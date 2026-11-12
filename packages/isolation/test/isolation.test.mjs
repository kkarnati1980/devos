// S4-a1 (DEVOS-126): docs/modules/S4.md AT1–AT4 (pure half) and AT9.
import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  stackNetwork, indexFromPort, hardenCompose, isolationHook, stateDocument, tailnetCidrOk, DEFAULT_LIMITS, IsolationError,
} from "../dist/index.js";

const MiB = 1024 * 1024;
const net = stackNetwork("shop", "live", 3);
const code = (c) => (e) => e instanceof IsolationError && e.code === c;

test("AT1: distinct, stable /24s inside 10.208.0.0/14; index outside 0–1023 refused", () => {
  assert.deepEqual(stackNetwork("shop", "live", 0), { name: "devos-p-shop-live", subnet: "10.208.0.0/24", gateway: "10.208.0.1", idx: 0 });
  assert.deepEqual(stackNetwork("shop", "preview", 257), { name: "devos-p-shop-preview", subnet: "10.209.1.0/24", gateway: "10.209.1.1", idx: 257 });
  assert.equal(stackNetwork("x", "live", 1023).subnet, "10.211.255.0/24");
  assert.deepEqual(stackNetwork("shop", "live", 5), stackNetwork("shop", "live", 5), "stable");
  assert.notEqual(stackNetwork("a", "live", 4).subnet, stackNetwork("b", "live", 5).subnet);
  for (const i of [-1, 1024, 1.5, NaN]) assert.throws(() => stackNetwork("shop", "live", i), code("bad_stack"));
  for (const s of ["Shop", "-a", "a-", "a_b", "a".repeat(41), ""]) assert.throws(() => stackNetwork(s, "live", 1), code("bad_stack"), s);
  assert.throws(() => stackNetwork("shop", "prod", 1), code("bad_stack"));
  assert.equal(indexFromPort(20005, 20000), 5);
  assert.throws(() => indexFromPort(19999, 20000), code("bad_stack"));
  assert.throws(() => indexFromPort(21024, 20000), code("bad_stack"));
});

test("AT2: missing limits get the per-env defaults; values above the cap are clamped; deploy limits are folded in", () => {
  const out = hardenCompose({ services: { app: { image: "a" },
    dep: { image: "c", deploy: { resources: { limits: { cpus: "0.25", memory: "256m", pids: 64 }, reservations: { cpus: "0.1" } } } } } }, "live", net);
  assert.deepEqual([out.services.app.cpus, out.services.app.mem_limit, out.services.app.pids_limit], [1.0, 768 * MiB, 256]);
  assert.equal(out.services.app.memswap_limit, 768 * MiB);
  // Clamping is checked on its own stack: at the per-service caps it uses the whole live budget's CPU.
  const big = hardenCompose({ services: { big: { image: "b", cpus: "8", mem_limit: "16g", pids_limit: 99999 } } }, "live", net);
  assert.deepEqual([big.services.big.cpus, big.services.big.mem_limit, big.services.big.pids_limit], [2, 2048 * MiB, 1024]);
  assert.deepEqual([out.services.dep.cpus, out.services.dep.mem_limit, out.services.dep.pids_limit], [0.25, 256 * MiB, 64]);
  assert.deepEqual(out.services.dep.deploy.resources, { reservations: { cpus: "0.1" } }, "one source of truth for limits");
  const units = hardenCompose({ services: { a: { mem_limit: "1gib" }, b: { mem_limit: "300MiB" }, c: { mem_limit: 104857600 }, e: { mem_limit: "512Mi" } } }, "live", net);
  assert.deepEqual([units.services.a.mem_limit, units.services.b.mem_limit, units.services.c.mem_limit, units.services.e.mem_limit], [1024 * MiB, 300 * MiB, 100 * MiB, 512 * MiB]);
  const pv = hardenCompose({ services: { app: { image: "a" } } }, "preview", stackNetwork("shop", "preview", 2));
  assert.deepEqual([pv.services.app.cpus, pv.services.app.mem_limit, pv.services.app.pids_limit], [0.5, 512 * MiB, 256]);
});

test("AT2: a limit that does not limit (0, -1, junk) cannot be set → limits_missing", () => {
  for (const s of [{ pids_limit: -1 }, { pids_limit: 0 }, { cpus: "0" }, { cpus: "lots" }, { mem_limit: "-1" }, { mem_limit: 0 }, { pids_limit: 1.5 },
    { mem_limit: "5x" }, { deploy: { resources: { limits: { pids: -1 } } } }, { cpus: true },
    // Values that round to 0 (= unlimited) in Docker (pre-review): fractional bytes, tiny CPU shares.
    { mem_limit: 0.5 }, { mem_limit: "0.9b" }, { mem_limit: "1m" }, { cpus: 1e-10 }, { cpus: "0.001" }]) {
    assert.throws(() => hardenCompose({ services: { app: { image: "a", ...s } } }, "live", net), code("limits_missing"), JSON.stringify(s));
  }
});

test("AT2/AT3: hardening adds no-new-privileges, cap_drop ALL and only the project network (no IPv6, fixed subnet)", () => {
  const out = hardenCompose({ services: { app: { image: "a", cap_add: ["NET_BIND_SERVICE"], networks: ["backend"], security_opt: ["no-new-privileges"] } },
    networks: { backend: {} } }, "live", net);
  const s = out.services.app;
  assert.deepEqual(s.cap_drop, ["ALL"]);
  assert.deepEqual(s.cap_add, ["NET_BIND_SERVICE"]);
  assert.deepEqual(s.security_opt, ["no-new-privileges:true"]);
  assert.deepEqual(s.networks, ["devos-p-shop-live"]);
  assert.deepEqual(out.networks, { "devos-p-shop-live": { name: "devos-p-shop-live", driver: "bridge", enable_ipv6: false, ipam: { config: [{ subnet: "10.208.3.0/24", gateway: "10.208.3.1" }] } } });
});

test("AT3: unsafe Compose options are refused with compose_unsafe", () => {
  const bad = {
    privileged: { privileged: true },
    host_net: { network_mode: "host" },
    other_net_mode: { network_mode: "service:db" },
    pid_host: { pid: "host" },
    ipc_host: { ipc: "host" },
    net_admin: { cap_add: ["NET_ADMIN"] },
    sys_admin: { cap_add: ["CAP_SYS_ADMIN"] },
    sock: { volumes: ["/var/run/docker.sock:/var/run/docker.sock"] },
    sock_long: { volumes: [{ type: "bind", source: "/run/docker.sock", target: "/s" }] },
    sock_rel: { volumes: ["./docker.sock:/s"] },
    root_bind: { volumes: ["/:/host"] },
    etc_bind: { volumes: ["/etc/:/x:ro"] },
    // Pre-review: no host bind of any path, however it is spelled.
    dbl_slash: { volumes: ["//etc:/x"] },
    dotdot: { volumes: ["/usr/../etc:/x"] },
    rel_up: { volumes: ["../../../../:/host"] },
    var_bind: { volumes: ["/var:/v"] },
    coolify_dir: { volumes: ["/data/coolify:/c"] },
    home_bind: { volumes: ["/home:/h"] },
    repo_bind: { volumes: ["./src:/app/src"] },
    undeclared_named: { volumes: ["other:/x"] },
    long_bind: { volumes: [{ type: "bind", source: "./x", target: "/x" }] },
    long_undeclared: { volumes: [{ type: "volume", source: "nope", target: "/x" }] },
    // Interpolation is resolved by Compose after the check.
    interp_vol: { volumes: ["${H:-/}:/host"] },
    interp_priv: { privileged: "${P:-true}" },
    interp_cpus: { cpus: "${C:-0}" },
    // Indirection and features outside the allow-list.
    extends: { extends: { file: "../evil.yml", service: "root" } },
    merge_key: { "<<": { privileged: true } },
    priv_yes: { privileged: "yes" },
    priv_one: { privileged: 1 },
    env_file: { env_file: ["/root/.devos/secrets/isolation_state_token"] },
    build_net: { build: { context: ".", network: "host" } },
    build_ssh: { build: { context: ".", ssh: ["default"] } },
    build_secret: { build: { context: ".", secrets: ["s"] } },
    build_ctx: { build: { context: "/" } },
    build_ctx_up: { build: "../.." },
    build_git: { build: "https://github.com/x/y.git#main" },
    build_df: { build: { context: ".", dockerfile: "../../etc/Dockerfile" } },
    runtime: { runtime: "runc-unsafe" },
    seccomp_file: { security_opt: ["seccomp=./allow-all.json"] },
    apparmor: { security_opt: ["apparmor=x"] },
    oom: { oom_kill_disable: true },
    sysctls: { sysctls: { "net.ipv4.ip_forward": 1 } },
    gpus: { gpus: "all" },
    gpu_res: { deploy: { resources: { reservations: { devices: [{ capabilities: ["gpu"] }] } } } },
    replicas: { deploy: { replicas: 50 } },
    global: { deploy: { mode: "global" } },
    scale: { scale: 3 },
    container_name: { container_name: "coolify-db" },
    logging: { logging: { driver: "syslog" } },
    label_coolify: { labels: { "coolify.managed": "true" } },
    label_traefik: { labels: ["traefik.enable=true"] },
    configs: { configs: ["c"] },
    // Second pre-review.
    dot_named: { volumes: [".:/app"] },
    caddy_num: { labels: { "caddy_0": "x.example", "caddy_0.reverse_proxy": "10.0.0.1:8000" } },
    caddy_space: { labels: [" caddy=x"] },
    build_remote: { build: "github.com/attacker/repo" },
    build_remote_ctx: { build: { context: "gitlab.com/a/b" } },
    build_df_escape: { build: { context: "./web", dockerfile: "../../x/Dockerfile" } },
    ulimit_nproc: { ulimits: { nproc: 100000 } },
    ulimit_memlock: { ulimits: { memlock: -1 } },
    devices: { devices: ["/dev/kvm"] },
    seccomp: { security_opt: ["seccomp=unconfined"] },
    nnp_off: { security_opt: ["no-new-privileges:false"] },
    coolify_net: { networks: ["coolify"] },
    coolify_map: { networks: { coolify: {} } },
    host_gw: { extra_hosts: ["h:host-gateway"] },
    vfrom: { volumes_from: ["db"] },
  };
  for (const [k, s] of Object.entries(bad)) assert.throws(() => hardenCompose({ services: { app: { image: "a", ...s } } }, "live", net), code("compose_unsafe"), k);
  assert.throws(() => hardenCompose({ services: { app: { networks: ["edge"] } }, networks: { edge: { external: true } } }, "live", net), code("compose_unsafe"), "external network");
  assert.throws(() => hardenCompose({ services: { app: { networks: ["px"] } }, networks: { px: { name: "coolify" } } }, "live", net), code("compose_unsafe"), "renamed coolify");
  for (const doc of [null, [], "services: {}", {}, { services: {} }, { services: { app: "x" } }]) assert.throws(() => hardenCompose(doc, "live", net), code("compose_unsafe"));
  // Document-level keys outside the allow-list, and volumes that are not plain local ones (pre-review).
  const app = { app: { image: "a", volumes: ["r:/host"] } };
  for (const [k, doc] of Object.entries({
    include: { include: ["../evil.yml"], services: { app: { image: "a" } } },
    configs_top: { configs: { c: { file: "/etc/shadow" } }, services: { app: { image: "a" } } },
    secrets_top: { secrets: { s: { file: "/root/.devos/secrets/isolation_state_token" } }, services: { app: { image: "a" } } },
    name_top: { name: "coolify", services: { app: { image: "a" } } },
    merge_top: { "<<": {}, services: { app: { image: "a" } } },
    vol_bind_opts: { volumes: { r: { driver: "local", driver_opts: { type: "none", o: "bind", device: "/" } } }, services: app },
    vol_external: { volumes: { r: { external: true, name: "coolify-db" } }, services: app },
    vol_named: { volumes: { r: { name: "devos-p-other-live_data" } }, services: app },
    vol_driver: { volumes: { r: { driver: "nfs" } }, services: app },
    svc_interp_name: { services: { "${X}": { image: "a" } } },
    // Names that Compose reads as bind mounts whatever is declared (second pre-review).
    vol_dotdot: { volumes: { "..": null }, services: { app: { image: "a", volumes: ["..:/host"] } } },
    vol_dot: { volumes: { ".": null }, services: { app: { image: "a", volumes: [".:/host"] } } },
    vol_slash: { volumes: { "/": null }, services: { app: { image: "a", volumes: ["/:/host"] } } },
    vol_tilde: { volumes: { "~": null }, services: { app: { image: "a", volumes: ["~:/host"] } } },
    vol_dot_long: { volumes: { ".": null }, services: { app: { image: "a", volumes: [{ type: "volume", source: ".", target: "/h" }] } } },
  })) assert.throws(() => hardenCompose(doc, "live", net), code("compose_unsafe"), k);
  // A named volume is not a bind mount and is fine.
  const ok = hardenCompose({ "x-common": { a: 1 }, version: "3.9", volumes: { data: null, logs: { driver: "local" } },
    services: { db: { image: "pg", volumes: ["data:/var/lib/postgresql/data", { type: "volume", source: "logs", target: "/l", read_only: true }, { type: "tmpfs", target: "/t" }],
      environment: { DB_URL: "postgres://u:${PASS}@db/x" }, command: ["sh", "-c", "echo $$HOME"], expose: ["5432"], depends_on: [], healthcheck: { test: ["CMD", "true"] },
      build: { context: "./db", dockerfile: "Dockerfile", args: { V: "1" } }, deploy: { replicas: 1, restart_policy: { condition: "on-failure" } }, labels: { "app.tier": "db" } } } }, "live", net);
  assert.equal(ok.services.db.environment.DB_URL, "postgres://u:${PASS}@db/x", "interpolation inside environment is the app's own business");
  // Ordinary app files: anonymous volumes, ulimits nofile, profiles, x-* keys in a service, $$ escapes,
  // a Dockerfile beside a subdirectory context, and ports (dropped: M2.4-c2 publishes the stack's port).
  const app2 = hardenCompose({ services: { web: { image: "n", volumes: ["/app/node_modules", { type: "volume", target: "/cache" }], ulimits: { nofile: { soft: 1024, hard: 4096 } },
    profiles: ["web"], "x-note": "inert", labels: { cost: "$$5" }, build: { context: "./web", dockerfile: "../docker/web.Dockerfile" }, ports: ["0.0.0.0:8000:80"] } } }, "preview", stackNetwork("shop", "preview", 2));
  assert.ok(!("ports" in app2.services.web), "ports dropped");
  assert.deepEqual(app2.services.web.volumes, ["/app/node_modules", { type: "volume", target: "/cache" }]);
  assert.ok(!("privileged" in ok.services.db));
});

test("AT2: invalid limit settings (0, negative, NaN) are refused rather than meaning unlimited", () => {
  const bad = (patch) => ({ defaults: { live: { ...DEFAULT_LIMITS.defaults.live, ...patch }, preview: DEFAULT_LIMITS.defaults.preview }, caps: DEFAULT_LIMITS.caps });
  for (const p of [{ cpus: 0 }, { memBytes: -1 }, { pids: NaN }, { cpus: Infinity }, { pids: 1.5 }]) {
    assert.throws(() => hardenCompose({ services: { app: { image: "a" } } }, "live", net, bad(p)), code("limits_missing"), JSON.stringify(p));
  }
  assert.throws(() => hardenCompose({ services: { app: { image: "a" } } }, "live", net, { ...DEFAULT_LIMITS, caps: { cpus: 2, memBytes: 0, pids: 10 } }), code("limits_missing"));
});

test("AT2: the stack has a budget: defaults share what explicit limits leave; over budget is refused", () => {
  // app + db + cache with no limits: 3 × 1.0 CPU would be 3; they share the live budget of 2 CPUs and 3 GiB.
  const three = hardenCompose({ services: { app: {}, db: {}, cache: {} } }, "live", net);
  for (const s of Object.values(three.services)) assert.deepEqual([s.cpus, s.mem_limit, s.pids_limit], [0.66, 768 * MiB, 256]);
  const sum = (o, k) => Object.values(o.services).reduce((a, s) => a + s[k], 0);
  assert.ok(sum(three, "cpus") <= 2 && sum(three, "mem_limit") <= 3072 * MiB && sum(three, "pids_limit") <= 2048);
  // An explicit 1.5 CPU leaves 0.5 for the other two.
  const mixed = hardenCompose({ services: { app: { cpus: 1.5 }, db: {}, cache: {} } }, "live", net);
  assert.deepEqual([mixed.services.app.cpus, mixed.services.db.cpus, mixed.services.cache.cpus], [1.5, 0.25, 0.25]);
  // Explicit limits over the budget, or nothing left for the unset ones, or too many services.
  assert.throws(() => hardenCompose({ services: { a: { mem_limit: "2g" }, b: { mem_limit: "2g" } } }, "live", net), code("limits_over_budget"));
  assert.throws(() => hardenCompose({ services: { a: { cpus: 2 }, b: {} } }, "live", net), code("limits_over_budget"));
  assert.throws(() => hardenCompose({ services: { a: { pids_limit: 1024 }, b: {} } }, "preview", stackNetwork("shop", "preview", 2)), code("limits_over_budget"));
  const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`s${i}`, { cpus: 0.05, mem_limit: "16m", pids_limit: 8 }]));
  assert.throws(() => hardenCompose({ services: many }, "live", net), code("compose_unsafe"));
});

test("errors name the service and option, never a value", () => {
  for (const s of [{ cap_add: ["SECRET_CAP_xyz"] }, { security_opt: ["seccomp=/s3cr3t.json"] }, { volumes: ["/s3cr3t:/x"] }]) {
    try { hardenCompose({ services: { app: { image: "a", ...s } } }, "live", net); assert.fail("accepted"); } catch (e) {
      assert.ok(e instanceof IsolationError);
      assert.doesNotMatch(e.message, /SECRET_CAP|s3cr3t/);
    }
  }
});

test("AT3: the input is not changed (a refusal hands nothing on)", () => {
  const input = { services: { app: { image: "a" } } };
  const copy = structuredClone(input);
  hardenCompose(input, "live", net);
  assert.deepEqual(input, copy);
});

test("AT4 (document half): exactly {stacks:[{slug, env, idx, egress, tailnet}]}; bad entries refused", () => {
  const doc = stateDocument([{ slug: "shop", env: "live", idx: 3, egress: true, tailnet: ["100.101.2.3/32"], secret: "x", projectId: "p" }]);
  assert.deepEqual(doc, { stacks: [{ slug: "shop", env: "live", idx: 3, egress: true, tailnet: ["100.101.2.3/32"] }] });
  assert.deepEqual(Object.keys(doc.stacks[0]), ["slug", "env", "idx", "egress", "tailnet"]);
  const ok = { slug: "shop", env: "live", idx: 3, egress: false, tailnet: [] };
  for (const bad of [{ slug: "Shop" }, { env: "x" }, { idx: 1024 }, { egress: "yes" }, { tailnet: ["10.0.0.0/8"] }, { tailnet: ["100.64.0.0/9"] },
    { tailnet: ["100.128.0.1/32"] }, { tailnet: ["fd7a:115c:a1e0::/48"] }, { tailnet: ["100.064.0.1/32"] }, { tailnet: Array(65).fill("100.64.0.1/32") }]) {
    assert.throws(() => stateDocument([{ ...ok, ...bad }]), code("bad_stack"), JSON.stringify(bad).slice(0, 60));
  }
  assert.throws(() => stateDocument([ok, { ...ok, env: "preview" }]), code("bad_stack"), "duplicate index");
  assert.throws(() => stateDocument([ok, { ...ok, idx: 4 }]), code("bad_stack"), "duplicate stack");
  assert.ok(tailnetCidrOk("100.64.0.0/10") && tailnetCidrOk("100.127.255.255/32") && !tailnetCidrOk("100.64.0.0/33"));
});

test("AT9: the hook rewrites, records, and never spawns a process or touches the host", async () => {
  const spawned = [];
  const saved = {};
  for (const k of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    saved[k] = childProcess[k];
    childProcess[k] = (...a) => { spawned.push([k, a[0]]); throw new Error("no child process allowed"); };
  }
  syncBuiltinESMExports();
  try {
    const records = [];
    const hook = isolationHook({ store: { recordStack: async (r) => { records.push(r); } } });
    const out = await hook({ id: "p1", slug: "shop" }, { name: "preview", port: 20004, portRangeStart: 20000, compose: { services: { app: { image: "a" } } } });
    assert.equal(out.network, "devos-p-shop-preview");
    assert.equal(out.subnet, "10.208.4.0/24");
    assert.equal(out.compose.services.app.cpus, DEFAULT_LIMITS.defaults.preview.cpus);
    assert.deepEqual(records, [{ projectId: "p1", slug: "shop", env: "preview", idx: 4, network: "devos-p-shop-preview", subnet: "10.208.4.0/24" }]);
    await assert.rejects(hook({ id: "p1", slug: "shop" }, { name: "live", port: 20005, portRangeStart: 20000, compose: { services: { app: { privileged: true } } } }), code("compose_unsafe"));
    await assert.rejects(hook({ id: "p1", slug: "shop" }, { name: "live", port: 20005, portRangeStart: 20000, compose: { services: { app: { pids_limit: -1 } } } }), code("limits_missing"));
    await assert.rejects(hook({ id: "p1", slug: "shop" }, null), code("bad_stack"));
    await assert.rejects(hook(null, { name: "live", port: 20005, portRangeStart: 20000, compose: {} }), code("bad_stack"));
    assert.equal(records.length, 1, "a refused stack is not recorded");
    assert.deepEqual(spawned, []);
  } finally {
    for (const [k, v] of Object.entries(saved)) childProcess[k] = v;
    syncBuiltinESMExports();
  }
});

test("AT9 (static): the built package imports no Node builtin that can reach the host, a socket or a process", () => {
  const dist = new URL("../dist/", import.meta.url);
  for (const f of fs.readdirSync(dist).filter((n) => n.endsWith(".js"))) {
    const src = fs.readFileSync(new URL(f, dist), "utf8");
    for (const m of src.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\brequire\s*\(|\bimport\s*\(\s*[^"'\s]/gm)) {
      const spec = m[1] ?? m[2] ?? m[3];
      assert.ok(spec && spec.startsWith("./"), `${f} imports ${spec ?? "require()"}`);
    }
  }
});

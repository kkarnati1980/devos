// M2.4-c2a acceptance tests on fake GitHub + Coolify (docs/modules/M2.4.md: AT1–AT4 for applications; the S4 hook).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  allowAll, CoolifyClient, GitHubClient, MemoryStore, coolifyProjectStep, githubRepoStep, stackSteps, applicationSteps,
  applicationStep, applicationName, parseCompose, publishTailnetPort, isTailnetIpv4, parsePortRange, portStep, runProvision, StepError, COMPOSE_MAX_BYTES,
} from "../dist/index.js";
import { fakeProviders } from "./fakes.mjs";

const TOKEN = "ghp_TESTONLY_not_a_real_token_0123456789";
const P = { id: "11111111-2222-4333-8444-555555555555", slug: "acme", name: "Acme" };
const RANGE = parsePortRange("20000-20999");
const SERVER = "srv-0123456789";
const TAILNET_IP = "100.101.102.103";
const noSleep = async () => {};
const CORE_COMPOSE = readFileSync(new URL("../../../templates/golden-path/core/compose.yaml", import.meta.url));
const sha1 = (b) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest("hex");

/** A hook that records its calls and marks the Compose it returns, standing in for S4's isolationHook. */
function recordingHook() {
  const calls = [];
  return { calls, afterStack: async (project, env) => { calls.push({ project, env }); return { compose: { ...env.compose, "x-hardened": env.name } }; } };
}

/** Puts a core commit holding `files` on the fake repo's main and journals the `github/core` step as done. */
async function pushCore(fake, store, files = { "compose.yaml": CORE_COMPOSE }) {
  const g = fake.gitOf(`kkarnati1980/devos-${P.slug}`);
  const tree = [];
  for (const [path, content] of Object.entries(files)) { const s = sha1(content); g.blobs.set(s, content); tree.push({ path, mode: "100644", type: "blob", sha: s }); }
  const t = createHash("sha1").update(JSON.stringify(tree)).digest("hex");
  g.trees.set(t, tree);
  const c = createHash("sha1").update(`commit ${t}`).digest("hex");
  g.commits.set(c, { tree: t, parents: [] });
  g.main = c;
  await store.markDone(P.id, { key: "github/core", provider: "github", kind: "core" }, c);
  return c;
}

async function setup({ fake = fakeProviders(), store = new MemoryStore(), hook = recordingHook(), files } = {}) {
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep: noSleep });
  const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep: noSleep });
  const opts = { owner: "kkarnati1980", serverUuid: SERVER, tailnetIp: TAILNET_IP, range: RANGE, hooks: { afterStack: hook.afterStack } };
  const base = [githubRepoStep(gh, P, "kkarnati1980"), coolifyProjectStep(cf, P), ...stackSteps(cf, store, P, RANGE)];
  await runProvision(P.id, base, { store, authorize: allowAll });
  await pushCore(fake, store, files);
  const steps = () => [...base, ...applicationSteps(cf, gh, store, P, opts)];
  return { fake, store, hook, gh, cf, opts, steps };
}

const appCreates = (fake) => fake.creates().filter((c) => c.path === "/api/v1/applications/dockercompose");

test("AT1 one application per environment, from the repo's Compose after the hook, recorded; nothing deployed", async () => {
  const s = await setup();
  const out = await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  assert.deepEqual(out.slice(-2).map((o) => o.outcome), ["created", "created"]);
  const posts = appCreates(s.fake);
  assert.equal(posts.length, 2);
  const proj = [...s.fake.projects.values()][0];
  for (const [i, env] of [["preview", "preview"], ["production", "live"]].entries()) {
    const b = posts[i].body;
    assert.equal(b.name, `devos-acme-${env[1]}`);
    assert.equal(b.environment_name, env[0]);
    assert.equal(b.project_uuid, proj.uuid);
    assert.equal(b.server_uuid, SERVER);
    assert.equal(b.instant_deploy, false, "M2.4 deploys nothing");
    assert.equal(b.autogenerate_domain, false, "decision 1: no Coolify domain, tailnet only");
    assert.ok(b.description.includes(`devos:${P.id}`), "marker in the create call itself");
    const sent = parse(Buffer.from(b.docker_compose_raw, "base64").toString("utf8"));
    assert.equal(sent["x-hardened"], env[1], "Coolify gets the hook's Compose");
    const core = parse(CORE_COMPOSE.toString()).services;
    const port = env[1] === "preview" ? 20000 : 20001;
    assert.deepEqual(sent.services, { ...core, app: { ...core.app, ports: [{ target: 3000, published: String(port), host_ip: TAILNET_IP, protocol: "tcp", mode: "host" }] } },
      "built from the repo's compose.yaml, with only the stack's tailnet port published (Codex PR76-r4)");
  }
  assert.deepEqual(s.hook.calls.map((c) => [c.env.name, c.env.port, c.env.portRangeStart, c.project.id]),
    [["preview", 20000, 20000, P.id], ["live", 20001, 20000, P.id]]);
  const apps = s.store.resources.filter((r) => r.kind === "application");
  assert.deepEqual(apps.map((r) => r.name).sort(), ["devos-acme-live", "devos-acme-preview"]);
  assert.ok(!s.fake.calls.some((c) => c.path.startsWith("/api/v1/deploy")), "no deploy call");
  assert.ok([...s.fake.apps.values()].every((a) => a.fqdn === undefined), "no generated domain");
});

test("AT2 a re-run creates nothing; a lost journal adopts both applications by name and marker", async () => {
  const s = await setup();
  await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  const before = s.fake.creates().length;
  const again = await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  assert.ok(again.every((o) => o.outcome === "recorded"));
  for (const env of ["preview", "production"]) s.store.steps.delete(`${P.id}/coolify/application/${env}`);
  const out = await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  assert.deepEqual(out.slice(-2).map((o) => o.outcome), ["adopted", "adopted"]);
  assert.equal(s.fake.creates().length, before);
  assert.equal(s.hook.calls.length, 2, "the hook runs only for a create");
});

test("AT3/AT4 a create that times out after it happened is adopted with one POST", async () => {
  const s = await setup();
  s.fake.faults.push({ match: (m, p) => m === "POST" && p === "/api/v1/applications/dockercompose", action: "timeout-after" });
  const out = await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  assert.equal(out.at(-2).outcome, "adopted");
  assert.equal(appCreates(s.fake).length, 2, "one POST per environment");
  assert.equal(s.fake.apps.size, 2);
});

test("AT3 crash after the create returns, before the DB write: the re-run adopts, total creates per application = 1", async () => {
  const s = await setup();
  const orig = s.store.recordResource.bind(s.store);
  let crash = true;
  s.store.recordResource = async (pid, r) => { if (crash && r.kind === "application") { crash = false; throw new Error("killed"); } return orig(pid, r); };
  await assert.rejects(runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll }), /killed/);
  const out = await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  assert.deepEqual(out.slice(-2).map((o) => o.outcome), ["adopted", "created"]);
  assert.equal(appCreates(s.fake).length, 2);
});

test("AT5-style: a same-named application without our marker is a name_conflict; nothing is created", async () => {
  const s = await setup();
  s.fake.apps.set("apforeign0001", { uuid: "apforeign0001", name: "devos-acme-preview", description: "someone else's" });
  await assert.rejects(runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll }),
    (e) => e instanceof StepError && e.code === "name_conflict" && e.retryable === false);
  assert.equal(appCreates(s.fake).length, 0);
  assert.equal(s.hook.calls.length, 0);
});

test("the S4 hook is required, and its refusal creates nothing", async () => {
  const s = await setup();
  assert.throws(() => applicationStep(s.cf, s.gh, s.store, P, "preview", { ...s.opts, hooks: undefined }), /provision-hooks-required/);
  assert.throws(() => applicationStep(s.cf, s.gh, s.store, P, "preview", { ...s.opts, hooks: {} }), /provision-hooks-required/);
  const refuse = { calls: [], afterStack: async () => { const e = new Error("compose_unsafe: privileged"); e.name = "IsolationError"; throw e; } };
  const steps = [...s.steps().slice(0, 6), ...applicationSteps(s.cf, s.gh, s.store, P, { ...s.opts, hooks: refuse })];
  await assert.rejects(runProvision(P.id, steps, { store: s.store, authorize: allowAll }),
    (e) => e instanceof StepError && e.code === "provider_error" && e.retryable === false);
  assert.equal(appCreates(s.fake).length, 0);
});

test("AT12-style: a policy deny on provision.coolify.application creates nothing and calls no hook", async () => {
  const s = await setup();
  const authorize = async (a) => (a === "provision.coolify.application" ? "deny" : "allow");
  await assert.rejects(runProvision(P.id, s.steps(), { store: s.store, authorize }), (e) => e.code === "policy_denied");
  assert.equal(appCreates(s.fake).length, 0);
  assert.equal(s.hook.calls.length, 0);
});

test("missing inputs fail before any write: no core commit, no compose.yaml, a lost lock", async () => {
  const s = await setup();
  s.store.steps.delete(`${P.id}/github/core`);
  await assert.rejects(runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll }), (e) => e.code === "provider_error");
  assert.equal(appCreates(s.fake).length, 0);

  const t = await setup({ files: { "README.md": Buffer.from("no compose\n") } });
  await assert.rejects(runProvision(P.id, t.steps(), { store: t.store, authorize: allowAll }), (e) => e.code === "provider_error");
  assert.equal(appCreates(t.fake).length, 0);

  const u = await setup();
  const hook = u.hook.afterStack;
  u.opts.hooks.afterStack = async (...a) => { const r = await hook(...a); u.store.lockLost = true; return r; };
  const steps = [...u.steps().slice(0, 6), ...applicationSteps(u.cf, u.gh, u.store, P, u.opts)];
  await assert.rejects(runProvision(P.id, steps, { store: u.store, authorize: allowAll }), (e) => e instanceof StepError && e.code === "provider_error");
  assert.equal(appCreates(u.fake).length, 0, "the lock is checked after the hook, right before the POST");
});

test("an inconclusive application list creates nothing", async () => {
  const bad = [[404, { message: "Not Found" }], [200, { not: "a list" }], [200, [{ name: "x" }]], [200, [{ name: "x", uuid: "a/b" }]], [200, [{ name: "x", uuid: "ab1", description: 7 }]]];
  for (const [status, body] of bad) {
    const s = await setup();
    const real = s.fake.fetchImpl;
    const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => TOKEN, sleep: noSleep,
      fetchImpl: async (url, init = {}) => ((init.method ?? "GET") === "GET" && new URL(url).pathname === "/api/v1/applications"
        ? new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }) : real(url, init)) });
    const steps = [...s.steps().slice(0, 6), ...applicationSteps(cf, s.gh, s.store, P, s.opts)];
    await assert.rejects(runProvision(P.id, steps, { store: s.store, authorize: allowAll }), (e) => e.code === "provider_error", JSON.stringify(body));
    assert.equal(appCreates(s.fake).length, 0, JSON.stringify(body));
  }
});

test("Compose parsing: size cap, YAML errors, a non-mapping, merge keys stay literal, names and validation", () => {
  assert.throws(() => parseCompose(Buffer.alloc(COMPOSE_MAX_BYTES + 1, 0x20)), /compose-too-large/);
  assert.throws(() => parseCompose(Buffer.from("services: [unclosed")), /compose-invalid/);
  assert.throws(() => parseCompose(Buffer.from("- a\n- b\n")), /compose-invalid/);
  assert.throws(() => parseCompose(Buffer.from("a: 1\na: 2\n")), /compose-invalid/);
  const d = parseCompose(Buffer.from("x-base: &b {cpus: '1'}\nservices:\n  app:\n    <<: *b\n    image: nginx\n"));
  assert.ok(Object.hasOwn(d.services.app, "<<"), "a merge key is left for S4 to refuse");
  assert.equal(applicationName("acme", "production"), "devos-acme-live");
  assert.equal(applicationName("acme", "preview"), "devos-acme-preview");
  const s = { cf: null, gh: null, store: new MemoryStore() };
  const base = { owner: "kkarnati1980", serverUuid: SERVER, tailnetIp: TAILNET_IP, range: RANGE, hooks: recordingHook() };
  assert.throws(() => applicationStep(s.cf, s.gh, s.store, { id: P.id, slug: "Bad Slug" }, "preview", base), /slug-invalid/);
  assert.throws(() => applicationStep(s.cf, s.gh, s.store, P, "preview", { ...base, serverUuid: "../x" }), /server-uuid-invalid/);
});

test("c1 note 2: a DB failure while allocating a port is retryable; the re-run keeps the port", async () => {
  const store = new MemoryStore();
  const orig = store.recordResource.bind(store);
  let fail = true;
  store.recordResource = async (pid, r) => { if (fail && r.kind === "port") { fail = false; await orig(pid, r); throw new Error("statement timeout"); } return orig(pid, r); };
  await assert.rejects(runProvision(P.id, [portStep(store, P, "preview", RANGE)], { store, authorize: allowAll }),
    (e) => e instanceof StepError && e.code === "provider_error" && e.retryable === true);
  const out = await runProvision(P.id, [portStep(store, P, "preview", RANGE)], { store, authorize: allowAll });
  assert.deepEqual(out.map((o) => [o.outcome, o.externalId]), [["adopted", "20000"]]);
  assert.equal(store.resources.filter((r) => r.kind === "port").length, 1);
});

test("pre-review: not listed after the create → create_unconfirmed with one POST; the next run adopts", async () => {
  const s = await setup();
  const real = s.fake.fetchImpl;
  let hide = true;
  const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => TOKEN, sleep: noSleep,
    fetchImpl: async (url, init = {}) => {
      const res = await real(url, init);
      if (hide && (init.method ?? "GET") === "GET" && new URL(url).pathname === "/api/v1/applications") return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      return res;
    } });
  const steps = [...s.steps().slice(0, 6), ...applicationSteps(cf, s.gh, s.store, P, s.opts)];
  await assert.rejects(runProvision(P.id, steps, { store: s.store, authorize: allowAll }), (e) => e.code === "create_unconfirmed" && e.retryable === true);
  assert.equal(appCreates(s.fake).length, 1);
  hide = false;
  const out = await runProvision(P.id, steps, { store: s.store, authorize: allowAll });
  assert.equal(out.at(-2).outcome, "adopted");
  assert.equal(appCreates(s.fake).length, 2, "one POST per environment");
});

test("pre-review: a 2xx POST with no uuid is looked up and adopted, never POSTed again", async () => {
  const s = await setup();
  const real = s.fake.fetchImpl;
  let once = true;
  const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => TOKEN, sleep: noSleep,
    fetchImpl: async (url, init = {}) => {
      const res = await real(url, init);
      if (once && init.method === "POST" && new URL(url).pathname === "/api/v1/applications/dockercompose") { once = false; return new Response("{}", { status: 201, headers: { "content-type": "application/json" } }); }
      return res;
    } });
  const out = await runProvision(P.id, [...s.steps().slice(0, 6), ...applicationSteps(cf, s.gh, s.store, P, s.opts)], { store: s.store, authorize: allowAll });
  assert.equal(out.at(-2).outcome, "adopted");
  assert.equal(appCreates(s.fake).length, 2);
});

test("pre-review: two owned applications with our name are inconclusive; nothing is created or adopted", async () => {
  const s = await setup();
  for (const id of ["apdup0001", "apdup0002"]) s.fake.apps.set(id, { uuid: id, name: "devos-acme-preview", description: `x devos:${P.id}` });
  await assert.rejects(runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll }), (e) => e.code === "provider_error");
  assert.equal(appCreates(s.fake).length, 0);
  assert.equal(s.store.resources.filter((r) => r.kind === "application").length, 0);
});

test("pre-review: a hook that hangs fails retryable within its bound; a hook returning an array is refused; nothing is created", async () => {
  const s = await setup();
  const hang = { afterStack: () => new Promise(() => {}) };
  const t0 = Date.now();
  await assert.rejects(runProvision(P.id, [...s.steps().slice(0, 6), ...applicationSteps(s.cf, s.gh, s.store, P, { ...s.opts, hooks: hang, hookTimeoutMs: 50 })], { store: s.store, authorize: allowAll }),
    (e) => e instanceof StepError && e.code === "provider_error" && e.retryable === true);
  assert.ok(Date.now() - t0 < 5000);
  const arr = { afterStack: async () => ({ compose: [] }) };
  await assert.rejects(runProvision(P.id, [...s.steps().slice(0, 6), ...applicationSteps(s.cf, s.gh, s.store, P, { ...s.opts, hooks: arr })], { store: s.store, authorize: allowAll }),
    (e) => e.code === "provider_error" && e.retryable === false);
  assert.equal(appCreates(s.fake).length, 0);
});

test("Codex PR76-r4: the allocated port is published on the tailnet address only, and refusals create nothing", async () => {
  const s = await setup();
  assert.throws(() => applicationStep(s.cf, s.gh, s.store, P, "preview", { ...s.opts, tailnetIp: undefined }), /tailnet-ip-invalid/);
  for (const bad of ["0.0.0.0", "10.0.0.1", "100.128.0.1", "100.064.0.1", "100.64.0.1/32", "::1", "100.64.0.256"]) {
    assert.throws(() => applicationStep(s.cf, s.gh, s.store, P, "preview", { ...s.opts, tailnetIp: bad }), /tailnet-ip-invalid/, bad);
  }
  assert.ok(isTailnetIpv4("100.64.0.1") && isTailnetIpv4("100.127.255.254"));
  const doc = { services: { app: { image: "x" }, db: { image: "y" } } };
  const out = publishTailnetPort(doc, 20004, TAILNET_IP);
  assert.deepEqual(out.services.app.ports, [{ target: 3000, published: "20004", host_ip: TAILNET_IP, protocol: "tcp", mode: "host" }]);
  assert.equal(out.services.db.ports, undefined, "only the app service is published");
  assert.equal(doc.services.app.ports, undefined, "the input is not mutated");
  assert.throws(() => publishTailnetPort({ services: { web: {} } }, 20004, TAILNET_IP), /no app service/);
  assert.throws(() => publishTailnetPort({ services: { app: {}, db: { ports: ["5432:5432"] } } }, 20004, TAILNET_IP), /compose-ports-unexpected: service db/);

  // A hook that leaves a ports entry (S4 not run as specified) fails the step, and no application is created.
  const leaky = { afterStack: async (_p, env) => ({ compose: { ...env.compose, services: { ...env.compose.services, app: { ...env.compose.services.app, ports: ["0.0.0.0:80:3000"] } } } }) };
  await assert.rejects(runProvision(P.id, [...s.steps().slice(0, 6), ...applicationSteps(s.cf, s.gh, s.store, P, { ...s.opts, hooks: leaky })], { store: s.store, authorize: allowAll }));
  assert.equal(appCreates(s.fake).length, 0);
});

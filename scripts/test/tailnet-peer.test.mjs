// DEVOS-251 (docs/modules/S4.md "S4-d Tailnet peer kept"): scripts/server/tailnet-snat.sh and
// scripts/server/checks/api-tailnet-peer.sh with fake `tailscale` and `conntrack`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const FIX = path.join(ROOT, "scripts/server/tailnet-snat.sh");
const CHECK = path.join(ROOT, "scripts/server/checks/api-tailnet-peer.sh");
let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devos-tsnat-")); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const KK = "100.80.173.125", HOST = "100.88.140.76";
const ct = (client, back, port = 3001) =>
  `tcp      6 431999 ESTABLISHED src=${client} dst=${HOST} sport=50926 dport=${port} src=172.16.3.6 dst=${back} sport=${port} dport=50926 [ASSURED] mark=0 use=1`;

// Fakes: `tailscale debug prefs` prints {"NoSNAT": <file nosnat>, "AdvertiseRoutes": <routes>} (or the raw `prefs`
// text); `tailscale set --snat-subnet-routes=false` writes true to nosnat (unless setNoop) and logs the call;
// `tailscale ip -4` prints `ip`; `conntrack -L ... --dport <p>` prints the file ct.<p> (missing: exit 1);
// `conntrack -D ...` logs its arguments and answers per `ctDel`.
function run(name, script, { nosnat = false, routes = "null", prefs, setRc = 0, setNoop = false, ip = HOST,
  conntrack, noTailscale = false, conf = "", ctDel = "ok", pending = false, routesAfterSet } = {}) {
  const dir = path.join(tmp, name);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(path.join(dir, "devos"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(dir, "devos/server-agent.conf"), conf);
  if (pending) fs.writeFileSync(path.join(dir, "devos/tailnet-snat.cut-pending"), "");
  const ns = path.join(dir, "nosnat");
  fs.writeFileSync(ns, String(nosnat));
  if (prefs !== undefined) fs.writeFileSync(path.join(dir, "prefs.raw"), prefs);
  fs.writeFileSync(path.join(dir, "routes"), routes);
  if (!noTailscale) {
    fs.writeFileSync(path.join(bin, "tailscale"), `#!/usr/bin/env bash
case "$*" in
  "ip -4") echo "${ip}" ;;
  "debug prefs") if [[ -f "${dir}/prefs.raw" ]]; then cat "${dir}/prefs.raw"; else echo "{\\"ControlURL\\":\\"x\\",\\"NoSNAT\\":$(cat "${ns}"),\\"AdvertiseRoutes\\":$(cat "${dir}/routes")}"; fi ;;
  "set --snat-subnet-routes=false") echo set >> "${dir}/set.log"; ${setNoop ? "true" : `[[ ${setRc} -eq 0 ]] && echo true > "${ns}"`}${routesAfterSet ? `; echo '${routesAfterSet}' > "${dir}/routes"` : ""}; exit ${setRc} ;;
  *) exit 9 ;;
esac\n`, { mode: 0o755 });
  }
  if (conntrack) {
    for (const [p, lines] of Object.entries(conntrack)) fs.writeFileSync(path.join(dir, `ct.${p}`), lines.join("\n") + (lines.length ? "\n" : ""));
    fs.writeFileSync(path.join(bin, "conntrack"), `#!/usr/bin/env bash
[[ "$1" == "-D" ]] && { echo "$*" >> "${dir}/ct.del"; case "${ctDel}" in
  ok) exit 0 ;; none) echo "conntrack v1.4.6 (conntrack-tools): 0 flow entries have been deleted." >&2; exit 1 ;; *) exit 124 ;; esac; }
[[ "$1 $2 $3 $4 $5" == "-L -p tcp -d ${ip}" && "$6" == "--dport" ]] || exit 9
f="${dir}/ct.$7"; [[ -f "$f" ]] || exit 1
cat "$f"; echo "conntrack v1.4.6 (conntrack-tools): 1 flow entries have been shown." >&2\n`, { mode: 0o755 });
  }
  for (const t of ["timeout", "cat", "bash", "grep", "sed", "head", "jq", "rm"]) {
    // The system copy first: a wrapper earlier on the developer's PATH must not stand in for it.
    const sys = ["/usr/bin", "/bin"].map((d) => path.join(d, t)).find((f) => fs.existsSync(f));
    const real = sys || spawnSync("bash", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    if (real && real.startsWith("/")) fs.symlinkSync(real, path.join(bin, t));
  }
  const r = spawnSync("/bin/bash", [script], { encoding: "utf8", env: { PATH: bin, DEVOS_DIR: path.join(dir, "devos") } });
  const sets = fs.existsSync(path.join(dir, "set.log")) ? fs.readFileSync(path.join(dir, "set.log"), "utf8").split("\n").filter(Boolean).length : 0;
  return { code: r.status, out: (r.stdout + r.stderr).trim(), sets, dir };
}
const owed = (r) => fs.existsSync(path.join(r.dir, "devos/tailnet-snat.cut-pending"));

// ---- tailnet-snat.sh ----
test("AT-d-1a: NoSNAT false is turned off once and confirmed by reading the prefs again", () => {
  const r = run("fix", FIX, {});
  assert.deepEqual([r.code, r.sets], [0, 1], r.out);
  assert.match(r.out, /^fixed: subnet-route SNAT turned off/);
  assert.equal(fs.readFileSync(path.join(r.dir, "nosnat"), "utf8").trim(), "true");
});

test("AT-d-1b: NoSNAT true: nothing changes (idempotent)", () => {
  const r = run("clean", FIX, { nosnat: true });
  assert.deepEqual([r.code, r.sets, r.out], [0, 0, "ok: subnet-route SNAT is off (NoSNAT true)"]);
});

test("AT-d-1c: a host that advertises routes (subnet router or exit node) is left alone and fails", () => {
  const r = run("router", FIX, { routes: '["0.0.0.0/0","::/0"]' });
  assert.deepEqual([r.code, r.sets], [1, 0], r.out);
  assert.match(r.out, /advertises 2 route\(s\).*KK decision/);
});

test("AT-d-1k: a route-advertising host with a cut still owed is never cut (Codex PR220-r5)", () => {
  const r = run("routercut", FIX, { nosnat: true, routes: '["10.0.0.0/24"]', conntrack: {}, pending: true });
  assert.deepEqual([r.code, r.sets], [0, 0], r.out);
  assert.match(r.out, /advertises 1 route\(s\), so nothing is cut \(KK decision\)$/);
  assert.ok(!fs.existsSync(path.join(r.dir, "ct.del")), "no conntrack delete");
});

test("AT-d-1l: routes that appear between the first read and the confirming read stop the cut (Codex PR220-r6)", () => {
  const r = run("routerlate", FIX, { conntrack: {}, routesAfterSet: '["10.0.0.0/24"]' });
  assert.deepEqual([r.code, r.sets], [0, 1], r.out);
  assert.match(r.out, /note: this host now advertises 1 route\(s\): no connection is cut \(KK decision\)$/);
  assert.ok(!fs.existsSync(path.join(r.dir, "ct.del")), "no conntrack delete");
});

test("AT-d-1d: a failed set, or NoSNAT still false afterwards, are failures", () => {
  const b = run("setfail", FIX, { setRc: 1 });
  assert.deepEqual([b.code, b.sets, b.out], [1, 1, "fail: tailscale set --snat-subnet-routes=false did not succeed"]);
  assert.ok(owed(b), "the marker is written before tailscale set, so the cut stays owed");
  const c = run("stays", FIX, { setNoop: true });
  assert.deepEqual([c.code, c.sets, c.out], [1, 1, "fail: NoSNAT is still false after tailscale set"]);
});

test("AT-d-1e: skipped without tailscale", () => {
  assert.equal(run("nots", FIX, { noTailscale: true }).code, 3);
});

test("AT-d-1f: after the fix, source-NATed flows on the API and dashboard ports are cut once (pre-review 1, Codex PR220-r2)", () => {
  const r = run("cut", FIX, { conntrack: { 3001: [], 3000: [] }, conf: "API_PORT=3001\n" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /old masqueraded connections on ports 3001 and 3000 cut/);
  assert.deepEqual(fs.readFileSync(path.join(r.dir, "ct.del"), "utf8").trim().split("\n"),
    ["-D -p tcp -s 100.64.0.0/10 -d 100.88.140.76 --dport 3001 --src-nat", "-D -p tcp -s 100.64.0.0/10 -d 100.88.140.76 --dport 3000 --src-nat"],
    "only source-NATed flows are deleted");
  assert.ok(!owed(r));
});

test("AT-d-1h: a failed cut is owed: exit 1, marker kept, retried on the next (already clean) tick (Codex PR220-r1)", () => {
  const a = run("cutfail", FIX, { conntrack: {}, ctDel: "timeout" });
  assert.equal(a.code, 1, a.out);
  assert.match(a.out, /fail: cutting old connections on port 3001 failed \(conntrack exit 124\); retried next tick/);
  assert.ok(owed(a), "the cut stays owed");
  const b = run("cutretry", FIX, { nosnat: true, conntrack: {}, ctDel: "none", pending: true });
  assert.equal(b.code, 0, b.out);
  assert.match(b.out, /^ok: .*\nold masqueraded connections on ports 3001 and 3000 cut/);
  assert.ok(!owed(b), "done once, marker gone");
  const c = run("cutnone", FIX, { nosnat: true, conntrack: {} });
  assert.deepEqual([c.code, c.out], [0, "ok: subnet-route SNAT is off (NoSNAT true)"], "nothing owed: no cut");
  assert.ok(!fs.existsSync(path.join(c.dir, "ct.del")));
});

test("AT-d-1i: prefs that are not JSON, lack a field, or hold the wrong type change nothing (Codex PR220-r1)", () => {
  for (const [n, prefs] of [["pjunk", "not json"], ["pempty", "{}"], ["pnoroutes", '{"NoSNAT":false}'],
    ["pnonosnat", '{"AdvertiseRoutes":null}'], ["pstr", '{"NoSNAT":false,"AdvertiseRoutes":"10.0.0.0/8"}'],
    ["pnsstr", '{"NoSNAT":"false","AdvertiseRoutes":null}'], ["parr", "[]"],
    ["ptrail", '{"NoSNAT":false,"AdvertiseRoutes":null} trailing junk'],
    ["ptwo", '{"NoSNAT":false,"AdvertiseRoutes":null}\n{"NoSNAT":false,"AdvertiseRoutes":null}']]) {
    const r = run(n, FIX, { prefs });
    assert.deepEqual([r.code, r.sets, r.out], [1, 0, "fail: cannot read NoSNAT and AdvertiseRoutes from tailscale prefs; not changed"], n);
  }
});

test("AT-d-1j: without the conntrack tool the cut is not owed forever", () => {
  const r = run("noct", FIX, {});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /note: conntrack not installed/);
  assert.ok(!owed(r));
});

// ---- checks/api-tailnet-peer.sh ----
test("AT-d-2a: pass: NoSNAT true and every tailnet client's reply goes back to that client", () => {
  const r = run("cpass", CHECK, { nosnat: true, conntrack: { 3001: [ct(KK, KK), ct(HOST, "172.16.3.1")], 3000: [] } });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, ["tailscale prefs: NoSNAT true (ok)",
    "port 3001: 1 inbound tailnet connection(s), none with a rewritten source",
    "port 3000: 0 inbound tailnet connection(s), none with a rewritten source"].join("\n"));
});

test("AT-d-2b: fail: NoSNAT false, or prefs unreadable", () => {
  const a = run("cmasq", CHECK, { conntrack: { 3001: [], 3000: [] } });
  assert.equal(a.code, 1);
  assert.match(a.out, /^fail: tailscaled's subnet-route SNAT is on \(NoSNAT false\)/);
  const b = run("cbad", CHECK, { prefs: "{}", conntrack: { 3001: [], 3000: [] } });
  assert.equal(b.code, 1);
  assert.match(b.out, /^fail: cannot read NoSNAT from tailscale prefs/);
  for (const [n, prefs] of [["ctrail", '{"NoSNAT":true} junk'], ["ctwo", '{"NoSNAT":true}\n{"NoSNAT":true}']]) {
    const c = run(n, CHECK, { prefs, conntrack: { 3001: [], 3000: [] } });
    assert.equal(c.code, 1, n);
    assert.match(c.out, /^fail: cannot read NoSNAT from tailscale prefs/, "trailing text or a second document is not read as true (Codex PR220-r4)");
  }
});

test("AT-d-2c: fail: KK's connection replied to the bridge gateway (the 23 Nov conntrack line), even with NoSNAT true", () => {
  const r = run("cnat", CHECK, { nosnat: true, conntrack: { 3001: [ct(KK, "172.16.3.1"), ct("100.101.1.2", "100.101.1.2")], 3000: [] } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /fail: port 3001: 1 of 2 inbound tailnet connection\(s\) have a rewritten source \(e\.g\. client 100\.80\.173\.125, reply to 172\.16\.3\.1\)/);
});

test("AT-d-2d: ports come from server-agent.conf; non-tailnet clients are not counted", () => {
  const r = run("cconf", CHECK, { nosnat: true, conf: "API_PORT=4001\nDASHBOARD_PORT=4000\n",
    conntrack: { 4001: [ct("203.0.113.9", "172.16.3.1", 4001), ct(KK, KK, 4001)], 4000: [ct(KK, KK, 4000)] } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /port 4001: 1 inbound/);
  assert.match(r.out, /port 4000: 1 inbound/);
});

test("AT-d-2g: conntrack installed but unreadable for a port fails, even with NoSNAT true (Codex PR220-r3)", () => {
  const r = run("cctfail", CHECK, { nosnat: true, conntrack: { 3001: [ct(KK, KK)] } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /fail: conntrack could not be read for port 3000/);
});

test("AT-d-2e: skipped without a tailnet address; conntrack missing reads the preference only", () => {
  assert.equal(run("cnoip", CHECK, { nosnat: true, ip: "" }).code, 3);
  const r = run("cnoct", CHECK, { nosnat: true });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /note: conntrack not installed: only the preference is checked/);
});

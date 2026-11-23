// DEVOS-251 (docs/modules/S4.md "S4-d Tailnet peer kept"): scripts/server/tailnet-snat.sh and
// scripts/server/checks/api-tailnet-peer.sh with fake `tailscale`, `iptables` and `conntrack`.
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

const MASQ = "-N ts-postrouting\n-A ts-postrouting -m mark --mark 0x40000/0xff0000 -j MASQUERADE\n";
const CLEAN = "-N ts-postrouting\n";
const KK = "100.80.173.125", HOST = "100.88.140.76";
const ct = (client, back, port = 3001) =>
  `tcp      6 431999 ESTABLISHED src=${client} dst=${HOST} sport=50926 dport=${port} src=172.16.3.6 dst=${back} sport=${port} dport=50926 [ASSURED] mark=0 use=1`;

// Fakes: `iptables -t nat -S ts-postrouting` prints the file `chain` (missing file = no chain, exit 1);
// `tailscale set --snat-subnet-routes=false` empties it (unless setNoop) and logs the call; `tailscale debug prefs`
// prints `prefs`; `tailscale ip -4` prints `ip`; `conntrack -L ... --dport <p>` prints the file ct.<p>.
function run(name, script, { chain, prefs = '{"AdvertiseRoutes":null}', setRc = 0, setNoop = false, ip = HOST,
  conntrack, noTailscale = false, conf = "" } = {}) {
  const dir = path.join(tmp, name);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(path.join(dir, "devos"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(dir, "devos/server-agent.conf"), conf);
  const chainFile = path.join(dir, "chain");
  if (chain !== undefined) fs.writeFileSync(chainFile, chain);
  fs.writeFileSync(path.join(bin, "iptables"), `#!/usr/bin/env bash
[[ "$*" == "-w 5 -t nat -S ts-postrouting" ]] || exit 9
[[ -f "${chainFile}" ]] || { echo "iptables: No chain/target/match by that name." >&2; exit 1; }
cat "${chainFile}"\n`, { mode: 0o755 });
  if (!noTailscale) {
    fs.writeFileSync(path.join(dir, "prefs"), prefs);
    fs.writeFileSync(path.join(bin, "tailscale"), `#!/usr/bin/env bash
case "$*" in
  "ip -4") echo "${ip}" ;;
  "debug prefs") cat "${path.join(dir, "prefs")}" ;;
  "set --snat-subnet-routes=false") echo set >> "${path.join(dir, "set.log")}"; ${setNoop ? "true" : `[[ ${setRc} -eq 0 ]] && printf '%s' "${CLEAN.replace(/\n/g, "\\n")}" > "${chainFile}"`}; exit ${setRc} ;;
  *) exit 9 ;;
esac\n`, { mode: 0o755 });
  }
  if (conntrack) {
    for (const [p, lines] of Object.entries(conntrack)) fs.writeFileSync(path.join(dir, `ct.${p}`), lines.join("\n") + (lines.length ? "\n" : ""));
    fs.writeFileSync(path.join(bin, "conntrack"), `#!/usr/bin/env bash
[[ "$1 $2 $3 $4 $5" == "-L -p tcp -d ${ip}" && "$6" == "--dport" ]] || exit 9
f="${dir}/ct.$7"; [[ -f "$f" ]] || exit 1
cat "$f"; echo "conntrack v1.4.6 (conntrack-tools): 1 flow entries have been shown." >&2\n`, { mode: 0o755 });
  }
  for (const t of ["timeout", "cat", "bash", "grep", "sed", "head", "jq", "sleep", "printf"]) {
    const real = spawnSync("bash", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    if (real && real.startsWith("/")) fs.symlinkSync(real, path.join(bin, t));
  }
  const r = spawnSync("/bin/bash", [script], { encoding: "utf8", env: { PATH: bin, DEVOS_DIR: path.join(dir, "devos") } });
  const sets = fs.existsSync(path.join(dir, "set.log")) ? fs.readFileSync(path.join(dir, "set.log"), "utf8").split("\n").filter(Boolean).length : 0;
  return { code: r.status, out: (r.stdout + r.stderr).trim(), sets };
}

// ---- tailnet-snat.sh ----
test("AT-d-1a: the masquerade rule present is turned off once and confirmed gone", () => {
  const r = run("fix", FIX, { chain: MASQ });
  assert.deepEqual([r.code, r.sets], [0, 1], r.out);
  assert.match(r.out, /^fixed: subnet-route SNAT turned off/);
});

test("AT-d-1b: no masquerade rule: nothing changes (idempotent)", () => {
  const r = run("clean", FIX, { chain: CLEAN });
  assert.deepEqual([r.code, r.sets, r.out], [0, 0, "ok: tailscaled does not masquerade forwarded tailnet traffic"]);
});

test("AT-d-1c: a host that advertises routes (subnet router or exit node) is left alone and fails", () => {
  const r = run("router", FIX, { chain: MASQ, prefs: '{"AdvertiseRoutes":["0.0.0.0/0","::/0"]}' });
  assert.deepEqual([r.code, r.sets], [1, 0], r.out);
  assert.match(r.out, /advertises 2 route\(s\).*KK decision/);
});

test("AT-d-1d: unreadable prefs, a failed set, or a rule that stays are failures", () => {
  const a = run("noprefs", FIX, { chain: MASQ, prefs: "not json" });
  assert.deepEqual([a.code, a.sets], [1, 0], a.out);
  const b = run("setfail", FIX, { chain: MASQ, setRc: 1 });
  assert.deepEqual([b.code, b.sets, b.out], [1, 1, "fail: tailscale set --snat-subnet-routes=false did not succeed"]);
  const c = run("stays", FIX, { chain: MASQ, setNoop: true });
  assert.deepEqual([c.code, c.sets], [1, 1], c.out);
  assert.match(c.out, /still there after tailscale set$/);
});

test("AT-d-1e: skipped without tailscale, or with no ts-postrouting chain", () => {
  assert.equal(run("nots", FIX, { chain: MASQ, noTailscale: true }).code, 3);
  const r = run("nochain", FIX, {});
  assert.deepEqual([r.code, r.sets], [3, 0], r.out);
});

// ---- checks/api-tailnet-peer.sh ----
test("AT-d-2a: pass: no masquerade rule and every tailnet client's reply goes back to that client", () => {
  const r = run("cpass", CHECK, { chain: CLEAN, conntrack: { 3001: [ct(KK, KK), ct(HOST, "172.16.3.1")], 3000: [] } });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, ["ts-postrouting: no MASQUERADE (ok)",
    "port 3001: 1 inbound tailnet connection(s), none with a rewritten source",
    "port 3000: 0 inbound tailnet connection(s), none with a rewritten source"].join("\n"));
});

test("AT-d-2b: fail: the masquerade rule is present", () => {
  const r = run("cmasq", CHECK, { chain: MASQ, conntrack: { 3001: [], 3000: [] } });
  assert.equal(r.code, 1);
  assert.match(r.out, /^fail: tailscaled masquerades forwarded tailnet traffic/);
});

test("AT-d-2c: fail: KK's connection replied to the bridge gateway (the 23 Nov conntrack line), even with no rule visible", () => {
  const r = run("cnat", CHECK, { conntrack: { 3001: [ct(KK, "172.16.3.1"), ct("100.101.1.2", "100.101.1.2")], 3000: [] } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /note: no ts-postrouting chain to read/);
  assert.match(r.out, /fail: port 3001: 1 of 2 inbound tailnet connection\(s\) have a rewritten source \(e\.g\. client 100\.80\.173\.125, reply to 172\.16\.3\.1\)/);
});

test("AT-d-2d: ports come from server-agent.conf; non-tailnet clients are not counted", () => {
  const r = run("cconf", CHECK, { chain: CLEAN, conf: "API_PORT=4001\nDASHBOARD_PORT=4000\n",
    conntrack: { 4001: [ct("203.0.113.9", "172.16.3.1", 4001), ct(KK, KK, 4001)], 4000: [ct(KK, KK, 4000)] } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /port 4001: 1 inbound/);
  assert.match(r.out, /port 4000: 1 inbound/);
});

test("AT-d-2e: skipped without a tailnet address or with nothing readable; conntrack missing reads the rule only", () => {
  assert.equal(run("cnoip", CHECK, { chain: CLEAN, ip: "" }).code, 3);
  assert.equal(run("cnothing", CHECK, {}).code, 3);
  const r = run("cnoct", CHECK, { chain: CLEAN });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /note: conntrack not installed: only the masquerade rule is checked/);
});

// DEVOS-65 (S4-b): scripts/server/isolation-apply.sh against a fake `iptables` (chains kept as files), a fake
// `iptables-restore`, a fake `curl` (serves FAKE_STATE) and real TCP listeners for the self-test.
// Contract: docs/modules/S4.md (S4-b, AT5-AT8).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts/server/isolation-apply.sh");
const GOLDEN = path.join(ROOT, "scripts/test/fixtures/isolation-golden.rules");
let tmp, bin, up, upPort, downPort;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devos-iso-"));
  bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const w = (n, body) => { fs.writeFileSync(path.join(bin, n), `#!/usr/bin/env bash\n${body}\n`); fs.chmodSync(path.join(bin, n), 0o755); };
  // iptables: each chain is a file in $FAKE_NF (one rule per line, "-A CHAIN ..."); -w N is ignored.
  // Both fakes take one xtables lock file like the legacy backend (Codex PR54-r1): restore holds it for its whole
  // run, so an iptables query issued while a restore is running fails (exit 4) instead of answering.
  w("iptables", `exec 8>"$FAKE_LOG/xtables.lock"; flock -w 1 8 || { echo "xtables lock held" >&2; exit 4; }
[[ "$1" == -w ]] && shift 2
echo "$*" >> "$FAKE_LOG/iptables.log"
# Codex PR210-r3: after a restore with FAKE_QFAIL set, every query fails like a held xtables lock (exit 4).
[[ -f "$FAKE_LOG/qfail" && ( "$1" == -S || "$1" == -C ) ]] && { echo "xtables lock held" >&2; exit 4; }
if [[ "$*" == -S ]]; then  # whole-table listing: every chain, its policy or -N line, then its rules
  for f in "$FAKE_NF"/*; do [[ -f "$f" ]] || continue; ch="\${f##*/}"
    [[ "$ch" == INPUT || "$ch" == FORWARD ]] && echo "-P $ch DROP" || echo "-N $ch"; cat "$f"; done; exit 0
fi
op="$1" ch="$2"; shift 2; f="$FAKE_NF/$ch"
[[ "$op" == -S && -n "\${FAKE_IPT_S_SLEEP:-}" ]] && sleep "$FAKE_IPT_S_SLEEP"
[[ "$op" == -D && -n "\${FAKE_IPT_D_RC:-}" ]] && exit "$FAKE_IPT_D_RC"  # Codex PR165-r1: a failed rule delete
case "$op" in
  -S) [[ -f "$f" ]] || exit 1; [[ "$ch" == INPUT || "$ch" == FORWARD ]] && echo "-P $ch DROP" || echo "-N $ch"; cat "$f" ;;
  -C) [[ -f "$f" ]] && grep -qxF -- "-A $ch $*" "$f" ;;
  -D) [[ -f "$f" ]] && grep -qxF -- "-A $ch $*" "$f" || exit 1
      awk -v r="-A $ch $*" '!d && $0==r {d=1; next} {print}' "$f" > "$f.n" && mv "$f.n" "$f" ;;
  -I) shift; { echo "-A $ch $*"; cat "$f"; } > "$f.n" && mv "$f.n" "$f" ;;
  -F) : > "$f" ;;
  -X) rm -f "$f" ;;
  *) exit 2 ;;
esac`);
  // iptables-restore --noflush: all-or-nothing like the real one (FAKE_RESTORE_RC != 0 fails before any
  // change); declared chains are (re)created empty, then -A / -D / -I lines are applied in order. When
  // FAKE_KILL_PID is set, that process (a self-test listener) is killed after a successful restore.
  w("iptables-restore", `exec 8>"$FAKE_LOG/xtables.lock"; flock 8; sleep 0.2; in="$(cat)"; n=$(ls "$FAKE_LOG" | grep -c '^restore\\.' ); printf '%s\\n' "$in" > "$FAKE_LOG/restore.$n"
[[ "\${FAKE_RESTORE_RC:-0}" == 0 ]] || exit "$FAKE_RESTORE_RC"
while IFS= read -r l; do
  c="$(cut -d' ' -f2 <<<"$l")"; f="$FAKE_NF/$c"
  case "$l" in
    :*) c="\${l#:}"; c="\${c%% *}"; : > "$FAKE_NF/$c" ;;
    -A\\ *) echo "$l" >> "$f" ;;
    -D\\ *) r="-A \${l#-D }"; awk -v r="$r" '!d && $0==r {d=1; next} {print}' "$f" > "$f.n" && mv "$f.n" "$f" ;;
    -I\\ *) r="\${l#-I $c 1 }"; { echo "-A $c $r"; cat "$f"; } > "$f.n" && mv "$f.n" "$f" ;;
  esac
done <<<"$in"
[[ -z "\${FAKE_QFAIL:-}" ]] || : > "$FAKE_LOG/qfail"
if [[ -n "\${FAKE_KILL_PID:-}" ]]; then kill -9 "$FAKE_KILL_PID" 2>/dev/null; sleep 0.3; fi`);
  // curl: logs argv (to prove the token is not on it) and prints FAKE_STATE; FAKE_CURL_RC fails the fetch.
  w("curl", `echo "$*" >> "$FAKE_LOG/curl.args"; [[ -z "\${FAKE_CURL_SLEEP:-}" ]] || sleep "$FAKE_CURL_SLEEP"; [[ "\${FAKE_CURL_RC:-0}" == 0 ]] || exit "$FAKE_CURL_RC"; [[ -z "\${FAKE_CURL_TOUCH:-}" ]] || : > "$FAKE_CURL_TOUCH"; cat "$FAKE_STATE"`);
  w("tailscale", `exit 1`);
  // ip6tables / ip6tables-restore (S4-b2c): the same fakes over $FAKE_NF/v6 and $FAKE_LOG/v6, so the IPv4
  // restore count and logs are not mixed with IPv6. FAKE_V6_RC fails every ip6tables call; FAKE_V6_RESTORE_RC the restore.
  w("ip6tables", `[[ "\${FAKE_V6_RC:-0}" == 0 ]] || exit "$FAKE_V6_RC"; FAKE_NF="$FAKE_NF/v6" FAKE_LOG="$FAKE_LOG/v6" FAKE_IPT_S_SLEEP="\${FAKE_V6_S_SLEEP:-}" FAKE_IPT_D_RC= exec "\${0%/*}/iptables" "$@"`);
  w("ip6tables-restore", `FAKE_NF="$FAKE_NF/v6" FAKE_LOG="$FAKE_LOG/v6" FAKE_RESTORE_RC="\${FAKE_V6_RESTORE_RC:-0}" FAKE_KILL_PID= FAKE_QFAIL= exec "\${0%/*}/iptables-restore" "$@"`);
  // conntrack (S4-b2d): logs argv; FAKE_CT_RC fails it with another message; with no match the real one exits 1.
  w("conntrack", `echo "$*" >> "$FAKE_LOG/conntrack.log"; [[ "\${FAKE_CT_RC:-0}" == 0 ]] || { echo "conntrack v1.4.7 (conntrack-tools): Operation failed: injected" >&2; exit "$FAKE_CT_RC"; }
[[ -n "\${FAKE_CT_NOMATCH:-}" ]] && { echo "conntrack v1.4.7 (conntrack-tools): 0 flow entries have been deleted." >&2; exit 1; }
echo "conntrack v1.4.7 (conntrack-tools): 3 flow entries have been deleted." >&2`);
  up = net.createServer((s) => s.end()).listen(0, "127.0.0.1");
  await new Promise((r) => up.once("listening", r));
  upPort = up.address().port;
  const d = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => d.once("listening", r));
  downPort = d.address().port;
  await new Promise((r) => d.close(r));
});
after(() => { up?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const STATE = { stacks: [
  { slug: "beta", env: "live", idx: 257, egress: true, tailnet: [] },
  { slug: "alpha", env: "preview", idx: 0, egress: false, tailnet: ["100.101.102.103/32"] },
] };

// /etc/ufw/after.rules as M0.1 v1.3.1 leaves it: ufw's own head, then the DEVOS UFW AND DOCKER block at the end.
const UFW_HEAD = "# rules.input-after\n*filter\n:ufw-after-input - [0:0]\nCOMMIT\n";
const M01 = `# BEGIN DEVOS UFW AND DOCKER (M0.1 v1.3.1) - default-deny
*filter
:ufw-user-forward - [0:0]
:ufw-docker-logging-deny - [0:0]
:DOCKER-USER - [0:0]
-A DOCKER-USER -j ufw-user-forward
-A DOCKER-USER -j ufw-docker-logging-deny
COMMIT
# END DEVOS UFW AND DOCKER
`;
// after6.rules as M0.1 v1.3.1 leaves it (S4-b2c).
const UFW_HEAD6 = "# rules.input-after\n*filter\n:ufw6-after-input - [0:0]\nCOMMIT\n";
const M01_6 = `# BEGIN DEVOS UFW AND DOCKER (M0.1 v1.3.1, IPv6) - same policy; containers use ULA fd00::/8.
*filter
:ufw6-user-forward - [0:0]
:ufw6-docker-logging-deny - [0:0]
:DOCKER-USER - [0:0]
-A DOCKER-USER -j ufw6-user-forward
-A DOCKER-USER -j ufw6-docker-logging-deny
COMMIT
# END DEVOS UFW AND DOCKER
`;
// Both ufw paths, so no test ever falls back to the real /etc/ufw files.
const AFTER_CONF = (h) => `ISOLATION_UFW_AFTER_RULES=${path.join(h, "after.rules")}\nISOLATION_UFW_AFTER6_RULES=${path.join(h, "after6.rules")}\n`;
const afterRules = (h) => fs.readFileSync(path.join(h, "after.rules"), "utf8");
const bootBlock = (h) => { const m = afterRules(h).match(/# BEGIN DEVOS S4 ISOLATION[^\n]*\n([\s\S]*?)# END DEVOS S4 ISOLATION\n/); return m && m[1]; };

function host(state, { conf = "", token = "t0ken-" + "a".repeat(30) } = {}) {
  const h = fs.mkdtempSync(path.join(tmp, "h-"));
  for (const d of ["devos/secrets", "nf/v6", "log/v6"]) fs.mkdirSync(path.join(h, d), { recursive: true });
  if (token !== null) fs.writeFileSync(path.join(h, "devos/secrets/isolation_state_token"), token + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(h, "devos/server-agent.conf"), `ISOLATION_SELFTEST_TARGETS=127.0.0.1:${upPort}\n${conf}${AFTER_CONF(h)}`);
  fs.writeFileSync(path.join(h, "after.rules"), UFW_HEAD + M01, { mode: 0o640 });
  fs.writeFileSync(path.join(h, "after6.rules"), UFW_HEAD6 + M01_6, { mode: 0o640 });
  fs.writeFileSync(path.join(h, "nf/v6/DOCKER-USER"), "-A DOCKER-USER -j ufw6-user-forward\n-A DOCKER-USER -j ufw6-docker-logging-deny\n");
  fs.writeFileSync(path.join(h, "nf/v6/INPUT"), "-A INPUT -j ufw6-before-logging-input\n");
  fs.writeFileSync(path.join(h, "nf/v6/FORWARD"), "-A FORWARD -j ufw6-before-logging-forward\n");
  fs.writeFileSync(path.join(h, "nf/DOCKER-USER"), "-A DOCKER-USER -j ufw-user-forward\n-A DOCKER-USER -j ufw-docker-logging-deny\n");
  fs.writeFileSync(path.join(h, "nf/INPUT"), "-A INPUT -j ufw-before-logging-input\n");
  fs.writeFileSync(path.join(h, "nf/FORWARD"), "-A FORWARD -j ts-forward\n-A FORWARD -j DOCKER-USER\n");
  setState(h, state);
  return h;
}
const setState = (h, s) => fs.writeFileSync(path.join(h, "state.json"), typeof s === "string" ? s : JSON.stringify(s));
function run(h, args = [], env = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, DEVOS_DIR: path.join(h, "devos"),
    FAKE_NF: path.join(h, "nf"), FAKE_LOG: path.join(h, "log"), FAKE_STATE: path.join(h, "state.json"), ...env } });
  const out = r.stdout + r.stderr;
  // DEVOS-128 (v1.5.0): every failed apply run (exit 1) ends with exactly one fixed reason line; the agent keeps
  // only that code. Checked on every exit-1 run in this file, so no failure path can be missed.
  if (r.status === 1 && !args.includes("--remove")) {
    // stdout's last line (stderr, e.g. from an EXIT trap, can land after it; the agent reads the last reason line)
    assert.match(r.stdout.trimEnd().split("\n").at(-1), REASON_LINE, `exit 1 without a reason line:\n${out}`);
    assert.equal(out.split("\n").filter((l) => l.startsWith("reason: ")).length, 1, `one reason line only:\n${out}`);
  }
  return { code: r.status, out, stdout: r.stdout };
}
const REASON_LINE = /^reason: (config|token|state-fetch|refused|lock|deadline|conntrack|apply|self-test|rollback|record|boot-persistence|ipv6)$/;
const reason = (r) => (r.stdout.trimEnd().split("\n").at(-1).match(REASON_LINE) || [])[1];
const nf = (h, c) => (fs.existsSync(path.join(h, "nf", c)) ? fs.readFileSync(path.join(h, "nf", c), "utf8") : null);
const restores = (h) => fs.readdirSync(path.join(h, "log")).filter((f) => f.startsWith("restore.")).length;
const installed = (h) => path.join(h, "devos/isolation/installed.rules");

test("AT5 generated block equals the golden file (pool, private ranges, metadata, egress, gateway DNS)", () => {
  const h = host(STATE);
  const r = run(h, ["--dry-run"]);
  assert.equal(r.code, 0, r.out);
  const block = r.out.split("\n# dry run")[0] + "\n";
  assert.equal(block, fs.readFileSync(GOLDEN, "utf8"));
  assert.match(block, /-A DEVOS-ISO-FWD -s 10\.209\.1\.0\/24 -m comment --comment "beta\/live egress" -j RETURN/);
  assert.doesNotMatch(block, /alpha\/preview egress/);
  assert.match(block, /-A DEVOS-ISO-FWD -d 169\.254\.0\.0\/16 -j DROP/);
  assert.equal(restores(h), 0, "dry run writes nothing");
  assert.equal(fs.existsSync(installed(h)), false);
});

test("apply puts both jumps first, records the block, and a second run writes nothing (AT7)", () => {
  const h = host(STATE);
  let r = run(h);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /applied: 2 stacks, self-test passed/);
  assert.equal(nf(h, "DOCKER-USER").split("\n")[0], "-A DOCKER-USER -j DEVOS-ISO-FWD");
  assert.equal(nf(h, "DOCKER-USER").split("\n")[1], "-A DOCKER-USER -j ufw-user-forward", "M0.1 rules kept");
  assert.equal(nf(h, "INPUT").split("\n")[0], "-A INPUT -j DEVOS-ISO-IN");
  assert.equal(fs.readFileSync(installed(h), "utf8"), fs.readFileSync(GOLDEN, "utf8"));
  const log = fs.readFileSync(path.join(h, "log/curl.args"), "utf8");
  assert.doesNotMatch(log, /t0ken/, "token never on curl's argv");
  assert.match(log, /--max-time 10/);
  const ipLog1 = fs.readFileSync(path.join(h, "log/iptables.log"), "utf8");
  r = run(h);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /unchanged/);
  assert.equal(restores(h), 1, "no second iptables-restore");
  const writes = fs.readFileSync(path.join(h, "log/iptables.log"), "utf8").slice(ipLog1.length).split("\n").filter((l) => /^-(I|D|F|X) /.test(l));
  assert.deepEqual(writes, [], "no iptables write on an unchanged state");
});

test("a moved jump is put back first without duplicating it", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  fs.writeFileSync(path.join(h, "nf/DOCKER-USER"), "-A DOCKER-USER -j ufw-user-forward\n-A DOCKER-USER -j DEVOS-ISO-FWD\n");
  const r = run(h);
  assert.equal(r.code, 0, r.out);
  const du = nf(h, "DOCKER-USER");
  assert.equal(du.split("\n")[0], "-A DOCKER-USER -j DEVOS-ISO-FWD");
  assert.equal(du.match(/DEVOS-ISO-FWD/g).length, 1);
});

for (const [name, bad] of [
  ["invalid slug", { stacks: [{ slug: "Bad_Slug", env: "live", idx: 1, egress: false, tailnet: [] }] }],
  ["index above 1023", { stacks: [{ slug: "a", env: "live", idx: 1024, egress: false, tailnet: [] }] }],
  ["fractional index", { stacks: [{ slug: "a", env: "live", idx: 1.5, egress: false, tailnet: [] }] }],
  ["duplicate index", { stacks: [{ slug: "a", env: "live", idx: 3, egress: false, tailnet: [] }, { slug: "b", env: "live", idx: 3, egress: false, tailnet: [] }]}],
  ["tailnet CIDR outside 100.64/10", { stacks: [{ slug: "a", env: "live", idx: 1, egress: false, tailnet: ["10.0.0.0/8"] }] }],
  ["IPv6 tailnet entry (no ip6tables rule until S4-b2)", { stacks: [{ slug: "a", env: "live", idx: 1, egress: false, tailnet: ["fd7a:115c:a1e0::5/128"] }] }],
  ["too-wide tailnet prefix", { stacks: [{ slug: "a", env: "live", idx: 1, egress: false, tailnet: ["100.64.0.0/2"] }] }],
  ["unknown env", { stacks: [{ slug: "a", env: "prod", idx: 1, egress: false, tailnet: [] }] }],
  ["string egress", { stacks: [{ slug: "a", env: "live", idx: 1, egress: "yes", tailnet: [] }] }],
  ["extra field", { stacks: [{ slug: "a", env: "live", idx: 1, egress: false, tailnet: [], secret: "x" }] }],
  ["malformed JSON", "{\"stacks\": ["],
  ["newline in a tailnet string forging a stack", { stacks: [{ slug: "alpha", env: "preview", idx: 0, egress: false, tailnet: ["100.64.0.1/32\n7\tforged\tlive\ttrue\t100.64.0.0/10"] }] }],
  ["two CIDRs in one string", { stacks: [{ slug: "a", env: "live", idx: 1, egress: false, tailnet: ["100.64.0.1/32,100.64.0.2/32"] }] }],
  ["two concatenated documents", '{"stacks":[]}{"stacks":[{"slug":"a","env":"live","idx":1,"egress":true,"tailnet":[]}]}'],
  ["injection in comment text", { stacks: [{ slug: "a\" -j ACCEPT", env: "live", idx: 1, egress: false, tailnet: [] }] }],
]) {
  test(`AT6 bad state refused: ${name}; last good block kept`, () => {
    const h = host(STATE);
    assert.equal(run(h).code, 0);
    const before = fs.readFileSync(installed(h), "utf8");
    setState(h, bad);
    const r = run(h);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /refused: .*nothing changed/);
    assert.equal(reason(r), "refused", "DEVOS-128 reason code");
    assert.equal(restores(h), 1, "nothing applied");
    assert.equal(fs.readFileSync(installed(h), "utf8"), before);
  });
}

test("AT6 a failed state fetch changes nothing", () => {
  const h = host(STATE);
  const r = run(h, [], { FAKE_CURL_RC: "7" });
  assert.equal(r.code, 1, r.out);
  assert.equal(reason(r), "state-fetch", "DEVOS-128 reason code");
  assert.match(r.out, /state fetch failed \(curl exit 7\): nothing changed/);
  assert.equal(restores(h), 0);
});

test("AT7 a failed iptables-restore leaves the previous chains, jumps and record in place", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  const snap = ["DOCKER-USER", "INPUT", "DEVOS-ISO-FWD", "DEVOS-ISO-IN"].map((c) => nf(h, c));
  const before = fs.readFileSync(installed(h), "utf8");
  setState(h, { stacks: [] });
  const r = run(h, [], { FAKE_RESTORE_RC: "1" });
  assert.equal(r.code, 1, r.out);
  assert.equal(reason(r), "apply", "DEVOS-128 reason code");
  assert.match(r.out, /apply failed .*previous block is still in place/);
  assert.deepEqual(["DOCKER-USER", "INPUT", "DEVOS-ISO-FWD", "DEVOS-ISO-IN"].map((c) => nf(h, c)), snap);
  assert.equal(fs.readFileSync(installed(h), "utf8"), before);
});

test("AT7 the jumps change in the same restore transaction as the chains (no -D/-I outside it)", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  const tx = fs.readFileSync(path.join(h, "log/restore.0"), "utf8");
  assert.match(tx, /-I DOCKER-USER 1 -j DEVOS-ISO-FWD\n-I FORWARD 1 -j DEVOS-ISO-FWD\n-I INPUT 1 -j DEVOS-ISO-IN\nCOMMIT\n$/);
  const writes = fs.readFileSync(path.join(h, "log/iptables.log"), "utf8").split("\n").filter((l) => /^-(I|D|F|X) /.test(l));
  assert.deepEqual(writes, []);
});

test("FORWARD gets the jump first, above tailscaled's ts-forward, and keeps it there", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  assert.deepEqual(nf(h, "FORWARD").split("\n").slice(0, 2), ["-A FORWARD -j DEVOS-ISO-FWD", "-A FORWARD -j ts-forward"]);
  // tailscaled restarts and re-inserts ts-forward at position 1
  fs.writeFileSync(path.join(h, "nf/FORWARD"), "-A FORWARD -j ts-forward\n" + nf(h, "FORWARD").replace("-A FORWARD -j ts-forward\n", ""));
  const r = run(h);
  assert.equal(r.code, 0, r.out);
  assert.equal(nf(h, "FORWARD").split("\n")[0], "-A FORWARD -j DEVOS-ISO-FWD");
  assert.equal(nf(h, "FORWARD").match(/DEVOS-ISO-FWD/g).length, 1);
  assert.equal(run(h, ["--remove"]).code, 0);
  assert.doesNotMatch(nf(h, "FORWARD"), /DEVOS-ISO/);
});

test("drift: a hand-edited rule with the same rule count is rebuilt on the next run", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  const good = nf(h, "DEVOS-ISO-FWD");
  fs.writeFileSync(path.join(h, "nf/DEVOS-ISO-FWD"), good.replace(/-A DEVOS-ISO-FWD -j DROP\n$/, "-A DEVOS-ISO-FWD -j ACCEPT\n"));
  assert.notEqual(nf(h, "DEVOS-ISO-FWD"), good);
  const r = run(h);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /applied/);
  assert.equal(nf(h, "DEVOS-ISO-FWD"), good);
});

test("drift: a hand-flushed S4 chain is rebuilt on the next run", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  const good = nf(h, "DEVOS-ISO-FWD");
  fs.writeFileSync(path.join(h, "nf/DEVOS-ISO-FWD"), "");
  const r = run(h);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /applied/);
  assert.equal(nf(h, "DEVOS-ISO-FWD"), good);
});

test("index 1023 is accepted (pool 10.211.255.0/24)", () => {
  const h = host({ stacks: [{ slug: "last", env: "live", idx: 1023, egress: false, tailnet: [] }] });
  const r = run(h, ["--dry-run"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /-s 10\.211\.255\.0\/24 -d 10\.211\.255\.0\/24/);
});

async function listener() {  // a self-test target in its own process, so the fake restore can kill it
  const c = spawn(process.execPath, ["-e", "require('net').createServer(s=>s.end()).listen(0,'127.0.0.1',function(){console.log(this.address().port)})"]);
  const port = await new Promise((r) => c.stdout.once("data", (d) => r(Number(String(d).trim()))));
  return { pid: c.pid, port, stop: () => { try { c.kill("SIGKILL"); } catch {} } };
}
// Keeps the after.rules line, so no test ever falls back to the real /etc/ufw/after.rules.
const targets = (h, ...ports) => fs.writeFileSync(path.join(h, "devos/server-agent.conf"),
  `ISOLATION_SELFTEST_TARGETS=${ports.map((p) => "127.0.0.1:" + p).join(" ")}\n${AFTER_CONF(h)}`);

test("AT8 self-test that passed before and fails after rolls back to the previous block", async () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  const good = nf(h, "DEVOS-ISO-FWD");
  const l = await listener();
  try {
    targets(h, upPort, l.port);
    setState(h, { stacks: [{ slug: "gamma", env: "live", idx: 5, egress: true, tailnet: [] }] });
    const r = run(h, [], { FAKE_KILL_PID: String(l.pid) });
    assert.equal(r.code, 1, r.out);
    assert.equal(reason(r), "self-test", "DEVOS-128 reason code");
    assert.match(r.out, /self-test failed after apply \(self-test: 127\.0\.0\.1:\d+ did not answer\)/);
    assert.match(r.out, /rolled back to the previous block/);
    assert.equal(nf(h, "DEVOS-ISO-FWD"), good);
    assert.equal(nf(h, "DOCKER-USER").match(/DEVOS-ISO-FWD/g).length, 1);
    assert.doesNotMatch(fs.readFileSync(installed(h), "utf8"), /gamma/);
  } finally { l.stop(); }
});

test("DEVOS-128: an isolation directory that cannot be created says lock", () => {
  const h = host(STATE);
  fs.rmSync(path.join(h, "devos/isolation"), { recursive: true, force: true });
  fs.writeFileSync(path.join(h, "devos/isolation"), "not a directory\n");
  const r = run(h);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /cannot create .*isolation/);
  assert.equal(reason(r), "lock");
  assert.equal(restores(h), 0, "nothing applied");
});

test("DEVOS-128: a rollback whose record fails says rollback, names the step, and still restores the rest", async () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  const good = nf(h, "DEVOS-ISO-FWD");
  const l = await listener();
  try {
    targets(h, upPort, l.port);
    setState(h, { stacks: [{ slug: "gamma", env: "live", idx: 5, egress: true, tailnet: [] }] });
    fs.mkdirSync(path.join(h, "devos/isolation/installed.rules.tmp")); // the rollback's record() cannot write
    const r = run(h, [], { FAKE_KILL_PID: String(l.pid) });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /rolled back to the previous block, but .*installed\.rules could not be recorded/);
    assert.doesNotMatch(r.out, /--remove/, "a restored live block is never followed by a --remove instruction (PR210-r2)");
    assert.equal(reason(r), "rollback");
    assert.equal(nf(h, "DEVOS-ISO-FWD"), good, "the live rollback happened");
  } finally { l.stop(); }
});

test("DEVOS-128 (Codex PR210-r1): a rollback whose boot block cannot be restored says rollback; the live block is restored", async () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  const good = nf(h, "DEVOS-ISO-FWD");
  const l = await listener();
  try {
    targets(h, upPort, l.port);
    setState(h, { stacks: [{ slug: "gamma", env: "live", idx: 5, egress: true, tailnet: [] }] });
    fs.writeFileSync(path.join(h, "after.rules"), UFW_HEAD);   // M0.1's block gone: boot_sync cannot write
    const r = run(h, [], { FAKE_KILL_PID: String(l.pid) });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /rolled back to the previous block, but the boot block in .* could not be restored/);
    assert.equal(reason(r), "rollback");
    assert.equal(nf(h, "DEVOS-ISO-FWD"), good, "the live rollback itself still happened");
  } finally { l.stop(); }
});

test("AT8 self-test failure on the first apply removes the block entirely", async () => {
  const h = host(STATE);
  const l = await listener();
  try {
    targets(h, l.port);
    const r = run(h, [], { FAKE_KILL_PID: String(l.pid) });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /rolled back: S4 block removed/);
    assert.equal(nf(h, "DEVOS-ISO-FWD"), null);
    assert.doesNotMatch(nf(h, "DOCKER-USER"), /DEVOS-ISO/);
    assert.doesNotMatch(nf(h, "INPUT"), /DEVOS-ISO/);
    assert.equal(fs.existsSync(installed(h)), false);
  } finally { l.stop(); }
});

test("DEVOS-128 (Codex PR210-r3): a first-apply rollback whose firewall queries fail says rollback and asks for --remove", async () => {
  const h = host(STATE);
  const l = await listener();
  try {
    targets(h, l.port);
    const r = run(h, [], { FAKE_KILL_PID: String(l.pid), FAKE_QFAIL: "1" });  // every query fails after the restore
    assert.equal(r.code, 1, r.out);
    assert.doesNotMatch(r.out, /rolled back: S4 block removed/, "a failed query never reads as removed");
    assert.match(r.out, /the firewall did not answer \(ipt -S\)/);
    assert.match(r.out, /rollback failed: run .* --remove from the console/);
    assert.equal(reason(r), "rollback");
    assert.match(nf(h, "DOCKER-USER"), /DEVOS-ISO-FWD/, "the rules really are still in place");
  } finally { l.stop(); }
});

test("DEVOS-128 (Codex PR210-r3): --remove does not report success while iptables queries fail", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  fs.writeFileSync(path.join(h, "log/qfail"), "");
  const r = run(h, ["--remove"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /some IPv4 S4 rules are still in place/);
  assert.doesNotMatch(r.out, /^removed:/m);
});

test("a host self-test already failing before the change keeps the block (isolation is the floor) and reports it", () => {
  const h = host(STATE);
  targets(h, downPort);
  const r = run(h);
  assert.equal(r.code, 1, r.out);
  assert.equal(reason(r), "self-test", "DEVOS-128 reason code");
  assert.match(r.out, /block kept; the host self-test was already failing before the change/);
  assert.equal(nf(h, "DOCKER-USER").split("\n")[0], "-A DOCKER-USER -j DEVOS-ISO-FWD");
  assert.equal(fs.readFileSync(installed(h), "utf8"), fs.readFileSync(GOLDEN, "utf8"));
});

test("a second run waits for nobody: a held lock skips (exit 3) and changes nothing", () => {
  const h = host(STATE);
  fs.mkdirSync(path.join(h, "devos/isolation"), { recursive: true });
  const lock = path.join(h, "devos/isolation/.lock");
  fs.writeFileSync(lock, "");
  const holder = spawn("flock", [lock, "sleep", "5"]);
  spawnSync("sleep", ["0.3"]);
  try {
    const r = run(h);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /another isolation-apply run holds/);
    assert.equal(restores(h), 0);
  } finally { holder.kill("SIGKILL"); }
});

test("AT8 --remove leaves only the M0.1/M0.2 rules", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  const r = run(h, ["--remove"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(nf(h, "DOCKER-USER"), "-A DOCKER-USER -j ufw-user-forward\n-A DOCKER-USER -j ufw-docker-logging-deny\n");
  assert.equal(nf(h, "INPUT"), "-A INPUT -j ufw-before-logging-input\n");
  assert.equal(nf(h, "DEVOS-ISO-FWD"), null);
  assert.equal(nf(h, "DEVOS-ISO-IN"), null);
  assert.equal(fs.existsSync(installed(h)), false);
  assert.equal(run(h, ["--remove"]).code, 0, "remove is idempotent");
});

test("S4-b2a: --remove keeps the block off (isolation/disabled) until KK deletes the marker", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  assert.equal(run(h, ["--remove"]).code, 0);
  const marker = path.join(h, "devos/isolation/disabled");
  assert.ok(fs.existsSync(marker), "--remove writes the marker");
  const before = restores(h);
  const r = run(h);
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /disabled: --remove was run; delete .*isolation\/disabled/);
  assert.equal(restores(h), before, "a disabled run changes nothing");
  assert.equal(nf(h, "DEVOS-ISO-FWD"), null);
  assert.equal(run(h, ["--dry-run"]).code, 0, "--dry-run still works while disabled");
  fs.rmSync(marker);
  assert.equal(run(h).code, 0, "deleting the marker turns the block back on");
  assert.match(nf(h, "DEVOS-ISO-FWD"), /DEVOS-ISO-FWD/);
});

test("S4-b2a (Codex PR158-r1): a --remove that lands while a run fetches the state still wins", () => {
  const h = host(STATE);
  const marker = path.join(h, "devos/isolation/disabled");
  fs.mkdirSync(path.dirname(marker), { recursive: true });   // --remove creates it
  const before = restores(h);
  // The fake curl writes the marker during the fetch, as a --remove finishing in that window would.
  const r = run(h, [], { FAKE_CURL_TOUCH: marker });
  assert.equal(r.code, 4, r.out);
  assert.equal(restores(h), before, "nothing applied after the marker appeared");
  assert.equal(nf(h, "DEVOS-ISO-FWD"), null);
});

test("skipped (exit 3) without a token; refuses a non-loopback state URL", () => {
  let h = host(STATE, { token: null });
  let r = run(h);
  assert.equal(r.code, 3, r.out);
  assert.equal(restores(h), 0);
  h = host(STATE, { conf: "ISOLATION_STATE_URL=http://example.com:80/internal/isolation-state\n" });
  r = run(h);
  assert.equal(r.code, 1, r.out);
  assert.equal(reason(r), "config", "DEVOS-128 reason code");
  assert.match(r.out, /loopback/);
  assert.equal(fs.existsSync(path.join(h, "log/curl.args")), false, "no request made");
});

test("DEVOS-237: a token shorter than 32 characters is refused before any request", () => {
  const h = host(STATE, { token: "t0ken-" + "a".repeat(25) }); // 31 characters
  const r = run(h);
  assert.equal(r.code, 1, r.out);
  assert.equal(reason(r), "token", "DEVOS-128 reason code");
  assert.match(r.out, /token file is malformed/);
  assert.equal(fs.existsSync(path.join(h, "log/curl.args")), false, "no request made");
  assert.equal(restores(h), 0);
});

test("DEVOS-237: a token of exactly 32 characters is accepted", () => {
  const h = host(STATE, { token: "t0ken-" + "a".repeat(26) }); // 32 characters
  const r = run(h, ["--dry-run"]);
  assert.equal(r.code, 0, r.out);
});

test("unknown arguments are refused", () => {
  const h = host(STATE);
  assert.equal(run(h, ["--force"]).code, 2);
  assert.equal(run(h, ["--dry-run", "x"]).code, 2);
});

// --- S4-b2b: boot persistence through /etc/ufw/after.rules --------------------------------------------------
test("S4-b2b: apply writes the boot block after M0.1's block, and an unchanged run does not rewrite it", () => {
  const h = host(STATE);
  const r = run(h);
  assert.equal(r.code, 0, r.out);
  const txt = afterRules(h);
  assert.ok(txt.startsWith(UFW_HEAD + M01), "ufw's own rules and M0.1's block are kept, in front");
  assert.ok(txt.indexOf("# BEGIN DEVOS S4 ISOLATION") > txt.indexOf("# END DEVOS UFW AND DOCKER"), "ours comes after M0.1's");
  const golden = fs.readFileSync(GOLDEN, "utf8");
  assert.equal(bootBlock(h), golden.replace(/^COMMIT\n$/m, "")
    + "-I DOCKER-USER 1 -j DEVOS-ISO-FWD\n-I FORWARD 1 -j DEVOS-ISO-FWD\n-I INPUT 1 -j DEVOS-ISO-IN\nCOMMIT\n");
  assert.equal(fs.statSync(path.join(h, "after.rules")).mode & 0o777, 0o640, "file mode kept");
  assert.doesNotMatch(txt, /[^\x09\x0a\x20-\x7e]/, "ASCII only (ufw crashes on anything else)");
  const ino = fs.statSync(path.join(h, "after.rules")).ino;
  assert.equal(run(h).code, 0);
  assert.equal(fs.statSync(path.join(h, "after.rules")).ino, ino, "unchanged run leaves the file alone");
  assert.equal(fs.readdirSync(h).filter((f) => f.includes(".devos-s4.")).length, 0, "no temp file left");
});

test("S4-b2b: loading after.rules on a fresh boot (and after M0.1's DOCKER-USER flush) restores the live block", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  const live = { fwd: nf(h, "DEVOS-ISO-FWD"), in: nf(h, "DEVOS-ISO-IN") };
  // Reboot: no S4 chains, INPUT/FORWARD hold only ufw's/tailscaled's jumps; ufw then loads after.rules in one restore.
  for (const c of ["DEVOS-ISO-FWD", "DEVOS-ISO-IN"]) fs.rmSync(path.join(h, "nf", c));
  fs.writeFileSync(path.join(h, "nf/INPUT"), "-A INPUT -j ufw-before-logging-input\n");
  fs.writeFileSync(path.join(h, "nf/FORWARD"), "-A FORWARD -j ts-forward\n-A FORWARD -j DOCKER-USER\n");
  fs.writeFileSync(path.join(h, "nf/DOCKER-USER"), "-A DOCKER-USER -j stale\n");
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, FAKE_NF: path.join(h, "nf"), FAKE_LOG: path.join(h, "log") };
  // Pre-review: the fake restore would create a missing chain, so check statically what the real one refuses:
  // every chain the whole file appends to, inserts into or jumps to is builtin or declared earlier in the file.
  const known = new Set(["INPUT", "FORWARD", "OUTPUT", "ACCEPT", "DROP", "RETURN", "LOG"]);
  for (const l of afterRules(h).split("\n")) {
    const decl = l.match(/^:(\S+) /);
    if (decl) { known.add(decl[1]); continue; }
    const rule = l.match(/^-[AI] (\S+) /);
    if (!rule) continue;
    assert.ok(known.has(rule[1]), `chain ${rule[1]} used before it exists: ${l}`);
    const tgt = l.match(/ -j (\S+)$/);
    if (tgt) assert.ok(known.has(tgt[1]), `target ${tgt[1]} not declared before: ${l}`);
  }
  const r = spawnSync("iptables-restore", ["--noflush"], { input: afterRules(h), env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(nf(h, "DEVOS-ISO-FWD"), live.fwd);
  assert.equal(nf(h, "DEVOS-ISO-IN"), live.in);
  assert.equal(nf(h, "DOCKER-USER"), "-A DOCKER-USER -j DEVOS-ISO-FWD\n-A DOCKER-USER -j ufw-user-forward\n-A DOCKER-USER -j ufw-docker-logging-deny\n",
    "M0.1 flushed DOCKER-USER, then our jump went in first");
  assert.equal(nf(h, "FORWARD").split("\n")[0], "-A FORWARD -j DEVOS-ISO-FWD", "first, above ts-forward");
  assert.equal(nf(h, "INPUT").split("\n")[0], "-A INPUT -j DEVOS-ISO-IN");
  // The agent's next tick finds everything in place (same block, jumps first, same fingerprint).
  const after = run(h);
  assert.equal(after.code, 0, after.out);
  assert.match(after.out, /unchanged/);
});

test("S4-b2b: a re-run of M0.1 (its block moves to the end) puts ours back after it on the next tick", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  const ours = bootBlock(h);
  // M0.1's replace_block: delete its block, append it again at the end.
  const t = afterRules(h).replace(M01, "") + M01;
  fs.writeFileSync(path.join(h, "after.rules"), t);
  const r = run(h);
  assert.equal(r.code, 0, r.out);
  const txt = afterRules(h);
  assert.ok(txt.indexOf("# BEGIN DEVOS S4 ISOLATION") > txt.indexOf("# END DEVOS UFW AND DOCKER"));
  assert.equal(bootBlock(h), ours);
  assert.equal(txt.match(/# BEGIN DEVOS S4 ISOLATION/g).length, 1, "exactly one copy");
});

test("S4-b2b: without M0.1's block the boot block is not written (exit 1), the live block still applies", () => {
  const h = host(STATE);
  fs.writeFileSync(path.join(h, "after.rules"), UFW_HEAD);
  const r = run(h);
  assert.equal(r.code, 1, r.out);
  assert.equal(reason(r), "boot-persistence", "DEVOS-128 reason code");
  assert.match(r.out, /M0\.1's DEVOS UFW AND DOCKER block is not in .*; not written/);
  assert.match(r.out, /self-test passed, but not persisted for boot/);
  assert.equal(afterRules(h), UFW_HEAD, "after.rules untouched");
  assert.equal(nf(h, "DOCKER-USER").split("\n")[0], "-A DOCKER-USER -j DEVOS-ISO-FWD");
});

test("S4-b2b: a rollback rewrites the boot block to the restored block; a first-apply rollback deletes it", async () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  const good = bootBlock(h);
  let l = await listener();
  try {
    targets(h, upPort, l.port);
    setState(h, { stacks: [{ slug: "gamma", env: "live", idx: 5, egress: true, tailnet: [] }] });
    const r = run(h, [], { FAKE_KILL_PID: String(l.pid) });
    assert.equal(r.code, 1, r.out);
    assert.equal(bootBlock(h), good);
  } finally { l.stop(); }
  const h2 = host(STATE);
  l = await listener();
  try {
    targets(h2, l.port);
    const r = run(h2, [], { FAKE_KILL_PID: String(l.pid) });
    assert.match(r.out, /rolled back: S4 block removed/);
    assert.equal(afterRules(h2), UFW_HEAD + M01, "no boot block after the first apply was rolled back");
  } finally { l.stop(); }
});

test("S4-b2b: --remove deletes the boot block too, so a reboot does not bring the block back", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  assert.ok(bootBlock(h));
  const r = run(h, ["--remove"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(afterRules(h), UFW_HEAD + M01);
  assert.equal(run(h, ["--remove"]).code, 0, "still idempotent");
});

test("S4-b2b (pre-review): broken markers (an orphan BEGIN) are refused and the file is left alone", () => {
  const h = host(STATE);
  const broken = UFW_HEAD + M01 + "# BEGIN DEVOS S4 ISOLATION (hand edit)\n# KK's own line\n";
  fs.writeFileSync(path.join(h, "after.rules"), broken);
  const r = run(h);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /markers in .* are broken \(hand edit\?\); not written/);
  assert.equal(afterRules(h), broken, "nothing after the orphan BEGIN is dropped");
});

// --- S4-b2d: conntrack clean-up for stacks whose rights shrank, and the run deadline -------------------------
const ctLog = (h) => { const f = path.join(h, "log/conntrack.log"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []; };
const pending = (h) => path.join(h, "devos/isolation/conntrack.pending");

test("S4-b2d: the first apply cuts the pool's old connections once; an unchanged run cuts nothing", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  assert.deepEqual(ctLog(h), ["-D -s 10.208.0.0/14"]);
  assert.equal(fs.existsSync(pending(h)), false);
  assert.equal(run(h).code, 0);
  assert.equal(ctLog(h).length, 1, "no clean-up on an unchanged run");
});

test("S4-b2d: only stacks that lost a right are cut (egress revoked, tailnet removed, stack gone); a grant cuts nothing", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  const n0 = ctLog(h).length;
  // Grant: alpha gains egress -> nothing cut.
  setState(h, { stacks: [STATE.stacks[0], { ...STATE.stacks[1], egress: true }] });
  assert.equal(run(h).code, 0);
  assert.equal(ctLog(h).length, n0, "a grant cuts nothing");
  // Revoke beta's egress (idx 257 -> 10.209.1.0/24) and alpha's tailnet entry (idx 0 -> 10.208.0.0/24).
  setState(h, { stacks: [{ ...STATE.stacks[0], egress: false }, { ...STATE.stacks[1], egress: true, tailnet: [] }] });
  assert.equal(run(h).code, 0);
  assert.deepEqual(ctLog(h).slice(n0).sort(), ["-D -s 10.208.0.0/24", "-D -s 10.209.1.0/24"]);
  // Remove beta entirely.
  const n1 = ctLog(h).length;
  setState(h, { stacks: [{ ...STATE.stacks[1], egress: true, tailnet: [] }] });
  assert.equal(run(h).code, 0);
  assert.deepEqual(ctLog(h).slice(n1), ["-D -s 10.209.1.0/24"]);
});

test("S4-b2d: 'no entry matched' counts as done; a failed clean-up is kept pending and retried next tick", () => {
  const h = host(STATE);
  assert.equal(run(h, [], { FAKE_CT_NOMATCH: "1" }).code, 0, "0 flow entries deleted is a success");
  assert.equal(fs.existsSync(pending(h)), false);
  setState(h, { stacks: [STATE.stacks[1]] });
  let r = run(h, [], { FAKE_CT_RC: "2" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /conntrack clean-up incomplete, retried next tick: 10\.209\.1\.0\/24/);
  assert.match(r.out, /self-test passed; old connections not yet cut/);
  assert.equal(fs.readFileSync(pending(h), "utf8").trim(), "10.209.1.0/24");
  assert.match(nf(h, "DEVOS-ISO-FWD"), /alpha\/preview/, "the new block is in place regardless");
  r = run(h);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /unchanged/);
  assert.equal(ctLog(h).at(-1), "-D -s 10.209.1.0/24", "retried on the unchanged tick");
  assert.equal(fs.existsSync(pending(h)), false);
});

test("S4-b2d (Codex PR163-r4): a pending cut is retried on a tick whose state fetch fails or whose document is refused", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  setState(h, { stacks: [STATE.stacks[1]] });
  assert.equal(run(h, [], { FAKE_CT_RC: "2" }).code, 1);
  assert.equal(fs.readFileSync(pending(h), "utf8").trim(), "10.209.1.0/24");
  // The state endpoint is down: the fetch fails, but the queued cut still runs and the list is cleared.
  let r = run(h, [], { FAKE_CURL_RC: "7" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /state fetch failed \(curl exit 7\): nothing changed/);
  assert.equal(ctLog(h).at(-1), "-D -s 10.209.1.0/24", "retried before the fetch");
  assert.equal(fs.existsSync(pending(h)), false);
  // A refused document: same, and a cut that fails again stays pending.
  setState(h, { stacks: [STATE.stacks[0]] });
  assert.equal(run(h, [], { FAKE_CT_RC: "2" }).code, 1);
  const n = ctLog(h).length;
  setState(h, "{\"stacks\":[{\"slug\":\"BAD\"}]}");
  r = run(h, [], { FAKE_CT_RC: "2" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /refused/);
  assert.ok(ctLog(h).length > n, "retried before validation");
  assert.ok(fs.existsSync(pending(h)), "still pending after another failure");
  // Disabled by --remove: no cut is attempted (the block is off on purpose).
  fs.writeFileSync(path.join(h, "devos/isolation/disabled"), "x\n");
  const m = ctLog(h).length;
  assert.equal(run(h).code, 4);
  assert.equal(ctLog(h).length, m);
});

test("S4-b2d: a pending list entry that is not a pool source is never passed to conntrack", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  fs.writeFileSync(pending(h), "0.0.0.0/0\n-F\n10.209.1.0/24\n");
  assert.equal(run(h).code, 0);
  assert.deepEqual(ctLog(h).slice(1), ["-D -s 10.209.1.0/24"]);
});

test("S4-b2d: no change starts after the run deadline; nothing changes and the next tick retries", () => {
  const h = host(STATE, { conf: "ISOLATION_DEADLINE_S=0\n" });
  const r = run(h, [], { FAKE_CURL_SLEEP: "1.2" });
  assert.equal(r.code, 1, r.out);
  assert.equal(reason(r), "deadline", "DEVOS-128 reason code");
  assert.match(r.out, /deadline: \d+ s spent before the change \(limit 0 s\); nothing changed/);
  assert.equal(restores(h), 0);
  assert.equal(nf(h, "DEVOS-ISO-FWD"), null);
  const ok = host(STATE);
  assert.equal(run(ok, [], { FAKE_CURL_SLEEP: "1.2" }).code, 0, "the default 25 s deadline allows a slow fetch");
});

test("Codex PR163-r1: a deadline used up by the iptables queries just before the change still defers it; nothing changes", () => {
  // The first apply makes no iptables query before the early check, so it passes; install_block's queries then
  // take 2 s each, past the 1 s deadline, and iptables-restore must not start.
  const h = host(STATE, { conf: "ISOLATION_DEADLINE_S=1\n" });
  const r = run(h, [], { FAKE_IPT_S_SLEEP: "2" });
  assert.equal(r.code, 1, r.out);
  assert.equal(reason(r), "deadline", "DEVOS-128 reason code");
  assert.match(r.out, /deadline: \d+ s spent before the change \(limit 1 s\); nothing changed/);
  assert.equal(restores(h), 0, "iptables-restore never started");
  assert.equal(nf(h, "DEVOS-ISO-FWD"), null);
  assert.equal(fs.existsSync(pending(h)), false, "the cut queued for the deferred change is withdrawn");
  assert.equal(fs.existsSync(installed(h)), false, "nothing recorded");
  const ok = run(h, [], {});
  assert.equal(ok.code, 0, ok.out);
});

test("S4-b2d (pre-review): a failed boot step after a revoke still cuts the revoked stack, now and on later ticks", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  fs.writeFileSync(path.join(h, "after.rules"), UFW_HEAD); // M0.1's block gone: boot persistence fails from now on
  const n0 = ctLog(h).length;
  setState(h, { stacks: [STATE.stacks[1]] });
  let r = run(h, [], { FAKE_CT_RC: "2" });
  assert.equal(r.code, 1, r.out);
  assert.equal(fs.readFileSync(pending(h), "utf8").trim(), "10.209.1.0/24", "queued before the change");
  r = run(h);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /not persisted for boot/);
  assert.equal(ctLog(h).at(-1), "-D -s 10.209.1.0/24", "the unchanged tick still runs the clean-up");
  assert.equal(fs.existsSync(pending(h)), false);
  assert.ok(ctLog(h).length > n0);
});

test("S4-b2d (pre-review): a drift repair (same block re-installed) cuts the whole pool", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  fs.writeFileSync(path.join(h, "nf/DEVOS-ISO-FWD"), ""); // hand flush
  const n0 = ctLog(h).length;
  assert.equal(run(h).code, 0);
  assert.deepEqual(ctLog(h).slice(n0), ["-D -s 10.208.0.0/14"]);
});

test("S4-b2d (pre-review): the block kept after an already-failing probe is cut too", () => {
  const h = host(STATE);
  targets(h, downPort);
  const r = run(h);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /block kept/);
  assert.deepEqual(ctLog(h), ["-D -s 10.208.0.0/14"]);
});

test("S4-b2d (pre-review): without the conntrack tool the run says so, exits 1 and keeps the cut pending", () => {
  const h = host(STATE);
  const nob = path.join(h, "bin");
  fs.mkdirSync(nob);
  for (const f of fs.readdirSync(bin)) if (f !== "conntrack") fs.symlinkSync(path.join(bin, f), path.join(nob, f));
  // Only the core tools the script needs, so a real conntrack in /usr/bin cannot be found.
  const core = path.join(h, "core");
  fs.mkdirSync(core);
  for (const t of ["bash", "jq", "flock", "sed", "grep", "cat", "cut", "sort", "comm", "head", "tr", "mv", "rm", "mkdir", "chmod",
    "date", "sha256sum", "timeout", "awk", "ls", "paste", "mktemp", "stat", "sleep", "kill", "printf", "env"]) {
    const w = spawnSync("bash", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    if (w.startsWith("/")) fs.symlinkSync(w, path.join(core, t));
  }
  const r = run(h, [], { PATH: `${nob}:${core}` });
  assert.equal(r.code, 1, r.out);
  assert.equal(reason(r), "conntrack", "DEVOS-128 reason code");
  assert.match(r.out, /conntrack not installed/);
  assert.equal(fs.readFileSync(pending(h), "utf8").trim(), "10.208.0.0/14");
  assert.match(nf(h, "DEVOS-ISO-FWD"), /DEVOS-ISO-FWD/, "the block itself does not need conntrack");
});

test("S4-b2d (pre-review r2): the cut is queued before the change, so a failed record cannot lose it", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  setState(h, { stacks: [STATE.stacks[1]] });
  fs.mkdirSync(path.join(h, "devos/isolation/installed.rules.tmp")); // record() cannot write its temp file
  const r = run(h, [], { FAKE_CT_RC: "2" });
  assert.equal(r.code, 1, r.out);
  assert.equal(reason(r), "record", "DEVOS-128 reason code");
  assert.match(r.out, /could not record/);
  assert.equal(fs.readFileSync(pending(h), "utf8").trim(), "10.209.1.0/24", "queued before iptables-restore ran");
});

test("S4-b2d (pre-review r2): a rolled-back change leaves the pending list as it was (no NAT reset for nothing)", async () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  fs.writeFileSync(pending(h), "10.208.3.0/24\n"); // an older cut still due
  const l = await listener();
  try {
    targets(h, upPort, l.port);
    setState(h, { stacks: [STATE.stacks[1]] }); // would cut beta's /24
    // Codex PR163-r4: a due cut is now retried before the fetch, so conntrack keeps failing here to keep it due.
    const r = run(h, [], { FAKE_KILL_PID: String(l.pid), FAKE_CT_RC: "2" });
    assert.match(r.out, /rolled back to the previous block/);
    assert.equal(fs.readFileSync(pending(h), "utf8").trim(), "10.208.3.0/24", "beta's cut was dropped with the rollback");
  } finally { l.stop(); }
  const f = host(STATE);
  setState(f, { stacks: [STATE.stacks[1]] });
  assert.equal(run(f, [], { FAKE_RESTORE_RC: "1" }).code, 1);
  assert.equal(fs.existsSync(pending(f)), false, "a refused restore queues nothing");
});

test("S4-b2d (pre-review r2): drift plus a state change in one tick still cuts the whole pool", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  fs.writeFileSync(path.join(h, "nf/DEVOS-ISO-FWD"), "");
  setState(h, { stacks: [...STATE.stacks, { slug: "gamma", env: "live", idx: 9, egress: false, tailnet: [] }] });
  const n0 = ctLog(h).length;
  assert.equal(run(h).code, 0);
  assert.deepEqual(ctLog(h).slice(n0), ["-D -s 10.208.0.0/14"]);
});

test("S4-b2d (pre-review r2): a pending entry with an octet above 255 is dropped, not retried forever", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  fs.writeFileSync(pending(h), "10.208.999.0/24\n");
  assert.equal(run(h).code, 0);
  assert.equal(ctLog(h).length, 1, "only the first apply's pool cut");
});

// --- S4-b2c: the IPv6 defence-in-depth drop ---------------------------------------------------------------
const nf6 = (h, c) => nf(h, `v6/${c}`);
const restores6 = (h) => fs.readdirSync(path.join(h, "log/v6")).filter((f) => f.startsWith("restore.")).length;
const after6 = (h) => fs.readFileSync(path.join(h, "after6.rules"), "utf8");
const RULE6 = "-A DEVOS-ISO6 -i devos-p+ -j DROP\n";
const firstRule = (h, c) => nf6(h, c).split("\n")[0];

test("S4-b2c: an apply run installs the IPv6 drop with every jump first, once, and persists it in after6.rules", () => {
  const h = host(STATE);
  const r = run(h);
  assert.equal(r.code, 0, r.out);
  assert.equal(nf6(h, "DEVOS-ISO6"), RULE6);
  for (const c of ["DOCKER-USER", "FORWARD", "INPUT"]) {
    assert.equal(firstRule(h, c), `-A ${c} -j DEVOS-ISO6`, c);
    assert.equal(nf6(h, c).split("\n").filter((l) => l === `-A ${c} -j DEVOS-ISO6`).length, 1, c);
  }
  const t = after6(h);
  assert.ok(t.startsWith(UFW_HEAD6 + M01_6), "M0.1's IPv6 block kept, ours after it");
  assert.match(t, /# BEGIN DEVOS S4 ISOLATION6[^\n]*\n\*filter\n:DEVOS-ISO6 - \[0:0\]\n-A DEVOS-ISO6 -i devos-p\+ -j DROP\n-I DOCKER-USER 1 -j DEVOS-ISO6\n-I FORWARD 1 -j DEVOS-ISO6\n-I INPUT 1 -j DEVOS-ISO6\nCOMMIT\n# END DEVOS S4 ISOLATION6\n$/);
  assert.doesNotMatch(afterRules(h), /ISOLATION6/, "the IPv4 after.rules carries no IPv6 block");
  assert.equal(fs.statSync(path.join(h, "after6.rules")).mode & 0o777, 0o640, "file mode kept");
  // An unchanged run issues no IPv6 restore and leaves after6.rules alone.
  const n = restores6(h), ino = fs.statSync(path.join(h, "after6.rules")).ino;
  assert.equal(run(h).code, 0);
  assert.equal(restores6(h), n, "no second ip6tables-restore");
  assert.equal(fs.statSync(path.join(h, "after6.rules")).ino, ino);
  assert.deepEqual(fs.readdirSync(h).filter((f) => f.includes("devos-s4")), [], "no temp file left");
});

test("S4-b2c: a flushed IPv6 chain or a lost jump is repaired on the next tick, even when the state fetch fails", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  fs.writeFileSync(path.join(h, "nf/v6/DEVOS-ISO6"), "");
  fs.writeFileSync(path.join(h, "nf/v6/FORWARD"), "-A FORWARD -j ufw6-before-logging-forward\n-A FORWARD -j DEVOS-ISO6\n");
  const r = run(h, [], { FAKE_CURL_RC: "7" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /state fetch failed/);
  assert.equal(nf6(h, "DEVOS-ISO6"), RULE6);
  assert.equal(firstRule(h, "FORWARD"), "-A FORWARD -j DEVOS-ISO6");
  assert.equal(nf6(h, "FORWARD").split("\n").filter((l) => l.endsWith("-j DEVOS-ISO6")).length, 1, "the moved jump is not duplicated");
  assert.equal(run(h).code, 0, "unchanged afterwards");
});

test("S4-b2c: an IPv6 failure does not stop the IPv4 block; the run exits 1 and says why", () => {
  const h = host(STATE);
  let r = run(h, [], { FAKE_V6_RC: "3" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /IPv6 drop not in place: IPv6 drop: the IPv6 DOCKER-USER chain is missing/);
  assert.match(r.out, /applied: 2 stacks, self-test passed/);
  assert.match(nf(h, "DEVOS-ISO-FWD"), /beta\/live egress/, "IPv4 block applied");
  r = run(h, [], { FAKE_V6_RESTORE_RC: "1" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /IPv6 drop not in place: IPv6 drop: ip6tables-restore refused the transaction/);
  assert.match(r.out, /unchanged: 2 stacks/);
  assert.equal(nf6(h, "DEVOS-ISO6"), null, "nothing half-applied");
  assert.equal(run(h).code, 0, "applied on the next good tick");
  assert.equal(nf6(h, "DEVOS-ISO6"), RULE6);
});

test("S4-b2c: without M0.1's IPv6 block the drop is applied live but not written to after6.rules (exit 1)", () => {
  const h = host(STATE);
  fs.writeFileSync(path.join(h, "after6.rules"), UFW_HEAD6);
  const r = run(h);
  assert.equal(r.code, 1, r.out);
  assert.equal(reason(r), "ipv6", "DEVOS-128 reason code");
  assert.match(r.out, /M0\.1's DEVOS UFW AND DOCKER block is not in .*after6\.rules; not written/);
  assert.equal(after6(h), UFW_HEAD6, "after6.rules untouched");
  assert.equal(nf6(h, "DEVOS-ISO6"), RULE6, "live drop in place");
});

test("S4-b2c: loading after6.rules on a fresh boot restores the IPv6 drop with its jumps first", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  for (const c of ["DEVOS-ISO6"]) fs.rmSync(path.join(h, "nf/v6", c));
  fs.writeFileSync(path.join(h, "nf/v6/INPUT"), "-A INPUT -j ufw6-before-logging-input\n");
  fs.writeFileSync(path.join(h, "nf/v6/FORWARD"), "-A FORWARD -j ufw6-before-logging-forward\n");
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, FAKE_NF: path.join(h, "nf"), FAKE_LOG: path.join(h, "log") };
  const r = spawnSync("ip6tables-restore", ["--noflush"], { input: after6(h), env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(nf6(h, "DEVOS-ISO6"), RULE6);
  for (const c of ["DOCKER-USER", "FORWARD", "INPUT"]) assert.equal(firstRule(h, c), `-A ${c} -j DEVOS-ISO6`, c);
  const n = restores6(h);
  assert.equal(run(h).code, 0);
  assert.equal(restores6(h), n, "the next tick finds it in place");
});

test("S4-b2c: --remove deletes the IPv6 drop and its after6.rules block; a disabled run does not re-apply it", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  const r = run(h, ["--remove"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(nf6(h, "DEVOS-ISO6"), null);
  for (const c of ["DOCKER-USER", "FORWARD", "INPUT"]) assert.doesNotMatch(nf6(h, c), /DEVOS-ISO6/, c);
  assert.equal(after6(h), UFW_HEAD6 + M01_6, "after6.rules back to M0.1's");
  assert.equal(run(h).code, 4);
  assert.equal(nf6(h, "DEVOS-ISO6"), null, "kept off while disabled");
  assert.equal(run(h, ["--remove"]).code, 0, "idempotent");
});

test("S4-b2c: --dry-run prints the IPv6 block after the IPv4 one and changes nothing", () => {
  const h = host(STATE);
  const r = run(h, ["--dry-run"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /# dry run: nothing changed \(2 stacks\)\n# IPv6 block \(ip6tables, static; S4-b2c\):\n\*filter\n:DEVOS-ISO6 - \[0:0\]\n-A DEVOS-ISO6 -i devos-p\+ -j DROP\nCOMMIT\n$/);
  assert.equal(nf6(h, "DEVOS-ISO6"), null);
  assert.equal(restores6(h), 0);
});

test("S4-b2c: IPv6 tailnet entries are still refused, whole document (decision 6)", () => {
  const h = host({ stacks: [{ slug: "alpha", env: "preview", idx: 0, egress: false, tailnet: ["fd7a:115c:a1e0::1/128"] }] });
  const r = run(h);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /IPv6 entries are refused: project networks have no IPv6/);
  assert.equal(nf(h, "DEVOS-ISO-FWD"), null);
});

test("S4-b2c (pre-review): a hanging ip6tables stops at the IPv6 budget, and the IPv4 change still goes ahead", () => {
  const h = host(STATE);
  const t = Date.now();
  const r = run(h, [], { FAKE_V6_S_SLEEP: "3", FAKE_IPT_S_SLEEP: "0" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /IPv6 drop not in place: IPv6 drop: time budget \(8 s\) used up; retried next tick/);
  assert.match(r.out, /applied: 2 stacks, self-test passed/, "the IPv6 time is not counted against the IPv4 deadline");
  assert.doesNotMatch(r.out, /deadline:/);
  assert.equal(restores6(h), 0, "no IPv6 restore started past the budget");
  assert.ok(Date.now() - t < 30000, "bounded");
});

test("S4-b2c (pre-review): --remove does not report success while ip6tables does not answer", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  const r = run(h, ["--remove"], { FAKE_V6_RC: "4" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ip6tables does not answer/);
  assert.equal(nf6(h, "DEVOS-ISO6"), RULE6, "still there, and said so");
  // Codex PR165-r1: the IPv6 failure must not stop the IPv4 rollback or the marker (AT8).
  assert.ok(fs.existsSync(path.join(h, "devos/isolation/disabled")), "the disable marker is written anyway");
  assert.equal(nf(h, "DEVOS-ISO-FWD"), null, "the IPv4 block is gone");
  assert.equal(afterRules(h), UFW_HEAD + M01, "the IPv4 boot block is gone too");
  const before = restores(h);
  const next = run(h);
  assert.equal(next.code, 4, next.out);
  assert.equal(restores(h), before, "the next tick does not re-apply the IPv4 block");
  assert.equal(nf(h, "DEVOS-ISO-FWD"), null);
  // Once ip6tables answers again, a second --remove finishes the IPv6 part.
  assert.equal(run(h, ["--remove"]).code, 0);
  assert.equal(nf6(h, "DEVOS-ISO6"), null);
  assert.equal(after6(h), UFW_HEAD6 + M01_6);
});

test("S4-b2c (Codex PR165-r1): an IPv4 removal failure still removes the IPv6 drop and both boot blocks", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  const r = run(h, ["--remove"], { FAKE_IPT_D_RC: "4" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /some IPv4 S4 rules are still in place/);
  assert.ok(fs.existsSync(path.join(h, "devos/isolation/disabled")));
  assert.equal(afterRules(h), UFW_HEAD + M01, "the IPv4 boot block is removed anyway");
  assert.equal(nf6(h, "DEVOS-ISO6"), null, "the IPv6 drop is removed anyway");
  assert.equal(after6(h), UFW_HEAD6 + M01_6);
  assert.equal(run(h).code, 4, "kept off");
});

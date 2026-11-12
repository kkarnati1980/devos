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
  w("iptables", `[[ "$1" == -w ]] && shift 2
echo "$*" >> "$FAKE_LOG/iptables.log"
op="$1" ch="$2"; shift 2; f="$FAKE_NF/$ch"
case "$op" in
  -S) [[ -f "$f" ]] || exit 1; [[ "$ch" == INPUT ]] && echo "-P INPUT DROP" || echo "-N $ch"; cat "$f" ;;
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
  w("iptables-restore", `in="$(cat)"; n=$(ls "$FAKE_LOG" | grep -c '^restore\\.' ); printf '%s\\n' "$in" > "$FAKE_LOG/restore.$n"
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
if [[ -n "\${FAKE_KILL_PID:-}" ]]; then kill -9 "$FAKE_KILL_PID" 2>/dev/null; sleep 0.3; fi`);
  // curl: logs argv (to prove the token is not on it) and prints FAKE_STATE; FAKE_CURL_RC fails the fetch.
  w("curl", `echo "$*" >> "$FAKE_LOG/curl.args"; [[ "\${FAKE_CURL_RC:-0}" == 0 ]] || exit "$FAKE_CURL_RC"; cat "$FAKE_STATE"`);
  w("tailscale", `exit 1`);
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
  { slug: "alpha", env: "preview", idx: 0, egress: false, tailnet: ["100.101.102.103/32", "fd7a:115c:a1e0::5/128"] },
] };

function host(state, { conf = "", token = "t0ken-abcdefghijklmnop" } = {}) {
  const h = fs.mkdtempSync(path.join(tmp, "h-"));
  for (const d of ["devos/secrets", "nf", "log"]) fs.mkdirSync(path.join(h, d), { recursive: true });
  if (token !== null) fs.writeFileSync(path.join(h, "devos/secrets/isolation_state_token"), token + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(h, "devos/server-agent.conf"), `ISOLATION_SELFTEST_TARGETS=127.0.0.1:${upPort}\n${conf}`);
  fs.writeFileSync(path.join(h, "nf/DOCKER-USER"), "-A DOCKER-USER -j ufw-user-forward\n-A DOCKER-USER -j ufw-docker-logging-deny\n");
  fs.writeFileSync(path.join(h, "nf/INPUT"), "-A INPUT -j ufw-before-logging-input\n");
  setState(h, state);
  return h;
}
const setState = (h, s) => fs.writeFileSync(path.join(h, "state.json"), typeof s === "string" ? s : JSON.stringify(s));
function run(h, args = [], env = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, DEVOS_DIR: path.join(h, "devos"),
    FAKE_NF: path.join(h, "nf"), FAKE_LOG: path.join(h, "log"), FAKE_STATE: path.join(h, "state.json"), ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
}
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
    assert.equal(restores(h), 1, "nothing applied");
    assert.equal(fs.readFileSync(installed(h), "utf8"), before);
  });
}

test("AT6 a failed state fetch changes nothing", () => {
  const h = host(STATE);
  const r = run(h, [], { FAKE_CURL_RC: "7" });
  assert.equal(r.code, 1, r.out);
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
  assert.match(r.out, /apply failed .*previous block is still in place/);
  assert.deepEqual(["DOCKER-USER", "INPUT", "DEVOS-ISO-FWD", "DEVOS-ISO-IN"].map((c) => nf(h, c)), snap);
  assert.equal(fs.readFileSync(installed(h), "utf8"), before);
});

test("AT7 the jumps change in the same restore transaction as the chains (no -D/-I outside it)", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  const tx = fs.readFileSync(path.join(h, "log/restore.0"), "utf8");
  assert.match(tx, /-I DOCKER-USER 1 -j DEVOS-ISO-FWD\n-I INPUT 1 -j DEVOS-ISO-IN\nCOMMIT\n$/);
  const writes = fs.readFileSync(path.join(h, "log/iptables.log"), "utf8").split("\n").filter((l) => /^-(I|D|F|X) /.test(l));
  assert.deepEqual(writes, []);
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
const targets = (h, ...ports) => fs.writeFileSync(path.join(h, "devos/server-agent.conf"), `ISOLATION_SELFTEST_TARGETS=${ports.map((p) => "127.0.0.1:" + p).join(" ")}\n`);

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
    assert.match(r.out, /self-test failed after apply \(self-test: 127\.0\.0\.1:\d+ did not answer\)/);
    assert.match(r.out, /rolled back to the previous block/);
    assert.equal(nf(h, "DEVOS-ISO-FWD"), good);
    assert.equal(nf(h, "DOCKER-USER").match(/DEVOS-ISO-FWD/g).length, 1);
    assert.doesNotMatch(fs.readFileSync(installed(h), "utf8"), /gamma/);
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

test("a host self-test already failing before the change keeps the block (isolation is the floor) and reports it", () => {
  const h = host(STATE);
  targets(h, downPort);
  const r = run(h);
  assert.equal(r.code, 1, r.out);
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

test("skipped (exit 3) without a token; refuses a non-loopback state URL", () => {
  let h = host(STATE, { token: null });
  let r = run(h);
  assert.equal(r.code, 3, r.out);
  assert.equal(restores(h), 0);
  h = host(STATE, { conf: "ISOLATION_STATE_URL=http://example.com:80/internal/isolation-state\n" });
  r = run(h);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /loopback/);
  assert.equal(fs.existsSync(path.join(h, "log/curl.args")), false, "no request made");
});

test("unknown arguments are refused", () => {
  const h = host(STATE);
  assert.equal(run(h, ["--force"]).code, 2);
  assert.equal(run(h, ["--dry-run", "x"]).code, 2);
});

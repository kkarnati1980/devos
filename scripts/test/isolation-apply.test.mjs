// DEVOS-65 (S4-b): scripts/server/isolation-apply.sh against a fake `iptables` (chains kept as files), a fake
// `iptables-restore`, a fake `curl` (serves FAKE_STATE) and real TCP listeners for the self-test.
// Contract: docs/modules/S4.md (S4-b, AT5-AT8).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  -I) shift; { echo "-A $ch $*"; cat "$f"; } > "$f.n" && mv "$f.n" "$f"; [[ -n "\${FAKE_I_RC:-}" ]] && exit "$FAKE_I_RC"; exit 0 ;;
  -F) : > "$f" ;;
  -X) rm -f "$f" ;;
  *) exit 2 ;;
esac`);
  // iptables-restore --noflush: declared chains are (re)created empty, then -A lines appended; FAKE_RESTORE_RC != 0 fails first.
  w("iptables-restore", `in="$(cat)"; n=$(ls "$FAKE_LOG" | grep -c '^restore\\.' ); printf '%s\\n' "$in" > "$FAKE_LOG/restore.$n"
[[ "\${FAKE_RESTORE_RC:-0}" == 0 ]] || exit "$FAKE_RESTORE_RC"
while IFS= read -r l; do case "$l" in :*) c="\${l#:}"; c="\${c%% *}"; : > "$FAKE_NF/$c" ;; -A\\ *) c="$(cut -d' ' -f2 <<<"$l")"; echo "$l" >> "$FAKE_NF/$c" ;; esac; done <<<"$in"`);
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
  assert.match(log, /--max-time 15/);
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

test("AT7 a failed iptables-restore leaves the previous block and installed record in place", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  const before = fs.readFileSync(installed(h), "utf8");
  setState(h, { stacks: [] });
  const r = run(h, [], { FAKE_RESTORE_RC: "1" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /apply failed/);
  assert.equal(fs.readFileSync(installed(h), "utf8"), before);
});

test("AT8 self-test failure rolls back to the previous block in the same run", () => {
  const h = host(STATE);
  assert.equal(run(h).code, 0);
  const good = nf(h, "DEVOS-ISO-FWD");
  setState(h, { stacks: [{ slug: "gamma", env: "live", idx: 5, egress: true, tailnet: [] }] });
  fs.appendFileSync(path.join(h, "devos/server-agent.conf"), "");
  fs.writeFileSync(path.join(h, "devos/server-agent.conf"), `ISOLATION_SELFTEST_TARGETS=127.0.0.1:${upPort} 127.0.0.1:${downPort}\n`);
  const r = run(h);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /self-test: 127\.0\.0\.1:\d+ did not answer/);
  assert.match(r.out, /rolled back to the previous block/);
  assert.equal(nf(h, "DEVOS-ISO-FWD"), good);
  assert.doesNotMatch(fs.readFileSync(installed(h), "utf8"), /gamma/);
});

test("AT8 self-test failure on the first apply removes the block entirely", () => {
  const h = host(STATE, { conf: "" });
  fs.writeFileSync(path.join(h, "devos/server-agent.conf"), `ISOLATION_SELFTEST_TARGETS=127.0.0.1:${downPort}\n`);
  const r = run(h);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /rolled back: S4 block removed/);
  assert.equal(nf(h, "DEVOS-ISO-FWD"), null);
  assert.doesNotMatch(nf(h, "DOCKER-USER"), /DEVOS-ISO/);
  assert.doesNotMatch(nf(h, "INPUT"), /DEVOS-ISO/);
  assert.equal(fs.existsSync(installed(h)), false);
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

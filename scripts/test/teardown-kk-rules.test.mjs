// DEVOS-112 (docs/modules/M2.5.md "DEVOS-112: KK's teardown rules check"): the read-only server check, on a fake `docker`.
// Fake on PATH: `docker` (ps → one API id unless FAKE_API=0, exit FAKE_PS_RC; exec → prints FAKE_DIR/cli and exits
// FAKE_CLI_RC; anything else exits 99 and is recorded).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK = path.join(ROOT, "scripts/server/checks/teardown-kk-rules.sh");
const ID = "11111111-1111-4111-8111-111111111111";

function run({ cli, cliRc = 0, api = true, psRc = 0, noDocker = false } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "devos-kkrules-"));
  fs.writeFileSync(path.join(bin, "cli"), cli);
  if (!noDocker) {
    fs.writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env bash
echo "$*" >> "$FAKE_DIR/docker.args"
case "$1" in
  ps) [[ "$FAKE_API" == 1 ]] && echo abcdef123456; [[ "$FAKE_API" == 2 ]] && printf abcdef123456; exit "$FAKE_PS_RC";;
  exec) cat "$FAKE_DIR/cli"; exit "$FAKE_CLI_RC";;
esac
exit 99
`);
    fs.chmodSync(path.join(bin, "docker"), 0o755);
  }
  const jq = ["/usr/bin/jq", "/usr/local/bin/jq", "/bin/jq"].find((p) => fs.existsSync(p));
  if (jq) fs.symlinkSync(jq, path.join(bin, "jq"));
  // PATH holds the fake bin and the system tools, never a real docker.
  const r = spawnSync("bash", [CHECK], {
    env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_DIR: bin, FAKE_API: api === "nonl" ? "2" : api ? "1" : "0", FAKE_CLI_RC: String(cliRc), FAKE_PS_RC: String(psRc) },
    encoding: "utf8",
  });
  const args = fs.existsSync(path.join(bin, "docker.args")) ? fs.readFileSync(path.join(bin, "docker.args"), "utf8") : "";
  fs.rmSync(bin, { recursive: true, force: true });
  return { code: r.status, out: r.stdout + r.stderr, args };
}

const act = (enforced, outcome = enforced, reason = "allowed-by", matched = [ID]) => ({ outcome, enforced, reason, matched });
const line = (o) => JSON.stringify(o) + "\n";
const PASS = line({ result: "pass", mode: "enforce", rules: 1, pinned: 0, actions: { "teardown.archive": act("allow"), "teardown.restore": act("allow") } });
const FAIL = line({ result: "fail", mode: "enforce", rules: 0, pinned: 0, actions: { "teardown.archive": act("deny", "deny", "default-deny", []), "teardown.restore": act("deny", "deny", "default-deny", []) } });

test("DEVOS-112: both allowed → pass, with the mode and the deciding rule", () => {
  const r = run({ cli: PASS });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^policy mode enforce, 1 enabled rule\(s\)$/m);
  assert.match(r.out, new RegExp(`KK teardown.archive: allow \\(rule outcome allow, allowed-by, rules ${ID}\\)`));
  assert.match(r.out, /^ok: KK's Archive and Restore are allowed$/m);
  assert.match(r.args, /exec abcdef123456 node deploy\/with-db-url\.mjs node apps\/api\/dist\/teardown-rules-cli\.js kk-teardown/);
});

test("DEVOS-112: a default deny in enforce mode → fail, naming it", () => {
  const r = run({ cli: FAIL, cliRc: 1 });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /KK teardown.restore: deny \(rule outcome deny, default-deny\)$/m);
  assert.match(r.out, /^fail: KK's Archive or Restore would be refused by the policy in force$/m);
});

test("DEVOS-112 pre-review 1: a result that disagrees with its rows is unreadable, never a pass", () => {
  for (const [result, a, b] of [["pass", act("deny"), act("allow")], ["pass", act("allow"), act("require_approval")], ["fail", act("allow"), act("allow")], ["pass", act("allow"), act("")], ["pass", act("allow"), act("maybe")]]) {
    const r = run({ cli: line({ result, mode: "enforce", rules: 1, pinned: 0, actions: { "teardown.archive": a, "teardown.restore": b } }), cliRc: result === "pass" ? 0 : 1 });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^fail: unreadable rules check output$/m);
    assert.doesNotMatch(r.out, /^ok:/m);
  }
});

test("DEVOS-112 pre-review 2: rules pinned to a login or a project are reported, not judged", () => {
  const r = run({ cli: PASS.replace('"pinned":0', '"pinned":2') });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /note: 2 teardown rule\(s\) are pinned to a KK login or a project/);
  assert.doesNotMatch(run({ cli: PASS }).out, /note:/);
  assert.equal(run({ cli: PASS.replace('"pinned":0', '"pinned":"2"') }).code, 1);
});

test("DEVOS-112: an exit code that disagrees with the result fails", () => {
  assert.equal(run({ cli: PASS, cliRc: 1 }).code, 1);
  const r = run({ cli: FAIL, cliRc: 0 });
  assert.equal(r.code, 1);
  assert.match(r.out, /disagrees/);
});

test("DEVOS-112: skipped only when DevOS is not deployed; a failed docker ps or a missing database fails", () => {
  assert.equal(run({ cli: PASS, api: false }).code, 3);
  assert.equal(run({ cli: PASS, psRc: 1 }).code, 1);
  // Pre-review r2 1: a container id without a trailing newline is still found.
  assert.equal(run({ cli: PASS, api: "nonl" }).code, 0);
  const r = run({ cli: line({ code: "skipped", detail: "database-not-configured" }), cliRc: 3 });
  assert.equal(r.code, 1);
  assert.match(r.out, /no database/);
});

test("DEVOS-112: helper errors print only fixed codes", () => {
  let r = run({ cli: line({ error: "teardown-rules-read-failed" }), cliRc: 1 });
  assert.equal(r.code, 1);
  assert.match(r.out, /^fail: the rules check failed: teardown-rules-read-failed$/m);
  r = run({ cli: line({ error: "password=hunter2" }), cliRc: 1 });
  assert.match(r.out, /unrecognised error/);
  assert.ok(!r.out.includes("hunter2"));
  r = run({ cli: PASS, cliRc: 7 });
  assert.equal(r.code, 1);
  assert.match(r.out, /no result/);
});

test("DEVOS-112: malformed output is unreadable, never a pass", () => {
  for (const cli of ["", "not json\n", PASS + PASS, "[1]\n", '{"a":1} {"b":2}\n',
    line({ result: "pass", mode: "enforce", rules: 1, pinned: 0, actions: { "teardown.archive": act("allow") } }),
    line({ result: "pass", mode: "enforce", rules: 1, actions: { "teardown.archive": act("allow"), "teardown.restore": act("allow") } }),
    line({ result: "pass", mode: "legacy", rules: 1, pinned: 0, actions: { "teardown.archive": act("allow"), "teardown.restore": act("allow") } }),
    line({ result: "pass", mode: "enforce", rules: 1, pinned: 0, actions: { "teardown.archive": act("allow", "allow", "x\nok: fake"), "teardown.restore": act("allow") } }),
    line({ result: "pass", mode: "enforce", rules: 1, pinned: 0, actions: { "teardown.archive": act("allow", "allow", "allowed-by", ["a b"]), "teardown.restore": act("allow") } }),
    PASS.replace("\n", "\u0000\n")]) {
    const r = run({ cli });
    assert.equal(r.code, 1, `${JSON.stringify(cli)} → ${r.out}`);
    assert.doesNotMatch(r.out, /^ok:/m);
  }
});

test("DEVOS-112: the check only runs docker ps and docker exec (read-only)", () => {
  const r = run({ cli: PASS });
  const verbs = r.args.trim().split("\n").map((l) => l.split(" ")[0]);
  assert.deepEqual([...new Set(verbs)].sort(), ["exec", "ps"]);
});

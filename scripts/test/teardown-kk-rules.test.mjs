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
const ID2 = "22222222-2222-4222-8222-222222222222";

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
  for (const [result, a, b] of [["pass", act("deny"), act("allow")], ["pass", act("allow"), act("require_approval")], ["fail", act("allow"), act("allow")], ["pass", act("allow"), act("")], ["pass", act("allow"), act("maybe")], ["pass", act("allow"), act("allow", "allow", "sentinels-disagree")], ["pass", act("allow", "allow", "narrow-match"), act("allow")], ["pass", act("allow", "deny", "default-deny", []), act("allow")]]) {
    const r = run({ cli: line({ result, mode: "enforce", rules: 1, pinned: 0, actions: { "teardown.archive": a, "teardown.restore": b } }), cliRc: result === "pass" ? 0 : 1 });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^fail: unreadable rules check output$/m);
    assert.doesNotMatch(r.out, /^ok:/m);
  }
});

test("DEVOS-112 pre-review 2: rules pinned to a login or a project are reported, not judged", () => {
  const r = run({ cli: PASS.replace('"rules":1,"pinned":0', '"rules":3,"pinned":2') });
  // Codex PR238-r6 sweep: more pinned rules than rules loaded is unreadable.
  assert.match(run({ cli: PASS.replace('"pinned":0', '"pinned":2') }).out, /^fail: unreadable rules check output$/m);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /note: 2 teardown rule\(s\) are pinned to a KK login or a project/);
  assert.doesNotMatch(run({ cli: PASS }).out, /note:/);
  // Codex PR238-r3: in observe mode a recorded deny with an enforced allow is a valid row.
  const obs = run({ cli: line({ result: "pass", mode: "observe", rules: 0, pinned: 0, actions: { "teardown.archive": act("allow", "deny", "default-deny", []), "teardown.restore": act("allow", "deny", "default-deny", []) } }) });
  assert.equal(obs.code, 0, obs.out);
  // Codex PR238-r1: sentinels that disagree are a fail, shown as such.
  // Codex PR238-r4: valid observe-mode gate rows are read and fail, naming the gate.
  for (const a of [act("deny", "deny", "denied-by;gate-denied-by", [ID, ID2]), act("require_approval", "require_approval", "approval-required-by;gate-approval-required-by", [ID, ID2]), act("require_approval", "deny", "denied-by;gate-approval-required-by", [ID, ID2])]) {
    const g = run({ cli: line({ result: "fail", mode: "observe", rules: 2, pinned: 0, actions: { "teardown.archive": a, "teardown.restore": act("allow") } }), cliRc: 1 });
    assert.equal(g.code, 1, g.out);
    assert.match(g.out, /KK teardown\.archive: (deny|require_approval) \(rule outcome/);
    assert.match(g.out, /^fail: KK's Archive or Restore would be refused/m);
  }
  const dis = run({ cli: line({ result: "fail", mode: "enforce", rules: 1, pinned: 1, actions: { "teardown.archive": act("allow", "allow", "sentinels-disagree"), "teardown.restore": act("allow", "allow", "sentinels-disagree") } }), cliRc: 1 });
  assert.equal(dis.code, 1, dis.out);
  assert.match(dis.out, /KK teardown.archive: allow \(rule outcome allow, sentinels-disagree/);
  assert.match(dis.out, /^fail: KK's Archive or Restore would be refused/m);
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

// Codex PR238-r4, r5: rows the evaluator cannot produce. Each fixture is otherwise consistent (its `result` follows
// from the rows and the helper's exit code from its `result`), so only the row check can refuse it.
test("DEVOS-112: a row the evaluator cannot produce is unreadable, never a pass", () => {
  const O = (enforced, outcome, reason, matched = [ID]) => act(enforced, outcome, reason, matched);
  const rows = [
    ["enforce", O("allow", "allow", "default-deny", [])],
    ["enforce", O("allow", "allow", "denied-by")],
    ["enforce", O("allow", "allow", "approval-required-by")],
    ["enforce", O("allow", "allow", "allowed-by", [])],
    ["enforce", O("allow", "allow", "none")],
    ["enforce", O("allow", "allow", "allowed-by;gate-denied-by")],
    ["enforce", O("deny", "deny", "denied-by;gate-denied-by")],
    ["enforce", O("deny", "deny", "allowed-by")],
    ["observe", O("allow", "deny", "denied-by;gate-denied-by")],
    ["observe", O("allow", "require_approval", "approval-required-by;gate-approval-required-by")],
    ["observe", O("allow", "allow", "default-deny", [])],
    ["observe", O("allow", "deny", "allowed-by")],
    ["observe", O("deny", "allow", "allowed-by")],
    ["observe", O("deny", "deny", "default-deny", [])],
    ["observe", O("require_approval", "allow", "allowed-by")],
    ["observe", O("allow", "allow", "allowed-by;sentinels-disagree")],
    ["observe", O("allow", "deny", "default-deny")],
    ["enforce", O("deny", "deny", "default-deny")],
    ["observe", O("require_approval", "deny", "default-deny;gate-approval-required-by", [])],
    ["observe", O("require_approval", "deny", "denied-by")],
    ["observe", O("deny", "deny", "gate-denied-by;denied-by")],
    ["enforce", O("deny", "allow", "narrow-match")],
    ["observe", O("allow", "allow", "narrow-match", [])],
    ["observe", O("allow", "allow", "allowed-by", [ID, ID]), 2],
    ["observe", O("allow", "allow", "allowed-by", [ID, ID2])],
    // Pre-review sweep: each needs `rules` high enough that no other check refuses it.
    ["observe", O("allow", "allow", "allowed-by", Array.from({ length: 11 }, (_, i) => `${i}`.padStart(8, "0") + "-1111-4111-8111-111111111111")), 20],
    ["observe", O("deny", "deny", "denied-by;gate-denied-by;gate-approval-required-by", [ID, ID2]), 2],
    ["observe", O("require_approval", "require_approval", "approval-required-by;gate-denied-by", [ID, ID2]), 2],
    ["observe", O("deny", "deny", "denied-by;gate-approval-required-by", [ID, ID2]), 2],
    ["observe", O("deny", "deny", "denied-by;gate-denied-by", [ID]), 2],
    ["enforce", O("allow", "allow", "allowed-by;allowed-by"), 2],
    ["observe", O("deny", "allow", "narrow-match"), 2],
    ["observe", O("require_approval", "allow", "sentinels-disagree"), 2],
    ["observe", { ...O("allow", "allow", "allowed-by"), extra: 1 }, 2],
  ];
  for (const [mode, a, rules = 1] of rows) {
    const result = a.enforced === "allow" && a.reason !== "narrow-match" && a.reason !== "sentinels-disagree" ? "pass" : "fail";
    const cli = line({ result, mode, rules, pinned: 0, actions: { "teardown.archive": a, "teardown.restore": act("allow") } });
    const r = run({ cli, cliRc: result === "pass" ? 0 : 1 });
    assert.equal(r.code, 1, `${mode} ${JSON.stringify(a)} → ${r.out}`);
    assert.match(r.out, /^fail: unreadable rules check output$/m, `${mode} ${JSON.stringify(a)} → ${r.out}`);
    assert.doesNotMatch(r.out, /^ok:/m);
  }
});

test("DEVOS-112 pre-review sweep: object-level output the helper never prints is unreadable", () => {
  const P = JSON.parse(PASS);
  for (const o of [{ ...P, error: false }, { ...P, error: "" }, { ...P, code: "skipped" }, { ...P, actions: { ...P.actions, "teardown.purge": act("allow") } },
    { ...P, actions: { "teardown.archive": act("allow"), "teardown.restore": act("allow", "allow", "allowed-by", [ID2]) } },
    // Codex PR238-r7: the same sole rule cannot allow one action and deny the other.
    { ...P, mode: "observe", actions: { "teardown.archive": act("allow"), "teardown.restore": act("allow", "deny", "denied-by") } }]) {
    const r = run({ cli: line(o) });
    assert.equal(r.code, 1, `${JSON.stringify(o)} → ${r.out}`);
    assert.doesNotMatch(r.out, /^ok:/m);
  }
});

test("Codex PR238-r8: a cut list of 10 matched ids is not compared across the actions", () => {
  // Ten allows shared by both actions and one deny on Restore only: the helper prints the same 10 ids for both
  // (MATCHED_CAP), yet Restore is denied. The check must name that deny, not call the output unreadable.
  const ten = Array.from({ length: 10 }, (_, i) => `allow-${i}`);
  const cli = line({ result: "fail", mode: "enforce", rules: 11, pinned: 0, actions: {
    "teardown.archive": act("allow", "allow", "allowed-by", ten),
    "teardown.restore": act("deny", "deny", "denied-by", ten) } });
  const r = run({ cli, cliRc: 1 });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /KK teardown.restore: deny \(rule outcome deny, denied-by, rules allow-0,/);
  assert.match(r.out, /^fail: KK's Archive or Restore would be refused by the policy in force$/m);
  // Below the cap the r7 rule still holds: 9 shared ids with different answers are unreadable.
  const nine = ten.slice(0, 9);
  const bad = line({ result: "fail", mode: "enforce", rules: 11, pinned: 0, actions: {
    "teardown.archive": act("allow", "allow", "allowed-by", nine),
    "teardown.restore": act("deny", "deny", "denied-by", nine) } });
  const b = run({ cli: bad, cliRc: 1 });
  assert.equal(b.code, 1, b.out);
  assert.match(b.out, /^fail: unreadable rules check output$/m);
});

test("Codex PR238-r9: two deciding codes (`default-deny;denied-by`) are unreadable, never a pass", () => {
  const row = act("allow", "deny", "default-deny;denied-by", [ID]);
  for (const reason of ["default-deny;denied-by", "denied-by;allowed-by", "allowed-by;allowed-by;gate-denied-by"]) {
    const r = run({ cli: line({ result: "pass", mode: "observe", rules: 1, pinned: 0, actions: { "teardown.archive": { ...row, reason }, "teardown.restore": { ...row, reason } } }) });
    assert.equal(r.code, 1, `${reason} → ${r.out}`);
    assert.match(r.out, /^fail: unreadable rules check output$/m);
    assert.doesNotMatch(r.out, /^ok:/m);
  }
});

test("Codex PR238-r10: the same matched rules in another order for the other action are unreadable", () => {
  const cli = line({ result: "pass", mode: "enforce", rules: 2, pinned: 0, actions: {
    "teardown.archive": act("allow", "allow", "allowed-by", [ID, ID2]),
    "teardown.restore": act("allow", "allow", "allowed-by", [ID2, ID]) } });
  const r = run({ cli });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^fail: unreadable rules check output$/m);
  // The same order is read.
  const ok = run({ cli: cli.replace(`["${ID2}","${ID}"]`, `["${ID}","${ID2}"]`) });
  assert.equal(ok.code, 0, ok.out);
});

test("Codex PR238-r11: rules both actions name must come in the same relative order", () => {
  const ID3 = "33333333-3333-4333-8333-333333333333";
  const mk = (b) => line({ result: "pass", mode: "enforce", rules: 3, pinned: 0, actions: {
    "teardown.archive": act("allow", "allow", "allowed-by", [ID, ID2]), "teardown.restore": act("allow", "allow", "allowed-by", b) } });
  const r = run({ cli: mk([ID2, ID, ID3]) });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^fail: unreadable rules check output$/m);
  for (const b of [[ID, ID2, ID3], [ID, ID3, ID2], [ID3, ID, ID2]]) assert.equal(run({ cli: mk(b) }).code, 0, JSON.stringify(b));
});

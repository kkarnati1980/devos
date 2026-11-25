// DEVOS-112 (docs/modules/M2.5.md "DEVOS-112: KK's teardown rules check"): would M1.7 let KK's Archive and Restore through?
import { test } from "node:test";
import assert from "node:assert/strict";
import { kkTeardownCli, randomSentinels, KK_TEARDOWN_ACTIONS } from "../dist/teardown-rules-cli.js";

const rule = (o) => ({
  id: o.id, name: o.name ?? o.id, version: 1, priority: o.priority ?? 0, actions: o.actions ?? ["teardown.*"],
  resources: o.resources ?? ["project:*"], principals: o.principals ?? ["kk:*"], roles: [], environments: [],
  effect: o.effect ?? "allow", constraints: o.constraints ?? {}, enabled: o.enabled ?? true,
});
const reader = (mode, rules) => async () => ({ loadPolicy: async () => ({ mode, rules }) });
const ALLOW = "11111111-1111-4111-8111-111111111111";
const DENY = "22222222-2222-4222-8222-222222222222";

test("DEVOS-112: an allow rule for kk:* on teardown.* passes in enforce mode", async () => {
  const r = await kkTeardownCli(["kk-teardown"], reader("enforce", [rule({ id: ALLOW })]));
  assert.equal(r.code, 0);
  assert.equal(r.out.result, "pass");
  assert.equal(r.out.mode, "enforce");
  for (const a of KK_TEARDOWN_ACTIONS) assert.deepEqual(r.out.actions[a], { outcome: "allow", enforced: "allow", reason: "allowed-by", matched: [ALLOW] });
});

test("DEVOS-112: no rule is a default deny in enforce mode (the M2.5-b1 risk), and a fail", async () => {
  const r = await kkTeardownCli(["kk-teardown"], reader("enforce", []));
  assert.equal(r.code, 1);
  assert.equal(r.out.result, "fail");
  assert.deepEqual(r.out.actions["teardown.archive"], { outcome: "deny", enforced: "deny", reason: "default-deny", matched: [] });
});

test("DEVOS-112: in observe mode a default deny is recorded but not enforced, so KK's click goes through", async () => {
  const r = await kkTeardownCli(["kk-teardown"], reader("observe", []));
  assert.equal(r.code, 0);
  assert.deepEqual(r.out.actions["teardown.restore"], { outcome: "deny", enforced: "allow", reason: "default-deny", matched: [] });
});

test("DEVOS-112: a deny beats an allow, a gate deny binds in observe mode, and require_approval is not allowed", async () => {
  let r = await kkTeardownCli(["kk-teardown"], reader("enforce", [rule({ id: ALLOW }), rule({ id: DENY, effect: "deny", actions: ["teardown.restore"] })]));
  assert.equal(r.code, 1);
  assert.equal(r.out.actions["teardown.archive"].enforced, "allow");
  assert.deepEqual(r.out.actions["teardown.restore"].matched.sort(), [ALLOW, DENY].sort());
  assert.equal(r.out.actions["teardown.restore"].enforced, "deny");
  r = await kkTeardownCli(["kk-teardown"], reader("observe", [rule({ id: DENY, effect: "deny", constraints: { gate: true } })]));
  assert.equal(r.code, 1);
  assert.equal(r.out.actions["teardown.archive"].enforced, "deny");
  r = await kkTeardownCli(["kk-teardown"], reader("observe", [rule({ id: ALLOW, effect: "require_approval", constraints: { gate: true } })]));
  assert.equal(r.code, 1);
  assert.equal(r.out.actions["teardown.archive"].enforced, "require_approval");
  r = await kkTeardownCli(["kk-teardown"], reader("enforce", [rule({ id: ALLOW, effect: "require_approval" })]));
  assert.equal(r.code, 1);
  assert.equal(r.out.actions["teardown.archive"].enforced, "require_approval");
});

test("DEVOS-112: asks as generic KK principals on random sentinel projects; a rule pinned to one login or project does not match", async () => {
  const [x, y] = randomSentinels();
  assert.match(x.identity.id, /^kk:check-[0-9a-f-]{36}$/);
  assert.notEqual(x.identity.id, y.identity.id);
  assert.notEqual(x.projectId, y.projectId);
  assert.notEqual(randomSentinels()[0].projectId, x.projectId);
  const r = await kkTeardownCli(["kk-teardown"], reader("enforce", [
    rule({ id: ALLOW, principals: ["kk:someone@example.com"] }),
    rule({ id: DENY, effect: "deny", resources: ["project:abc"] }),
  ]));
  assert.equal(r.code, 1);
  assert.deepEqual(r.out.actions["teardown.archive"].matched, []);
  // Pre-review 2: both are counted as pinned (not judged); an agent rule or a non-teardown rule is not.
  assert.equal(r.out.pinned, 2);
  const other = await kkTeardownCli(["kk-teardown"], reader("enforce", [rule({ id: DENY, effect: "deny", principals: ["agent:*"] }), rule({ id: "x1", actions: ["repo.*"] }), rule({ id: ALLOW })]));
  assert.equal(other.out.pinned, 0);
  assert.equal(other.code, 0);
});

test("Codex PR238-r1: a rule that matches only one sentinel makes the sentinels disagree, a fail, never a pass", async () => {
  const fixed = () => [
    { identity: { id: "kk:check-a", type: "kk" }, projectId: "pa" },
    { identity: { id: "kk:check-b", type: "kk" }, projectId: "pb" },
  ];
  // An allow scoped to the first sentinel (as a rule written for the check's own identity would be).
  let r = await kkTeardownCli(["kk-teardown"], reader("enforce", [rule({ id: ALLOW, principals: ["kk:check-a"] })]), Date.now, fixed);
  assert.equal(r.code, 1);
  assert.equal(r.out.actions["teardown.archive"].enforced, "deny");
  assert.equal(r.out.actions["teardown.archive"].reason, "sentinels-disagree");
  assert.equal(r.out.pinned, 1);
  // Scoped to one sentinel project, in observe mode: both enforced allow, but the rule outcomes differ.
  r = await kkTeardownCli(["kk-teardown"], reader("observe", [rule({ id: ALLOW, resources: ["project:pa"] })]), Date.now, fixed);
  assert.equal(r.code, 1);
  assert.equal(r.out.actions["teardown.restore"].enforced, "allow");
  assert.equal(r.out.actions["teardown.restore"].reason, "sentinels-disagree");
  // On fresh random sentinels such a rule can never match at all: a default deny, a fail.
  r = await kkTeardownCli(["kk-teardown"], reader("enforce", [rule({ id: ALLOW, principals: ["kk:teardown*"] }), rule({ id: "r2", resources: ["project:00000000*"] })]));
  assert.equal(r.code, 1);
  assert.equal(r.out.actions["teardown.archive"].reason, "default-deny");
});

test("DEVOS-112: a read error or a malformed policy is a fixed code, never the database message", async () => {
  let r = await kkTeardownCli(["kk-teardown"], async () => ({ loadPolicy: async () => { throw new Error("password=hunter2 refused"); } }));
  assert.deepEqual(r, { code: 1, out: { error: "teardown-rules-read-failed" } });
  r = await kkTeardownCli(["kk-teardown"], reader("legacy", []));
  assert.deepEqual(r, { code: 1, out: { error: "teardown-rules-read-failed" } });
  r = await kkTeardownCli(["kk-teardown"], reader("enforce", null));
  assert.deepEqual(r, { code: 1, out: { error: "teardown-rules-read-failed" } });
  r = await kkTeardownCli(["kk-teardown"], async () => { throw new Error("no db"); });
  assert.deepEqual(r, { code: 1, out: { error: "teardown-rules-read-failed" } });
});

test("DEVOS-112: wrong arguments are usage (exit 2) and read nothing", async () => {
  let read = false;
  for (const argv of [[], ["kk"], ["kk-teardown", "x"]]) {
    const r = await kkTeardownCli(argv, async () => { read = true; return { loadPolicy: async () => ({ mode: "observe", rules: [] }) }; });
    assert.equal(r.code, 2);
  }
  assert.equal(read, false);
});

test("DEVOS-112: a rule id that is not id-shaped is never printed", async () => {
  const r = await kkTeardownCli(["kk-teardown"], reader("enforce", [rule({ id: "x\ny; rm -rf /" })]));
  assert.equal(r.code, 0);
  assert.deepEqual(r.out.actions["teardown.archive"].matched, []);
  assert.ok(!JSON.stringify(r.out).includes("rm -rf"));
});

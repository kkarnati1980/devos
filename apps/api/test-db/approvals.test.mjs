// M2.3 AT2–AT5, AT7 and AT10 against real Postgres (api-db workflow): the Prisma approval and gate stores with the
// M1.1 constraints and triggers, and the real M1.7 engine on PrismaPolicyStore for grants.
// Rows are committed, so every test uses its own project, tasks and a unique policy action.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createDb } from "@devos/db";
import { PolicyEngine, PrismaPolicyStore } from "@devos/policy";
import { Approvals, PrismaApprovalStore } from "../dist/approvals.js";
import { GateEngine, PrismaGateStore } from "../dist/gates.js";
import { grantsForApproval } from "../dist/runtime.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

const KEY = randomBytes(32);
const KK = { identity: { id: "kk:kk@kiot.io", type: "kk" }, tailscaleLogin: "kk@kiot.io" };
const AGENT = { id: "agent:builder:run-1", type: "agent", roles: ["builder"] };
const verifyKkSession = (s) => s?.tailscaleLogin === "kk@kiot.io";

async function fixture(taskCount = 3) {
  const slug = `m23-${randomBytes(8).toString("hex")}`;
  const project = await db.project.create({ data: { slug, name: slug } });
  const tasks = [];
  for (let i = 0; i < taskCount; i++) {
    tasks.push((await db.task.create({ data: { projectId: project.id, kind: "build", title: `task ${i}` } })).id);
  }
  return { projectId: project.id, tasks };
}

function setup(now = Date.now) {
  const store = new PrismaApprovalStore(db, 5000);
  const engine = new PolicyEngine({ store: new PrismaPolicyStore(db), hmacKey: KEY, now, verifyKkSession });
  const approvals = new Approvals({ store, grants: engine, notifier: null, verifyKkSession, now });
  return { store, engine, approvals };
}

const status = async (id) => (await db.task.findUnique({ where: { id }, select: { status: true } })).status;
const card = (projectId, over = {}) => ({ gate: "decision", action: `deploy.preview.${randomUUID()}`, target: "repo:devos-app", reason: "First preview deploy", projectId, ...over });

test("AT2 (db): approve stores the decision, issues one scoped grant and unblocks only free tasks", async () => {
  const { projectId, tasks: [t1, t2, t3] } = await fixture();
  const { approvals } = setup();
  const a = await approvals.raiseCard(card(projectId), [t1, t2]);
  const b = await approvals.raiseCard(card(projectId), [t2]);
  assert.equal(await status(t1), "blocked");
  assert.equal(await status(t3), "ready");
  const sha = "a".repeat(40);
  const { card: decided, grantId } = await approvals.approve(KK, a.id, { sha });
  assert.equal(decided.status, "approved");
  assert.equal(decided.decidedBy, "kk:kk@kiot.io");
  const grants = await db.approvalGrant.findMany({ where: { approvalId: a.id } });
  assert.equal(grants.length, 1);
  assert.equal(grants[0].id, grantId);
  assert.deepEqual([grants[0].scopeAction, grants[0].scopeResource, grants[0].projectId, grants[0].sha, grants[0].maxUses], [a.action, a.target, projectId, sha, 1]);
  assert.equal(await status(t1), "ready", "only blocker approved");
  assert.equal(await status(t2), "blocked", "another blocker still pending");
  assert.equal(await status(t3), "ready", "unrelated task untouched");
  assert.equal(await db.auditEvent.count({ where: { projectId, action: "approval.approved", actor: "kk" } }), 1);
  await approvals.approve(KK, b.id);
  assert.equal(await status(t2), "ready");
});

test("AT3 (db): reject stores the comment, issues no grant, tasks stay blocked", async () => {
  const { projectId, tasks: [t1] } = await fixture(1);
  const { approvals, store } = setup();
  const c = await approvals.raiseCard(card(projectId), [t1]);
  const r = await approvals.reject(KK, c.id, "Not yet: budget");
  assert.equal(r.status, "rejected");
  assert.equal(await db.approvalGrant.count({ where: { approvalId: c.id } }), 0);
  assert.equal(await status(t1), "blocked");
  const comments = await store.comments(c.id);
  assert.deepEqual(comments.map((x) => [x.author, x.body]), [["kk:kk@kiot.io", "Not yet: budget"]]);
  await assert.rejects(approvals.approve(KK, c.id), (e) => e.code === "card-not-pending");
});

test("AT4 (db): an approval's grant is consumed once; a second use is refused grant-used-up", async () => {
  const { projectId, tasks: [t1] } = await fixture(1);
  const { approvals, engine } = setup();
  const c = await approvals.raiseCard(card(projectId), [t1]);
  await db.policyRule.create({
    data: { name: `m23-at4-${randomUUID()}`, version: 1, priority: 0, actions: [c.action], resources: [], principals: [], roles: [], environments: [], effect: "require_approval", constraints: {}, createdBy: "kk:kk@kiot.io" },
  });
  const { grantId } = await approvals.approve(KK, c.id);
  const chain = `m23-at4-${randomUUID()}`;
  const ask = () => engine.decide({ chain, identity: AGENT, action: { type: c.action, resource: c.target, projectId }, approvalGrantId: grantId });
  assert.equal((await ask()).outcome, "allow");
  assert.match((await ask()).reason, /grant-used-up/);
  assert.equal((await db.approvalGrant.findUnique({ where: { id: grantId } })).uses, 1);
});

test("AT5 (db): an expired card keeps its task blocked; an expired grant is refused grant-expired", async () => {
  const { projectId, tasks: [t1, t2] } = await fixture(2);
  let now = Date.now();
  const { approvals, engine, store } = setup(() => now);
  const old = await approvals.raiseCard(card(projectId), [t1]);
  await db.approval.update({ where: { id: old.id }, data: { createdAt: new Date(now - 8 * 24 * 3600 * 1000) } });
  const expired = await approvals.expireCards();
  assert.ok(expired.includes(old.id));
  assert.equal((await store.get(old.id)).status, "expired");
  assert.equal(await status(t1), "blocked");
  await assert.rejects(approvals.approve(KK, old.id), (e) => e.code === "card-not-pending");

  const c = await approvals.raiseCard(card(projectId), [t2]);
  await db.policyRule.create({
    data: { name: `m23-at5-${randomUUID()}`, version: 1, priority: 0, actions: [c.action], resources: [], principals: [], roles: [], environments: [], effect: "require_approval", constraints: {}, createdBy: "kk:kk@kiot.io" },
  });
  const { grantId } = await approvals.approve(KK, c.id, { expiresInHours: 1 });
  now += 2 * 3600 * 1000;
  const d = await engine.decide({ chain: `m23-at5-${randomUUID()}`, identity: AGENT, action: { type: c.action, resource: c.target, projectId }, approvalGrantId: grantId });
  assert.match(d.reason, /grant-expired/);
  assert.notEqual(d.outcome, "allow");
  assert.equal((await db.approvalGrant.findUnique({ where: { id: grantId } })).uses, 0);
  // The refused attempt raises a fresh card and the task waits on it again (AT5 wording). The shared test database
  // runs M1.7 in observe mode (the schema default), so the enforced outcome is "allow"; the evaluated outcome is the
  // one an enforcing engine would return, and that is what the caller turns into a card.
  assert.equal(d.outcome, "require_approval");
  const enforced = { enforcedOutcome: d.outcome, reason: d.reason, matchedRuleIds: d.matchedRuleIds };
  const again = await approvals.cardForDecision(enforced, { action: c.action, resource: c.target, projectId, taskId: t2 });
  assert.notEqual(again.id, c.id);
  assert.equal(await status(t2), "blocked");
});

test("AT7 (db): two concurrent approvals of one card: one wins, one card-not-pending, one live grant", async () => {
  const { projectId, tasks: [t1] } = await fixture(1);
  const { approvals } = setup();
  const c = await approvals.raiseCard(card(projectId), [t1]);
  const results = await Promise.allSettled([approvals.approve(KK, c.id), approvals.approve(KK, c.id)]);
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason.code, "card-not-pending");
  const live = await db.approvalGrant.findMany({ where: { approvalId: c.id, revokedAt: null } });
  assert.equal(live.length, 1);
  assert.equal(live[0].id, won[0].value.grantId);
  assert.equal(await db.auditEvent.count({ where: { action: "approval.approved", details: { path: ["approvalId"], equals: c.id } } }), 1);
});

test("AT7b (db): a task blocked by two cards approved at once becomes ready", async () => {
  const { projectId, tasks: [t1] } = await fixture(1);
  const { approvals } = setup();
  const a = await approvals.raiseCard(card(projectId), [t1]);
  const b = await approvals.raiseCard(card(projectId), [t1]);
  await Promise.all([approvals.approve(KK, a.id), approvals.approve(KK, b.id)]);
  assert.equal(await status(t1), "ready");
});

test("AT8 (db): raising the same card twice at once creates one card with both blockers", async () => {
  const { projectId, tasks: [t1, t2] } = await fixture(2);
  const { approvals, store } = setup();
  const input = card(projectId);
  const [x, y] = await Promise.all([approvals.raiseCard(input, [t1]), approvals.raiseCard(input, [t2])]);
  assert.equal(x.id, y.id);
  assert.equal(await db.approval.count({ where: { projectId, action: input.action } }), 1);
  assert.deepEqual((await store.blockedTasks(x.id)).map((t) => t.id).sort(), [t1, t2].sort());
});

test("AT8b (db): a dedupe raise racing an approve never leaves a task blocked by an approved card", async () => {
  for (let round = 0; round < 5; round++) {
    const { projectId, tasks: [t1, t2] } = await fixture(2);
    const { approvals } = setup();
    const c = card(projectId);
    const first = await approvals.raiseCard(c, [t1]);
    const [, raised] = await Promise.all([approvals.approve(KK, first.id), approvals.raiseCard(c, [t2])]);
    const blockers = await db.taskBlocker.findMany({ where: { taskId: t2 }, include: { approval: { select: { status: true } } } });
    assert.equal(blockers.length, 1);
    if (raised.id === first.id) {
      // The raise won the card lock: t2 was blocked first and the approve then freed it.
      assert.equal(await status(t2), "ready");
    } else {
      // The approve won: the raise saw the card decided and made a fresh pending card for t2.
      assert.equal(blockers[0].approval.status, "pending");
      assert.equal(await status(t2), "blocked");
    }
  }
});

test("pre-review r2 (db): a multi-task raise racing an approve of a card sharing those tasks does not deadlock", async () => {
  for (let round = 0; round < 5; round++) {
    const { projectId, tasks: [t1, t2] } = await fixture(2);
    const { approvals } = setup();
    const a = await approvals.raiseCard(card(projectId), [t1, t2]);
    const [ok, raised] = await Promise.all([approvals.approve(KK, a.id), approvals.raiseCard(card(projectId), [t2, t1])]);
    assert.equal(ok.card.status, "approved");
    assert.equal(raised.status, "pending");
    assert.equal(await status(t1), "blocked");
    assert.equal(await status(t2), "blocked");
  }
});

test("pre-review (db): a project card cannot block another project's task", async () => {
  const { projectId } = await fixture(0);
  const other = await fixture(1);
  const { approvals } = setup();
  await assert.rejects(approvals.raiseCard(card(projectId), [other.tasks[0]]), (e) => e.code === "task-other-project");
  assert.equal(await status(other.tasks[0]), "ready");
});

test("AT10 (db): closeMilestone needs an approved, same-project, same-gate approval", async () => {
  const { projectId } = await fixture(0);
  const other = await fixture(0);
  const ms = await db.milestone.create({ data: { projectId, ordinal: 1, name: "P1", gateName: "requirements" } });
  const { approvals } = setup();
  const pending = await approvals.raiseCard(card(projectId, { gate: "requirements" }), []);
  const otherProject = await approvals.raiseCard(card(other.projectId, { gate: "requirements" }), []);
  const otherGate = await approvals.raiseCard(card(projectId, { gate: "decision" }), []);
  await approvals.approve(KK, otherProject.id);
  await approvals.approve(KK, otherGate.id);
  await db.policyRule.create({
    data: { name: `m23-at10-${randomUUID()}`, version: 1, priority: 0, actions: ["gate.transition"], resources: [], principals: [], roles: [], environments: [], effect: "allow", constraints: {}, createdBy: "kk:kk@kiot.io" },
  });
  const gates = new GateEngine({ store: new PrismaGateStore(db, 5000), policy: new PolicyEngine({ store: new PrismaPolicyStore(db), hmacKey: KEY }) });
  for (const a of [pending.id, otherProject.id, otherGate.id]) {
    await assert.rejects(gates.closeMilestone(KK.identity, ms.id, a), (e) => e.code === "gate-evidence-missing");
  }
  assert.equal((await db.milestone.findUnique({ where: { id: ms.id } })).closedAt, null);
  await approvals.approve(KK, pending.id);
  const closed = await gates.closeMilestone(KK.identity, ms.id, pending.id);
  const row = await db.milestone.findUnique({ where: { id: ms.id } });
  assert.equal(row.gateApprovalId, pending.id);
  assert.equal(row.closedAt.toISOString(), closed.closedAt.toISOString());
  assert.equal(await db.auditEvent.count({ where: { projectId, action: "milestone.closed" } }), 1);
  await assert.rejects(gates.closeMilestone(KK.identity, ms.id, pending.id), (e) => e.code === "milestone-closed");
});

test("PR41-r3 (db): concurrent closes on one approval never deadlock (same milestone and two milestones)", async () => {
  const { projectId } = await fixture(0);
  const { approvals } = setup();
  const ap = await approvals.raiseCard(card(projectId, { gate: "requirements" }), []);
  await approvals.approve(KK, ap.id);
  await db.policyRule.create({
    data: { name: `m23-r3-${randomUUID()}`, version: 1, priority: 0, actions: ["gate.transition"], resources: [], principals: [], roles: [], environments: [], effect: "allow", constraints: {}, createdBy: "kk:kk@kiot.io" },
  });
  const gates = new GateEngine({ store: new PrismaGateStore(db, 5000), policy: new PolicyEngine({ store: new PrismaPolicyStore(db), hmacKey: KEY }) });
  const outcome = (p) => p.then(() => "closed", (e) => (e && e.code) || String(e && e.message));
  for (let round = 0; round < 5; round++) {
    const m1 = await db.milestone.create({ data: { projectId, ordinal: 10 + round * 2, name: `R${round}a`, gateName: "requirements" } });
    const m2 = await db.milestone.create({ data: { projectId, ordinal: 11 + round * 2, name: `R${round}b`, gateName: "requirements" } });
    // same milestone, four at once: exactly one closes, the rest see milestone-closed
    const same = await Promise.all([1, 2, 3, 4].map(() => outcome(gates.closeMilestone(KK.identity, m1.id, ap.id))));
    assert.equal(same.filter((o) => o === "closed").length, 1, same.join(","));
    assert.ok(same.every((o) => o === "closed" || o === "milestone-closed"), same.join(","));
    // two milestones sharing the approval, at once: both close
    const m3 = await db.milestone.create({ data: { projectId, ordinal: 100 + round, name: `R${round}c`, gateName: "requirements" } });
    const two = await Promise.all([m2.id, m3.id].map((id) => outcome(gates.closeMilestone(KK.identity, id, ap.id))));
    assert.deepEqual(two, ["closed", "closed"], two.join(","));
  }
});

test("M2.3-b1 (db): grantsForApproval returns the card's grants newest first, with revoke state and no other card's", async () => {
  const { projectId, tasks: [t1] } = await fixture(1);
  const { approvals, engine } = setup();
  const a = await approvals.raiseCard(card(projectId), [t1]);
  const b = await approvals.raiseCard(card(projectId), []);
  const { grantId } = await approvals.approve(KK, a.id, { maxUses: 2 });
  await approvals.approve(KK, b.id);
  let rows = await grantsForApproval(db, a.id, 5000);
  assert.deepEqual(rows.map((g) => g.id), [grantId]);
  assert.equal(rows[0].maxUses, 2);
  assert.equal(rows[0].uses, 0);
  assert.equal(rows[0].revokedAt, null);
  assert.equal(rows[0].scopeResource, "repo:devos-app");
  assert.equal(await engine.revokeGrant(KK, grantId), true);
  rows = await grantsForApproval(db, a.id, 5000);
  assert.ok(rows[0].revokedAt instanceof Date);
  assert.deepEqual(await grantsForApproval(db, randomUUID(), 5000), []);
});

test("Codex PR60-r1 (db): a live grant older than 20 newer revoked grants is still returned, so it can be shown and revoked", async () => {
  const { projectId } = await fixture(0);
  const { approvals, engine } = setup();
  const a = await approvals.raiseCard(card(projectId), []);
  const { grantId: live } = await approvals.approve(KK, a.id);
  const base = await db.approvalGrant.findUnique({ where: { id: live } });
  for (let i = 1; i <= 22; i++) {
    await db.approvalGrant.create({ data: { approvalId: a.id, scopeAction: base.scopeAction, scopeResource: base.scopeResource, projectId, issuedBy: base.issuedBy, issuedAt: new Date(base.issuedAt.getTime() + i * 1000), expiresAt: base.expiresAt, maxUses: 1, revokedAt: new Date(base.issuedAt.getTime() + i * 1000 + 1) } });
  }
  const rows = await grantsForApproval(db, a.id, 5000);
  assert.ok(rows.some((g) => g.id === live && g.revokedAt === null), "the live grant is present");
  assert.equal(rows.length, 21, "the 20 newest plus the live one");
  assert.equal(rows.at(-1).id, live, "newest first; the live grant is the oldest");
  assert.equal(await engine.revokeGrant(KK, live), true);
});


test("DEVOS-164 (db): expireCardsById expires named pending cards with one audit row each; decided and unknown ids are left alone", async () => {
  const { projectId, tasks: [t1, t2] } = await fixture(2);
  const { approvals, store } = setup();
  const pending = await approvals.raiseCard(card(projectId), [t1]);
  const decided = await approvals.raiseCard(card(projectId), [t2]);
  await approvals.reject(KK, decided.id, "not now");
  const out = await approvals.expireCardsById([pending.id, decided.id, randomUUID()], "superseded by requirements v2");
  assert.deepEqual(out, [pending.id]);
  const row = await store.get(pending.id);
  assert.deepEqual([row.status, row.decidedBy], ["expired", "system:expiry"]);
  assert.equal((await store.get(decided.id)).status, "rejected");
  assert.equal(await status(t1), "blocked");
  const audits = await db.auditEvent.findMany({ where: { action: "approval.expired", details: { path: ["approvalId"], equals: pending.id } } });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].details.reason, "superseded by requirements v2");
  assert.equal(audits[0].projectId, projectId);
  assert.equal(await db.auditEvent.count({ where: { action: "approval.expired", details: { path: ["approvalId"], equals: decided.id } } }), 0);
  assert.deepEqual(await approvals.expireCardsById([pending.id], "again"), [], "idempotent");
});

test("DEVOS-164 (db): expireCardsById racing approve: the card is either approved or expired, never both", async () => {
  for (let i = 0; i < 5; i++) {
    const { projectId, tasks: [t1] } = await fixture(1);
    const { approvals, store } = setup();
    const c = await approvals.raiseCard(card(projectId), [t1]);
    const [exp, appr] = await Promise.allSettled([approvals.expireCardsById([c.id], "superseded"), approvals.approve(KK, c.id)]);
    assert.equal(exp.status, "fulfilled");
    const final = (await store.get(c.id)).status;
    const live = await db.approvalGrant.findMany({ where: { approvalId: c.id, revokedAt: null } });
    const expiredAudits = await db.auditEvent.count({ where: { action: "approval.expired", details: { path: ["approvalId"], equals: c.id } } });
    const approvedAudits = await db.auditEvent.count({ where: { action: "approval.approved", details: { path: ["approvalId"], equals: c.id } } });
    if (final === "expired") {
      assert.deepEqual(exp.value, [c.id]);
      assert.equal(appr.status, "rejected");
      assert.equal(appr.reason.code, "card-not-pending");
      assert.equal(live.length, 0, "the losing approve's grant is revoked");
      assert.deepEqual([expiredAudits, approvedAudits], [1, 0]);
      assert.equal(await status(t1), "blocked");
    } else {
      assert.equal(final, "approved");
      assert.deepEqual(exp.value, []);
      assert.equal(appr.status, "fulfilled");
      assert.equal(live.length, 1);
      assert.deepEqual([expiredAudits, approvedAudits], [0, 1]);
      assert.equal(await status(t1), "ready");
    }
  }
});

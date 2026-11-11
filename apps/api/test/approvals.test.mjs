// M2.3 acceptance tests (docs/modules/M2.3.md), core service against in-memory stores and the real M1.7 engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryPolicyStore, PolicyEngine } from "@devos/policy";
import { KkSessionRegistry } from "../dist/auth.js";
import { Approvals, ApprovalError, MemoryApprovalStore, parseApproveOptions, parseCard, purgeConfirmationHash } from "../dist/approvals.js";
import { GateEngine, MemoryGateStore } from "../dist/gates.js";

const KEY = Buffer.alloc(32, 7);
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const T3 = "33333333-3333-4333-8333-333333333333";
const PROJECT = "44444444-4444-4444-8444-444444444444";

function setup({ notifier = null, rules = [] } = {}) {
  let now = Date.parse("2026-11-11T12:00:00Z");
  const kk = new KkSessionRegistry();
  const policyStore = new MemoryPolicyStore({ mode: "enforce", rules });
  const engine = new PolicyEngine({ store: policyStore, hmacKey: KEY, now: () => now, verifyKkSession: kk.verify });
  const store = new MemoryApprovalStore();
  store.addTask(T1, "deploy preview");
  store.addTask(T2, "provision repo");
  store.addTask(T3, "unrelated work");
  const approvals = new Approvals({ store, grants: engine, notifier, verifyKkSession: kk.verify, now: () => now });
  return { approvals, store, engine, policyStore, session: kk.mint("kk@example.com"), advance: (ms) => (now += ms) };
}

const card = (over = {}) => ({ gate: "decision", action: "deploy.preview", target: "repo:devos-app", reason: "First preview deploy", projectId: PROJECT, ...over });

const approvalRule = {
  id: "r-approve",
  name: "preview needs approval",
  version: 1,
  priority: 10,
  actions: ["deploy.preview"],
  resources: [],
  principals: [],
  roles: [],
  environments: [],
  effect: "require_approval",
  constraints: {},
  enabled: true,
};
const agent = { id: "agent:builder", type: "agent", role: "builder" };

test("AT1 raiseCard stores, blocks, audits and notifies once; a failed notice keeps the card", async () => {
  const sent = [];
  const { approvals, store } = setup({ notifier: { notify: async (n) => sent.push(n) } });
  const c = await approvals.raiseCard(card(), [T1]);
  assert.equal(c.status, "pending");
  assert.equal(store.tasks.get(T1).status, "blocked");
  assert.equal(store.tasks.get(T3).status, "ready");
  assert.equal(store.audit.at(-1).action, "approval.raised");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "approval");
  assert.equal(sent[0].approvalId, c.id);

  const failing = setup({ notifier: { notify: async () => Promise.reject(new Error("smtp down")) } });
  const c2 = await failing.approvals.raiseCard(card(), [T1]);
  assert.equal((await failing.store.get(c2.id)).status, "pending");
});

test("AT2 approve issues one scoped grant and unblocks only tasks with no other open blocker", async () => {
  const { approvals, store, policyStore, session } = setup();
  const a = await approvals.raiseCard(card(), [T1, T2]);
  await approvals.raiseCard(card({ action: "repo.create", target: "github:devos-app" }), [T2]);
  const { card: decided, grantId } = await approvals.approve(session, a.id, { sha: "a".repeat(40) });
  assert.equal(decided.status, "approved");
  assert.equal(decided.decidedBy, "kk:kk@example.com");
  assert.equal(store.tasks.get(T1).status, "ready");
  assert.equal(store.tasks.get(T2).status, "blocked"); // still waits on the second card
  assert.equal(store.tasks.get(T3).status, "ready");
  const grants = [...policyStore.grants];
  assert.equal(grants.length, 1);
  assert.equal(grants[0].id, grantId);
  assert.equal(grants[0].approvalId, a.id);
  assert.equal(grants[0].scopeAction, "deploy.preview");
  assert.equal(grants[0].scopeResource, "repo:devos-app");
  assert.equal(grants[0].projectId, PROJECT);
  assert.equal(grants[0].sha, "a".repeat(40));
  assert.equal(grants[0].maxUses, 1);
});

test("AT3 reject stores the comment, issues no grant and keeps the tasks blocked", async () => {
  const { approvals, store, policyStore, session } = setup();
  const a = await approvals.raiseCard(card(), [T1]);
  const r = await approvals.reject(session, a.id, "Not this week");
  assert.equal(r.status, "rejected");
  assert.equal(store.tasks.get(T1).status, "blocked");
  assert.equal(policyStore.grants.length, 0);
  const comments = await store.comments(a.id);
  assert.deepEqual(comments.map((c) => [c.author, c.body]), [["kk:kk@example.com", "Not this week"]]);
  await assert.rejects(approvals.approve(session, a.id), (e) => e instanceof ApprovalError && e.code === "card-not-pending");
});

test("AT4 the card's grant lifts require_approval exactly once; a second use is refused", async () => {
  const { approvals, engine, session } = setup({ rules: [approvalRule] });
  const request = { identity: agent, action: { type: "deploy.preview", resource: "repo:devos-app", projectId: PROJECT } };
  const first = await engine.decide(request);
  assert.equal(first.enforcedOutcome, "require_approval");
  const c = await approvals.cardForDecision(first, { action: "deploy.preview", resource: "repo:devos-app", projectId: PROJECT, taskId: T1 });
  const { grantId } = await approvals.approve(session, c.id);
  const used = await engine.decide({ ...request, approvalGrantId: grantId });
  assert.equal(used.enforcedOutcome, "allow");
  const again = await engine.decide({ ...request, approvalGrantId: grantId });
  assert.equal(again.enforcedOutcome, "require_approval");
  assert.match(again.reason, /grant-used-up/);
});

test("AT5 an expired card or grant leaves the task blocked", async () => {
  const { approvals, engine, store, session, advance } = setup({ rules: [approvalRule] });
  const c = await approvals.raiseCard(card(), [T1]);
  advance(8 * 24 * 3600 * 1000);
  assert.deepEqual(await approvals.expireCards(), [c.id]);
  assert.equal((await store.get(c.id)).status, "expired");
  assert.equal(store.tasks.get(T1).status, "blocked");
  await assert.rejects(approvals.approve(session, c.id), (e) => e.code === "card-not-pending");

  const c2 = await approvals.raiseCard(card({ target: "repo:other" }), [T2]);
  const { grantId } = await approvals.approve(session, c2.id, { expiresInHours: 1 });
  advance(2 * 3600 * 1000);
  const late = await engine.decide({ identity: agent, action: { type: "deploy.preview", resource: "repo:other", projectId: PROJECT }, approvalGrantId: grantId });
  assert.equal(late.enforcedOutcome, "require_approval");
  assert.match(late.reason, /grant-expired/);
});

test("AT6 only KK decides: agents, copied or unminted sessions are refused and nothing changes", async () => {
  const { approvals, store, policyStore, session } = setup();
  const c = await approvals.raiseCard(card(), [T1]);
  const forged = { identity: { id: "kk:kk@example.com", type: "kk" }, tailscaleLogin: "kk@example.com" };
  const agentSession = { identity: { id: "agent:builder", type: "agent" }, tailscaleLogin: "x" };
  for (const s of [forged, agentSession, { ...session }, null]) {
    await assert.rejects(approvals.approve(s, c.id), (e) => e.code === "not-kk" && e.status === 403);
    await assert.rejects(approvals.reject(s, c.id), (e) => e.code === "not-kk");
    await assert.rejects(approvals.comment(s, c.id, "hi"), (e) => e.code === "not-kk");
  }
  assert.equal((await store.get(c.id)).status, "pending");
  assert.equal(policyStore.grants.length, 0);
});

test("AT7 two concurrent approvals: one wins, the loser's grant is revoked", async () => {
  const { approvals, policyStore, session } = setup();
  const c = await approvals.raiseCard(card(), [T1]);
  const results = await Promise.allSettled([approvals.approve(session, c.id), approvals.approve(session, c.id)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const lost = results.find((r) => r.status === "rejected");
  assert.equal(lost.reason.code, "card-not-pending");
  const live = [...policyStore.grants].filter((g) => !g.revokedAt);
  assert.equal(live.length, 1);
  assert.equal(live[0].id, results.find((r) => r.status === "fulfilled").value.grantId);
});

test("AT8 cardForDecision needs require_approval; a pending twin is reused and gains blockers", async () => {
  const { approvals, store } = setup();
  await assert.rejects(approvals.cardForDecision({ enforcedOutcome: "allow", reason: "" }, { action: "a", resource: "b" }), (e) => e.code === "card-not-required");
  await assert.rejects(approvals.cardForDecision({ enforcedOutcome: "deny", reason: "" }, { action: "a", resource: "b" }), (e) => e.code === "card-not-required");
  const a = await approvals.cardForDecision({ enforcedOutcome: "require_approval", reason: "rule r1" }, { action: "deploy.preview", resource: "repo:x", projectId: PROJECT, taskId: T1 });
  const b = await approvals.cardForDecision({ enforcedOutcome: "require_approval", reason: "rule r1" }, { action: "deploy.preview", resource: "repo:x", projectId: PROJECT, taskId: T2 });
  assert.equal(a.id, b.id);
  assert.equal(store.cards.size, 1);
  assert.deepEqual((await store.blockedTasks(a.id)).map((t) => t.id).sort(), [T1, T2]);
});

test("AT9 purge needs the typed confirmation; a mismatch changes nothing", async () => {
  const { approvals, store, policyStore, session } = setup();
  const c = await approvals.raiseCard(card({ gate: "purge", action: "project.purge", target: "project:demo" }), [T1]);
  await assert.rejects(approvals.approve(session, c.id), (e) => e.code === "purge-confirmation-mismatch");
  await assert.rejects(approvals.approve(session, c.id, { confirmation: "PURGE project:other" }), (e) => e.code === "purge-confirmation-mismatch");
  assert.equal((await store.get(c.id)).status, "pending");
  assert.equal(policyStore.grants.length, 0);
  const ok = await approvals.approve(session, c.id, { confirmation: "PURGE project:demo" });
  assert.equal(ok.card.confirmationHash, purgeConfirmationHash("project:demo"));
});

test("AT11 input validation and secret-shaped text are refused with fixed codes", () => {
  assert.equal(parseCard(null), "invalid-input");
  assert.equal(parseCard({ ...card(), extra: 1 }), "invalid-input");
  assert.equal(parseCard({ ...card(), gate: "launch" }), "invalid-input");
  assert.equal(parseCard({ ...card(), action: "two\nlines" }), "invalid-input");
  assert.equal(parseCard({ ...card(), action: "x".repeat(201) }), "invalid-input");
  assert.equal(parseCard({ ...card(), costUsd: "-1" }), "invalid-input");
  assert.equal(parseCard({ ...card(), projectId: "nope" }), "invalid-input");
  assert.equal(parseCard({ ...card(), reason: `use ${["api", "key"].join("_")}=${["sk", "live", "abcdef123456"].join("-")}` }), "card-contains-secret");
  assert.equal(typeof parseCard(card({ costUsd: "12.50" })), "object");
  assert.equal(parseApproveOptions({ maxUses: 0 }), "invalid-input");
  assert.equal(parseApproveOptions({ expiresInHours: 90 * 24 + 1 }), "invalid-input");
  assert.equal(parseApproveOptions({ sha: "abc" }), "invalid-input");
  assert.equal(parseApproveOptions({ other: true }), "invalid-input");
  assert.deepEqual(parseApproveOptions({ maxUses: 2, expiresInHours: 48 }), { maxUses: 2, expiresInHours: 48 });
});

test("AT10 closeMilestone needs an approved, same-project, same-gate approval and a policy allow", async () => {
  const M = "55555555-5555-4555-8555-555555555555";
  const A_OK = "66666666-6666-4666-8666-666666666666";
  const A_PENDING = "77777777-7777-4777-8777-777777777777";
  const A_OTHER_PROJECT = "88888888-8888-4888-8888-888888888888";
  const A_OTHER_GATE = "99999999-9999-4999-8999-999999999999";
  const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const allowGate = { ...approvalRule, id: "r-gate", name: "gate transitions", actions: ["gate.transition"], principals: [], effect: "allow" };
  const policy = new PolicyEngine({ store: new MemoryPolicyStore({ mode: "enforce", rules: [allowGate] }), hmacKey: KEY });
  const store = new MemoryGateStore();
  store.milestones.set(M, { id: M, projectId: PROJECT, gateName: "requirements", closedAt: null });
  store.approvals.set(A_OK, { id: A_OK, projectId: PROJECT, gate: "requirements", status: "approved" });
  store.approvals.set(A_PENDING, { id: A_PENDING, projectId: PROJECT, gate: "requirements", status: "pending" });
  store.approvals.set(A_OTHER_PROJECT, { id: A_OTHER_PROJECT, projectId: OTHER, gate: "requirements", status: "approved" });
  store.approvals.set(A_OTHER_GATE, { id: A_OTHER_GATE, projectId: PROJECT, gate: "decision", status: "approved" });
  const gates = new GateEngine({ store, policy });
  const kkId = { id: "kk:kk@example.com", type: "kk" };
  for (const a of [A_PENDING, A_OTHER_PROJECT, A_OTHER_GATE, OTHER]) {
    await assert.rejects(gates.closeMilestone(kkId, M, a), (e) => e instanceof ApprovalError && e.code === "gate-evidence-missing" && e.status === 409, a);
  }
  assert.equal(store.milestones.get(M).closedAt, null);

  // A policy deny stops the transition with the policy's reason code, even with evidence.
  const denied = new GateEngine({ store, policy: new PolicyEngine({ store: new MemoryPolicyStore({ mode: "enforce", rules: [] }), hmacKey: KEY }) });
  await assert.rejects(denied.closeMilestone(kkId, M, A_OK), (e) => e.code === "default-deny" && e.status === 403);
  assert.equal(store.milestones.get(M).closedAt, null);

  const closed = await gates.closeMilestone(kkId, M, A_OK);
  assert.equal(closed.approvalId, A_OK);
  assert.ok(store.milestones.get(M).closedAt);
  assert.equal(store.audit.at(-1).action, "milestone.closed");
  await assert.rejects(gates.closeMilestone(kkId, M, A_OK), (e) => e.code === "milestone-closed");
});

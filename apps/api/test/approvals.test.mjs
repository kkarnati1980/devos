// M2.3 acceptance tests (docs/modules/M2.3.md), core service against in-memory stores and the real M1.7 engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryPolicyStore, PolicyEngine } from "@devos/policy";
import { KkSessionRegistry } from "../dist/auth.js";
import { Approvals, ApprovalError, MemoryApprovalStore, gateFromRules, parseApproveOptions, parseCard, purgeConfirmationHash } from "../dist/approvals.js";
import { gateForRulesFromDb } from "../dist/runtime.js";
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
  store.addTask(T1, "deploy preview", "ready", PROJECT);
  store.addTask(T2, "provision repo", "ready", PROJECT);
  store.addTask(T3, "unrelated work", "ready", PROJECT);
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
  // The refused attempt raises a fresh card and the task waits on it again (contract AT5 wording).
  const again = await approvals.cardForDecision(late, { action: "deploy.preview", resource: "repo:other", projectId: PROJECT, taskId: T2 });
  assert.notEqual(again.id, c2.id);
  assert.equal(again.status, "pending");
  assert.equal(store.tasks.get(T2).status, "blocked");
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

test("pre-review: approve enforces option limits itself; a failed loser revoke is audited, not swallowed", async () => {
  const { approvals, policyStore, session } = setup();
  const c = await approvals.raiseCard(card(), [T1]);
  for (const bad of [{ maxUses: 10000 }, { expiresInHours: 0.5 }, { expiresInHours: Number.NaN }, { other: 1 }]) {
    await assert.rejects(approvals.approve(session, c.id, bad), (e) => e instanceof ApprovalError && e.code === "invalid-input");
  }
  assert.equal(policyStore.grants.length, 0);

  const s2 = setup();
  const c2 = await s2.approvals.raiseCard(card(), [T1]);
  let revokes = 0;
  const grants = { issueGrant: (sess, scope) => s2.engine.issueGrant(sess, scope), revokeGrant: async () => { revokes++; throw new Error("db blip"); } };
  const racing = new Approvals({ store: s2.store, grants, notifier: null, verifyKkSession: () => true });
  await s2.approvals.approve(s2.session, c2.id).catch(() => undefined); // wins first
  s2.store.cards.get(c2.id).status = "pending"; // the racing call reads it as pending, then loses inside decide
  const decideOrig = s2.store.decide.bind(s2.store);
  s2.store.decide = async () => null;
  await assert.rejects(racing.approve(s2.session, c2.id), (e) => e.code === "approvals-store-error");
  assert.equal(revokes, 2);
  assert.equal(s2.store.audit.at(-1).action, "approval.grant_revoke_failed");
  s2.store.decide = decideOrig;
});

test("pre-review: the gate comes from the matched rule; purge actions are always gate 5; projects do not mix", async () => {
  const { approvals, store } = setup();
  const d = { enforcedOutcome: "require_approval", reason: "r", matchedRuleIds: ["r-approve"] };
  const plain = await approvals.cardForDecision(d, { action: "deploy.preview", resource: "repo:x", projectId: PROJECT, gate: "first_launch" });
  assert.equal(plain.gate, "decision"); // a caller-supplied gate is ignored
  const purge = await approvals.cardForDecision(d, { action: "project.purge", resource: "project:demo", projectId: PROJECT });
  assert.equal(purge.gate, "purge");
  const mapped = new Approvals({ store, grants: { issueGrant: async () => ({}), revokeGrant: async () => true }, notifier: null, verifyKkSession: () => false, gateForRules: async (ids) => (ids.includes("r-launch") ? "first_launch" : null) });
  assert.equal((await mapped.cardForDecision({ ...d, matchedRuleIds: ["r-launch"] }, { action: "app.launch", resource: "app:x", projectId: PROJECT })).gate, "first_launch");
  const OTHER = "55555555-5555-4555-8555-555555555555";
  store.addTask(OTHER, "other project task", "ready", "66666666-6666-4666-8666-666666666666");
  await assert.rejects(approvals.raiseCard(card({ action: "x.y" }), [OTHER]), (e) => e.code === "task-other-project");
  assert.equal(store.tasks.get(OTHER).status, "ready");
});

test("pre-review AT11: wildcards, Unicode line breaks, bidi overrides and secret-shaped comments are refused", async () => {
  assert.equal(parseCard({ ...card(), action: "deploy.*" }), "invalid-input");
  assert.equal(parseCard({ ...card(), target: "*" }), "invalid-input");
  assert.equal(parseCard({ ...card(), action: "deploy\u2028preview" }), "invalid-input");
  assert.equal(parseCard({ ...card(), target: "repo:\u202eppa" }), "invalid-input");
  assert.equal(parseCard({ ...card(), reason: "a\u0085b" }), "invalid-input");
  const { approvals, session } = setup();
  const c = await approvals.raiseCard(card(), [T1]);
  const secret = `token ${["sk", "live", "abcdef123456"].join("-")}`;
  await assert.rejects(approvals.comment(session, c.id, secret), (e) => e.code === "card-contains-secret");
  await assert.rejects(approvals.reject(session, c.id, secret), (e) => e.code === "card-contains-secret");
});

test("pre-review r2: a purge action is gate 5 whoever raises it; a running task is parked as blocked", async () => {
  const { approvals, store, policyStore, session } = setup();
  const c = await approvals.raiseCard(card({ gate: "decision", action: "project.purge", target: "project:demo" }), [T1]);
  assert.equal(c.gate, "purge");
  await assert.rejects(approvals.approve(session, c.id), (e) => e.code === "purge-confirmation-mismatch");
  assert.equal(policyStore.grants.length, 0);
  store.tasks.get(T2).status = "running";
  await approvals.cardForDecision({ enforcedOutcome: "require_approval", reason: "r" }, { action: "deploy.preview", resource: "repo:y", projectId: PROJECT, taskId: T2 });
  assert.equal(store.tasks.get(T2).status, "blocked");
});

test("Codex PR41-r1: a gate.transition that requires approval closes only with KK's forwarded grant", async () => {
  const M = "55555555-5555-4555-8555-555555555556";
  const gateRule = { ...approvalRule, id: "r-gate-approve", name: "gate transitions need approval", actions: ["gate.transition"] };
  const { approvals, engine, session } = setup({ rules: [gateRule] });
  const c = await approvals.raiseCard(card({ gate: "requirements", action: "gate.transition", target: `milestone:${M}` }), [T1]);
  const { grantId } = await approvals.approve(session, c.id);
  const store = new MemoryGateStore();
  store.milestones.set(M, { id: M, projectId: PROJECT, gateName: "requirements", closedAt: null });
  store.approvals.set(c.id, { id: c.id, projectId: PROJECT, gate: "requirements", status: "approved" });
  const gates = new GateEngine({ store, policy: engine });
  // The release agent acts on KK's grant (M1.7 refuses a grant used by its own issuer).
  const releaser = { id: "agent:release", type: "agent" };
  await assert.rejects(gates.closeMilestone(releaser, M, c.id), (e) => e instanceof ApprovalError && e.status === 403 && e.code.startsWith("approval-required"));
  await assert.rejects(gates.closeMilestone(releaser, M, c.id, { approvalGrantId: "not-a-uuid" }), (e) => e.code === "invalid-input");
  assert.equal(store.milestones.get(M).closedAt, null);
  const closed = await gates.closeMilestone(releaser, M, c.id, { approvalGrantId: grantId });
  assert.equal(closed.milestoneId, M);
  assert.ok(store.milestones.get(M).closedAt);
});

test("Codex PR41-r4: a SHA-scoped gate grant closes the milestone only for the approved commit", async () => {
  const M = "55555555-5555-4555-8555-555555555557";
  const SHA_OK = "a".repeat(40);
  const gateRule = { ...approvalRule, id: "r-gate-approve-sha", name: "gate transitions need approval", actions: ["gate.transition"] };
  const { approvals, engine, session } = setup({ rules: [gateRule] });
  const c = await approvals.raiseCard(card({ gate: "requirements", action: "gate.transition", target: `milestone:${M}` }), [T1]);
  const { grantId } = await approvals.approve(session, c.id, { sha: SHA_OK });
  const store = new MemoryGateStore();
  store.milestones.set(M, { id: M, projectId: PROJECT, gateName: "requirements", closedAt: null });
  store.approvals.set(c.id, { id: c.id, projectId: PROJECT, gate: "requirements", status: "approved" });
  const gates = new GateEngine({ store, policy: engine });
  const releaser = { id: "agent:release", type: "agent" };
  // No SHA forwarded, or another commit: M1.7 refuses the SHA-scoped grant.
  await assert.rejects(gates.closeMilestone(releaser, M, c.id, { approvalGrantId: grantId }), (e) => e instanceof ApprovalError && e.status === 403);
  await assert.rejects(gates.closeMilestone(releaser, M, c.id, { approvalGrantId: grantId, sha: "b".repeat(40) }), (e) => e instanceof ApprovalError && e.status === 403);
  await assert.rejects(gates.closeMilestone(releaser, M, c.id, { approvalGrantId: grantId, sha: "NOT-A-SHA" }), (e) => e.code === "invalid-input");
  assert.equal(store.milestones.get(M).closedAt, null);
  const closed = await gates.closeMilestone(releaser, M, c.id, { approvalGrantId: grantId, sha: SHA_OK });
  assert.equal(closed.milestoneId, M);
  assert.ok(store.milestones.get(M).closedAt);
});

test("Codex PR41-r1: a gate name changed between validation and close does not close the milestone", async () => {
  const M = "55555555-5555-4555-8555-555555555557";
  const A = "66666666-6666-4666-8666-666666666667";
  const store = new MemoryGateStore();
  store.milestones.set(M, { id: M, projectId: PROJECT, gateName: "requirements", closedAt: null });
  store.approvals.set(A, { id: A, projectId: PROJECT, gate: "requirements", status: "approved" });
  const policy = { decide: async () => { store.milestones.get(M).gateName = "first_launch"; return { enforcedOutcome: "allow", reason: "ok" }; } };
  const gates = new GateEngine({ store, policy });
  await assert.rejects(gates.closeMilestone({ id: "kk:kk@example.com", type: "kk" }, M, A), (e) => e.code === "gate-evidence-missing" && e.status === 409);
  assert.equal(store.milestones.get(M).closedAt, null);
  // An approval revoked (no longer approved) in the same window is caught the same way.
  store.milestones.get(M).gateName = "requirements";
  const p2 = { decide: async () => { store.approvals.get(A).status = "rejected"; return { enforcedOutcome: "allow", reason: "ok" }; } };
  await assert.rejects(new GateEngine({ store, policy: p2 }).closeMilestone({ id: "kk:kk@example.com", type: "kk" }, M, A), (e) => e.code === "gate-evidence-missing");
  assert.equal(store.milestones.get(M).closedAt, null);
});

test("DEVOS-104 item 1: a require_approval decision with no resource is refused card-needs-resource; nothing changes", async () => {
  const { approvals, store } = setup();
  const d = { enforcedOutcome: "require_approval", reason: "rule r1" };
  for (const resource of ["", "   ", undefined]) {
    await assert.rejects(approvals.cardForDecision(d, { action: "deploy.preview", resource, projectId: PROJECT, taskId: T1 }), (e) => e instanceof ApprovalError && e.code === "card-needs-resource");
  }
  assert.equal(store.cards.size, 0);
  assert.equal(store.tasks.get(T1).status, "ready");
});

test("DEVOS-104 item 2: expiry takes effect at the sweep; until then a pending card can still be decided", async () => {
  const { approvals, store, session, advance } = setup({ rules: [approvalRule] });
  const c = await approvals.raiseCard(card(), [T1]);
  advance(7 * 24 * 3600 * 1000 + 1);
  const { card: decided } = await approvals.approve(session, c.id);
  assert.equal(decided.status, "approved");
  assert.deepEqual(await approvals.expireCards(), []);
  assert.equal(store.tasks.get(T1).status, "ready");
});


// DEVOS-164: expire named pending cards (for M2.2-d3c2).
test("DEVOS-164 expireCardsById expires a named pending card (one audit row), leaves decided and unknown ids alone", async () => {
  const { approvals, store, session } = setup({ rules: [approvalRule] });
  const pending = await approvals.raiseCard(card(), [T1]);
  const decided = await approvals.raiseCard(card({ target: "repo:other" }), [T2]);
  await approvals.approve(session, decided.id);
  const other = await approvals.raiseCard(card({ target: "repo:third" }), [T3]);
  const before = store.audit.length;
  const unknown = "99999999-9999-4999-8999-999999999999";
  const out = await approvals.expireCardsById([pending.id, decided.id, unknown, "not-a-uuid", pending.id], "superseded by requirements v2");
  assert.deepEqual(out, [pending.id]);
  assert.equal((await store.get(pending.id)).status, "expired");
  assert.equal((await store.get(pending.id)).decidedBy, "system:expiry");
  assert.equal((await store.get(decided.id)).status, "approved");
  assert.equal((await store.get(other.id)).status, "pending", "an unnamed pending card is untouched");
  assert.equal(store.tasks.get(T1).status, "blocked", "an expired card keeps its task blocked");
  const rows = store.audit.slice(before);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { action: "approval.expired", summary: `Expired: ${pending.action}`, details: { gate: "decision", approvalId: pending.id, reason: "superseded by requirements v2" } });
  // Idempotent: a second call expires nothing and audits nothing.
  assert.deepEqual(await approvals.expireCardsById([pending.id], "again"), []);
  assert.equal(store.audit.length, before + 1);
  await assert.rejects(approvals.approve(session, pending.id), (e) => e.code === "card-not-pending");
});

test("DEVOS-164 expireCardsById validates its input", async () => {
  const { approvals, store } = setup();
  const c = await approvals.raiseCard(card(), [T1]);
  assert.deepEqual(await approvals.expireCardsById([], "nothing named"), []);
  for (const bad of [[c.id, 5], "not-an-array", null, Array(2001).fill(c.id), [c.id, "x".repeat(65)]]) {
    await assert.rejects(approvals.expireCardsById(bad, "reason"), (e) => e.code === "invalid-input");
  }
  for (const reason of ["", "   ", "two\nlines", "x".repeat(501), 7]) {
    await assert.rejects(approvals.expireCardsById([c.id], reason), (e) => e.code === "invalid-input");
  }
  await assert.rejects(approvals.expireCardsById([c.id], "token ghp_" + "a".repeat(36)), (e) => e.code === "card-contains-secret");
  const many = Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${(i + 1000).toString(16).padStart(12, "0")}`);
  await assert.rejects(approvals.expireCardsById(many, "too many"), (e) => e.code === "invalid-input");
  assert.equal((await store.get(c.id)).status, "pending", "a refused call changes nothing");
});

test("DEVOS-164 expireCardsById boundaries: 500 distinct ids and a 500-character reason are accepted; ids are case-insensitive", async () => {
  const { approvals, store } = setup();
  const c = await approvals.raiseCard(card(), [T1]);
  const filler = Array.from({ length: 499 }, (_, i) => `00000000-0000-4000-8000-${(i + 1000).toString(16).padStart(12, "0")}`);
  // 499 unknown ids + the card (upper case) + duplicates and non-UUIDs: 500 distinct UUIDs, under the cap.
  const ids = [...filler, c.id.toUpperCase(), c.id, filler[0], "nope"];
  assert.deepEqual(await approvals.expireCardsById(ids, "r".repeat(500)), [c.id]);
  assert.equal((await store.get(c.id)).status, "expired");
});

test("DEVOS-134: the gate comes from the matched rules' constraints.gateName; unknown names are ignored; the stricter gate wins", async () => {
  const rules = [
    { id: "r-launch", constraints: { gate: true, gateName: "first_launch" } },
    { id: "r-spend", constraints: { gateName: "destructive_or_spend" } },
    { id: "r-typo", constraints: { gateName: "first-launch" } },
    { id: "r-none", constraints: {} },
    { id: "r-null", constraints: null },
    { id: "r-num", constraints: { gateName: 3 } },
  ];
  assert.equal(gateFromRules(["r-launch"], rules), "first_launch");
  assert.equal(gateFromRules(["r-launch", "r-spend"], rules), "destructive_or_spend", "a second rule never weakens the gate");
  assert.equal(gateFromRules(["r-spend", "r-launch"], rules), "destructive_or_spend", "order does not matter");
  assert.equal(gateFromRules(["r-typo", "r-none", "r-null", "r-num"], rules), null, "names outside GATES are ignored");
  assert.equal(gateFromRules(["r-spend"], [{ id: "r-launch", constraints: { gateName: "purge" } }]), null, "only matched rules count");
  assert.equal(gateFromRules([], rules), null);

  // The runtime read: bounded transaction, only the matched ids, no read when nothing matched, >100 ids refused.
  const seen = [];
  const db = {
    $transaction: async (fn, o) => { seen.push({ o }); return fn({ $queryRaw: async (...a) => { seen.push({ raw: a[0].join("?") }); return []; }, policyRule: { findMany: async (q) => { seen.push({ q }); return rules.filter((r) => q.where.id.in.includes(r.id)); } } }); },
  };
  assert.equal(await gateForRulesFromDb(db, ["r-launch", "r-launch", "r-spend"], 5000), "destructive_or_spend");
  assert.deepEqual(seen[0].o, { timeout: 5000, maxWait: 5000 });
  assert.match(seen[1].raw, /statement_timeout/);
  assert.deepEqual(seen[2].q, { where: { id: { in: ["r-launch", "r-spend"] } }, select: { id: true, constraints: true } });
  seen.length = 0;
  assert.equal(await gateForRulesFromDb(db, [], 5000), null);
  assert.equal(seen.length, 0, "no matched rule, no read");
  await assert.rejects(gateForRulesFromDb(db, Array.from({ length: 101 }, (_, i) => `r${i}`), 5000), /gate-rules-too-many/);

  // Wired through Approvals: a launch rule raises a first_launch card; a purge action stays gate 5 whatever the rule says.
  const { store } = setup();
  const a = new Approvals({ store, grants: { issueGrant: async () => ({}), revokeGrant: async () => true }, notifier: null, verifyKkSession: () => false, gateForRules: (ids) => gateForRulesFromDb(db, ids, 5000) });
  const d = { enforcedOutcome: "require_approval", reason: "r", matchedRuleIds: ["r-launch"] };
  assert.equal((await a.cardForDecision(d, { action: "app.launch", resource: "app:x", projectId: PROJECT })).gate, "first_launch");
  assert.equal((await a.cardForDecision({ ...d, matchedRuleIds: ["r-typo"] }, { action: "app.other", resource: "app:y", projectId: PROJECT })).gate, "decision");
  assert.equal((await a.cardForDecision(d, { action: "project.purge", resource: "project:demo", projectId: PROJECT })).gate, "purge");
});

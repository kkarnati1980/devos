// M2.2-d3a: the runtime wires the analyst pipeline to the M2.3 approvals core (contract docs/modules/M2.2.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRequirementsStore } from "@devos/analyst";
import { Approvals, MemoryApprovalStore } from "../dist/approvals.js";
import { syncApproval } from "../dist/requirements.js";
import { buildRuntime, requirementsServices, REQUIREMENTS_TX_MS } from "../dist/runtime.js";
import { KkSessionRegistry } from "../dist/auth.js";

const P1 = "4b7d1c1e-2f6a-4a8e-9d55-0c1f2a3b4c5d";
const SPEC = `# Shop

## Phase 1: Launch

- FR-1: Owner login
  - Login works
- FR-2: Menu page
  - Menu shows prices
- FR-3: Delivery tracking

## Open questions
- What monthly budget can we spend on hosting?
`;

function wire({ notifier = null } = {}) {
  const store = new MemoryRequirementsStore();
  store.addProject({ id: P1, name: "Shop", stage: "intake" });
  const approvalStore = new MemoryApprovalStore();
  const approvals = new Approvals({ store: approvalStore, grants: { issueGrant: async () => ({ id: "g" }) }, notifier, verifyKkSession: () => false });
  return { store, approvalStore, svc: requirementsServices(store, approvals, approvalStore) };
}

test("AT-W1 a spec raises its requirements card in the approvals inbox, linked to the draft", async () => {
  const { svc, approvalStore } = wire();
  const r = await svc.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  assert.ok(r.approvalId);
  const card = approvalStore.cards.get(r.approvalId);
  assert.equal(card.gate, "requirements");
  assert.equal(card.status, "pending");
  assert.equal(card.projectId, P1);
  assert.equal((await svc.store.latestDoc(P1)).approvalId, r.approvalId);
});

test("AT-W2 question cards go to the inbox as decision cards that block no task", async () => {
  const { svc, approvalStore } = wire();
  const r = await svc.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  const decisions = [...approvalStore.cards.values()].filter((c) => c.gate === "decision");
  assert.equal(r.questionCards.failed.length, 0, JSON.stringify(r.questionCards.failed));
  assert.equal(decisions.length, r.questionCards.raised.length);
  assert.ok(decisions.length >= 1, "the budget question is a KK card");
  assert.equal(approvalStore.blockers.length, 0);
  // FR-3 has no acceptance criteria: its card's draft blocks FR-3, and that key is not passed to the core (Behaviour 3).
  assert.ok(decisions.some((c) => /FR-3/.test(`${c.action} ${c.target} ${c.reason}`)), "the missing-acceptance card for FR-3 is raised");
});

test("AT-W3 the card reader is the approvals store: an approved requirements card approves the draft via sync", async () => {
  const { svc, approvalStore } = wire();
  const r = await svc.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  assert.equal((await syncApproval(svc, P1)).status, "draft", "a pending card changes nothing");
  approvalStore.cards.get(r.approvalId).status = "approved";
  assert.equal((await syncApproval(svc, P1)).status, "approved");
});

test("AT-W4 a repeat spec while the question card is pending reuses that card (the core's pending-twin dedupe)", async () => {
  const { svc, approvalStore } = wire();
  await svc.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  const before = [...approvalStore.cards.values()].filter((c) => c.gate === "decision").length;
  await svc.pipeline.submitSpec(P1, { kind: "paste", text: SPEC.replace("## Open", "- FR-4: Orders\n  - Orders list\n\n## Open") });
  const after = [...approvalStore.cards.values()].filter((c) => c.gate === "decision").length;
  assert.equal(after, before);
});

test("AT-W5 buildRuntime: requirements off without the database or policy key; wired with both", async () => {
  const kkSessions = new KkSessionRegistry();
  const okDb = { $transaction: async (fn) => fn({ $queryRaw: async () => [] }) };
  const opts = { outboundTimeoutMs: 500, kkSessions, loadDb: async () => okDb };
  for (const env of [{}, { DATABASE_URL: "postgresql://x/y" }]) {
    const rt = await buildRuntime(env, opts);
    assert.deepEqual(rt.requirements, { pipeline: null, store: null, cards: null });
  }
  const rt = await buildRuntime({ DATABASE_URL: "postgresql://x/y", DEVOS_POLICY_HMAC_KEY: "test-only-policy-hmac-key-0123456789abcdef" }, opts);
  assert.ok(rt.requirements.pipeline && rt.requirements.store && rt.requirements.cards);
  assert.equal(REQUIREMENTS_TX_MS, 30_000);
});

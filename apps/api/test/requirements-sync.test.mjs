// M2.2-d3c1: the syncApproval job and no repeat question cards across versions (contract docs/modules/M2.2.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRequirementsStore } from "@devos/analyst";
import { Approvals, MemoryApprovalStore } from "../dist/approvals.js";
import { requirementsServices } from "../dist/runtime.js";
import { RequirementsSyncJob, skipDecidedQuestions, syncIntervalMs, SYNC_DEFAULT_MS, SYNC_MIN_MS, SYNC_MAX_MS } from "../dist/requirements-sync.js";

const P1 = "4b7d1c1e-2f6a-4a8e-9d55-0c1f2a3b4c5d";
const P2 = "5c8e2d2f-3a7b-4b9f-8e66-1d2a3b4c5d6e";
const SPEC = `# Shop

## Phase 1: Launch

- FR-1: Owner login
  - Login works
- FR-2: Menu page
  - Menu shows prices

## Open questions
- What monthly budget can we spend on hosting?
`;

function wire() {
  const store = new MemoryRequirementsStore();
  store.addProject({ id: P1, name: "Shop", stage: "intake" });
  store.addProject({ id: P2, name: "Cafe", stage: "intake" });
  const approvalStore = new MemoryApprovalStore();
  const approvals = new Approvals({ store: approvalStore, grants: { issueGrant: async () => ({ id: "g" }) }, notifier: null, verifyKkSession: () => false });
  const svc = requirementsServices(store, approvals, approvalStore);
  // The memory store has no SQL; the lister mirrors draftsAwaitingDecision over its newest docs.
  const lister = {
    async draftsAwaitingDecision(limit) {
      const out = [];
      for (const p of [P1, P2]) {
        const d = await store.latestDoc(p);
        if (d && d.status === "draft" && d.approvalId) out.push(p);
      }
      return out.slice(0, limit);
    },
  };
  return { store, approvalStore, svc, lister };
}

test("AT-S1 one job tick approves a draft whose card is approved, with no POST", async () => {
  const { svc, approvalStore, lister } = wire();
  const r = await svc.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  approvalStore.cards.get(r.approvalId).status = "approved";
  const logs = [];
  const job = new RequirementsSyncJob(svc, lister, (e) => logs.push(e), 60_000);
  assert.equal(await job.tick(), 1);
  assert.equal((await svc.store.latestDoc(P1)).status, "approved");
  assert.deepEqual(logs, []);
});

test("AT-S2 pending/rejected cards leave the draft; a failing project is logged with the fixed code and the next one is synced", async () => {
  const { svc, approvalStore, lister } = wire();
  const r1 = await svc.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  const r2 = await svc.pipeline.submitSpec(P2, { kind: "paste", text: SPEC });
  approvalStore.cards.get(r1.approvalId).status = "rejected";
  const job = new RequirementsSyncJob(svc, lister, () => {}, 60_000);
  await job.tick();
  assert.equal((await svc.store.latestDoc(P1)).status, "draft", "rejected leaves the draft");
  assert.equal((await svc.store.latestDoc(P2)).status, "draft", "pending leaves the draft");

  approvalStore.cards.get(r2.approvalId).status = "approved";
  const realGet = svc.cards.get;
  svc.cards.get = async (id) => {
    if (id === r1.approvalId) throw new Error("secret spec text in a db error");
    return realGet(id);
  };
  const logs = [];
  const job2 = new RequirementsSyncJob(svc, lister, (e) => logs.push(e), 60_000);
  assert.equal(await job2.tick(), 1);
  assert.deepEqual(logs, [{ level: "warn", msg: "requirements-sync-failed", projectId: P1 }]);
  assert.ok(!JSON.stringify(logs).includes("secret"), "the error message is never logged");
  assert.equal((await svc.store.latestDoc(P2)).status, "approved");
});

test("AT-S2 a failing lister is logged and the tick ends cleanly", async () => {
  const { svc } = wire();
  const logs = [];
  const job = new RequirementsSyncJob(svc, { draftsAwaitingDecision: async () => { throw new Error("db down"); } }, (e) => logs.push(e), 60_000);
  assert.equal(await job.tick(), 0);
  assert.deepEqual(logs, [{ level: "warn", msg: "requirements-sync-failed", projectId: "*" }]);
});

test("AT-S3 ticks never overlap, the interval is clamped, stop() clears the timer", async () => {
  const { svc } = wire();
  let release;
  const gate = new Promise((r) => (release = r));
  let calls = 0;
  const job = new RequirementsSyncJob(svc, { draftsAwaitingDecision: async () => { calls++; await gate; return []; } }, () => {}, 60_000);
  const first = job.tick();
  assert.equal(await job.tick(), null, "a tick during a running tick does nothing");
  release();
  assert.equal(await first, 0);
  assert.equal(calls, 1);
  assert.equal(await job.tick(), 0, "the next tick runs once the first finished");

  assert.equal(syncIntervalMs(undefined), SYNC_DEFAULT_MS);
  assert.equal(syncIntervalMs("abc"), SYNC_DEFAULT_MS);
  assert.equal(syncIntervalMs("-5"), SYNC_DEFAULT_MS);
  assert.equal(syncIntervalMs("1"), SYNC_MIN_MS);
  assert.equal(syncIntervalMs("99999999"), SYNC_MAX_MS);
  assert.equal(syncIntervalMs(" 120000 "), 120_000);

  job.start();
  assert.ok(job["timer"], "started");
  job.stop();
  assert.equal(job["timer"], null, "stopped");
});

test("AT-Q1 a question approved or rejected in an earlier version is not raised again", async () => {
  for (const decided of ["approved", "rejected"]) {
    const { svc, approvalStore } = wire();
    const v1 = await svc.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
    const q = v1.questionCards.raised;
    assert.ok(q.length >= 1);
    for (const { cardId } of q) approvalStore.cards.get(cardId).status = decided;
    const before = approvalStore.cards.size;
    const v2 = await svc.pipeline.submitSpec(P1, { kind: "paste", text: `${SPEC}\n- FR-9: Reviews\n  - Reviews show\n` });
    const decisionsAfter = [...approvalStore.cards.values()].filter((c) => c.gate === "decision");
    assert.equal(decisionsAfter.length, q.length, `${decided}: no new decision card`);
    assert.deepEqual(v2.questionCards.raised.map((x) => x.cardId).sort(), q.map((x) => x.cardId).sort(), `${decided}: the decided card ids come back`);
    assert.equal(approvalStore.cards.size, before + 1, `${decided}: only the new requirements card is added`);
  }
});

test("AT-Q2 an expired earlier card, or a decided card of another project, does not stop the question", async () => {
  const { svc, approvalStore } = wire();
  const v1 = await svc.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  for (const { cardId } of v1.questionCards.raised) approvalStore.cards.get(cardId).status = "expired";
  const v2 = await svc.pipeline.submitSpec(P1, { kind: "paste", text: `${SPEC}\n- FR-9: Reviews\n  - Reviews show\n` });
  const old = new Set(v1.questionCards.raised.map((x) => x.cardId));
  assert.ok(v2.questionCards.raised.length >= 1 && v2.questionCards.raised.every((x) => !old.has(x.cardId)), "asked again after expiry");

  // Another project's decided twin does not count.
  const p2 = await svc.pipeline.submitSpec(P2, { kind: "paste", text: SPEC });
  assert.ok(p2.questionCards.raised.every((x) => !old.has(x.cardId)));
});

test("AT-Q1 the decided-card scan is bounded and paged", async () => {
  const pages = [];
  const lister = {
    async list(f) {
      pages.push(f);
      return Array.from({ length: f.limit }, (_, i) => ({ id: `${f.status}-${pages.length}-${i}`, gate: "decision", action: "x", target: "y", projectId: P1 }));
    },
  };
  let raised = 0;
  const port = skipDecidedQuestions(async () => ({ id: `new-${++raised}` }), lister);
  const r = await port({ card: { gate: "decision", action: "other", target: "y", projectId: P1, reason: "r" } }, "r");
  assert.equal(r.id, "new-1");
  assert.equal(pages.reduce((n, f) => n + f.limit, 0), 1000, "at most 1 000 cards are read in all");
  assert.ok(pages.every((f) => f.projectId === P1 && f.limit <= 100));
  assert.equal(pages[1].cursor, pages[0].limit && `${pages[0].status}-1-99`, "the next page starts after the last card");
});

// CR-b2b (DEVOS-215, docs/modules/ADR-0012.md): the M2.3 binding and the flush/apply job, over the memory stores.
// AT11's M2.3 half: approval releases exactly the batch's tasks; a task named in no `blocks` is never blocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CardBatchQueue, MemoryQueueStore } from "@devos/card-batch";
import { Approvals, ApprovalError, MemoryApprovalStore } from "../dist/approvals.js";
import { CardBatchJob, batchCardsFrom } from "../dist/card-batch.js";

const P = "11111111-1111-4111-8111-111111111111";
const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const T2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const T3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const AT_0730_IST = new Date("2026-11-14T02:00:00Z");
const AT_0800_IST = new Date("2026-11-14T02:30:00Z");

function wire({ tasks = true } = {}) {
  const approvalStore = new MemoryApprovalStore();
  if (tasks) for (const id of [T1, T2, T3]) approvalStore.addTask(id, id, "ready", P);
  const approvals = new Approvals({ store: approvalStore, grants: { issueGrant: async () => ({ id: "g" }) }, notifier: null, verifyKkSession: () => false });
  const store = new MemoryQueueStore();
  store.addProject(P, "Shop");
  const q = new CardBatchQueue(store, batchCardsFrom(approvals, approvalStore), randomUUID);
  const lister = {
    async projectsToFlush() {
      return [P];
    },
    async batchesToApply() {
      return [...store.batches.values()].filter((b) => b.state === "raised" && !b.appliedAt).map((b) => b.id);
    },
  };
  const logs = [];
  const job = new CardBatchJob(q, approvals, (id) => store.projectName(id), lister, (e) => logs.push(e));
  return { approvalStore, approvals, store, q, job, logs };
}

test("CR-b2b job: no flush before 08:00 IST; one card from 08:00; approval applies BQ answers and logs the follow-up once", async () => {
  const { approvalStore, store, q, job, logs } = wire();
  await q.queueQuestion(P, { gate: "decision", text: "Dark header?", default: "yes", blocks: [] }, AT_0730_IST);
  assert.deepEqual(await job.tick(AT_0730_IST), { applied: 0, flushed: 0 });
  assert.equal(approvalStore.cards.size, 0);
  assert.deepEqual(await job.tick(AT_0800_IST), { applied: 0, flushed: 1 });
  assert.deepEqual(await job.tick(AT_0800_IST), { applied: 0, flushed: 0 });
  const [card] = [...approvalStore.cards.values()];
  assert.equal(card.gate, "decision");
  assert.match(card.target, /^batch:/);
  card.status = "approved";
  card.decidedAt = new Date(AT_0800_IST.getTime() + 60_000);
  await approvalStore.comment(card.id, "kk", "BQ-1: no", new Date(AT_0800_IST.getTime() + 30_000));
  assert.equal((await job.tick(AT_0800_IST)).applied, 1);
  assert.deepEqual(store.decisions.filter((d) => d.approvalId).map((d) => [d.source, d.answer]), [["kk", "no"]]);
  assert.equal(logs.filter((l) => l.msg === "card-batch-follow-up").length, 1);
  await job.tick(AT_0800_IST);
  assert.equal(logs.filter((l) => l.msg === "card-batch-follow-up").length, 1, "logged once");
});

test("CR-b2b job: a refused batch's members are raised one by one; a transient failure retries without losing them", async () => {
  // T1 does not exist in M2.3, so the batch card is refused (task-not-found) and the batch is parked.
  const { approvals, approvalStore, store, q, job } = wire({ tasks: false });
  await q.queueQuestion(P, { gate: "decision", text: "Dark header?", default: "yes", blocks: [T1] }, AT_0730_IST);
  const raise = approvals.raiseCard.bind(approvals);
  let transient = true;
  approvals.raiseCard = async (input, blocks) => {
    if (input.target.startsWith("question:") && transient) {
      transient = false;
      throw new Error("db down");
    }
    return raise(input, blocks);
  };
  await job.tick(AT_0800_IST);
  const [b] = [...store.batches.values()];
  assert.deepEqual([b.state, b.handedOffAt], ["refused", null], "a transient member failure keeps the hand-off open");
  await job.tick(AT_0800_IST);
  assert.ok(store.batches.get(b.id).handedOffAt, "handed off once every member is raised");
  const cards = [...approvalStore.cards.values()];
  assert.equal(cards.length, 1);
  assert.match(cards[0].target, /^question:/);
});

test("batchCardsFrom: lookup by target finds a decided card; the queue-time check refuses what M2.3 would", async () => {
  const { approvals, approvalStore } = wire();
  const cards = batchCardsFrom(approvals, approvalStore);
  const c = await approvals.raiseCard({ gate: "decision", action: "Answer the build questions for Shop", target: "batch:x", reason: "1 question", projectId: P });
  approvalStore.cards.get(c.id).status = "approved";
  assert.deepEqual(await cards.findByTarget(P, "batch:x"), { id: c.id });
  assert.equal(await cards.findByTarget(P, "batch:y"), null);
  assert.equal(await cards.check({ projectId: P, reason: "1 question\nBQ-1: Fine? (default: yes)", blocks: [] }), null);
  assert.equal(typeof (await cards.check({ projectId: P, reason: "x".repeat(2001), blocks: [] })), "string");
});

test("AT11 (M2.3 half): approval releases exactly the batch's tasks; a task in no blocks is never blocked", async () => {
  const { approvalStore, q, job } = wire();
  await q.queueQuestion(P, { gate: "decision", text: "Dark header?", default: "yes", blocks: [T1] }, AT_0730_IST);
  await q.queueQuestion(P, { gate: "decision", text: "Sticky footer?", default: "no", blocks: [T2] }, new Date(AT_0730_IST.getTime() + 1));
  assert.deepEqual([T1, T2, T3].map((t) => approvalStore.tasks.get(t).status), ["ready", "ready", "ready"], "before the flush no task state changes");
  await job.tick(AT_0800_IST);
  assert.deepEqual([T1, T2, T3].map((t) => approvalStore.tasks.get(t).status), ["blocked", "blocked", "ready"]);
  const [card] = [...approvalStore.cards.values()];
  await approvalStore.decide(card.id, { status: "approved", by: "kk", at: new Date(AT_0800_IST.getTime() + 60_000) }, { action: "approval.decide", summary: "test", details: {} });
  assert.deepEqual([T1, T2, T3].map((t) => approvalStore.tasks.get(t).status), ["ready", "ready", "ready"]);
  assert.equal((await job.tick(AT_0800_IST)).applied, 1);
});

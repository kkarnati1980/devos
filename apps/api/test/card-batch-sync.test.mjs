// CR-b2d (DEVOS-218, docs/modules/ADR-0012.md): the M2.3 binding and the flush/apply job, over the memory stores
// (adapted from the CR-b2b WIP branch's tests).
// AT11's M2.3 half: approval releases exactly the batch's tasks; a task named in no `blocks` is never blocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CardBatchQueue, MemoryQueueStore } from "@devos/card-batch";
import { Approvals, ApprovalError, MemoryApprovalStore } from "../dist/approvals.js";
import { CardBatchJob } from "../dist/card-batch-sync.js";
import { approvalBatchCards } from "../dist/card-batch-store.js";

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
  const q = new CardBatchQueue(store, approvalBatchCards(approvals), randomUUID);
  const lister = {
    days: [],
    async projectsToFlush(day, _limit, after) {
      lister.days.push(day);
      return after ? [] : [{ projectId: P, since: "2026-11-14 02:00:00+00" }];
    },
    async projectsWithOpenBatch() {
      return [...store.batches.values()].some((b) => b.projectId === P && (b.state === "raising" || (b.state === "refused" && !b.handedOffAt))) ? [P] : [];
    },
    async batchesToApply() {
      return [...store.batches.values()].filter((b) => b.state === "raised" && !b.settledAt).map((b) => b.id);
    },
  };
  const logs = [];
  const job = new CardBatchJob(q, approvals, (id) => store.projectName(id), lister, (e) => logs.push(e));
  return { approvalStore, approvals, store, q, job, logs, lister };
}

test("CR-b2d job: no flush before 08:00 IST; one card from 08:00; approval applies BQ answers and logs the follow-up once", async () => {
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

test("CR-b2d job: a refused batch's members are raised one by one; a transient failure retries without losing them", async () => {
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

test("approvalBatchCards: lookup by target finds a decided card; the queue-time check refuses what M2.3 would", async () => {
  const { approvals, approvalStore } = wire();
  const cards = approvalBatchCards(approvals);
  const c = await approvals.raiseCard({ gate: "decision", action: "Answer the build questions for Shop", target: "batch:x", reason: "1 question", projectId: P });
  approvalStore.cards.get(c.id).status = "approved";
  assert.deepEqual(await cards.findByTarget(P, "batch:x"), { id: c.id });
  assert.equal(await cards.findByTarget(P, "batch:y"), null);
  assert.equal(cards.check, undefined, "no task reader: M2.3 checks the tasks at raise");
  const other = "22222222-2222-4222-8222-222222222222";
  const checked = approvalBatchCards(approvals, { taskProjects: async (ids) => new Map(ids.filter((t) => t !== T3).map((t) => [t, t === T2 ? other : P])) });
  assert.equal(await checked.check({ projectId: P, reason: "1 question\nBQ-1: Fine? (default: yes)", blocks: [T1] }), null);
  assert.equal(await checked.check({ projectId: P, reason: "1 question", blocks: [T3] }), "task-not-found");
  assert.equal(await checked.check({ projectId: P, reason: "1 question", blocks: [T2] }), "task-other-project");
  assert.equal(await checked.check({ projectId: P, reason: "key sk-ant-api03-" + "a".repeat(40), blocks: [] }), "card-contains-secret");
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

test("CR-b2d job: a batch is settled after its follow-ups; a crash before settle logs them again, never loses them", async () => {
  const { approvalStore, store, q, job, logs, lister } = wire();
  await q.queueQuestion(P, { gate: "decision", text: "Dark header?", default: "yes", blocks: [] }, AT_0730_IST);
  await job.tick(AT_0800_IST);
  assert.deepEqual(lister.days.at(-1), "2026-11-14", "the flush list is asked for the IST day");
  const [card] = [...approvalStore.cards.values()];
  card.status = "approved";
  card.decidedAt = new Date(AT_0800_IST.getTime() + 60_000);
  await approvalStore.comment(card.id, "kk", "BQ-1: no", new Date(AT_0800_IST.getTime() + 30_000));
  // The crash: settle fails once, after the follow-up was logged.
  const settle = q.settle.bind(q);
  q.settle = async () => { q.settle = settle; throw new Error("db down"); };
  await job.tick(AT_0800_IST);
  const [b] = [...store.batches.values()];
  assert.equal(b.settledAt, null);
  assert.equal(logs.filter((l) => l.msg === "card-batch-follow-up").length, 1);
  assert.equal(logs.filter((l) => l.msg === "card-batch-apply-failed").length, 1);
  await job.tick(AT_0800_IST);
  assert.ok(store.batches.get(b.id).settledAt);
  assert.equal(logs.filter((l) => l.msg === "card-batch-follow-up").length, 2, "logged again, at least once");
  await job.tick(AT_0800_IST);
  assert.equal(logs.filter((l) => l.msg === "card-batch-follow-up").length, 2, "a settled batch is not listed again");
  // A rejected batch is settled at once, with no follow-up.
  await q.queueQuestion(P, { gate: "decision", text: "Sticky footer?", default: "no", blocks: [] }, new Date("2026-11-15T02:00:00Z"));
  await job.tick(new Date("2026-11-15T02:40:00Z"));
  const c2 = [...approvalStore.cards.values()].find((c) => c.id !== card.id);
  c2.status = "rejected";
  c2.decidedAt = new Date("2026-11-15T02:45:00Z");
  await job.tick(new Date("2026-11-15T02:50:00Z"));
  const b2 = [...store.batches.values()].find((x) => x.id !== b.id);
  assert.ok(b2.settledAt);
  assert.equal(logs.filter((l) => l.msg === "card-batch-follow-up").length, 2);
});

test("CR-b2d job: a hand-off retry skips a member whose card KK already decided; a refused member is logged without its text", async () => {
  // T1 does not exist in M2.3, so the batch card is refused and its members are handed off one by one.
  const { approvals, approvalStore, store, q, job, logs } = wire({ tasks: false });
  approvalStore.addTask(T2, T2, "ready", P);
  await q.queueQuestion(P, { gate: "decision", text: "Dark header?", default: "yes", blocks: [T1] }, AT_0730_IST);
  await q.queueQuestion(P, { gate: "decision", text: "Sticky footer?", default: "no", blocks: [T2] }, new Date(AT_0730_IST.getTime() + 1));
  await q.queueQuestion(P, { gate: "decision", text: "Round avatars?", default: "yes", blocks: [] }, new Date(AT_0730_IST.getTime() + 2));
  await q.queueQuestion(P, { gate: "decision", text: "Logo colour?", default: "blue", blocks: [] }, new Date(AT_0730_IST.getTime() + 3));
  const raise = approvals.raiseCard.bind(approvals);
  let failThird = true;
  approvals.raiseCard = async (input, blocks) => {
    if (input.target.startsWith("question:") && input.reason.startsWith("Round") && failThird) {
      failThird = false;
      throw new Error("db down");
    }
    if (input.target.startsWith("question:") && input.reason.startsWith("Logo")) throw new ApprovalError("card-contains-secret");
    return raise(input, blocks);
  };
  await job.tick(AT_0800_IST);
  const [b] = [...store.batches.values()];
  assert.deepEqual([b.state, b.handedOffAt], ["refused", null], "the third member failed: the hand-off stays open");
  const sticky = [...approvalStore.cards.values()].find((c) => c.reason.startsWith("Sticky"));
  assert.equal(approvalStore.tasks.get(T2).status, "blocked");
  // KK decides the second member's card before the retry; its task is released.
  await approvalStore.decide(sticky.id, { status: "approved", by: "kk", at: new Date(AT_0800_IST.getTime() + 60_000) }, { action: "approval.decide", summary: "test", details: {} });
  assert.equal(approvalStore.tasks.get(T2).status, "ready");
  await job.tick(AT_0800_IST);
  assert.ok(store.batches.get(b.id).handedOffAt, "handed off once every member is handled");
  const reasons = [...approvalStore.cards.values()].map((c) => c.reason.split(" ")[0]).sort();
  assert.deepEqual(reasons, ["Dark", "Round", "Sticky"], "each member raised once, none twice");
  assert.equal(approvalStore.tasks.get(T2).status, "ready", "a decided member's tasks are never re-blocked");
  // No log line carries question text or an error message.
  const refusedLog = logs.filter((l) => l.msg === "card-batch-question-refused");
  assert.equal(refusedLog.length, 1, "the member M2.3 refuses outright is logged once, and the hand-off still completes");
  assert.deepEqual(Object.keys(refusedLog[0]).sort(), ["level", "msg", "projectId", "questionId"]);
  for (const l of logs) assert.ok(!JSON.stringify(l).match(/Dark|Sticky|Round|Logo|db down/), JSON.stringify(l));
});

test("CR-b2d job: a failing list or flush is logged with a fixed code and the rest of the tick runs", async () => {
  const { q, job, logs, lister } = wire();
  await q.queueQuestion(P, { gate: "decision", text: "Dark header?", default: "yes", blocks: [] }, AT_0730_IST);
  lister.batchesToApply = async () => { throw new Error("secret-ish detail"); };
  assert.deepEqual(await job.tick(AT_0800_IST), { applied: 0, flushed: 1 });
  assert.deepEqual(logs.map((l) => l.msg), ["card-batch-list-failed"]);
  const flush = q.flushBatch.bind(q);
  q.flushBatch = async () => { throw new Error("db down"); };
  await job.tick(new Date("2026-11-15T02:40:00Z")); // the next IST day's pass
  assert.ok(logs.some((l) => l.msg === "card-batch-flush-failed" && l.projectId === P));
  assert.ok(!JSON.stringify(logs).includes("secret-ish") && !JSON.stringify(logs).includes("db down"));
  q.flushBatch = flush;
});

test("CR-b2d job: the day's batches are claimed by one pass from 08:00 IST; a question queued at 14:00 IST waits for the next day", async () => {
  const { approvalStore, q, job, lister } = wire();
  // The day's pass runs at 08:00 IST with nothing queued.
  await job.tick(AT_0800_IST);
  await q.queueQuestion(P, { gate: "decision", text: "Dark header?", default: "yes", blocks: [] }, new Date("2026-11-14T08:30:00Z")); // 14:00 IST
  await job.tick(new Date("2026-11-14T08:35:00Z"));
  assert.equal(approvalStore.cards.size, 0, "no card at 14:05 IST");
  // 23:59 IST is still 14 Nov; 08:05 IST on 15 Nov is a new IST day (UTC still 15 Nov 02:35).
  await job.tick(new Date("2026-11-14T18:29:00Z"));
  assert.equal(approvalStore.cards.size, 0);
  await job.tick(new Date("2026-11-15T02:35:00Z"));
  assert.equal(approvalStore.cards.size, 1, "raised by the next day's pass");
  assert.equal(lister.days.at(-1), "2026-11-15");
});

test("CR-b2d job: a failed daily list read is retried on the next tick", async () => {
  const { approvalStore, q, job, lister } = wire();
  await q.queueQuestion(P, { gate: "decision", text: "Dark header?", default: "yes", blocks: [] }, AT_0730_IST);
  const list = lister.projectsToFlush;
  lister.projectsToFlush = async () => { lister.projectsToFlush = list; throw new Error("db down"); };
  await job.tick(AT_0800_IST);
  assert.equal(approvalStore.cards.size, 0);
  await job.tick(new Date(AT_0800_IST.getTime() + 300_000));
  assert.equal(approvalStore.cards.size, 1);
});

test("CR-b2d job (Codex PR143-r1): the daily pass drains every page, so the 101st eligible project still gets its batch", async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `p-${String(i).padStart(3, "0")}`);
  const flushed = [];
  let lists = 0;
  const queue = { applyBatch: async () => ({ outcome: "none", followUps: [] }), settle: async () => {}, flushBatch: async (id) => { flushed.push(id); return { outcome: "raised" }; } };
  const row = (id) => ({ projectId: id, since: `2026-11-14 01:00:${id.slice(2)}+00` });
  const lister = {
    // A flushed project has the day's batch, so it leaves the list; each read returns at most one page, after the cursor.
    projectsToFlush: async (_day, limit, after) => { lists++; return ids.filter((id) => !flushed.includes(id) && (!after || id > after.projectId)).slice(0, limit).map(row); },
    projectsWithOpenBatch: async () => [],
    batchesToApply: async () => [],
  };
  const job = new CardBatchJob(queue, null, async () => "x", lister, () => {});
  const r = await job.tick(AT_0800_IST);
  assert.equal(r.flushed, 101);
  assert.deepEqual(flushed, ids);
  assert.equal(lists, 2, "a full page is followed by the next; the short page ends the pass");
  await job.tick(new Date(AT_0800_IST.getTime() + 300_000));
  assert.equal(lists, 2, "the day counts as flushed only after the pass drained");
});

test("CR-b2d job (Codex PR143-r2): 100 stuck open batches cannot hide the 101st eligible project; pages move by keyset cursor", async () => {
  // 100 projects whose batches stay `raising` (still eligible on every read, oldest first) and one later project
  // with a queued question. The store is keyset-paginated on (since, projectId), as PrismaQueueStore.projectsToFlush.
  const stuck = Array.from({ length: 100 }, (_, i) => ({ projectId: `s-${String(i).padStart(3, "0")}`, since: `2026-11-13 10:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(6, "0")}+00` }));
  const late = { projectId: "z-late", since: "2026-11-14 01:00:00+00" };
  const all = [...stuck, late].sort((a, b) => (a.since === b.since ? (a.projectId < b.projectId ? -1 : 1) : a.since < b.since ? -1 : 1));
  const key = (r) => [r.since, r.projectId];
  const gt = (a, b) => (a[0] === b[0] ? a[1] > b[1] : a[0] > b[0]);
  const flushedIds = [];
  const afters = [];
  const queue = {
    applyBatch: async () => ({ outcome: "none", followUps: [] }),
    settle: async () => {},
    flushBatch: async (id) => { flushedIds.push(id); return id === late.projectId ? { outcome: "raised" } : { outcome: "raising" }; },
  };
  const lister = {
    projectsToFlush: async (_day, limit, after) => {
      afters.push(after ?? null);
      // Stuck batches never leave the list; the late project leaves once it has the day's batch.
      return all.filter((r) => !(r.projectId === late.projectId && flushedIds.includes(late.projectId)) && (!after || gt(key(r), key(after)))).slice(0, limit);
    },
    projectsWithOpenBatch: async () => stuck.map((r) => r.projectId),
    batchesToApply: async () => [],
  };
  const job = new CardBatchJob(queue, null, async () => "x", lister, () => {});
  const r = await job.tick(AT_0800_IST);
  assert.ok(flushedIds.includes(late.projectId), "the 101st project is flushed in the same tick");
  assert.equal(r.flushed, 1);
  assert.equal(afters.length, 2, "page 2 is read after a full page of 100, and is short");
  assert.equal(afters[0], null);
  assert.deepEqual(afters[1], all[99], "page 2 starts after page 1's last row");
  assert.equal(new Set(flushedIds).size, flushedIds.length, "no project is flushed twice in one pass");
  // The day is flushed: the next tick only retries open batches (one page), it does not re-list the day.
  afters.length = 0;
  await job.tick(new Date(AT_0800_IST.getTime() + 300_000));
  assert.equal(afters.length, 0);
});

test("CR-b2d job (Codex PR143-r3): a pass cut by the page bound resumes after its cursor on the next tick, so the project after 5,000 stuck batches is reached", async () => {
  const stuck = Array.from({ length: 5000 }, (_, i) => ({ projectId: `s-${String(i).padStart(4, "0")}`, since: `2026-11-13 10:00:00.${String(i).padStart(6, "0")}+00` }));
  const late = { projectId: "z-late", since: "2026-11-14 01:00:00+00" };
  const all = [...stuck, late];
  const gt = (a, b) => (a.since === b.since ? a.projectId > b.projectId : a.since > b.since);
  const flushedIds = [];
  const reads = [];
  const queue = {
    applyBatch: async () => ({ outcome: "none", followUps: [] }),
    settle: async () => {},
    flushBatch: async (id) => { flushedIds.push(id); return id === late.projectId ? { outcome: "raised" } : { outcome: "raising" }; },
  };
  let failNext = false;
  const lister = {
    projectsToFlush: async (day, limit, after) => {
      if (failNext) { failNext = false; throw new Error("db down"); }
      reads.push({ day, after: after ?? null });
      return all.filter((r) => !(r.projectId === late.projectId && flushedIds.includes(late.projectId)) && (!after || gt(r, after))).slice(0, limit);
    },
    projectsWithOpenBatch: async () => [],
    batchesToApply: async () => [],
  };
  const job = new CardBatchJob(queue, null, async () => "x", lister, () => {});
  const t1 = await job.tick(AT_0800_IST);
  assert.equal(t1.flushed, 0);
  assert.equal(reads.length, 50, "one tick reads at most 50 pages");
  assert.ok(!flushedIds.includes(late.projectId));
  // A failed read on the next tick keeps the cursor; the tick after retries from the same place.
  failNext = true;
  await job.tick(new Date(AT_0800_IST.getTime() + 300_000));
  assert.equal(reads.length, 50);
  const t3 = await job.tick(new Date(AT_0800_IST.getTime() + 600_000));
  assert.deepEqual(reads[50].after, stuck[4999], "the next pass resumes after the last row read, not from the start");
  assert.equal(t3.flushed, 1, "the project after the 5,000 stuck batches is flushed");
  assert.equal(reads.length, 51, "the short page ends the pass");
  await job.tick(new Date(AT_0800_IST.getTime() + 900_000));
  assert.equal(reads.length, 51, "the day counts as flushed");
  // The next IST day starts its pass from the beginning.
  await job.tick(new Date(AT_0800_IST.getTime() + 86_400_000));
  assert.equal(reads[51].day, "2026-11-15");
  assert.equal(reads[51].after, null);
});

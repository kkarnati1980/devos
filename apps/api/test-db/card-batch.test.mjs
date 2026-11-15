// ADR-0012 CR-b2b (DEVOS-215): the batched cards on Postgres — AT8b (the batch lock and the crash between raise and
// record) and the M2.3 half of AT11 (blocked tasks become ready; a task not named in any `blocks` is never blocked).
// Runs in CI `api-db`. Rows are committed, so every test uses its own project and tasks.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { createDb } from "@devos/db";
import { PolicyEngine, PrismaPolicyStore } from "@devos/policy";
import { CardBatchQueue, QueueError, batchCard } from "@devos/card-batch";
import { Approvals, PrismaApprovalStore } from "../dist/approvals.js";
import { PrismaQueueStore, approvalBatchCards, prismaTaskProjects } from "../dist/card-batch-store.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

const KEY = randomBytes(32);
const KK = { identity: { id: "kk:kk@kiot.io", type: "kk" }, tailscaleLogin: "kk@kiot.io" };
const verifyKkSession = (s) => s?.tailscaleLogin === "kk@kiot.io";
const DAY1 = new Date("2026-11-14T04:30:00Z"); // 10:00 IST, 14 Nov
const DAY1_LATE = new Date("2026-11-14T18:00:00Z"); // 23:30 IST, 14 Nov
const DAY2 = new Date("2026-11-14T18:31:00Z"); // 00:01 IST, 15 Nov

async function fixture(taskCount = 3) {
  const slug = `crb2-${randomBytes(8).toString("hex")}`;
  const project = await db.project.create({ data: { slug, name: slug } });
  const tasks = [];
  for (let i = 0; i < taskCount; i++) tasks.push((await db.task.create({ data: { projectId: project.id, kind: "build", title: `task ${i}` } })).id);
  return { projectId: project.id, tasks };
}

function setup() {
  const engine = new PolicyEngine({ store: new PrismaPolicyStore(db), hmacKey: KEY, verifyKkSession });
  const approvals = new Approvals({ store: new PrismaApprovalStore(db, 5000), grants: engine, notifier: null, verifyKkSession });
  const store = new PrismaQueueStore(db, { databaseUrl: url, timeoutMs: 5000 });
  const cards = approvalBatchCards(approvals, prismaTaskProjects(db));
  return { approvals, store, cards, queue: new CardBatchQueue(store, cards, randomUUID) };
}

const status = async (id) => (await db.task.findUnique({ where: { id }, select: { status: true } })).status;
const batchCards = (projectId) => db.approval.findMany({ where: { projectId, gate: "decision" } });
const ask = (text, dflt, blocks = []) => ({ gate: "decision", text, default: dflt, blocks });

test("CR-b2b: the queue writes the question with its provisional row once; ids are scoped to the project", async () => {
  const { projectId, tasks: [t1] } = await fixture(1);
  const { queue } = setup();
  const id = randomUUID();
  const q = await queue.queueQuestion(projectId, { ...ask("Which colour for the header?", "blue", [t1]), id }, DAY1);
  assert.deepEqual([q.id, q.projectId, q.default, q.blocks, q.batchId], [id, projectId, "blue", [t1], null]);
  await queue.queueQuestion(projectId, { ...ask("Which colour for the header?", "blue", [t1]), id }, DAY1);
  const rows = await db.projectDecision.findMany({ where: { projectId, itemId: `Q-${id}` } });
  assert.deepEqual(rows.map((r) => [r.source, r.answer, r.approvalId]), [["default-provisional", "blue", null]]);
  assert.equal(await status(t1), "ready", "before the flush no task state changes (AT11)");
  const other = await fixture(0);
  await assert.rejects(queue.queueQuestion(other.projectId, { ...ask("Tabs or spaces?", "spaces"), id }, DAY1), (e) => e instanceof QueueError && e.code === "id-conflict");
  // M2.3's refusals are run at queue time: a task of another project is refused, nothing is stored.
  await assert.rejects(queue.queueQuestion(other.projectId, ask("Tabs or spaces?", "spaces", [t1]), DAY1), (e) => e instanceof QueueError && e.code === "not-batchable");
  assert.equal(await db.queuedQuestion.count({ where: { projectId: other.projectId } }), 0);
});

test("AT8b (db): a flush that cannot take the batch lock raises nothing; after the record a flush raises nothing", async () => {
  const { projectId, tasks: [t1, t2] } = await fixture(2);
  const { approvals, store, queue } = setup();
  await queue.queueQuestion(projectId, ask("Which colour for the header?", "blue", [t1]), DAY1);
  const claimed = await store.claim(projectId, "2026-11-14", randomUUID());
  assert.equal(claimed.state, "raising");
  // Flush A holds the lock: it raises the card, the card is decided, and flush B runs before A records it.
  let inB;
  const held = await store.withBatchLock(claimed.id, async () => {
    const members = await store.members(claimed.id);
    const card = batchCard(projectId, claimed.id);
    const raised = await approvals.raiseCard({ ...card, reason: `1 questions\nBQ-1: ${members[0].text} (default: blue)`, projectId }, [t1]);
    await approvals.approve(KK, raised.id);
    inB = await queue.flushBatch(projectId, DAY1_LATE);
    await store.markRaised(claimed.id, raised.id);
    return raised.id;
  });
  assert.equal(held.locked, true);
  assert.equal(inB.outcome, "busy", "B could not take the lock and raised nothing");
  const c = await queue.flushBatch(projectId, DAY1_LATE);
  assert.equal(c.outcome, "none", "the day's batch is raised; nothing new to claim");
  assert.equal((await batchCards(projectId)).length, 1);
  assert.equal((await store.batch(claimed.id)).state, "raised");
  assert.equal(await status(t2), "ready", "a task not in any blocks is never blocked");
});

test("AT8b (db): with A's connection dropped between raise and record, B finds the decided card by target and records it", async () => {
  const { projectId, tasks: [t1] } = await fixture(1);
  const { approvals, store, queue } = setup();
  await queue.queueQuestion(projectId, ask("Should the footer be sticky?", "no", [t1]), DAY1);
  const claimed = await store.claim(projectId, "2026-11-14", randomUUID());
  // Flush A on its own connection: takes the session lock, raises the card, then its connection drops.
  const a = new pg.Client({ connectionString: url });
  await a.connect();
  a.on("error", () => {});
  let open = true;
  let raised;
  try {
    const got = await a.query("SELECT pg_try_advisory_lock(hashtext('devos:card-batch:' || $1::text)) AS ok", [claimed.id]);
    assert.equal(got.rows[0].ok, true);
    const name = (await db.project.findUnique({ where: { id: projectId } })).name;
    const card = batchCard(name, claimed.id);
    raised = await approvals.raiseCard({ ...card, reason: "1 questions\nBQ-1: Should the footer be sticky? (default: no)", projectId }, [t1]);
    // While A holds the lock, B does nothing.
    assert.equal((await queue.flushBatch(projectId, DAY1_LATE)).outcome, "busy");
    await approvals.approve(KK, raised.id);
    assert.equal(await status(t1), "ready");
    open = false;
    await a.end(); // the crash: the lock goes with the connection
  } finally {
    if (open) await a.end().catch(() => {});
  }
  const b = await queue.flushBatch(projectId, DAY1_LATE);
  assert.deepEqual([b.outcome, b.cardId], ["recorded", raised.id]);
  assert.equal((await batchCards(projectId)).length, 1, "one card in total");
  assert.equal(await status(t1), "ready", "no task is re-blocked");
  assert.equal((await queue.flushBatch(projectId, DAY1_LATE)).outcome, "none");
});

test("AT11 (db, M2.3 half): approving with BQ-1 records kk/default rows and the blocked tasks become ready; rejecting keeps them blocked", async () => {
  const { projectId, tasks: [t1, t2, t3, t4] } = await fixture(4);
  const { approvals, store, queue } = setup();
  const q1 = await queue.queueQuestion(projectId, ask("Should the footer be sticky?", "yes", [t1]), DAY1);
  const q2 = await queue.queueQuestion(projectId, ask("Round or square avatars?", "round", [t2]), new Date(DAY1.getTime() + 1000));
  assert.equal(await status(t1), "ready", "before the flush no task state changes");
  const f = await queue.flushBatch(projectId, DAY1_LATE);
  assert.equal(f.outcome, "raised");
  assert.deepEqual([await status(t1), await status(t2), await status(t4)], ["blocked", "blocked", "ready"]);
  await approvals.comment(KK, f.cardId, "BQ-1: no");
  await approvals.approve(KK, f.cardId);
  const done = await queue.applyBatch(f.batchId, DAY2);
  assert.deepEqual([done.outcome, done.first], ["approved", true]);
  assert.deepEqual(done.followUps.map((x) => x.questionId), [q1.id]);
  const rows = await db.projectDecision.findMany({ where: { projectId, approvalId: f.cardId }, orderBy: { itemId: "asc" } });
  const by = Object.fromEntries(rows.map((r) => [r.itemId, [r.source, r.answer]]));
  assert.deepEqual(by[`Q-${q1.id}`], ["kk", "no"]);
  assert.deepEqual(by[`Q-${q2.id}`], ["default", "round"]);
  assert.deepEqual([await status(t1), await status(t2)], ["ready", "ready"]);
  // A second apply writes nothing and keeps the batch listed until settled (Codex PR135-r1).
  assert.equal((await queue.applyBatch(f.batchId, DAY2)).first, false);
  assert.equal(await db.projectDecision.count({ where: { projectId, approvalId: f.cardId } }), 2);
  assert.ok((await store.batchesToApply()).includes(f.batchId));
  await queue.settle(f.batchId, DAY2);
  assert.ok(!(await store.batchesToApply()).includes(f.batchId));

  // Rejection, the next IST day: no rows, the task stays blocked, no new card.
  await queue.queueQuestion(projectId, ask("Serif or sans?", "sans", [t3]), DAY2);
  const g = await queue.flushBatch(projectId, DAY2);
  assert.equal(g.outcome, "raised");
  await approvals.reject(KK, g.cardId, "Not now");
  const r = await queue.applyBatch(g.batchId, DAY2);
  assert.deepEqual([r.outcome, r.stopped], ["rejected", [t3]]);
  assert.equal(await db.projectDecision.count({ where: { projectId, approvalId: g.cardId } }), 0);
  assert.equal(await status(t3), "blocked");
  assert.equal((await queue.flushBatch(projectId, DAY2)).outcome, "none");
  assert.equal((await batchCards(projectId)).length, 2);
  assert.equal(await status(t4), "ready", "a task not named in any blocks is never blocked");
});

test("CR-b2b: card_batch refuses a second batch for the same project and IST day, and a raised row without a card", async () => {
  const { projectId } = await fixture(0);
  await db.$executeRawUnsafe("INSERT INTO card_batch (id, project_id, ist_day) VALUES (gen_random_uuid(), $1::uuid, '2026-11-14')", projectId);
  await assert.rejects(db.$executeRawUnsafe("INSERT INTO card_batch (id, project_id, ist_day) VALUES (gen_random_uuid(), $1::uuid, '2026-11-14')", projectId));
  await assert.rejects(db.$executeRawUnsafe("INSERT INTO card_batch (id, project_id, ist_day, state) VALUES (gen_random_uuid(), $1::uuid, '2026-11-15', 'raised')", projectId));
  await assert.rejects(db.$executeRawUnsafe("INSERT INTO card_batch (id, project_id, ist_day) VALUES (gen_random_uuid(), $1::uuid, '15 Nov')", projectId));
});

test("AT8b (db): B claims the raising row while A holds the lock; after A records, B's re-read under the lock stops (already)", async () => {
  const { projectId, tasks: [t1] } = await fixture(1);
  const { approvals, store, queue } = setup();
  await queue.queueQuestion(projectId, ask("Which logo size?", "small", [t1]), DAY1);
  const claimed = await store.claim(projectId, "2026-11-14", randomUUID());
  // B has claimed (it got the raising row) but has not yet taken the lock when A records.
  const bClaim = await store.claim(projectId, "2026-11-14", randomUUID());
  assert.equal(bClaim.id, claimed.id);
  const name = (await db.project.findUnique({ where: { id: projectId } })).name;
  const raised = await approvals.raiseCard({ ...batchCard(name, claimed.id), reason: "1 questions\nBQ-1: Which logo size? (default: small)", projectId }, [t1]);
  await store.markRaised(claimed.id, raised.id);
  // B now runs its locked step: the re-read sees `raised` and stops. A stub claim hands B the stale row it held.
  const stale = Object.create(store);
  stale.claim = async () => bClaim;
  const b = await new CardBatchQueue(stale, approvalBatchCards(approvals), randomUUID).flushBatch(projectId, DAY1_LATE);
  assert.deepEqual([b.outcome, b.cardId], ["already", raised.id]);
  assert.equal((await batchCards(projectId)).length, 1);
});

test("CR-b2b (db): two concurrent claims of one project and day make one batch; projectsToFlush skips a project waiting for tomorrow", async () => {
  const { projectId } = await fixture(0);
  const { store, queue } = setup();
  await queue.queueQuestion(projectId, ask("Light or dark theme?", "light"), DAY1);
  assert.ok((await store.projectsToFlush("2026-11-14")).includes(projectId));
  const [x, y] = await Promise.all([store.claim(projectId, "2026-11-14", randomUUID()), store.claim(projectId, "2026-11-14", randomUUID())]);
  assert.equal(x.id, y.id, "the second claim gets the first one's raising batch");
  assert.equal(await db.cardBatch.count({ where: { projectId } }), 1);
  assert.ok((await store.projectsWithOpenBatch()).includes(projectId), "a raising batch is retried");
  await store.markRefused(x.id);
  assert.ok((await store.projectsWithOpenBatch()).includes(projectId), "a refused batch not yet handed off is retried");
  await store.markHandedOff(x.id, DAY1_LATE);
  assert.ok(!(await store.projectsWithOpenBatch()).includes(projectId));
  // A question queued after the day's batch waits for 15 Nov: it takes no slot on 14 Nov.
  await queue.queueQuestion(projectId, ask("Show prices with tax?", "yes"), DAY1_LATE);
  assert.ok(!(await store.projectsToFlush("2026-11-14")).includes(projectId));
  assert.ok((await store.projectsToFlush("2026-11-15")).includes(projectId));
  assert.ok((await store.projectsToFlush("2026-11-15", 2.5)).length <= 2, "a fractional limit is an integer");
  // A batch whose card is still pending is not listed for apply.
  const f = await queue.flushBatch(projectId, DAY2);
  assert.equal(f.outcome, "raised");
  assert.ok(!(await store.batchesToApply()).includes(f.batchId));
});

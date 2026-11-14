// CR-b2b (DEVOS-215, docs/modules/ADR-0012.md): AT8b and the card_batch / queued_question checks against real
// Postgres (api-db workflow): PrismaQueueStore with the session advisory lock on a dedicated pg connection.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { createDb } from "@devos/db";
import { CardBatchQueue } from "@devos/card-batch";
import { PrismaQueueStore } from "../dist/card-batch-store.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

const opened = [];
async function connect() {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  opened.push(c);
  return c;
}
const DAY = new Date("2026-11-14T04:30:00Z");

/** A card port over a plain list (the M2.3 binding is wired in runtime.ts); `during` runs inside raiseCard. */
function fakeCards() {
  const cards = [];
  return {
    cards,
    during: null,
    async raiseCard(input, blocks) {
      const c = { id: randomUUID(), status: "pending", ...input, blocks: [...blocks] };
      cards.push(c);
      if (this.during) await this.during(c);
      return { id: c.id };
    },
    async findByTarget(projectId, target) {
      const c = [...cards].reverse().find((x) => x.projectId === projectId && x.target === target);
      return c ? { id: c.id } : null;
    },
    async get(id) {
      const c = cards.find((x) => x.id === id);
      return c ? { id: c.id, status: c.status } : null;
    },
    async comments() {
      return [];
    },
  };
}

async function project() {
  const slug = `crb2b-${randomBytes(4).toString("hex")}`;
  return db.project.create({ data: { slug, name: slug } });
}

test("AT8b: the batch lock serialises raise and record; a dropped holder's card is recorded, never raised twice", async () => {
  // (1) A holds the lock and raises; the card is decided before A records; B runs meanwhile and is busy; C after
  // A's record raises nothing.
  {
    const p = await project();
    const store = new PrismaQueueStore(db, connect, 5000);
    const cards = fakeCards();
    const q = new CardBatchQueue(store, cards, randomUUID);
    await q.queueQuestion(p.id, { gate: "decision", text: "Which colour for the header?", default: "blue" }, DAY);
    let b;
    cards.during = async (c) => {
      cards.during = null;
      c.status = "approved";
      b = await q.flushBatch(p.id, DAY);
    };
    const a = await q.flushBatch(p.id, DAY);
    assert.equal(a.outcome, "raised");
    assert.deepEqual([b.outcome, b.batchId], ["busy", a.batchId]);
    const c = await q.flushBatch(p.id, DAY);
    assert.deepEqual(c, { outcome: "none" });
    assert.equal(cards.cards.length, 1);
    const row = await db.cardBatch.findUnique({ where: { id: a.batchId } });
    assert.deepEqual([row.state, row.cardId], ["raised", a.cardId]);
  }
  // (2) A's connection drops between raise and record: the lock is released with it; B takes the lock, finds the
  // decided card by target, records it and raises none.
  {
    const p = await project();
    const cards = fakeCards();
    let lockConn;
    const store = new PrismaQueueStore(db, async () => (lockConn = await connect()), 5000);
    const q = new CardBatchQueue(store, cards, randomUUID);
    await q.queueQuestion(p.id, { gate: "decision", text: "Which colour for the header?", default: "blue" }, DAY);
    cards.during = async (c) => {
      cards.during = null;
      c.status = "approved";
      // The holder dies: its session ends (lock released) and the record never happens.
      await lockConn.end();
      throw new Error("holder crashed");
    };
    await assert.rejects(q.flushBatch(p.id, DAY), /holder crashed/);
    const [batch] = await db.cardBatch.findMany({ where: { projectId: p.id } });
    assert.equal(batch.state, "raising");
    const b = await q.flushBatch(p.id, DAY);
    assert.deepEqual([b.outcome, b.batchId, b.cardId], ["recorded", batch.id, cards.cards[0].id]);
    assert.equal(cards.cards.length, 1, "one card in total");
    assert.equal((await db.cardBatch.findUnique({ where: { id: batch.id } })).state, "raised");
  }
});

test("CR-b2b: claim is one per project and day under concurrency; apply has one winner; the checks hold", async () => {
  const p = await project();
  const store = new PrismaQueueStore(db, connect, 5000);
  const q = new CardBatchQueue(store, fakeCards(), randomUUID);
  const id = randomUUID();
  await q.queueQuestion(p.id, { gate: "decision", text: "Which colour?", default: "blue", id }, DAY);
  await q.queueQuestion(p.id, { gate: "decision", text: "Which colour?", default: "blue", id }, DAY);
  assert.equal(await db.queuedQuestion.count({ where: { projectId: p.id } }), 1, "a retried queue call writes nothing");
  assert.equal(await db.projectDecision.count({ where: { projectId: p.id, source: "default-provisional" } }), 1);
  const claims = await Promise.all([store.claim(p.id, "2026-11-14", randomUUID()), store.claim(p.id, "2026-11-14", randomUUID())]);
  assert.equal(new Set(claims.map((c) => c?.id)).size, 1, "both see the one raising batch");
  assert.equal(await db.cardBatch.count({ where: { projectId: p.id } }), 1);
  const batchId = claims[0].id;
  await store.markRaised(batchId, (await db.approval.create({ data: { projectId: p.id, gate: "decision", action: "x", target: `batch:${batchId}`, reason: "1 question" } })).id);
  const row = { projectId: p.id, itemId: `Q-${id}`, text: "Which colour?", answer: "red", source: "kk", approvalId: (await store.batch(batchId)).cardId };
  const wins = await Promise.all([store.apply(batchId, [row], DAY), store.apply(batchId, [row], DAY)]);
  assert.deepEqual(wins.sort(), [false, true]);
  assert.equal(await db.projectDecision.count({ where: { projectId: p.id, source: "kk" } }), 1);
  const refusedBy = (check) => (e) => String(e?.message ?? "").includes(check);
  await assert.rejects(db.cardBatch.create({ data: { projectId: p.id, istDay: "2026-11-15", state: "done" } }), refusedBy("card_batch_state_valid"));
  await assert.rejects(db.cardBatch.create({ data: { projectId: p.id, istDay: "15 Nov", state: "raising" } }), refusedBy("card_batch_ist_day_valid"));
  await assert.rejects(db.cardBatch.create({ data: { projectId: p.id, istDay: "2026-11-16", state: "raised" } }), refusedBy("card_batch_raised_has_card"));
  await assert.rejects(db.queuedQuestion.create({ data: { projectId: p.id, text: "", source: "runner", default: "x", blocks: [], queuedAt: DAY } }), refusedBy("queued_question_text_valid"));
  await assert.rejects(db.queuedQuestion.create({ data: { projectId: p.id, text: "x", source: "runner", default: "y".repeat(201), blocks: [], queuedAt: DAY } }), refusedBy("queued_question_default_valid"));
});

after(async () => {
  for (const c of opened) await c.end().catch(() => {});
});

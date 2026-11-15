// ADR-0012 CR-b2c (DEVOS-216): the project page's batch view (AT8a page part, AT11 page part) and its store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { batchesView, PrismaBatchViewStore, BATCH_VIEW_DAYS } from "../dist/card-batch-view.js";

const P = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const C1 = "33333333-3333-4333-8333-333333333333";
const q = (id, batchId, n, text = `Question ${n}`) => ({ id, batchId, text, source: "builder", default: "Architect decides", queuedAt: `2026-11-15T08:${String(n).padStart(2, "0")}:00.000Z` });

function reader(snap) {
  return { projectBySlug: async (s) => (s === "shop" ? { id: P } : null), batchSnapshot: async (id) => { assert.equal(id, P); return snap; } };
}

test("AT8a (CR-b2c): the page lists all 12 questions of a batch whose card reason is clipped, numbered BQ-1..BQ-12 in queue order", async () => {
  const long = "x".repeat(1000);
  const questions = Array.from({ length: 12 }, (_, i) => q(`q${String(i + 1).padStart(2, "0")}`, "b2", i + 1, `${i + 1} ${long}`.slice(0, 1000)));
  const decisions = questions.map((x, i) => ({ approvalId: C2, itemId: `Q-${x.id}`, answer: i === 0 ? "no" : "Architect decides", source: i === 0 ? "kk" : "default" }));
  const v = await batchesView("shop", reader({
    batches: [{ id: "b2", istDay: "2026-11-15", state: "raised", cardId: C2, cardStatus: "approved", applied: true, handedOff: false }],
    questions, decisions, stopped: [], waitingCount: 0, truncated: false,
  }));
  assert.equal(v.batches.length, 1);
  const b = v.batches[0];
  assert.equal(b.questions.length, 12);
  assert.deepEqual(b.questions.map((x) => x.ref), Array.from({ length: 12 }, (_, i) => `BQ-${i + 1}`));
  assert.equal(b.questions[11].text.length, 1000, "the full question, not the 200-character card line");
  assert.deepEqual([b.questions[0].answer, b.questions[0].answerSource], ["no", "kk"]);
  assert.deepEqual([b.questions[5].answer, b.questions[5].answerSource], ["Architect decides", "default"]);
  assert.deepEqual(b.stoppedTasks, [], "an approved card stops nothing");
});

test("AT11 page part (CR-b2c): a rejected or expired card lists its stopped tasks; answers and tasks never cross cards", async () => {
  const v = await batchesView("shop", reader({
    batches: [
      { id: "b3", istDay: "2026-11-16", state: "raised", cardId: "44444444-4444-4444-8444-444444444444", cardStatus: "expired", applied: false, handedOff: false },
      { id: "b2", istDay: "2026-11-15", state: "raised", cardId: C2, cardStatus: "pending", applied: false, handedOff: false },
      { id: "b1", istDay: "2026-11-14", state: "raised", cardId: C1, cardStatus: "rejected", applied: false, handedOff: false },
      { id: "b0", istDay: "2026-11-13", state: "refused", cardId: null, cardStatus: null, applied: false, handedOff: true },
    ],
    questions: [q("qa", "b1", 1), q("qb", "b2", 2), q("qc", "b2", 3), q("qw", null, 4, "waiting one"), q("qd", "b3", 5), q("qe", "b0", 6)],
    // A row for qb under another card must not answer it on this card.
    decisions: [{ approvalId: C1, itemId: "Q-qb", answer: "wrong card", source: "kk" }],
    stopped: [
      { approvalId: C1, id: "t1", title: "Build search" },
      { approvalId: C1, id: "t2", title: "Index the catalogue" },
      { approvalId: C2, id: "t9", title: "pending card's task" },
      { approvalId: "44444444-4444-4444-8444-444444444444", id: "t3", title: "Expired card's task" },
    ],
    waitingCount: 250,
    truncated: true,
  }));
  const [b3, b2, b1, b0] = v.batches;
  assert.deepEqual(b1.stoppedTasks, [{ id: "t1", title: "Build search" }, { id: "t2", title: "Index the catalogue" }]);
  assert.deepEqual(b1.questions.map((x) => [x.ref, x.answer]), [["BQ-1", null]], "a rejected card records no answers");
  assert.deepEqual(b3.stoppedTasks, [{ id: "t3", title: "Expired card's task" }]);
  assert.deepEqual(b2.stoppedTasks, [], "before a decision nothing is listed as stopped");
  assert.deepEqual(b2.questions.map((x) => [x.ref, x.answer]), [["BQ-1", null], ["BQ-2", null]]);
  assert.deepEqual(b0.questions.map((x) => x.ref), ["BQ-1"]);
  assert.equal(b0.handedOff, true);
  assert.deepEqual(v.waiting.map((w) => w.text), ["waiting one"]);
  assert.equal(v.waitingCount, 250, "the real count, not the listed rows");
  assert.equal(v.truncated, true);
});

test("CR-b2c: an unknown slug is null; a project with no batches is empty", async () => {
  assert.equal(await batchesView("nope", reader({ batches: [], questions: [], decisions: [], stopped: [], waitingCount: 0, truncated: false })), null);
  assert.deepEqual(await batchesView("shop", reader({ batches: [], questions: [], decisions: [], stopped: [], waitingCount: 0, truncated: false })), { waiting: [], waitingCount: 0, batches: [], truncated: false });
});

test("CR-b2c store: one REPEATABLE READ transaction with a statement timeout; every read is bounded and scoped", async () => {
  const calls = [];
  let opts;
  const tx = {
    $queryRaw: async (strings, ...v) => { calls.push({ sql: strings.join("?"), v }); return []; },
    $queryRawUnsafe: async (sql, ...v) => {
      calls.push({ sql, v });
      if (sql.includes("FROM card_batch")) {
        return [
          { id: "b1", ist_day: "2026-11-14", state: "raised", card_id: C1, card_status: "rejected", applied: false, handed_off: false },
          { id: "b2", ist_day: "2026-11-15", state: "raising", card_id: null, card_status: null, applied: false, handed_off: false },
        ];
      }
      if (sql.includes("count(*)")) return [{ n: 7 }];
      if (sql.includes("FROM task_blocker")) return [{ approval_id: C1, id: "t1", title: "Build search" }];
      if (sql.includes("batch_id = ANY")) return [{ id: "qa", batch_id: "b1", text: "Q", source: "builder", default_answer: "no", queued_at: new Date("2026-11-14T03:00:00Z") }];
      return [];
    },
  };
  const db = { $transaction: async (fn, o) => { opts = o; return fn(tx); } };
  const snap = await new PrismaBatchViewStore(db, 5000).batchSnapshot(P);
  assert.deepEqual(opts, { timeout: 5000, maxWait: 5000, isolationLevel: "RepeatableRead" });
  assert.match(calls[0].sql, /statement_timeout/);
  assert.deepEqual(calls[0].v, ["5000"]);
  for (const c of calls.slice(1)) assert.match(c.sql, /LIMIT \$\d/, "every read is bounded");
  const batchRead = calls.find((c) => c.sql.includes("FROM card_batch"));
  assert.deepEqual(batchRead.v, [P, BATCH_VIEW_DAYS]);
  const taskRead = calls.find((c) => c.sql.includes("FROM task_blocker"));
  assert.deepEqual(taskRead.v.slice(0, 2), [[C1], P], "stopped tasks: only rejected/expired cards, and only this project's tasks");
  assert.match(taskRead.sql, /t\.status = 'blocked'/);
  const decisionRead = calls.find((c) => c.sql.includes("FROM project_decision"));
  assert.deepEqual(decisionRead.v[0], [C1], "answers are read only for raised cards");
  // PR144-r1: answers only for the listed members, so the bound cannot drop a displayed question's recorded answer.
  assert.deepEqual(decisionRead.v[1], ["Q-qa"], "answers are read only for the listed questions");
  assert.match(decisionRead.sql, /item_id = ANY\(\$2::text\[\]\)/);
  assert.equal(snap.questions[0].queuedAt, "2026-11-14T03:00:00.000Z");
  assert.deepEqual(snap.stopped, [{ approvalId: C1, id: "t1", title: "Build search" }]);
  assert.equal(snap.batches[1].cardId, null);
  assert.equal(snap.waitingCount, 7);
  assert.equal(snap.truncated, false);
  assert.match(calls.find((c) => c.sql.includes("batch_id = ANY")).sql, /ORDER BY b\.ist_day DESC/, "a cut drops the oldest batches' questions first");
});

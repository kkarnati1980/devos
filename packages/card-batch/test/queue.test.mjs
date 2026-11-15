// CR-b2a (DEVOS-214, docs/modules/ADR-0012.md): AT7, AT8 (memory), AT10 and the core half of AT11, plus input checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CardBatchQueue, MemoryQueueStore, QueueError, batchReason } from "../dist/index.js";

const P = "11111111-1111-4111-8111-111111111111";
const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const T2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const T3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
// 10:00 IST on 14 Nov 2026, and the next IST day.
const DAY1 = new Date("2026-11-14T04:30:00Z");
const DAY1_LATE = new Date("2026-11-14T18:00:00Z"); // 23:30 IST, still 14 Nov
const DAY2 = new Date("2026-11-14T18:31:00Z"); // 00:01 IST, 15 Nov

/** A fake M2.3: raised cards with their blockers, a failure switch and a hook that runs inside raiseCard. */
function fakeCards() {
  const cards = [];
  const f = {
    cards,
    fail: false,
    during: null,
    async raiseCard(input, blocks) {
      if (f.during) await f.during();
      if (f.fail) throw new Error("db down");
      const c = { id: randomUUID(), status: "pending", ...input, blocks: [...blocks], comments: [] };
      cards.push(c);
      return { id: c.id };
    },
    async findByTarget(projectId, target) {
      const c = [...cards].reverse().find((x) => x.projectId === projectId && x.target === target);
      return c ? { id: c.id } : null;
    },
    async get(id) {
      const c = cards.find((x) => x.id === id);
      // A decided M2.3 card always has decidedAt; tests that do not set one get a far-future time.
      return c ? { id: c.id, status: c.status, decidedAt: c.decidedAt !== undefined ? c.decidedAt : c.status === "pending" ? null : new Date("2100-01-01T00:00:00Z") } : null;
    },
    async comments(id) {
      return cards.find((x) => x.id === id).comments.map((c) => (typeof c === "string" ? { body: c, createdAt: new Date(0) } : c));
    },
  };
  return f;
}

function wire() {
  const store = new MemoryQueueStore();
  store.addProject(P, "Shop");
  const cards = fakeCards();
  return { store, cards, q: new CardBatchQueue(store, cards, randomUUID) };
}
const ask = (text, dflt = "blue", blocks = []) => ({ gate: "decision", text, default: dflt, blocks });

test("AT7: three questions queued on one IST day give exactly one card; a second flush that day raises nothing", async () => {
  const { store, cards, q } = wire();
  await q.queueQuestion(P, ask("Which colour for the header?", "blue", [T1]), DAY1);
  await q.queueQuestion(P, ask("Should the footer be sticky?", "no", [T2]), new Date(DAY1.getTime() + 1000));
  await q.queueQuestion(P, ask("Round or square avatars?", "round"), new Date(DAY1.getTime() + 2000));
  const r = await q.flushBatch(P, DAY1_LATE);
  assert.equal(r.outcome, "raised");
  assert.equal(cards.cards.length, 1);
  const c = cards.cards[0];
  assert.equal(c.gate, "decision");
  assert.equal(c.action, "Answer the build questions for Shop");
  assert.equal(c.target, `batch:${r.batchId}`);
  assert.equal(c.reason, batchReason(await store.members(r.batchId)));
  assert.ok(c.reason.startsWith("3 questions\nBQ-1: Which colour for the header? (default: blue)\n"));
  assert.deepEqual(c.blocks.sort(), [T1, T2].sort());
  assert.deepEqual(await q.flushBatch(P, DAY1_LATE), { outcome: "none" });
  assert.equal(cards.cards.length, 1);
  assert.equal((await store.batch(r.batchId)).state, "raised");
  // Rule 7: each queued question recorded its default as provisional, before any flush.
  assert.deepEqual(store.decisions.map((d) => [d.source, d.answer, d.approvalId]), [["default-provisional", "blue", null], ["default-provisional", "no", null], ["default-provisional", "round", null]]);
});

test("AT8: a question queued after the day's flush waits for the next day; concurrent flushes raise one card", async () => {
  for (const decided of [false, true]) {
    const { store, cards, q } = wire();
    await q.queueQuestion(P, ask("Which colour?", "blue", [T1]), DAY1);
    const first = await q.flushBatch(P, DAY1);
    if (decided) cards.cards[0].status = "approved";
    const late = await q.queueQuestion(P, ask("Sticky footer?", "no", [T2]), DAY1_LATE);
    await q.queueQuestion(P, ask("Avatars round?", "yes", [T3]), new Date(DAY1_LATE.getTime() + 1000));
    assert.deepEqual(await q.flushBatch(P, DAY1_LATE), { outcome: "none" }, `decided=${decided}`);
    assert.equal(cards.cards.length, 1);
    assert.equal(store.questions.find((x) => x.id === late.id).batchId, null);
    assert.deepEqual(cards.cards[0].blocks, [T1], "later tasks are not attached to the first card");
    const next = await q.flushBatch(P, DAY2);
    assert.equal(next.outcome, "raised");
    assert.notEqual(next.batchId, first.batchId);
    assert.equal(cards.cards.length, 2);
    assert.ok(cards.cards[1].reason.startsWith("2 questions\nBQ-1: Sticky footer?"));
    assert.deepEqual(cards.cards[1].blocks.sort(), [T2, T3].sort());
  }
  // Two concurrent flushes for one project and day: one card (the second finds the lock held, or the row raised).
  const { cards, q } = wire();
  await q.queueQuestion(P, ask("Which colour?"), DAY1);
  let second;
  cards.during = async () => {
    cards.during = null;
    second = await q.flushBatch(P, DAY1);
  };
  const first = await q.flushBatch(P, DAY1);
  assert.equal(first.outcome, "raised");
  assert.equal(second.outcome, "busy");
  assert.equal(second.batchId, first.batchId);
  assert.equal(cards.cards.length, 1);
  const [a, b] = await Promise.all([q.flushBatch(P, DAY1), q.flushBatch(P, DAY1)]);
  assert.deepEqual([a, b], [{ outcome: "none" }, { outcome: "none" }]);
  assert.equal(cards.cards.length, 1);
});

test("AT10: a raiseCard failure keeps the batch raising with its members; the retry raises the same card, or records an existing one", async () => {
  const { store, cards, q } = wire();
  await q.queueQuestion(P, ask("Which colour?", "blue", [T1]), DAY1);
  cards.fail = true;
  await assert.rejects(q.flushBatch(P, DAY1), /db down/);
  const [b] = [...store.batches.values()];
  assert.equal(b.state, "raising");
  assert.equal((await store.members(b.id)).length, 1);
  cards.fail = false;
  const late = await q.queueQuestion(P, ask("Sticky footer?", "no", [T2]), DAY1_LATE);
  const r = await q.flushBatch(P, DAY2);
  assert.deepEqual([r.outcome, r.batchId], ["raised", b.id]);
  assert.equal(cards.cards.length, 1);
  assert.equal(cards.cards[0].target, `batch:${b.id}`);
  assert.equal(cards.cards[0].action, "Answer the build questions for Shop");
  assert.ok(cards.cards[0].reason.startsWith("1 question\nBQ-1: Which colour?"));
  assert.deepEqual(cards.cards[0].blocks, [T1]);
  assert.equal(store.questions.find((x) => x.id === late.id).batchId, null, "the new question is not in the retried batch");
  // The day-2 batch already exists (the retried one is not day 2's), so day 2 can still claim its own batch later.
  assert.equal((await q.flushBatch(P, DAY2)).outcome, "raised");
  assert.equal(cards.cards.length, 2);

  // A card created before the failure (raise succeeded, record failed), pending or decided, is recorded, not raised again.
  for (const status of ["pending", "approved", "rejected"]) {
    const w = wire();
    await w.q.queueQuestion(P, ask("Which colour?", "blue", [T1]), DAY1);
    const markRaised = w.store.markRaised.bind(w.store);
    w.store.markRaised = async () => {
      throw new Error("connection dropped");
    };
    await assert.rejects(w.q.flushBatch(P, DAY1), /connection dropped/);
    w.cards.cards[0].status = status;
    w.store.markRaised = markRaised;
    const again = await w.q.flushBatch(P, DAY2);
    assert.equal(again.outcome, "recorded", status);
    assert.equal(again.cardId, w.cards.cards[0].id);
    assert.equal(w.cards.cards.length, 1, status);
    assert.equal((await w.store.batch(again.batchId)).state, "raised");
  }
});

test("AT11 (core): approval records BQ answers as kk and the rest as default; rejection records nothing and lists the stopped tasks", async () => {
  const { store, cards, q } = wire();
  const q1 = await q.queueQuestion(P, ask("Dark header?", "yes", [T1]), DAY1);
  await q.queueQuestion(P, ask("Sticky footer?", "no", [T2]), new Date(DAY1.getTime() + 1));
  const before = store.decisions.length;
  const r = await q.flushBatch(P, DAY1);
  assert.equal((await q.applyBatch(r.batchId, DAY1)).outcome, "not-ready", "pending card");
  cards.cards[0].status = "approved";
  cards.cards[0].comments.push("Thanks.\nBQ-1: no");
  const applied = await q.applyBatch(r.batchId, DAY1_LATE);
  assert.equal(applied.outcome, "approved");
  const final = store.decisions.slice(before);
  assert.deepEqual(final.map((d) => [d.itemId, d.source, d.answer, d.approvalId]), [[`Q-${q1.id}`, "kk", "no", cards.cards[0].id], [final[1].itemId, "default", "no", cards.cards[0].id]]);
  assert.deepEqual(applied.followUps, [{ questionId: q1.id, answer: "no", blocks: [T1] }]);
  assert.equal(applied.first, true);
  // Pre-review finding 2: a second apply is not first and returns the same follow-ups (the caller files per question id).
  const again = await q.applyBatch(r.batchId, DAY2);
  assert.deepEqual([again.outcome, again.first, again.followUps], ["approved", false, applied.followUps]);
  assert.equal(store.decisions.length, before + 2);

  const w = wire();
  await w.q.queueQuestion(P, ask("Dark header?", "yes", [T1, T2]), DAY1);
  const rr = await w.q.flushBatch(P, DAY1);
  const n = w.store.decisions.length;
  w.cards.cards[0].status = "rejected";
  const rej = await w.q.applyBatch(rr.batchId, DAY1);
  assert.equal(rej.outcome, "rejected");
  assert.deepEqual(rej.stopped.sort(), [T1, T2].sort());
  assert.equal(w.store.decisions.length, n);
  assert.equal(w.cards.cards.length, 1, "a rejection raises no new card");
  assert.equal((await w.q.flushBatch(P, DAY2)).outcome, "none");
});

test("queueQuestion refuses non-batchable and malformed input, and unknown projects", async () => {
  const { store, q } = wire();
  for (const [input, code] of [
    [{ gate: "purge", text: "Which colour?", default: "blue" }, "not-batchable"],
    [ask("Is ₹500 fine?"), "not-batchable"],
    [ask("Which colour?", "delete them"), "not-batchable"],
    [ask("x".repeat(1001)), "invalid-input"],
    [ask("Which\ncolour?"), "invalid-input"],
    [ask("Which colour?", ""), "invalid-input"],
    [ask("Which colour?", "y".repeat(201)), "invalid-input"],
    [ask("Which colour?", "blue", ["not-a-uuid"]), "invalid-input"],
    [{ ...ask("Which colour?"), blocks: "x" }, "invalid-input"],
    [ask("Which colour?", "blue", Array.from({ length: 51 }, () => randomUUID())), "invalid-input"],
  ]) {
    await assert.rejects(q.queueQuestion(P, input, DAY1), (e) => e instanceof QueueError && e.code === code, JSON.stringify(input).slice(0, 60));
  }
  await assert.rejects(q.queueQuestion("nope", ask("Which colour?"), DAY1), (e) => e.code === "invalid-input");
  await assert.rejects(q.queueQuestion(randomUUID(), ask("Which colour?"), DAY1), (e) => e.code === "project-not-found");
  await assert.rejects(q.queueQuestion(P, ask("Which colour?"), new Date(Number.NaN)), (e) => e.code === "invalid-input");
  assert.equal(store.questions.length, 0);
  assert.equal(store.decisions.length, 0);
  const ok = await q.queueQuestion(P, ask("  Which colour?  ", "blue", [T1, T1]), DAY1);
  assert.deepEqual([ok.text, ok.blocks, ok.source, ok.batchId], ["Which colour?", [T1], "runner", null]);
});

test("pre-review findings 1, 2, 4: refusals park the batch, applies have one winner, late comments do not count", async () => {
  // 1a: a refusal no retry can change parks the batch as refused with its members; the next day batches again.
  const { store, cards, q } = wire();
  await q.queueQuestion(P, ask("Which colour?", "blue", [T1]), DAY1);
  const raiseCard = cards.raiseCard;
  cards.raiseCard = async () => {
    throw Object.assign(new Error("task-not-found"), { code: "task-not-found" });
  };
  const r = await q.flushBatch(P, DAY1);
  assert.deepEqual([r.outcome, r.code, r.members.map((m) => m.text)], ["refused", "task-not-found", ["Which colour?"]]);
  assert.equal((await store.batch(r.batchId)).state, "refused");
  cards.raiseCard = raiseCard;
  const late = await q.queueQuestion(P, ask("Sticky footer?", "no", [T2]), DAY1_LATE);
  // Pre-review r2 finding 1: until the caller confirms the hand-off, every flush returns the refused members again
  // (a crash after the refusal loses nothing), and nothing new is claimed.
  const again = await q.flushBatch(P, DAY2);
  assert.deepEqual([again.outcome, again.batchId, again.members.map((m) => m.text)], ["refused", r.batchId, ["Which colour?"]]);
  assert.equal(cards.cards.length, 0);
  await q.handOff(r.batchId, DAY1_LATE);
  assert.deepEqual(await q.flushBatch(P, DAY1_LATE), { outcome: "none" }, "day 1 already has its batch");
  const next = await q.flushBatch(P, DAY2);
  assert.equal(next.outcome, "raised");
  assert.equal(cards.cards.length, 1);
  assert.deepEqual((await store.members(next.batchId)).map((m) => m.id), [late.id], "the refused member never joins another batch");
  // 1b: the check port refuses at queue time; a `*` in the project name never reaches the action.
  const w = wire();
  w.cards.check = async ({ reason, blocks }) => (blocks.includes(T3) || reason.includes("sk-") ? "task-not-found" : null);
  await assert.rejects(w.q.queueQuestion(P, ask("Which colour?", "blue", [T3]), DAY1), (e) => e.code === "not-batchable" && e.hit === "card");
  assert.equal(w.store.questions.length, 0);
  w.store.addProject(P, "Shop*");
  await w.q.queueQuestion(P, ask("Which colour?", "blue", [T1]), DAY1);
  await w.q.flushBatch(P, DAY1);
  assert.equal(w.cards.cards[0].action, "Answer the build questions for Shop");
  // 2: two concurrent applies: exactly one is first; 4: a BQ line after the decision does not count.
  const x = wire();
  await x.q.queueQuestion(P, ask("Dark header?", "yes", [T1]), DAY1);
  const xb = await x.q.flushBatch(P, DAY1);
  Object.assign(x.cards.cards[0], { status: "approved", decidedAt: new Date(DAY1.getTime() + 60_000) });
  x.cards.cards[0].comments.push({ body: "BQ-1: no", createdAt: new Date(DAY1.getTime() + 30_000) }, { body: "BQ-1: maybe", createdAt: new Date(DAY1.getTime() + 90_000) });
  const [a, b] = await Promise.all([x.q.applyBatch(xb.batchId, DAY1_LATE), x.q.applyBatch(xb.batchId, DAY1_LATE)]);
  assert.deepEqual([a.first, b.first].sort(), [false, true]);
  assert.deepEqual(a.followUps, b.followUps);
  const final = x.store.decisions.filter((d) => d.approvalId !== null);
  assert.deepEqual(final.map((d) => [d.source, d.answer]), [["kk", "no"]]);
});

test("pre-review r2 findings 2 and 4: an expired card stops its tasks like a rejection; a retried queue call is safe", async () => {
  const { store, cards, q } = wire();
  const id = randomUUID();
  const one = await q.queueQuestion(P, { ...ask("Dark header?", "yes", [T1]), id }, DAY1);
  const two = await q.queueQuestion(P, { ...ask("Dark header?", "yes", [T1]), id }, new Date(DAY1.getTime() + 5000));
  assert.deepEqual(two, one);
  assert.equal(store.questions.length, 1);
  assert.equal(store.decisions.length, 1);
  await assert.rejects(q.queueQuestion(P, { ...ask("Dark header?"), id: "x" }, DAY1), (e) => e.code === "invalid-input");
  const r = await q.flushBatch(P, DAY1);
  cards.cards[0].status = "expired";
  const out = await q.applyBatch(r.batchId, DAY1_LATE);
  assert.deepEqual([out.outcome, out.first, out.stopped], ["rejected", true, [T1]]);
  assert.equal(store.decisions.length, 1);
  assert.ok((await store.batch(r.batchId)).appliedAt);
});

test("Codex PR135-r1: an applied batch stays listed until settled, with the same follow-ups; question ids are scoped to the project", async () => {
  const { store, cards, q } = wire();
  const Q1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  await q.queueQuestion(P, { ...ask("Which colour for the header?", "blue", [T1]), id: Q1 }, DAY1);
  const r = await q.flushBatch(P, DAY1_LATE);
  const card = cards.cards.find((c) => c.id === r.cardId);
  card.status = "approved";
  card.comments.push("BQ-1: green");
  // Finding 1: apply commits, then the caller crashes before filing its follow-up.
  const a1 = await q.applyBatch(r.batchId, DAY2);
  assert.equal(a1.first, true);
  assert.deepEqual(a1.followUps.map((f) => f.questionId), [Q1]);
  const b1 = await store.batch(r.batchId);
  assert.ok(b1.appliedAt);
  assert.equal(b1.settledAt, null, "not settled: the sync job still lists it");
  // The next tick rediscovers it and gets the same follow-up; nothing is written twice.
  const decisionsBefore = store.decisions.length;
  const a2 = await q.applyBatch(r.batchId, DAY2);
  assert.equal(a2.outcome, "approved");
  assert.equal(a2.first, false);
  assert.deepEqual(a2.followUps, a1.followUps);
  assert.equal(store.decisions.length, decisionsBefore);
  await q.settle(r.batchId, DAY2);
  assert.ok((await store.batch(r.batchId)).settledAt);
  const a3 = await q.applyBatch(r.batchId, DAY2);
  assert.equal(a3.outcome, "settled");
  assert.deepEqual(a3.followUps, []);
  // settle on a batch that was never applied does nothing.
  const P2 = "22222222-2222-4222-8222-222222222222";
  store.addProject(P2, "Blog");
  await q.queueQuestion(P2, ask("Serif or sans?", "sans"), DAY1);
  const r2 = await q.flushBatch(P2, DAY1_LATE);
  await q.settle(r2.batchId, DAY2);
  assert.equal((await store.batch(r2.batchId)).settledAt, null);
  // Finding 2: project P2 reusing P's question id is refused; nothing of P's question comes back and nothing is written.
  const qBefore = store.questions.length;
  const dBefore = store.decisions.length;
  await assert.rejects(
    q.queueQuestion(P2, { ...ask("Tabs or spaces?", "spaces"), id: Q1 }, DAY2),
    (e) => e instanceof QueueError && e.code === "id-conflict" && !String(e.message).includes("colour"),
  );
  assert.equal(store.questions.length, qBefore);
  assert.equal(store.decisions.length, dBefore);
  // The same project retrying its own id still gets its stored question back.
  const again = await q.queueQuestion(P, { ...ask("Which colour for the header?", "blue", [T1]), id: Q1 }, DAY2);
  assert.equal(again.id, Q1);
  assert.equal(again.projectId, P);
});

test("Codex PR135-r2: an approved card without decidedAt is not applied; a comment without createdAt never counts", async () => {
  const { store, cards, q } = wire();
  await q.queueQuestion(P, ask("Which colour for the header?", "blue", [T1]), DAY1);
  const r = await q.flushBatch(P, DAY1_LATE);
  const card = cards.cards.find((c) => c.id === r.cardId);
  Object.assign(card, { status: "approved", decidedAt: null });
  assert.equal((await q.applyBatch(r.batchId, DAY2)).outcome, "not-ready", "fail closed: no decision time");
  assert.equal((await store.batch(r.batchId)).appliedAt, null);
  card.decidedAt = new Date(DAY1_LATE.getTime() + 60_000);
  card.comments.push({ body: "BQ-1: green" }, { body: "BQ-1: red", createdAt: new Date("invalid") });
  const a1 = await q.applyBatch(r.batchId, DAY2);
  assert.deepEqual([a1.outcome, a1.followUps], ["approved", []], "untimed comments are ignored");
  // A later timed comment is ignored too, so a replay before settle returns the same follow-ups.
  card.comments.push({ body: "BQ-1: green", createdAt: new Date(DAY2.getTime() + 60_000) });
  const a2 = await q.applyBatch(r.batchId, DAY2);
  assert.deepEqual([a2.first, a2.followUps], [false, a1.followUps]);
  assert.deepEqual(store.decisions.filter((d) => d.approvalId === card.id).map((d) => [d.source, d.answer]), [["default", "blue"]]);
});

test("Codex PR135-r3: a replay returns the follow-ups of the stored rows, even when a late comment becomes visible", async () => {
  const { store, cards, q } = wire();
  const q1 = await q.queueQuestion(P, ask("Which colour for the header?", "blue", [T1]), DAY1);
  const r = await q.flushBatch(P, DAY1_LATE);
  const card = cards.cards.find((c) => c.id === r.cardId);
  Object.assign(card, { status: "approved", decidedAt: new Date(DAY1_LATE.getTime() + 60_000) });
  const a1 = await q.applyBatch(r.batchId, DAY2);
  assert.deepEqual([a1.first, a1.followUps], [true, []]);
  // A comment timestamped before the decision commits only now (M2.3 sets createdAt before its transaction).
  card.comments.push({ body: "BQ-1: green", createdAt: new Date(DAY1_LATE.getTime() + 30_000) });
  const a2 = await q.applyBatch(r.batchId, DAY2);
  assert.deepEqual([a2.first, a2.followUps], [false, []], "the replay follows the stored default row");
  // And the reverse: the stored kk row drives the follow-up on every replay.
  const w = wire();
  const qq = await w.q.queueQuestion(P, ask("Should the footer be sticky?", "no", [T2]), DAY1);
  const rr = await w.q.flushBatch(P, DAY1_LATE);
  const c2 = w.cards.cards.find((c) => c.id === rr.cardId);
  Object.assign(c2, { status: "approved", decidedAt: new Date(DAY1_LATE.getTime() + 60_000) });
  c2.comments.push({ body: "BQ-1: yes", createdAt: new Date(DAY1_LATE.getTime() + 1000) });
  const b1 = await w.q.applyBatch(rr.batchId, DAY2);
  c2.comments.length = 0; // whatever the comments read later, the replay is the same
  const b2 = await w.q.applyBatch(rr.batchId, DAY2);
  assert.deepEqual(b1.followUps, [{ questionId: qq.id, answer: "yes", blocks: [T2] }]);
  assert.deepEqual(b2.followUps, b1.followUps);
  assert.ok(q1.id);
});

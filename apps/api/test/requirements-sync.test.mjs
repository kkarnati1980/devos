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
        if (d && d.status === "draft" && d.approvalId && approvalStore.cards.get(d.approvalId)?.status === "approved") out.push(p);
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

  // Both approved now; P1's sync throws, P2's must still run.
  approvalStore.cards.get(r1.approvalId).status = "approved";
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
  assert.equal((await svc.store.latestDoc(P1)).status, "draft", "the failed project is left for the next tick");
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

test("AT-Q2 an expired earlier card does not stop the question", async () => {
  const { svc, approvalStore } = wire();
  const v1 = await svc.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  for (const { cardId } of v1.questionCards.raised) approvalStore.cards.get(cardId).status = "expired";
  const v2 = await svc.pipeline.submitSpec(P1, { kind: "paste", text: `${SPEC}\n- FR-9: Reviews\n  - Reviews show\n` });
  const old = new Set(v1.questionCards.raised.map((x) => x.cardId));
  assert.ok(v2.questionCards.raised.length >= 1 && v2.questionCards.raised.every((x) => !old.has(x.cardId)), "asked again after expiry");
});

test("AT-Q2 an approved or rejected card of another project does not stop the question (same action and target)", async () => {
  for (const decided of ["approved", "rejected"]) {
    const { svc, approvalStore } = wire();
    const v1 = await svc.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
    for (const { cardId } of v1.questionCards.raised) approvalStore.cards.get(cardId).status = decided;
    const p1Cards = v1.questionCards.raised.map((x) => approvalStore.cards.get(x.cardId));
    const before = [...approvalStore.cards.values()].filter((c) => c.gate === "decision").length;
    const p2 = await svc.pipeline.submitSpec(P2, { kind: "paste", text: SPEC });
    const old = new Set(p1Cards.map((c) => c.id));
    assert.ok(p2.questionCards.raised.length >= 1 && p2.questionCards.raised.every((x) => !old.has(x.cardId)), `${decided}: P2 gets its own cards`);
    // the twin really shares action and target, so only the project filter keeps them apart
    const p2Cards = p2.questionCards.raised.map((x) => approvalStore.cards.get(x.cardId));
    assert.ok(p2Cards.some((c) => p1Cards.some((o) => o.action === c.action && o.target === c.target)), "same dedupe key across projects");
    assert.equal([...approvalStore.cards.values()].filter((c) => c.gate === "decision").length, before + p2.questionCards.raised.length);
  }
});

test("AT-Q2 a failed decided-card lookup still raises the question", async () => {
  let raised = 0;
  const port = skipDecidedQuestions(async () => ({ id: `new-${++raised}` }), { list: async () => { throw new Error("db timeout"); } });
  assert.deepEqual(await port({ card: { gate: "decision", action: "a", target: "t", projectId: P1, reason: "r" } }, "r"), { id: "new-1" });
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

test("AT-Q3 (DEVOS-166) one decided-card scan per submission, not one per question; the next submission scans afresh", async () => {
  const { store, approvalStore } = wire();
  const approvals = new Approvals({ store: approvalStore, grants: { issueGrant: async () => ({ id: "g" }) }, notifier: null, verifyKkSession: () => false });
  const decidedReads = [];
  const list = approvalStore.list.bind(approvalStore);
  const spied = Object.create(approvalStore);
  spied.list = async (f) => {
    if (f.status === "approved" || f.status === "rejected") decidedReads.push(f.status);
    return list(f);
  };
  const svc = requirementsServices(store, approvals, spied);
  const two = `${SPEC}- Which payment provider do we use?\n`;
  const v1 = await svc.pipeline.submitSpec(P1, { kind: "paste", text: two });
  assert.ok(v1.questionCards.raised.length >= 2, `needs two or more questions, got ${v1.questionCards.raised.length}`);
  // One scan: one read per status (each page is short), however many questions were raised.
  assert.deepEqual(decidedReads, ["approved", "rejected"]);
  // A card KK decides between submissions is seen by the next one, which scans again.
  const [first] = v1.questionCards.raised;
  approvalStore.cards.get(first.cardId).status = "approved";
  decidedReads.length = 0;
  const v2 = await svc.pipeline.submitSpec(P1, { kind: "paste", text: `${two}\n- FR-9: Reviews\n  - Reviews show\n` });
  assert.deepEqual(decidedReads, ["approved", "rejected"]);
  assert.ok(v2.questionCards.raised.some((x) => x.cardId === first.cardId), "the decided card is reused, not asked again");
});

test("AT-Q3 (DEVOS-166) outside a submission each question still scans; a failed shared scan raises every question", async () => {
  let reads = 0;
  const lister = { list: async () => { reads++; return []; } };
  const port = skipDecidedQuestions(async () => ({ id: "new" }), lister);
  const q = (t) => ({ card: { gate: "decision", action: "a", target: t, projectId: P1, reason: "r" } });
  await port(q("t1"), "r");
  await port(q("t2"), "r");
  assert.equal(reads, 4, "two scans of two statuses without a submission scope");

  const { withDecidedScan } = await import("../dist/requirements-sync.js");
  let fails = 0, raised = 0;
  const failing = skipDecidedQuestions(async () => ({ id: `new-${++raised}` }), { list: async () => { fails++; throw new Error("db timeout"); } });
  await withDecidedScan(async () => {
    assert.deepEqual(await failing(q("t1"), "r"), { id: "new-1" });
    assert.deepEqual(await failing(q("t2"), "r"), { id: "new-2" });
  });
  assert.equal(fails, 1, "the failed scan is shared, not retried per question");
});

test("AT-Q3 (DEVOS-166) concurrent submissions each make their own scan", async () => {
  const { withDecidedScan } = await import("../dist/requirements-sync.js");
  const reads = [];
  const lister = { list: async (f) => { reads.push(f.projectId); await new Promise((r) => setTimeout(r, 5)); return []; } };
  const port = skipDecidedQuestions(async () => ({ id: "new" }), lister);
  const q = (p, t) => ({ card: { gate: "decision", action: "a", target: t, projectId: p, reason: "r" } });
  const submission = (p) => withDecidedScan(async () => { await port(q(p, "t1"), "r"); await port(q(p, "t2"), "r"); });
  await Promise.all([submission(P1), submission(P1), submission(P2)]);
  // Three submissions, one scan each (two statuses per scan), even two at once for the same project.
  assert.equal(reads.filter((p) => p === P1).length, 4);
  assert.equal(reads.filter((p) => p === P2).length, 2);
});

test("DEVOS-204: approval counts only comments up to the decision; a later `PF-1: no` is a re-answer on the next tick", async () => {
  const store = new MemoryRequirementsStore();
  store.addProject({ id: P1, name: "Shop", stage: "intake", continuousRun: true, capUsd: 15 });
  const approvalStore = new MemoryApprovalStore();
  const approvals = new Approvals({ store: approvalStore, grants: { issueGrant: async () => ({ id: "g" }) }, notifier: null, verifyKkSession: () => false });
  const svc = requirementsServices(store, approvals, approvalStore);
  const r = await svc.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  assert.ok(r.preflight?.length, "continuous-run spec has a pre-flight");
  const decidedAt = new Date(Date.now() - 600_000);
  const card = approvalStore.cards.get(r.approvalId);
  card.status = "approved";
  card.decidedAt = decidedAt;
  await approvalStore.comment(r.approvalId, "kk", "PF-1: yes", new Date(decidedAt.getTime() - 1000));
  // Posted after the decision but before the approval sync ran: it must not count as the approval's answer.
  await approvalStore.comment(r.approvalId, "kk", "PF-1: no", new Date(decidedAt.getTime() + 60_000));
  let reanswerCalls = 0;
  const lister = {
    async draftsAwaitingDecision() {
      const d = await store.latestDoc(P1);
      return d.status === "draft" ? [P1] : [];
    },
    async reanswersAwaiting() {
      reanswerCalls++;
      const d = await store.latestDoc(P1);
      return d.status === "approved" ? [P1] : [];
    },
  };
  const job = new RequirementsSyncJob(svc, lister, () => {}, 60_000);
  assert.equal(await job.tick(), 1);
  const items = r.preflight.filter((i) => i.kind === "decision");
  const pf1 = () => store.decisions.filter((d) => d.itemId === "PF-1");
  // The first tick approves with `yes` (only comments up to the decision count, though `no` already exists).
  assert.equal(store.decisions.filter((d) => d.approvalId === r.approvalId).length, items.length);
  assert.deepEqual(pf1().map((d) => [d.answer, d.source]), [["yes", "kk"]]);
  // The next tick reads the later comment as a re-answer: one new kk row; the state stays approved.
  assert.equal(await job.tick(), 1);
  assert.deepEqual(pf1().map((d) => [d.answer, d.source, d.approvalId === r.approvalId]), [["yes", "kk", true], ["no", "kk", false]]);
  assert.equal(store.decisions.length, items.length + 1);
  assert.equal(store.preflightState.get(P1), "approved");
  // Another tick adds nothing; a new comment changing PF-2 adds one row for PF-2 only.
  assert.equal(await job.tick(), 1);
  assert.equal(store.decisions.length, items.length + 1);
  await approvalStore.comment(r.approvalId, "kk", "PF-2: USD 40", new Date());
  assert.equal(await job.tick(), 1);
  assert.equal(store.decisions.length, items.length + 2);
  assert.deepEqual(store.decisions.at(-1).itemId, "PF-2");
  assert.equal(store.decisions.at(-1).answer, "USD 40");
  assert.ok(reanswerCalls >= 3);
  // The cursor stays REANSWER_SETTLE_MS behind now, so the newest comment is read again on later ticks (no-op).
  const docId = (await store.latestDoc(P1)).id;
  assert.ok(store.answersSyncedAt.get(docId).getTime() <= Date.now() - 29_000);
});

test("DEVOS-204: a failing re-answer list is logged and the approvals of the tick still run", async () => {
  const { svc, approvalStore, lister } = wire();
  const r = await svc.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  approvalStore.cards.get(r.approvalId).status = "approved";
  const logs = [];
  const job = new RequirementsSyncJob(svc, { ...lister, reanswersAwaiting: async () => { throw new Error("db down"); } }, (e) => logs.push(e), 60_000);
  assert.equal(await job.tick(), 1);
  assert.equal((await svc.store.latestDoc(P1)).status, "approved");
  assert.deepEqual(logs, [{ level: "warn", msg: "requirements-sync-failed", projectId: "*" }]);
});

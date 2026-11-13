// M2.2-d3c2: expire the superseded version's pending cards and an unlinked requirements card (contract docs/modules/M2.2.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRequirementsStore } from "@devos/analyst";
import { Approvals, MemoryApprovalStore } from "../dist/approvals.js";
import { requirementsServices } from "../dist/runtime.js";
import { expireSuperseded, requirementsCardVersion } from "../dist/requirements-expiry.js";

const P1 = "4b7d1c1e-2f6a-4a8e-9d55-0c1f2a3b4c5d";
const P2 = "5c8e2d2f-3a7b-4b9f-8e66-1d2a3b4c5d6e";
const spec = (questions) => `# Shop

## Phase 1: Launch

- FR-1: Owner login
  - Login works

## Open questions
${questions.map((q) => `- ${q}`).join("\n")}
`;
const BUDGET = "What monthly budget can we spend on hosting?";
const DOMAIN = "Which domain name should the shop use?";
const LOGO = "Who supplies the logo artwork?";

function wire() {
  const store = new MemoryRequirementsStore();
  store.addProject({ id: P1, name: "Shop", stage: "intake" });
  store.addProject({ id: P2, name: "Cafe", stage: "intake" });
  const approvalStore = new MemoryApprovalStore();
  const approvals = new Approvals({ store: approvalStore, grants: { issueGrant: async () => ({ id: "g" }) }, notifier: null, verifyKkSession: () => false });
  const logs = [];
  const svc = requirementsServices(store, approvals, approvalStore, null, (e) => logs.push(e));
  return { store, approvalStore, approvals, svc, logs };
}

const cardsOf = (approvalStore, pred) => [...approvalStore.cards.values()].filter(pred);
const questionByText = (approvalStore, text) => cardsOf(approvalStore, (c) => c.gate === "decision" && c.reason.includes(text));

test("AT-E1 a new version expires the superseded requirements card and the questions it dropped; kept questions stay pending", async () => {
  const { svc, approvalStore } = wire();
  const r1 = await svc.pipeline.submitSpec(P1, { kind: "paste", text: spec([BUDGET, DOMAIN]) });
  assert.deepEqual(r1.expired, { requirements: [], questions: [], skipped: [] });
  const budget1 = questionByText(approvalStore, BUDGET);
  const domain1 = questionByText(approvalStore, DOMAIN);
  assert.equal(budget1.length, 1);
  assert.equal(domain1.length, 1);

  const r2 = await svc.pipeline.submitSpec(P1, { kind: "paste", text: spec([BUDGET, LOGO]) });
  assert.notEqual(r2.approvalId, r1.approvalId);
  assert.equal(approvalStore.cards.get(r1.approvalId).status, "expired", "v1's requirements card");
  assert.equal(approvalStore.cards.get(r2.approvalId).status, "pending", "v2's requirements card");
  assert.equal(domain1[0].status, "expired", "the question v2 dropped");
  assert.equal(budget1[0].status, "pending", "the question both versions ask is reused, not expired");
  assert.ok(r2.questionCards.raised.some((q) => q.cardId === budget1[0].id));
  assert.equal(questionByText(approvalStore, LOGO)[0].status, "pending", "the new question");
  assert.deepEqual(r2.expired.requirements, [r1.approvalId]);
  assert.deepEqual(r2.expired.questions, [domain1[0].id]);
  assert.deepEqual(r2.expired.skipped, []);
});

test("AT-E2 a requirements card the store could not link is expired at once", async () => {
  const { store, svc, approvalStore } = wire();
  store.linkApproval = async () => false;
  const r = await svc.pipeline.submitSpec(P1, { kind: "paste", text: spec([BUDGET]) });
  assert.equal(r.approvalId, null);
  assert.ok(r.warnings.includes("card-link-failed"));
  const req = cardsOf(approvalStore, (c) => c.gate === "requirements");
  assert.equal(req.length, 1);
  assert.equal(req[0].status, "expired");
  assert.deepEqual(r.expired.requirements, [req[0].id]);
  assert.equal(questionByText(approvalStore, BUDGET)[0].status, "pending", "this version's question stays");
});

test("AT-E3 decided cards, other projects, non-analyst decision cards and later-version cards are never expired", async () => {
  const { svc, approvalStore, approvals } = wire();
  const r1 = await svc.pipeline.submitSpec(P1, { kind: "paste", text: spec([BUDGET, DOMAIN]) });
  questionByText(approvalStore, DOMAIN)[0].status = "approved";
  const other = await svc.pipeline.submitSpec(P2, { kind: "paste", text: spec([LOGO]) });
  const foreign = await approvals.raiseCard({ gate: "decision", action: "Pick a hosting region", target: "region", reason: "Architect asks", projectId: P1 });
  const later = await approvals.raiseCard({ gate: "requirements", action: "requirements.approve", target: `project ${P1} docs/requirements.md v9`, reason: "later", projectId: P1 });
  const r2 = await svc.pipeline.submitSpec(P1, { kind: "paste", text: spec([LOGO]) });
  assert.equal(approvalStore.cards.get(r1.approvalId).status, "expired");
  assert.equal(questionByText(approvalStore, DOMAIN)[0].status, "approved", "a decided card is left alone");
  assert.equal(questionByText(approvalStore, BUDGET)[0].status, "expired");
  assert.equal(approvalStore.cards.get(other.approvalId).status, "pending", "another project's requirements card");
  assert.ok(cardsOf(approvalStore, (c) => c.projectId === P2).every((c) => c.status === "pending"), "another project's cards");
  assert.equal(approvalStore.cards.get(foreign.id).status, "pending", "a decision card that is not an analyst question");
  assert.equal(approvalStore.cards.get(later.id).status, "pending", "a requirements card for a later version");
  assert.equal(approvalStore.cards.get(r2.approvalId).status, "pending");
});

test("AT-E4 a failed question raise skips question expiry; a newer saved version skips the pass; a failing pass is logged and the submission succeeds", async () => {
  const { svc, approvalStore, logs } = wire();
  await svc.pipeline.submitSpec(P1, { kind: "paste", text: spec([BUDGET, DOMAIN]) });
  const domain1 = questionByText(approvalStore, DOMAIN)[0];

  // A failed raise in the new version: the older pending question may be the only card for it, so none expire.
  const realRaise = approvalStore.raise.bind(approvalStore);
  approvalStore.raise = async (input, ...rest) => {
    if (input.gate === "decision" && input.reason.includes(LOGO)) throw Object.assign(new Error("db down"), { code: "store-error" });
    return realRaise(input, ...rest);
  };
  const r2 = await svc.pipeline.submitSpec(P1, { kind: "paste", text: spec([LOGO]) });
  approvalStore.raise = realRaise;
  assert.equal(r2.questionCards.failed.length, 1);
  assert.deepEqual(r2.expired.skipped, ["question-raise-failed"]);
  assert.equal(domain1.status, "pending");
  assert.equal(r2.expired.requirements.length, 1, "the superseded requirements card still expires");

  // A newer version saved meanwhile: this pass does nothing (that submission cleans up).
  const r3 = await svc.pipeline.submitSpec(P1, { kind: "paste", text: spec([LOGO]) });
  const deps = { latestDoc: async () => ({ id: "newer", version: r3.docVersion + 1, approvalId: null }), cards: approvalStore, expire: async (ids) => ids };
  const stale = await expireSuperseded(deps, P1, r3, new Date());
  assert.deepEqual(stale.skipped, ["newer-version"]);
  assert.deepEqual(stale.questions, [], "question cards are left to the newest submission");
  assert.deepEqual(stale.requirements, [r3.approvalId], "this version's card is below the newest version, so it expires");

  // The pass throws: the submission still succeeds, `expired` is null and a fixed code is logged.
  approvalStore.list = async () => {
    throw new Error("secret-looking message");
  };
  const r4 = await svc.pipeline.submitSpec(P1, { kind: "paste", text: spec([LOGO]) });
  assert.equal(r4.expired, null);
  assert.ok(r4.docId);
  assert.deepEqual(logs, [{ level: "warn", msg: "requirements-expiry-failed", projectId: P1 }]);
});

test("AT-E5 cards raised after the submission started (a concurrent submission) are left alone, and the version parser is exact", async () => {
  const { svc, approvalStore } = wire();
  const r1 = await svc.pipeline.submitSpec(P1, { kind: "paste", text: spec([DOMAIN]) });
  const domain = questionByText(approvalStore, DOMAIN)[0];
  const deps = { latestDoc: async () => ({ id: r1.docId, version: r1.docVersion, approvalId: r1.approvalId }), cards: approvalStore, expire: async (ids) => ids };
  const empty = { ...r1, questionCards: { raised: [], failed: [] } };
  const before = new Date(domain.createdAt.getTime() - 1);
  assert.deepEqual((await expireSuperseded(deps, P1, empty, before)).questions, [], "created after startedAt");
  assert.deepEqual((await expireSuperseded(deps, P1, empty, domain.createdAt)).questions, [domain.id], "created by then");

  assert.equal(requirementsCardVersion(`project ${P1} docs/requirements.md v12`, P1), 12);
  for (const t of [`project ${P1} docs/requirements.md v0`, `project ${P1} docs/requirements.md v1 `, `project ${P2} docs/requirements.md v1`, `project ${P1} docs/other.md v1`, `project ${P1} docs/requirements.md v1x`]) {
    assert.equal(requirementsCardVersion(t, P1), null, t);
  }
});

test("AT-E6 interleaved submissions: an older submission that raises its cards after a newer one ran still expires its own requirements card; the next submission clears its questions", async () => {
  const { svc, approvalStore } = wire();
  const realRaise = approvalStore.raise.bind(approvalStore);
  let release;
  const gate = new Promise((res) => (release = res));
  let paused = false;
  approvalStore.raise = async (input, ...rest) => {
    // Hold submission A (the first spec) just before it raises its requirements card.
    if (!paused && input.gate === "requirements") {
      paused = true;
      await gate;
    }
    return realRaise(input, ...rest);
  };
  const a = svc.pipeline.submitSpec(P1, { kind: "paste", text: spec([DOMAIN]) });
  while (!paused) await new Promise((res) => setImmediate(res));
  const b = await svc.pipeline.submitSpec(P1, { kind: "paste", text: spec([LOGO]) });
  release();
  const ra = await a;
  assert.equal(ra.docVersion, 1);
  assert.equal(b.docVersion, 2);
  assert.deepEqual(ra.expired.skipped, ["newer-version"]);
  const cardA = cardsOf(approvalStore, (c) => c.gate === "requirements" && c.target.endsWith(" v1"));
  assert.equal(cardA.length, 1);
  assert.equal(cardA[0].status, "expired", "A's late v1 card is expired by A's own pass");
  assert.equal(approvalStore.cards.get(b.approvalId).status, "pending", "B's newest card is untouched");
  const domain = questionByText(approvalStore, DOMAIN)[0];
  assert.equal(domain.status, "pending", "A's late question card is left (created after B started)");
  approvalStore.raise = realRaise;
  const c = await svc.pipeline.submitSpec(P1, { kind: "paste", text: spec([LOGO]) });
  assert.equal(domain.status, "expired", "the next submission's pass clears it");
  assert.ok(c.expired.questions.includes(domain.id));
});

test("AT-E7 (Codex PR88-r1) a newer version cannot save while an older pass checks and expires, so the newest spec keeps a pending card for its questions", async () => {
  const { store, svc, approvalStore } = wire();
  // A store with a project hold, as PrismaRequirementsStore: saveAnalysis waits while the pass holds the project.
  let tail = Promise.resolve();
  const hold = (fn) => {
    const run = tail.then(fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
  const realSave = store.saveAnalysis.bind(store);
  const order = [];
  store.saveAnalysis = (input) => hold(async () => { order.push("save"); return realSave(input); });
  store.withProjectHeld = (_id, fn) => hold(() => fn(() => undefined));
  const svcHeld = requirementsServices(store, new Approvals({ store: approvalStore, grants: { issueGrant: async () => ({ id: "g" }) }, notifier: null, verifyKkSession: () => false }), approvalStore);

  await svcHeld.pipeline.submitSpec(P1, { kind: "paste", text: spec([DOMAIN]) }); // v1 asks Q
  const q1 = questionByText(approvalStore, DOMAIN)[0];
  // v2 drops Q. Pause its pass while it holds the project, then start v3, which asks Q again.
  const realList = approvalStore.list.bind(approvalStore);
  let release, entered;
  const gate = new Promise((res) => (release = res));
  const inPass = new Promise((res) => (entered = res));
  let pausedOnce = false;
  approvalStore.list = async (f) => {
    if (f.status === "pending" && !pausedOnce) {
      pausedOnce = true;
      order.push("v2-pass");
      entered();
      await gate;
    }
    return realList(f);
  };
  const v2 = svcHeld.pipeline.submitSpec(P1, { kind: "paste", text: spec([LOGO]) });
  await inPass;
  const v3 = svcHeld.pipeline.submitSpec(P1, { kind: "paste", text: spec([DOMAIN]) });
  for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res));
  assert.deepEqual(order.slice(-2), ["save", "v2-pass"], "v3 has not saved while v2's pass holds the project");
  release();
  const [r2, r3] = await Promise.all([v2, v3]);
  approvalStore.list = realList;
  assert.equal(q1.status, "expired", "v2 dropped Q, so v1's card expires");
  const q3 = r3.questionCards.raised.map((q) => approvalStore.cards.get(q.cardId)).filter((c) => c.reason.includes(DOMAIN));
  assert.equal(q3.length, 1);
  assert.equal(q3[0].status, "pending", "v3, the newest spec, has a pending card for Q");
  assert.notEqual(q3[0].id, q1.id);
  assert.equal(r3.docVersion, 3);
  assert.deepEqual(r2.expired.questions, [q1.id]);
});

test("AT-E9 (Codex PR88-r4) the pass never starts an expiry write the project hold may not outlast", async () => {
  const { PrismaRequirementsStore, HoldLapsedError } = await import("../dist/requirements-store.js");
  // The hold lasts the store's timeout plus one step; assertHeld refuses once a whole step no longer fits.
  const txOpts = [];
  const db = { $transaction: async (fn, o) => (txOpts.push(o), fn({ $queryRaw: async () => [] })) };
  const store = new PrismaRequirementsStore(db, 60);
  const seen = await store.withProjectHeld(P1, async (assertHeld) => {
    assertHeld(); // at once: fits
    await new Promise((r) => setTimeout(r, 90)); // 90 ms into a 60 + 40 ms hold: a 40 ms step no longer fits
    try { assertHeld(); return "fits"; } catch (e) { return e; }
  }, 40);
  assert.deepEqual(txOpts[0], { timeout: 100, maxWait: 60 }, "the hold's own bound is the store timeout plus one step");
  assert.ok(seen instanceof HoldLapsedError && seen.message === "project-hold-lapsed");

  // In the pass: a hold that lapses after the first write stops before the second, and nothing more is expired.
  const writes = [];
  const pending = ["c1", "c2"].map((id, i) => ({ id, gate: "requirements", action: "requirements.approve", target: `project ${P1} docs/requirements.md v${i + 1}`, projectId: P1, createdAt: new Date(0) }));
  let calls = 0;
  const deps = {
    latestDoc: async () => ({ id: "doc-3", version: 3, approvalId: null }),
    cards: { list: async ({ cursor }) => (cursor ? [] : pending) },
    expire: async (ids) => (writes.push(ids), ids),
    serialize: async (_id, fn) => fn(() => { if (++calls > 1) throw new HoldLapsedError(); }),
  };
  const r = { docId: "doc-3", docVersion: 3, questionCards: { raised: [], failed: [] } };
  const unlinked = { ...pending[0], id: "c3", target: `project ${P1} docs/requirements.md v3` };
  deps.cards.list = async ({ cursor }) => (cursor ? [] : [...pending, unlinked]);
  await assert.rejects(expireSuperseded(deps, P1, r, new Date()), /project-hold-lapsed/);
  assert.deepEqual(writes, [["c1", "c2"]], "the superseded batch ran while held; the unlinked batch never started");
});

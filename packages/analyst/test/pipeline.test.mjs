import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpec } from "@devos/intake";
import { createHash } from "node:crypto";
import { MemoryRequirementsStore, PipelineError, RequirementsPipeline, ingestStatus, requirementsCard } from "../dist/index.js";

// Same checks as M2.3 parseCard (apps/api/src/approvals.ts), pinned here because apps/api is not a dependency.
const ONE_LINE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+$/;
const MULTI_LINE = /^[^\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]*$/;
const cardOk = (c) =>
  [c.action, c.target].every((v) => v.length >= 1 && v.length <= 200 && ONE_LINE.test(v) && !v.includes("*")) &&
  c.reason.length >= 1 && c.reason.length <= 2000 && MULTI_LINE.test(c.reason);

const P1 = "4b7d1c1e-2f6a-4a8e-9d55-0c1f2a3b4c5d";
const NOW = () => new Date("2026-11-12T14:00:00Z");

const SPEC = `# Shop

## Phase 1: Launch

| ID | Requirement | Priority | Acceptance |
|---|---|---|---|
| FR-1 | Owner login | Must | Login works; Logout works |
| FR-2 | Menu page | Should | Menu shows prices |

## Phase 2: Payments

- FR-3: Online payment

## Open questions

- Which payment provider should we pay for?
- Should the cache use Redis or Postgres?
`;

function setup({ stage = "intake", raiseReq, raiseQ, runner, continuousRun, secretNames } = {}) {
  const store = new MemoryRequirementsStore();
  store.addProject({ id: P1, name: "Shop", stage, ...(continuousRun === undefined ? {} : { continuousRun, capUsd: 15 }) });
  const reqCards = [];
  const qCards = [];
  let n = 0;
  const pipeline = new RequirementsPipeline({
    store,
    now: NOW,
    runner,
    ...(secretNames ? { secretNames } : {}),
    raiseRequirementsCard: raiseReq ?? (async (card) => {
      reqCards.push(card);
      return { id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` };
    }),
    raiseQuestionCard: raiseQ ?? (async (draft, reason) => {
      qCards.push({ draft, reason });
      return { id: `10000000-0000-4000-8000-${String(++n).padStart(12, "0")}` };
    }),
  });
  return { store, pipeline, reqCards, qCards };
}

async function rejects(p, code, status) {
  await assert.rejects(p, (e) => e instanceof PipelineError && e.code === code && (status === undefined || e.status === status));
}

test("PL1 paste: spec v1, requirement and milestone rows, draft doc linked to one requirements card", async () => {
  const { store, pipeline, reqCards } = setup();
  const r = await pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  assert.equal(r.specVersion, 1);
  assert.equal(r.docVersion, 1);
  assert.equal(store.specs[0].sourceFormat, "paste");
  assert.equal(store.specs[0].originalName, null);
  assert.equal(store.specs[0].fileSha256, createHash("sha256").update(SPEC, "utf8").digest("hex"));
  const rows = store.requirements.get(P1);
  assert.deepEqual([...rows.keys()], ["FR-1", "FR-2", "FR-3"]);
  assert.deepEqual(rows.get("FR-1"), { key: "FR-1", title: "Owner login", priority: "must", acceptance: "Login works\nLogout works", milestoneOrdinal: 1 });
  assert.equal(rows.get("FR-2").priority, "should");
  assert.equal(rows.get("FR-3").milestoneOrdinal, 2);
  assert.deepEqual([...store.milestones.get(P1).values()], [
    { ordinal: 1, name: "Phase 1: Launch", gateName: "G1" },
    { ordinal: 2, name: "Phase 2: Payments", gateName: "G2" },
  ]);
  // Exactly one requirements card, linked to the draft doc.
  assert.equal(reqCards.length, 1);
  const doc = await store.latestDoc(P1);
  assert.deepEqual({ status: doc.status, approvalId: doc.approvalId }, { status: "draft", approvalId: r.approvalId });
  assert.equal(store.docs[0].repoPath, "docs/requirements.md");
  const c = reqCards[0];
  assert.equal(c.gate, "requirements");
  assert.equal(c.action, "requirements.approve");
  assert.equal(c.projectId, P1);
  assert.ok(cardOk(c));
  assert.match(c.target, /docs\/requirements\.md v1$/);
  assert.match(c.reason, /^3 requirements \(2 must, 1 should, 0 could\), 2 milestones/);
  // The card carries no spec text.
  assert.ok(!/login|menu|payment provider/i.test(c.reason + c.target));
  assert.match(r.markdown, /### FR-1 — Owner login/);
  assert.match(r.markdown, /spec version 1|version 1/i);
  assert.deepEqual(r.counts, { requirements: 3, milestones: 2, openQuestions: 3, proposed: 0 });
  assert.deepEqual(r.warnings, []);
});

test("PL2 file upload and a second version: v1 superseded, rows upserted, dropped keys kept and reported", async () => {
  const { store, pipeline, reqCards } = setup();
  const r1 = await pipeline.submitSpec(P1, { kind: "file", bytes: Buffer.from(SPEC, "utf8"), originalName: "shop.md" });
  assert.equal(store.specs[0].sourceFormat, "md");
  assert.equal(store.specs[0].originalName, "shop.md");
  const v2 = SPEC.replace("| FR-2 | Menu page | Should | Menu shows prices |\n", "").replace("Owner login", "Owner sign-in");
  const r2 = await pipeline.submitSpec(P1, { kind: "paste", text: v2 });
  assert.equal(r2.specVersion, 2);
  assert.equal(r2.docVersion, 2);
  assert.deepEqual(store.docs.map((d) => d.status), ["superseded", "draft"]);
  assert.deepEqual(r2.droppedKeys, ["FR-2"]);
  assert.deepEqual(r2.droppedMilestones, []);
  const rows = store.requirements.get(P1);
  assert.equal(rows.get("FR-1").title, "Owner sign-in");
  assert.ok(rows.has("FR-2"), "a dropped requirement is never deleted (data deletion is KK's call)");
  assert.equal(reqCards.length, 2);
  assert.match(reqCards[1].target, /v2$/);
  assert.notEqual(r1.approvalId, r2.approvalId);
});

test("PL3 KK approves once: only an approved requirements card for the newest doc approves it; then no resubmission", async () => {
  const { store, pipeline } = setup();
  const r1 = await pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  const r2 = await pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  // The superseded v1 card, a rejected card, an expired card and a decision card change nothing.
  assert.equal(await pipeline.applyDecision({ id: r1.approvalId, gate: "requirements", status: "approved" }), "ignored");
  assert.equal(await pipeline.applyDecision({ id: r2.approvalId, gate: "requirements", status: "rejected" }), "ignored");
  assert.equal(await pipeline.applyDecision({ id: r2.approvalId, gate: "requirements", status: "expired" }), "ignored");
  assert.equal(await pipeline.applyDecision({ id: r2.approvalId, gate: "decision", status: "approved" }), "ignored");
  assert.equal(await pipeline.applyDecision({ id: "20000000-0000-4000-8000-000000000000", gate: "requirements", status: "approved" }), "ignored");
  assert.deepEqual(store.docs.map((d) => d.status), ["superseded", "draft"]);
  assert.equal(await pipeline.applyDecision({ id: r2.approvalId, gate: "requirements", status: "approved" }), "approved");
  assert.deepEqual(store.docs.map((d) => d.status), ["superseded", "approved"]);
  // A repeat decision is a no-op.
  assert.equal(await pipeline.applyDecision({ id: r2.approvalId, gate: "requirements", status: "approved" }), "ignored");
  await rejects(pipeline.submitSpec(P1, { kind: "paste", text: SPEC }), "requirements-already-approved", 409);
  assert.equal(store.specs.length, 2, "a refused submission stores nothing");
  // The store refuses too (the pipeline pre-check can race a concurrent approval).
  const before = JSON.stringify([store.specs, store.docs, [...store.requirements.get(P1)]]);
  await rejects(store.saveAnalysis({ projectId: P1, expectedStage: "intake", spec: { sourceFormat: "paste", originalName: null, fileSha256: "a".repeat(64), text: "x" }, requirements: [{ key: "FR-9", title: "x", priority: "must", acceptance: "", milestoneOrdinal: null }], milestones: [], repoPath: "docs/requirements.md" }), "requirements-already-approved", 409);
  assert.equal(JSON.stringify([store.specs, store.docs, [...store.requirements.get(P1)]]), before, "a refused save stores nothing");
  // approveDoc itself refuses a doc that is not the newest draft (it holds the project lock in the Prisma store).
  assert.equal(await store.approveDoc(store.docs[0].id), false);
});

test("PL4 open questions: non-technical become cards, technical go to the Architect log; failures never block", async () => {
  const { pipeline, qCards } = setup();
  const r = await pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  const texts = qCards.map((q) => q.draft.card.target + " " + q.reason);
  assert.ok(texts.some((t) => /payment provider/.test(t)), "a money question goes to KK");
  assert.ok(!texts.some((t) => /Redis/.test(t)), "a technical question never reaches KK");
  assert.match(r.architectLog, /Redis/);
  assert.ok(qCards.every((q) => q.draft.card.projectId === P1 && q.draft.card.gate === "decision"));
  assert.equal(r.questionCards.raised.length, qCards.length);

  // A failing requirements card: the result says so, nothing is linked, question cards still go out.
  let down = true;
  const s2 = setup({ raiseReq: async () => { if (down) throw new Error("db down"); return { id: "30000000-0000-4000-8000-000000000001" }; } });
  const r2 = await s2.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  assert.equal(r2.approvalId, null);
  assert.deepEqual(r2.warnings, ["card-failed"]);
  assert.equal((await s2.store.latestDoc(P1)).approvalId, null);
  assert.ok(s2.qCards.length > 0);
  // Resubmitting raises a fresh card for the new version.
  down = false;
  const r3 = await s2.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  assert.equal(r3.approvalId, "30000000-0000-4000-8000-000000000001");

  // A failing question card is reported with a fixed code; the requirements card is still raised.
  const s3 = setup({ raiseQ: async () => { throw Object.assign(new Error("x"), { code: "store-down" }); } });
  const r4 = await s3.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  assert.ok(r4.approvalId);
  assert.ok(r4.questionCards.failed.length > 0 && r4.questionCards.failed.every((f) => f.code === "store-down"));

  // A store error while linking the card: the spec stays stored, the result says so, question cards still go out.
  const s4 = setup();
  s4.store.linkApproval = async () => { throw new Error("db down"); };
  const r5 = await s4.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  assert.equal(r5.approvalId, null);
  assert.deepEqual(r5.warnings, ["card-link-failed"]);
  assert.equal(s4.store.specs.length, 1);
  assert.ok(s4.qCards.length > 0);
});

test("PL5 input checks: bad id, unknown project, wrong stage, empty or oversize paste, refused file type", async () => {
  const { pipeline, store } = setup();
  await rejects(pipeline.submitSpec("nope", { kind: "paste", text: SPEC }), "invalid-input", 400);
  await rejects(pipeline.submitSpec("5b7d1c1e-2f6a-4a8e-9d55-0c1f2a3b4c5d", { kind: "paste", text: SPEC }), "project-not-found", 404);
  await rejects(pipeline.submitSpec(P1, { kind: "paste", text: "   \n" }), "empty-spec", 400);
  await rejects(pipeline.submitSpec(P1, { kind: "paste", text: "a".repeat(500_001) }), "spec-too-large", 413);
  await rejects(pipeline.submitSpec(P1, { kind: "other" }), "invalid-input", 400);
  await rejects(pipeline.submitSpec(P1, { kind: "file", bytes: "not bytes", originalName: "a.md" }), "invalid-input", 400);
  await rejects(pipeline.submitSpec(P1, { kind: "file", bytes: Buffer.from("MZ\x90\x00"), originalName: "tool.exe" }), "type-unknown", 400);
  assert.equal(store.specs.length, 0, "nothing stored for a refused submission");
  const late = setup({ stage: "building" });
  await rejects(late.pipeline.submitSpec(P1, { kind: "paste", text: SPEC }), "project-not-in-intake", 409);
  assert.equal(late.store.specs.length, 0);
  // The stage is re-checked under the store's lock: a stage change after the pre-check stores nothing.
  const racing = setup();
  const orig = racing.store.project.bind(racing.store);
  racing.store.project = async (id) => { const p = await orig(id); racing.store.projects.get(id).stage = "provisioning"; return p; };
  await rejects(racing.pipeline.submitSpec(P1, { kind: "paste", text: SPEC }), "project-not-in-intake", 409);
  assert.equal(racing.store.specs.length, 0);
});

const PROSE = `# Bakery app

## Overview

The shop owner can publish a daily menu with prices for each bread.

## Phase 1: Launch

- FR-1: Owner login
`;

test("PL6 model pass: grounded proposals are stored and flagged on the card; a failing model leaves the deterministic result", async () => {
  const blocks = parseSpec(Buffer.from(PROSE, "utf8"), "pasted-spec.md").blocks;
  const menu = blocks.findIndex((b) => b.type !== "table" && b.text.includes("daily menu"));
  const calls = [], projects = [];
  const runner = async (req) => {
    calls.push(req.tag);
    projects.push(req.projectId);
    return { output: JSON.stringify({ requirements: [{ block: menu, title: "Owner publishes daily menu with prices" }], criteria: [] }) };
  };
  const { store, pipeline, reqCards } = setup({ runner });
  const r = await pipeline.submitSpec(P1, { kind: "paste", text: PROSE });
  assert.deepEqual(calls, ["analyst_assist"]);
  assert.deepEqual(projects, [P1], "the runner learns the project, so a run can be recorded against it (M2.2-d3b1)");
  assert.equal(r.counts.proposed, 1);
  assert.ok(store.requirements.get(P1).has("FR-M001"));
  assert.match(reqCards[0].reason, /1 requirements were proposed by the model/);

  const failing = setup({ runner: async () => { throw new Error("cap reached"); } });
  const r2 = await failing.pipeline.submitSpec(P1, { kind: "paste", text: PROSE });
  assert.deepEqual([...failing.store.requirements.get(P1).keys()], ["FR-1"]);
  assert.equal(r2.counts.proposed, 0);
  assert.deepEqual(r2.warnings, ["assist-failed"], "a failed model pass is visible");
  const junk = setup({ runner: async () => ({ output: "not json" }) });
  assert.deepEqual((await junk.pipeline.submitSpec(P1, { kind: "paste", text: PROSE })).warnings, ["assist-failed"]);
});

test("PL8 ingest refusals map to fixed statuses: size 413, conversion faults 422, file faults 400", () => {
  for (const c of ["too-large", "text-too-long", "too-many-blocks"]) assert.equal(ingestStatus(c), 413);
  for (const c of ["parse-timeout", "parse-memory", "parse-failed"]) assert.equal(ingestStatus(c), 422);
  for (const c of ["type-unknown", "empty", "pdf-no-text", "zip-corrupt"]) assert.equal(ingestStatus(c), 400);
});

test("PL7 requirementsCard is accepted by the M2.3 card rules for long counts and never includes spec text", () => {
  const a = { requirements: [{ key: "FR-1", title: "<script>x</script> secret sk-live-123", priority: "must", acceptance: [], milestone: null, assigned: false, source: 0 }], milestones: [], stack: [], openQuestions: [], outOfScope: [], warnings: [] };
  const c = requirementsCard(P1, 12345, a);
  assert.ok(cardOk(c));
  assert.ok(!c.reason.includes("script") && !c.reason.includes("sk-live"));
});

test("AT2 (CR-a2): in continuous-run mode one requirements card carries the pre-flight and no decision card is raised; off, as before", async () => {
  const on = setup({ continuousRun: true, secretNames: async () => ["PAYMENTS_KEY"] });
  const r = await on.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  assert.equal(on.reqCards.length, 1);
  assert.equal(on.reqCards[0].gate, "requirements");
  assert.equal(on.qCards.length, 0, "no separate decision card");
  assert.ok(r.preflight.length >= 3);
  assert.match(on.reqCards[0].reason, /\nPre-flight: \d+ questions, 1 secrets — PF-1: .*payment provider/);
  assert.match(on.reqCards[0].reason, /secret PAYMENTS_KEY \(enter in setup wizard\)/);
  assert.ok(on.reqCards[0].reason.length <= 2000);
  assert.match(r.architectLog, /Redis/, "technical questions still go to the Architect log");
  const doc = on.store.docs.at(-1);
  assert.deepEqual(doc.preflight, r.preflight, "the list KK saw is stored with the doc");
  assert.equal(on.store.preflightState.get(P1), "pending");
  // The card's action and target are unchanged by the mode.
  const off = setup({ continuousRun: false });
  const r0 = await off.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  assert.equal(off.reqCards[0].action, on.reqCards[0].action);
  assert.equal(off.reqCards[0].target, on.reqCards[0].target);
  assert.ok(!/Pre-flight/.test(off.reqCards[0].reason));
  assert.ok(off.qCards.length > 0, "mode off raises the decision cards as before");
  assert.equal(r0.preflight, null);
  assert.equal(off.store.preflightState.has(P1), false);
  // A project row without the field (before CR-a2's store) behaves as off.
  const legacy = setup();
  await legacy.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  assert.deepEqual(legacy.qCards.length, off.qCards.length);
});

test("AT5 (CR-a2, card half): a secret-shaped pre-flight question is retried without its text; a long pre-flight ends with +k more", async () => {
  // Same shape as M2.3's looksSecret password/token/api-key rule (apps/api/src/notify.ts).
  const SECRETISH = /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i;
  const VALUE = "zq81Lm0pXr";
  const spec = SPEC.replace("- Which payment provider should we pay for?", `- Which payment provider should we pay for? Our old token: ${VALUE}`);
  const tries = [];
  const raiseReq = async (card) => {
    tries.push(card);
    if (SECRETISH.test(card.reason)) throw Object.assign(new Error("refused"), { code: "card-contains-secret" });
    return { id: "00000000-0000-4000-8000-000000000099" };
  };
  const on = setup({ continuousRun: true, raiseReq, secretNames: async () => ["PAYMENTS_KEY"] });
  const r = await on.pipeline.submitSpec(P1, { kind: "paste", text: spec });
  assert.equal(tries.length, 2, "one refusal, one retry");
  assert.ok(SECRETISH.test(tries[0].reason), "the first try carried the question text");
  const card = tries[1];
  assert.ok(!card.reason.includes(VALUE), "no secret value in the raised card");
  assert.match(card.reason, /Pre-flight: \d+ questions, 1 secrets — PF-1: question text withheld/);
  assert.match(card.reason, /secret PAYMENTS_KEY \(enter in setup wizard\)/);
  assert.match(card.reason, /Monthly spend cap for this project/, "fixed texts stay");
  assert.equal(card.action, "requirements.approve");
  assert.ok(!r.warnings.includes("card-failed"));
  assert.equal(on.qCards.length, 0);
  assert.ok(on.store.docs.at(-1).approvalId, "the doc is linked to the one intake card");
  // Any other refusal is not retried.
  const other = setup({ continuousRun: true, raiseReq: async () => { throw Object.assign(new Error("x"), { code: "db-down" }); } });
  const r2 = await other.pipeline.submitSpec(P1, { kind: "paste", text: spec });
  assert.deepEqual(r2.warnings, ["card-failed"]);
  // Mode off: the card has no spec text, so a refusal is not retried (as before CR-a2).
  let offTries = 0;
  const off = setup({ continuousRun: false, raiseReq: async () => { offTries++; throw Object.assign(new Error("x"), { code: "card-contains-secret" }); } });
  await off.pipeline.submitSpec(P1, { kind: "paste", text: spec });
  assert.equal(offTries, 1);
  // A pre-flight longer than the 2,000-character reason ends with "+<k> more on the project page".
  const many = Array.from({ length: 40 }, (_, i) => `- Which vendor should we pay for option ${i} of the monthly ${"plan ".repeat(12)}?`).join("\n");
  const big = setup({ continuousRun: true });
  await big.pipeline.submitSpec(P1, { kind: "paste", text: SPEC.replace("- Which payment provider should we pay for?", many) });
  const reason = big.reqCards[0].reason;
  assert.ok(reason.length <= 2000);
  assert.match(reason, /; \+\d+ more on the project page$/);
});

test("AT4/AT6 (CR-a2, memory store): approval writes KK's answers and defaults with it; rejection closes; a new version re-opens", async () => {
  const s = setup({ continuousRun: true, secretNames: async () => ["PAYMENTS_KEY"] });
  const r = await s.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  // Rejected: state `rejected`, nothing recorded, the doc stays a draft.
  assert.equal(await s.pipeline.applyDecision({ id: r.approvalId, gate: "requirements", status: "rejected" }), "rejected");
  assert.equal(s.store.preflightState.get(P1), "rejected");
  assert.equal(s.store.decisions.length, 0);
  // AT6: a new spec version re-opens the pre-flight with a new card.
  const r2 = await s.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  assert.notEqual(r2.approvalId, r.approvalId);
  assert.equal(s.store.preflightState.get(P1), "pending");
  // The old card's late rejection no longer touches the state (it is not the newest doc).
  assert.equal(await s.pipeline.applyDecision({ id: r.approvalId, gate: "requirements", status: "rejected" }), "ignored");
  assert.equal(s.store.preflightState.get(P1), "pending");
  // AT4: approving with `PF-1: yes` records PF-1 as kk and every other decision item as its default.
  assert.equal(await s.pipeline.applyDecision({ id: r2.approvalId, gate: "requirements", status: "approved" }, ["PF-1: yes"]), "approved");
  const decisions = r2.preflight.filter((i) => i.kind === "decision");
  assert.equal(s.store.decisions.length, decisions.length);
  assert.deepEqual(s.store.decisions.map((d) => d.source), decisions.map((_, i) => (i === 0 ? "kk" : "default")));
  assert.equal(s.store.decisions[0].answer, "yes");
  assert.ok(s.store.decisions.every((d) => d.approvalId === r2.approvalId && d.projectId === P1));
  assert.equal(s.store.preflightState.get(P1), "approved");
  // Idempotent: a second sync of the decided card records nothing more.
  assert.equal(await s.pipeline.applyDecision({ id: r2.approvalId, gate: "requirements", status: "approved" }, ["PF-1: no"]), "ignored");
  assert.equal(s.store.decisions.length, decisions.length);
  // Mode off: approval records no decision rows, as before.
  const off = setup({ continuousRun: false });
  const r0 = await off.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  assert.equal(await off.pipeline.applyDecision({ id: r0.approvalId, gate: "requirements", status: "approved" }, ["PF-1: yes"]), "approved");
  assert.equal(off.store.decisions.length, 0);
  assert.equal(await off.pipeline.applyDecision({ id: r0.approvalId, gate: "requirements", status: "rejected" }), "ignored");
});

test("DEVOS-208 (memory store): a new spec version with the mode off re-opens a rejected pre-flight; approved stays", async () => {
  const s = setup({ continuousRun: false });
  s.store.preflightState.set(P1, "rejected");
  const r = await s.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  assert.equal(s.store.preflightState.get(P1), "pending");
  assert.equal(await s.pipeline.applyDecision({ id: r.approvalId, gate: "requirements", status: "approved" }), "approved");
  assert.equal(s.store.preflightState.get(P1), "approved");
  const ok = setup({ continuousRun: false });
  ok.store.preflightState.set(P1, "approved");
  await ok.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  assert.equal(ok.store.preflightState.get(P1), "approved", "approved is not moved by a new version");
});

test("DEVOS-205 (memory store): approving a doc without a pre-flight on a pending project opens the state; rejected and approved stay", async () => {
  for (const [before, after] of [["pending", "approved"], ["rejected", "rejected"], ["approved", "approved"]]) {
    const s = setup({ continuousRun: false });
    const r = await s.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
    s.store.preflightState.set(P1, before);
    assert.equal(await s.pipeline.applyDecision({ id: r.approvalId, gate: "requirements", status: "approved" }), "approved");
    assert.equal(s.store.preflightState.get(P1), after);
  }
});

test("DEVOS-204 (memory store): a later KK comment re-answers one item; the earlier row stays; nothing pauses; re-runs add nothing", async () => {
  const s = setup({ continuousRun: true });
  const r = await s.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  const decidedAt = new Date("2026-11-14T10:00:00Z");
  const card = { id: r.approvalId, gate: "requirements", status: "approved", decidedAt };
  assert.equal(await s.pipeline.applyDecision(card, ["PF-1: yes"]), "approved");
  const before = s.store.decisions.map((d) => ({ ...d }));
  const comments = [
    { id: "c0", body: "PF-1: yes", createdAt: decidedAt },
    { id: "c1", body: "PF-1: no", createdAt: new Date("2026-11-14T11:00:00Z") },
  ];
  const seen = new Date("2026-11-14T11:00:00Z");
  assert.equal(await s.pipeline.applyReanswers(card, comments, seen), 1);
  assert.equal(s.store.decisions.length, before.length + 1);
  assert.deepEqual(s.store.decisions.slice(0, before.length), before, "the approval rows stay as they were");
  const added = s.store.decisions.at(-1);
  assert.deepEqual({ itemId: added.itemId, answer: added.answer, source: added.source, commentId: added.commentId, approvalId: added.approvalId }, { itemId: "PF-1", answer: "no", source: "kk", commentId: "c1", approvalId: null });
  assert.equal(s.store.preflightState.get(P1), "approved", "running work is not paused");
  assert.equal(s.store.answersSyncedAt.get(s.store.docs.at(-1).id).getTime(), seen.getTime());
  // A re-run is a no-op, and the cursor never moves back.
  assert.equal(await s.pipeline.applyReanswers(card, comments, new Date("2026-11-14T10:30:00Z")), 1);
  assert.equal(s.store.decisions.length, before.length + 1);
  assert.equal(s.store.answersSyncedAt.get(s.store.docs.at(-1).id).getTime(), seen.getTime());
  // Not applied: a draft doc, a rejected or undecided card, another gate.
  assert.equal(await s.pipeline.applyReanswers({ ...card, status: "rejected" }, comments, seen), null);
  assert.equal(await s.pipeline.applyReanswers({ ...card, decidedAt: null }, comments, seen), null);
  assert.equal(await s.pipeline.applyReanswers({ ...card, gate: "decision" }, comments, seen), null);
  const d = setup({ continuousRun: true });
  const rd = await d.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  assert.equal(await d.pipeline.applyReanswers({ ...card, id: rd.approvalId }, comments, seen), null);
  assert.equal(d.store.decisions.length, 0);
});

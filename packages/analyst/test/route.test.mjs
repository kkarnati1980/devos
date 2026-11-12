import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpec } from "@devos/intake";
import {
  analyzeSpec,
  classifyQuestion,
  planQuestions,
  questionFingerprint,
  raiseQuestionCards,
  renderArchitectLog,
} from "../dist/index.js";

function plan(md, meta = { specVersion: 3, projectId: "4b7d1c1e-2f6a-4a8e-9d55-0c1f2a3b4c5d" }) {
  const a = analyzeSpec(parseSpec(Buffer.from(md, "utf8"), "spec.md").blocks);
  return { a, p: planQuestions(a, meta) };
}

const SPEC = `## Requirements

### FR-1: Login

- Login succeeds

### FR-2: Export

- FR-3: Import

## Open questions

- Who pays for SMS messages?
- Which database should store sessions?
- Should the export be called "Download"?
- Is the thing ready?
`;

test("RT1 classification: non-technical topics win over technical ones; unclear goes to KK", () => {
  const cls = (text) => classifyQuestion({ kind: "stated", text });
  assert.deepEqual(cls("Who pays for SMS messages?"), { class: "non-technical", reason: "non-technical-topic" });
  assert.deepEqual(cls("Which database should store sessions?"), { class: "technical", reason: "technical-topic" });
  assert.deepEqual(cls("Which database fits the budget?"), { class: "non-technical", reason: "non-technical-topic" });
  assert.deepEqual(cls("Hosting — TBD"), { class: "technical", reason: "technical-topic" });
  assert.deepEqual(cls("Is the thing ready?"), { class: "non-technical", reason: "default-non-technical" });
  assert.deepEqual(classifyQuestion({ kind: "missing-acceptance", text: "Export" }), {
    class: "non-technical",
    reason: "missing-acceptance",
  });
  // Whole words only: "dbase" / "userland" are not "db" / "user".
  assert.equal(cls("Is dbase ok?").reason, "default-non-technical");
});

test("RT2 plan: non-technical questions become decision cards, technical ones go to the Architect log", () => {
  const { a, p } = plan(SPEC);
  assert.equal(a.openQuestions.length, 6);
  assert.deepEqual(p.technical.map((t) => t.text), ["Which database should store sessions?"]);
  const actions = p.cards.map((c) => c.card.action).sort();
  assert.deepEqual(actions, [
    "Answer an open question in the spec",
    "Answer an open question in the spec",
    "Answer an open question in the spec",
    "Confirm acceptance criteria for FR-2",
    "Confirm acceptance criteria for FR-3",
  ]);
  for (const c of p.cards) {
    assert.equal(c.card.gate, "decision");
    assert.equal(c.card.projectId, "4b7d1c1e-2f6a-4a8e-9d55-0c1f2a3b4c5d");
    assert.ok(!/[\n\r*]/.test(c.card.action + c.card.target));
    assert.ok(c.card.reason.length <= 2000 && c.card.action.length <= 200 && c.card.target.length <= 200);
    assert.match(c.card.reason, /spec version 3/);
  }
  // Every question is routed exactly once.
  assert.equal(p.cards.length + p.technical.length, a.openQuestions.length);
});

test("RT3 cards block only what depends on them (DV-FR-012)", () => {
  const { p } = plan(SPEC);
  const byTarget = Object.fromEntries(p.cards.map((c) => [c.card.target, c.blocks]));
  assert.deepEqual(byTarget["spec-acceptance:FR-2"], ["FR-2"]);
  assert.deepEqual(byTarget["spec-acceptance:FR-3"], ["FR-3"]);
  assert.deepEqual(byTarget[`spec-question:${questionFingerprint("Who pays for SMS messages?")}`], []);
  // FR-1 has criteria: no card blocks it.
  assert.ok(!p.cards.some((c) => c.blocks.includes("FR-1")));
  // A TBD in a requirement's own line blocks that requirement.
  const { p: p2 } = plan(`## Requirements

- FR-7: Export format TBD
  - CSV works
`);
  const card = p2.cards.find((c) => c.card.target.startsWith("spec-question:"));
  assert.deepEqual(card.blocks, ["FR-7"]);
});

test("RT4 stable targets: the same question in a later spec version dedupes in M2.3; repeats in one spec merge", () => {
  const v3 = plan(SPEC).p.cards.map((c) => c.card.target);
  const v4 = plan(`## Open questions\n\n- Intro?\n\n${SPEC}`, { specVersion: 4 }).p.cards.map((c) => c.card.target);
  for (const t of v3) assert.ok(v4.includes(t), t);
  const { p } = plan(`## Open questions

- Who pays for SMS?
- who pays   for SMS?
`);
  assert.equal(p.cards.length, 1);
});

test("RT5 spec text stays inert: one-line, clipped, and the Architect log escapes Markdown/HTML", () => {
  const long = "Who pays " + "x".repeat(5000) + "?";
  const { p } = plan(`## Open questions

- ${long}
- Which API <script>alert(1)</script> [x](javascript:alert(1)) should we use?
`);
  assert.equal(p.cards.length, 1);
  assert.ok(p.cards[0].card.reason.length <= 2000);
  assert.ok(p.cards[0].card.reason.endsWith('…"'));
  const md = renderArchitectLog(p, { specVersion: 3, generatedAt: "2026-11-12" });
  assert.ok(!md.includes("<script>"));
  assert.ok(!md.includes("](javascript:"));
  assert.match(md, /## Q-2/);
  assert.match(md, /_to be decided by the Architect_/);
  assert.equal(md, renderArchitectLog(p, { specVersion: 3, generatedAt: "2026-11-12" }));
  assert.match(renderArchitectLog({ cards: [], technical: [] }, { specVersion: 1, generatedAt: "d" }), /No technical questions/);
});

test("RT6 raising: one failure never stops the rest; a secret refusal retries once with the withheld reason", async () => {
  const { p } = plan(SPEC);
  const calls = [];
  const raise = async (draft, reason) => {
    calls.push([draft.questionId, reason]);
    if (draft.card.target === "spec-acceptance:FR-2") throw Object.assign(new Error("db down: SECRET"), { code: "db-down" });
    if (draft.card.target === "spec-acceptance:FR-3" && reason === draft.card.reason)
      throw Object.assign(new Error("x"), { code: "card-contains-secret" });
    if (draft.card.action.startsWith("Answer") && /thing/.test(reason)) throw new Error("plain failure, no code");
    return { id: `card-${calls.length}` };
  };
  const r = await raiseQuestionCards(p, raise);
  assert.equal(r.raised.length + r.failed.length, p.cards.length);
  assert.deepEqual(
    r.failed.map((f) => f.code).sort(),
    ["db-down", "raise-failed"],
  );
  const fr3 = r.raised.find((x) => x.questionId === p.cards.find((c) => c.card.target === "spec-acceptance:FR-3").questionId);
  assert.equal(fr3.withheld, true);
  assert.ok(calls.some(([, reason]) => /withheld/.test(reason)));
  // Failure codes never carry error messages.
  assert.ok(!JSON.stringify(r).includes("SECRET"));
});

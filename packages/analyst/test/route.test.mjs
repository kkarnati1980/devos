import { test } from "node:test";
// Copies of M2.3 parseCard's checks (apps/api/src/approvals.ts ONE_LINE / MULTI_LINE / text()); apps/api is not
// a dependency of this package, so the test pins the same rules.
const ONE_LINE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+$/;
const MULTI_LINE = /^[^\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]*$/;
const accepted = (card) =>
  [card.action, card.target].every((v) => v.trim().length >= 1 && v.trim().length <= 200 && ONE_LINE.test(v.trim())) &&
  card.reason.trim().length >= 1 && card.reason.trim().length <= 2000 && MULTI_LINE.test(card.reason.trim()) &&
  !card.action.includes("*") && !card.target.includes("*");
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
  assert.equal(cls("Is userland ok?").reason, "default-non-technical");
  // The whole text is classified: a non-technical word after 4,000+ characters still sends it to KK.
  assert.equal(cls("Which database " + "x ".repeat(2500) + "fits the budget?").class, "non-technical");
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
    assert.ok(accepted(c.card), c.card.target);
    assert.ok(ONE_LINE.test(c.card.reason));
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
  // One TBD cell in a requirements table blocks only its own row, though all rows share one block.
  const { p: p3 } = plan(`| ID | Requirement | Acceptance |
|---|---|---|
| FR-1 | Login | works |
| FR-2 | Export | format TBD |
| FR-3 | Import | ok |
`);
  assert.deepEqual(p3.cards.filter((c) => c.card.target.startsWith("spec-question:")).map((c) => c.blocks), [["FR-2"]]);
  assert.ok(!p3.cards.some((c) => c.blocks.includes("FR-1") || c.blocks.includes("FR-3")));
  // A TBD criterion under a heading requirement blocks that requirement.
  const { p: p4 } = plan(`### FR-1: Login

- works
- Password rules TBD
`);
  assert.deepEqual(p4.cards.map((c) => c.blocks), [["FR-1"]]);
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
  assert.ok(accepted(p.cards[0].card));
  assert.ok(p.cards[0].card.reason.endsWith('…"'));
  // Non-BMP text is clipped by UTF-16 units (what parseCard counts) and never splits a surrogate pair;
  // bidi overrides and isolates are removed, so parseCard accepts the card.
  const { p: emoji } = plan(`## Open questions\n\n- Who pays ${"\u{1F600}".repeat(1600)}?\n- Who pays \u202Eevil\u2066x\u2069?\n`);
  assert.equal(emoji.cards.length, 2);
  for (const c of emoji.cards) {
    assert.ok(accepted(c.card), c.card.reason.slice(0, 40));
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(c.card.reason));
  }
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
    if (/Who pays/.test(draft.card.reason) && reason === draft.card.reason)
      throw Object.assign(new Error("x"), { code: "invalid-input" });
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
  assert.equal(r.raised.filter((x) => x.withheld).length, 2);
  // A missing-acceptance reason quotes the requirement's title, not analyzer-generated text.
  assert.match(p.cards.find((c) => c.card.target === "spec-acceptance:FR-2").card.reason, /title in the spec: "Export"/);
  // Failure codes never carry error messages.
  assert.ok(!JSON.stringify(r).includes("SECRET"));
});

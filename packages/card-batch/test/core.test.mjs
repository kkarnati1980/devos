// CR-b1 (DEVOS-210, docs/modules/ADR-0012.md): AT9, and the pure halves of AT8a and AT11.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DELETION_WORDS, LEGAL_WORDS, MONEY_WORDS } from "@devos/analyst";
import { BOUNDARY_WORDS, STOP_WORDS, batchAnswers, batchCard, batchLines, batchReason, batchable, istDay, stopHit } from "../dist/index.js";

// Same multi-line rule as M2.3 parseCard's reason (apps/api/src/approvals.ts MULTI_LINE), pinned here.
const MULTI_LINE = new RegExp("^[^\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]*$");

test("AT9 (CR-b1): stop-and-ask gates and words are not batchable; a plain decision question is", () => {
  for (const gate of ["purge", "destructive_or_spend", "first_launch", "requirements", undefined]) {
    assert.deepEqual(batchable({ gate, text: "Which colour for the header?" }).ok, false, `gate ${gate}`);
  }
  for (const text of [
    "Is ₹500 a month fine?",
    "Is $20 fine?",
    "Should we buy a premium subscription?",
    "Is truncating this table acceptable?",
    "Can we restore last week's backup?",
    "Is the licensing fine?",
  ]) {
    const r = batchable({ gate: "decision", text });
    assert.equal(r.ok, false, text);
    assert.equal(r.code, "not-batchable");
  }
  assert.deepEqual(batchable({ gate: "decision", text: "Which colour should the header be?", default: "blue" }), { ok: true });
  // Runner decision: a stop-and-ask default is refused too (fails toward interrupting).
  assert.equal(batchable({ gate: "decision", text: "What should happen to old rows?", default: "delete them" }).ok, false);
  assert.equal(batchable({ gate: "decision", text: 42 }).ok, false);
});

test("AT9 (CR-b1): every listed word and its +s, +ed, +ing, +ion forms (also from the stem without a final e) is refused", () => {
  const groups = { MONEY_WORDS, LEGAL_WORDS, DELETION_WORDS, BOUNDARY_WORDS };
  for (const [name, words] of Object.entries(groups)) assert.ok(words.length > 0, name);
  assert.deepEqual([...STOP_WORDS], [...MONEY_WORDS, ...LEGAL_WORDS, ...DELETION_WORDS, ...BOUNDARY_WORDS], "one shared list");
  let n = 0;
  for (const w of STOP_WORDS) {
    const stems = w.endsWith("e") ? [w, w.slice(0, -1)] : [w];
    for (const s of stems) {
      for (const form of [s, `${s}s`, `${s}ed`, `${s}ing`, `${s}ion`]) {
        for (const cased of [form, form.toUpperCase()]) {
          const r = batchable({ gate: "decision", text: `Question about ${cased} here?` });
          assert.equal(r.ok, false, `${w} → ${cased}`);
          n++;
        }
      }
    }
  }
  assert.ok(n > 1000, `iterated ${n} forms`);
  // The longest stem a word starts with is reported.
  assert.equal(stopHit("deletion of rows"), "deletion");
  assert.equal(stopHit("purchasing"), "purchasing");
  assert.equal(stopHit("A licensed font?"), "license");
  assert.equal(stopHit("Restoring it?"), "restor");
  assert.equal(stopHit("Which header colour?"), null);
});

test("AT8a (CR-b1, pure): 12 questions of 1,000 characters give a reason within 2,000 that parseCard accepts", () => {
  const qs = Array.from({ length: 12 }, (_, i) => ({ text: `Question ${i} `.padEnd(1000, "x"), default: "Architect decides" }));
  for (const q of qs) assert.ok(q.text.length >= 1000);
  const lines = batchLines(qs);
  assert.equal(lines.length, 12);
  for (const l of lines) assert.ok(l.length <= 200, "each line clipped to 200");
  assert.ok(lines.join("\n").length > 2000, "the full list is over the limit");
  const reason = batchReason(qs);
  assert.ok(reason.length <= 2000);
  const m = /\n\+(\d+) more on the project page$/.exec(reason);
  assert.ok(m && Number(m[1]) >= 1, "ends with +<k> more");
  assert.ok(reason.startsWith("12 questions\nBQ-1: Question 0"));
  for (const l of reason.split("\n")) assert.ok(l.length <= 200);
  assert.match(reason, MULTI_LINE);
  // Control characters in a question never break the one-line rule.
  const odd = batchReason([{ text: "Two\nlines here", default: "a\tb" }]);
  assert.equal(odd, "1 question\nBQ-1: Two lines here (default: a b)");
  assert.equal(batchReason([]), "0 questions");
});

test("AT11 (CR-b1, pure): `BQ-1: no` records BQ-1 as kk and the rest as default; last line wins; blank is no answer", () => {
  const qs = [{ text: "Header colour?", default: "blue" }, { text: "Show prices in INR?", default: "yes" }, { text: "Tone?", default: "friendly" }];
  assert.deepEqual(batchAnswers(qs, ["BQ-1: no"]), [
    { itemId: "BQ-1", text: "Header colour?", answer: "no", source: "kk" },
    { itemId: "BQ-2", text: "Show prices in INR?", answer: "yes", source: "default" },
    { itemId: "BQ-3", text: "Tone?", answer: "friendly", source: "default" },
  ]);
  const r = batchAnswers(qs, ["BQ-3: formal\nBQ-9: x", "note\nBQ-3: casual\nBQ-2:   "]);
  assert.deepEqual(r.map((x) => [x.answer, x.source]), [["blue", "default"], ["yes", "default"], ["casual", "kk"]]);
  assert.equal(batchAnswers(qs, [`BQ-1: ${"a".repeat(1500)}`])[0].answer.length, 1000);
});

test("CR-b1: IST day and the fixed batch card identity", () => {
  assert.equal(istDay(new Date("2026-11-14T18:29:59Z")), "2026-11-14");
  assert.equal(istDay(new Date("2026-11-14T18:30:00Z")), "2026-11-15");
  assert.throws(() => istDay(new Date("x")), RangeError);
  assert.deepEqual(batchCard("Shop", "b1"), { gate: "decision", action: "Answer the build questions for Shop", target: "batch:b1" });
  assert.deepEqual(batchCard("Shop", "b1"), batchCard("Shop", "b1"), "a retry sends the same card");
});

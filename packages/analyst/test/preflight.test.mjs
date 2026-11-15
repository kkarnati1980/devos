// CR-a1 (DEVOS-193, docs/modules/ADR-0012.md): AT1 and the pure half of AT5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpec } from "@devos/intake";
import { analyzeSpec, buildPreflight, preflightEntries, preflightLine, preflightReanswers, PreflightError, SECRET_DEFAULT } from "../dist/index.js";

// Same one-line rule as M2.3 parseCard (apps/api/src/approvals.ts ONE_LINE), pinned here as in route.test.mjs.
const ONE_LINE = new RegExp("^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]+$");
const analysis = (md) => analyzeSpec(parseSpec(Buffer.from(md, "utf8"), "spec.md").blocks);

const SPEC = `## Requirements

### FR-1: Login

- Login succeeds

### FR-7: Password

- Password rules TBD
- A password has at least 12 characters

## Open questions

- Who pays for SMS messages?
- Is the thing ready?
- Which database should store sessions?
`;

test("AT1: 2 spec-wide + 1 owned non-technical question and 2 secrets give PF-1…PF-7, each with a default; deterministic", () => {
  const a = analysis(SPEC);
  const items = buildPreflight(a, ["SMS_API_KEY", "MAPS_KEY"], { maxCostUsd: 25 });
  assert.deepEqual(items.map((i) => i.id), ["PF-1", "PF-2", "PF-3", "PF-4", "PF-5", "PF-6", "PF-7"]);
  assert.deepEqual(items.map((i) => i.kind), ["decision", "decision", "decision", "decision", "decision", "secret", "secret"]);
  for (const i of items) assert.ok(i.default.length > 0, `${i.id} has a default`);
  const owned = items.filter((i) => i.blocks);
  assert.equal(owned.length, 1);
  assert.deepEqual(owned[0].blocks, ["FR-7"]);
  assert.ok(!items.some((i) => /database/i.test(i.text)), "technical questions stay with the Architect");
  assert.equal(items[3].text, "Monthly spend cap for this project");
  assert.match(items[3].default, /USD 25/);
  assert.deepEqual(items[4].options, ["no", "yes"]);
  assert.equal(items[4].default, "no — tailnet only");
  assert.deepEqual(items.slice(5).map((i) => [i.text, i.default]), [["SMS_API_KEY", SECRET_DEFAULT], ["MAPS_KEY", SECRET_DEFAULT]]);
  assert.deepEqual(buildPreflight(analysis(SPEC), ["SMS_API_KEY", "MAPS_KEY"], { maxCostUsd: 25 }), items);
});

test("AT1b: a missing-acceptance question defaults to building as written; a repeated question is one item", () => {
  const a = analysis(`## Requirements\n\n### FR-1: Export\n\n## Open questions\n\n- Who pays?\n- Who pays?\n`);
  const items = buildPreflight(a, [], { maxCostUsd: 0 });
  const acc = items.find((i) => /FR-1/.test(i.text));
  assert.ok(acc, "an acceptance item for FR-1");
  assert.equal(acc.default, "build as written; the Architect proposes the criteria");
  assert.deepEqual(acc.blocks, ["FR-1"]);
  assert.equal(items.filter((i) => i.text === "Who pays?").length, 1);
});

test("AT1c: a secret name that is not NAME-shaped, or a bad envelope, is refused (no value ever enters an item)", () => {
  const a = analysis(SPEC);
  for (const n of ["sk_live_abc", "has space", "A", "", "X".repeat(65)]) {
    assert.throws(() => buildPreflight(a, [n], { maxCostUsd: 1 }), (e) => e instanceof PreflightError && e.code === "invalid-secret-name", n);
  }
  for (const env of [null, { maxCostUsd: -1 }, { maxCostUsd: Number.NaN }]) {
    assert.throws(() => buildPreflight(a, [], env), (e) => e instanceof PreflightError && e.code === "invalid-envelope");
  }
  assert.equal(buildPreflight(a, ["DUP_KEY", "DUP_KEY"], { maxCostUsd: 1 }).filter((i) => i.kind === "secret").length, 1);
});

test("AT5 (pure half): the summary line names counts, defaults and secrets by name, fits the limit, and ends with +k more when cut", () => {
  const items = buildPreflight(analysis(SPEC), ["SMS_API_KEY", "MAPS_KEY"], { maxCostUsd: 25 });
  const line = preflightLine(items, 2000);
  assert.match(line, /^Pre-flight: 5 questions, 2 secrets — PF-1: /);
  assert.match(line, /PF-6: secret SMS_API_KEY \(enter in setup wizard\)/);
  assert.ok(ONE_LINE.test(line));
  assert.ok(!/\+\d+ more/.test(line));

  const many = Array.from({ length: 40 }, (_, i) => `- Who decides question ${i} ${"about the content and wording ".repeat(8)}?`).join("\n");
  const big = buildPreflight(analysis(`## Requirements\n\n### FR-1: A\n\n- ok\n\n## Open questions\n\n${many}\n`), [], { maxCostUsd: 5 });
  const cut = preflightLine(big, 2000);
  assert.ok(cut.length <= 2000, `length ${cut.length}`);
  const m = cut.match(/\+(\d+) more on the project page$/);
  assert.ok(m && Number(m[1]) >= 1);
  assert.ok(ONE_LINE.test(cut));
  // Entries checked directly (not by splitting the line): each is ≤ 200, and the line lists a prefix of them in order.
  const entries = preflightEntries(big);
  for (const e of entries) assert.ok(e.length <= 200, `entry of ${e.length}`);
  const shown = entries.length - Number(m[1]);
  assert.ok(cut.startsWith(`Pre-flight: ${big.length} questions, 0 secrets — ${entries.slice(0, shown).join("; ")}; +`));
  // Too little room: never longer than asked; no room at all gives "".
  assert.ok(preflightLine(big, 10).length <= 10);
  for (const max of [0, -5, Number.NaN]) assert.equal(preflightLine(big, max), "", `max ${max}`);
  assert.ok(preflightLine(big, 5000).length <= 2000, "never past M2.3's reason limit");
});

test("AT5b (pure half): control and bidi characters become spaces, and a cut never splits a surrogate pair", () => {
  const items = [
    { id: "PF-1", kind: "decision", text: "Ship\tthe \u202edark\u2066 mode\nnow?", default: "Architect decides" },
    { id: "PF-2", kind: "decision", text: `${"a".repeat(192)}\u{1F600}${"b".repeat(40)}`, default: "x" },
  ];
  const line = preflightLine(items, 2000);
  assert.ok(ONE_LINE.test(line));
  assert.match(line, /PF-1: Ship the dark mode now\? \(default: Architect decides\)/);
  const e2 = preflightEntries(items)[1];
  assert.ok(e2.length <= 200);
  assert.ok(e2.endsWith("a…"), "the cut drops the whole pair before the ellipsis");
  for (let i = 0; i < e2.length; i++) {
    const c = e2.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) assert.ok(i + 1 < e2.length && e2.charCodeAt(i + 1) >= 0xdc00 && e2.charCodeAt(i + 1) <= 0xdfff, "lone high surrogate");
  }
});

test("DEVOS-204: a later `PF-1: no` after an approval with `PF-1: yes` gives one kk row for PF-1 only", () => {
  const items = [
    { id: "PF-1", kind: "decision", text: "Public URL?", default: "no — tailnet only" },
    { id: "PF-2", kind: "decision", text: "Budget", default: "USD 15" },
    { id: "PF-3", kind: "secret", text: "PAYMENTS_KEY", default: "enter in setup wizard" },
  ];
  const approved = [
    { itemId: "PF-1", answer: "yes" },
    { itemId: "PF-2", answer: "USD 15" },
  ];
  const rows = preflightReanswers(items, approved, [{ id: "c1", body: "Changed my mind.\nPF-1: no\nPF-2: USD 15\nPF-3: abc\nPF-9: x" }]);
  assert.deepEqual(rows, [{ commentId: "c1", itemId: "PF-1", text: "Public URL?", answer: "no", source: "kk" }]);
  // Deterministic: the same input gives the same rows; an unchanged answer, a secret or an unknown id gives none.
  assert.deepEqual(preflightReanswers(items, approved, [{ id: "c1", body: "Changed my mind.\nPF-1: no\nPF-2: USD 15\nPF-3: abc\nPF-9: x" }]), rows);
  assert.deepEqual(preflightReanswers(items, approved, [{ id: "c2", body: "PF-1: yes\nPF-1:   \nnote" }]), []);
  // Each comment is read in order against the current answer: no, then back to yes, gives two rows.
  const twice = preflightReanswers(items, approved, [
    { id: "c1", body: "PF-1: no" },
    { id: "c2", body: "PF-1: no" },
    { id: "c3", body: "PF-2: USD 30\nPF-1: yes" },
  ]);
  assert.deepEqual(twice.map((r) => [r.commentId, r.itemId, r.answer]), [["c1", "PF-1", "no"], ["c3", "PF-1", "yes"], ["c3", "PF-2", "USD 30"]]);
  // Within one comment the last line for an id wins; an item missing from the approval rows starts at its default.
  assert.deepEqual(preflightReanswers(items, [], [{ id: "c4", body: "PF-2: USD 20\nPF-2: USD 15" }]), []);
});

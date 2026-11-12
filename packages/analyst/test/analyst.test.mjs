import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpec } from "@devos/intake";
import { analyzeSpec, renderRequirementsMd } from "../dist/index.js";

const blocksOf = (md) => parseSpec(Buffer.from(md, "utf8"), "spec.md").blocks;
const analyze = (md, opts) => {
  const blocks = blocksOf(md);
  return { blocks, a: analyzeSpec(blocks, opts) };
};
const META = { projectName: "Demo", specVersion: 1, specSha256: "a".repeat(64), date: "2026-11-12" };

test("AT1 requirements table: IDs kept, titles, priorities, criteria, milestones", () => {
  const { a } = analyze(`# Spec

| ID | Requirement | Priority | Acceptance | Phase |
|---|---|---|---|---|
| FR-001 | Sign in with email | Must | Link sent; link expires in 15 min | Phase 1 |
| FR-002 | Export to CSV | Should | File downloads | Phase 2 |
| NFR-1.1 | Page loads fast | Could | Under 2 s on 4G | Phase 2 |
`);
  assert.deepEqual(a.requirements.map((r) => r.key), ["FR-001", "FR-002", "NFR-1.1"]);
  assert.deepEqual(a.requirements.map((r) => r.priority), ["must", "should", "could"]);
  assert.equal(a.requirements[0].title, "Sign in with email");
  assert.deepEqual(a.requirements[0].acceptance, ["Link sent", "link expires in 15 min"]);
  assert.deepEqual(a.milestones.map((m) => [m.ordinal, m.name]), [[1, "Phase 1"], [2, "Phase 2"]]);
  assert.equal(a.requirements[2].milestone, "Phase 2");
  assert.ok(a.requirements.every((r) => !r.assigned));
  assert.equal(a.openQuestions.length, 0);
  assert.equal(a.warnings.length, 0);
});

test("AT2 line requirements with nested criteria and Given/When/Then", () => {
  const { a } = analyze(`# Features

- FR-010: Create invoice (Must)
  - Invoice has a number
  - Total includes GST
- FR-011 — Send invoice

### FR-012: Pay online (Should)

Given an open invoice

When the client pays

- Receipt emailed
`);
  const [r10, r11, r12] = a.requirements;
  assert.equal(r10.key, "FR-010");
  assert.equal(r10.title, "Create invoice");
  assert.deepEqual(r10.acceptance, ["Invoice has a number", "Total includes GST"]);
  assert.equal(r11.title, "Send invoice");
  assert.equal(r11.acceptance.length, 0);
  assert.equal(r12.priority, "should");
  assert.deepEqual(r12.acceptance, ["Given an open invoice", "When the client pays", "Receipt emailed"]);
});

test("AT3 phase headings become ordered milestones; requirements inherit the nearest", () => {
  const { a } = analyze(`## Phase 1 — Foundations

- FR-1: Accounts (Must)
  - Sign up works

## Phase 2 — Billing

- FR-2: Invoices (Must)
  - Invoice created
`);
  assert.deepEqual(a.milestones.map((m) => m.name), ["Phase 1 — Foundations", "Phase 2 — Billing"]);
  assert.equal(a.requirements[0].milestone, "Phase 1 — Foundations");
  assert.equal(a.requirements[1].milestone, "Phase 2 — Billing");
});

test("AT4 ID-less items get assigned IDs that never collide with spec IDs", () => {
  const { a } = analyze(`# Spec

The old draft listed FR-A001 once.

## Functional requirements

- Users can reset their password
- Admins can disable a user (Should)
`);
  const assigned = a.requirements.filter((r) => r.assigned);
  assert.deepEqual(assigned.map((r) => r.key), ["FR-A002", "FR-A003"]);
  assert.equal(assigned[1].priority, "should");
  assert.equal(assigned[1].title, "Admins can disable a user");
});

test("AT5 duplicate keeps first and warns; Won't is out of scope; unknown priority defaults to must", () => {
  const { a } = analyze(`| ID | Title | Priority | Acceptance |
|---|---|---|---|
| FR-1 | First | Must | ok |
| FR-1 | Second | Must | ok |
| FR-2 | Dark mode | Won't | n/a |
| FR-3 | Search | Someday | finds things |
`);
  assert.deepEqual(a.requirements.map((r) => [r.key, r.title, r.priority]), [["FR-1", "First", "must"], ["FR-3", "Search", "must"]]);
  assert.deepEqual(a.outOfScope.map((o) => o.key), ["FR-2"]);
  assert.ok(a.warnings.some((w) => w.code === "duplicate-id" && w.key === "FR-1"));
  assert.ok(a.warnings.some((w) => w.code === "priority-defaulted" && w.key === "FR-3"));
  assert.ok(a.warnings.every((w) => !("text" in w)));
});

test("AT6 stack and open questions; missing criteria become questions", () => {
  const { a } = analyze(`## Tech stack

- Next.js
- Postgres

## Requirements

- FR-1: Login (Must)

Pricing tier for teams is TBD.

Should guests see prices?

## Open questions

- Which payment provider
`);
  assert.deepEqual(a.stack.map((s) => s.text), ["Next.js", "Postgres"]);
  const stated = a.openQuestions.filter((q) => q.kind === "stated").map((q) => q.text);
  assert.deepEqual(stated, ["Pricing tier for teams is TBD.", "Should guests see prices?", "Which payment provider"]);
  const missing = a.openQuestions.filter((q) => q.kind === "missing-acceptance");
  assert.deepEqual(missing.map((q) => q.requirement), ["FR-1"]);
  assert.deepEqual(a.openQuestions.map((q) => q.id), ["Q-1", "Q-2", "Q-3", "Q-4"]);
});

test("AT7 no invention: every item maps to a source block; empty spec warns", () => {
  const { blocks, a } = analyze(`## Phase 1

- FR-1: Login (Must)
  - works

## Requirements

- Reset password

## Stack

- Go
`);
  const textOf = (i) => {
    const b = blocks[i];
    return b.type === "table" ? b.rows.flat().join(" ") : b.text;
  };
  for (const r of a.requirements) {
    const t = textOf(r.source);
    assert.ok(r.assigned ? t.includes(r.title) : t.includes(r.key), `${r.key} not in its source block`);
  }
  for (const m of a.milestones) assert.ok(textOf(m.source).includes(m.name));
  for (const s of a.stack) assert.ok(textOf(s.source).includes(s.text));
  const empty = analyzeSpec(blocksOf("# Nothing here\n\nJust prose.\n"));
  assert.equal(empty.requirements.length, 0);
  assert.ok(empty.warnings.some((w) => w.code === "no-requirements"));
  // A mention of an ID inside prose is a reference, not a definition.
  const ref = analyzeSpec(blocksOf("See FR-9 for details.\n"));
  assert.equal(ref.requirements.length, 0);
});

test("AT8 requirements.md is inert and deterministic", () => {
  const md = `| ID | Title | Priority | Acceptance |
|---|---|---|---|
| FR-1 | Show <b>bold</b> name | Must | done |
| FR-2 | No criteria | Must | |
`;
  const { a } = analyze(md);
  const out1 = renderRequirementsMd(a, META);
  assert.equal(out1, renderRequirementsMd(analyze(md).a, META));
  assert.ok(!out1.includes("<b>"));
  assert.ok(out1.includes("&lt;b&gt;bold&lt;/b&gt;"));
  assert.ok(out1.includes("_No acceptance criteria — see Q-1._"));
  assert.match(out1, /## Open questions\n\n- \*\*Q-1\*\* FR-2 has no acceptance criteria/);
  // Renderer on its own, given hostile text straight in blocks (not through intake).
  const hostile = analyzeSpec([
    { type: "list-item", text: "FR-7: <script>x</script> [y](javascript:alert(1)) **z** (Must)", ordered: false, depth: 0 },
    { type: "list-item", text: "![img](http://e/x) # not a heading", ordered: false, depth: 1 },
  ]);
  const out = renderRequirementsMd(hostile, META);
  assert.ok(!out.includes("<script"));
  assert.ok(!/\]\(javascript:/.test(out));
  assert.ok(!out.includes("![img]("));
  assert.ok(out.includes("\\*\\*z\\*\\*"));
  assert.throws(() => renderRequirementsMd(a, { ...META, specSha256: "xyz" }), TypeError);
});

test("AT9 60 requirements across 9 phases", () => {
  const rows = [];
  for (let i = 1; i <= 60; i++) rows.push(`| FR-${String(i).padStart(3, "0")} | Feature ${i} | Must | Works ${i} | Phase ${((i - 1) % 9) + 1} |`);
  const { a } = analyze(`| ID | Requirement | Priority | Acceptance | Phase |\n|---|---|---|---|---|\n${rows.join("\n")}\n`);
  assert.equal(a.requirements.length, 60);
  assert.equal(a.milestones.length, 9);
  assert.equal(new Set(a.requirements.map((r) => r.key)).size, 60);
  assert.equal(a.openQuestions.length, 0);
});

test("assignPrefix is validated", () => {
  assert.throws(() => analyzeSpec([], { assignPrefix: "fr-x" }), TypeError);
});

test("AT5b rejected headings swallow their criteria; Won't after a kept ID is a duplicate", () => {
  const { a } = analyze(`## Requirements

### FR-1: Login (Must)

- Link sent

### FR-1: Login again

- Second definition criterion

### FR-9: Dark mode (Won't)

- Toggle in settings
- Remembers choice
`);
  assert.deepEqual(a.requirements.map((r) => r.key), ["FR-1"]);
  assert.deepEqual(a.requirements[0].acceptance, ["Link sent"]);
  assert.deepEqual(a.outOfScope.map((o) => o.key), ["FR-9"]);
  assert.ok(a.requirements.every((r) => !r.assigned));
  const t = analyze(`| ID | Title | Priority | Acceptance |
|---|---|---|---|
| FR-1 | Login | Must | ok |
| FR-1 | Login v2 | Won't | x |
`).a;
  assert.deepEqual(t.requirements.map((r) => r.key), ["FR-1"]);
  assert.equal(t.outOfScope.length, 0);
  assert.ok(t.warnings.some((w) => w.code === "duplicate-id" && w.key === "FR-1"));
});

test("AT2b AC-n items are criteria of the requirement above", () => {
  const { a } = analyze(`### FR-1: Login (Must)

- AC-1: Link sent
- AC-2: Link expires
`);
  assert.deepEqual(a.requirements.map((r) => r.key), ["FR-1"]);
  assert.deepEqual(a.requirements[0].acceptance, ["AC-1: Link sent", "AC-2: Link expires"]);
  assert.equal(a.openQuestions.length, 0);
});

test("AT4b assigned requirements keep nested criteria; numbered section headings", () => {
  const { a } = analyze(`## 3. Functional requirements

- Users can reset password (Must)
  - Email sent within 1 min

## 4.2 Outstanding questions

- Which SMS provider
`);
  assert.equal(a.requirements.length, 1);
  assert.equal(a.requirements[0].key, "FR-A001");
  assert.deepEqual(a.requirements[0].acceptance, ["Email sent within 1 min"]);
  assert.deepEqual(a.openQuestions.map((q) => q.text), ["Which SMS provider"]);
});

test("AT6b sections end at milestone headings; Release notes is not a milestone; references are not definitions", () => {
  const { a } = analyze(`## Tech stack

- Go

## Phase 1 — MVP

- FR-1: Login
  - works

The dashboard shows totals.

## Release notes

- FR-2: Export (Must)
  - CSV

- FR-1-2: Not an ID definition
`);
  assert.deepEqual(a.stack.map((s) => s.text), ["Go"]);
  assert.deepEqual(a.milestones.map((m) => m.name), ["Phase 1 — MVP"]);
  assert.equal(a.requirements[1].milestone, "Phase 1 — MVP");
  assert.deepEqual(a.requirements.map((r) => r.key), ["FR-1", "FR-2"]);
});

test("AT8b out of scope renders; many assigned IDs stay linear", () => {
  const { a } = analyze(`| ID | Title | Priority | Acceptance |
|---|---|---|---|
| FR-2 | Dark mode | Won't | n/a |
`);
  assert.match(renderRequirementsMd(a, META), /## Out of scope\n\n- FR-2 — Dark mode/);
  const items = Array.from({ length: 20000 }, (_, i) => `- Item ${i}`).join("\n");
  const t0 = Date.now();
  const big = analyze(`## Requirements\n\n${items}\n`).a;
  assert.equal(big.requirements.length, 20000);
  assert.ok(Date.now() - t0 < 5000, "20k assigned IDs took too long");
});

test("AT6c a requirements section split by phase keeps its items; hyphenated words are not milestones", () => {
  const { a } = analyze(`## Functional requirements

### Phase 1

- Users can sign up

### Phase 2

- Users can export

## Release-ready checklist

- FR-5: Audit log (Must)
  - Entries kept
`);
  assert.deepEqual(a.requirements.map((r) => [r.key, r.milestone]), [["FR-A001", "Phase 1"], ["FR-A002", "Phase 2"], ["FR-5", "Phase 2"]]);
  assert.deepEqual(a.milestones.map((m) => m.name), ["Phase 1", "Phase 2"]);
});

test("AT10 (PR53-r1) bare IDs are not definitions; priority aliases on lines; TBD criteria become questions", () => {
  const { a } = analyze(`## Requirements

FR-1

- FR-2: Dark mode (W)
- FR-3: Export (P2)
- FR-4: Theme (Low)
- FR-5: Login (Must)
  - Session duration TBD
  - Link sent

| ID | Title | Priority | Acceptance |
|---|---|---|---|
| FR-6 | Reports | Must | Totals shown; Format TBC |

## Stack

- Hosting TBD
`);
  assert.deepEqual(a.requirements.map((r) => [r.key, r.priority]), [["FR-3", "should"], ["FR-4", "could"], ["FR-5", "must"], ["FR-6", "must"]]);
  assert.deepEqual(a.outOfScope.map((o) => o.key), ["FR-2"]);
  assert.deepEqual(a.requirements[2].acceptance, ["Link sent"]);
  assert.deepEqual(a.requirements[3].acceptance, ["Totals shown"]);
  const stated = a.openQuestions.filter((q) => q.kind === "stated").map((q) => q.text);
  assert.deepEqual(stated, ["Session duration TBD", "Format TBC", "Hosting TBD"]);
  assert.deepEqual(a.stack.map((s) => s.text), ["Hosting TBD"]);
});

test("AT10b (PR53-r2) bare ID list items are references; an ID-less item with TBD is a requirement and a question", () => {
  const { a } = analyze(`## Requirements

- FR-1
- **FR-2**, FR-3
- Users can export reports; format TBD
  - Export downloads
`);
  assert.deepEqual(a.requirements.map((r) => [r.key, r.title, r.assigned]), [["FR-A001", "Users can export reports; format TBD", true]]);
  assert.deepEqual(a.requirements[0].acceptance, ["Export downloads"]);
  assert.deepEqual(a.openQuestions.filter((q) => q.kind === "stated").map((q) => q.text), ["FR-A001: Users can export reports; format TBD"]);
  assert.equal(a.openQuestions.filter((q) => q.kind === "missing-acceptance").length, 0);
});

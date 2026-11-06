// S1 acceptance tests (docs/modules/S1.md): catalogue schema, rules, generated files, index budget, rules.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { load, validate, render, estimateTokens, EXPECTED_IDS, INDEX_TOKEN_BUDGET } from "../standards/gen-standard.mjs";

const clone = (o) => JSON.parse(JSON.stringify(o));
const mod = (doc, id) => doc.modules.find((m) => m.id === id);

test("AT1 the catalogue validates against its schema and the catalogue rules", () => {
  assert.deepEqual(validate(load()), []);
});

test("AT2 the catalogue holds exactly F1–F3, SM-01–SM-18 and SM-C1–C3, each complete", () => {
  const doc = load();
  assert.deepEqual(doc.modules.map((m) => m.id), EXPECTED_IDS);
  for (const m of doc.modules) {
    assert.ok(m.applies_when.length > 5, `${m.id} applicability`);
    if (m.kind === "selectable") {
      assert.ok(m.lite.checks.length && m.full.checks.length, `${m.id} Lite and Full checks`);
      assert.ok(m.signals.length, `${m.id} signals`);
      for (const c of [...m.lite.checks, ...m.full.checks]) assert.ok(c.evidence, `${c.id} evidence`);
    } else {
      assert.ok(m.checks.length, `${m.id} checks`);
    }
  }
  for (const id of ["F1", "F2", "F3"]) assert.deepEqual(mod(doc, id).blocks, ["preview", "live"]);
});

test("AT3 the validator rejects broken catalogues", () => {
  const base = load();
  const cases = [
    ["selectable module without Full", (d) => { delete mod(d, "SM-04").full; }, /schema/],
    ["floor module that does not block preview", (d) => { mod(d, "F2").blocks = ["live"]; }, /floor modules block preview and live/],
    ["duplicate module id", (d) => { d.modules.push(clone(mod(d, "SM-01"))); }, /duplicate module ids: SM-01/],
    ["missing module", (d) => { d.modules = d.modules.filter((m) => m.id !== "SM-17"); }, /missing modules: SM-17/],
    ["check id at the wrong level", (d) => { mod(d, "SM-01").lite.checks[0].id = "SM-01-F9"; }, /must be SM-01-L<n>/],
    ["unknown evidence kind", (d) => { mod(d, "SM-03").lite.checks[0].evidence = "vibes"; }, /schema/],
    ["invalid signal regex", (d) => { mod(d, "SM-16").signals[0].code = ["(unclosed"]; }, /bad signal regex/],
    ["selectable module with no signals", (d) => { mod(d, "SM-09").signals = []; }, /at least one signal/],
  ];
  for (const [name, mutate, expected] of cases) {
    const d = clone(base);
    mutate(d);
    const errors = validate(d);
    assert.ok(errors.some((e) => expected.test(e)), `${name}: ${JSON.stringify(errors)}`);
  }
});

test("AT4 the index fits the 2,000-token budget and lists every module", () => {
  const index = readFileSync("docs/standards/index.md", "utf8");
  assert.ok(estimateTokens(index) <= INDEX_TOKEN_BUDGET, `index is about ${estimateTokens(index)} tokens`);
  for (const id of EXPECTED_IDS) assert.match(index, new RegExp(`\\| ${id} \\|`), id);
});

test("AT5 the generated files are current and one file exists per module", () => {
  const files = render(load());
  for (const [rel, text] of files) {
    const p = `docs/standards/${rel}`;
    assert.ok(existsSync(p), `${p} exists`);
    assert.equal(readFileSync(p, "utf8"), text, `${p} is current`);
  }
  assert.equal([...files.keys()].filter((k) => k.startsWith("modules/")).length, 24);
  // and the CLI agrees
  execFileSync(process.execPath, ["scripts/standards/gen-standard.mjs", "--check"], { stdio: "pipe" });
});

test("AT6 rules.md carries the build-standard rules and the review section cites module IDs", () => {
  const rules = readFileSync("rules.md", "utf8");
  assert.match(rules, /## Build standard \(ADR-0010\/0011\)/);
  assert.match(rules, /F1 secret exposure, F2 internal-URL block/);
  const review = rules.slice(rules.indexOf("## Review guidelines"));
  assert.match(review, /\*\*Build standard:\*\*.*F1–F3.*selection\.md.*`SM-02-L2`/s);
  for (const f of ["docs/decisions/0010-modular-build-standard-and-readiness-gate.md", "docs/decisions/0011-devos-hardening-and-access.md"]) {
    assert.ok(existsSync(f), f);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// M0.6 AT: the shared ReviewVerdict type declares exactly the fields of the review runner's
// verdict schema (docs/modules/M0.3.md). Read from source so the test needs no build step.
const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const fieldsOf = (iface) => {
  const m = src.match(new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `${iface} not found`);
  return [...m[1].matchAll(/^\s*(\w+):/gm)].map((x) => x[1]);
};

test("ReviewVerdict has exactly verdict, sha, summary, findings", () => {
  assert.deepEqual(fieldsOf("ReviewVerdict").sort(), ["findings", "sha", "summary", "verdict"]);
});

test("ReviewFinding has exactly severity, file, line, evidence, consequence", () => {
  assert.deepEqual(fieldsOf("ReviewFinding").sort(), ["consequence", "evidence", "file", "line", "severity"]);
});

test("verdict and severity enums match the schema", () => {
  assert.match(src, /verdict: "PASS" \| "CHANGES_REQUESTED";/);
  assert.match(src, /ReviewSeverity = "high" \| "medium" \| "low";/);
});

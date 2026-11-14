// DEVOS-181: one KK-only classifier for the gate evaluator and the Release merge path, with one test table.
// Contracts: docs/modules/GI-4.md and docs/modules/GI-1b.md ("Shared KK-only classifier").
import { test } from "node:test";
import assert from "node:assert/strict";
import { KK_ONLY, ciBodyIsPlain } from "../gates/kk-only.mjs";
import * as evaluator from "../gates/evaluate-gate.mjs";
import { notKeepable } from "../release/merge.mjs";

const SKIP = ["test", "skip"].join(".");
const NOSEC = ["// ", "no", "sec"].join("");
const LONG = "x".repeat(200);

// [rule, file, text, expected KK-only]
const TABLE = [
  // Always KK-only (spec §4.4 / §4.5).
  ["gitleaksignore-added", ".gitleaksignore", "abc:rule:1", true],
  ["policy-weakened", "packages/policy/src/a.ts", "deny", true],
  ["guard-change-not-isolated", "scripts/floor-guard/floor-guard.mjs", "x", true],
  // Security words in the file or the text, for any rule.
  ["test-skipped", "apps/api/src/security/a.test.ts", `${SKIP}("a"`, true],
  ["assertion-removed", "apps/api/test/secrets.test.mjs", "assert.ok(x)", true],
  ["lint-rule-off", "eslint.config.mjs", '"security/detect-eval-with-expression": "off",', true],
  ["threshold-lowered", "vitest.config.ts", "audit: 0", true],
  // A cut (full-length) text fails closed.
  ["test-skipped", "apps/api/test/a.test.mjs", LONG, true],
  // Suppressions.
  ["suppression-added", "apps/api/src/x.ts", NOSEC, true],
  ["suppression-added", "apps/api/src/x.ts", "// eslint-disable-next-line security/detect-object-injection", true],
  ["suppression-added", "apps/api/src/x.ts", "// @ts-expect-error narrow later", false],
  // Lint.
  ["lint-rule-off", "eslint.config.mjs", "ignores: [\"dist/**\"]", true],
  ["lint-rule-off", "eslint.config.mjs", '"no-console": "off"', false],
  // CI: body-less or unknown bodies are KK-only; a plain stored body is not (DEVOS-186).
  ["ci-step-removed", ".github/workflows/ci.yml", "Lint", true],
  ["ci-disabled", ".github/workflows/ci.yml", "build", true],
  ["ci-job-removed", ".github/workflows/ci.yml", "build; ran: run: pnpm build", true],
  ["ci-step-removed", ".github/workflows/ci.yml", "Build; ran: run: pnpm test", true],
  ["ci-step-removed", ".github/workflows/ci.yml", "Build; ran: run: ./scripts/x.sh", true],
  ["ci-step-removed", ".github/workflows/ci.yml", "Build; ran: run: pnpm build", false],
  ["ci-step-changed", ".github/workflows/ci.yml", "Install; was: run: pnpm install; now: run: pnpm install --frozen-lockfile", false],
  ["ci-step-removed", ".github/workflows/ci.yml", "Checkout; ran: uses: actions/checkout@v4", false],
  // Ordinary weakenings stay Codex-keepable.
  ["test-skipped", "apps/api/test/a.test.mjs", `${SKIP}("flaky on CI"`, false],
  ["assertion-removed", "apps/api/test/a.test.mjs", "assert.equal(a, 1)", false],
  ["contract-weakened", "docs/modules/M2.2.md", "AT-CA6", false],
];

test("K1 the gate evaluator and the Release merge path use the one shared classifier", () => {
  assert.equal(evaluator.KK_ONLY, KK_ONLY);
  assert.equal(evaluator.ciBodyIsPlain, ciBodyIsPlain);
  assert.equal(notKeepable, KK_ONLY);
});

test("K2 the KK-only table", () => {
  for (const [rule, file, text, kk] of TABLE) {
    assert.equal(KK_ONLY({ id: "fg-0000000000", rule, file, line: 1, text }), kk, `${rule} ${file} ${text.slice(0, 60)}`);
  }
});

test("K3 a malformed hit fails closed or reads as an ordinary hit, never throws", () => {
  assert.equal(KK_ONLY({ rule: "guard-change-not-isolated" }), true);
  assert.equal(KK_ONLY({ rule: "ci-step-removed" }), true);
  for (const h of [null, undefined, {}]) assert.doesNotThrow(() => KK_ONLY(h));
});

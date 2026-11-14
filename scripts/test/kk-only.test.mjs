// DEVOS-181: one KK-only classifier for the gate evaluator and the Release merge path, with one test table.
// Contracts: docs/modules/GI-4.md and docs/modules/GI-1b.md ("Shared KK-only classifier").
import { test } from "node:test";
import assert from "node:assert/strict";
import { KK_ONLY, ciBodyIsPlain, CUT, STEP_BODY_CUT } from "../gates/kk-only.mjs";
import { TEXT_CUT, STEP_BODY_CUT as GUARD_STEP_BODY_CUT, STEP_BODY_RULES } from "../floor-guard/floor-guard.mjs";
import * as evaluator from "../gates/evaluate-gate.mjs";
import { notKeepable } from "../release/merge.mjs";

const SKIP = ["test", "skip"].join(".");
const NOSEC = ["// ", "no", "sec"].join("");
const LONG = "x".repeat(200);
// Built by concatenation so the floor guard does not read these fixtures as new suppressions (GI-4 "Floor-guard self-match").
const ESL = ["// eslint", "disable-next-line"].join("-");
const TSE = ["// @ts", "expect-error"].join("-");

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
  ["suppression-added", "apps/api/src/x.ts", `${ESL} security/detect-object-injection`, true],
  ["suppression-added", "apps/api/src/x.ts", `${TSE} narrow later`, false],
  // Lint.
  ["lint-rule-off", "eslint.config.mjs", "ignores: [\"dist/**\"]", true],
  ["lint-rule-off", "eslint.config.mjs", '"no-console": "off"', false],
  // CI: body-less or unknown bodies are KK-only; a plain stored body is not (DEVOS-186).
  ["ci-step-removed", ".github/workflows/ci.yml", "Lint", true],
  ["ci-disabled", ".github/workflows/ci.yml", "build", true],
  ["ci-job-removed", ".github/workflows/ci.yml", "job build removed; ran: run: pnpm build", true],
  ["ci-step-removed", ".github/workflows/ci.yml", "job ci: step Build removed; ran: run: pnpm test", true],
  ["ci-step-removed", ".github/workflows/ci.yml", "job ci: step Build removed; ran: run: ./scripts/x.sh", true],
  ["ci-step-removed", ".github/workflows/ci.yml", "job ci: step Build removed; ran: run: pnpm build", false],
  ["ci-step-changed", ".github/workflows/ci.yml", "job ci: step Install changed; was: run: pnpm install; now: run: pnpm install --frozen-lockfile", false],
  ["ci-step-removed", ".github/workflows/ci.yml", "job ci: step Checkout removed; ran: uses: actions/checkout@v4", false],
  // DEVOS-209: SHA-pinned setup steps with their shaping keys are plain; past 200 characters is not a cut for a step.
  ["ci-step-changed", ".github/workflows/ci.yml", "job build: step uses:actions/setup-node changed; was: uses: actions/setup-node@v4 ⏎ with: ⏎ node-version-file: .nvmrc; now: uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 ⏎ with: ⏎ node-version-file: .nvmrc ⏎ package-manager-cache: false", false],
  ["ci-step-changed", ".github/workflows/ci-gate.yml", "job ci-gate: step uses:actions/checkout#2 changed; was: uses: actions/checkout@v4 ⏎ with: ⏎ ref: ${{ github.event.pull_request.base.sha }} ⏎ path: .gate-base ⏎ sparse-checkout: .github/workflows ⏎ persist-credentials: false; now: uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 ⏎ with: ⏎ ref: ${{ github.event.pull_request.base.sha }} ⏎ path: .gate-base ⏎ sparse-checkout: .github/workflows ⏎ persist-credentials: false", false],
  ["ci-step-changed", ".github/workflows/ci.yml", "job ci: step uses:actions/checkout changed; was: uses: actions/checkout@v4; now: uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 ⏎ with: ⏎ persist-credentials: true", true],
  ["ci-step-changed", ".github/workflows/ci.yml", "job ci: step uses:actions/checkout changed; was: uses: actions/checkout@v4; now: uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 ⏎ with: ⏎ ref: ${{ github.event.pull_request.head.ref }}", true],
  ["ci-step-changed", ".github/workflows/ci.yml", "job ci: step uses:actions/checkout changed; was: uses: actions/checkout@v4; now: uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 ⏎ with: ⏎ ref: main", true],
  ["ci-step-changed", ".github/workflows/security.yml", "job vuln-scan: step uses:actions/checkout changed; was: uses: actions/checkout@v4; now: uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09", true],
  ["ci-job-removed", ".github/workflows/ci.yml", "x".repeat(250), true],
  // Pre-review finding 2: a base SHA or a sparse checkout on the main checkout changes what later steps scan or lint.
  ["ci-step-changed", ".github/workflows/release-images.yml", "job s: step uses:actions/checkout changed; was: uses: actions/checkout@v4; now: uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 ⏎ with: ⏎ ref: ${{ github.event.pull_request.base.sha }}", true],
  ["ci-step-changed", ".github/workflows/release-images.yml", "job s: step uses:actions/checkout changed; was: uses: actions/checkout@v4; now: uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 ⏎ with: ⏎ sparse-checkout: README.md", true],
  ["ci-step-changed", ".github/workflows/release-images.yml", "job s: step uses:actions/checkout changed; was: uses: actions/checkout@v4; now: uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 ⏎ with: ⏎ sparse-checkout: README.md ⏎ path: .", true],
  ["ci-step-changed", ".github/workflows/release-images.yml", "job s: step uses:actions/checkout changed; was: uses: actions/checkout@v4; now: uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 ⏎ with: ⏎ ref: ${{ github.event.pull_request.base.sha }} ⏎ path: ./", true],
  ["ci-step-changed", ".github/workflows/ci.yml", "job build: step uses:actions/checkout changed; was: uses: actions/checkout@v4; now: uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 ⏎ with: ⏎ ref: ${{ github.event.pull_request.head.sha }}", false],
  // Pre-review finding 1: a step text of exactly 200 characters may be an older guard's cut, so it fails closed.
  ["ci-step-removed", ".github/workflows/ci.yml", ("job ci: step X removed; ran: run: pnpm build" + " ".repeat(200)).slice(0, 200), true],
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
  // A hit with no rule, file or text names nothing a Keep could cover; it reads as an ordinary hit.
  for (const h of [null, undefined, {}]) assert.equal(KK_ONLY(h), false);
});

test("K4 the classifier's cut lengths are the floor guard's (DEVOS-209)", () => {
  assert.equal(CUT, TEXT_CUT);
  assert.equal(STEP_BODY_CUT, GUARD_STEP_BODY_CUT);
  assert.deepEqual([...STEP_BODY_RULES], ["ci-step-removed", "ci-step-changed"]);
  // A step body just under the step cut is read in full; at the cut it fails closed.
  const body = (n) => { const t = "job ci: step X removed; ran: run: pnpm build"; return t + " ".repeat(n - t.length); };
  assert.equal(KK_ONLY({ rule: "ci-step-removed", file: ".github/workflows/ci.yml", line: 0, text: body(STEP_BODY_CUT - 1) }), false);
  assert.equal(KK_ONLY({ rule: "ci-step-removed", file: ".github/workflows/ci.yml", line: 0, text: body(STEP_BODY_CUT) }), true);
});

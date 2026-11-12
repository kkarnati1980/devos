// DEVOS-141 floor guard: one fixture diff per §4.2 pattern (exit 1), a clean diff (exit 0), forced errors (exit 2),
// dispositions, guard isolation, and the CLI. Contract: docs/modules/GI-1.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, applyDispositions, parseDiff, workflowShape } from "../floor-guard.mjs";

const GUARD = path.resolve(import.meta.dirname, "../floor-guard.mjs");
const g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A repo with `base` files committed on main and `head` changes (null = delete) committed on a branch. */
function repo(base, head) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devos-fg-"));
  g(dir, "init", "-q", "-b", "main");
  g(dir, "config", "user.email", "t@example.invalid"); g(dir, "config", "user.name", "t");
  const write = (files) => { for (const [p, c] of Object.entries(files)) { const f = path.join(dir, p); if (c === null) fs.rmSync(f); else { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); } } };
  write({ "README.md": "x\n", ...base }); g(dir, "add", "-A"); g(dir, "commit", "-qm", "base");
  g(dir, "switch", "-qc", "pr"); write(head); g(dir, "add", "-A"); g(dir, "commit", "-qm", "head", "--allow-empty");
  return dir;
}
const check = (base, head) => run({ cwd: repo(base, head), base: "main", head: "pr" });
const rules = (r) => r.hits.map((h) => h.rule);

const T = "packages/x/test/a.test.ts";
const testSrc = (body) => `import { it, expect } from "vitest";\nit("a", () => {\n${body}\n});\n`;
const WF = ".github/workflows/ci.yml";
const wf = (steps, extra = "") => `name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest\n${extra}    steps:\n${steps}`;
const STEPS = `      - uses: actions/checkout@v4\n      - name: Lint\n        run: pnpm lint\n      - name: Test\n        run: pnpm test\n`;

const VIOLATIONS = [
  ["test-file-deleted", { [T]: testSrc("expect(1).toBe(1);") }, { [T]: null }],
  ["test-skipped (.skip)", { [T]: testSrc("expect(1).toBe(1);") }, { [T]: testSrc("expect(1).toBe(1);").replace('it("a"', 'it.skip("a"') }],
  ["test-skipped (.only)", { [T]: testSrc("expect(1).toBe(1);") }, { [T]: testSrc("expect(1).toBe(1);").replace('it("a"', 'it.only("a"') }],
  ["test-skipped (.todo)", { [T]: testSrc("expect(1).toBe(1);") }, { [T]: testSrc("expect(1).toBe(1);") + 'it.todo("b");\n' }],
  ["test-skipped (xit)", { [T]: testSrc("expect(1).toBe(1);") }, { [T]: testSrc("expect(1).toBe(1);").replace('it("a"', 'xit("a"') }],
  ["test-skipped (xdescribe)", { [T]: testSrc("expect(1).toBe(1);") }, { [T]: testSrc("expect(1).toBe(1);") + 'xdescribe("d", () => {});\n' }],
  ["test-skipped (describe.skip)", { [T]: testSrc("expect(1).toBe(1);") }, { [T]: testSrc("expect(1).toBe(1);") + 'describe.skip("d", () => {});\n' }],
  ["test-skipped (skipIf)", { [T]: testSrc("expect(1).toBe(1);") }, { [T]: testSrc("expect(1).toBe(1);").replace('it("a"', 'it.skipIf(!process.env.DB)("a"') }],
  ["test-skipped (node:test skip option)", { "scripts/test/b.test.mjs": 'test("a", () => { assert.ok(1); });\n' }, { "scripts/test/b.test.mjs": 'test("a", { skip: !process.env.DB }, () => { assert.ok(1); });\n' }],
  ["test-skipped (early return)", { [T]: testSrc("expect(1).toBe(1);") }, { [T]: testSrc("if (!process.env.DB) return;\nexpect(1).toBe(1);") }],
  ["assertions-lost", { [T]: testSrc("expect(1).toBe(1);\nexpect(2).toBe(2);") }, { [T]: testSrc("expect(1).toBe(1);") }],
  ["coverage-lowered", { "packages/x/vitest.config.ts": "export default { test: { coverage: { thresholds: { lines: 90 } } } };\n" }, { "packages/x/vitest.config.ts": "export default { test: { coverage: { thresholds: { lines: 70 } } } };\n" }],
  ["max-warnings-raised", { "packages/x/package.json": '{ "scripts": { "lint": "eslint . --max-warnings 0" } }\n' }, { "packages/x/package.json": '{ "scripts": { "lint": "eslint . --max-warnings 50" } }\n' }],
  ["timeout-past-ceiling (CI)", { [WF]: wf(STEPS, "    timeout-minutes: 10\n") }, { [WF]: wf(STEPS, "    timeout-minutes: 90\n") }],
  ["timeout-past-ceiling (test)", { "packages/x/vitest.config.ts": "export default { test: { testTimeout: 5000 } };\n" }, { "packages/x/vitest.config.ts": "export default { test: { testTimeout: 600000 } };\n" }],
  ["retries-raised", { "apps/d/playwright.config.ts": "export default { retries: 0 };\n" }, { "apps/d/playwright.config.ts": "export default { retries: 3 };\n" }],
  ["suppression-added (eslint-disable)", { "packages/x/src/a.ts": "export const a = 1;\n" }, { "packages/x/src/a.ts": "// eslint-disable-next-line\nexport const a = 1;\n" }],
  ["suppression-added (@ts-ignore)", { "packages/x/src/a.ts": "export const a = 1;\n" }, { "packages/x/src/a.ts": "// @ts-ignore\nexport const a = 1;\n" }],
  ["suppression-added (@ts-expect-error)", { "packages/x/src/a.ts": "export const a = 1;\n" }, { "packages/x/src/a.ts": "// @ts-expect-error\nexport const a = 1;\n" }],
  ["suppression-added (@ts-nocheck)", { "packages/x/src/a.ts": "export const a = 1;\n" }, { "packages/x/src/a.ts": "// @ts-nocheck\nexport const a = 1;\n" }],
  ["suppression-added (istanbul ignore)", { "packages/x/src/a.ts": "export const a = 1;\n" }, { "packages/x/src/a.ts": "/* istanbul ignore next */\nexport const a = 1;\n" }],
  ["suppression-added (nosec)", { "scripts/a.py": "x = 1\n" }, { "scripts/a.py": "x = 1  # nosec\n" }],
  ["suppression-added (gitleaks:allow)", { "packages/x/src/a.ts": "export const a = 1;\n" }, { "packages/x/src/a.ts": "export const a = 1; // gitleaks:allow\n" }],
  ["gitleaksignore-added", { ".gitleaksignore": "# fingerprints\n" }, { ".gitleaksignore": "# fingerprints\nabc123:src/a.ts:generic-api-key:1\n" }],
  ["ci-step-removed", { [WF]: wf(STEPS) }, { [WF]: wf(STEPS.replace("      - name: Test\n        run: pnpm test\n", "")) }],
  ["ci-job-removed", { [WF]: wf(STEPS) + "  e2e:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm e2e\n" }, { [WF]: wf(STEPS) }],
  ["ci-workflow-deleted", { [WF]: wf(STEPS) }, { [WF]: null }],
  ["ci-trigger-removed (required check no longer reports on PRs)", { [WF]: wf(STEPS) }, { [WF]: wf(STEPS).replace("  pull_request:\n    branches: [main]\n", "") }],
  ["ci-continue-on-error", { [WF]: wf(STEPS) }, { [WF]: wf(STEPS.replace("        run: pnpm test\n", "        run: pnpm test\n        continue-on-error: true\n")) }],
  ["ci-disabled (if: false)", { [WF]: wf(STEPS) }, { [WF]: wf(STEPS.replace("      - name: Test\n", "      - name: Test\n        if: false\n")) }],
  ["failure-swallowed (|| true)", { [WF]: wf(STEPS) }, { [WF]: wf(STEPS.replace("run: pnpm test", "run: pnpm test || true")) }],
  ["failure-swallowed (set +e)", { "scripts/t.sh": "#!/usr/bin/env bash\nset -e\nnode --test\n" }, { "scripts/t.sh": "#!/usr/bin/env bash\nset +e; pnpm test\nnode --test\n" }],
  ["stub-marker", { "packages/x/src/a.ts": "export const a = 1;\n" }, { "packages/x/src/a.ts": "export const a = 1;\n// TODO: real logic\n" }],
  ["stub-marker (not implemented)", { "packages/x/src/a.ts": "export const a = 1;\n" }, { "packages/x/src/a.ts": "export const a = 1;\nexport function b() { throw new Error('not implemented'); }\n" }],
  ["stub-body", { "packages/x/src/a.ts": "export function f(x: number) {\n  const y = x * 2;\n  if (y > 10) return y - 1;\n  return y + 1;\n}\n" }, { "packages/x/src/a.ts": "export function f(x: number) {\n  return 0;\n}\n" }],
  ["contract-weakened", { "docs/modules/M9.md": "# M9\n## Acceptance tests\n| # | Pass when |\n|---|---|\n| AT1 | parses 10 rows |\n| AT2 | rejects bad input |\n" }, { "docs/modules/M9.md": "# M9\n## Acceptance tests\n| # | Pass when |\n|---|---|\n| AT1 | parses rows |\n" }],
  ["contract-weakened (pass rule)", { "docs/modules/M9.md": "# M9\n## Pass rule\n- `pnpm --filter x test` exits 0\n" }, { "docs/modules/M9.md": "# M9\n## Pass rule\n- works as expected\n" }],
  ["test-skipped (fit)", { [T]: testSrc("expect(1).toBe(1);") }, { [T]: testSrc("expect(1).toBe(1);").replace('it("a"', 'fit("a"') }],
  ["test-skipped (fdescribe)", { [T]: testSrc("expect(1).toBe(1);") }, { [T]: testSrc("expect(1).toBe(1);") + 'fdescribe("d", () => {});\n' }],
  ["test-skipped (xtest)", { [T]: testSrc("expect(1).toBe(1);") }, { [T]: testSrc("expect(1).toBe(1);") + 'xtest("d", () => {});\n' }],
  ["test-skipped (runIf)", { [T]: testSrc("expect(1).toBe(1);") }, { [T]: testSrc("expect(1).toBe(1);").replace('it("a"', 'it.runIf(process.env.DB)("a"') }],
  ["test-skipped (test.fixme)", { [T]: testSrc("expect(1).toBe(1);") }, { [T]: testSrc("expect(1).toBe(1);") + 'test.fixme("d", () => {});\n' }],
  ["test-skipped (todo option)", { "scripts/test/b.test.mjs": 'test("a", () => { assert.ok(1); });\n' }, { "scripts/test/b.test.mjs": 'test("a", { todo: "later" }, () => { assert.ok(1); });\n' }],
  ["test-skipped (skip option on its own line)", { "scripts/test/b.test.mjs": 'test("a", () => { assert.ok(1); });\n' }, { "scripts/test/b.test.mjs": 'test(\n  "a",\n  {\n    skip: !process.env.DB,\n  },\n  () => { assert.ok(1); },\n);\n' }],
  ["test-skipped (two-line early return)", { [T]: testSrc("expect(1).toBe(1);") }, { [T]: testSrc("if (!process.env.DB) {\n  return;\n}\nexpect(1).toBe(1);") }],
  ["test-file-deleted (renamed to a non-test path)", { [T]: testSrc("expect(1).toBe(1);") }, { [T]: null, "packages/x/src/old-a.ts": testSrc("expect(1).toBe(1);") }],
  ["trivial-assertion", { [T]: testSrc("expect(f()).toBe(3);") }, { [T]: testSrc("expect(true).toBe(true);") }],
  ["suppression-added (c8 ignore)", { "packages/x/src/a.ts": "export const a = 1;\n" }, { "packages/x/src/a.ts": "/* c8 ignore next */\nexport const a = 1;\n" }],
  ["failure-swallowed (|| exit 0)", { [WF]: wf(STEPS) }, { [WF]: wf(STEPS.replace("run: pnpm lint", "run: pnpm lint || exit 0")) }],
  ["failure-swallowed (|| :)", { [WF]: wf(STEPS) }, { [WF]: wf(STEPS.replace("run: pnpm lint", "run: pnpm lint || :")) }],
  ["max-warnings-raised (removed)", { "packages/x/package.json": '{ "scripts": {\n  "lint": "eslint . --max-warnings 0"\n} }\n' }, { "packages/x/package.json": '{ "scripts": {\n  "lint": "eslint ."\n} }\n' }],
  ["max-warnings-raised (-1 = unlimited)", { "packages/x/package.json": '{ "scripts": { "lint": "eslint . --max-warnings 0" } }\n' }, { "packages/x/package.json": '{ "scripts": { "lint": "eslint . --max-warnings -1" } }\n' }],
  ["retries-raised (new non-zero)", { "apps/d/playwright.config.ts": "export default { use: {} };\n" }, { "apps/d/playwright.config.ts": "export default { retries: 2, use: {} };\n" }],
  ["timeout-past-ceiling (hookTimeout)", { "packages/x/vitest.config.ts": "export default { test: {} };\n" }, { "packages/x/vitest.config.ts": "export default { test: { hookTimeout: 300000 } };\n" }],
  ["coverage-lowered (thresholds removed)", { "packages/x/vitest.config.ts": "export default { test: { coverage: {\n  thresholds: { lines: 90 },\n} } };\n" }, { "packages/x/vitest.config.ts": "export default { test: { coverage: {\n} } };\n" }],
  ["tests-excluded", { "packages/x/vitest.config.ts": "export default { test: {} };\n" }, { "packages/x/vitest.config.ts": "export default { test: { exclude: ['test/slow/**'] } };\n" }],
  ["test-script-changed", { "packages/x/package.json": '{ "scripts": {\n  "test": "vitest run"\n} }\n' }, { "packages/x/package.json": '{ "scripts": {\n  "test": "echo ok"\n} }\n' }],
  ["lint-rule-off", { "packages/x/eslint.config.mjs": "export default [{ rules: {} }];\n" }, { "packages/x/eslint.config.mjs": "export default [{ rules: {\n  \"no-unused-vars\": \"off\",\n} }];\n" }],
  ["ci-step-changed", { [WF]: wf(STEPS) }, { [WF]: wf(STEPS.replace("run: pnpm test", "run: echo ok")) }],
  ["ci-trigger-narrowed (paths filter)", { [WF]: wf(STEPS) }, { [WF]: wf(STEPS).replace("  pull_request:\n    branches: [main]\n", "  pull_request:\n    branches: [main]\n    paths: ['docs/**']\n") }],
  ["ci-trigger-narrowed (branches)", { [WF]: wf(STEPS) }, { [WF]: wf(STEPS).replace("  pull_request:\n    branches: [main]\n", "  pull_request:\n    branches: [nope]\n") }],
  ["ci-trigger-narrowed (types added)", { [WF]: wf(STEPS) }, { [WF]: wf(STEPS).replace("  pull_request:\n    branches: [main]\n", "  pull_request:\n    branches: [main]\n    types: [closed]\n") }],
  // PR70-r9: the same filter line moved from push to an unrestricted pull_request narrows PR runs
  ["ci-trigger-narrowed (filter moved between events)", { [WF]: wf(STEPS).replace("  pull_request:\n    branches: [main]\n", "  pull_request:\n") }, { [WF]: wf(STEPS).replace("  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n", "  push:\n  pull_request:\n    branches: [main]\n") }],
  ["tests-excluded (quoted jest key in package.json)", { "packages/x/package.json": '{ "jest": {\n} }\n' }, { "packages/x/package.json": '{ "jest": {\n  "testPathIgnorePatterns": ["slow"]\n} }\n' }],
  ["lint-rule-off (unquoted key)", { "packages/x/eslint.config.mjs": "export default [{ rules: {} }];\n" }, { "packages/x/eslint.config.mjs": "export default [{ rules: {\n  eqeqeq: 'off',\n} }];\n" }],
  ["lint-rule-off (error to warn)", { "packages/x/eslint.config.mjs": "export default [{ rules: {\n  eqeqeq: 'error',\n} }];\n" }, { "packages/x/eslint.config.mjs": "export default [{ rules: {\n  eqeqeq: 'warn',\n} }];\n" }],
  ["ci-step-changed (action version bump of an unnamed step)", { [WF]: wf(STEPS) }, { [WF]: wf(STEPS.replace("checkout@v4", "checkout@v5")) }],
  ["trivial-assertion (assert.equal of two equal literals)", { "scripts/test/b.test.mjs": 'test("a", () => { assert.equal(result, 1); });\n' }, { "scripts/test/b.test.mjs": 'test("a", () => { assert.equal(1, 1); });\n' }],
  ["ci-step-removed (steps at the same indentation as steps:)", { [WF]: wf(STEPS.replace(/^      /gm, "    ")) }, { [WF]: wf(STEPS.replace(/^      /gm, "    ").replace("    - name: Test\n      run: pnpm test\n", "")) }],
  ["ci-step-changed (steps at the same indentation as steps:)", { [WF]: wf(STEPS.replace(/^      /gm, "    ")) }, { [WF]: wf(STEPS.replace(/^      /gm, "    ").replace("run: pnpm test", "run: echo ok")) }],
  ["ci-step-removed (duplicate step names)", { [WF]: wf("      - name: Check\n        run: pnpm test\n      - name: Check\n        run: pnpm lint\n") }, { [WF]: wf("      - name: Check\n        run: pnpm lint\n") }],
  ["coverage-lowered (perFile turned off)", { "packages/x/vitest.config.ts": "export default { test: { coverage: {\n  perFile: true,\n} } };\n" }, { "packages/x/vitest.config.ts": "export default { test: { coverage: {\n  perFile: false,\n} } };\n" }],
  ["coverage-lowered (perFile removed)", { "packages/x/vitest.config.ts": "export default { test: { coverage: {\n  perFile: true,\n} } };\n" }, { "packages/x/vitest.config.ts": "export default { test: { coverage: {\n} } };\n" }],
  ["test-script-changed (one-line package.json)", { "packages/x/package.json": '{"scripts":{"test":"vitest run"}}\n' }, { "packages/x/package.json": '{"scripts":{"test":"echo ok"}}\n' }],
  ["timeout-past-ceiling (quoted jest key)", { "packages/x/package.json": '{ "jest": {\n} }\n' }, { "packages/x/package.json": '{ "jest": {\n  "testTimeout": 600000\n} }\n' }],
  ["coverage-lowered (per-path threshold on one line)", { "packages/x/vitest.config.ts": "export default { test: { coverage: { thresholds: { lines: 80, 'src/**': { lines: 95 } } } } };\n" }, { "packages/x/vitest.config.ts": "export default { test: { coverage: { thresholds: { lines: 80, 'src/**': { lines: 90 } } } } };\n" }],
  ["max-warnings-raised (second limit on a line removed)", { "packages/x/vitest.config.ts": 'execSync("eslint a --max-warnings 0"); execSync("eslint b --max-warnings 0");\n' }, { "packages/x/vitest.config.ts": 'execSync("eslint a --max-warnings 0"); execSync("eslint b");\n' }],
  ["contract-weakened (subsection of Acceptance tests)", { "docs/modules/M9.md": "# M9\n## Acceptance tests\n### Validation\n- AT1 rejects bad ids\n" }, { "docs/modules/M9.md": "# M9\n## Acceptance tests\n### Validation\n" }],
  ["coverage-lowered (vitest.config.mts)", { "packages/x/vitest.config.mts": "export default { test: { coverage: { thresholds: { lines: 90 } } } };\n" }, { "packages/x/vitest.config.mts": "export default { test: { coverage: { thresholds: { lines: 70 } } } };\n" }],
  ["coverage-lowered (switch off in a test file, coverage key unchanged)", { [T]: testSrc("const opts = {\n  coverage: {\n    enabled: true,\n  },\n};\nexpect(opts).toBeTruthy();") }, { [T]: testSrc("const opts = {\n  coverage: {\n    enabled: false,\n  },\n};\nexpect(opts).toBeTruthy();") }],
  ["test-skipped (return added inside an existing env block)", { [T]: testSrc("if (!process.env.DB) {\n  console.log('no db');\n}\nexpect(1).toBe(1);") }, { [T]: testSrc("if (!process.env.DB) {\n  return;\n  console.log('no db');\n}\nexpect(1).toBe(1);") }],
  ["ci-step-changed (run line re-indented under if False)", { [WF]: wf("      - uses: actions/checkout@v4\n      - name: Py\n        run: |\n          python - <<'PY'\n          import subprocess\n          if False:\n              pass\n          subprocess.run(['pnpm', 'test'])\n          PY\n") }, { [WF]: wf("      - uses: actions/checkout@v4\n      - name: Py\n        run: |\n          python - <<'PY'\n          import subprocess\n          if False:\n              pass\n              subprocess.run(['pnpm', 'test'])\n          PY\n") }],
  ["test-file-deleted (non-JS suffix test)", { "checks/security.test.py": "def test_a():\n    assert True\n" }, { "checks/security.test.py": null }],
  ["ci-step-changed (nested with: name changed)", { [WF]: wf("      - uses: actions/checkout@v4\n      - name: Get\n        uses: actions/download-artifact@v4\n        with:\n          name: artifact-a\n") }, { [WF]: wf("      - uses: actions/checkout@v4\n      - name: Get\n        uses: actions/download-artifact@v4\n        with:\n          name: artifact-b\n") }],
  ["coverage-lowered (one of two equal switches on a line turned off)", { "packages/x/vitest.config.ts": "export default [{ test: { coverage: { enabled: true } } }, { test: { coverage: { enabled: true } } }];\n" }, { "packages/x/vitest.config.ts": "export default [{ test: { coverage: { enabled: true } } }, { test: { coverage: { enabled: false } } }];\n" }],
  ["retries-raised (second project on one line)", { "apps/d/playwright.config.ts": "export default { projects: [{ name: 'a', retries: 3 }, { name: 'b', retries: 0 }] };\n" }, { "apps/d/playwright.config.ts": "export default { projects: [{ name: 'a', retries: 3 }, { name: 'b', retries: 1 }] };\n" }],
  ["coverage-lowered (second switch on one line)", { "packages/x/vitest.config.ts": "export default { test: { coverage: { enabled: true, all: true } } };\n" }, { "packages/x/vitest.config.ts": "export default { test: { coverage: { enabled: true, all: false } } };\n" }],
  ["lint-rule-off (quoted ignores key)", { "packages/x/eslint.config.mjs": "export default [];\n" }, { "packages/x/eslint.config.mjs": 'export default [{ "ignores": ["**/*"] }];\n' }],
  ["gitattributes-changed", { "packages/x/src/a.ts": "export const a = 1;\n" }, { ".gitattributes": "*.ts binary\n", "packages/x/src/a.ts": "export const a = 2;\n" }],
  ["contract-weakened (Green section)", { "docs/modules/M9.md": "# M9\n## Green\n- GC1: x exits 1\n" }, { "docs/modules/M9.md": "# M9\n## Green\n- GC1: x runs\n" }],
  ["contract-weakened (moved out of docs/modules)", { "docs/modules/M9.md": "# M9\n## Acceptance tests\n| AT1 | a |\n" }, { "docs/modules/M9.md": null, "docs/old/M9.md": "# M9\n## Acceptance tests\n| AT1 | a |\n" }],
  ["contract-weakened (line starting with --)", { "docs/modules/M9.md": "# M9\n## Acceptance tests\n-- AT1 must parse\n" }, { "docs/modules/M9.md": "# M9\n## Acceptance tests\n" }],
  ["policy-weakened (rules file)", { "packages/policy/rules/base.json": '{ "id": "r1", "effect": "require_approval" }\n' }, { "packages/policy/rules/base.json": "\n" }],
  ["policy-weakened (file deleted)", { "packages/policy/src/evaluator.ts": "export const x = 1;\n" }, { "packages/policy/src/evaluator.ts": null }],
  ["policy-weakened", { "packages/policy/src/evaluator.ts": "const deny = matched.find((r) => r.effect === \"deny\");\nconst outcome = deny ? \"deny\" : \"allow\";\n" }, { "packages/policy/src/evaluator.ts": "const outcome = \"allow\";\n" }],
];

for (const [name, base, head] of VIOLATIONS) {
  test(`exit 1: ${name}`, () => {
    const r = check(base, head);
    assert.equal(r.exit, 1, JSON.stringify(r));
    assert.ok(rules(r).includes(name.split(" ")[0]), `${name}: got ${rules(r)}`);
    for (const h of r.hits) assert.match(h.id, /^fg-[0-9a-f]{10}$/);
  });
}

test("exit 0: a clean diff (new code, new tests, more assertions, a contract row added, a timeout within the ceiling)", () => {
  const r = check(
    { [T]: testSrc("expect(1).toBe(1);"), [WF]: wf(STEPS, "    timeout-minutes: 10\n"), "docs/modules/M9.md": "# M9\n## Acceptance tests\n| AT1 | a |\n", "packages/x/src/a.ts": "export const a = 1;\n" },
    { [T]: testSrc("expect(1).toBe(1);\nexpect(2).toBe(2);"), [WF]: wf(STEPS + "      - name: Build\n        run: pnpm build\n", "    timeout-minutes: 20\n"),
      "docs/modules/M9.md": "# M9\n## Acceptance tests\n| AT1 | a |\n| AT2 | b |\n", "packages/x/src/a.ts": "export const a = 1;\nexport const b = () => a + 1;\n", "packages/x/test/b.test.ts": testSrc("expect(2).toBe(2);") },
  );
  assert.deepEqual(r.hits, []);
  assert.equal(r.exit, 0);
});

test("exit 0: a test file renamed to another test file is not a deletion; a new contract is free to write", () => {
  const r = check({ [T]: testSrc("expect(1).toBe(1);") }, { [T]: null, "packages/x/test/renamed.test.ts": testSrc("expect(1).toBe(1);"), "docs/modules/M10.md": "# M10\n## Acceptance tests\n| AT1 | x |\n" });
  assert.deepEqual(r.hits, []);
});

test("exit 0: a non-env early return in a test helper, and || true on a non-test shell line", () => {
  const r = check({ [T]: testSrc("expect(1).toBe(1);"), "scripts/s.sh": "x=1\n" },
    { [T]: testSrc("const m = (o) => { if (o.hang) return; };\nexpect(1).toBe(1);"), "scripts/s.sh": "x=1\nv=\"$(sed -n 1p f 2>/dev/null || true)\"\n" });
  assert.deepEqual(r.hits, []);
});

test("exit 0: a trivial assertion only moved or re-indented is not new", () => {
  const r = check({ [T]: testSrc("expect(f()).toBe(3);\n  expect(null).toBe(g());") }, { [T]: testSrc("expect(null).toBe(g());\nexpect(f()).toBe(3);") });
  assert.deepEqual(r.hits, []);
});

test("exit 2: an unknown head ref (could not run) is never clean", () => {
  const r = run({ cwd: repo({}, {}), base: "main", head: "no-such-ref" });
  assert.equal(r.exit, 2); assert.match(r.error, /git rev-parse/);
});

test("exit 2: not a git repository, and missing arguments", () => {
  assert.equal(run({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), "devos-fg-nogit-")), base: "main", head: "HEAD" }).exit, 2);
  assert.equal(run({ cwd: repo({}, {}), base: "main" }).exit, 2);
});

test("exit 2: an unreadable diff throws a GuardError (parseDiff)", () => {
  assert.throws(() => parseDiff("garbage before any header\n"), /unreadable diff/);
  assert.throws(() => parseDiff("diff --git a/x b/x\n@@ nonsense @@\n"), /unreadable hunk/);
});

test("guard isolation: a guard change beside any other change is a hit; alone (plus a decision note) it is not", () => {
  const mixed = check({ "scripts/floor-guard/floor-guard.mjs": "a\n" }, { "scripts/floor-guard/floor-guard.mjs": "b\n", "packages/x/src/a.ts": "export const a = 2;\n" });
  assert.ok(rules(mixed).includes("guard-change-not-isolated"));
  const alone = check({ "scripts/floor-guard/floor-guard.mjs": "a\n" }, { "scripts/floor-guard/floor-guard.mjs": "b // @ts-ignore\n", "docs/decisions/0099-x.md": "note\n" });
  assert.deepEqual(alone.hits, []);
});

test("dispositions: Keep only from a Codex verdict on the same SHA naming id and file:line; a new SHA voids it", () => {
  const r = check({ [T]: testSrc("expect(1).toBe(1);") }, { [T]: testSrc("expect(1).toBe(1);").replace('it("a"', 'it.skip("a"') });
  const [h] = r.hits;
  const keep = `FLOOR-GUARD KEEP ${h.id} ${h.file}:${h.line} flaky upstream, tracked in DEVOS-1`;
  assert.deepEqual(applyDispositions(r, { sha: r.sha, source: "codex", text: keep }), { exit: 0, open: [] });
  assert.equal(applyDispositions(r, { sha: "0".repeat(40), source: "codex", text: keep }).exit, 1, "other SHA");
  assert.equal(applyDispositions(r, { sha: r.sha, source: "builder", text: keep }).exit, 1, "the Builder cannot dispose of its own hit");
  assert.equal(applyDispositions(r, { sha: r.sha, source: "codex", text: `FLOOR-GUARD KEEP ${h.id} ${h.file}:${h.line + 1}` }).exit, 1, "wrong line");
  assert.equal(applyDispositions({ ...r, exit: 2 }, { sha: r.sha, source: "codex", text: keep }).exit, 2, "exit 2 cannot be disposed of");
});

test("workflowShape reads jobs, step identities and triggers", () => {
  const s = workflowShape(wf(STEPS));
  assert.deepEqual(s.jobs, { build: ["uses:actions/checkout", "name:Lint", "name:Test"] });
  assert.ok(s.on.includes("pull_request") && s.on.includes("push"));
});

test("binary attribute cannot hide a skip: .gitattributes in the head is ignored for the diff and is itself a hit", () => {
  const r = check({ [T]: testSrc("expect(1).toBe(1);") }, { ".gitattributes": "*.ts binary\n", [T]: testSrc("expect(1).toBe(1);").replace('it("a"', 'it.skip("a"') });
  assert.ok(rules(r).includes("test-skipped") && rules(r).includes("gitattributes-changed"), String(rules(r)));
});

test("CLI: run through a symlinked path still exits 2 on an unknown ref (never a silent 0)", () => {
  const dir = repo({}, {});
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "devos-fg link ")), "guard.mjs");
  fs.symlinkSync(GUARD, link);
  assert.equal(spawnSync(process.execPath, [link, "--base", "main", "--head", "nope"], { cwd: dir }).status, 2);
});

test("CLI: exit codes, HIT lines and the JSON report", () => {
  const dir = repo({ [T]: testSrc("expect(1).toBe(1);") }, { [T]: testSrc("expect(1).toBe(1);").replace('it("a"', 'it.skip("a"') });
  const out = path.join(dir, "report.json");
  const r = spawnSync(process.execPath, [GUARD, "--base", "main", "--head", "pr", "--report", out], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stdout, /HIT fg-[0-9a-f]{10} test-skipped packages\/x\/test\/a\.test\.ts:2/);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).hits.length, 1);
  const bad = spawnSync(process.execPath, [GUARD, "--base", "main", "--head", "nope"], { cwd: dir, encoding: "utf8" });
  assert.equal(bad.status, 2); assert.match(bad.stderr, /could not run/);
  g(dir, "switch", "-q", "main");
  assert.equal(spawnSync(process.execPath, [GUARD, "--base", "main", "--head", "main"], { cwd: dir }).status, 0);
});

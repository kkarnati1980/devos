// CI-T-b (DEVOS-152): ci-gate acceptance tests AT1–AT5 (docs/modules/CI-T-b.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { evaluate, expectedChecks, expectedFromWorkflow, expectedUnion, GateError, listRuns, waitForChecks } from "../ci/ci-gate.mjs";

const run = (id, name, status, conclusion, suite = `s-${name}`) => ({ id, name, status, conclusion, suite });
const wf = (pr, jobs = { a: { "runs-on": "x" } }) => ({ on: { pull_request: pr }, jobs });

test("AT1: every expected check succeeded passes; any failure, cancel, timeout or skip fails at once", () => {
  const ok = [run(1, "a", "completed", "success"), run(2, "b", "completed", "success")];
  assert.equal(evaluate(["a", "b"], ok).state, "success");
  for (const c of ["failure", "cancelled", "timed_out", "skipped", "neutral", "action_required", "stale", null]) {
    const v = evaluate(["a", "b"], [run(1, "a", "completed", c), run(2, "b", "in_progress", null)]);
    assert.equal(v.state, "failure", `conclusion ${c} must fail`);
    assert.deepEqual(v.failed, [`a=${c}`]);
  }
});

test("AT2: a check that has not reported keeps the gate waiting; past the deadline it fails", async () => {
  assert.equal(evaluate(["a", "b"], [run(1, "a", "completed", "success")]).state, "pending");
  assert.equal(evaluate(["a"], [run(1, "a", "queued", null)]).state, "pending");
  let t = 0;
  const v = await waitForChecks({ expected: ["a", "b"], read: async () => [run(1, "a", "completed", "success")], deadlineMs: 60_000, intervalMs: 20_000, now: () => t, sleep: async (ms) => { t += ms; } });
  assert.equal(v.state, "failure");
  assert.deepEqual(v.failed, ["b=not-finished-in-time"]);
  // It finishes as soon as the last check passes.
  let reads = 0;
  const w = await waitForChecks({ expected: ["a"], read: async () => (++reads < 3 ? [run(1, "a", "in_progress", null)] : [run(1, "a", "completed", "success")]), deadlineMs: 60_000, intervalMs: 1, now: () => 0, sleep: async () => {} });
  assert.equal(w.state, "success");
  assert.equal(reads, 3);
});

test("AT3: path filters, types, job if:, matrices, reusable workflows and branch globs fail closed", () => {
  const bad = [
    wf({ branches: ["main"], paths: ["apps/**"] }),
    wf({ "paths-ignore": ["docs/**"] }),
    wf({ types: ["labeled"] }),
    wf({}, { a: { "runs-on": "x", if: "github.actor == 'x'" } }),
    wf({}, { a: { "runs-on": "x", strategy: { matrix: { n: [1, 2] } } } }),
    wf({}, { a: { uses: "./.github/workflows/x.yml" } }),
    wf({}, { a: { "runs-on": "x", name: "build ${{ matrix.n }}" } }),
    wf({ branches: ["release/*"] }),
  ];
  for (const w of bad) assert.throws(() => expectedFromWorkflow("x.yml", w, "main"), GateError);
});

test("AT4: the newest run of a re-run check counts", () => {
  assert.equal(evaluate(["a"], [run(5, "a", "completed", "failure"), run(9, "a", "completed", "success")]).state, "success");
  assert.equal(evaluate(["a"], [run(9, "a", "completed", "failure"), run(5, "a", "completed", "success")]).state, "failure");
  assert.equal(evaluate(["a"], [run(5, "a", "completed", "success"), run(9, "a", "in_progress", null)]).state, "pending");
});

test("AT5: the gate never expects itself; push-only and other-branch workflows are not expected; checks are named by job name or id", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-gate-"));
  writeFileSync(join(dir, "ci-gate.yml"), "on:\n  pull_request:\njobs:\n  ci-gate:\n    runs-on: x\n");
  writeFileSync(join(dir, "push.yml"), "on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: x\n");
  writeFileSync(join(dir, "other.yml"), "on:\n  pull_request:\n    branches: [release]\njobs:\n  rel:\n    runs-on: x\n");
  writeFileSync(join(dir, "ci.yml"), "on:\n  pull_request:\n    branches: [main]\njobs:\n  build:\n    runs-on: x\n  named:\n    name: Lint all\n    runs-on: x\n");
  writeFileSync(join(dir, "list.yml"), "on: [push, pull_request]\njobs:\n  e2e:\n    runs-on: x\n");
  assert.deepEqual(expectedChecks(dir, "main"), ["build", "Lint all", "e2e"]);
  assert.deepEqual(expectedFromWorkflow("x.yml", wf({ "branches-ignore": ["main"] }), "main"), []);
  // An empty set or two jobs with one check name are errors, never a pass.
  const empty = mkdtempSync(join(tmpdir(), "ci-gate-"));
  assert.throws(() => expectedChecks(empty, "main"), GateError);
  writeFileSync(join(dir, "dup.yml"), "on: pull_request\njobs:\n  build:\n    runs-on: x\n");
  assert.throws(() => expectedChecks(dir, "main"), /same check name: build/);
});

test("the repo's own workflows parse: every PR job is expected, and the gate is not", () => {
  const names = expectedChecks(".github/workflows", "main");
  // Exact list: adding or renaming a PR check must update this test (and the ruleset notes) on purpose.
  assert.deepEqual([...names].sort(), ["api-db", "build", "compose-smoke", "dashboard-e2e", "db", "licence-check", "linear-sync-db", "policy-db", "provision-db", "run-engine-db", "secret-scan", "security-selftest", "teardown-db", "vuln-scan"]);
  assert.ok(!names.includes("ci-gate"));
});

test("CLI: missing inputs or a bad workflow exit 2, never 0", () => {
  const exit = (env) => {
    try {
      execFileSync(process.execPath, ["scripts/ci/ci-gate.mjs"], { env: { PATH: process.env.PATH, ...env }, stdio: "pipe" });
      return 0;
    } catch (e) {
      return e.status;
    }
  };
  assert.equal(exit({}), 2);
  const dir = mkdtempSync(join(tmpdir(), "ci-gate-"));
  mkdirSync(join(dir, "wf"));
  writeFileSync(join(dir, "wf", "a.yml"), "on:\n  pull_request:\n    paths: [x]\njobs:\n  a:\n    runs-on: x\n");
  assert.equal(exit({ GITHUB_REPOSITORY: "o/r", GATE_SHA: "a".repeat(40), GATE_BASE: "main", GITHUB_TOKEN: "t", GATE_WORKFLOWS_DIR: join(dir, "wf") }), 2);
});

test("AT7: a PR that deletes or narrows a check main runs fails at once; added checks are expected", () => {
  const base = mkdtempSync(join(tmpdir(), "ci-gate-base-"));
  const head = mkdtempSync(join(tmpdir(), "ci-gate-head-"));
  writeFileSync(join(base, "sec.yml"), "on: pull_request\njobs:\n  secret-scan:\n    runs-on: x\n");
  writeFileSync(join(base, "ci.yml"), "on: pull_request\njobs:\n  build:\n    runs-on: x\n");
  writeFileSync(join(head, "ci.yml"), "on: pull_request\njobs:\n  build:\n    runs-on: x\n  extra:\n    runs-on: x\n");
  writeFileSync(join(head, "sec.yml"), "on:\n  pull_request:\n    branches: [release]\njobs:\n  secret-scan:\n    runs-on: x\n");
  assert.throws(() => expectedUnion(base, head, "main"), /removes or narrows checks main runs: secret-scan/);
  writeFileSync(join(head, "sec.yml"), "on: pull_request\njobs:\n  secret-scan:\n    runs-on: x\n");
  assert.deepEqual(expectedUnion(base, head, "main"), ["build", "extra", "secret-scan"]);
  assert.throws(() => expectedUnion(join(base, "missing"), head, "main"), GateError);
});

test("AT8: check runs are read page by page, only from GitHub Actions, with bounded retries that fail closed", async () => {
  const mk = (id, name, slug = "github-actions") => ({ id, name, status: "completed", conclusion: "success", app: { slug } });
  const pages = { 1: Array.from({ length: 100 }, (_, i) => mk(i + 1, `j${i}`)), 2: [mk(101, "last"), mk(102, "secret-scan", "evil-app")] };
  const urls = [];
  const ok = async (url) => { urls.push(url); const p = Number(new URL(url).searchParams.get("page")); return { ok: true, status: 200, json: async () => ({ total_count: 102, check_runs: pages[p] }) }; };
  const runs = await listRuns("https://api.example", "o/r", "a".repeat(40), "t", ok, async () => {});
  assert.equal(runs.length, 101, "the other app's run is ignored");
  assert.ok(!runs.some((r) => r.name === "secret-scan"));
  assert.equal(urls.length, 2);
  let calls = 0;
  const flaky = async () => (++calls < 3 ? { ok: false, status: 502 } : { ok: true, status: 200, json: async () => ({ total_count: 1, check_runs: [mk(1, "a")] }) });
  assert.equal((await listRuns("https://api.example", "o/r", "s", "t", flaky, async () => {})).length, 1);
  calls = 0;
  const down = async () => { calls++; throw new Error("reset"); };
  await assert.rejects(listRuns("https://api.example", "o/r", "s", "t", down, async () => {}), GateError);
  assert.equal(calls, 3, "three attempts, then exit 2");
  calls = 0;
  const denied = async () => { calls++; return { ok: false, status: 403 }; };
  await assert.rejects(listRuns("https://api.example", "o/r", "s", "t", denied, async () => {}), /HTTP 403/);
  assert.equal(calls, 1, "a 4xx is not retried");
});

test("AT9: run through a symlinked path with a space, the CLI still runs main() and exits 2 on missing inputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci gate %20 "));
  cpSync("scripts/ci/ci-gate.mjs", join(dir, "real.mjs"));
  symlinkSync(join(process.cwd(), "node_modules"), join(dir, "node_modules"));
  symlinkSync(join(dir, "real.mjs"), join(dir, "link.mjs"));
  let status = 0;
  try {
    execFileSync(process.execPath, [join(dir, "link.mjs")], { env: { PATH: process.env.PATH }, stdio: "pipe" });
  } catch (e) {
    status = e.status;
  }
  assert.equal(status, 2);
});

test("AT10: a same-named run from another workflow run (check suite) never stands in for the real check", () => {
  const real = run(5, "secret-scan", "completed", "failure", "suite-security");
  const fake = run(9, "secret-scan", "completed", "success", "suite-push");
  const v = evaluate(["secret-scan"], [real, fake]);
  assert.equal(v.state, "failure");
  assert.deepEqual(v.failed, ["secret-scan=reported-by-more-than-one-workflow-run"]);
  // A re-run inside the same workflow run keeps its suite and is fine.
  assert.equal(evaluate(["secret-scan"], [real, run(9, "secret-scan", "completed", "success", "suite-security")]).state, "success");
});

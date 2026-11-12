// CI-T-b (DEVOS-152): ci-gate acceptance tests AT1–AT5 (docs/modules/CI-T-b.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { attributeRuns, checkOwners, evaluate, expectedChecks, expectedFromWorkflow, expectedUnion, GateError, listPrWorkflowRuns, listRuns, waitForChecks } from "../ci/ci-gate.mjs";

const run = (id, name, status, conclusion, suite = `s-${name}`, workflow = "w.yml") => ({ id, name, status, conclusion, suite, workflow });
// Every expected name owned by w.yml, the workflow file `run()` attributes to by default.
const own = (names) => new Map(names.map((n) => [n, "w.yml"]));
const wf = (pr, jobs = { a: { "runs-on": "x" } }) => ({ on: { pull_request: pr }, jobs });

test("AT1: every expected check succeeded passes; any failure, cancel, timeout or skip fails at once", () => {
  const ok = [run(1, "a", "completed", "success"), run(2, "b", "completed", "success")];
  assert.equal(evaluate(["a", "b"], ok, own(["a", "b"])).state, "success");
  for (const c of ["failure", "cancelled", "timed_out", "skipped", "neutral", "action_required", "stale", null]) {
    const v = evaluate(["a", "b"], [run(1, "a", "completed", c), run(2, "b", "in_progress", null)], own(["a", "b"]));
    assert.equal(v.state, "failure", `conclusion ${c} must fail`);
    assert.deepEqual(v.failed, [`a=${c}`]);
  }
});

test("AT2: a check that has not reported keeps the gate waiting; past the deadline it fails", async () => {
  assert.equal(evaluate(["a", "b"], [run(1, "a", "completed", "success")], own(["a", "b"])).state, "pending");
  assert.equal(evaluate(["a"], [run(1, "a", "queued", null)], own(["a"])).state, "pending");
  let t = 0;
  const v = await waitForChecks({ expected: ["a", "b"], owners: own(["a", "b"]), read: async () => [run(1, "a", "completed", "success")], deadlineMs: 60_000, intervalMs: 20_000, now: () => t, sleep: async (ms) => { t += ms; } });
  assert.equal(v.state, "failure");
  assert.deepEqual(v.failed, ["b=not-finished-in-time"]);
  // It finishes as soon as the last check passes.
  let reads = 0;
  const w = await waitForChecks({ expected: ["a"], owners: own(["a"]), read: async () => (++reads < 3 ? [run(1, "a", "in_progress", null)] : [run(1, "a", "completed", "success")]), deadlineMs: 60_000, intervalMs: 1, now: () => 0, sleep: async () => {} });
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
  assert.equal(evaluate(["a"], [run(5, "a", "completed", "failure"), run(9, "a", "completed", "success")], own(["a"])).state, "success");
  assert.equal(evaluate(["a"], [run(9, "a", "completed", "failure"), run(5, "a", "completed", "success")], own(["a"])).state, "failure");
  assert.equal(evaluate(["a"], [run(5, "a", "completed", "success"), run(9, "a", "in_progress", null)], own(["a"])).state, "pending");
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
  // Codex PR73-r3: an absent or empty base input fails closed instead of skipping the base comparison.
  for (const missing of [undefined, "", "   "]) assert.throws(() => expectedUnion(missing, head, "main"), /GATE_BASE_WORKFLOWS_DIR .* is required/);
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
  assert.ok(urls.every((u) => new URL(u).searchParams.get("filter") === "all"), "every run is read, not only the latest per name (PR73-r1)");
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

test("AT10: two PR workflow runs of the owning file on one SHA fail the name; a re-run in the same suite counts", () => {
  const real = run(5, "secret-scan", "completed", "failure", "suite-security");
  const again = run(9, "secret-scan", "completed", "success", "suite-reopened");
  const v = evaluate(["secret-scan"], [real, again], own(["secret-scan"]));
  assert.equal(v.state, "failure");
  assert.deepEqual(v.failed, ["secret-scan=reported-by-more-than-one-workflow-run"]);
  // A re-run inside the same workflow run keeps its suite and is fine.
  assert.equal(evaluate(["secret-scan"], [real, run(9, "secret-scan", "completed", "success", "suite-security")], own(["secret-scan"])).state, "success");
});

test("AT11 (Codex PR73-r4): an unrelated workflow's same-named run never satisfies, or blocks, the expected check", () => {
  const owners = new Map([["secret-scan", "security.yml"]]);
  // A push-only workflow (no PR workflow run, so workflow=null) reports success before the PR check exists.
  const pushFirst = run(3, "secret-scan", "completed", "success", "suite-push", null);
  assert.equal(evaluate(["secret-scan"], [pushFirst], owners).state, "pending");
  // Another PR workflow file with a job of the same name does not count either.
  const otherPr = run(4, "secret-scan", "completed", "success", "suite-other", "other.yml");
  assert.equal(evaluate(["secret-scan"], [pushFirst, otherPr], owners).state, "pending");
  // The real PR check decides: its failure fails the gate even though the unrelated runs succeeded …
  const realFail = run(5, "secret-scan", "completed", "failure", "suite-security", "security.yml");
  assert.deepEqual(evaluate(["secret-scan"], [pushFirst, otherPr, realFail], owners).failed, ["secret-scan=failure"]);
  // … and its success passes, with the unrelated runs ignored rather than flagged.
  const realOk = run(5, "secret-scan", "completed", "success", "suite-security", "security.yml");
  assert.equal(evaluate(["secret-scan"], [pushFirst, realOk], owners).state, "success");
  // An expected name no workflow owns, or a missing map, is an error, never a pass.
  assert.throws(() => evaluate(["secret-scan"], [realOk], new Map()), GateError);
  assert.throws(() => evaluate(["secret-scan"], [realOk]), GateError);
});

test("AT12 (Codex PR73-r4): check runs are tied to the head SHA's pull_request workflow runs", async () => {
  const sha = "b".repeat(40);
  const wr = (suite, path, event = "pull_request", head = sha) => ({ check_suite_id: suite, path, event, head_sha: head });
  const urls = [];
  const fetchOk = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => ({ total_count: 4, workflow_runs: [wr(11, ".github/workflows/security.yml"), wr(12, ".github/workflows/deploy.yml", "push"), wr(13, ".github/workflows/ci.yml", "pull_request", "c".repeat(40)), wr(14, ".github/workflows/ci.yml@refs/heads/main")] }) };
  };
  const suites = await listPrWorkflowRuns("https://api.example", "o/r", sha, "t", fetchOk, async () => {});
  assert.deepEqual([...suites.entries()], [["11", "security.yml"], ["14", "ci.yml"]], "push runs and other SHAs are dropped");
  const q = new URL(urls[0]).searchParams;
  assert.equal(q.get("head_sha"), sha);
  assert.equal(q.get("event"), "pull_request");
  const tagged = attributeRuns([run(1, "secret-scan", "completed", "success", 11, undefined), run(2, "secret-scan", "completed", "success", 12, undefined)], suites);
  assert.deepEqual(tagged.map((r) => r.workflow), ["security.yml", null]);
  // Paging past 100 runs, with a 5xx retried on the way.
  let n = 0;
  const paged = async (url) => {
    if (++n === 1) return { ok: false, status: 502 };
    const p = Number(new URL(url).searchParams.get("page"));
    const list = p === 1 ? Array.from({ length: 100 }, (_, i) => wr(100 + i, `.github/workflows/w${i}.yml`)) : [wr(999, ".github/workflows/last.yml")];
    return { ok: true, status: 200, json: async () => ({ total_count: 101, workflow_runs: list }) };
  };
  const many = await listPrWorkflowRuns("https://api.example", "o/r", sha, "t", paged, async () => {});
  assert.equal(many.size, 101);
  assert.equal(many.get("999"), "last.yml");
  // A bad body or a 4xx fails closed (exit 2).
  await assert.rejects(listPrWorkflowRuns("https://api.example", "o/r", sha, "t", async () => ({ ok: true, status: 200, json: async () => ({}) }), async () => {}), GateError);
  await assert.rejects(listPrWorkflowRuns("https://api.example", "o/r", sha, "t", async () => ({ ok: false, status: 403 }), async () => {}), /workflow-runs read failed: HTTP 403/);
  // checkOwners maps each expected name to its file; the repo's real set is owned file by file.
  const owners = checkOwners(".github/workflows", "main");
  assert.equal(owners.size, 14);
  assert.ok([...owners.values()].every((f) => /\.ya?ml$/.test(f) && f !== "ci-gate.yml"));
});

// GI-3 (DEVOS-143): the Release merge path refuses unless CI is green, Codex PASSed and main is in the head,
// all on the PR's current head SHA, and merges pinned to that SHA (docs/modules/GI-3.md, AT1–AT9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, githubClient, main, release } from "../release/merge.mjs";

const REPO = "kkarnati1980/devos";
const HEAD = "a".repeat(40);
const MAIN = "b".repeat(40);
const OLD = "d".repeat(40);
const TOKEN = "ghp_" + "X".repeat(36);
const WATCHER = { login: "kkarnati1980" };

// A fake GitHub. `state` is mutated per test; every request is recorded.
function fakeGitHub(over = {}) {
  const state = {
    pr: { number: 7, state: "open", draft: false, merged: false, base: { ref: "main" }, head: { sha: HEAD, repo: { full_name: REPO } } },
    checkRuns: [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "e2e", status: "completed", conclusion: "skipped" },
    ],
    statuses: [{ context: "codex-review", state: "success", description: "Codex PASS (PR7-r2)", creator: WATCHER, updated_at: "2026-11-12T10:00:00Z" }],
    workflowRuns: [
      { id: 11, workflow_id: 1, name: "ci", run_number: 5, status: "completed", conclusion: "cancelled" },
      { id: 12, workflow_id: 1, name: "ci", run_number: 6, status: "completed", conclusion: "success" },
      { id: 13, workflow_id: 2, name: "db", run_number: 3, status: "completed", conclusion: "success" },
    ],
    oldShaStatuses: [{ context: "codex-review", state: "success", description: "Codex PASS (PR7-r1)", creator: WATCHER }],
    mainSha: MAIN,
    compare: "ahead",
    mergeStatus: 200,
    ...over,
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace("https://api.github.com", "");
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.authorization, hasSignal: !!init.signal });
    const reply = (status, json) => ({ status, text: async () => JSON.stringify(json) });
    if (state.fail5xx && init.method === "GET" && state.fail5xx-- > 0) return reply(502, {});
    if (path === `/repos/${REPO}/pulls/7` && init.method === "GET") return reply(200, state.pr);
    if (path.startsWith(`/repos/${REPO}/commits/${HEAD}/check-runs`)) {
      const page = Number(new URL(url).searchParams.get("page"));
      const slice = state.checkRuns.slice((page - 1) * 100, page * 100);
      return reply(200, { total_count: state.checkRuns.length, check_runs: slice });
    }
    if (path.startsWith(`/repos/${REPO}/commits/${HEAD}/status`)) return reply(200, { total_count: state.statuses.length, statuses: state.statuses });
    if (path.startsWith(`/repos/${REPO}/commits/${OLD}/status`)) return reply(200, { total_count: 1, statuses: state.oldShaStatuses });
    if (path.startsWith(`/repos/${REPO}/actions/runs?head_sha=${HEAD}`)) return reply(200, { total_count: state.workflowRuns.length, workflow_runs: state.workflowRuns });
    if (path === `/repos/${REPO}/git/ref/heads/main`) return reply(200, { object: { sha: state.mainSha } });
    if (path === `/repos/${REPO}/compare/${MAIN}...${HEAD}`) return reply(200, { status: state.compare });
    if (path === `/repos/${REPO}/pulls/7/merge` && init.method === "PUT") {
      if (state.putThrows) { if (state.putThrows === "merged") state.pr = { ...state.pr, merged: true, state: "closed", merge_commit_sha: "e".repeat(40) }; throw new TypeError("socket hang up"); }
      return state.mergeStatus === 200 ? reply(200, { merged: true, sha: "c".repeat(40) }) : reply(state.mergeStatus, { message: "Head branch was modified" });
    }
    return reply(404, { message: "not found" });
  };
  return { state, calls, fetchImpl, gh: githubClient({ token: TOKEN, fetchImpl, retries: 2 }) };
}

const run = (f, extra = {}) => release(f.gh, { repo: REPO, pr: 7, ...extra });
const merges = (f) => f.calls.filter((c) => c.method === "PUT");

test("AT1 all green: merges once, pinned to the evaluated head SHA, merge method merge", async () => {
  const f = fakeGitHub();
  const r = await run(f);
  assert.equal(r.code, 0);
  assert.deepEqual(merges(f).map((c) => c.body), [{ sha: HEAD, merge_method: "merge" }]);
});

test("AT2 no Codex PASS (missing, CHANGES_REQUESTED, pending, or a PASS labelled for another PR): refused, no merge", async () => {
  const cases = [
    [],
    [{ context: "codex-review", state: "failure", description: "Codex CHANGES_REQUESTED (PR7-r2)", creator: WATCHER }],
    [{ context: "codex-review", state: "pending", description: "runner busy", creator: WATCHER }],
    [{ context: "codex-review", state: "success", description: "Codex PASS (PR8-r1)", creator: WATCHER }],
    [{ context: "codex-review", state: "success", description: "looks fine", creator: WATCHER }],
    // A PASS forged by a workflow (GITHUB_TOKEN posts as github-actions[bot]) or with no creator is refused.
    [{ context: "codex-review", state: "success", description: "Codex PASS (PR7-r1)", creator: { login: "github-actions[bot]" } }],
    [{ context: "codex-review", state: "success", description: "Codex PASS (PR7-r1)" }],
  ];
  for (const statuses of cases) {
    const f = fakeGitHub({ statuses });
    const r = await run(f);
    assert.equal(r.code, 1, JSON.stringify(statuses));
    assert.equal(merges(f).length, 0);
  }
});

test("AT3 red or unfinished CI on the head SHA: refused, no merge", async () => {
  const cases = [
    [{ name: "build", status: "completed", conclusion: "failure" }],
    [{ name: "build", status: "completed", conclusion: "success" }, { name: "db", status: "in_progress", conclusion: null }],
    [{ name: "build", status: "completed", conclusion: "cancelled" }],
    [{ name: "build", status: "completed", conclusion: "timed_out" }],
    [],
    [{ name: "e2e", status: "completed", conclusion: "skipped" }],
  ];
  for (const checkRuns of cases) {
    const f = fakeGitHub({ checkRuns });
    const r = await run(f);
    assert.equal(r.code, 1, JSON.stringify(checkRuns));
    assert.equal(merges(f).length, 0);
  }
});

test("AT3b the latest run of a workflow still queued, running or failed refuses; a superseded cancelled run does not", async () => {
  for (const [status, conclusion] of [["queued", null], ["in_progress", null], ["completed", "failure"], ["completed", "cancelled"]]) {
    const runs = [...fakeGitHub().state.workflowRuns, { id: 14, workflow_id: 2, name: "db", run_number: 4, status, conclusion }];
    const f = fakeGitHub({ workflowRuns: runs });
    assert.equal((await run(f)).code, 1, `${status}/${conclusion}`);
    assert.equal(merges(f).length, 0);
  }
  assert.equal((await run(fakeGitHub())).code, 0, "ci run 5 (cancelled) is superseded by run 6 (success)");
  const rerun = [{ id: 11, workflow_id: 1, name: "ci", run_number: 6, run_attempt: 1, status: "completed", conclusion: "failure" },
    { id: 11, workflow_id: 1, name: "ci", run_number: 6, run_attempt: 2, status: "completed", conclusion: "success" }];
  assert.equal((await run(fakeGitHub({ workflowRuns: rerun }))).code, 0, "a successful re-run attempt supersedes the failed attempt");
});

test("AT4 main not an ancestor of the head (behind or diverged): refused, no merge", async () => {
  for (const compare of ["behind", "diverged"]) {
    const f = fakeGitHub({ compare });
    const r = await run(f);
    assert.equal(r.code, 1);
    assert.match(r.reasons.join("\n"), /not in the head/);
    assert.equal(merges(f).length, 0);
  }
});

test("AT5 GC5: a commit after the PASS voids it — the head moved between check and merge, GitHub 409, refused", async () => {
  const f = fakeGitHub({ mergeStatus: 409 });
  const r = await run(f);
  assert.equal(r.code, 1);
  assert.match(r.reasons[0], /head moved/);
  assert.equal(merges(f).length, 1, "the merge PUT is never retried");
  // And a PASS that only exists on the old SHA does not count for the new head: statuses are read per head SHA.
  assert.ok(f.calls.some((c) => c.path.startsWith(`/repos/${REPO}/commits/${HEAD}/status`)));
  // The PASS sits on the old SHA; the PR's head is a new commit with no review yet: refused, and the old SHA is never read.
  const g = fakeGitHub({ statuses: [] });
  const r2 = await run(g);
  assert.equal(r2.code, 1);
  assert.match(r2.reasons.join("\n"), /no codex-review status/);
  assert.ok(!g.calls.some((c) => c.path.includes(OLD)));
  assert.equal(merges(g).length, 0);
});

test("AT5b a merge PUT that fails in flight is read back: merged → exit 0; not merged → exit 2; never retried", async () => {
  const log = () => {};
  const f = fakeGitHub({ putThrows: "merged" });
  assert.equal(await main(["7"], { env: { GH_TOKEN: TOKEN }, fetchImpl: f.fetchImpl, log }), 0);
  assert.equal(merges(f).length, 1);
  const g = fakeGitHub({ putThrows: "lost" });
  const out = [];
  assert.equal(await main(["7"], { env: { GH_TOKEN: TOKEN }, fetchImpl: g.fetchImpl, log: (l) => out.push(l) }), 2);
  assert.equal(merges(g).length, 1);
  assert.match(out.join("\n"), /not merged/);
});

test("AT6 a required check run (e.g. the CI aggregator or floor guard once listed) must report success", async () => {
  const config = { ...DEFAULT_CONFIG, requiredCheckRuns: ["floor-guard"] };
  let f = fakeGitHub();
  assert.equal((await run(f, { config })).code, 1, "missing required check");
  f = fakeGitHub({ checkRuns: [{ name: "build", status: "completed", conclusion: "success" }, { name: "floor-guard", status: "completed", conclusion: "skipped" }] });
  assert.equal((await run(f, { config })).code, 1, "a skipped required check is not success");
  f = fakeGitHub({ checkRuns: [{ name: "build", status: "completed", conclusion: "success" }, { name: "floor-guard", status: "completed", conclusion: "success" }] });
  assert.equal((await run(f, { config })).code, 0);
});

test("AT7 not open, draft, wrong base, fork head, or another failing status: refused", async () => {
  const base = fakeGitHub().state.pr;
  const prs = [
    { ...base, state: "closed" },
    { ...base, draft: true },
    { ...base, base: { ref: "dev" } },
    { ...base, head: { sha: HEAD, repo: { full_name: "someone/devos" } } },
    { ...base, head: { sha: HEAD, repo: null } },
  ];
  for (const pr of prs) {
    const f = fakeGitHub({ pr });
    assert.equal((await run(f)).code, 1, JSON.stringify(pr));
    assert.equal(merges(f).length, 0);
  }
  for (const state of ["failure", "error", "pending"]) {
    const f = fakeGitHub({ statuses: [...fakeGitHub().state.statuses, { context: "other", state }] });
    assert.equal((await run(f)).code, 1, state);
  }
});

test("AT8 --dry-run never merges; paginated check runs beyond page 1 are judged", async () => {
  const f = fakeGitHub();
  assert.equal((await run(f, { dryRun: true })).code, 0);
  assert.equal(merges(f).length, 0);
  const many = Array.from({ length: 150 }, (_, i) => ({ name: `job${i}`, status: "completed", conclusion: "success" }));
  many[140] = { name: "job140", status: "completed", conclusion: "failure" };
  const g = fakeGitHub({ checkRuns: many });
  assert.equal((await run(g)).code, 1, "a failure on page 2 is seen");
});

test("AT9 cannot run → exit 2, never a merge; the token never appears in output; every call has a timeout; GETs retry 5xx", async () => {
  const out = [];
  const log = (l) => out.push(l);
  assert.equal(await main([], { env: { GH_TOKEN: TOKEN }, log }), 2);
  assert.equal(await main(["7", "--repo", "bad repo"], { env: { GH_TOKEN: TOKEN }, log }), 2);
  assert.equal(await main(["7", "--repo", "../.."], { env: { GH_TOKEN: TOKEN }, log }), 2);
  const down = async () => { throw new TypeError("fetch failed"); };
  assert.equal(await main(["7"], { env: { GH_TOKEN: TOKEN }, fetchImpl: down, log }), 2);
  const f = fakeGitHub({ fail5xx: 2 });
  assert.equal(await main(["7"], { env: { GH_TOKEN: TOKEN }, fetchImpl: f.fetchImpl, log }), 0, "two 502s on GET are retried");
  assert.ok(f.calls.every((c) => c.hasSignal), "every call carries a timeout signal");
  assert.ok(f.calls.every((c) => c.auth === `Bearer ${TOKEN}`));
  const g = fakeGitHub({ fail5xx: 9 });
  assert.equal(await main(["7"], { env: { GH_TOKEN: TOKEN }, fetchImpl: g.fetchImpl, log }), 2);
  assert.equal(merges(g).length, 0);
  assert.ok(!out.join("\n").includes(TOKEN), "token never printed");
  assert.ok(out.some((l) => l.startsWith("MERGED PR #7")));
});

// GI-3 (DEVOS-143): the Release merge path refuses unless CI is green, Codex PASSed and main is in the head,
// all on the PR's current head SHA, and merges pinned to that SHA (docs/modules/GI-3.md, AT1–AT9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKOFF_CAP_MS, DEFAULT_CONFIG, backoffMs, githubClient, main, release } from "../release/merge.mjs";

const REPO = "kkarnati1980/devos";
const HEAD = "a".repeat(40);
const MAIN = "b".repeat(40);
const OLD = "d".repeat(40);
const TOKEN = "ghp_" + "X".repeat(36);
const WATCHER = { login: "kkarnati1980" };

// A fake GitHub. `state` is mutated per test; every request is recorded.
function fakeGitHub(over = {}) {
  const state = {
    pr: { number: 7, state: "open", draft: false, merged: false, changed_files: 1, base: { ref: "main" }, head: { sha: HEAD, repo: { full_name: REPO } } },
    files: [{ filename: "apps/api/src/x.ts", status: "modified" }],
    comments: [],
    checkRuns: [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "floor-guard", status: "completed", conclusion: "success" },
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
    if (path.startsWith(`/repos/${REPO}/pulls/7/files`)) {
      const page = Number(new URL(url).searchParams.get("page"));
      return reply(200, state.files.slice((page - 1) * 100, page * 100));
    }
    if (path.startsWith(`/repos/${REPO}/issues/7/comments`)) {
      const page = Number(new URL(url).searchParams.get("page"));
      return reply(200, state.comments.slice((page - 1) * 100, page * 100));
    }
    if (path === `/repos/${REPO}/git/ref/heads/main`) return reply(200, { object: { sha: state.mainSha } });
    if (path === `/repos/${REPO}/compare/${MAIN}...${HEAD}`) return reply(200, { status: state.compare });
    if (path === `/repos/${REPO}/pulls/7/merge` && init.method === "PUT") {
      if (state.putStatus) {
        if (state.putMerges) state.pr = { ...state.pr, merged: true, state: "closed", merge_commit_sha: "e".repeat(40) };
        return { status: state.putStatus, text: async () => state.putBody ?? "" };
      }
      if (state.putThrows) { if (state.putThrows === "merged") state.pr = { ...state.pr, merged: true, state: "closed", merge_commit_sha: "e".repeat(40) }; throw new TypeError("socket hang up"); }
      return state.mergeStatus === 200 ? reply(200, { merged: true, sha: "c".repeat(40) }) : reply(state.mergeStatus, { message: "Head branch was modified" });
    }
    return reply(404, { message: "not found" });
  };
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  // DEVOS-148: `netFailures` GETs fail with a network error before the fake answers (one client, one retry setting).
  let netFailures = over.netFailures ?? 0;
  const client = async (url, init) => {
    if (init.method === "GET" && netFailures-- > 0) throw new TypeError("fetch failed");
    return fetchImpl(url, init);
  };
  return { state, calls, fetchImpl, sleep, sleeps, gh: githubClient({ token: TOKEN, fetchImpl: client, retries: 2, sleep }) };
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
  assert.deepEqual(DEFAULT_CONFIG.requiredCheckRuns, ["floor-guard"], "GI-1b: the floor guard is a required check");
  let f = fakeGitHub({ checkRuns: [{ name: "build", status: "completed", conclusion: "success" }] });
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
  many[0] = { name: "floor-guard", status: "completed", conclusion: "success" };
  const ok = fakeGitHub({ checkRuns: many.slice() });
  assert.equal((await run(ok, { dryRun: true })).code, 0, "150 green runs over two pages pass");
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
  assert.equal(await main(["7"], { env: { GH_TOKEN: TOKEN }, fetchImpl: down, log, sleep: async () => {} }), 2);
  const f = fakeGitHub({ fail5xx: 2 });
  assert.equal(await main(["7"], { env: { GH_TOKEN: TOKEN }, fetchImpl: f.fetchImpl, log, sleep: f.sleep }), 0, "two 502s on GET are retried");
  assert.ok(f.calls.every((c) => c.hasSignal), "every call carries a timeout signal");
  assert.ok(f.calls.every((c) => c.auth === `Bearer ${TOKEN}`));
  const g = fakeGitHub({ fail5xx: 9 });
  assert.equal(await main(["7"], { env: { GH_TOKEN: TOKEN }, fetchImpl: g.fetchImpl, log, sleep: g.sleep }), 2);
  assert.equal(merges(g).length, 0);
  assert.ok(!out.join("\n").includes(TOKEN), "token never printed");
  assert.ok(out.some((l) => l.startsWith("MERGED PR #7")));
});

test("AT5c Codex PR67-r1: a 5xx or an unreadable 200 on the merge PUT is read back, never reported as a refusal or re-sent", async () => {
  const log = () => {};
  for (const [putStatus, putBody] of [[502, "{}"], [504, ""], [200, "<html>"], [200, "{}"]]) {
    const merged = fakeGitHub({ putStatus, putBody, putMerges: true });
    assert.equal(await main(["7"], { env: { GH_TOKEN: TOKEN }, fetchImpl: merged.fetchImpl, log }), 0, `${putStatus} ${putBody}: merged → 0`);
    assert.equal(merges(merged).length, 1);
    const notMerged = fakeGitHub({ putStatus, putBody });
    assert.equal(await main(["7"], { env: { GH_TOKEN: TOKEN }, fetchImpl: notMerged.fetchImpl, log }), 2, `${putStatus} ${putBody}: not merged → 2`);
    assert.equal(merges(notMerged).length, 1);
  }
  // A definite refusal (405 not mergeable, 409 head moved) stays exit 1 without a read-back merge claim.
  const refused = fakeGitHub({ putStatus: 405, putBody: JSON.stringify({ message: "Pull Request is not mergeable" }) });
  assert.equal(await main(["7"], { env: { GH_TOKEN: TOKEN }, fetchImpl: refused.fetchImpl, log }), 1);
});

test("DEVOS-148 GET retries wait with bounded exponential backoff and jitter; the merge PUT never waits or retries", async () => {
  // Two 502s, then success: two waits, the first in [250, 500] ms, the second in [500, 1000] ms.
  const f = fakeGitHub({ fail5xx: 2 });
  assert.equal((await run(f)).code, 0);
  assert.equal(f.sleeps.length, 2);
  assert.ok(f.sleeps[0] >= 250 && f.sleeps[0] <= 500, `first wait ${f.sleeps[0]}`);
  assert.ok(f.sleeps[1] >= 500 && f.sleeps[1] <= 1000, `second wait ${f.sleeps[1]}`);
  assert.equal(merges(f).length, 1);
  // A run with no failures never waits.
  const ok = fakeGitHub();
  assert.equal((await run(ok)).code, 0);
  assert.deepEqual(ok.sleeps, []);
  // The PUT is not retried and does not wait, even when it fails in flight.
  const p = fakeGitHub({ putThrows: "merged" });
  assert.equal((await run(p)).code, 0, "read back as merged");
  assert.equal(merges(p).length, 1);
  assert.deepEqual(p.sleeps, []);
  // The schedule: exact bounds at jitter 0 and 1, capped, and a bad random source cannot escape the bounds.
  assert.deepEqual([1, 2, 3].map((a) => backoffMs(a, () => 0)), [250, 500, 1000]);
  assert.deepEqual([1, 2, 3].map((a) => backoffMs(a, () => 1)), [500, 1000, 2000]);
  assert.equal(backoffMs(30, () => 1), BACKOFF_CAP_MS);
  for (const r of [() => -5, () => 7, () => Number.NaN]) {
    const ms = backoffMs(1, r);
    assert.ok(ms >= 250 && ms <= 500, `bounded for ${r}`);
  }
});

test("DEVOS-148 a GET network error is retried after a backoff", async () => {
  const f = fakeGitHub({ netFailures: 1 });
  assert.equal((await release(f.gh, { repo: REPO, pr: 7 })).code, 0);
  assert.equal(f.sleeps.length, 1);
});

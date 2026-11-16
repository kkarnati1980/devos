// DEVOS-197 part 2: AT1–AT6 for the closed-PR branch cleanup (docs/decisions/0029-closed-pr-branch-cleanup.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  COMMENT, cleanup, decideFromEvent, listBacklog, makeApi, nameAllowed, refPath,
} from "../ci/cleanup-closed-pr-branch.mjs";

const REPO = "kkarnati1980/devos";
const WF = fileURLToPath(new URL("../../.github/workflows/cleanup-closed-pr-branch.yml", import.meta.url));

function event({ number = 999, ref = "kishore/devos-999-x", merged = false, headRepo = REPO, action = "closed" } = {}) {
  return {
    action,
    repository: { default_branch: "main", full_name: REPO },
    pull_request: { number, merged, merged_at: merged ? "2026-11-16T09:00:00Z" : null, head: { ref, repo: headRepo ? { full_name: headRepo } : null } },
  };
}

/** A fake GitHub: routes keyed by "METHOD path"; records every call. Unknown routes fail the test. */
function fakeApi(routes) {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    if (!(key in routes)) throw new Error(`unexpected call ${key}`);
    const r = routes[key];
    return typeof r === "function" ? r(body) : r;
  };
  return { api, calls };
}

const B = "kishore/devos-999-x";
const happy = (over = {}) => ({
  [`GET /repos/${REPO}/branches/${B}`]: { status: 200, body: { name: B, protected: false } },
  [`GET /repos/${REPO}/rules/branches/${B}`]: { status: 200, body: [] },
  [`GET /repos/${REPO}/pulls?state=open&per_page=100&head=${encodeURIComponent(`kkarnati1980:${B}`)}`]: { status: 200, body: [] },
  [`GET /repos/${REPO}/pulls?state=open&per_page=100&base=${encodeURIComponent(B)}`]: { status: 200, body: [] },
  [`GET /repos/${REPO}/pulls/999`]: { status: 200, body: { number: 999, state: "closed", merged: false } },
  [`DELETE /repos/${REPO}/git/refs/heads/${B}`]: { status: 204, body: null },
  [`POST /repos/${REPO}/issues/999/comments`]: { status: 201, body: { id: 1 } },
  ...over,
});

test("AT1 closed, unmerged kishore/devos-999-x: the branch is deleted and the comment is posted", async () => {
  const { api, calls } = fakeApi(happy());
  const logs = [];
  const r = await cleanup({ event: event(), repo: REPO, api, log: (l) => logs.push(l) });
  assert.equal(r.deleted, true);
  const del = calls.find((c) => c.method === "DELETE");
  assert.equal(del.path, `/repos/${REPO}/git/refs/heads/${B}`);
  const post = calls.find((c) => c.method === "POST");
  assert.deepEqual(post.body, { body: COMMENT });
  assert.match(COMMENT, /Restore branch/);
  // the checks run before the delete, the comment after it
  assert.deepEqual(calls.map((c) => c.method), ["GET", "GET", "GET", "GET", "GET", "DELETE", "POST"]);
  assert.ok(logs.some((l) => l.startsWith("deleted:")));
});

test("AT2 a merged PR: nothing is called and nothing is deleted", async () => {
  const { api, calls } = fakeApi({});
  const r = await cleanup({ event: event({ merged: true }), repo: REPO, api });
  assert.equal(r.deleted, false);
  assert.match(r.reason, /merged/);
  assert.equal(calls.length, 0);
  // merged_at alone (merged flag missing) also counts as merged; an unknown merged state is skipped
  assert.equal(decideFromEvent({ ...event(), pull_request: { ...event().pull_request, merged: undefined, merged_at: "x" } }, REPO).act, false);
  assert.equal(decideFromEvent({ ...event(), pull_request: { ...event().pull_request, merged: undefined } }, REPO).act, false);
});

test("AT3 the branch is also the head of another open PR: not deleted", async () => {
  const { api, calls } = fakeApi(happy({
    [`GET /repos/${REPO}/pulls?state=open&per_page=100&head=${encodeURIComponent(`kkarnati1980:${B}`)}`]: { status: 200, body: [{ number: 1000, head: { ref: B } }] },
  }));
  const r = await cleanup({ event: event(), repo: REPO, api });
  assert.equal(r.deleted, false);
  assert.match(r.reason, /open PR #1000/);
  assert.ok(!calls.some((c) => c.method === "DELETE" || c.method === "POST"));
});

test("AT3a the closed PR was reopened before the job ran (it heads an open PR again, or re-reads as open): not deleted", async () => {
  for (const over of [
    { [`GET /repos/${REPO}/pulls?state=open&per_page=100&head=${encodeURIComponent(`kkarnati1980:${B}`)}`]: { status: 200, body: [{ number: 999, head: { ref: B } }] } },
    { [`GET /repos/${REPO}/pulls/999`]: { status: 200, body: { number: 999, state: "open", merged: false } } },
    { [`GET /repos/${REPO}/pulls?state=open&per_page=100&base=${encodeURIComponent(B)}`]: { status: 200, body: [{ number: 1001 }] } },
  ]) {
    const { api, calls } = fakeApi(happy(over));
    const r = await cleanup({ event: event(), repo: REPO, api });
    assert.equal(r.deleted, false, JSON.stringify(over));
    assert.ok(!calls.some((c) => c.method === "DELETE" || c.method === "POST"));
  }
});

test("AT3d a 422 at delete counts as gone only for 'Reference does not exist'; any other 422 fails the run with no comment", async () => {
  const gone = fakeApi(happy({ [`DELETE /repos/${REPO}/git/refs/heads/${B}`]: { status: 422, body: { message: "Reference does not exist" } } }));
  assert.equal((await cleanup({ event: event(), repo: REPO, api: gone.api })).deleted, false);
  const refused = fakeApi(happy({ [`DELETE /repos/${REPO}/git/refs/heads/${B}`]: { status: 422, body: { message: "Cannot delete this protected branch" } } }));
  await assert.rejects(cleanup({ event: event(), repo: REPO, api: refused.api }), /delete .*HTTP 422/);
  assert.ok(!refused.calls.some((c) => c.method === "POST"));
});

test("AT3b a protected branch, a ruleset-covered branch or an unreadable rule list: not deleted", async () => {
  for (const over of [
    { [`GET /repos/${REPO}/branches/${B}`]: { status: 200, body: { name: B, protected: true } } },
    { [`GET /repos/${REPO}/branches/${B}`]: { status: 200, body: { name: B } } }, // protected unknown → skip
    { [`GET /repos/${REPO}/rules/branches/${B}`]: { status: 200, body: [{ type: "deletion" }] } },
  ]) {
    const { api, calls } = fakeApi(happy(over));
    const r = await cleanup({ event: event(), repo: REPO, api });
    assert.equal(r.deleted, false, JSON.stringify(over));
    assert.ok(!calls.some((c) => c.method === "DELETE"));
  }
  const { api, calls } = fakeApi(happy({ [`GET /repos/${REPO}/rules/branches/${B}`]: { status: 403, body: null } }));
  await assert.rejects(cleanup({ event: event(), repo: REPO, api }), /read rules .*HTTP 403/);
  assert.ok(!calls.some((c) => c.method === "DELETE"));
});

test("AT3c a branch already gone: skipped, no comment", async () => {
  const { api, calls } = fakeApi(happy({ [`GET /repos/${REPO}/branches/${B}`]: { status: 404, body: null } }));
  const r = await cleanup({ event: event(), repo: REPO, api });
  assert.equal(r.deleted, false);
  assert.match(r.reason, /already gone/);
  assert.equal(calls.length, 1);
});

test("AT4 main, the default branch or a name outside the prefix: skipped with no API call", async () => {
  for (const ref of ["main", "develop", "kishore/other-1", "devos-1-x", "kishore/devos-", "kishore/devos-1/../main", "kishore/devos-1-x.lock", "kishore/devos-1 x", "kishore/devos-1-x/"]) {
    const { api, calls } = fakeApi({});
    const r = await cleanup({ event: event({ ref }), repo: REPO, api });
    assert.equal(r.deleted, false, ref);
    assert.equal(calls.length, 0, ref);
  }
  assert.equal(nameAllowed("kishore/devos-197-p2-closed-pr-branch-cleanup"), true);
  const ev = event({ ref: "kishore/devos-1-x" });
  ev.repository.default_branch = "kishore/devos-1-x";
  assert.match(decideFromEvent(ev, REPO).reason, /default branch/);
});

test("AT5 a fork (or a deleted head repo): skipped with no API call", async () => {
  for (const headRepo of ["someone/devos", null]) {
    const { api, calls } = fakeApi({});
    const r = await cleanup({ event: event({ headRepo }), repo: REPO, api });
    assert.equal(r.deleted, false);
    assert.match(r.reason, /fork/);
    assert.equal(calls.length, 0);
  }
});

test("AT5b not a closed event: skipped", () => {
  assert.equal(decideFromEvent(event({ action: "opened" }), REPO).act, false);
  assert.equal(decideFromEvent({}, REPO).act, false);
});

test("AT6 the workflow never checks out or runs PR code", () => {
  const src = readFileSync(WF, "utf8");
  const wf = parse(src);
  assert.deepEqual(Object.keys(wf.on), ["pull_request_target"]);
  assert.deepEqual(wf.on.pull_request_target.types, ["closed"]);
  assert.deepEqual(wf.permissions, {});
  // nothing from the PR head is ever interpolated: no head.sha / head.ref / merge ref anywhere in the file
  assert.doesNotMatch(src, /pull_request\.head\.(sha|ref)|refs\/pull\/|merge_commit_sha|github\.head_ref/);
  for (const [name, job] of Object.entries(wf.jobs)) {
    assert.deepEqual(job.permissions, { contents: "write", "pull-requests": "write" }, name);
    assert.match(job.if, /pull_request\.merged == false/);
    assert.match(job.if, /head\.repo\.full_name == github\.repository/);
    for (const step of job.steps) {
      if (step.uses) {
        assert.match(step.uses, /^actions\/checkout@[0-9a-f]{40}$/, `${name}: only a SHA-pinned checkout is used`);
        assert.equal(step.with?.ref, undefined, "checkout takes no ref, so it is GITHUB_SHA on this repo's own branch");
        assert.equal(step.with?.repository, undefined);
        assert.equal(step.with?.["persist-credentials"], false);
      }
      if (step.run) {
        assert.equal(step.run.trim(), "node scripts/ci/cleanup-closed-pr-branch.mjs");
        assert.doesNotMatch(step.run, /\$\{\{/);
      }
      if (step.env) for (const v of Object.values(step.env)) assert.equal(v, "${{ github.token }}");
    }
  }
});

test("refPath keeps slashes and encodes each segment", () => {
  assert.equal(refPath("kishore/devos-1-a#b"), "kishore/devos-1-a%23b");
});

test("makeApi sends the token, a timeout signal and JSON; maps a timeout to a CleanupError", async () => {
  let seen;
  const api = makeApi({ token: "test-token-not-real", fetchImpl: async (url, init) => { seen = { url, init }; return { status: 201, text: async () => '{"id":1}' }; } });
  const r = await api("POST", "/x", { body: "hi" });
  assert.deepEqual(r, { status: 201, body: { id: 1 } });
  assert.equal(seen.url, "https://api.github.com/x");
  assert.equal(seen.init.headers.authorization, "Bearer test-token-not-real");
  assert.ok(seen.init.signal instanceof AbortSignal);
  const slow = makeApi({ token: "t", fetchImpl: async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; } });
  await assert.rejects(slow("GET", "/y"), /GET \/y: timed out/);
  assert.throws(() => makeApi({ token: "" }), /GITHUB_TOKEN/);
});

test("listBacklog lists only existing kishore/devos-* branches of closed, unmerged, non-fork PRs and deletes nothing", async () => {
  const { api, calls } = fakeApi({
    [`GET /repos/${REPO}/branches?per_page=100&page=1`]: { status: 200, body: [{ name: "main" }, { name: "kishore/devos-1-a" }, { name: "kishore/devos-2-b" }, { name: "kishore/devos-3-c" }, { name: "kishore/devos-5-e" }] },
    [`GET /repos/${REPO}/pulls?state=all&per_page=100&page=1`]: { status: 200, body: [
      { number: 1, state: "closed", merged_at: null, closed_at: "t1", head: { ref: "kishore/devos-1-a", repo: { full_name: REPO } } },
      { number: 2, state: "closed", merged_at: "t", head: { ref: "kishore/devos-2-b", repo: { full_name: REPO } } },
      { number: 3, state: "closed", merged_at: null, head: { ref: "kishore/devos-3-c", repo: { full_name: "x/y" } } },
      { number: 4, state: "closed", merged_at: null, head: { ref: "kishore/devos-4-gone", repo: { full_name: REPO } } },
      { number: 5, state: "closed", merged_at: null, head: { ref: "kishore/devos-5-e", repo: { full_name: REPO } } },
      { number: 6, state: "open", head: { ref: "kishore/devos-5-e", repo: { full_name: REPO } } },
    ] },
  });
  const list = await listBacklog({ repo: REPO, api });
  assert.deepEqual(list, [{ pr: 1, branch: "kishore/devos-1-a", closedAt: "t1" }]);
  assert.ok(calls.every((c) => c.method === "GET"));
});

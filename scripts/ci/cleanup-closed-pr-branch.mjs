// DEVOS-197 part 2 (KK's decision, 16 Nov 2026 14:42 IST; docs/decisions/0029-closed-pr-branch-cleanup.md):
// delete the head branch of a PR closed WITHOUT merging, so a leftover branch can no longer turn `secret-scan` red on
// every open PR. Run by .github/workflows/cleanup-closed-pr-branch.yml on `pull_request_target: [closed]`.
//
// Safety (decision 2): only `kishore/devos-*` branches of this repo; never `main`, the default branch, a protected
// branch, a branch a ruleset forbids deleting, or a branch that is the head of another open PR. Every skip is logged
// with its reason. This file never runs PR code: it reads only the event JSON and calls the REST API.
//
// Usage:
//   node scripts/ci/cleanup-closed-pr-branch.mjs                 # in the workflow (GITHUB_EVENT_PATH, GITHUB_TOKEN)
//   node scripts/ci/cleanup-closed-pr-branch.mjs --list-backlog  # list only: branches of closed, unmerged PRs
// Exit 0 = deleted or skipped with a reason; 1 = an API call failed; 2 = bad input.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const BRANCH_PREFIX = "kishore/devos-";
export const COMMENT =
  "Branch deleted automatically because this PR was closed without merging. Use 'Restore branch' above to bring it back.";
const TIMEOUT_MS = 10_000; // ADR-0011: a timeout on every outbound call
const BRANCH_NAME = /^kishore\/devos-[A-Za-z0-9._/-]+$/;

export class CleanupError extends Error {}

/** Branch names this script may ever delete: the runners' prefix, plain characters, no `..`, no trailing `/`/`.lock`. */
export function nameAllowed(ref) {
  return typeof ref === "string" && BRANCH_NAME.test(ref) && !ref.includes("..") && !ref.includes("//")
    && !ref.endsWith("/") && !ref.endsWith(".lock") && ref !== "main";
}

/**
 * The event-only part of the decision (no API calls): returns `{ act: true, branch, pr }` or `{ act: false, reason }`.
 * `repo` is `owner/name` of the repo the workflow runs in.
 */
export function decideFromEvent(event, repo) {
  const pr = event?.pull_request;
  if (event?.action !== "closed" || !pr) return { act: false, reason: "not a closed pull_request event" };
  if (pr.merged === true || pr.merged_at) return { act: false, reason: `PR #${pr.number} was merged` };
  if (pr.merged !== false) return { act: false, reason: `PR #${pr.number}: merged state unknown` };
  const headRepo = pr.head?.repo?.full_name;
  if (!headRepo || headRepo !== repo) return { act: false, reason: `PR #${pr.number}: head is a fork or a deleted repo (${headRepo ?? "none"})` };
  const branch = pr.head?.ref;
  const defaultBranch = event.repository?.default_branch ?? "main";
  if (branch === defaultBranch || branch === "main") return { act: false, reason: `PR #${pr.number}: ${branch} is the default branch` };
  if (!nameAllowed(branch)) return { act: false, reason: `PR #${pr.number}: branch ${JSON.stringify(branch)} is outside ${BRANCH_PREFIX}*` };
  if (!Number.isInteger(pr.number) || pr.number <= 0) return { act: false, reason: "PR number missing" };
  return { act: true, branch, pr: pr.number };
}

/** Each path segment encoded, slashes kept, so `kishore/devos-1-x` stays one ref path. */
export const refPath = (branch) => branch.split("/").map(encodeURIComponent).join("/");

/**
 * A small REST client. `fetchImpl` is injectable for tests. Returns `{ status, body }`; throws CleanupError on a
 * network failure or timeout. No retries: deletes are not safe to repeat blindly, and a failed GET just skips.
 */
export function makeApi({ token, apiUrl = "https://api.github.com", fetchImpl = globalThis.fetch }) {
  if (!token) throw new CleanupError("GITHUB_TOKEN is not set");
  return async (method, path, body) => {
    let res;
    try {
      res = await fetchImpl(`${apiUrl}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new CleanupError(`${method} ${path}: ${e.name === "TimeoutError" ? "timed out" : "request failed"}`);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json };
  };
}

/**
 * Full run for one event. `api(method, path, body)` → `{status, body}`. `log` gets one line per decision.
 * Returns `{ deleted: boolean, reason }`.
 */
export async function cleanup({ event, repo, api, log = () => {} }) {
  const d = decideFromEvent(event, repo);
  if (!d.act) { log(`skip: ${d.reason}`); return { deleted: false, reason: d.reason }; }
  const { branch, pr } = d;
  const [owner] = repo.split("/");
  const fail = (what, r) => { throw new CleanupError(`${what}: HTTP ${r.status}`); };

  // 1. The branch must still exist and be unprotected.
  const b = await api("GET", `/repos/${repo}/branches/${refPath(branch)}`);
  if (b.status === 404) { const reason = `branch ${branch} is already gone`; log(`skip: ${reason}`); return { deleted: false, reason }; }
  if (b.status !== 200) fail(`read branch ${branch}`, b);
  if (b.body?.protected !== false) { const reason = `branch ${branch} is protected`; log(`skip: ${reason}`); return { deleted: false, reason }; }

  // 2. No ruleset rule may cover it (a `deletion` rule, or any rule at all: a ruleset-covered ref is left alone).
  const rules = await api("GET", `/repos/${repo}/rules/branches/${refPath(branch)}`);
  if (rules.status !== 200 || !Array.isArray(rules.body)) fail(`read rules for ${branch}`, rules);
  if (rules.body.length > 0) {
    const reason = `branch ${branch} is covered by a ruleset (${[...new Set(rules.body.map((r) => r?.type))].join(", ")})`;
    log(`skip: ${reason}`); return { deleted: false, reason };
  }

  // 3. It must not be the head of another open PR.
  const open = await api("GET", `/repos/${repo}/pulls?state=open&per_page=100&head=${encodeURIComponent(`${owner}:${branch}`)}`);
  if (open.status !== 200 || !Array.isArray(open.body)) fail(`list open PRs for ${branch}`, open);
  const others = open.body.filter((p) => p?.number !== pr && p?.head?.ref === branch);
  if (others.length > 0) {
    const reason = `branch ${branch} is the head of open PR ${others.map((p) => `#${p.number}`).join(", ")}`;
    log(`skip: ${reason}`); return { deleted: false, reason };
  }

  // 4. Delete, then tell the PR how to restore it.
  const del = await api("DELETE", `/repos/${repo}/git/refs/heads/${refPath(branch)}`);
  if (del.status === 404 || del.status === 422) { const reason = `branch ${branch} was already gone at delete`; log(`skip: ${reason}`); return { deleted: false, reason }; }
  if (del.status !== 204) fail(`delete ${branch}`, del);
  log(`deleted: ${branch} (PR #${pr} closed without merging)`);
  const c = await api("POST", `/repos/${repo}/issues/${pr}/comments`, { body: COMMENT });
  if (c.status !== 201) fail(`comment on PR #${pr}`, c);
  return { deleted: true, reason: `deleted ${branch}` };
}

/**
 * List only (decision 5): the branches that still exist and belong to closed, unmerged PRs with the runners' prefix.
 * Deletes nothing. Returns `[{ pr, branch, closedAt }]`, newest first.
 */
export async function listBacklog({ repo, api }) {
  const branches = new Set();
  for (let page = 1; page <= 50; page++) {
    const r = await api("GET", `/repos/${repo}/branches?per_page=100&page=${page}`);
    if (r.status !== 200 || !Array.isArray(r.body)) throw new CleanupError(`list branches: HTTP ${r.status}`);
    for (const b of r.body) if (b?.name) branches.add(b.name);
    if (r.body.length < 100) break;
  }
  const open = new Set();
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= 50; page++) {
    const r = await api("GET", `/repos/${repo}/pulls?state=all&per_page=100&page=${page}`);
    if (r.status !== 200 || !Array.isArray(r.body)) throw new CleanupError(`list PRs: HTTP ${r.status}`);
    for (const p of r.body) {
      const ref = p?.head?.ref;
      if (p?.state === "open") { open.add(ref); continue; }
      if (p?.merged_at || p?.head?.repo?.full_name !== repo || !nameAllowed(ref) || !branches.has(ref) || seen.has(ref)) continue;
      seen.add(ref);
      out.push({ pr: p.number, branch: ref, closedAt: p.closed_at });
    }
    if (r.body.length < 100) break;
  }
  return out.filter((x) => !open.has(x.branch));
}

async function main(argv) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) { console.error("cleanup: GITHUB_REPOSITORY is missing"); return 2; }
  try {
    const api = makeApi({ token: process.env.GITHUB_TOKEN, apiUrl: process.env.GITHUB_API_URL || undefined });
    if (argv.includes("--list-backlog")) {
      const list = await listBacklog({ repo, api });
      for (const x of list) console.log(`#${x.pr}\t${x.branch}\t${x.closedAt ?? ""}`);
      console.log(`total: ${list.length} branch(es) of closed, unmerged PRs (list only; nothing deleted)`);
      return 0;
    }
    const path = process.env.GITHUB_EVENT_PATH;
    if (!path) { console.error("cleanup: GITHUB_EVENT_PATH is missing"); return 2; }
    let event;
    try { event = JSON.parse(readFileSync(path, "utf8")); } catch { console.error("cleanup: cannot read the event file"); return 2; }
    await cleanup({ event, repo, api, log: (l) => console.log(`cleanup: ${l}`) });
    return 0;
  } catch (e) {
    if (e instanceof CleanupError) { console.error(`cleanup: failed: ${e.message}`); return 1; }
    throw e;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main(process.argv.slice(2));

#!/usr/bin/env node
// Release merge path v1.0.0 (DEVOS-143, gate integrity Part 3; contract docs/modules/GI-3.md).
// The ONE way a runner merges a PR into main. It merges only when every stored result is green for the
// PR's CURRENT head SHA, and pins the merge to that SHA, so any commit after the review voids the PASS (GC5).
//
//   node scripts/release/merge.mjs <pr> [--repo owner/name] [--dry-run]
//
// Exit codes: 0 merged (or, with --dry-run, would merge) · 1 refused (a gate condition failed) ·
// 2 could not run (bad arguments, no token, GitHub unreadable). Exit 2 is never a merge.
// The token comes from GH_TOKEN or GITHUB_TOKEN, else `gh auth token`; it is never printed or logged.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DEFAULT_CONFIG = JSON.parse(readFileSync(new URL("./required-checks.json", import.meta.url), "utf8"));
const OK_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);
const API = "https://api.github.com";

export class CannotRun extends Error {}

// GitHub client with a timeout on every call (ADR-0011). GETs are retried (safe); the merge PUT never is.
export function githubClient({ token, fetchImpl = fetch, timeoutMs = 30_000, retries = 2 } = {}) {
  if (!token) throw new CannotRun("no GitHub token (set GH_TOKEN, or log in with gh)");
  async function call(method, path, body) {
    const attempts = method === "GET" ? retries + 1 : 1;
    let last;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetchImpl(`${API}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        if (method === "GET" && res.status >= 500) { last = new CannotRun(`GET ${path}: HTTP ${res.status}`); continue; }
        return { status: res.status, json };
      } catch (err) {
        last = new CannotRun(`${method} ${path}: ${err?.name === "TimeoutError" ? "timed out" : "request failed"}`);
        if (method !== "GET") throw last;
      }
    }
    throw last;
  }
  async function get(path) {
    const r = await call("GET", path);
    if (r.status !== 200) throw new CannotRun(`GET ${path}: HTTP ${r.status}`);
    return r.json;
  }
  return { call, get };
}

async function allCheckRuns(gh, repo, sha) {
  const runs = [];
  for (let page = 1; page <= 20; page++) {
    const j = await gh.get(`/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`);
    runs.push(...(j.check_runs ?? []));
    if (runs.length >= (j.total_count ?? 0) || (j.check_runs ?? []).length === 0) return runs;
  }
  throw new CannotRun("more than 2,000 check runs; refusing to judge a partial list");
}

async function allStatuses(gh, repo, sha) {
  const statuses = [];
  for (let page = 1; page <= 20; page++) {
    const j = await gh.get(`/repos/${repo}/commits/${sha}/status?per_page=100&page=${page}`);
    statuses.push(...(j.statuses ?? []));
    if (statuses.length >= (j.total_count ?? 0) || (j.statuses ?? []).length === 0) return statuses;
  }
  throw new CannotRun("more than 2,000 statuses; refusing to judge a partial list");
}

// The latest GitHub Actions run of every workflow on the head SHA (as the review watcher judges CI). Jobs not created
// yet (needs:) are invisible as check runs, but their workflow run is still queued or in progress. Older runs of the
// same workflow (e.g. cancelled by concurrency after a reopen) are superseded and ignored.
async function latestWorkflowRuns(gh, repo, sha) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const j = await gh.get(`/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100&page=${page}`);
    all.push(...(j.workflow_runs ?? []));
    if (all.length >= (j.total_count ?? 0) || (j.workflow_runs ?? []).length === 0) {
      const latest = new Map();
      for (const r of all) {
        const prev = latest.get(r.workflow_id);
        const newer = !prev || r.run_number > prev.run_number || (r.run_number === prev.run_number && (r.run_attempt ?? 1) > (prev.run_attempt ?? 1));
        if (newer) latest.set(r.workflow_id, r);
      }
      return [...latest.values()];
    }
  }
  throw new CannotRun("more than 2,000 workflow runs; refusing to judge a partial list");
}

// Reads every stored result for the PR's current head and returns { ok, sha, reasons[] }. Never merges.
export async function evaluate(gh, { repo, pr, config = DEFAULT_CONFIG }) {
  const reasons = [];
  const p = await gh.get(`/repos/${repo}/pulls/${pr}`);
  const sha = p?.head?.sha;
  if (!sha) throw new CannotRun(`PR #${pr}: no head SHA in the response`);
  if (p.state !== "open") reasons.push(`PR is ${p.merged ? "already merged" : p.state}, not open`);
  if (p.draft) reasons.push("PR is a draft");
  if (p.base?.ref !== config.baseBranch) reasons.push(`base is ${p.base?.ref}, not ${config.baseBranch}`);
  if (p.head?.repo?.full_name !== repo) reasons.push(`head is in ${p.head?.repo?.full_name ?? "a deleted repo"}, not ${repo}`);

  // 1. Green CI on this SHA: at least one check run, all completed, none failed, every required one present.
  const runs = await allCheckRuns(gh, repo, sha);
  if (runs.length === 0) reasons.push("no CI check runs on the head SHA");
  for (const r of runs) {
    if (r.status !== "completed") reasons.push(`check "${r.name}" is ${r.status}`);
    else if (!OK_CONCLUSIONS.has(r.conclusion)) reasons.push(`check "${r.name}" concluded ${r.conclusion}`);
  }
  if (runs.length > 0 && !runs.some((r) => r.conclusion === "success")) reasons.push("no CI check run succeeded");
  for (const w of await latestWorkflowRuns(gh, repo, sha)) {
    if (w.status !== "completed") reasons.push(`workflow "${w.name}" (run ${w.id}) is ${w.status}`);
    else if (!OK_CONCLUSIONS.has(w.conclusion)) reasons.push(`workflow "${w.name}" (run ${w.id}) concluded ${w.conclusion}`);
  }
  for (const name of config.requiredCheckRuns) {
    const r = runs.find((x) => x.name === name);
    if (!r) reasons.push(`required check "${name}" has not reported on the head SHA`);
    else if (r.conclusion !== "success") reasons.push(`required check "${name}" is ${r.conclusion ?? r.status}, not success`);
  }

  // 2. Codex PASS on this SHA (the review watcher's `codex-review` status, for this PR), and no other red status.
  const statuses = await allStatuses(gh, repo, sha);
  const latest = new Map();
  for (const s of statuses) {
    const prev = latest.get(s.context);
    if (!prev || String(s.updated_at ?? s.created_at) > String(prev.updated_at ?? prev.created_at)) latest.set(s.context, s);
  }
  const codex = latest.get(config.codexContext);
  const desc = String(codex?.description ?? "");
  if (!codex) reasons.push(`no ${config.codexContext} status on the head SHA (not reviewed yet)`);
  else if (codex.creator?.login !== config.codexCreator) reasons.push(`${config.codexContext} was posted by ${codex.creator?.login ?? "an unknown account"}, not the review watcher (${config.codexCreator})`);
  else if (codex.state !== "success" || !desc.startsWith("Codex PASS")) reasons.push(`${config.codexContext} is ${codex.state} ("${desc.slice(0, 80)}"), not a PASS`);
  else {
    const label = desc.match(/\bPR(\d+)-r\d+\b/);
    if (!label || Number(label[1]) !== Number(pr)) reasons.push(`the PASS on this SHA is labelled for ${label ? `PR #${label[1]}` : "no PR"}, not PR #${pr}`);
  }
  for (const s of latest.values()) {
    if (s.context === config.codexContext) continue;
    if (s.state !== "success") reasons.push(`status "${s.context}" is ${s.state}`);
  }

  // 3. origin/main is already in the head (ADR-0013).
  const ref = await gh.get(`/repos/${repo}/git/ref/heads/${config.baseBranch}`);
  const mainSha = ref?.object?.sha;
  if (!mainSha) throw new CannotRun(`cannot read the ${config.baseBranch} SHA`);
  const cmp = await gh.get(`/repos/${repo}/compare/${mainSha}...${sha}`);
  if (cmp.status !== "ahead" && cmp.status !== "identical") {
    reasons.push(`${config.baseBranch} ${mainSha.slice(0, 7)} is not in the head (compare: ${cmp.status}); merge ${config.baseBranch} in first`);
  }

  return { ok: reasons.length === 0, sha, mainSha, reasons };
}

// The Release path: evaluate, then merge pinned to the evaluated SHA. GitHub refuses (409) if the head moved.
export async function release(gh, { repo, pr, dryRun = false, config = DEFAULT_CONFIG, log = () => {} }) {
  const v = await evaluate(gh, { repo, pr, config });
  if (!v.ok) {
    log(`REFUSED PR #${pr} at ${v.sha.slice(0, 7)}:`);
    for (const r of v.reasons) log(`  - ${r}`);
    return { code: 1, ...v };
  }
  if (dryRun) { log(`OK PR #${pr} at ${v.sha.slice(0, 7)}: would merge (dry run)`); return { code: 0, ...v }; }
  // An ambiguous outcome (network error or timeout, a 5xx from a gateway, or a 2xx without a readable "merged")
  // may hide a merge GitHub already accepted: read the PR back, never re-send the PUT (Codex PR67-r1).
  async function readBack(cause) {
    const after = await gh.get(`/repos/${repo}/pulls/${pr}`).catch(() => null);
    if (after?.merged && after.head?.sha === v.sha) {
      log(`MERGED PR #${pr}: head ${v.sha} -> merge ${after.merge_commit_sha} (confirmed after: ${cause})`);
      return { code: 0, mergeSha: after.merge_commit_sha, ...v };
    }
    if (after && !after.merged) throw new CannotRun(`${cause}; PR #${pr} is not merged yet; read the PR again before retrying`);
    throw new CannotRun(`${cause}; MERGE OUTCOME UNKNOWN for PR #${pr}, read the PR before retrying`);
  }
  let r;
  try {
    r = await gh.call("PUT", `/repos/${repo}/pulls/${pr}/merge`, { sha: v.sha, merge_method: "merge" });
  } catch (err) {
    return readBack(err.message);
  }
  if (r.status === 200 && r.json?.merged === true) {
    log(`MERGED PR #${pr}: head ${v.sha} -> merge ${r.json.sha}`);
    return { code: 0, mergeSha: r.json.sha, ...v };
  }
  if (r.status >= 500 || (r.status >= 200 && r.status < 300)) return readBack(`merge PUT answered HTTP ${r.status} without a confirmed merge`);
  const why = r.status === 409 ? "the head moved after the check (a new commit voids the PASS)" : `HTTP ${r.status}: ${String(r.json?.message ?? "").slice(0, 120)}`;
  log(`REFUSED PR #${pr}: GitHub did not merge: ${why}`);
  return { code: 1, ...v, reasons: [why] };
}

function tokenFromEnv(env = process.env) {
  if (env.GH_TOKEN) return env.GH_TOKEN;
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : "";
}

export function parseArgs(argv) {
  const out = { repo: "kkarnati1980/devos", dryRun: false, pr: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--repo") out.repo = argv[++i];
    else if (/^\d+$/.test(a) && out.pr === null) out.pr = Number(a);
    else throw new CannotRun(`unknown argument: ${a}`);
  }
  if (!out.pr) throw new CannotRun("usage: merge.mjs <pr> [--repo owner/name] [--dry-run]");
  if (!/^[\w.-]+\/[\w.-]+$/.test(out.repo ?? "") || out.repo.split("/").some((seg) => /^\.+$/.test(seg))) throw new CannotRun("--repo must be owner/name");
  return out;
}

export async function main(argv, { env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  try {
    const args = parseArgs(argv);
    const gh = githubClient({ token: tokenFromEnv(env), fetchImpl });
    return (await release(gh, { ...args, log })).code;
  } catch (err) {
    log(`CANNOT RUN: ${err instanceof CannotRun ? err.message : `unexpected error: ${String(err?.message ?? err).slice(0, 200)}`}`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}

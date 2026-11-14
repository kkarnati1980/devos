#!/usr/bin/env node
// Release merge path v1.1.0 (DEVOS-143, gate integrity Part 3; contract docs/modules/GI-3.md).
// v1.1.0 (DEVOS-149, GI-1b; contract docs/modules/GI-1b.md): floor guard required; a failing floor guard is
// accepted only with valid Codex Keeps for that SHA; a PR touching a guard path needs a PASS naming the change.
// The ONE way a runner merges a PR into main. It merges only when every stored result is green for the
// PR's CURRENT head SHA, and pins the merge to that SHA, so any commit after the review voids the PASS (GC5).
//
//   node scripts/release/merge.mjs <pr> [--repo owner/name] [--dry-run]
//
// Exit codes: 0 merged (or, with --dry-run, would merge) · 1 refused (a gate condition failed) ·
// 2 could not run (bad arguments, no token, GitHub unreadable). Exit 2 is never a merge.
// The token comes from GH_TOKEN or GITHUB_TOKEN, else `gh auth token`; it is never printed or logged.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GUARD_PATHS } from "../floor-guard/floor-guard.mjs";

export const DEFAULT_CONFIG = JSON.parse(readFileSync(new URL("./required-checks.json", import.meta.url), "utf8"));
const OK_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);
const API = "https://api.github.com";

export class CannotRun extends Error {}

// DEVOS-148 (ADR-0011 §9): bounded exponential backoff with equal jitter between GET attempts. Attempt i (from 1)
// waits a random time in [delay/2, delay], delay = min(BACKOFF_BASE_MS * 2^(i-1), BACKOFF_CAP_MS).
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 4_000;
export function backoffMs(attempt, random = Math.random) {
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
  const r = Math.min(Math.max(Number(random()) || 0, 0), 1);
  return Math.round(delay / 2 + r * (delay / 2));
}
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// GitHub client with a timeout on every call (ADR-0011). GETs are retried (safe) after a backoff; the merge PUT
// never is.
export function githubClient({ token, fetchImpl = fetch, timeoutMs = 30_000, retries = 2, sleep = realSleep, random = Math.random } = {}) {
  if (!token) throw new CannotRun("no GitHub token (set GH_TOKEN, or log in with gh)");
  async function call(method, path, body) {
    const attempts = method === "GET" ? retries + 1 : 1;
    let last;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(backoffMs(i, random));
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

async function mainHead(gh, repo, config) {
  const ref = await gh.get(`/repos/${repo}/git/ref/heads/${config.baseBranch}`);
  const mainSha = ref?.object?.sha;
  if (!mainSha) throw new CannotRun(`cannot read the ${config.baseBranch} SHA`);
  return mainSha;
}

/** GI-1b: the PR's changed files (old and new names) that are floor-guard paths, and whether a decision note changed. */
export async function guardPathsTouched(gh, repo, pr, changedFiles) {
  if (!Number.isInteger(changedFiles)) throw new CannotRun(`PR #${pr}: no changed_files count in the response`);
  if (changedFiles > 3000) throw new CannotRun(`PR #${pr} changes ${changedFiles} files; GitHub lists at most 3,000, refusing to judge a partial list`);
  const files = [];
  for (let page = 1; page <= 30 && files.length < changedFiles; page++) {
    const j = await gh.get(`/repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`);
    if (!Array.isArray(j) || j.length === 0) break;
    files.push(...j);
  }
  if (files.length < changedFiles) throw new CannotRun(`PR #${pr}: listed ${files.length} of ${changedFiles} changed files; refusing to judge a partial list`);
  const paths = new Set();
  for (const f of files) for (const n of [f.filename, f.previous_filename]) if (n && GUARD_PATHS.some((re) => re.test(n))) paths.add(n);
  const decisionNote = files.some((f) => /^docs\/decisions\/[^/]+\.md$/.test(f.filename ?? "") && f.status !== "removed");
  return { paths: [...paths].sort(), decisionNote };
}

/**
 * GI-1b: the text of the review watcher's PASS comment for this exact SHA and label (first line
 * "### Codex review <label> — **PASS**", a "**Commit:** `<sha>`" line, posted by the watcher's account). The
 * watcher renders the verdict summary on one line, so each "FLOOR-GUARD KEEP|CHANGE" marker is moved onto its own
 * line before it is matched. Returns null when no such comment exists.
 */
export async function passVerdictText(gh, repo, pr, sha, label, creator) {
  const comments = [];
  for (let page = 1; page <= 20; page++) {
    const j = await gh.get(`/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(j) || j.length === 0) break;
    comments.push(...j);
    if (page === 20 && j.length === 100) throw new CannotRun(`PR #${pr} has more than 2,000 comments; refusing to judge a partial list`);
  }
  const head = `### Codex review ${label} — **PASS**`;
  // The earliest matching comment that was never edited (pre-review finding 3): a later or edited comment from the
  // shared account cannot replace the watcher's.
  const match = comments.find((c) => c?.user?.login === creator && (!c.updated_at || c.updated_at === c.created_at) && String(c.body ?? "").split("\n")[0].trim() === head && String(c.body).includes(`**Commit:** \`${sha}\``));
  if (!match) return null;
  // Markers count only on the Summary line, never in the findings table, whose cells quote PR text (finding 1).
  const summary = String(match.body).split("\n").find((l) => l.startsWith("- **Summary:** "));
  if (!summary) return null;
  return summary.slice("- **Summary:** ".length).replace(/[ \t]*(FLOOR-GUARD (?:KEEP|CHANGE) )/g, "\n$1");
}

// Hits a Codex Keep never clears (spec §4.4: security scanning, policy and money go to KK; §4.5: a guard change must
// stand alone). Mirrors KK_ONLY in scripts/gates/evaluate-gate.mjs (DEVOS-144) plus guard-change-not-isolated.
const SECURITY_SUPPRESSION = /gitleaks[:]allow|\bnose[c]\b/;
const SECURITY_WORDS = /secur|secret|gitleaks|\bnose[c]\b|audit|licen[cs]e|codeql|semgrep|trivy|snyk|xss|no-eval|detect-/i;
export function notKeepable(h) {
  const text = String(h?.text ?? "");
  if (SECURITY_WORDS.test(`${h?.file ?? ""} ${text}`)) return true;
  if (text.length >= 200) return true; // GI-1 cuts hit text at 200 characters: what follows cannot be ruled out
  if (["gitleaksignore-added", "policy-weakened", "guard-change-not-isolated"].includes(h?.rule)) return true;
  if (h?.rule === "suppression-added") return SECURITY_SUPPRESSION.test(text);
  if (/^ci-/.test(h?.rule ?? "")) return true; // a CI hit names the step, not what it ran
  if (h?.rule === "lint-rule-off") return /\bignores?\b/.test(text);
  return false;
}

/**
 * True when the verdict text has a line "FLOOR-GUARD CHANGE <path>" naming exactly this path: the whole rest of
 * the line (trailing whitespace aside) must equal the path, so one marker never covers a shorter path that is its
 * prefix (Codex PR96-r1). Anything written after the path on the same line fails closed (no match).
 */
export function namesChange(text, path) {
  for (const m of String(text).matchAll(/^[ \t]*FLOOR-GUARD CHANGE (.+)$/gm)) {
    if (m[1].replace(/[ \t]+$/, "") === path) return true;
  }
  return false;
}

/**
 * GI-1b: re-run the floor guard on <main>...<sha> with main's copy of the guard (as CI runs the base copy), in
 * the current repository after fetching both SHAs. Any failure to fetch, load or run is "could not run".
 */
export async function localGuardReport({ mainSha, sha, cwd = process.cwd() }) {
  for (const x of [mainSha, sha]) if (!/^[0-9a-f]{40}$/.test(String(x))) throw new CannotRun("floor guard: bad SHA");
  const fetched = spawnSync("git", ["fetch", "--quiet", "--no-tags", "origin", mainSha, sha], { cwd, encoding: "utf8", timeout: 60_000 });
  if (fetched.status !== 0) throw new CannotRun("floor guard: cannot fetch the main and head SHAs");
  const src = spawnSync("git", ["show", `${mainSha}:scripts/floor-guard/floor-guard.mjs`], { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  if (src.status !== 0) throw new CannotRun("floor guard: main has no scripts/floor-guard/floor-guard.mjs");
  const dir = mkdtempSync(join(tmpdir(), "devos-fg-"));
  try {
    const file = join(dir, "floor-guard.mjs");
    writeFileSync(file, src.stdout);
    const mod = await import(pathToFileURL(file).href);
    return { report: mod.run({ cwd, base: mainSha, head: sha }), applyDispositions: mod.applyDispositions };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Reads every stored result for the PR's current head and returns { ok, sha, reasons[] }. Never merges.
export async function evaluate(gh, { repo, pr, config = DEFAULT_CONFIG, guardReport = localGuardReport }) {
  const reasons = [];
  const p = await gh.get(`/repos/${repo}/pulls/${pr}`);
  const sha = p?.head?.sha;
  if (!sha) throw new CannotRun(`PR #${pr}: no head SHA in the response`);
  if (p.state !== "open") reasons.push(`PR is ${p.merged ? "already merged" : p.state}, not open`);
  if (p.draft) reasons.push("PR is a draft");
  if (p.base?.ref !== config.baseBranch) reasons.push(`base is ${p.base?.ref}, not ${config.baseBranch}`);
  if (p.head?.repo?.full_name !== repo) reasons.push(`head is in ${p.head?.repo?.full_name ?? "a deleted repo"}, not ${repo}`);

  // 1. Green CI on this SHA: at least one check run, all completed, none failed, every required one present.
  //    Red results are collected with the check or workflow they belong to, so a floor guard disposed of by
  //    Codex Keeps (step 2b) can set aside exactly its own failure and the aggregator's (GI-1b).
  const red = [];
  const runs = await allCheckRuns(gh, repo, sha);
  if (runs.length === 0) reasons.push("no CI check runs on the head SHA");
  for (const r of runs) {
    if (r.status !== "completed") red.push({ check: r.name, msg: `check "${r.name}" is ${r.status}` });
    else if (!OK_CONCLUSIONS.has(r.conclusion)) red.push({ check: r.name, failed: r.conclusion === "failure", msg: `check "${r.name}" concluded ${r.conclusion}` });
  }
  if (runs.length > 0 && !runs.some((r) => r.conclusion === "success")) reasons.push("no CI check run succeeded");
  for (const w of await latestWorkflowRuns(gh, repo, sha)) {
    if (w.status !== "completed") red.push({ workflow: w.name, path: w.path, msg: `workflow "${w.name}" (run ${w.id}) is ${w.status}` });
    else if (!OK_CONCLUSIONS.has(w.conclusion)) red.push({ workflow: w.name, path: w.path, failed: w.conclusion === "failure", msg: `workflow "${w.name}" (run ${w.id}) concluded ${w.conclusion}` });
  }
  for (const name of config.requiredCheckRuns) {
    const r = runs.find((x) => x.name === name);
    if (!r) reasons.push(`required check "${name}" has not reported on the head SHA`);
    else if (r.conclusion !== "success") red.push({ check: name, required: true, failed: r.conclusion === "failure", msg: `required check "${name}" is ${r.conclusion ?? r.status}, not success` });
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
  let passLabel = null;
  if (!codex) reasons.push(`no ${config.codexContext} status on the head SHA (not reviewed yet)`);
  else if (codex.creator?.login !== config.codexCreator) reasons.push(`${config.codexContext} was posted by ${codex.creator?.login ?? "an unknown account"}, not the review watcher (${config.codexCreator})`);
  else if (codex.state !== "success" || !desc.startsWith("Codex PASS")) reasons.push(`${config.codexContext} is ${codex.state} ("${desc.slice(0, 80)}"), not a PASS`);
  else {
    const label = desc.match(/\bPR(\d+)-r\d+\b/);
    if (!label || Number(label[1]) !== Number(pr)) reasons.push(`the PASS on this SHA is labelled for ${label ? `PR #${label[1]}` : "no PR"}, not PR #${pr}`);
    else passLabel = label[0];
  }
  for (const s of latest.values()) {
    if (s.context === config.codexContext) continue;
    if (s.state !== "success") reasons.push(`status "${s.context}" is ${s.state}`);
  }

  // 2b. Floor guard (GI-1b): guard-path changes must be named by the PASS; a failing floor guard is set aside
  //     only when every hit it finds on this SHA has a valid Codex Keep (spec §4.4, GI-1 Dispositions).
  const fg = config.floorGuard;
  let mainSha = null; // read once: the guard re-run and the compare in step 3 judge the same main
  const fgFailed = fg ? red.filter((x) => x.check === fg.check && x.failed) : [];
  const otherFgRed = fg ? red.filter((x) => (x.check === fg.check || x.path === fg.workflowPath) && !x.failed) : [];
  const guardFiles = await guardPathsTouched(gh, repo, pr, p.changed_files);
  let disposed = false;
  if (guardFiles.paths.length > 0 || (fgFailed.length > 0 && otherFgRed.length === 0)) {
    const verdictText = passLabel ? await passVerdictText(gh, repo, pr, sha, passLabel, config.codexCreator) : null;
    if (guardFiles.paths.length > 0) {
      if (!verdictText) reasons.push(`the PR changes guard path(s) ${guardFiles.paths.join(", ")}, and there is no Codex PASS comment for ${sha.slice(0, 7)} to name the change`);
      else {
        for (const path of guardFiles.paths) if (!namesChange(verdictText, path)) reasons.push(`guard path ${path} changed, but the PASS for ${sha.slice(0, 7)} has no "FLOOR-GUARD CHANGE ${path}" line`);
        if (!guardFiles.decisionNote) reasons.push("guard paths changed without a docs/decisions/ note in the same PR (spec §4.5)");
      }
    }
    if (fgFailed.length > 0 && otherFgRed.length === 0) {
      if (!verdictText) reasons.push(`floor guard failed on ${sha.slice(0, 7)} and there is no Codex PASS comment for this SHA to hold Keeps`);
      else {
        mainSha ??= await mainHead(gh, repo, config);
        const { report, applyDispositions } = await guardReport({ mainSha, sha });
        if (report.sha !== sha) reasons.push(`floor-guard report is for ${String(report.sha).slice(0, 7)}, not the head ${sha.slice(0, 7)}`);
        else if (report.exit === 2) reasons.push(`floor guard could not run on ${sha.slice(0, 7)} (exit 2 is never clean): ${report.error ?? "unknown error"}`);
        else if (report.hits.length === 0) reasons.push(`floor guard failed in CI on ${sha.slice(0, 7)} but finds no hit on a re-run; re-run the check, a red check is never set aside without a hit`);
        else {
          const d = applyDispositions(report, { sha, source: "codex", text: verdictText });
          const kk = report.hits.filter(notKeepable);
          for (const h of kk) reasons.push(`floor-guard hit ${h.id} ${h.rule} ${h.file}:${h.line} cannot be kept by Codex: restore it or escalate to KK (spec §4.4/§4.5)`);
          for (const h of d.open) if (!kk.includes(h)) reasons.push(`floor-guard hit ${h.id} ${h.rule} ${h.file}:${h.line} has no "FLOOR-GUARD KEEP ${h.id} ${h.file}:${h.line} <reason>" in the PASS for ${sha.slice(0, 7)}`);
          if (d.exit === 0 && kk.length === 0) disposed = true;
        }
      }
    }
  }
  // Workflow runs are matched by their file, not their name, so a PR-added workflow named "floor-guard" is never
  // set aside (pre-review finding 4).
  const isWf = (x, file) => x.workflow !== undefined && x.path === file;
  const setAside = (x) => disposed && (x.check === fg.check || isWf(x, fg.workflowPath) || (x.failed && (x.check === fg.aggregatorCheck || isWf(x, fg.aggregatorWorkflowPath))));
  for (const x of red) if (!setAside(x)) reasons.push(x.msg);

  // 3. origin/main is already in the head (ADR-0013).
  mainSha ??= await mainHead(gh, repo, config);
  const cmp = await gh.get(`/repos/${repo}/compare/${mainSha}...${sha}`);
  if (cmp.status !== "ahead" && cmp.status !== "identical") {
    reasons.push(`${config.baseBranch} ${mainSha.slice(0, 7)} is not in the head (compare: ${cmp.status}); merge ${config.baseBranch} in first`);
  }

  return { ok: reasons.length === 0, sha, mainSha, reasons, disposed };
}

// The Release path: evaluate, then merge pinned to the evaluated SHA. GitHub refuses (409) if the head moved.
export async function release(gh, { repo, pr, dryRun = false, config = DEFAULT_CONFIG, log = () => {}, guardReport }) {
  const v = await evaluate(gh, { repo, pr, config, ...(guardReport ? { guardReport } : {}) });
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

export async function main(argv, { env = process.env, fetchImpl = fetch, log = console.log, sleep = realSleep } = {}) {
  try {
    const args = parseArgs(argv);
    const gh = githubClient({ token: tokenFromEnv(env), fetchImpl, sleep });
    return (await release(gh, { ...args, log })).code;
  } catch (err) {
    log(`CANNOT RUN: ${err instanceof CannotRun ? err.message : `unexpected error: ${String(err?.message ?? err).slice(0, 200)}`}`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}

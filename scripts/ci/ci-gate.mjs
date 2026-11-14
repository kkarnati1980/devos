#!/usr/bin/env node
// CI-T-b (DEVOS-152, docs/modules/CI-T-b.md): the `ci-gate` aggregator. It works out which jobs the PR's
// workflows run for this base branch, waits for their check runs on the head SHA, and passes only when every
// one of them succeeded. It never passes by default: a failure, cancel, skip, timeout, missing check, or a
// workflow it cannot reason about (path filters, job `if:`, matrices, reusable workflows) is a fail.
// Exit codes: 0 pass · 1 a check failed or did not report in time · 2 error (never treated as a pass).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

export const GATE_WORKFLOW = "ci-gate.yml";
const UNSUPPORTED_TRIGGER_KEYS = ["paths", "paths-ignore"];

export class GateError extends Error {}

/** `on:` as an object of event → config (string and list forms normalised). */
function triggers(on) {
  if (typeof on === "string") return { [on]: {} };
  if (Array.isArray(on)) return Object.fromEntries(on.map((e) => [e, {}]));
  if (on && typeof on === "object") return on;
  return {};
}

function branchMatches(patterns, base) {
  for (const p of patterns) {
    if (typeof p !== "string") throw new GateError(`branch filter "${String(p)}" is not a string`);
    if (/[*?![\]+]/.test(p) && p !== "*" && p !== "**") throw new GateError(`branch pattern "${p}" is not supported`);
    if (p === base || p === "*" || p === "**") return true;
  }
  return false;
}

/**
 * The check-run names one workflow will produce for a PR into `base`: [] when it does not run for this PR.
 * @param {string} file  workflow file name (for messages)
 * @param {unknown} wf   parsed workflow YAML
 */
export function expectedFromWorkflow(file, wf, base) {
  if (!wf || typeof wf !== "object") throw new GateError(`${file}: not a workflow`);
  const on = triggers(wf.on ?? wf[true]); // YAML 1.1 parsers may read `on` as boolean true
  const pr = on.pull_request;
  if (pr === undefined) return [];
  const cfg = pr ?? {};
  for (const k of UNSUPPORTED_TRIGGER_KEYS) {
    if (cfg[k] !== undefined) throw new GateError(`${file}: pull_request.${k} is not supported by ci-gate yet (fails closed)`);
  }
  if (cfg.types !== undefined) throw new GateError(`${file}: pull_request.types is not supported by ci-gate yet (fails closed)`);
  if (cfg.branches !== undefined && cfg["branches-ignore"] !== undefined) throw new GateError(`${file}: both branches and branches-ignore`);
  if (cfg.branches !== undefined && !branchMatches([cfg.branches].flat(), base)) return [];
  if (cfg["branches-ignore"] !== undefined && branchMatches([cfg["branches-ignore"]].flat(), base)) return [];
  const jobs = wf.jobs;
  if (!jobs || typeof jobs !== "object") throw new GateError(`${file}: no jobs`);
  const names = [];
  for (const [id, job] of Object.entries(jobs)) {
    if (!job || typeof job !== "object") throw new GateError(`${file}: job ${id} is not a mapping`);
    if (job.if !== undefined) throw new GateError(`${file}: job ${id} has an if: condition, not supported by ci-gate yet (fails closed)`);
    if (job.strategy?.matrix !== undefined) throw new GateError(`${file}: job ${id} has a matrix, not supported by ci-gate yet (fails closed)`);
    if (job.uses !== undefined) throw new GateError(`${file}: job ${id} calls a reusable workflow, not supported by ci-gate yet (fails closed)`);
    const name = job.name ?? id;
    if (typeof name !== "string" || name.includes("${{")) throw new GateError(`${file}: job ${id} has a computed name`);
    names.push(name);
  }
  return names;
}

/**
 * Every check-run name the PR must pass: the union of the base commit's and the head's workflows (the gate's
 * own file excluded). A PR that deletes or narrows a workflow still has to pass the checks main runs today.
 */
export function expectedUnion(baseDir, headDir, base) {
  // Codex PR73-r3: the base directory is required; a missing input fails closed rather than skipping the comparison.
  if (typeof baseDir !== "string" || !baseDir.trim()) throw new GateError("GATE_BASE_WORKFLOWS_DIR (the base commit's workflow directory) is required");
  const head = expectedChecks(headDir, base);
  if (!existsSync(baseDir)) throw new GateError("the base commit's workflow directory is missing");
  const dropped = expectedChecks(baseDir, base).filter((n) => !head.includes(n));
  // Fail at once rather than wait out the deadline: removing a check main runs needs its own approved change (G5).
  if (dropped.length) throw new GateError(`the PR removes or narrows checks main runs: ${dropped.join(", ")}`);
  return head;
}

/**
 * Every check-run name the workflows in `dir` produce for a PR into `base`, mapped to the workflow file that
 * produces it (the gate's own file excluded). Codex PR73-r4: the file is how a check run is tied to the PR's
 * own workflow run, so a same-named job from another workflow (e.g. push-only) never counts.
 * @returns {Map<string, string>} check name → workflow file name
 */
export function checkOwners(dir, base) {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && f !== GATE_WORKFLOW).sort();
  const owners = new Map();
  const dupes = new Set();
  for (const f of files) {
    for (const n of expectedFromWorkflow(f, parse(readFileSync(join(dir, f), "utf8")), base)) {
      if (owners.has(n)) dupes.add(n);
      else owners.set(n, f);
    }
  }
  if (dupes.size) throw new GateError(`two jobs report the same check name: ${[...dupes].join(", ")}`);
  if (owners.size === 0) throw new GateError("no checks expected; refusing to pass an empty set");
  return owners;
}

/** Every check-run name the workflows in `dir` produce for a PR into `base` (the gate's own file excluded). */
export function expectedChecks(dir, base) {
  return [...checkOwners(dir, base).keys()];
}

/**
 * Compare expected names with the check runs on the SHA. The newest run of a name counts (re-runs).
 * Codex PR73-r4: a run counts only when it belongs to a `pull_request` workflow run of the file that owns its
 * name (`r.workflow`, from `attributeRuns`); anything else, such as a push-only workflow's same-named job that
 * reports first, is ignored, so the expected check stays pending until its own PR run reports.
 * @param {string[]} expected
 * @param {{ name: string, workflow: string | null }[]} runs
 * @param {Map<string, string>} owners  check name → workflow file (`checkOwners`); required
 * @returns {{ state: "success" | "failure" | "pending", failed: string[], pending: string[] }}
 */
export function evaluate(expected, runs, owners) {
  if (!(owners instanceof Map)) throw new GateError("evaluate needs the check → workflow map");
  for (const name of expected) if (!owners.has(name)) throw new GateError(`no workflow owns expected check ${name}`);
  const newest = new Map();
  const suites = new Map(); // name → PR check suites it appeared in; a re-run stays in its suite
  for (const r of runs) {
    if (!r.workflow || r.workflow !== owners.get(r.name)) continue;
    if (!suites.has(r.name)) suites.set(r.name, new Set());
    suites.get(r.name).add(String(r.suite));
    const prev = newest.get(r.name);
    if (!prev || Number(r.id) > Number(prev.id)) newest.set(r.name, r);
  }
  const failed = [];
  const pending = [];
  for (const name of expected) {
    const r = newest.get(name);
    // Two PR workflow runs of the owning file on one SHA (e.g. a close and reopen): ambiguous, fail closed.
    if ((suites.get(name)?.size ?? 0) > 1) failed.push(`${name}=reported-by-more-than-one-workflow-run`);
    else if (!r || r.status !== "completed") pending.push(name);
    else if (r.conclusion !== "success") failed.push(`${name}=${r.conclusion}`);
  }
  if (failed.length) return { state: "failure", failed, pending };
  if (pending.length) return { state: "pending", failed, pending };
  return { state: "success", failed, pending };
}

/** `filter=all`: GitHub's default (`latest`) would hide an older same-named run from another suite (PR73-r1). Only GitHub Actions' own check runs count; another app posting a same-named "success" is ignored. */
export const ACTIONS_APP_SLUG = "github-actions";

/** One page read; a GET is safe to retry (ADR-0011), so a transient error gets 3 attempts before exit 2. */
async function readPage(url, token, fetchImpl, pause, what = "check-runs") {
  let last = "unknown";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
        signal: AbortSignal.timeout(15_000), // ADR-0011: every outbound call has a timeout
      });
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break;
    } catch {
      last = "network error or timeout";
    }
    if (attempt < 3) await pause(attempt * 2_000);
  }
  throw new GateError(`${what} read failed: ${last}`);
}

export async function listRuns(api, repo, sha, token, fetchImpl, pause = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const runs = [];
  for (let page = 1; page <= 10; page++) {
    const body = await readPage(`${api}/repos/${repo}/commits/${sha}/check-runs?filter=all&per_page=100&page=${page}`, token, fetchImpl, pause);
    if (!Array.isArray(body?.check_runs) || typeof body.total_count !== "number") throw new GateError("check-runs read returned an unexpected body");
    for (const c of body.check_runs) {
      if (c.app?.slug === ACTIONS_APP_SLUG) runs.push({ id: c.id, name: c.name, status: c.status, conclusion: c.conclusion, suite: c.check_suite?.id ?? null });
    }
    if (page * 100 >= body.total_count || body.check_runs.length < 100) return runs;
  }
  throw new GateError("more than 1,000 check runs on one SHA");
}

/**
 * The head SHA's `pull_request` workflow runs, as check-suite id → workflow file name (Codex PR73-r4).
 * Needs `actions: read`. Same paging, timeout and retry rules as `listRuns`.
 */
export async function listPrWorkflowRuns(api, repo, sha, token, fetchImpl, pause = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const suites = new Map();
  for (let page = 1; page <= 10; page++) {
    const url = `${api}/repos/${repo}/actions/runs?head_sha=${sha}&event=pull_request&per_page=100&page=${page}`;
    const body = await readPage(url, token, fetchImpl, pause, "workflow-runs");
    if (!Array.isArray(body?.workflow_runs) || typeof body.total_count !== "number") throw new GateError("workflow-runs read returned an unexpected body");
    for (const w of body.workflow_runs) {
      // The query filters by event already; checking again keeps a push run out if the filter were ignored.
      if (w.event !== "pull_request" || w.head_sha !== sha || w.check_suite_id == null || typeof w.path !== "string") continue;
      suites.set(String(w.check_suite_id), w.path.split("@")[0].split("/").pop());
    }
    if (page * 100 >= body.total_count || body.workflow_runs.length < 100) return suites;
  }
  throw new GateError("more than 1,000 workflow runs on one SHA");
}

/** Tag each check run with the workflow file of its PR workflow run, or null when its suite is not one. */
export function attributeRuns(runs, prSuites) {
  return runs.map((r) => ({ ...r, workflow: prSuites.get(String(r.suite)) ?? null }));
}

/** Poll until every expected check has finished, one fails, or the deadline passes. */
export async function waitForChecks({ expected, owners, read, deadlineMs, intervalMs, now = Date.now, sleep, log = () => {} }) {
  const end = now() + deadlineMs;
  for (;;) {
    const v = evaluate(expected, await read(), owners);
    if (v.state !== "pending") return v;
    if (now() >= end) return { ...v, state: "failure", failed: v.pending.map((n) => `${n}=not-finished-in-time`) };
    log(`waiting for: ${v.pending.join(", ")}`);
    await sleep(intervalMs);
  }
}

/**
 * GI-1d: the PR number and base SHA from the workflow's event file (GITHUB_EVENT_PATH), so the workflow passes no
 * new inputs. Anything unreadable is null, and `floorGuardDisposition` then errors (exit 2).
 */
export function prFromEvent(path) {
  try {
    const pr = JSON.parse(readFileSync(path, "utf8"))?.pull_request;
    return { pr: pr?.number ?? null, baseSha: pr?.base?.sha ?? null };
  } catch {
    return { pr: null, baseSha: null };
  }
}

/**
 * GI-1d: the checkout is shallow and keeps no credentials, so the floor guard re-run first fetches the full history
 * of base and head with the job token, passed through git's environment config (never on the command line or in
 * .git/config). A failed fetch is an error, never a pass.
 */
export function fetchHistory({ baseSha, sha, token, cwd = process.cwd(), run = spawnSync }) {
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}` };
  const shallow = run("git", ["rev-parse", "--is-shallow-repository"], { cwd, encoding: "utf8", timeout: 10_000 });
  const args = ["fetch", "--quiet", "--no-tags", ...(String(shallow.stdout).trim() === "true" ? ["--unshallow"] : []), "origin", baseSha, sha];
  const r = run("git", args, { cwd, encoding: "utf8", env, timeout: 120_000 });
  if (r.status !== 0) throw new GateError("floor guard re-run: cannot fetch the base and head history");
}

/** The Release path's shared rules (GI-1b), loaded only when a disposition is judged; a load failure is an error
 * (exit 2), never a pass. */
async function loadRelease() {
  try {
    return await import("../release/merge.mjs");
  } catch {
    throw new GateError("cannot load scripts/release/merge.mjs to judge floor-guard Keeps");
  }
}

/**
 * GI-1d (DEVOS-179): when the only failed check is the floor guard, ci-gate passes only if the Release path's own
 * rules (GI-1b, `judgeFloorGuard`) dispose of it: the watcher's Codex PASS for this SHA and PR holds a valid
 * Keep for every hit of the floor guard re-run (base copy, on base...head), no hit is KK-only, and every guard
 * path the PR changes is named by a CHANGE line with a decision note. It never waits for the PASS: the watcher
 * reviews only green heads, so ci-gate is re-run after the PASS lands. Anything else stays a failure.
 * @returns {Promise<{ disposed: boolean, reasons: string[] }>}
 */
export async function floorGuardDisposition(v, { gh, repo, pr, sha, baseSha, config, guardReport, release = loadRelease }) {
  const rel = await release();
  config ??= rel.DEFAULT_CONFIG;
  const fg = config.floorGuard;
  if (!fg || v.state !== "failure" || v.pending.length > 0 || v.failed.length !== 1 || v.failed[0] !== `${fg.check}=failure`) {
    return { disposed: false, reasons: [] };
  }
  if (!Number.isInteger(Number(pr)) || Number(pr) <= 0) throw new GateError("the pull request number (event file) is required to judge floor-guard Keeps");
  if (!/^[0-9a-f]{40}$/.test(String(baseSha))) throw new GateError("the base SHA (event file) is not a full commit SHA");
  const statuses = [];
  for (let page = 1; page <= 20; page++) {
    const j = await gh.get(`/repos/${repo}/commits/${sha}/status?per_page=100&page=${page}`);
    statuses.push(...(j?.statuses ?? []));
    if (statuses.length >= (j?.total_count ?? 0) || (j?.statuses ?? []).length === 0) break;
    if (page === 20) throw new GateError("more than 2,000 statuses; refusing to judge a partial list");
  }
  const { passLabel, reasons } = rel.codexPass(statuses, pr, config);
  if (!passLabel) return { disposed: false, reasons };
  const p = await gh.get(`/repos/${repo}/pulls/${pr}`);
  if (p?.head?.sha !== sha) return { disposed: false, reasons: [`PR #${pr}'s head is ${String(p?.head?.sha).slice(0, 7)}, not ${sha.slice(0, 7)}`] };
  const judged = await rel.judgeFloorGuard(gh, { repo, pr, sha, passLabel, changedFiles: p.changed_files, floorGuardFailed: true, otherFloorGuardRed: false, mainSha: baseSha, guardReport: guardReport ?? ((a) => rel.localGuardReport({ ...a, fetch: false })), config });
  return { disposed: judged.disposed && judged.reasons.length === 0, reasons: judged.reasons };
}

async function main() {
  const { GITHUB_API_URL = "https://api.github.com", GITHUB_REPOSITORY, GATE_SHA, GATE_BASE, GITHUB_TOKEN } = process.env;
  if (!GITHUB_REPOSITORY || !GATE_SHA || !GATE_BASE || !GITHUB_TOKEN) throw new GateError("GITHUB_REPOSITORY, GATE_SHA, GATE_BASE and GITHUB_TOKEN are required");
  if (!/^[0-9a-f]{40}$/.test(GATE_SHA)) throw new GateError("GATE_SHA is not a full commit SHA");
  const headDir = process.env.GATE_WORKFLOWS_DIR ?? ".github/workflows";
  const expected = expectedUnion(process.env.GATE_BASE_WORKFLOWS_DIR, headDir, GATE_BASE);
  const owners = checkOwners(headDir, GATE_BASE);
  console.log(`ci-gate: ${GATE_SHA} needs ${expected.length} checks: ${expected.join(", ")}`);
  const v = await waitForChecks({
    expected,
    owners,
    // Check runs first, then the PR workflow runs: a suite created between the two reads is still found.
    read: async () => {
      const runs = await listRuns(GITHUB_API_URL, GITHUB_REPOSITORY, GATE_SHA, GITHUB_TOKEN, fetch);
      return attributeRuns(runs, await listPrWorkflowRuns(GITHUB_API_URL, GITHUB_REPOSITORY, GATE_SHA, GITHUB_TOKEN, fetch));
    },
    deadlineMs: Number(process.env.GATE_DEADLINE_MS ?? 27 * 60_000), // inside the job's 30-minute timeout
    intervalMs: 20_000,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (m) => console.log(m),
  });
  if (v.state === "success") {
    console.log("ci-gate: every expected check passed");
    return 0;
  }
  const { pr, baseSha } = prFromEvent(process.env.GITHUB_EVENT_PATH ?? "");
  const rel = await loadRelease();
  const d = await floorGuardDisposition(v, {
    gh: rel.githubClient({ token: GITHUB_TOKEN }),
    repo: GITHUB_REPOSITORY,
    pr,
    sha: GATE_SHA,
    baseSha,
    guardReport: async (a) => {
      fetchHistory({ baseSha: a.mainSha, sha: a.sha, token: GITHUB_TOKEN });
      return rel.localGuardReport({ ...a, fetch: false });
    },
  });
  if (d.disposed) {
    console.log("ci-gate: every expected check passed except floor-guard, whose every hit has a valid Codex Keep for this SHA (GI-1b rules)");
    return 0;
  }
  for (const r of d.reasons) console.error(`ci-gate: floor-guard not disposed: ${r}`);
  console.error(`ci-gate: FAIL ${v.failed.join(", ")}`);
  return 1;
}

/** True when this file is the script node was asked to run (symlinks, spaces and % resolved), so it never exits 0 unrun. */
export function isEntry(argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === pathToFileURL(realpathSync(new URL(import.meta.url))).href;
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`ci-gate: ERROR ${e instanceof GateError ? e.message : "unexpected failure"}`);
      process.exit(2);
    },
  );
}

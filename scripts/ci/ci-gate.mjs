#!/usr/bin/env node
// CI-T-b (DEVOS-152, docs/modules/CI-T-b.md): the `ci-gate` aggregator. It works out which jobs the PR's
// workflows run for this base branch, waits for their check runs on the head SHA, and passes only when every
// one of them succeeded. It never passes by default: a failure, cancel, skip, timeout, missing check, or a
// workflow it cannot reason about (path filters, job `if:`, matrices, reusable workflows) is a fail.
// Exit codes: 0 pass · 1 a check failed or did not report in time · 2 error (never treated as a pass).
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
  const head = expectedChecks(headDir, base);
  if (!baseDir) return head;
  if (!existsSync(baseDir)) throw new GateError("the base commit's workflow directory is missing");
  const dropped = expectedChecks(baseDir, base).filter((n) => !head.includes(n));
  // Fail at once rather than wait out the deadline: removing a check main runs needs its own approved change (G5).
  if (dropped.length) throw new GateError(`the PR removes or narrows checks main runs: ${dropped.join(", ")}`);
  return head;
}

/** Every check-run name the workflows in `dir` produce for a PR into `base` (the gate's own file excluded). */
export function expectedChecks(dir, base) {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && f !== GATE_WORKFLOW).sort();
  const all = [];
  for (const f of files) all.push(...expectedFromWorkflow(f, parse(readFileSync(join(dir, f), "utf8")), base));
  const dupes = all.filter((n, i) => all.indexOf(n) !== i);
  if (dupes.length) throw new GateError(`two jobs report the same check name: ${[...new Set(dupes)].join(", ")}`);
  if (all.length === 0) throw new GateError("no checks expected; refusing to pass an empty set");
  return all;
}

/**
 * Compare expected names with the check runs on the SHA. The newest run of a name counts (re-runs).
 * @returns {{ state: "success" | "failure" | "pending", failed: string[], pending: string[] }}
 */
export function evaluate(expected, runs) {
  const newest = new Map();
  const suites = new Map(); // name → check suites it appeared in; a re-run stays in its suite
  for (const r of runs) {
    if (!suites.has(r.name)) suites.set(r.name, new Set());
    suites.get(r.name).add(String(r.suite));
    const prev = newest.get(r.name);
    if (!prev || Number(r.id) > Number(prev.id)) newest.set(r.name, r);
  }
  const failed = [];
  const pending = [];
  for (const name of expected) {
    const r = newest.get(name);
    // Another workflow (e.g. a push-triggered job with the same name) must not stand in for the real check.
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
async function readPage(url, token, fetchImpl, pause) {
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
  throw new GateError(`check-runs read failed: ${last}`);
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

/** Poll until every expected check has finished, one fails, or the deadline passes. */
export async function waitForChecks({ expected, read, deadlineMs, intervalMs, now = Date.now, sleep, log = () => {} }) {
  const end = now() + deadlineMs;
  for (;;) {
    const v = evaluate(expected, await read());
    if (v.state !== "pending") return v;
    if (now() >= end) return { ...v, state: "failure", failed: v.pending.map((n) => `${n}=not-finished-in-time`) };
    log(`waiting for: ${v.pending.join(", ")}`);
    await sleep(intervalMs);
  }
}

async function main() {
  const { GITHUB_API_URL = "https://api.github.com", GITHUB_REPOSITORY, GATE_SHA, GATE_BASE, GITHUB_TOKEN } = process.env;
  if (!GITHUB_REPOSITORY || !GATE_SHA || !GATE_BASE || !GITHUB_TOKEN) throw new GateError("GITHUB_REPOSITORY, GATE_SHA, GATE_BASE and GITHUB_TOKEN are required");
  if (!/^[0-9a-f]{40}$/.test(GATE_SHA)) throw new GateError("GATE_SHA is not a full commit SHA");
  const expected = expectedUnion(process.env.GATE_BASE_WORKFLOWS_DIR, process.env.GATE_WORKFLOWS_DIR ?? ".github/workflows", GATE_BASE);
  console.log(`ci-gate: ${GATE_SHA} needs ${expected.length} checks: ${expected.join(", ")}`);
  const v = await waitForChecks({
    expected,
    read: () => listRuns(GITHUB_API_URL, GITHUB_REPOSITORY, GATE_SHA, GITHUB_TOKEN, fetch),
    deadlineMs: Number(process.env.GATE_DEADLINE_MS ?? 27 * 60_000), // inside the job's 30-minute timeout
    intervalMs: 20_000,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (m) => console.log(m),
  });
  if (v.state === "success") {
    console.log("ci-gate: every expected check passed");
    return 0;
  }
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

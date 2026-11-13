// GI-1b (DEVOS-149, docs/modules/GI-1b.md): the Release merge path requires the floor guard, accepts a failing
// floor guard only with valid Codex Keeps for that SHA, and refuses guard-path changes the PASS does not name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { githubClient, localGuardReport, namesChange, notKeepable, passVerdictText, release } from "../release/merge.mjs";
import { applyDispositions, run as guardRun } from "../floor-guard/floor-guard.mjs";

const REPO = "kkarnati1980/devos";
const HEAD = "a".repeat(40);
const MAIN = "b".repeat(40);
const OTHER = "f".repeat(40);
const WATCHER = { login: "kkarnati1980" };
const passComment = (extraSummary = "", { sha = HEAD, label = "PR7-r2", user = WATCHER, verdict = "PASS", table = "", created_at = "2026-11-13T10:01:00Z", updated_at = created_at } = {}) => ({
  user,
  created_at,
  updated_at,
  body: `### Codex review ${label} — **${verdict}**\n\n- **Commit:** \`${sha}\`\n- **Contract:** \`docs/modules/GI-1.md\`\n- **Summary:** Looks right.${extraSummary}\n\n${table}Merge gate (D1): green CI **and** a PASS on this exact SHA.`,
});

function fake(over = {}) {
  const state = {
    pr: { number: 7, state: "open", draft: false, merged: false, changed_files: 1, base: { ref: "main" }, head: { sha: HEAD, repo: { full_name: REPO } } },
    files: [{ filename: "apps/api/src/x.ts", status: "modified" }],
    comments: [passComment()],
    checkRuns: [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "floor-guard", status: "completed", conclusion: "success" },
      { name: "ci-gate", status: "completed", conclusion: "success" },
    ],
    workflowRuns: [
      { id: 1, workflow_id: 1, name: "ci", path: ".github/workflows/ci.yml", run_number: 1, status: "completed", conclusion: "success" },
      { id: 2, workflow_id: 2, name: "floor-guard", path: ".github/workflows/floor-guard.yml", run_number: 1, status: "completed", conclusion: "success" },
      { id: 3, workflow_id: 3, name: "ci-gate", path: ".github/workflows/ci-gate.yml", run_number: 1, status: "completed", conclusion: "success" },
    ],
    statuses: [{ context: "codex-review", state: "success", description: "Codex PASS (PR7-r2)", creator: WATCHER, updated_at: "2026-11-13T10:00:00Z" }],
    ...over,
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    const p = url.replace("https://api.github.com", "");
    calls.push({ method: init.method, path: p });
    const reply = (status, json) => ({ status, text: async () => JSON.stringify(json) });
    const page = Number(new URL(url).searchParams.get("page") || 1);
    if (p === `/repos/${REPO}/pulls/7` && init.method === "GET") return reply(200, state.pr);
    if (p.startsWith(`/repos/${REPO}/pulls/7/files`)) return reply(200, state.files.slice((page - 1) * 100, page * 100));
    if (p.startsWith(`/repos/${REPO}/issues/7/comments`)) return reply(200, state.comments.slice((page - 1) * 100, page * 100));
    if (p.startsWith(`/repos/${REPO}/commits/${HEAD}/check-runs`)) return reply(200, { total_count: state.checkRuns.length, check_runs: state.checkRuns.slice((page - 1) * 100, page * 100) });
    if (p.startsWith(`/repos/${REPO}/commits/${HEAD}/status`)) return reply(200, { total_count: state.statuses.length, statuses: state.statuses });
    if (p.startsWith(`/repos/${REPO}/actions/runs?head_sha=${HEAD}`)) return reply(200, { total_count: state.workflowRuns.length, workflow_runs: state.workflowRuns });
    if (p === `/repos/${REPO}/git/ref/heads/main`) return reply(200, { object: { sha: MAIN } });
    if (p === `/repos/${REPO}/compare/${MAIN}...${HEAD}`) return reply(200, { status: "ahead" });
    if (p === `/repos/${REPO}/pulls/7/merge` && init.method === "PUT") return reply(200, { merged: true, sha: "c".repeat(40) });
    return reply(404, { message: "not found" });
  };
  return { state, calls, gh: githubClient({ token: "t", fetchImpl, retries: 0, sleep: async () => {} }) };
}
const merges = (f) => f.calls.filter((c) => c.method === "PUT").length;
// Fixture texts are assembled so this file itself holds no skip call or suppression for the floor guard to flag.
const SKIP = ["it", "skip"].join(".");
const HITS = [
  { id: "fg-0123456789", rule: "test-skipped", file: "packages/x/test/a.test.ts", line: 2, text: `${SKIP}("a"` },
  { id: "fg-abcdefabcd", rule: "suppression-added", file: "apps/api/src/x.ts", line: 9, text: ["// @ts", "ignore"].join("-") },
];
const stubGuard = (report) => async ({ mainSha, sha }) => {
  assert.equal(mainSha, MAIN, "the guard runs against main");
  return { report: { sha, base: MAIN, exit: report.hits?.length ? 1 : report.exit ?? 0, hits: [], ...report }, applyDispositions };
};
const redGuard = (over = {}) => fake({
  checkRuns: [
    { name: "build", status: "completed", conclusion: "success" },
    { name: "floor-guard", status: "completed", conclusion: "failure" },
    { name: "ci-gate", status: "completed", conclusion: "failure" },
  ],
  workflowRuns: [
    { id: 1, workflow_id: 1, name: "ci", path: ".github/workflows/ci.yml", run_number: 1, status: "completed", conclusion: "success" },
    { id: 2, workflow_id: 2, name: "floor-guard", path: ".github/workflows/floor-guard.yml", run_number: 1, status: "completed", conclusion: "failure" },
    { id: 3, workflow_id: 3, name: "ci-gate", path: ".github/workflows/ci-gate.yml", run_number: 1, status: "completed", conclusion: "failure" },
  ],
  ...over,
});
const keeps = (hits) => hits.map((h) => ` FLOOR-GUARD KEEP ${h.id} ${h.file}:${h.line} the fixture is intentional`).join("");

test("B1 the floor guard is a required check: missing or failed without Keeps refuses, no merge", async () => {
  let f = fake({ checkRuns: [{ name: "build", status: "completed", conclusion: "success" }] });
  let r = await release(f.gh, { repo: REPO, pr: 7 });
  assert.equal(r.code, 1);
  assert.ok(r.reasons.some((x) => x.includes('required check "floor-guard" has not reported')));
  f = redGuard();
  r = await release(f.gh, { repo: REPO, pr: 7, guardReport: stubGuard({ hits: HITS }) });
  assert.equal(r.code, 1);
  assert.equal(merges(f), 0);
  for (const h of HITS) assert.ok(r.reasons.some((x) => x.includes(h.id) && x.includes(`${h.file}:${h.line}`)), `open hit ${h.id} is named`);
});

test("B2 valid Keeps for every hit, from the watcher's PASS comment for this SHA, set aside the floor guard and the aggregator", async () => {
  const f = redGuard({ comments: [passComment(keeps(HITS))] });
  const r = await release(f.gh, { repo: REPO, pr: 7, guardReport: stubGuard({ hits: HITS }) });
  assert.equal(r.code, 0, r.reasons.join("; "));
  assert.equal(r.disposed, true);
  assert.equal(merges(f), 1);
});

test("B3 a Keep is void when one hit lacks it, or it comes from another account, another SHA, another label or a non-PASS comment", async () => {
  const variants = [
    [passComment(keeps(HITS.slice(0, 1)))],
    [passComment(keeps(HITS), { user: { login: "someone-else" } })],
    [passComment(keeps(HITS), { sha: OTHER })],
    [passComment(keeps(HITS), { label: "PR7-r1" })],
    [passComment(keeps(HITS), { verdict: "CHANGES_REQUESTED" })],
    [passComment(keeps(HITS).replace(":9 ", ":10 "))],
  ];
  for (const comments of variants) {
    const f = redGuard({ comments });
    const r = await release(f.gh, { repo: REPO, pr: 7, guardReport: stubGuard({ hits: HITS }) });
    assert.equal(r.code, 1, comments[0].body.slice(0, 60));
    assert.equal(merges(f), 0);
  }
});

test("B4 exit 2, a clean re-run, a report for another SHA, or another red check are never set aside (GC2)", async () => {
  const cases = [
    [stubGuard({ exit: 2, error: "unknown ref" }), /could not run/],
    [stubGuard({ hits: [] }), /finds no hit on a re-run/],
    [async () => ({ report: { sha: OTHER, exit: 1, hits: HITS }, applyDispositions }), /report is for/],
  ];
  for (const [guardReport, why] of cases) {
    const f = redGuard({ comments: [passComment(keeps(HITS))] });
    const r = await release(f.gh, { repo: REPO, pr: 7, guardReport });
    assert.equal(r.code, 1);
    assert.ok(r.reasons.some((x) => why.test(x)), r.reasons.join("; "));
    assert.equal(merges(f), 0);
  }
  // Keeps clear the floor guard but not a failing build, nor a cancelled floor guard.
  let f = redGuard({ comments: [passComment(keeps(HITS))] });
  f.state.checkRuns[0].conclusion = "failure";
  let r = await release(f.gh, { repo: REPO, pr: 7, guardReport: stubGuard({ hits: HITS }) });
  assert.equal(r.code, 1);
  assert.ok(r.reasons.some((x) => x.includes('check "build" concluded failure')));
  f = redGuard({ comments: [passComment(keeps(HITS))] });
  f.state.checkRuns[1].conclusion = "cancelled";
  let called = false;
  r = await release(f.gh, { repo: REPO, pr: 7, guardReport: async () => { called = true; return {}; } });
  assert.equal(r.code, 1);
  assert.equal(called, false, "a cancelled floor guard is not a stored result to dispose of");
});

test("B5 a PR touching a guard path needs a PASS naming each path and a decision note; renames count", async () => {
  const guardFile = "scripts/floor-guard/floor-guard.mjs";
  const note = { filename: "docs/decisions/0099-guard-change.md", status: "added" };
  const cases = [
    [[{ filename: guardFile, status: "modified" }, note], [passComment()], /no "FLOOR-GUARD CHANGE scripts\/floor-guard\/floor-guard.mjs"/],
    [[{ filename: guardFile, status: "modified" }], [passComment(` FLOOR-GUARD CHANGE ${guardFile}`)], /docs\/decisions/],
    [[{ filename: guardFile, status: "modified" }, note], [], /no Codex PASS comment/],
    [[{ filename: "scripts/tools/fg.mjs", previous_filename: guardFile, status: "renamed" }, note], [passComment()], /FLOOR-GUARD CHANGE scripts\/floor-guard/],
    [[{ filename: ".github/workflows/floor-guard.yml", status: "modified" }, note], [passComment(` FLOOR-GUARD CHANGE ${guardFile}`)], /floor-guard\.yml/],
  ];
  for (const [files, comments, why] of cases) {
    const f = fake({ files, comments, pr: { ...fake().state.pr, changed_files: files.length } });
    const r = await release(f.gh, { repo: REPO, pr: 7 });
    assert.equal(r.code, 1);
    assert.ok(r.reasons.some((x) => why.test(x)), r.reasons.join("; "));
    assert.equal(merges(f), 0);
  }
  const f = fake({ files: [{ filename: guardFile, status: "modified" }, note], comments: [passComment(` FLOOR-GUARD CHANGE ${guardFile}`)], pr: { ...fake().state.pr, changed_files: 2 } });
  assert.equal((await release(f.gh, { repo: REPO, pr: 7 })).code, 0);
});

test("B6 a file list GitHub cannot give in full is never judged (exit 2)", async () => {
  let f = fake({ pr: { ...fake().state.pr, changed_files: 3001 } });
  await assert.rejects(release(f.gh, { repo: REPO, pr: 7 }), /at most 3,000/);
  f = fake({ pr: { ...fake().state.pr, changed_files: 2 } });
  await assert.rejects(release(f.gh, { repo: REPO, pr: 7 }), /listed 1 of 2/);
});

test("B7 marker parsing: KEEP and CHANGE markers inline in the one-line summary are matched exactly", async () => {
  const f = fake({ comments: [passComment(" FLOOR-GUARD CHANGE scripts/floor-guard/floor-guard.mjs FLOOR-GUARD KEEP fg-0123456789 a b.ts:2 ok")] });
  const text = await passVerdictText(f.gh, REPO, 7, HEAD, "PR7-r2", "kkarnati1980");
  assert.ok(namesChange(text, "scripts/floor-guard/floor-guard.mjs"));
  assert.ok(!namesChange(text, "scripts/floor-guard/floor"), "a prefix is not a match");
  // Codex PR96-r1: a path with a space never covers its shorter prefix path; only the whole path matches.
  const spaced = "FLOOR-GUARD CHANGE scripts/floor-guard/a b.mjs";
  assert.ok(namesChange(spaced, "scripts/floor-guard/a b.mjs"));
  assert.ok(namesChange(spaced + "  ", "scripts/floor-guard/a b.mjs"), "trailing whitespace is ignored");
  assert.ok(!namesChange(spaced, "scripts/floor-guard/a"), "a prefix up to a space is not a match");
  assert.ok(!namesChange("FLOOR-GUARD CHANGE scripts/floor-guard/a trailing words", "scripts/floor-guard/a"), "text after the path fails closed");
  assert.match(text, /^FLOOR-GUARD KEEP fg-0123456789 a b\.ts:2 ok/m);
  const kept = applyDispositions({ sha: HEAD, exit: 1, hits: [{ id: "fg-0123456789", file: "a b.ts", line: 2 }] }, { sha: HEAD, source: "codex", text });
  assert.equal(kept.exit, 0, "a file name with a space still matches");
});

test("B8 GC1 (local): a real .skip added to a test is a floor-guard hit the Release path refuses without a Keep", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devos-gi1b-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@example.invalid"); g("config", "user.name", "t");
  const T = "packages/x/test/a.test.ts";
  fs.mkdirSync(path.join(dir, "packages/x/test"), { recursive: true });
  fs.writeFileSync(path.join(dir, T), 'import { it, expect } from "vitest";\nit("a", () => {\nexpect(1).toBe(1);\n});\n');
  g("add", "-A"); g("commit", "-qm", "base");
  g("switch", "-qc", "pr");
  fs.writeFileSync(path.join(dir, T), `import { it, expect } from "vitest";\n${SKIP}("a", () => {\nexpect(1).toBe(1);\n});\n`);
  g("commit", "-qam", "skip");
  const base = g("rev-parse", "main").trim();
  const head = g("rev-parse", "pr").trim();
  const report = guardRun({ cwd: dir, base, head });
  assert.equal(report.exit, 1);
  assert.deepEqual(report.hits.map((h) => h.rule), ["test-skipped"]);
  const f = redGuard();
  f.state.pr.head.sha = HEAD;
  const r = await release(f.gh, { repo: REPO, pr: 7, guardReport: async () => ({ report: { ...report, sha: HEAD }, applyDispositions }) });
  assert.equal(r.code, 1);
  assert.ok(r.reasons.some((x) => x.includes("test-skipped") && x.includes(T)));
  assert.equal(merges(f), 0);
  // localGuardReport refuses bad SHAs before running anything.
  await assert.rejects(localGuardReport({ mainSha: "main", sha: head, cwd: dir }), /bad SHA/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("B9 (pre-review) markers count only on the Summary line of the earliest unedited PASS comment", async () => {
  const row = `| low | x.ts:1 | quotes${keeps(HITS)} | none |\n\n`;
  const cases = [
    [passComment("", { table: row })],
    [{ ...passComment(keeps(HITS)), updated_at: "2026-11-13T10:30:00Z" }],
    [passComment(), passComment(keeps(HITS), { created_at: "2026-11-13T10:40:00Z" })],
  ];
  for (const comments of cases) {
    const f = redGuard({ comments });
    const r = await release(f.gh, { repo: REPO, pr: 7, guardReport: stubGuard({ hits: HITS }) });
    assert.equal(r.code, 1, JSON.stringify(comments).slice(0, 80));
    assert.equal(merges(f), 0);
  }
});

test("B10 (pre-review) hits spec §4.4/§4.5 keep from Codex are never set aside by a Keep", async () => {
  const kkHits = [
    { id: "fg-1111111111", rule: "gitleaksignore-added", file: ".gitleaksignore", line: 1, text: "abc:rule:1" },
    { id: "fg-2222222222", rule: "guard-change-not-isolated", file: "scripts/floor-guard/floor-guard.mjs", line: 1, text: "x" },
    { id: "fg-3333333333", rule: "ci-step-removed", file: ".github/workflows/ci.yml", line: 4, text: "Lint" },
    { id: "fg-4444444444", rule: "suppression-added", file: "apps/api/src/x.ts", line: 3, text: ["// ", "no", "sec"].join("") },
    { id: "fg-5555555555", rule: "test-skipped", file: "apps/api/src/security/a.test.ts", line: 3, text: `${SKIP}("a"` },
    { id: "fg-6666666666", rule: "policy-weakened", file: "packages/policy/src/a.ts", line: 3, text: "deny" },
  ];
  for (const h of kkHits) {
    assert.equal(notKeepable(h), true, h.rule);
    const f = redGuard({ comments: [passComment(keeps([h]))] });
    const r = await release(f.gh, { repo: REPO, pr: 7, guardReport: stubGuard({ hits: [h] }) });
    assert.equal(r.code, 1, h.rule);
    assert.ok(r.reasons.some((x) => x.includes(h.id) && x.includes("escalate to KK")), r.reasons.join("; "));
    assert.equal(merges(f), 0);
  }
  for (const h of HITS) assert.equal(notKeepable(h), false, `${h.rule} is keepable`);
});

test("B11 (pre-review) a red workflow named floor-guard from another file is never set aside", async () => {
  const f = redGuard({ comments: [passComment(keeps(HITS))] });
  f.state.workflowRuns.push({ id: 9, workflow_id: 9, name: "floor-guard", path: ".github/workflows/sneaky.yml", run_number: 1, status: "completed", conclusion: "failure" });
  const r = await release(f.gh, { repo: REPO, pr: 7, guardReport: stubGuard({ hits: HITS }) });
  assert.equal(r.code, 1);
  assert.ok(r.reasons.some((x) => x.includes("run 9")));
});

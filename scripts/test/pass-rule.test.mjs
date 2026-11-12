// DEVOS-142 (gate integrity Part 2): pass-rule validator. Contract: docs/modules/GI-2.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateContract, run } from "../contracts/check-pass-rule.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CLI = path.join(ROOT, "scripts/contracts/check-pass-rule.mjs");
const c = (rule) => `# M9 — X (contract)\n\n## Acceptance tests\n| AT1 | a |\n\n${rule}\n## Build record\n- x\n`;

test("GC3: a pass rule of \"works as expected\" fails, naming the judgement words", () => {
  const r = validateContract(c("## Pass rule\n- works as expected\n"), "M9.md");
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /references no command, test or measurable output \(judgement words only: works, as expected\)/);
});

test("GC3: a contract with no pass rule fails", () => {
  const r = validateContract(c(""), "M9.md");
  assert.deepEqual(r, { ok: false, errors: ['M9.md: no "## Pass rule" section'] });
});

test("rejected: an empty section, judgement-only bullets, and a bullet with no anchor", () => {
  assert.match(validateContract(c("## Pass rule\n\n"), "M9.md").errors[0], /is empty/);
  for (const bad of ["looks good", "no errors in the logs", "the model is confident", "the page works properly", "data is synced to Linear"]) {
    assert.equal(validateContract(c(`## Pass rule\n- ${bad}\n`)).ok, false, bad);
  }
  const mixed = validateContract(c("## Pass rule\n- `pnpm --filter x test` exits 0\n- works fine\n"));
  assert.equal(mixed.errors.length, 1, "every bullet must pass, not just one");
});

test("accepted: a command, a test file, an AT id, an exit code, an HTTP status, a threshold, a screenshot diff", () => {
  for (const good of [
    "`pnpm --filter @devos/intake test` exits 0",
    "`scripts/test/pass-rule.test.mjs` passes",
    "AT1–AT12 pass on the merged SHA",
    "the CLI exits 2 on a refusal",
    "`GET /health` returns HTTP 200 under load",
    "p95 latency at most 300 ms",
    "the job's wall time is ≤ 120 s",
    "screenshot diff of `/approvals` against the baseline is 0 pixels",
  ]) assert.equal(validateContract(c(`## Pass rule\n- ${good}\n`)).ok, true, good);
});

test("multi-line bullets, numbered lists and sub-part headings (### Pass rule (M2.2-a)) are read", () => {
  assert.equal(validateContract(c("## Pass rule\n1. the suite\n   `node --test x` exits 0\n")).ok, true);
  const parts = "## M9-a\n### Pass rule (M9-a)\n- AT1 passes\n## M9-b\n### Pass rule (M9-b)\n- seems fine\n";
  const r = validateContract(c(parts));
  assert.equal(r.errors.length, 1); assert.match(r.errors[0], /seems fine/);
});

function repo(base, head) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devos-pr-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  const w = (files) => { for (const [p, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); } };
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@example.invalid"); g("config", "user.name", "t");
  w(base); g("add", "-A"); g("commit", "-qm", "b"); g("switch", "-qc", "pr"); w(head); g("add", "-A"); g("commit", "-qm", "h", "--allow-empty");
  return dir;
}

test("diff mode checks only contracts changed in the PR, reading the head copy; untouched legacy contracts are not checked", () => {
  const dir = repo({ "docs/modules/OLD.md": c(""), "docs/modules/M9.md": c("## Pass rule\n- AT1 passes\n") },
    { "docs/modules/M9.md": c("## Pass rule\n- works\n"), "docs/modules/_template.md": c("") });
  const r = run({ cwd: dir, base: "main", head: "pr" });
  assert.equal(r.exit, 1); assert.deepEqual(r.checked, ["docs/modules/M9.md"]);
  const ok = repo({ "docs/modules/OLD.md": c("") }, { "docs/modules/M10.md": c("## Pass rule\n- `pnpm test` exits 0\n") });
  assert.equal(run({ cwd: ok, base: "main", head: "pr" }).exit, 0);
});

test("exit 2 when it cannot run (bad ref, missing arguments), via the CLI too", () => {
  const dir = repo({ "README.md": "x" }, {});
  assert.equal(run({ cwd: dir, base: "main", head: "nope" }).exit, 2);
  assert.equal(run({ cwd: dir }).exit, 2);
  assert.equal(spawnSync(process.execPath, [CLI, "--base", "main", "--head", "nope"], { cwd: dir }).status, 2);
  assert.equal(spawnSync(process.execPath, [CLI, "--base", "main", "--head", "pr"], { cwd: dir }).status, 0);
});

test("the contract template and the backfilled current-phase Lane A contracts pass", () => {
  for (const f of ["docs/modules/_template.md", "docs/modules/M2.1.md", "docs/modules/M2.2.md", "docs/modules/GI-2.md"]) {
    const r = validateContract(fs.readFileSync(path.join(ROOT, f), "utf8"), f);
    assert.deepEqual(r.errors, [], f);
  }
});

test("pre-review: no false accepts — paragraphs after a bullet, template comments, loose anchors, fenced headings", () => {
  const bad = [
    "## Pass rule\n- `pnpm test` exits 0\n\nThe dashboard looks good and the model is confident.\n",
    "## Pass rule\nThe suite `pnpm test` runs.\nAlso the UI looks good.\n",
    "## Pass rule\n<!-- run `node scripts/contracts/check-pass-rule.mjs` -->\n",
    "## Pass rule\n- works for > 1 user\n", "## Pass rule\n- upgrade v1 -> 2 works as expected\n", "## Pass rule\n- looks good within 2 days\n",
    "## Pass rule\n- the `git` history looks clean\n", "## Pass rule\n- the `make` button works properly\n", "## Pass rule\n- GCP2 is fine\n",
  ];
  for (const b of bad) assert.equal(validateContract(c(b)).ok, false, b);
  assert.equal(validateContract(c("## Example\n```md\n## Pass rule\n- AT1 passes\n```\n")).ok, false, "a heading inside a code fence is not a section");
});

test("pre-review: no false rejects — fenced commands, plural heading, pytest/axe, a bare status after 'returns'", () => {
  for (const good of [
    "## Pass rule\n- the smoke script exits 0:\n```bash\n# run it\nbash scripts/smoke.sh\n```\n",
    "## Pass rules\n- AT1 passes\n",
    "## Pass rule\n- `pytest -q tests/` exits 0\n", "## Pass rule\n- `axe http://localhost` reports at most 0 violations\n",
    "## Pass rule\n- `GET /health` returns 200\n",
  ]) assert.deepEqual(validateContract(c(good)).errors, [], good);
});

test("CLI --all outside a repository root exits 2, not 1", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devos-pr-none-"));
  assert.equal(spawnSync(process.execPath, [CLI, "--all"], { cwd: dir }).status, 2);
});

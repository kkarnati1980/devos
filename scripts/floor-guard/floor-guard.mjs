#!/usr/bin/env node
// Floor guard (DEVOS-141, gate integrity Part 1). Contract: docs/modules/GI-1.md.
// Reads the diff between a base and a head commit — never the PR description — and reports every
// weakening pattern of spec §4.2. Exit codes: 0 clean, 1 violation, 2 could not run (never clean).
// Zero dependencies on purpose: CI runs the BASE version of this file (§4.5) without an install.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const CEILINGS = Object.freeze({ ciTimeoutMinutes: 30, testTimeoutMs: 120000 });

// Paths owned by the guard: exempt from content patterns, but a change to any of them must come
// alone (with only a decision note or the GI-1 contract beside it).
export const GUARD_PATHS = [/^scripts\/floor-guard\//, /^scripts\/test\/floor-guard\.test\.mjs$/, /^\.github\/workflows\/floor-guard\.yml$/];
const GUARD_COMPANIONS = [/^docs\/decisions\/[^/]+\.md$/, /^docs\/modules\/GI-1\.md$/];

const CODE = /\.(m?[jt]sx?|c[jt]s|sh|bash|ya?ml|json|py)$/;
const TEST_FILE = /(^|\/)(test|tests|__tests__|test-db|e2e)\/.*\.(m?[jt]sx?|c[jt]s)$|\.(test|spec)\.(m?[jt]sx?|c[jt]s)$/;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const TEST_CONFIG = /(^|\/)(vitest|jest|playwright|vite)\.config\.[cm]?[jt]s$|(^|\/)\.(c8rc|nycrc)(\.json)?$|(^|\/)package\.json$/;
const SHELL = /\.(sh|bash)$/;
const LINT_CONFIG = /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[\w]+)?)$/;

const RX = {
  skip: [
    /\.(skip|only|todo)\s*\(/, /\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(/, /\b(skipIf|runIf)\s*\(/,
    /\.fixme\s*\(/, /(^|[{,])\s*(skip|todo|only)\s*:\s*[^,}\s]/, /^\s*if\s*\(.*(process\.env|\benv\.|platform|\bskip|\bCI\b).*\)\s*\{?\s*return\b/,
  ],
  assert: /\bexpect(\.\w+)?\s*\(|\bassert(\.\w+)*\s*\(/g,
  suppress: /eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|istanbul ignore|c8 ignore|\bnosec\b|gitleaks:allow/,
  envIf: /^\s*if\s*\(.*(process\.env|\benv\.|platform|\bskip|\bCI\b).*\)\s*\{\s*$/,
  trivial: /\bexpect\s*\(\s*(true|false|1|0|null|undefined|""|'')\s*\)|\bassert(\.ok)?\s*\(\s*(true|1)\s*[,)]|\bassert\.equal\s*\(\s*(\d+|true)\s*,\s*\3\s*[,)]/,
  swallow: /\|\|\s*:(\s|$|;)|\|\|\s*true\b|\bset\s+\+e\b|\|\|\s*exit\s+0\b/,
  testCmd: /\b(test|vitest|jest|playwright|tsc|eslint|lint|typecheck|pnpm|npm|npx|node --test)\b/,
  stub: /\b(TODO|FIXME)\b|not implemented/i,
  constBody: /^\s*(throw\b.*|return\s+(true|false|null|undefined|-?\d+(\.\d+)?|'[^']*'|"[^"]*"|`[^`]*`|\[\]|\{\})\s*;?)\s*$/,
  policy: /\bdeny\b|require_approval|isGate|\bgate\s*:|default-deny|wouldBlock|budget-exceeded/g,
};

const isGuard = (p) => GUARD_PATHS.some((r) => r.test(p));
const isTest = (p) => TEST_FILE.test(p);

export class GuardError extends Error {}

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw new GuardError(`git ${args.join(" ")} failed: ${(e.stderr || e.message || "").toString().trim().split("\n")[0]}`);
  }
}

/** Parse `git diff --unified=0` output into files with status, removed and added lines (with line numbers). */
export function parseDiff(text) {
  const files = [];
  let f = null, oldLn = 0, newLn = 0, inHeader = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) throw new GuardError(`unreadable diff header: ${line.slice(0, 120)}`);
      f = { oldPath: m[1], path: m[2], status: "M", removed: [], added: [], hunks: [] };
      files.push(f); inHeader = true;
    } else if (!f) {
      if (line.trim()) throw new GuardError(`unreadable diff: text before the first file header`);
    } else if (inHeader && line.startsWith("new file mode")) f.status = "A";
    else if (inHeader && line.startsWith("deleted file mode")) f.status = "D";
    else if (inHeader && line.startsWith("rename to ")) f.status = "R";
    else if (inHeader && (line.startsWith("Binary files ") || line.startsWith("GIT binary patch"))) f.binary = true;
    else if (inHeader && /^(--- |\+\+\+ |index |similarity |dissimilarity |rename from |copy |old mode|new mode)/.test(line)) { /* header */ }
    else if (line.startsWith("@@")) {
      inHeader = false;
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!m) throw new GuardError(`unreadable hunk header in ${f.path}`);
      oldLn = +m[1]; newLn = +m[2];
      f.hunks.push({ removed: [], added: [] });
    } else if (inHeader) {
      if (line.trim()) throw new GuardError(`unreadable diff header line in ${f.path}: ${line.slice(0, 80)}`);
    } else if (line.startsWith("-")) {
      const r = { ln: oldLn++, text: line.slice(1) };
      f.removed.push(r); f.hunks.at(-1)?.removed.push(r);
    } else if (line.startsWith("+")) {
      const a = { ln: newLn++, text: line.slice(1) };
      f.added.push(a); f.hunks.at(-1)?.added.push(a);
    }
  }
  return files;
}

function hitId(rule, file, text) {
  return "fg-" + createHash("sha256").update(`${rule}\0${file}\0${String(text).trim()}`).digest("hex").slice(0, 10);
}

/** Workflow structure, line-based (no YAML dependency): jobs → step identities, plus the trigger names. */
export function workflowShape(src) {
  const lines = src.split("\n");
  const indent = (s) => s.length - s.trimStart().length;
  const jobs = {};
  const on = new Set(), onLines = [];
  let jobsIndent = -1, jobIndent = -1, job = null, stepsIndent = -1, itemIndent = -1, step = null, onIndent = -1;
  for (const raw of lines) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const ind = indent(raw), t = raw.trim();
    if (ind === 0) { jobsIndent = t === "jobs:" ? 0 : -1; onIndent = /^(on|"on"|'on'):/.test(t) ? 0 : -1; job = null; stepsIndent = -1;
      if (onIndent === 0) onLines.push(t);
      const inline = /^(?:on|"on"|'on'):\s*(.+)$/.exec(t); if (inline) inline[1].replace(/[[\]]/g, "").split(",").forEach((x) => x.trim() && on.add(x.trim()));
      continue; }
    if (onIndent === 0 && ind > 0) { onLines.push(t); const m = /^-?\s*([\w-]+)\s*:?/.exec(t); if (m && (jobIndent < 0 || ind <= 2)) on.add(m[1]); continue; }
    if (jobsIndent !== 0) continue;
    if (jobIndent < 0) jobIndent = ind;
    if (ind === jobIndent) { const m = /^([\w-]+)\s*:/.exec(t); job = m ? m[1] : null; if (job) jobs[job] = []; stepsIndent = -1; continue; }
    if (!job) continue;
    if (t === "steps:") { stepsIndent = ind; itemIndent = -1; continue; }
    if (stepsIndent >= 0 && ind <= stepsIndent) stepsIndent = -1;
    if (stepsIndent < 0) continue;
    if (t.startsWith("- ") && (itemIndent < 0 || ind === itemIndent)) { itemIndent = ind; step = { id: null, body: [] }; jobs[job].push(step); }
    if (step && !/^-?\s*name\s*:/.test(t)) step.body.push(t.replace(/^-\s+/, ""));
    const m = /^-?\s*(name|uses|run)\s*:\s*(.*)$/.exec(t);
    if (step && m && (step.key !== "name")) { if (m[1] === "name" || !step.id) { step.id = `${m[1]}:${m[2].replace(/^["']|["']$/g, "").trim().replace(m[1] === "uses" ? /@[^@\s]*$/ : /$^/, "")}`; step.key = m[1]; } }
  }
  return {
    jobs: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.map((s) => s.id || "?")])),
    bodies: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, Object.fromEntries(v.map((s) => [s.id || "?", s.body.join("\n")]))])),
    on: [...on], onLines,
  };
}

function sectionOf(baseLines, ln) {
  for (let i = Math.min(ln, baseLines.length) - 1; i >= 0; i--) if (/^#{1,6}\s/.test(baseLines[i])) return baseLines[i];
  return "";
}

function numbers(lines, rx) {
  const out = [];
  for (const l of lines) for (const m of l.text.matchAll(rx)) out.push({ key: m[1].toLowerCase(), v: Number(m[2]), l });
  return out;
}

/**
 * Pure analysis. `files` from parseDiff; `show(rev, path)` returns file text at base or head (or null).
 * Returns hits [{id, rule, file, line, text}].
 */
export function analyse(files, show) {
  const hits = [];
  const hit = (rule, file, line, text) => hits.push({ id: hitId(rule, file, text), rule, file, line, text: String(text).trim().slice(0, 200) });

  const touched = files.map((f) => f.path).concat(files.map((f) => f.oldPath));
  if (touched.some(isGuard)) {
    for (const p of new Set(touched)) if (!isGuard(p) && !GUARD_COMPANIONS.some((r) => r.test(p))) hit("guard-change-not-isolated", p, 0, "a floor-guard change must come in a PR that changes nothing else");
  }

  for (const f of files) {
    const p = f.path;
    if (isGuard(p) || isGuard(f.oldPath)) continue;
    const test = isTest(p), oldTest = isTest(f.oldPath);
    const code = CODE.test(p) || p.endsWith(".gitleaksignore");

    if (oldTest && (f.status === "D" || (f.status === "R" && !test))) { hit("test-file-deleted", f.oldPath, 0, `${f.oldPath} deleted`); continue; }
    if (WORKFLOW.test(f.oldPath) && (f.status === "D" || (f.status === "R" && !WORKFLOW.test(p)))) { hit("ci-workflow-deleted", f.oldPath, 0, `${f.oldPath} deleted`); continue; }
    if (/^docs\/modules\/[^/]+\.md$/.test(f.oldPath) && (f.status === "D" || (f.status === "R" && f.oldPath !== p))) hit("contract-weakened", f.oldPath, 0, `${f.oldPath} ${f.status === "D" ? "deleted" : "moved to " + p}`);
    if (/(^|\/)\.gitattributes$/.test(p) || /(^|\/)\.gitattributes$/.test(f.oldPath)) { hit("gitattributes-changed", p, 0, "a .gitattributes change can hide diffs from the guard"); continue; }
    if (f.binary) { if (code || test || oldTest || /^packages\/policy\//.test(p)) hit("binary-code-change", p, 0, `${p} changed as binary`); continue; }

    if (test) {
      const removedTrim = new Set(f.removed.map((r) => r.text.trim()));
      f.added.forEach((a, i) => {
        if (RX.skip.some((r) => r.test(a.text))) hit("test-skipped", p, a.ln, a.text);
        else if (RX.envIf.test(a.text) && /^\s*return\b/.test(f.added[i + 1]?.text ?? "") && f.added[i + 1].ln === a.ln + 1) hit("test-skipped", p, a.ln, a.text);
        if (RX.trivial.test(a.text) && !removedTrim.delete(a.text.trim())) hit("trivial-assertion", p, a.ln, a.text);
      });
      const count = (ls) => ls.reduce((n, l) => n + [...l.text.matchAll(RX.assert)].length, 0);
      const lost = count(f.removed) - count(f.added);
      if (lost > 0) hit("assertions-lost", p, 0, `net ${lost} expect/assert call(s) removed`);
    }

    if (code) for (const a of f.added) if (RX.suppress.test(a.text)) hit("suppression-added", p, a.ln, a.text);
    if (p.endsWith(".gitleaksignore")) for (const a of f.added) if (a.text.trim() && !a.text.trim().startsWith("#")) hit("gitleaksignore-added", p, a.ln, a.text);

    // around test commands: every added line of a workflow or package.json; in shell scripts, lines that run a test/check tool
    if (WORKFLOW.test(p) || p.endsWith("package.json")) for (const a of f.added) if (RX.swallow.test(a.text)) hit("failure-swallowed", p, a.ln, a.text);
    if (SHELL.test(p)) for (const a of f.added) if (RX.swallow.test(a.text) && RX.testCmd.test(a.text)) hit("failure-swallowed", p, a.ln, a.text);

    if (WORKFLOW.test(p)) {
      for (const a of f.added) {
        if (/continue-on-error\s*:\s*(true|\$\{\{)/.test(a.text)) hit("ci-continue-on-error", p, a.ln, a.text);
        if (/^\s*(-\s*)?if\s*:\s*(false|\$\{\{\s*false\s*\}\})\s*$/.test(a.text)) hit("ci-disabled", p, a.ln, a.text);
      }
      const before = f.status === "A" ? null : show("base", f.oldPath), after = show("head", p);
      if (after == null || (before == null && f.status !== "A")) throw new GuardError(`cannot read workflow ${p} at base/head`);
      if (before != null) {
        const b = workflowShape(before), h = workflowShape(after);
        for (const [job, steps] of Object.entries(b.jobs)) {
          if (!(job in h.jobs)) { hit("ci-job-removed", p, 0, `job ${job} removed`); continue; }
          for (const s of steps) {
            if (!h.jobs[job].includes(s)) hit("ci-step-removed", p, 0, `job ${job}: step ${s} removed`);
            else if (b.bodies[job][s] !== h.bodies[job][s]) hit("ci-step-changed", p, 0, `job ${job}: step ${s} changed`);
          }
        }
        for (const t of b.on) if (!h.on.includes(t)) hit("ci-trigger-removed", p, 0, `trigger ${t} removed`);
        const left = [...h.onLines];
        for (const l of b.onLines) { const i = left.indexOf(l); if (i >= 0) left.splice(i, 1); else hit("ci-trigger-narrowed", p, 0, `trigger line "${l}" changed or removed`); }
        for (const l of left) if (/^(types|branches|tags|paths|paths-ignore|branches-ignore|tags-ignore)\s*:/.test(l)) hit("ci-trigger-narrowed", p, 0, `trigger filter "${l}" added`);
      }
    }

    // thresholds: CI timeout-minutes and test timeouts past the ceiling; coverage lowered; retries / max-warnings raised.
    if (WORKFLOW.test(p)) for (const a of f.added) { const m = /timeout-minutes\s*:\s*(\d+)/.exec(a.text); if (m && +m[1] > CEILINGS.ciTimeoutMinutes) hit("timeout-past-ceiling", p, a.ln, a.text); }
    if (test || TEST_CONFIG.test(p)) for (const a of f.added) for (const m of a.text.matchAll(/\b(testTimeout|hookTimeout|timeout)\s*[:=]\s*(\d[\d_]*)/g)) if (+m[2].replace(/_/g, "") > CEILINGS.testTimeoutMs) hit("timeout-past-ceiling", p, a.ln, a.text);
    if (TEST_CONFIG.test(p) || test || WORKFLOW.test(p)) {
      const cov = /\b(lines|branches|functions|statements|threshold|perFile)\b["']?\s*[:=]\s*(\d+(?:\.\d+)?)/g;
      const was = numbers(f.removed, cov), now = numbers(f.added, cov);
      for (const n of now) { const o = was.find((w) => w.key === n.key); if (o && n.v < o.v) hit("coverage-lowered", p, n.l.ln, n.l.text); }
      for (const o of was) if (!now.some((n) => n.key === o.key)) hit("coverage-lowered", p, o.l.ln, `removed: ${o.l.text}`);
      for (const a of f.added) if (/\b(exclude|testPathIgnorePatterns|testIgnore|modulePathIgnorePatterns|coveragePathIgnorePatterns)\b["']?\s*[:=]/.test(a.text) && !WORKFLOW.test(p)) hit("tests-excluded", p, a.ln, a.text);
      const retry = /(?<![\w-])(retries|retry|maxRetries)["']?\s*[:=\s]\s*(\d+)/g;
      const rw = numbers(f.removed, retry), rn = numbers(f.added, retry);
      for (const n of rn) { const o = rw.find((w) => w.key === n.key); if ((o && n.v > o.v) || (!o && n.v > 0 && !WORKFLOW.test(p))) hit("retries-raised", p, n.l.ln, n.l.text); }
      const mw = /--max-warnings[=\s]+(-?\d+)/;
      const val = (m) => (+m[1] < 0 ? Infinity : +m[1]);
      const mwOld = f.removed.map((l) => mw.exec(l.text)).filter(Boolean), mwNew = f.added.map((l) => [l, mw.exec(l.text)]).filter(([, m]) => m);
      for (const [l, m] of mwNew) if (val(m) === Infinity || mwOld.some((o) => val(m) > val(o))) hit("max-warnings-raised", p, l.ln, l.text);
      if (mwOld.length && !mwNew.length && !f.added.some((l) => l.text.includes("--max-warnings"))) hit("max-warnings-raised", p, 0, "--max-warnings removed");
    }

    if (p.endsWith("package.json")) {
      const scripts = (ls) => new Map(ls.map((l) => /^\s*"((?:test|lint|typecheck|check)(?::[\w:-]+)?)"\s*:\s*"(.*)"\s*,?\s*$/.exec(l.text)).filter(Boolean).map((m) => [m[1], m[2]]));
      const was = scripts(f.removed), now = scripts(f.added);
      for (const [k, v] of was) if (now.get(k) !== v) hit("test-script-changed", p, 0, `script "${k}": "${v}" -> ${now.has(k) ? `"${now.get(k)}"` : "removed"}`);
    }
    if (LINT_CONFIG.test(p)) for (const a of f.added) if (/[@\w/-]+["']?\s*:\s*\[?\s*(["'](off|warn)["']|[01]\s*[,\]}]|[01]\s*$)/.test(a.text) || /\bignores?\s*:/.test(a.text)) hit("lint-rule-off", p, a.ln, a.text);

    // stubs in non-test source
    if (code && !test && !WORKFLOW.test(p) && !p.endsWith(".json") && !p.startsWith("docs/")) {
      for (const a of f.added) if (RX.stub.test(a.text)) hit("stub-marker", p, a.ln, a.text);
      for (const h of f.hunks) {
        const rem = h.removed.filter((l) => l.text.trim() && !/^[{}();\s]*$/.test(l.text));
        const add = h.added.filter((l) => l.text.trim() && !/^[{}();\s]*$/.test(l.text));
        if (rem.length >= 3 && add.length === 1 && RX.constBody.test(add[0].text)) hit("stub-body", p, add[0].ln, add[0].text);
      }
    }

    // contract weakening: removed/reworded lines in an acceptance-test or pass-rule section of an existing contract
    if (/^docs\/modules\/[^/]+\.md$/.test(f.oldPath) && f.status !== "A") {
      const base = show("base", f.oldPath);
      if (base == null) throw new GuardError(`cannot read base ${f.oldPath}`);
      const bl = base.split("\n");
      for (const r of f.removed) if (r.text.trim() && /acceptance|pass rule|green/i.test(sectionOf(bl, r.ln))) hit("contract-weakened", f.oldPath, r.ln, r.text);
    }

    // policy weakening: net loss of decision keywords in packages/policy source, or any removal in a rules file
    if (/^packages\/policy\/(src|rules)\//.test(f.oldPath) && !test) {
      if (/^packages\/policy\/rules\//.test(f.oldPath)) { for (const r of f.removed) if (r.text.trim()) hit("policy-weakened", f.oldPath, r.ln, r.text); }
      else {
        const c = (ls) => ls.reduce((n, l) => n + [...l.text.matchAll(RX.policy)].length, 0);
        const lost = c(f.removed) - c(f.added);
        if (lost > 0 || f.status === "D") hit("policy-weakened", f.oldPath, 0, `net ${Math.max(lost, 1)} deny/gate/approval reference(s) removed`);
      }
    }
  }
  return hits;
}

/**
 * Dispositions (spec §4.4). A Keep is valid only for the SHA the report was made on, and only when the Codex
 * verdict for that same SHA names the hit's id and its file:line on a line "FLOOR-GUARD KEEP <id> <file>:<line> …".
 * Returns { exit, open: hits without a valid Keep }.
 */
export function applyDispositions(report, verdict) {
  if (!report || report.exit === 2) return { exit: 2, open: report?.hits ?? [] };
  if (!verdict || verdict.sha !== report.sha || verdict.source !== "codex") return { exit: report.hits.length ? 1 : 0, open: report.hits };
  const keeps = new Set();
  for (const m of String(verdict.text).matchAll(/^\s*FLOOR-GUARD KEEP (fg-[0-9a-f]{10}) (\S+):(\d+)\b/gm)) keeps.add(`${m[1]} ${m[2]}:${m[3]}`);
  const open = report.hits.filter((h) => !keeps.has(`${h.id} ${h.file}:${h.line}`));
  return { exit: open.length ? 1 : 0, open };
}

/** Run against a repository: base...head (merge base to head). Never throws; exit 2 on any failure to run. */
export function run({ cwd = process.cwd(), base, head }) {
  let sha = null;
  try {
    if (!base || !head) throw new GuardError("usage: floor-guard.mjs --base <rev> --head <rev>");
    sha = git(cwd, ["rev-parse", "--verify", `${head}^{commit}`]).trim();
    const mb = git(cwd, ["merge-base", base, sha]).trim();
    const diff = git(cwd, ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--text", "--src-prefix=a/", "--dst-prefix=b/", "--unified=0", "--find-renames", mb, sha]);
    const revs = { base: mb, head: sha };
    const show = (rev, p) => { try { return execFileSync("git", ["show", `${revs[rev]}:${p}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }); } catch { return null; } };
    const hits = analyse(parseDiff(diff), show);
    return { sha, base: mb, exit: hits.length ? 1 : 0, hits };
  } catch (e) {
    return { sha, exit: 2, hits: [], error: e instanceof GuardError ? e.message : `internal error: ${e?.message ?? e}` };
  }
}

function main(argv) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const report = run({ base: arg("--base"), head: arg("--head") });
  for (const h of report.hits) console.log(`HIT ${h.id} ${h.rule} ${h.file}:${h.line} ${h.text}`);
  if (report.exit === 2) console.error(`floor-guard: could not run: ${report.error}`);
  console.log(`floor-guard: exit ${report.exit} (${report.hits.length} hit(s)) on ${report.sha ?? "?"}`);
  const out = arg("--report");
  if (out) { try { fs.writeFileSync(out, JSON.stringify(report, null, 2)); } catch (e) { console.error(`floor-guard: cannot write report: ${e.message}`); return 2; } }
  return report.exit;
}

const isMain = () => { try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] ?? ""); } catch { return false; } };
if (isMain()) process.exit(main(process.argv.slice(2)));

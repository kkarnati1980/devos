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
const TEST_FILE = /(^|\/)(test|tests|__tests__|test-db|e2e)\/.*\.(m?[jt]sx?|c[jt]s)$|\.(test|spec)\.[\w-]+$/; // any extension for the *.test.* / *.spec.* suffix (PR70-r5)
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const TEST_CONFIG = /(^|\/)(vitest|jest|playwright|vite)\.config\.[cm]?[jt]s$|(^|\/)\.(c8rc|nycrc)(\.json)?$|(^|\/)package\.json$/;
const SHELL = /\.(sh|bash)$/;
const TSCONFIG = /(^|\/)tsconfig[\w.-]*\.json$/;
// TypeScript strictness flags; turning one off (or dropping a `true`) relaxes type checking (GI-1c).
const TS_STRICT = ["strict", "noImplicitAny", "strictNullChecks", "strictFunctionTypes", "strictBindCallApply", "strictPropertyInitialization",
  "noImplicitThis", "alwaysStrict", "useUnknownInCatchVariables", "exactOptionalPropertyTypes", "noUncheckedIndexedAccess"];

/** Parse JSONC (tsconfig): comments and trailing commas removed outside strings only. Returns null if unreadable. */
export function parseJsonc(text) {
  let out = "", i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') { let j = i + 1; while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1; out += text.slice(i, j + 1); i = j + 1; }
    else if (c === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") i++; }
    else if (c === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); if (e < 0) return null; out += " "; i = e + 2; }
    else if (c === ",") { let j = i + 1; while (j < n && /\s/.test(text[j])) j++; if (text[j] !== "}" && text[j] !== "]") out += c; i++; }
    else { out += c; i++; }
  }
  // a comment between a comma and the closing bracket was removed above, so re-check trailing commas once more
  out = out.replace(/,(\s*[}\]])/g, (m, rest, off) => (inString(out, off) ? m : rest));
  try { return JSON.parse(out); } catch { return null; }
}
function inString(t, off) { let q = false; for (let i = 0; i < off; i++) { if (t[i] === "\\" && q) i++; else if (t[i] === '"') q = !q; } return q; }
const LINT_CONFIG = /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[\w]+)?)$/;

const RX = {
  skip: [
    /\.(skip|only|todo)\s*\(/, /\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(/, /\b(skipIf|runIf)\s*\(/,
    /\.fixme\s*\(/, /(^|[{,])\s*(skip|todo|only)\s*:\s*[^,}\s]/,
    // a skip referenced without being called, e.g. a ternary `(cond ? it : it.skip)("a", …)` or `const t = it.skip` (GI-1c)
    /\b(?:it|test|describe|suite)\.(?:(?:concurrent|serial|sequential)\.)?(?:skip|todo|only|fixme)\b(?!\s*\()/,
    // bare forms only after an operator, so the word "fit" in a test name or string is not a hit (review GI-1c-r2)
    /[?:=(,|&]\s*\b(?:xit|xdescribe|xtest|fit|fdescribe)\b(?!\s*\()/, /^\s*if\s*\(.*(process\.env|\benv\.|platform|\bskip|\bCI\b).*\)\s*\{?\s*return\b/,
  ],
  assert: /\bexpect(\.\w+)?\s*\(|\bassert(\.\w+)*\s*\(/g,
  suppress: /eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|istanbul ignore|c8 ignore|\bnosec\b|gitleaks:allow/,
  envIf: /^\s*if\s*\(.*(process\.env|\benv\.|platform|\bskip|\bCI\b).*\)\s*\{\s*$/,
  trivial: [ // separate expressions, so no back-reference can point at the wrong group
    /\bexpect\s*\(\s*(true|false|1|0|null|undefined|""|'')\s*\)/,
    /\bassert(\.ok)?\s*\(\s*(true|1)\s*[,)]/,
    /\bassert\.(?:strict)?(?:deep)?(?:[Ee]qual|[Ss]trictEqual)\s*\(\s*(-?\d+(?:\.\d+)?|true|false|null|undefined|"[^"]*"|'[^']*')\s*,\s*\1\s*[,)]/,
  ],
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
export function parseDiff(text, { pairs = null } = {}) {
  const headers = pairs ? new Map(pairs.map(([o, n]) => [`diff --git a/${o} b/${n}`, [o, n]])) : null;
  const files = [];
  let f = null, oldLn = 0, newLn = 0, inHeader = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // With the -z name-status pairs, match the header exactly, so a path containing " b/" splits right (GI-1c).
      const pair = headers?.get(line);
      const m = pair ? [line, pair[0], pair[1]] : /^diff --git a\/(.+) b\/(.+)$/.exec(line);
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

/** Drops a trailing ` # comment` (outside quotes) and unquotes a leading mapping key (after an optional `- `). */
function normaliseYamlLine(raw) {
  let quote = null, cut = raw.length;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if ((ch === '"' || ch === "'") && (i === 0 || /[\s:\[{,-]/.test(raw[i - 1]))) quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(raw[i - 1]))) { cut = i; break; }
  }
  const line = raw.slice(0, cut).replace(/\s+$/, "");
  return line.replace(/^(\s*(?:-\s+)?)(["'])([^"']*)\2(\s*:)/, "$1$3$4");
}

/** Workflow structure, line-based (no YAML dependency): jobs → step identities, plus the trigger names. */
export function workflowShape(src) {
  // YAML comments and quoted keys are normalised first (PR70-r15): `steps: # checks` is `steps:`, `"build":` is
  // `build:`. Base and head are normalised alike, so a comment-only edit is not a change.
  const lines = src.split("\n").map(normaliseYamlLine);
  const indent = (s) => s.length - s.trimStart().length;
  const jobs = {};
  const on = new Set(), onLines = [], onStack = [];
  let jobsIndent = -1, jobIndent = -1, job = null, stepsIndent = -1, itemIndent = -1, step = null, onIndent = -1, opaque = null;
  for (const raw of lines) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const ind = indent(raw), t = raw.trim();
    if (ind === 0 && /^jobs\s*:\s*\S/.test(t)) {
      // A flow-style `jobs: {…}` mapping is not parsed: it fails closed as one opaque job and step, continuation
      // lines included, so any edit is ci-step-changed and its removal ci-step-removed (PR70-r17).
      jobsIndent = -1; onIndent = -1; job = null; stepsIndent = -1;
      opaque = { id: "inline-jobs", body: [t.replace(/^jobs\s*:\s*/, "")], ind: 0 }; jobs["(inline-jobs)"] = [opaque]; continue;
    }
    // continuation lines of an opaque flow value (deeper than the line that opened it) belong to it
    if (opaque && ind > opaque.ind) { opaque.body.push(t); continue; }
    opaque = null;
    if (ind === 0) { jobsIndent = t === "jobs:" ? 0 : -1; onIndent = /^(on|"on"|'on'):/.test(t) ? 0 : -1; job = null; stepsIndent = -1;
      if (onIndent === 0) { onLines.push(t); onStack.length = 0; }
      const inline = /^(?:on|"on"|'on'):\s*(.+)$/.exec(t); if (inline) inline[1].replace(/[[\]]/g, "").split(",").forEach((x) => x.trim() && on.add(x.trim()));
      continue; }
    if (onIndent === 0 && ind > 0) {
      // keep each trigger line's parent keys, so moving a filter from one event to another is a change (PR70-r9)
      while (onStack.length && onStack.at(-1).ind >= ind) onStack.pop();
      onLines.push(onStack.map((k) => k.key + " > ").join("") + t);
      const key = /^([\w-]+)\s*:/.exec(t); if (key) onStack.push({ ind, key: key[1] });
      const m = /^-?\s*([\w-]+)\s*:?/.exec(t); if (m && (jobIndent < 0 || ind <= 2)) on.add(m[1]);
      continue;
    }
    if (jobsIndent !== 0) continue;
    if (jobIndent < 0) jobIndent = ind;
    if (ind === jobIndent) {
      const m = /^([\w-]+)\s*:\s*(.*)$/.exec(t); job = m ? m[1] : null; if (job) jobs[job] = []; stepsIndent = -1;
      // A job given as an inline flow mapping (`build: {runs-on: …, steps: […]}`) is not parsed: it fails closed as one
      // opaque step holding the whole value, continuation lines included (PR70-r17).
      if (job && m[2]) { opaque = { id: "inline-job", body: [m[2]], ind }; jobs[job].push(opaque); }
      continue;
    }
    if (!job) continue;
    if (t === "steps:") { stepsIndent = ind; itemIndent = -1; continue; }
    // A flow-style or other inline step list is not parsed into steps: it fails closed as one opaque step, so any
    // edit to it is a ci-step-changed hit and its removal a ci-step-removed hit (PR70-r16).
    const inl = /^steps\s*:\s*(\S.*)$/.exec(t);
    if (inl) { opaque = { id: "inline-steps", body: [inl[1]], ind }; jobs[job].push(opaque); stepsIndent = -1; continue; }
    // YAML allows the step list at the same indentation as "steps:"; anything else at or above that indent ends it
    if (stepsIndent >= 0 && (ind < stepsIndent || (ind === stepsIndent && !t.startsWith("- ")))) stepsIndent = -1;
    if (stepsIndent < 0) continue;
    let keyLevel = false;
    if (t.startsWith("- ") && (itemIndent < 0 || ind === itemIndent) && ind >= stepsIndent) {
      itemIndent = ind; step = { id: null, body: [], keyIndent: ind + (t.length - t.replace(/^-\s+/, "").length) }; jobs[job].push(step); keyLevel = true;
    } else if (step && ind === step.keyIndent) keyLevel = true;
    // only the step's own `name:` is its identity; a nested `with: name:` or env entry is body (PR70-r5)
    const own = keyLevel && /^-?\s*name\s*:/.test(t);
    // keep indentation relative to the step's keys, so re-nesting a line (e.g. under `if False:`) is a change (PR70-r6)
    if (step && !own) step.body.push(" ".repeat(Math.max(0, ind - step.keyIndent)) + t.replace(/^-\s+/, ""));
    const m = keyLevel ? /^-?\s*(name|uses|run)\s*:\s*(.*)$/.exec(t) : null;
    if (step && m && (step.key !== "name")) { if (m[1] === "name" || !step.id) { step.id = `${m[1]}:${m[2].replace(/^["']|["']$/g, "").trim().replace(m[1] === "uses" ? /@[^@\s]*$/ : /$^/, "")}`; step.key = m[1]; } }
  }
  for (const steps of Object.values(jobs)) { // duplicate identities get #2, #3 … so multiplicity counts
    const seen = {};
    for (const st of steps) { const id = st.id || "?"; seen[id] = (seen[id] ?? 0) + 1; st.id = seen[id] > 1 ? `${id}#${seen[id]}` : id; }
  }
  return {
    jobs: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.map((s) => s.id || "?")])),
    bodies: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, Object.fromEntries(v.map((s) => [s.id || "?", s.body.join("\n")]))])),
    on: [...on], onLines,
  };
}

/** The heading chain above a line (nearest first, then each shallower ancestor), so a subsection of an acceptance
 * section is still inside it (PR70-r8). */
function sectionOf(baseLines, ln) {
  const chain = [];
  let level = 7;
  for (let i = Math.min(ln, baseLines.length) - 1; i >= 0 && level > 1; i--) {
    const m = /^(#{1,6})\s/.exec(baseLines[i]);
    if (m && m[1].length < level) { chain.push(baseLines[i]); level = m[1].length; }
  }
  return chain.join("\n");
}

/** A JS/TS/YAML numeric literal as written: separators (`1_000`), hex/octal/binary, decimals, exponents (PR70-r13). */
const NUM = String.raw`(0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)`;
const num = (s) => { const v = Number(s.replace(/_/g, "")); return Number.isNaN(v) ? Infinity : v; };

function numbers(lines, rx) {
  const out = [];
  for (const l of lines) for (const m of l.text.matchAll(rx)) out.push({ key: m[1].toLowerCase(), v: num(m[2]), l });
  return out;
}

/** `"key": v` / `'key': v` → `key: v` anywhere on the line (block or flow mapping), keeping indentation and `- ` markers (PR70-r18, PR70-r19). */
function unquoteKey(text) {
  return text.replace(/(^|[\s{,\[-])(["'])([\w.-]+)\2(\s*:)/g, "$1$3$4");
}

/**
 * Maps every line (1-based) of a YAML block scalar (`key: >-`, `key: |`, with indicators) to one logical line,
 * `key: <value lines joined by spaces>`, with key quotes removed (PR70-r20).
 */
function blockScalars(text) {
  const lines = text.split("\n"), out = new Map();
  const ind = (l) => l.length - l.trimStart().length;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*(?:-\s*)?[\w.-]+\s*:)\s*[|>][+-]?\d*\s*(?:#.*)?$/.exec(unquoteKey(lines[i]));
    if (!m) continue;
    const base = ind(lines[i]) + (/^\s*-\s/.test(lines[i]) ? 2 : 0);
    let j = i + 1;
    const parts = [];
    while (j < lines.length && (!lines[j].trim() || ind(lines[j]) > base)) { if (lines[j].trim()) parts.push(lines[j].trim()); j++; }
    const b = { start: i + 1, text: `${m[1]} ${parts.join(" ")}` };
    for (let k = i; k < j; k++) out.set(k + 1, b);
    i = j - 1;
  }
  return out;
}

/** True when an `if:` value is constant-false, quoted or not, bare or in ${{ }} (PR70-r12, PR70-r13). */
function constFalseIf(text) {
  const m = /^\s*(?:-\s*)?if\s*:\s*(.*?)\s*(?:#.*)?$/.exec(text);
  if (!m) return false;
  let e = m[1].trim();
  for (let i = 0; i < 3; i++) {
    const q = /^(["'])(.*)\1$/.exec(e); if (q) e = q[2].trim();
    const x = /^\$\{\{(.*)\}\}$/.exec(e); if (x) e = x[1].trim();
  }
  return constFalseExpr(e);
}

/** Splits an expression at top-level `op` (outside parentheses and quoted strings). */
function splitTop(e, op) {
  const out = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < e.length; i++) {
    const ch = e[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && e.startsWith(op, i)) { out.push(e.slice(start, i)); start = i + op.length; i += op.length - 1; }
  }
  out.push(e.slice(start));
  return out.map((x) => x.trim());
}

/** `( x )` → `x` only when the outer parentheses are one matching pair (not `(a) || (b)`); otherwise null. */
function unwrap(e) {
  if (!e.startsWith("(") || !e.endsWith(")")) return null;
  let depth = 0, quote = null;
  for (let i = 0; i < e.length; i++) {
    const ch = e[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0 && i < e.length - 1) return null;
  }
  return e.slice(1, -1).trim();
}

/**
 * Constant-false with GitHub expression precedence (`&&` binds tighter than `||`, PR70-r14): an `||` chain is false
 * only when every operand is; an `&&` chain is false when any operand is; parentheses are unwrapped.
 */
function constFalseExpr(e, depth = 0) {
  e = e.trim();
  if (depth > 20) return false;
  const or = splitTop(e, "||");
  if (or.length > 1) return or.every((x) => constFalseExpr(x, depth + 1));
  const and = splitTop(e, "&&");
  if (and.length > 1) return and.some((x) => constFalseExpr(x, depth + 1));
  const inner = unwrap(e);
  if (inner !== null) return constFalseExpr(inner, depth + 1);
  return /^(?:false|0|''|""|null|!\s*true)$/.test(e);
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
    // workflows: a quoted key (`"timeout-minutes":`, `'if':`) is the same YAML key, so every workflow rule reads
    // the changed lines with key quotes removed (PR70-r18, PR70-r19)
    if (WORKFLOW.test(p)) for (const side of ["added", "removed"]) f[side] = f[side].map((l) => ({ ...l, text: unquoteKey(l.text) }));
    // a block scalar (`if: >-` / `if: |` with the value on the lines below) is read as one logical line, from the
    // head copy, whether the key line or a value line changed (PR70-r20)
    if (WORKFLOW.test(p) && f.added.length && f.status !== "D") {
      const logical = blockScalars(show("head", p) ?? "");
      const seen = new Set();
      f.added = f.added.map((l) => {
        const b = logical.get(l.ln);
        if (!b || seen.has(b.start)) return b ? { ...l, text: "" } : l;
        seen.add(b.start);
        return { ...l, text: b.text };
      });
    }
    if (isGuard(p) || isGuard(f.oldPath)) continue;
    const test = isTest(p), oldTest = isTest(f.oldPath);
    const code = CODE.test(p) || p.endsWith(".gitleaksignore");

    if (oldTest && (f.status === "D" || (f.status === "R" && !test))) { hit("test-file-deleted", f.oldPath, 0, `${f.oldPath} deleted`); continue; }
    if (WORKFLOW.test(f.oldPath) && (f.status === "D" || (f.status === "R" && !WORKFLOW.test(p)))) { hit("ci-workflow-deleted", f.oldPath, 0, `${f.oldPath} deleted`); continue; }
    if (/^docs\/modules\/[^/]+\.md$/.test(f.oldPath) && (f.status === "D" || (f.status === "R" && f.oldPath !== p))) hit("contract-weakened", f.oldPath, 0, `${f.oldPath} ${f.status === "D" ? "deleted" : "moved to " + p}`);
    if (/(^|\/)\.gitattributes$/.test(p) || /(^|\/)\.gitattributes$/.test(f.oldPath)) { hit("gitattributes-changed", p, 0, "a .gitattributes change can hide diffs from the guard"); continue; }
    // Defence in depth: run() diffs with --text, so git never reports a binary file; a caller of analyse() might (GI-1c).
    if (f.binary) { if (code || test || oldTest || /^packages\/policy\//.test(p)) hit("binary-code-change", p, 0, `${p} changed as binary`); continue; }

    if (test) {
      const removedTrim = new Set(f.removed.map((r) => r.text.trim()));
      let headLines = null;
      const addedLn = new Set(f.added.map((a) => a.ln));
      f.added.forEach((a, i) => {
        if (RX.skip.some((r) => r.test(a.text))) hit("test-skipped", p, a.ln, a.text);
        // an added early return right under an env/platform/skip condition, whether that condition is added or
        // already there (PR70-r6): the line above it is read from the head copy of the file
        // an added env/platform/CI/skip condition directly above a return that is already there (PR70-r18)
        else if (RX.envIf.test(a.text)) {
          headLines ??= (show("head", p) ?? "").split("\n");
          let j = a.ln;
          while (j < headLines.length && !headLines[j].trim()) j++;
          if (j < headLines.length && /^\s*return\b/.test(headLines[j]) && !addedLn.has(j + 1)) hit("test-skipped", p, a.ln, `${a.text.trim()} ${headLines[j].trim()}`);
        }
        else if (/^\s*return\b/.test(a.text)) {
          headLines ??= (show("head", p) ?? "").split("\n");
          let j = a.ln - 2;
          while (j >= 0 && !headLines[j].trim()) j--;
          if (j >= 0 && RX.envIf.test(headLines[j])) hit("test-skipped", p, a.ln, `${headLines[j].trim()} ${a.text.trim()}`);
        }
        if (RX.trivial.some((r) => r.test(a.text)) && !removedTrim.delete(a.text.trim())) hit("trivial-assertion", p, a.ln, a.text);
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
        // a quoted key (`"continue-on-error":`, `'if':`) is the same key (PR70-r18)
        const t = unquoteKey(a.text);
        if (/continue-on-error\s*:\s*(["']\s*)?(true|\$\{\{)/.test(t)) hit("ci-continue-on-error", p, a.ln, a.text);
        // a trailing YAML comment is still `if: false` (PR70-r12); job-level and step-level alike
        if (constFalseIf(t)) hit("ci-disabled", p, a.ln, a.text);
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
        for (const l of left) {
          const parts = l.split(" > "), last = parts.at(-1), parents = parts.slice(0, -1);
          // a new filter key; any entry added under an *-ignore list; or a `!` exclusion added under an allow-list
          // (PR70-r10). A plain entry added under branches/paths/tags/types only widens the trigger.
          if (/^(types|branches|tags|paths|paths-ignore|branches-ignore|tags-ignore)\s*:/.test(last)
            || parents.some((k) => /^(paths|branches|tags)-ignore$/.test(k))
            || (/^(paths|branches|tags)$/.test(parents.at(-1) ?? "") && /^-\s*["']?!/.test(last)))
            hit("ci-trigger-narrowed", p, 0, `trigger filter "${l}" added`);
        }
      }
    }

    // thresholds: CI timeout-minutes and test timeouts past the ceiling; coverage lowered; retries / max-warnings raised.
    if (WORKFLOW.test(p)) for (const a of f.added) { const m = new RegExp(String.raw`timeout-minutes\s*:\s*["']?` + NUM).exec(a.text); if (m && num(m[1]) > CEILINGS.ciTimeoutMinutes) hit("timeout-past-ceiling", p, a.ln, a.text); }
    if (test || TEST_CONFIG.test(p)) for (const a of f.added) for (const m of a.text.matchAll(new RegExp(String.raw`\b(testTimeout|hookTimeout|timeout)["']?\s*[:=]\s*` + NUM, "g"))) if (num(m[2]) > CEILINGS.testTimeoutMs) hit("timeout-past-ceiling", p, a.ln, a.text);
    if (TEST_CONFIG.test(p) || test || WORKFLOW.test(p)) {
      const cov = new RegExp(String.raw`\b(lines|branches|functions|statements|threshold|perFile)\b["']?\s*[:=]\s*` + NUM, "g");
      const was = numbers(f.removed, cov), now = numbers(f.added, cov);
      // pair the k-th new occurrence of a key with its k-th old one, so nested/per-path thresholds compare in place (PR70-r2)
      const byKey = (xs) => xs.reduce((m, x) => (m[x.key] ??= []).push(x) && m, {});
      const wk = byKey(was), nk = byKey(now);
      for (const [key, olds] of Object.entries(wk)) {
        const news = nk[key] ?? [];
        olds.forEach((o, k) => { const n = news[k]; if (!n) hit("coverage-lowered", p, o.l.ln, `removed: ${o.l.text}`); else if (n.v < o.v) hit("coverage-lowered", p, n.l.ln, n.l.text); });
      }
      // boolean coverage switches: perFile / all / enabled turned off or removed
      const on = /\b(perFile|all|enabled|reportOnFailure)\b["']?\s*[:=]\s*true\b/g;
      const onKeys = (ls) => ls.flatMap((l) => [...l.text.matchAll(on)].map((m) => [l, m])); // every switch on a line (PR70-r3)
      // count each switch as a multiset, so one of two `enabled: true` turned off is still a loss (PR70-r4)
      const addedOn = onKeys(f.added).reduce((c, [, m]) => c.set(m[1], (c.get(m[1]) ?? 0) + 1), new Map());
      // the zero-context diff may not show the `coverage:` key around a changed switch, so the whole base/head file
      // is read when the changed lines do not mention it (PR70-r7)
      const mentionsCoverage = () => [show("base", f.oldPath), show("head", p)].some((x) => x != null && /coverage/.test(x));
      if (/coverage|c8rc|nycrc/i.test(p) || f.removed.concat(f.added).some((l) => /coverage/.test(l.text)) || TEST_CONFIG.test(p) || mentionsCoverage())
        for (const [l, m] of onKeys(f.removed)) { const left = addedOn.get(m[1]) ?? 0; if (left > 0) addedOn.set(m[1], left - 1); else hit("coverage-lowered", p, l.ln, `${m[1]} no longer true: ${l.text}`); }
      for (const a of f.added) if (/\b(exclude|testPathIgnorePatterns|testIgnore|modulePathIgnorePatterns|coveragePathIgnorePatterns)\b["']?\s*[:=]/.test(a.text) && !WORKFLOW.test(p)) hit("tests-excluded", p, a.ln, a.text);
      const retry = new RegExp(String.raw`(?<![\w-])(retries|retry|maxRetries)["']?\s*[:=\s]\s*` + NUM, "g");
      const rw = numbers(f.removed, retry), rn = numbers(f.added, retry);
      // pair the k-th new occurrence of a key with its k-th old one, as for coverage (PR70-r4)
      const rwk = byKey(rw), seen = {};
      for (const n of rn) { const k = (seen[n.key] = (seen[n.key] ?? -1) + 1); const o = rwk[n.key]?.[k]; if ((o && n.v > o.v) || (!o && n.v > 0 && !WORKFLOW.test(p))) hit("retries-raised", p, n.l.ln, n.l.text); }
      // every occurrence counts, paired k-th old to k-th new, so a later limit on the same line is read too (PR70-r8)
      const mw = /--max-warnings[=\s]+(-?\d+)/g;
      const val = (m) => (+m[1] < 0 ? Infinity : +m[1]);
      const mwOld = f.removed.flatMap((l) => [...l.text.matchAll(mw)].map((m) => [l, m]));
      const mwNew = f.added.flatMap((l) => [...l.text.matchAll(mw)].map((m) => [l, m]));
      mwNew.forEach(([l, m], k) => { const o = mwOld[k]; if (val(m) === Infinity || (o && val(m) > val(o[1]))) hit("max-warnings-raised", p, l.ln, l.text); });
      if (mwNew.length < mwOld.length) hit("max-warnings-raised", p, mwOld[mwNew.length][0].ln, `--max-warnings removed: ${mwOld[mwNew.length][0].text}`);
    }

    if (p.endsWith("package.json")) {
      // any position on the line, so a one-line package.json is read too (PR70-r2)
      // pre/post hooks of these scripts run with them, so they count too; a new hook is a change (GI-1c)
      const scripts = (ls) => new Map(ls.flatMap((l) => [...l.text.matchAll(/"((?:pre|post)?(?:test|lint|typecheck|check)(?::(?:[^"\\]|\\.)+)?)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]).map((m) => [m[1], m[2]]));
      const was = scripts(f.removed), now = scripts(f.added);
      for (const [k, v] of was) if (now.get(k) !== v) hit("test-script-changed", p, 0, `script "${k}": "${v}" -> ${now.has(k) ? `"${now.get(k)}"` : "removed"}`);
      for (const [k, v] of now) if (/^(pre|post)/.test(k) && !was.has(k)) hit("test-script-changed", p, 0, `hook "${k}" added: "${v}"`);
    }
    if (TSCONFIG.test(p)) {
      // Compare the parsed base and head files, so comments (one- or multi-line), strings holding "//" or "/*",
      // and reformatting cannot hide or fake a change (review GI-1c-r2). An unreadable tsconfig fails closed.
      const bt = f.status === "A" ? "{}" : show("base", f.oldPath), ht = f.status === "D" ? "{}" : show("head", p);
      const b = bt == null ? null : parseJsonc(bt), h = ht == null ? null : parseJsonc(ht);
      const lineOf = (k) => { const i = (ht ?? "").split("\n").findIndex((l) => l.includes(`"${k}"`)); return i < 0 ? 0 : i + 1; };
      if (!b || !h || typeof b !== "object" || typeof h !== "object") hit("ts-strict-relaxed", p, 0, `${p}: tsconfig unreadable as JSONC (fails closed)`);
      else {
        const bo = b.compilerOptions ?? {}, ho = h.compilerOptions ?? {};
        for (const k of TS_STRICT) {
          if (bo[k] === true && ho[k] !== true) hit("ts-strict-relaxed", p, lineOf(k), `"${k}": true -> ${ho[k] === undefined ? "removed" : JSON.stringify(ho[k])}`);
          else if (ho[k] === false && bo[k] !== false) hit("ts-strict-relaxed", p, lineOf(k), `"${k}": false`);
        }
        // strictness is inherited through "extends": dropping or retargeting it can turn strict off
        if (b.extends !== undefined && JSON.stringify(b.extends) !== JSON.stringify(h.extends)) hit("ts-strict-relaxed", p, lineOf("extends"), `extends ${JSON.stringify(b.extends)} -> ${h.extends === undefined ? "removed" : JSON.stringify(h.extends)}`);
      }
    }
    if (LINT_CONFIG.test(p)) for (const a of f.added) if (/[@\w/-]+["']?\s*:\s*\[?\s*(["'](off|warn)["']|[01]\s*[,\]}]|[01]\s*$)/.test(a.text) || /\bignores?\b["']?\s*:/.test(a.text)) hit("lint-rule-off", p, a.ln, a.text);

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
  // The rest of each KEEP line after the id; a hit is kept when that rest starts with its exact "<file>:<line>"
  // followed by whitespace or the line end, so file names with spaces work (PR70-r11).
  const keeps = [];
  for (const m of String(verdict.text).matchAll(/^\s*FLOOR-GUARD KEEP (fg-[0-9a-f]{10}) (.+)$/gm)) keeps.push([m[1], m[2]]);
  const kept = (h) => keeps.some(([id, rest]) => {
    const loc = `${h.file}:${h.line}`;
    return id === h.id && rest.startsWith(loc) && (rest.length === loc.length || /\s/.test(rest[loc.length]));
  });
  const open = report.hits.filter((h) => !kept(h));
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
    const ns = git(cwd, ["diff", "-z", "--name-status", "--no-ext-diff", "--find-renames", mb, sha]).split("\0");
    const pairs = [];
    for (let i = 0; i < ns.length - 1;) {
      const st = ns[i];
      if (/^[RC]/.test(st)) { pairs.push([ns[i + 1], ns[i + 2]]); i += 3; } else if (st) { pairs.push([ns[i + 1], ns[i + 1]]); i += 2; } else i++;
    }
    const revs = { base: mb, head: sha };
    const show = (rev, p) => { try { return execFileSync("git", ["show", `${revs[rev]}:${p}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }); } catch { return null; } };
    const hits = analyse(parseDiff(diff, { pairs }), show);
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

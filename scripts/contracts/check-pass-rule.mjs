#!/usr/bin/env node
// Pass-rule validator (DEVOS-142, gate integrity Part 2). Contract: docs/modules/GI-2.md.
// Every module contract (docs/modules/*.md) changed in a PR must carry a "## Pass rule" section whose every
// bullet is program-checkable: it names a command, a test suite or acceptance-test id, or a measurable output.
// Exit codes: 0 valid · 1 invalid · 2 could not run (never valid). Zero dependencies.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Words that judge instead of measure; a bullet made of these (and filler) alone is rejected.
export const JUDGEMENT = ["looks good", "works", "working", "no errors", "model is confident", "as expected", "correctly", "properly",
  "fine", "ok", "okay", "good", "reasonable", "sensible", "acceptable", "clean", "nice", "should", "seems", "appears"];

// A bullet passes when it carries at least one measurable anchor.
const ANCHORS = [
  /`[^`]*\b(pnpm|npm|npx|node|bash|sh|curl|git|gh|psql|docker|playwright|vitest|jest|tsc|eslint|python3?|make)\b[^`]*`/, // a command in a code span
  /`[^`]*\.(test|spec)\.[cm]?[jt]sx?[^`]*`/,           // a named test file
  /\b(AT|AB|GC|IT|E2E)[-\w]*\d+\b/,                     // an acceptance-test or green-condition id
  /\bexit(s| code)?\s*(0|1|2|non-?zero)\b/i,            // an exit code
  /\bHTTP\s*\d{3}\b|\b[1-5]\d\d\b\s*(status|response)/i, // an HTTP status
  /(≤|≥|<=|>=|<|>|at most|at least|under|within)\s*\d[\d.,_]*\s*(ms|s|seconds?|minutes?|%|kb|mb|gb|lines?|rows?|requests?)?\b/i, // a threshold
  /\bscreenshot diff\b|\bchecklist script\b/i,          // the UI allowances of spec §5
];

const SECTION = /^#{2,4}\s+Pass rule\b.*$/im;

/** Returns { ok, errors[] } for one contract's text. */
export function validateContract(text, file = "contract") {
  const errors = [];
  const lines = text.split("\n");
  const starts = lines.flatMap((l, i) => (/^#{2,4}\s+Pass rule\b/i.test(l) ? [i] : []));
  if (!starts.length || !SECTION.test(text)) return { ok: false, errors: [`${file}: no "## Pass rule" section`] };
  for (const s of starts) {
    const level = /^#+/.exec(lines[s])[0].length;
    const body = [];
    for (let i = s + 1; i < lines.length; i++) {
      const m = /^(#+)\s/.exec(lines[i]);
      if (m && m[1].length <= level) break;
      body.push(lines[i]);
    }
    // bullets (continuation lines join the bullet above); a body with no bullets is checked as one paragraph
    const bullets = [];
    for (const l of body) {
      if (/^\s*([-*]|\d+\.)\s+/.test(l)) bullets.push(l.replace(/^\s*([-*]|\d+\.)\s+/, ""));
      else if (l.trim() && bullets.length) bullets[bullets.length - 1] += " " + l.trim();
      else if (l.trim()) bullets.push(l.trim());
    }
    if (!bullets.length) { errors.push(`${file}:${s + 1}: "${lines[s].trim()}" is empty`); continue; }
    for (const b of bullets) {
      if (ANCHORS.some((r) => r.test(b))) continue;
      const judged = JUDGEMENT.filter((w) => new RegExp(`\\b${w.replace(/ /g, "\\s+")}\\b`, "i").test(b));
      errors.push(`${file}:${s + 1}: pass rule "${b.slice(0, 100)}" references no command, test or measurable output` +
        (judged.length ? ` (judgement words only: ${judged.join(", ")})` : ""));
    }
  }
  return { ok: errors.length === 0, errors };
}

const isContract = (p) => /^docs\/modules\/[^/]+\.md$/.test(p) && !/\/_template\.md$/.test(p);

/** Contracts added or modified between merge-base(base, head) and head; deleted ones are the floor guard's job. */
export function changedContracts(cwd, base, head) {
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const mb = git(["merge-base", base, head]).trim();
  return git(["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=AMR", mb, head, "--", "docs/modules"])
    .split("\n").filter(Boolean).filter(isContract);
}

export function run({ cwd = process.cwd(), base, head, files }) {
  try {
    if (!files && (!base || !head)) throw new Error("usage: check-pass-rule.mjs --base <rev> --head <rev> | --all | <file…>");
    const list = files ?? changedContracts(cwd, base, head);
    const read = (p) => (head && !files ? execFileSync("git", ["show", `${head}:${p}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) : fs.readFileSync(path.resolve(cwd, p), "utf8"));
    const errors = [];
    for (const p of list) errors.push(...validateContract(read(p), p).errors);
    return { exit: errors.length ? 1 : 0, checked: list, errors };
  } catch (e) {
    return { exit: 2, checked: [], errors: [`could not run: ${(e.stderr || e.message || e).toString().trim().split("\n")[0]}`] };
  }
}

function main(argv) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  let files;
  if (argv.includes("--all")) files = fs.readdirSync("docs/modules").map((f) => `docs/modules/${f}`).filter(isContract);
  else if (argv.length && !argv[0].startsWith("--")) files = argv;
  const r = run({ base: arg("--base"), head: arg("--head"), files });
  for (const e of r.errors) console.log(e);
  console.log(`pass-rule: exit ${r.exit} (${r.checked.length} contract(s) checked${r.checked.length ? ": " + r.checked.join(", ") : ""})`);
  return r.exit;
}

const isMain = () => { try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] ?? ""); } catch { return false; } };
if (isMain()) process.exit(main(process.argv.slice(2)));

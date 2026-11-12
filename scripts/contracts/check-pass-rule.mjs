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
const TOOLS = "pnpm|npm|npx|node|bash|sh|curl|git|gh|psql|docker|playwright|vitest|jest|tsc|eslint|python3?|pytest|make|axe|k6";
const ANCHORS = [
  new RegExp("(?<!`)`(?!`)\\s*(" + TOOLS + ")\\s[^`\\n]*`(?!`)"), // a command in an inline code span (tool first, with arguments)
  /`[^`]*\.(test|spec)\.[cm]?[jt]sx?`/,                 // a named test file
  /\b(AT|AB|GC)\d+[a-z]?\b|\bAT-[A-Z]+\d+\b/,           // an acceptance-test or green-condition id
  /\bexit(s| code| status)?\s*(\d{1,3}|non-?zero)\b/i,    // an exit code
  /\bHTTP\s*[1-5]\d\d\b|\b(returns|responds(\s+with)?|status( code)?)\s+[1-5]\d\d\b/i, // an HTTP status
  /((?<![-=<>])(≤|≥|<=|>=|<|>)|\b(at most|at least|under|within|exactly)\b)\s*\d[\d.,_]*\s*(%|(ms|s|seconds?|minutes?|kb|mb|gb|lines?|rows?|requests?|pixels?|px|violations?|findings?|errors?|hits?)\b)/i, // a threshold with a unit
  /\bscreenshot diff\b|\bchecklist script\b/i,          // the UI allowances of spec §5
];

const HEADING = /^(#{2,4})\s+Pass rules?\b/i;

/** Lines with HTML comments blanked and a flag for lines inside fenced code blocks. */
function scan(text) {
  const clean = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  let fence = null;
  return clean.split("\n").map((l) => {
    // CommonMark: a fence is a run of 3+ backticks or tildes; only a run of the same character, at least as long,
    // with nothing after it closes it, so a ``` line inside a ```` block is content (PR71-r4)
    const f = /^\s*(`{3,}|~{3,})(.*)$/.exec(l);
    if (f && !fence) { fence = f[1]; return { l, fenced: true, edge: true, opened: true }; }
    if (f && fence && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) { fence = null; return { l, fenced: true, edge: true, opened: false }; }
    return { l, fenced: !!fence };
  });
}

/** Returns { ok, errors[] } for one contract's text. */
export function validateContract(text, file = "contract") {
  const errors = [];
  const lines = scan(text);
  const starts = lines.flatMap((x, i) => (!x.fenced && HEADING.test(x.l) ? [i] : []));
  if (!starts.length) return { ok: false, errors: [`${file}: no "## Pass rule" section`] };
  for (const s of starts) {
    const level = HEADING.exec(lines[s].l)[1].length;
    // items: a bullet starts one; an indented line continues it; a blank line ends it; any other line is its own item.
    // A fenced block belongs to the item above it (or is its own item) and is checked on its own terms: every
    // non-blank, non-comment line in it must be a command, and a fence with a command anchors its item.
    const items = [];
    const fences = new Map(); // item index -> array of fence bodies
    let open = false, inItem = false;
    for (let i = s + 1; i < lines.length; i++) {
      const { l, fenced } = lines[i];
      const m = /^(#+)\s/.exec(l);
      if (!fenced && m && m[1].length <= level) break;
      if (!fenced && m) { open = false; continue; } // a deeper sub-heading inside the section is structure, not an item
      // a fenced block is an item of its own: its text never lends an anchor to, or borrows one from, a neighbour
      if (fenced) {
        if (lines[i].edge) {
          // an indented fence inside an open bullet is part of that bullet, so an indented line after it still
          // continues the bullet; any other fence ends it (PR71-r3)
          if (lines[i].opened) { inItem = open && /^\s+\S/.test(l); if (!items.length) items.push(""); const k = items.length - 1; fences.set(k, [...(fences.get(k) ?? []), []]); }
          else open = inItem;
          continue;
        }
        fences.get(items.length - 1).at(-1).push(l); continue;
      }
      if (!l.trim()) { open = false; continue; }
      if (/^\s*([-*]|\d+\.)\s+/.test(l)) { items.push(l.replace(/^\s*([-*]|\d+\.)\s+/, "")); open = true; }
      else if (open && /^\s+\S/.test(l)) items[items.length - 1] += " " + l.trim();
      else { items.push(l.trim()); open = true; }
    }
    if (!items.length) { errors.push(`${file}:${s + 1}: "${lines[s].l.trim()}" is empty`); continue; }
    const cmd = new RegExp("^\\s*(\\$\\s*)?(" + TOOLS + ")(\\s|$)");
    for (const [k, b] of items.entries()) {
      let fenceCmd = false, fenceBad = null;
      for (const body of fences.get(k) ?? []) for (const l of body) {
        if (!l.trim() || /^\s*#/.test(l)) continue;
        if (cmd.test(l)) fenceCmd = true; else fenceBad ??= l.trim();
      }
      if (fenceBad) { errors.push(`${file}:${s + 1}: fenced block line "${fenceBad.slice(0, 80)}" is not a command`); continue; }
      if (fenceCmd || ANCHORS.some((r) => r.test(b))) continue;
      const judged = JUDGEMENT.filter((w) => new RegExp(`\\b${w.replace(/ /g, "\\s+")}\\b`, "i").test(b));
      errors.push(`${file}:${s + 1}: pass rule "${b.replace(/\s+/g, " ").slice(0, 100)}" references no command, test or measurable output` +
        (judged.length ? ` (judgement words only: ${judged.join(", ")})` : ""));
    }
  }
  return { ok: errors.length === 0, errors };
}

const isContract = (p) => /^docs\/modules\/[^/]+\.md$/.test(p) && !/\/_template\.md$/.test(p);

/** Contracts added, modified or renamed between merge-base(base, head) and head. A deleted or moved-away contract is
 *  caught by the floor guard (scripts/floor-guard, rule contract-weakened, DEVOS-141). */
export function changedContracts(cwd, base, head) {
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const mb = git(["merge-base", base, head]).trim();
  return git(["diff", "-z", "--name-only", "--diff-filter=AMR", mb, head, "--", "docs/modules"])
    .split("\0").filter(Boolean).filter(isContract);
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
  try {
    if (argv.includes("--all")) files = fs.readdirSync("docs/modules").map((f) => `docs/modules/${f}`).filter(isContract);
    else if (argv.length && !argv[0].startsWith("--")) files = argv;
  } catch (e) { console.log(`pass-rule: could not run: ${e.message}`); return 2; }
  const r = run({ base: arg("--base"), head: arg("--head"), files });
  for (const e of r.errors) console.log(e);
  console.log(`pass-rule: exit ${r.exit} (${r.checked.length} contract(s) checked${r.checked.length ? ": " + r.checked.join(", ") : ""})`);
  return r.exit;
}

const isMain = () => { try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] ?? ""); } catch { return false; } };
if (isMain()) process.exit(main(process.argv.slice(2)));

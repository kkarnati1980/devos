// SM-06-L2: every migration is backward-compatible with the previous release (expand now, contract later). This
// check reads SQL migrations and refuses statements the previous release could not run against. It also warns
// (SM-06-L1 review aid) when a foreign-key column has no index that leads with it.
//
//   node src/migrations-check.mjs [--dir migrations] [--strict] [file.sql ...]
//     --dir     folder of *.sql files (default: migrations); every file in it is read unless files are named
//     file.sql  only these files, e.g. the ones a PR adds: git diff --name-only --diff-filter=AMR origin/main --
//               'migrations/*.sql' | xargs -r node src/migrations-check.mjs (-r: no files, no run; no git call
//               here: F2 keeps child processes out of src/)
//     --strict  index warnings fail too
//   exit 0 pass · 1 a refused statement (or a warning with --strict) · 2 usage or read error
//
// A planned contract step (the "later" in expand/contract, once no release uses the old shape) is allowed by a
// comment line right above the statement: `-- sm06: contract <reason of 10+ characters>`. It is reported, never
// silent. Limits (recorded in S3.md): statements are split on `;` outside quotes and comments; dollar-quoted
// function bodies are skipped whole; the rules read the statement text (string literals blanked), not a parsed
// schema.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ID = String.raw`(?:"[^"]*"|\w+)`;
const QID = String.raw`${ID}(?:\.${ID})?`;
const OBJECTS = String.raw`(TABLE|VIEW|MATERIALIZED\s+VIEW|SCHEMA|TYPE|DOMAIN|SEQUENCE|FUNCTION|PROCEDURE)`;
// Matched against the statement in upper case with the contents of string literals blanked ('…' → ''), so text
// inside a literal never trips or clears a rule.
export const RULES = [
  ["drop-object", new RegExp(String.raw`^DROP\s+${OBJECTS}\b`)],
  ["drop-column", new RegExp(String.raw`^ALTER\s+TABLE\b.*\bDROP\s+(COLUMN\s+)?(?!CONSTRAINT\b|DEFAULT\b|NOT\s+NULL\b|IDENTITY\b|EXPRESSION\b)${ID}`)],
  ["rename", new RegExp(String.raw`^ALTER\s+(${OBJECTS.slice(1, -1)}|INDEX)\b.*\bRENAME\b`)],
  ["column-type-change", new RegExp(String.raw`^ALTER\s+TABLE\b.*\bALTER\s+(COLUMN\s+)?${ID}\s+(SET\s+DATA\s+)?TYPE\b`)],
  ["set-not-null", /^ALTER\s+TABLE\b.*\bSET\s+NOT\s+NULL\b/],
  ["drop-default", /^ALTER\s+TABLE\b.*\bDROP\s+DEFAULT\b/],
  ["truncate", /^TRUNCATE\b/],
];
const CONTRACT = /^--\s*sm06:\s*contract\s+(\S.{9,})$/i;

/** End index (exclusive) of the quoted run starting at i. An E'…' string honours backslash escapes. */
function quoteEnd(sql, i) {
  const q = sql[i];
  const escapes = q === "'" && /[eE]/.test(sql[i - 1] ?? "") && !/\w/.test(sql[i - 2] ?? "");
  let j = i + 1;
  while (j < sql.length) {
    if (escapes && sql[j] === "\\") { j += 2; continue; }
    if (sql[j] === q) { if (sql[j + 1] === q) { j += 2; continue; } return j + 1; }
    j++;
  }
  return sql.length;
}

/** The statement with string-literal contents blanked; quoted identifiers are kept. */
export function blankLiterals(text) {
  let out = "", i = 0;
  while (i < text.length) {
    if (text[i] === "'" || text[i] === '"') { const end = quoteEnd(text, i); out += text[i] === "'" ? "''" : text.slice(i, end); i = end; continue; }
    out += text[i++];
  }
  return out;
}

/** Text outside parentheses only (subqueries, CTE bodies and column lists removed). */
const topLevel = (text) => { let d = 0, out = ""; for (const c of text) { if (c === "(") d++; else if (c === ")") d = Math.max(0, d - 1); else if (d === 0) out += c; } return out; };

function splitTop(s) {
  const parts = [];
  let depth = 0, cur = "";
  for (const c of s) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += c;
  }
  parts.push(cur);
  return parts;
}

/** Refusal rule ids for one statement (upper case, literals blanked). */
export function ruleHits(upper) {
  const hits = RULES.filter(([, re]) => re.test(upper)).map(([rule]) => rule);
  const top = topLevel(upper);
  if (/^(WITH\b.*\s)?DELETE\s+FROM\b/.test(top) && !/\bWHERE\b/.test(top)) hits.push("delete-without-where");
  if (/^(WITH\b.*\s)?UPDATE\s+/.test(top) && /\bSET\b/.test(top) && !/\bWHERE\b/.test(top)) hits.push("update-without-where");
  if (/^ALTER\s+TABLE\b/.test(upper)) {
    for (const clause of splitTop(upper)) {
      if (!/\bADD\s+(COLUMN\s+)?(?!CONSTRAINT\b|PRIMARY\b|UNIQUE\b|FOREIGN\b|CHECK\b|EXCLUDE\b)/.test(clause)) continue;
      if (/\bNOT\s+NULL\b/.test(clause) && !/\bDEFAULT\b|\bGENERATED\b|\b(SMALL|BIG)?SERIAL\d?\b/.test(clause)) { hits.push("add-not-null-without-default"); break; }
    }
  }
  return hits;
}

// End index (exclusive) of the block comment starting at i. Postgres block comments nest: /* a /* b */ c */.
function blockCommentEnd(sql, i) {
  let depth = 0, j = i;
  while (j < sql.length) {
    if (sql.startsWith("/*", j)) { depth++; j += 2; continue; }
    if (sql.startsWith("*/", j)) { depth--; j += 2; if (depth === 0) return j; continue; }
    j++;
  }
  return sql.length;
}

/** Splits SQL into statements, each with the contract reason from a comment line just above it (or null). */
export function statements(sql) {
  const out = [];
  let cur = "", reason = null, i = 0;
  const flush = () => {
    const text = cur.replace(/\s+/g, " ").trim();
    if (text) out.push({ text, reason });
    cur = ""; reason = null;
  };
  while (i < sql.length) {
    const c = sql[i], rest = sql.slice(i);
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      const line = sql.slice(i, end < 0 ? sql.length : end).trim();
      const m = CONTRACT.exec(line);
      if (m && !cur.trim()) reason = m[1].trim();
      // The newline ends the comment but stays a separator: `DROP-- x\nTABLE t` is DROP TABLE, not DROPTABLE.
      cur += " ";
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (rest.startsWith("/*")) { i = blockCommentEnd(sql, i); cur += " "; continue; }
    const dollar = /^\$(\w*)\$/.exec(rest);
    if (dollar) { const end = sql.indexOf(dollar[0], i + dollar[0].length); cur += " $body$ "; i = end < 0 ? sql.length : end + dollar[0].length; continue; }
    if (c === "'" || c === '"') { const end = quoteEnd(sql, i); cur += sql.slice(i, end); i = end; continue; }
    if (c === ";") { flush(); i++; continue; }
    cur += c; i++;
  }
  flush();
  return out;
}

/** Checks one file's SQL. Returns { refused: [{rule, statement}], allowed: [{rule, statement, reason}], warnings: [] }. */
export function checkSql(sql) {
  const refused = [], allowed = [], fks = [], indexed = new Set();
  for (const { text, reason } of statements(sql)) {
    const upper = blankLiterals(text).toUpperCase();
    for (const rule of ruleHits(upper)) (reason ? allowed : refused).push(reason ? { rule, statement: text, reason } : { rule, statement: text });
    collectKeys(blankLiterals(text), fks, indexed);
  }
  const warnings = fks.filter((k) => !indexed.has(`${k.table}.${k.column}`)).map((k) => `${k.table}.${k.column} references ${k.ref} but no index leads with it`);
  return { refused, allowed, warnings };
}

const ident = (s) => s.replace(/"/g, "").toLowerCase().split(".").pop();

// A table name: optionally schema-qualified, each part bare or double-quoted ("public"."orders").
const T = `(${QID})`;

function collectKeys(text, fks, indexed) {
  const ct = new RegExp(String.raw`^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?${T}\s*\((.*)\)`, "i").exec(text);
  if (ct) {
    const table = ident(ct[2]);
    for (const part of splitTop(ct[3])) {
      const p = part.trim();
      const col = new RegExp(String.raw`^("?\w+"?)\s+[\w ()[\],]*?\bREFERENCES\s+${T}`, "i").exec(p);
      if (col && !/^(CONSTRAINT|FOREIGN|PRIMARY|UNIQUE|CHECK)\b/i.test(p)) fks.push({ table, column: ident(col[1]), ref: ident(col[2]) });
      const fk = new RegExp(String.raw`FOREIGN\s+KEY\s*\(\s*("?\w+"?)[^)]*\)\s*REFERENCES\s+${T}`, "i").exec(p);
      if (fk) fks.push({ table, column: ident(fk[1]), ref: ident(fk[2]) });
      const key = /^(CONSTRAINT\s+\S+\s+)?(PRIMARY\s+KEY|UNIQUE)\s*\(\s*("?\w+"?)/i.exec(p);
      if (key) indexed.add(`${table}.${ident(key[3])}`);
      const inline = /^("?\w+"?)\s.*\b(PRIMARY\s+KEY|UNIQUE)\b/i.exec(p);
      if (inline && !/^(CONSTRAINT|FOREIGN|PRIMARY|UNIQUE|CHECK)\b/i.test(p)) indexed.add(`${table}.${ident(inline[1])}`);
    }
  }
  const at = new RegExp(String.raw`^ALTER\s+TABLE\s+(ONLY\s+)?${T}\s+ADD\s+(CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY\s*\(\s*("?\w+"?)[^)]*\)\s*REFERENCES\s+${T}`, "i").exec(text);
  if (at) fks.push({ table: ident(at[2]), column: ident(at[4]), ref: ident(at[5]) });
  const alt = new RegExp(String.raw`^ALTER\s+TABLE\s+(ONLY\s+)?(IF\s+EXISTS\s+)?${T}\s+(.*)$`, "i").exec(text);
  if (alt) {
    for (const clause of splitTop(alt[4])) {
      const m = new RegExp(String.raw`^\s*ADD\s+(COLUMN\s+)?(IF\s+NOT\s+EXISTS\s+)?(?!CONSTRAINT\b|FOREIGN\b)("?\w+"?)\s.*\bREFERENCES\s+${T}`, "i").exec(clause);
      if (m) fks.push({ table: ident(alt[3]), column: ident(m[3]), ref: ident(m[4]) });
    }
  }
  const ix = new RegExp(String.raw`^CREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?(${ID}\s+)?ON\s+(ONLY\s+)?${T}\s*(USING\s+\w+\s*)?\(\s*("?\w+"?)`, "i").exec(text);
  if (ix) indexed.add(`${ident(ix[6])}.${ident(ix[8])}`);
}


/** Every *.sql file under dir (sorted), or [] when the folder does not exist. */
export function migrationFiles(dir, cwd = process.cwd()) {
  if (!existsSync(join(cwd, dir))) return [];
  return readdirSync(join(cwd, dir), { recursive: true }).map(String).filter((f) => f.endsWith(".sql")).sort().map((f) => join(dir, f));
}

export function main(argv = process.argv.slice(2), { cwd = process.cwd(), log = console.log } = {}) {
  let dir = "migrations", strict = false;
  const named = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir" && argv[i + 1]) dir = argv[++i];
    else if (argv[i] === "--strict") strict = true;
    else if (!argv[i].startsWith("-") && argv[i].endsWith(".sql")) named.push(argv[i]);
    else { log(`migrations-check: unknown argument ${argv[i]}`); return 2; }
  }
  const files = named.length ? named : migrationFiles(dir, cwd);
  let refused = 0, warned = 0;
  for (const f of files) {
    let sql;
    try { sql = readFileSync(resolve(cwd, f), "utf8"); } catch { log(`migrations-check: cannot read ${f}`); return 2; }
    const r = checkSql(sql);
    for (const x of r.refused) log(`REFUSED ${relative(cwd, resolve(cwd, f))} ${x.rule}: ${x.statement.slice(0, 160)}`);
    for (const x of r.allowed) log(`CONTRACT ${relative(cwd, resolve(cwd, f))} ${x.rule} (${x.reason}): ${x.statement.slice(0, 160)}`);
    for (const w of r.warnings) log(`WARN ${relative(cwd, resolve(cwd, f))} ${w}`);
    refused += r.refused.length; warned += r.warnings.length;
  }
  log(`migrations-check: ${files.length} file(s), ${refused} refused, ${warned} warning(s)`);
  return refused > 0 || (strict && warned > 0) ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();

#!/usr/bin/env node
// DevOS — build standard generator and checker (S1, ADR-0010)
// Version: 1.0.0
// Source of truth: docs/standards/build-standard.yaml. Writes docs/standards/index.md and
// docs/standards/modules/<id>.md. `--check` writes nothing and exits 1 on any schema error, rule error or
// drift between the YAML and the generated files (CI runs it through `pnpm check:standard`).
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import Ajv from "ajv";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STD = join(ROOT, "docs/standards");
export const INDEX_TOKEN_BUDGET = 2000;

/** The catalogue IDs Phase PS v1.1.0 §3 defines; no more, no fewer. */
export const EXPECTED_IDS = [
  "F1", "F2", "F3",
  ...Array.from({ length: 18 }, (_, i) => `SM-${String(i + 1).padStart(2, "0")}`),
  "SM-C1", "SM-C2", "SM-C3",
];

/** Conservative token estimate for English Markdown: 1 token per 3.5 characters (real BPE counts are lower). */
export const estimateTokens = (text) => Math.ceil(text.length / 3.5);

export function load(yamlText = readFileSync(join(STD, "build-standard.yaml"), "utf8")) {
  return YAML.parse(yamlText);
}

/** Returns a list of error strings; empty when the catalogue is valid. */
export function validate(doc, schema = JSON.parse(readFileSync(join(STD, "build-standard.schema.json"), "utf8"))) {
  const errors = [];
  const ajv = new Ajv({ allErrors: true, strict: false });
  if (!ajv.validate(schema, doc)) {
    for (const e of ajv.errors) errors.push(`schema: ${e.instancePath || "/"} ${e.message}`);
    return errors;
  }
  const ids = doc.modules.map((m) => m.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) errors.push(`duplicate module ids: ${[...new Set(dup)].join(", ")}`);
  const missing = EXPECTED_IDS.filter((id) => !ids.includes(id));
  const extra = ids.filter((id) => !EXPECTED_IDS.includes(id));
  if (missing.length) errors.push(`missing modules: ${missing.join(", ")}`);
  if (extra.length) errors.push(`unknown modules: ${extra.join(", ")}`);
  const checkIds = [];
  for (const m of doc.modules) {
    const kindOk = m.id.startsWith("SM-C") ? "opt_in" : m.id.startsWith("F") ? "floor" : "selectable";
    if (m.kind !== kindOk) errors.push(`${m.id}: kind must be ${kindOk}`);
    if (m.kind === "floor" && !(m.blocks.includes("preview") && m.blocks.includes("live"))) {
      errors.push(`${m.id}: floor modules block preview and live`);
    }
    const groups = m.kind === "selectable" ? [["L", m.lite.checks], ["F", m.full.checks]] : [["", m.checks]];
    for (const [lvl, checks] of groups) {
      for (const c of checks) {
        checkIds.push(c.id);
        if (!c.id.startsWith(`${m.id}-${lvl}`) || !/^\d+$/.test(c.id.slice(m.id.length + 1 + lvl.length))) {
          errors.push(`${m.id}: check id ${c.id} must be ${m.id}-${lvl}<n>`);
        }
      }
    }
    if (m.kind === "selectable" && m.signals.length === 0) errors.push(`${m.id}: selectable modules need at least one signal`);
    for (const s of m.signals) {
      for (const re of [...(s.paths ?? []), ...(s.code ?? [])]) {
        try { new RegExp(re); } catch (e) { errors.push(`${m.id}: bad signal regex ${JSON.stringify(re)}: ${e.message}`); }
      }
    }
  }
  const dupChecks = checkIds.filter((id, i) => checkIds.indexOf(id) !== i);
  if (dupChecks.length) errors.push(`duplicate check ids: ${[...new Set(dupChecks)].join(", ")}`);
  return errors;
}

const KIND = { floor: "Floor (always on)", selectable: "Selectable", opt_in: "Opt-in (KK card only)" };
const HOW = { auto: "auto", review: "review", both: "auto + review" };
const cell = (s) => s.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
const firstClause = (s) => cell(s).replace(/^Lite, plus:? /, "+ ").replace(/\.$/, "");

export function renderIndex(doc) {
  const rows = (kind) => doc.modules.filter((m) => m.kind === kind);
  const out = [
    "# DevOS build standard — index",
    "",
    "<!-- Generated from build-standard.yaml by `pnpm gen:standard`. Do not edit by hand. -->",
    "",
    `Catalogue v${doc.version} (${doc.adr}). This index is the only standard text the selector reads in full;`,
    "a module's full text (`modules/<id>.md`) is loaded only once that module is selected for a project.",
    "",
    "## Floor — always on, every app (blocks preview and live)",
    "| ID | Module | Enforces |",
    "|---|---|---|",
    ...rows("floor").map((m) => `| ${m.id} | ${m.name} | ${cell(m.purpose)} |`),
    "",
    "## Selectable — chosen per app (Lite or Full)",
    "| ID | Module | Select when | Lite | Full adds |",
    "|---|---|---|---|---|",
    ...rows("selectable").map((m) =>
      `| ${m.id} | ${m.name} | ${cell(m.applies_when)} | ${firstClause(m.lite.summary)} | ${firstClause(m.full.summary)} |`),
    "",
    "## Opt-in — only when KK asks on a card",
    "| ID | Module |",
    "|---|---|",
    ...rows("opt_in").map((m) => `| ${m.id} | ${m.name} |`),
    "",
  ];
  return out.join("\n");
}

export function renderModule(m, doc) {
  const checks = (list) => [
    "| Check | How | Evidence |",
    "|---|---|---|",
    ...list.map((c) => `| **${c.id}** ${cell(c.check)} | ${HOW[c.how]} | \`${c.evidence}\` |`),
  ];
  const out = [
    `# ${m.id} — ${m.name}`,
    "",
    "<!-- Generated from build-standard.yaml by `pnpm gen:standard`. Do not edit by hand. -->",
    "",
    `- **Kind:** ${KIND[m.kind]}`,
    `- **Applies when:** ${cell(m.applies_when)}`,
  ];
  if (m.purpose) out.push(`- **Purpose:** ${cell(m.purpose)}`);
  if (m.blocks) out.push(`- **Blocks:** ${m.blocks.join(" and ")} deploys when any check fails`);
  out.push(`- **Catalogue:** v${doc.version} (${doc.adr})`, "");
  if (m.kind === "selectable") {
    out.push("## Lite", cell(m.lite.summary), "", ...checks(m.lite.checks), "");
    out.push("## Full", cell(m.full.summary), "", ...checks(m.full.checks), "");
  } else {
    out.push("## Checks", "", ...checks(m.checks), "");
  }
  out.push("## Code signals (mid-build detector, S5)");
  if (m.signals.length === 0) out.push("None: this module is never auto-added from code.");
  for (const s of m.signals) {
    out.push(`- ${s.description}`);
    for (const re of s.paths ?? []) out.push(`  - path: \`${re}\``);
    for (const re of s.code ?? []) out.push(`  - code: \`${re.replace(/`/g, "\\`")}\``);
  }
  out.push("");
  return out.join("\n");
}

export function render(doc) {
  const files = new Map([["index.md", renderIndex(doc)]]);
  for (const m of doc.modules) files.set(`modules/${m.id}.md`, renderModule(m, doc));
  return files;
}

function main() {
  const check = process.argv.includes("--check");
  const doc = load();
  const errors = validate(doc);
  if (errors.length) {
    for (const e of errors) console.error(`build-standard: ${e}`);
    process.exit(1);
  }
  const files = render(doc);
  const tokens = estimateTokens(files.get("index.md"));
  if (tokens > INDEX_TOKEN_BUDGET) {
    console.error(`build-standard: index.md is about ${tokens} tokens; budget is ${INDEX_TOKEN_BUDGET}`);
    process.exit(1);
  }
  const drift = [];
  for (const [rel, text] of files) {
    const p = join(STD, rel);
    const cur = existsSync(p) ? readFileSync(p, "utf8") : null;
    if (cur === text) continue;
    if (check) drift.push(rel);
    else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
  }
  const stray = readdirSync(join(STD, "modules")).filter((f) => !files.has(`modules/${f}`));
  if (stray.length) drift.push(...stray.map((f) => `modules/${f} (not in the catalogue)`));
  if (drift.length) {
    for (const d of drift) console.error(`build-standard: out of date: docs/standards/${d}`);
    console.error("build-standard: run `pnpm gen:standard` and commit the result");
    process.exit(1);
  }
  console.log(`build-standard: ${doc.modules.length} modules valid; index about ${tokens}/${INDEX_TOKEN_BUDGET} tokens${check ? "; generated files current" : "; files written"}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

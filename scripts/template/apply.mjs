#!/usr/bin/env node
// Generate an app repo from the golden-path template (S3, docs/modules/S3.md): the core always, plus one
// add-on per selected module. Never overwrites: the output directory must be absent or empty.
// Usage: apply.mjs --out <dir> [--select SM-01,SM-09] [--sha <devos-sha>]
// Exit 0 written; 2 refused (bad arguments, unknown or non-selectable module, non-empty output) with nothing written.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TEMPLATE = path.join(ROOT, "templates/golden-path");
export const TEMPLATE_VERSION = "0.1.0";

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else { if (fs.existsSync(d)) throw new Error(`add-on would overwrite ${path.relative(dst, d)}`); fs.copyFileSync(s, d); }
  }
}

export function selectableIds() {
  const cat = parse(fs.readFileSync(path.join(ROOT, "docs/standards/build-standard.yaml"), "utf8"));
  return new Set(cat.modules.filter((m) => m.kind === "selectable").map((m) => m.id));
}

function devosSha() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return "unknown"; }
}

export function apply({ out, select = [], sha = devosSha() }) {
  if (!out) return { code: 2, error: "--out is required" };
  out = path.resolve(out);   // so "dir/" stages beside dir, never inside it
  const ids = [...new Set(select.map((s) => s.trim()).filter(Boolean))];
  const ok = selectableIds();
  const bad = ids.filter((i) => !ok.has(i));
  if (bad.length) return { code: 2, error: `not a selectable module: ${bad.join(", ")}` };
  if (fs.existsSync(out) && fs.readdirSync(out).length) return { code: 2, error: `output directory is not empty: ${out}` };
  const applied = [], pending = [];
  for (const id of ids) (fs.existsSync(path.join(TEMPLATE, "addons", id, "addon.json")) ? applied : pending).push(id);
  const stage = `${out}.partial-${process.pid}`;
  try {
    copyDir(path.join(TEMPLATE, "core"), stage);
    for (const id of applied) copyDir(path.join(TEMPLATE, "addons", id, "files"), stage);
    fs.mkdirSync(path.join(stage, ".devos"), { recursive: true });
    fs.writeFileSync(path.join(stage, ".devos/template.json"), JSON.stringify({ template: "golden-path", version: TEMPLATE_VERSION, devosSha: sha, selected: ids, applied, pending }, null, 2) + "\n");
    if (fs.existsSync(out)) fs.rmdirSync(out);
    fs.renameSync(stage, out);
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    return { code: 2, error: String(e.message) };
  }
  return { code: 0, applied, pending };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const a = process.argv.slice(2); const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const r = apply({ out: arg("--out"), select: (arg("--select") || "").split(","), sha: arg("--sha") || undefined });
  if (r.code) { console.error(`apply: refused: ${r.error}`); process.exit(r.code); }
  console.log(`apply: core + ${r.applied.length} add-on(s)${r.pending.length ? `; pending (no add-on yet): ${r.pending.join(", ")}` : ""}`);
}

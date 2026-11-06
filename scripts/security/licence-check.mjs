#!/usr/bin/env node
// S2 licence report and gate (docs/modules/S2.md, D13).
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const POLICY_PATH = fileURLToPath(new URL("../../docs/security/licence-policy.json", import.meta.url));
export const loadPolicy = (path = POLICY_PATH) => JSON.parse(readFileSync(path, "utf8"));

// Classify one SPDX licence id: permissive | weak | strong | unknown.
export function classifyId(id, policy) {
  const clean = String(id ?? "").trim().replace(/^\(+|\)+$/g, "").replace(/\+$/, "");
  if (!clean) return "unknown";
  if (policy.permissive.includes(clean)) return "permissive";
  const upper = clean.toUpperCase();
  if (policy.strongCopyleft.some((p) => upper.startsWith(p.toUpperCase()))) return "strong";
  if (policy.weakCopyleft.some((p) => upper.startsWith(p.toUpperCase()))) return "weak";
  return "unknown";
}

const RANK = { permissive: 0, weak: 1, unknown: 2, strong: 3 };

// Classify an SPDX expression. OR takes the best side, AND the worst. Parentheses are flattened per level.
export function classifyExpression(expr, policy) {
  const text = String(expr ?? "").trim();
  if (!text) return "unknown";
  let balance = 0;
  for (const ch of text) {
    if (ch === "(") balance++;
    if (ch === ")" && --balance < 0) return "unknown";
  }
  if (balance !== 0) return "unknown"; // malformed expression fails closed
  const split = (s, op) => {
    const parts = [];
    let depth = 0;
    let cur = "";
    const tokens = s.split(/(\s+|\(|\))/).filter((t) => t !== "");
    for (const t of tokens) {
      if (t === "(") depth++;
      if (t === ")") depth--;
      if (depth === 0 && t.toUpperCase() === op) {
        parts.push(cur.trim());
        cur = "";
      } else cur += t;
    }
    parts.push(cur.trim());
    return parts.filter(Boolean);
  };
  const ors = split(text, "OR");
  if (ors.length > 1) return ors.map((p) => classifyExpression(p, policy)).sort((a, b) => RANK[a] - RANK[b])[0];
  const ands = split(text, "AND");
  if (ands.length > 1) return ands.map((p) => classifyExpression(p, policy)).sort((a, b) => RANK[b] - RANK[a])[0];
  if (text.startsWith("(") && text.endsWith(")")) return classifyExpression(text.slice(1, -1), policy);
  if (/[\s()]/.test(text)) return "unknown";
  return classifyId(text, policy);
}

const isReviewed = (name, version, policy) =>
  (policy.reviewed ?? []).some((r) => r.name === name && (r.versions ?? []).includes(version));

// listing: output of `pnpm licenses list --json` ({ licence: [{ name, versions, license }] }).
export function evaluate(listing, policy) {
  const failures = [];
  const reviewedUsed = [];
  const report = {};
  for (const [group, pkgs] of Object.entries(listing ?? {})) {
    for (const p of pkgs ?? []) {
      const licence = p.license ?? group;
      const cls = classifyExpression(licence, policy);
      (report[licence] ??= []).push(`${p.name}@${(p.versions ?? []).join(",")}`);
      for (const version of p.versions ?? [""]) {
        if (cls === "permissive") continue;
        if (cls === "weak" && isReviewed(p.name, version, policy)) {
          reviewedUsed.push(`${p.name}@${version} (${licence})`);
          continue;
        }
        const why =
          cls === "strong"
            ? "strong copyleft: decision card to KK (D13)"
            : cls === "weak"
              ? "weak copyleft not reviewed: add an assessment to docs/security/licence-policy.json"
              : "unknown or missing licence";
        failures.push({ package: `${p.name}@${version}`, licence: String(licence), class: cls, why });
      }
    }
  }
  return { ok: failures.length === 0, failures, reviewedUsed, report };
}

export function formatReport(r) {
  const lines = ["## Licence report (S2)", "", "| Licence | Packages |", "|---|---|"];
  for (const [licence, pkgs] of Object.entries(r.report).sort()) lines.push(`| ${licence} | ${pkgs.length}: ${pkgs.join(" ")} |`);
  lines.push("", `Reviewed weak copyleft in use: ${r.reviewedUsed.length ? r.reviewedUsed.join("; ") : "none"}`);
  if (r.failures.length) {
    lines.push("", "### Failures");
    for (const f of r.failures) lines.push(`- ${f.package} — ${f.licence} — ${f.why}`);
  }
  lines.push("", r.ok ? "licence-check: PASS" : `licence-check: FAIL (${r.failures.length})`);
  return lines.join("\n");
}

function main() {
  const run = spawnSync("pnpm", ["licenses", "list", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
  });
  if (run.error || run.status !== 0) {
    console.error(`licence-check: pnpm licenses failed (status ${run.status})`);
    console.error((run.stderr ?? "").slice(-2000));
    return 2;
  }
  let listing;
  try {
    listing = JSON.parse(run.stdout);
  } catch {
    console.error("licence-check: pnpm output is not JSON");
    return 2;
  }
  if (!Object.keys(listing).length) {
    console.error("licence-check: empty licence listing (were dependencies installed?)");
    return 2;
  }
  const r = evaluate(listing, loadPolicy());
  const text = formatReport(r);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());

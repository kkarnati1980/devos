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

// Parse an SPDX-style expression into a tree, or null when it is malformed (PR19-r2: syntax is checked
// on the whole expression before any OR/AND semantics, so a malformed operand anywhere fails closed).
// Grammar: or := and (OR and)* ; and := atom (AND atom)* ; atom := ID | "(" or ")". "and"/"or" match any case.
export function parseExpression(expr) {
  const tokens = String(expr ?? "").match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (t, op) => typeof t === "string" && t.toUpperCase() === op;
  const atom = () => {
    const t = tokens[i++];
    if (t === undefined || t === ")" || isOp(t, "AND") || isOp(t, "OR") || isOp(t, "WITH")) return null;
    if (t === "(") {
      const inner = or();
      if (inner === null || tokens[i++] !== ")") return null;
      return inner;
    }
    return { id: t };
  };
  const chain = (next, op) => () => {
    const first = next();
    if (first === null) return null;
    const parts = [first];
    while (isOp(peek(), op)) {
      i++;
      const n = next();
      if (n === null) return null;
      parts.push(n);
    }
    return parts.length === 1 ? first : { op, parts };
  };
  const and = chain(atom, "AND");
  const or = chain(and, "OR");
  if (!tokens.length) return null;
  const tree = or();
  return tree !== null && i === tokens.length ? tree : null;
}

// Classify an SPDX expression. A malformed expression is unknown; OR takes the best side, AND the worst.
export function classifyExpression(expr, policy) {
  const tree = parseExpression(expr);
  if (tree === null) return "unknown";
  const walk = (n) => {
    if (n.id !== undefined) return classifyId(n.id, policy);
    const classes = n.parts.map(walk).sort((a, b) => (n.op === "OR" ? RANK[a] - RANK[b] : RANK[b] - RANK[a]));
    return classes[0];
  };
  return walk(tree);
}

// A review covers one package, version and licence: a different reported licence needs its own assessment (PR19-r1).
const isReviewed = (name, version, licence, policy) =>
  (policy.reviewed ?? []).some(
    (r) => r.name === name && (r.versions ?? []).includes(version) && String(r.licence).trim() === String(licence).trim(),
  );

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
        if (cls === "weak" && isReviewed(p.name, version, licence, policy)) {
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

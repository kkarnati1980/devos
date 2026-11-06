#!/usr/bin/env node
// S2 dependency vulnerability gate (docs/modules/S2.md). High/critical fails; unknown severity fails closed.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BLOCK_CVSS = 7.0;
const DB_LEVEL = { CRITICAL: 9.0, HIGH: 7.0, MODERATE: 5.0, MEDIUM: 5.0, LOW: 2.0 };

// Severity of one osv-scanner group: CVSS max_severity first, then the advisories' database severity.
export function groupSeverity(group, vulns) {
  const cvss = Number.parseFloat(group.max_severity ?? "");
  if (Number.isFinite(cvss)) return cvss;
  let best = null;
  for (const v of vulns) {
    if (!(group.ids ?? []).includes(v.id)) continue;
    const level = DB_LEVEL[String(v.database_specific?.severity ?? "").toUpperCase()];
    if (level !== undefined && (best === null || level > best)) best = level;
  }
  return best; // null = unknown
}

// Pure evaluation of an osv-scanner JSON report.
export function evaluate(report) {
  const blocking = [];
  const unknown = [];
  const passing = [];
  for (const result of report?.results ?? []) {
    for (const pkg of result.packages ?? []) {
      const vulns = pkg.vulnerabilities ?? [];
      for (const group of pkg.groups ?? []) {
        const severity = groupSeverity(group, vulns);
        const item = {
          package: `${pkg.package?.name}@${pkg.package?.version}`,
          ids: [...(group.ids ?? []), ...(group.aliases ?? [])].filter((v, i, a) => a.indexOf(v) === i),
          severity,
        };
        if (severity === null) unknown.push(item);
        else if (severity >= BLOCK_CVSS) blocking.push(item);
        else passing.push(item);
      }
    }
  }
  return { ok: blocking.length === 0 && unknown.length === 0, blocking, unknown, passing };
}

export function formatResult(r) {
  const line = (tag, i) => `  ${tag} ${i.package} ${i.ids.join(", ")} severity=${i.severity ?? "unknown"}`;
  const out = [];
  for (const i of r.blocking) out.push(line("BLOCK", i));
  for (const i of r.unknown) out.push(line("BLOCK(unknown severity)", i));
  for (const i of r.passing) out.push(line("pass(below high)", i));
  out.push(r.ok ? "vuln-scan: PASS (no high/critical findings)" : `vuln-scan: FAIL (${r.blocking.length} high/critical, ${r.unknown.length} unknown severity)`);
  return out.join("\n");
}

function main(argv) {
  const lockfile = argv[0];
  if (!lockfile) {
    console.error("usage: vuln-scan.mjs <lockfile>");
    return 2;
  }
  const bin = process.env.OSV_SCANNER ?? "osv-scanner";
  const run = spawnSync(bin, ["--format", "json", "--lockfile", lockfile], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
  });
  // osv-scanner: 0 = no findings, 1 = findings; anything else is a tool failure.
  if (run.error || (run.status !== 0 && run.status !== 1)) {
    console.error(`vuln-scan: osv-scanner failed (status ${run.status}, ${run.error?.message ?? "no error"})`);
    console.error((run.stderr ?? "").slice(-2000));
    return 2;
  }
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    console.error("vuln-scan: osv-scanner output is not JSON");
    return 2;
  }
  if (run.status === 1 && !(report.results ?? []).length) {
    console.error("vuln-scan: osv-scanner reported findings but the report is empty");
    return 2;
  }
  const r = evaluate(report);
  console.log(formatResult(r));
  return r.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));

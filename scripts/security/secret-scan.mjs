#!/usr/bin/env node
// S2 secret-scan gate (docs/modules/S2.md): gitleaks over the full git history. Never prints a secret.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Only these fields are ever printed; Secret, Match and Line are dropped even if unredacted.
export function formatFindings(findings) {
  return findings.map((f) => {
    const commit = String(f.Commit ?? "").slice(0, 12) || "worktree";
    return `  LEAK rule=${f.RuleID} file=${f.File}:${f.StartLine} commit=${commit}`;
  });
}

export function evaluate(findings) {
  const list = Array.isArray(findings) ? findings : [];
  return { ok: list.length === 0, count: list.length, rules: [...new Set(list.map((f) => f.RuleID))].sort() };
}

function main(argv) {
  const repo = argv[0] ?? ".";
  const bin = process.env.GITLEAKS ?? "gitleaks";
  const dir = mkdtempSync(join(tmpdir(), "s2-gitleaks-"));
  const reportPath = join(dir, "report.json");
  try {
    const run = spawnSync(
      bin,
      ["git", "--no-banner", "--redact", "--exit-code", "1", "--report-format", "json", "--report-path", reportPath, repo],
      { encoding: "utf8", timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 },
    );
    // gitleaks: 0 = clean, 1 = leaks found; anything else is a tool failure.
    if (run.error || (run.status !== 0 && run.status !== 1)) {
      console.error(`secret-scan: gitleaks failed (status ${run.status}, ${run.error?.message ?? "no error"})`);
      return 2;
    }
    let findings;
    try {
      findings = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      console.error("secret-scan: gitleaks report missing or not JSON");
      return 2;
    }
    const r = evaluate(findings);
    if (run.status === 1 && r.ok) {
      console.error("secret-scan: gitleaks exited 1 with an empty report");
      return 2;
    }
    for (const line of formatFindings(findings)) console.log(line);
    console.log(r.ok ? "secret-scan: PASS (no secrets in history)" : `secret-scan: FAIL (${r.count} finding(s): ${r.rules.join(", ")})`);
    return r.ok ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));

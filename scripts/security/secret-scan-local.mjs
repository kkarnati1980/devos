#!/usr/bin/env node
// DEVOS-197 (docs/modules/S2.md, "DEVOS-197 build notes"): the CI secret scan, run locally over the commits about
// to be pushed (<base>..HEAD, base origin/main by default), before every push. Same gitleaks version, the same
// default rules and the same .gitleaksignore as the CI `secret-scan` job. Never prints a secret.
//   pnpm secret-scan:local [--base <ref>]
// Exit 0 = clean, 1 = finding(s), 2 = tool or setup failure (gitleaks missing, base not found).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, formatFindings } from "./secret-scan.mjs";
import { cachedGitleaksPath, pinnedGitleaks } from "./install-gitleaks.mjs";

const REF = /^[A-Za-z0-9._\/@{}~^-]{1,200}$/;

export function parseArgs(argv) {
  let base = "origin/main";
  let repo = ".";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") base = argv[++i];
    else if (argv[i] === "--repo") repo = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  // A ref starting with "-" would be read by git log as an option.
  if (typeof base !== "string" || !REF.test(base) || base.startsWith("-")) throw new Error("--base must be a git ref");
  if (typeof repo !== "string" || !repo) throw new Error("--repo must be a path");
  return { base, repo };
}

/** The gitleaks binary: $GITLEAKS, else the pinned copy installed by install-gitleaks.mjs, else `gitleaks` on PATH. */
export function resolveGitleaks(env = process.env) {
  if (env.GITLEAKS) return env.GITLEAKS;
  const cached = cachedGitleaksPath(pinnedGitleaks().version, env);
  return existsSync(cached) ? cached : "gitleaks";
}

export function main(argv, env = process.env) {
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(`secret-scan:local: ${e.message}`); return 2; }
  const git = (...a) => spawnSync("git", a, { cwd: args.repo, encoding: "utf8" });
  const baseSha = git("rev-parse", "--verify", "--quiet", `${args.base}^{commit}`);
  if (baseSha.status !== 0) {
    console.error(`secret-scan:local: base ${args.base} not found (run \`git fetch origin\` first)`);
    return 2;
  }
  const count = git("rev-list", "--count", `${args.base}..HEAD`);
  if (count.status !== 0) { console.error("secret-scan:local: cannot list commits"); return 2; }
  const n = Number(count.stdout.trim());
  const bin = resolveGitleaks(env);
  const dir = mkdtempSync(join(tmpdir(), "s2-local-"));
  const reportPath = join(dir, "report.json");
  try {
    const run = spawnSync(
      bin,
      ["git", "--no-banner", "--redact", "--exit-code", "1", "--report-format", "json", "--report-path", reportPath,
        `--log-opts=${args.base}..HEAD`, args.repo],
      { encoding: "utf8", timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 },
    );
    if (run.error?.code === "ENOENT") {
      console.error("secret-scan:local: gitleaks not found. Install the pinned copy: node scripts/security/install-gitleaks.mjs");
      return 2;
    }
    if (run.error || (run.status !== 0 && run.status !== 1)) {
      console.error(`secret-scan:local: gitleaks failed (status ${run.status}, ${run.error?.message ?? "no error"})`);
      return 2;
    }
    let findings = [];
    if (existsSync(reportPath)) {
      try { findings = JSON.parse(readFileSync(reportPath, "utf8") || "[]"); } catch { console.error("secret-scan:local: gitleaks report is not JSON"); return 2; }
    } else if (run.status === 1 || n > 0) {
      console.error("secret-scan:local: gitleaks report missing");
      return 2;
    }
    const r = evaluate(findings);
    if (run.status === 1 && r.ok) { console.error("secret-scan:local: gitleaks exited 1 with an empty report"); return 2; }
    if (run.status === 0 && !r.ok) { console.error("secret-scan:local: gitleaks exited 0 with findings"); return 2; }
    for (const line of formatFindings(findings)) console.log(line);
    console.log(r.ok
      ? `secret-scan:local: PASS (${n} commit(s) in ${args.base}..HEAD, no secrets)`
      : `secret-scan:local: FAIL (${r.count} finding(s): ${r.rules.join(", ")}). Do not push: make the value obviously fake or build it at run time, then rewrite your unpushed commits.`);
    return r.ok ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));

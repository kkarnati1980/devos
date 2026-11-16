// SM-14 Dependencies (docs/modules/S3.md, "S3-d1 SM-14 build notes").
// SM-14-L1: a lockfile is committed and the dependency scan finds no high or critical vulnerability.
//
// This file only reads files: it never runs npm and never touches the network (the floor allows no child process
// outside src/safe-fetch.mjs). CI runs the scan and hands its JSON over:
//   npm audit --json --package-lock-only > audit.json || true
//   node scripts/deps-check.mjs --audit audit.json --out evidence/sm-14-scan.json
// The check fails closed: a missing or stale lockfile, an audit that did not run, or one it cannot read all fail.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const CHECK = "SM-14-L1";
export const BLOCKING = Object.freeze(["high", "critical"]);
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;

/** Same keys and the same spec strings (order does not matter). */
function sameDeps(a, b) {
  const x = isObj(a) ? a : {};
  const y = isObj(b) ? b : {};
  const kx = Object.keys(x).sort();
  const ky = Object.keys(y).sort();
  return kx.length === ky.length && kx.every((k, i) => k === ky[i] && x[k] === y[k]);
}

/**
 * The lockfile half: `package-lock.json` exists, is lockfile version 2 or 3, its root entry declares exactly the
 * dependencies of `package.json`, and each declared dependency is resolved in it. Returns finding codes.
 */
export function checkLockfile(pkg, lock) {
  if (!isObj(pkg)) return ["package-json-unreadable"];
  if (lock === undefined) return ["lockfile-missing"];
  if (!isObj(lock)) return ["lockfile-unreadable"];
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) return ["lockfile-version-unsupported"];
  const root = isObj(lock.packages) ? lock.packages[""] : undefined;
  if (!isObj(root)) return ["lockfile-unreadable"];
  const out = [];
  if (DEP_FIELDS.some((f) => !sameDeps(pkg[f], root[f]))) out.push("lockfile-out-of-sync");
  for (const f of DEP_FIELDS.slice(0, 3)) {
    for (const name of Object.keys(isObj(pkg[f]) ? pkg[f] : {})) {
      const entry = Object.hasOwn(lock.packages, `node_modules/${name}`) ? lock.packages[`node_modules/${name}`] : undefined;
      if (!isObj(entry) || typeof entry.version !== "string") { out.push("lockfile-out-of-sync"); break; }
    }
  }
  return [...new Set(out)];
}

/**
 * The scan half: an `npm audit --json` report (format 2). Counts come from `metadata.vulnerabilities` and from the
 * per-package list; the larger of the two is used, so a report cannot hide a finding in either place.
 */
export function readAudit(audit) {
  if (!isObj(audit) || audit.auditReportVersion !== 2 || !isObj(audit.metadata) || !isObj(audit.metadata.vulnerabilities)) {
    return { findings: [isObj(audit) && isObj(audit.error) ? "audit-failed" : "audit-unreadable"], vulnerabilities: null };
  }
  const meta = audit.metadata.vulnerabilities;
  if (!SEVERITIES.every((s) => count(meta[s]))) return { findings: ["audit-unreadable"], vulnerabilities: null };
  const listed = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const v of Object.values(isObj(audit.vulnerabilities) ? audit.vulnerabilities : {})) {
    if (!isObj(v) || !SEVERITIES.includes(v.severity)) return { findings: ["audit-unreadable"], vulnerabilities: null };
    listed[v.severity] += 1;
  }
  const vulnerabilities = Object.fromEntries(SEVERITIES.map((s) => [s, Math.max(meta[s], listed[s])]));
  const findings = BLOCKING.filter((s) => vulnerabilities[s] > 0).map((s) => `${s}-vulnerabilities`);
  return { findings, vulnerabilities };
}

function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return e && e.code === "ENOENT" ? undefined : null; }
  try { return JSON.parse(text); } catch { return null; }
}

/** The whole check over an app directory and an audit report file; returns the `scan_report` evidence record. */
export function depsCheck({ dir, auditFile, now = () => new Date() }) {
  const lockPath = path.join(dir, "package-lock.json");
  const lockText = (() => { try { return fs.readFileSync(lockPath); } catch { return null; } })();
  const lockFindings = checkLockfile(readJson(path.join(dir, "package.json")), readJson(lockPath));
  const audit = auditFile ? readJson(auditFile) : undefined;
  const scan = audit === undefined ? { findings: ["audit-missing"], vulnerabilities: null } : readAudit(audit);
  const findings = [...lockFindings, ...scan.findings];
  return {
    check: CHECK,
    ok: findings.length === 0,
    findings,
    lockfile: lockText ? { path: "package-lock.json", sha256: crypto.createHash("sha256").update(lockText).digest("hex") } : null,
    vulnerabilities: scan.vulnerabilities,
    time: now().toISOString(),
  };
}

/** Writes the report next to its final name and renames it, so a reader never sees half a file. */
export function writeReport(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** CLI: `node scripts/deps-check.mjs --audit audit.json [--out evidence/sm-14-scan.json]`; exit 0 only when ok. */
export function main(argv, { dir = process.cwd(), log = console.log } = {}) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 && typeof argv[i + 1] === "string" ? argv[i + 1] : undefined; };
  const report = depsCheck({ dir, auditFile: arg("--audit") ? path.resolve(dir, arg("--audit")) : undefined });
  const out = arg("--out");
  if (out) writeReport(path.resolve(dir, out), report);
  log(`${CHECK} ${report.ok ? "PASS" : "FAIL"}${report.findings.length ? ` (${report.findings.join(", ")})` : ""}`);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));

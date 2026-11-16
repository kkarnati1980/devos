// SM-13-L1 evidence: node scripts/mybrain-scan.mjs --url http://127.0.0.1:3000 [--paths /health,/] [--out report.json]
// Scans a running app's responses (frame-ancestors 'none', no Access-Control-Allow-*) and the repo for a
// MyBrain credential, writes the scan_report record, and exits 0 only when it is clean.
import { realpathSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { findMyBrainSecrets, scanApp } from "../src/mybrain-link.mjs";

export async function main(argv, { scan = scanApp, root = process.cwd(), print = (s) => process.stdout.write(s) } = {}) {
  const arg = (name) => { const i = argv.indexOf(name); const v = i >= 0 ? argv[i + 1] : undefined; return v && !v.startsWith("--") ? v : undefined; };
  const url = arg("--url");
  if (!url) { print("usage: mybrain-scan.mjs --url <app base URL> [--paths /a,/b] [--out report.json]\n"); return 2; }
  const paths = arg("--paths") ? arg("--paths").split(",").map((p) => p.trim()).filter(Boolean) : undefined;
  const report = await scan({ baseUrl: url, ...(paths ? { paths } : {}) });
  const out = arg("--out");
  const secrets = findMyBrainSecrets(root, { skipFiles: out ? [resolve(out)] : [] });
  report.findings.push(...secrets);
  report.ok = report.findings.length === 0;
  if (out) { const tmp = `${resolve(out)}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(report, null, 2) + "\n"); renameSync(tmp, resolve(out)); }
  print(`${report.check}: ${report.ok ? "pass" : "FAIL"} (${report.checked.length} responses)\n${report.findings.map((f) => `  ${f}\n`).join("")}`);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));

// SM-14 add-on tests (docs/modules/S3.md, "S3-d1 SM-14 build notes").
// SM-14-L1: a lockfile is committed and the dependency scan finds no high or critical vulnerability.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkLockfile, readAudit, depsCheck, main, CHECK } from "../scripts/deps-check.mjs";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clean = () => ({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } });
const withVulns = (sev) => {
  const a = clean();
  a.vulnerabilities = { "left-pad": { name: "left-pad", severity: sev } };
  a.metadata.vulnerabilities[sev] = 1;
  return a;
};

function tmpApp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm14-"));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
  return dir;
}

test("SM-14-L1: the app ships a committed lockfile that matches package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(APP, "package-lock.json"), "utf8"));
  assert.deepEqual(checkLockfile(pkg, lock), []);
});

test("SM-14-L1: a missing, unreadable, old-format or stale lockfile fails", () => {
  const pkg = { name: "a", dependencies: { yaml: "2.8.1" }, devDependencies: { playwright: "1.49.1" } };
  const lock = { lockfileVersion: 3, packages: {
    "": { name: "a", dependencies: { yaml: "2.8.1" }, devDependencies: { playwright: "1.49.1" } },
    "node_modules/yaml": { version: "2.8.1" },
    "node_modules/playwright": { version: "1.49.1" },
  } };
  assert.deepEqual(checkLockfile(pkg, lock), []);
  assert.deepEqual(checkLockfile(pkg, undefined), ["lockfile-missing"]);
  assert.deepEqual(checkLockfile(pkg, null), ["lockfile-unreadable"]);
  assert.deepEqual(checkLockfile(pkg, { ...lock, lockfileVersion: 1 }), ["lockfile-version-unsupported"]);
  assert.deepEqual(checkLockfile(null, lock), ["package-json-unreadable"]);
  // A dependency added to package.json without refreshing the lockfile.
  assert.deepEqual(checkLockfile({ ...pkg, dependencies: { yaml: "2.8.1", pg: "8.13.1" } }, lock), ["lockfile-out-of-sync"]);
  // A changed version spec.
  assert.deepEqual(checkLockfile({ ...pkg, dependencies: { yaml: "^2.8.1" } }, lock), ["lockfile-out-of-sync"]);
  // Declared in the root entry but never resolved.
  const unresolved = structuredClone(lock);
  delete unresolved.packages["node_modules/yaml"];
  assert.deepEqual(checkLockfile(pkg, unresolved), ["lockfile-out-of-sync"]);
  // Lockfile version 2 is accepted too.
  assert.deepEqual(checkLockfile(pkg, { ...lock, lockfileVersion: 2 }), []);
  // A local package (file:, link:, workspace) is resolved as a link, without a version (as npm writes it).
  const local = { name: "a", dependencies: { loc: "file:local" } };
  assert.deepEqual(checkLockfile(local, { lockfileVersion: 3, packages: { "": { name: "a", dependencies: { loc: "file:local" } }, "node_modules/loc": { resolved: "local", link: true }, local: { version: "1.0.0" } } }), []);
  assert.deepEqual(checkLockfile(local, { lockfileVersion: 3, packages: { "": { name: "a", dependencies: { loc: "file:local" } }, "node_modules/loc": { link: true } } }), ["lockfile-out-of-sync"]);
  // A name in both dependencies and optionalDependencies is listed by npm under the optional ones only.
  const both = { name: "a", dependencies: { ms: "2.1.3" }, optionalDependencies: { ms: "2.1.3" } };
  assert.deepEqual(checkLockfile(both, { lockfileVersion: 3, packages: { "": { name: "a", optionalDependencies: { ms: "2.1.3" } }, "node_modules/ms": { version: "2.1.3", optional: true } } }), []);
  assert.deepEqual(checkLockfile(both, { lockfileVersion: 3, packages: { "": { name: "a" }, "node_modules/ms": { version: "2.1.3" } } }), ["lockfile-out-of-sync"]);
  // Codex PR187-r1: a required peer dependency must be resolved; an optional peer need not be.
  const peer = { name: "a", peerDependencies: { foo: "1.0.0" } };
  const peerRoot = { "": { name: "a", peerDependencies: { foo: "1.0.0" } } };
  assert.deepEqual(checkLockfile(peer, { lockfileVersion: 3, packages: peerRoot }), ["lockfile-out-of-sync"]);
  assert.deepEqual(checkLockfile(peer, { lockfileVersion: 3, packages: { ...peerRoot, "node_modules/foo": { version: "1.0.0", peer: true } } }), []);
  const optPeer = { ...peer, peerDependenciesMeta: { foo: { optional: true } } };
  assert.deepEqual(checkLockfile(optPeer, { lockfileVersion: 3, packages: peerRoot }), []);
  // A name like an Object member is not mistaken for a resolved entry.
  const proto = { name: "a", dependencies: { constructor: "1.0.0" } };
  assert.deepEqual(checkLockfile(proto, { lockfileVersion: 3, packages: { "": { dependencies: { constructor: "1.0.0" } } } }), ["lockfile-out-of-sync"]);
});

test("SM-14-L1: a high or critical vulnerability fails the scan; lower ones are counted but pass", () => {
  assert.deepEqual(readAudit(clean()).findings, []);
  assert.deepEqual(readAudit(withVulns("moderate")), { findings: [], vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 } });
  assert.deepEqual(readAudit(withVulns("high")).findings, ["high-vulnerabilities"]);
  assert.deepEqual(readAudit(withVulns("critical")).findings, ["critical-vulnerabilities"]);
  // A finding listed in only one of the two places still counts.
  const hidden = clean();
  hidden.vulnerabilities = { x: { severity: "critical" } };
  assert.deepEqual(readAudit(hidden).findings, ["critical-vulnerabilities"]);
  const metaOnly = clean();
  metaOnly.metadata.vulnerabilities.high = 2;
  assert.deepEqual(readAudit(metaOnly).findings, ["high-vulnerabilities"]);
});

test("SM-14-L1: an audit that did not run or cannot be read fails closed", () => {
  assert.deepEqual(readAudit({ error: { code: "ENOTFOUND", summary: "registry unreachable" } }).findings, ["audit-failed"]);
  for (const bad of [null, "", [], {}, { auditReportVersion: 1, advisories: {} }, { ...clean(), metadata: { vulnerabilities: { high: "0" } } },
    { ...clean(), metadata: { vulnerabilities: { ...clean().metadata.vulnerabilities, high: -1 } } },
    { ...clean(), metadata: { vulnerabilities: { ...clean().metadata.vulnerabilities, critical: 0.5 } } },
    // Codex PR187-r2: a missing or malformed per-package list.
    { ...clean(), vulnerabilities: [{ severity: "critical" }] }, { ...clean(), vulnerabilities: undefined }, { ...clean(), vulnerabilities: null }]) {
    assert.deepEqual(readAudit(bad).findings, ["audit-unreadable"], JSON.stringify(bad));
  }
  const odd = clean();
  odd.vulnerabilities = { x: { severity: "urgent" } };
  assert.deepEqual(readAudit(odd).findings, ["audit-unreadable"]);
});

test("SM-14-L1: the CLI stores the scan_report evidence and exits 0 only when the lockfile and the scan are clean", () => {
  const pkg = { name: "a", version: "1.0.0" };
  const lock = { lockfileVersion: 3, packages: { "": { name: "a", version: "1.0.0" } } };
  const dir = tmpApp({ "package.json": pkg, "package-lock.json": lock, "audit.json": clean() });
  const lines = [];
  assert.equal(main(["--audit", "audit.json", "--out", "evidence/sm-14-scan.json"], { dir, log: (l) => lines.push(l) }), 0);
  const report = JSON.parse(fs.readFileSync(path.join(dir, "evidence/sm-14-scan.json"), "utf8"));
  assert.equal(report.check, CHECK);
  assert.equal(report.ok, true);
  assert.deepEqual(report.findings, []);
  assert.match(report.lockfile.sha256, /^[0-9a-f]{64}$/);
  assert.ok(!Number.isNaN(Date.parse(report.time)));
  assert.deepEqual(lines, ["SM-14-L1 PASS"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "evidence")), ["sm-14-scan.json"], "no temp file left");

  fs.writeFileSync(path.join(dir, "audit.json"), JSON.stringify(withVulns("high")));
  assert.equal(main(["--audit", "audit.json"], { dir, log: (l) => lines.push(l) }), 1);
  assert.equal(lines.at(-1), "SM-14-L1 FAIL (high-vulnerabilities)");
  // No audit file given, or no lockfile: fail.
  assert.equal(main([], { dir, log: () => {} }), 1);
  assert.deepEqual(depsCheck({ dir }).findings, ["audit-missing"]);
  assert.equal(main(["--audit", "--out", "x.json"], { dir, log: () => {} }), 1, "a flag is never taken as the audit file");
  assert.ok(!fs.existsSync(path.join(dir, "--out")));
  assert.deepEqual(depsCheck({ dir, auditFile: path.join(dir, "missing.json") }).findings, ["audit-missing"]);
  fs.rmSync(path.join(dir, "package-lock.json"));
  fs.writeFileSync(path.join(dir, "audit.json"), JSON.stringify(clean()));
  const r = depsCheck({ dir, auditFile: path.join(dir, "audit.json") });
  assert.deepEqual([r.ok, r.findings, r.lockfile], [false, ["lockfile-missing"], null]);
});

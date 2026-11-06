// S2 acceptance tests AT1–AT4 (docs/modules/S2.md): gate evaluation logic, offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate as evalVulns } from "../security/vuln-scan.mjs";
import { evaluate as evalLicences, classifyExpression, loadPolicy } from "../security/licence-check.mjs";
import { evaluate as evalSecrets, formatFindings } from "../security/secret-scan.mjs";

const report = (groups, vulns = []) => ({
  results: [{ packages: [{ package: { name: "p", version: "1.0.0" }, vulnerabilities: vulns, groups }] }],
});

test("AT1 vulnerability evaluation blocks high/critical and unknown, passes medium/low", () => {
  for (const s of ["7.0", "7.2", "9.8"]) assert.equal(evalVulns(report([{ ids: ["X"], max_severity: s }])).ok, false, s);
  for (const s of ["6.9", "4.3", "0.1"]) assert.equal(evalVulns(report([{ ids: ["X"], max_severity: s }])).ok, true, s);
  for (const lvl of ["HIGH", "CRITICAL", "high"]) {
    const r = evalVulns(report([{ ids: ["G"], max_severity: "" }], [{ id: "G", database_specific: { severity: lvl } }]));
    assert.equal(r.ok, false, lvl);
    assert.equal(r.blocking.length, 1);
  }
  for (const lvl of ["MODERATE", "LOW"]) {
    const r = evalVulns(report([{ ids: ["G"], max_severity: "" }], [{ id: "G", database_specific: { severity: lvl } }]));
    assert.equal(r.ok, true, lvl);
  }
  const unknown = evalVulns(report([{ ids: ["U"], max_severity: "" }], [{ id: "U" }]));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.unknown.length, 1);
  assert.equal(evalVulns({ results: [] }).ok, true);
  assert.equal(evalVulns({}).ok, true);
  const named = evalVulns(report([{ ids: ["GHSA-35jh-r3h4-6jhm"], aliases: ["CVE-2021-23337"], max_severity: "7.2" }]));
  assert.deepEqual(named.blocking[0].ids, ["GHSA-35jh-r3h4-6jhm", "CVE-2021-23337"]);
});

const policy = loadPolicy();
const listing = (licence, name = "pkg", versions = ["1.0.0"]) => ({ [licence]: [{ name, versions, license: licence }] });

test("AT2 licence evaluation: permissive passes, copyleft and unknown fail, reviewed weak copyleft passes only at its version", () => {
  for (const l of ["MIT", "Apache-2.0", "MIT and ISC", "(MIT OR GPL-3.0)", "BSD-3-Clause", "CC-BY-4.0"]) {
    assert.equal(evalLicences(listing(l), policy).ok, true, l);
  }
  for (const l of ["GPL-3.0", "AGPL-3.0-only", "GPL-2.0-or-later", "MIT AND GPL-2.0", "UNKNOWN", "SEE LICENSE IN LICENSE", "SSPL-1.0", "(MIT) OR (GPL"]) {
    assert.equal(evalLicences(listing(l), policy).ok, false, l);
  }
  assert.equal(evalLicences({ x: [{ name: "nolicence", versions: ["1.0.0"] }] }, policy).ok, false);
  assert.equal(classifyExpression("GPL-3.0", policy), "strong");
  assert.equal(classifyExpression("LGPL-3.0-or-later", policy), "weak");
  assert.equal(evalLicences(listing("LGPL-3.0-or-later", "some-new-lib"), policy).ok, false);
  const reviewed = evalLicences(listing("LGPL-3.0-or-later", "@img/sharp-libvips-linux-x64", ["1.3.4"]), policy);
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.reviewedUsed.length, 1);
  assert.equal(evalLicences(listing("LGPL-3.0-or-later", "@img/sharp-libvips-linux-x64", ["1.3.5"]), policy).ok, false);
  const strong = evalLicences(listing("GPL-3.0", "gpl-lib"), policy);
  assert.match(strong.failures[0].why, /decision card/);
});

test("AT3 the secret formatter never prints the Secret or Match fields", () => {
  // Built at run time so the committed source never holds a token-shaped string (the S2 secret scan covers this file).
  const leaked = ["ghp", "THISisAfakeTOKENthatMUSTneverPRINT1234"].join("_");
  const finding = { RuleID: "github-pat", File: "a.js", StartLine: 3, Commit: "0123456789abcdef", Secret: leaked, Match: `token="${leaked}"`, Line: leaked };
  const lines = formatFindings([finding]).join("\n");
  assert.match(lines, /rule=github-pat file=a\.js:3 commit=0123456789ab/);
  assert.ok(!lines.includes(leaked));
  assert.ok(!lines.includes("THISisAfake"));
  assert.deepEqual(evalSecrets([finding]), { ok: false, count: 1, rules: ["github-pat"] });
  assert.equal(evalSecrets([]).ok, true);
});

test("AT4 the licence policy is well formed and reviews only weak copyleft", () => {
  assert.ok(Array.isArray(policy.permissive) && policy.permissive.includes("MIT"));
  for (const r of policy.reviewed) {
    for (const k of ["name", "licence", "reason", "ref"]) assert.ok(typeof r[k] === "string" && r[k].length > 2, `${r.name} ${k}`);
    assert.ok(Array.isArray(r.versions) && r.versions.length, `${r.name} versions`);
    assert.equal(classifyExpression(r.licence, policy), "weak", `${r.name} must be weak copyleft`);
  }
});

test("AT4b .gitleaksignore holds only commit-qualified fingerprints of historic fixtures", () => {
  const entries = readFileSync(new URL("../../.gitleaksignore", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  for (const e of entries) assert.match(e, /^[0-9a-f]{40}:[^:]+:[a-z0-9-]+:\d+$/, e);
});

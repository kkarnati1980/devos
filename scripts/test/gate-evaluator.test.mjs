// DEVOS-144 (gate integrity Part 4): gate evaluator. Contract: docs/modules/GI-4.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateGate, renderComment, CannotRun } from "../gates/evaluate-gate.mjs";

const SUP = "// eslint-" + "disable-next-line";
const fgClean = (sha, link) => ({ report: { sha, exit: 0, hits: [] }, link });
const hitOf = (rule, id = "fg-0123456789", file = "a.test.ts", line = 3, text = "x") => ({ id, rule, file, line, text });

const ROOT = path.resolve(import.meta.dirname, "../..");
const CLI = path.join(ROOT, "scripts/gates/evaluate-gate.mjs");
const H1 = "a".repeat(40), H2 = "b".repeat(40), M1 = "c".repeat(40), DEP = "d".repeat(40);
const L = (s) => `https://example.test/${s}`;

/** Complete, passing evidence for a two-PR, one-module phase. */
function complete() {
  return {
    gate: "G2",
    modules: [{ id: "M2.1", status: "Done", link: L("DEVOS-9"), mergedSha: M1, prs: [70, 71], passRule: { result: "pass", sha: M1, link: L("pr-m21") } }],
    blockers: [{ issue: "DEVOS-76", status: "Done", link: L("DEVOS-76") }],
    serverChecks: { sha: DEP, checks: [{ name: "server-check/health", state: "success", sha: DEP, link: L("sc1") }] },
    criteria: [{ text: "intake round-trips a spec", met: true, link: L("crit1") }],
    openKkItems: [],
    openKkQuery: L("kk-query"),
    mergedPrs: [
      { number: 70, headSha: H1, ci: { sha: H1, conclusion: "success", link: L("ci70") }, codex: { sha: H1, state: "success", link: L("cx70") },
        floorGuard: fgClean(H1, L("fg70")), mergeGate: { exit: 0, headSha: H1, mergeSha: "e".repeat(40), link: L("mg70") } },
      { number: 71, headSha: H2, ci: { sha: H2, conclusion: "success", link: L("ci71") }, codex: { sha: H2, state: "success", link: L("cx71") },
        floorGuard: fgClean(H2, L("fg71")), mergeGate: { exit: 0, headSha: H2, mergeSha: M1, link: L("mg71") } },
    ],
  };
}

test("AT1: complete evidence approves (exit 0 from the CLI)", () => {
  const r = evaluateGate(complete());
  assert.equal(r.decision, "approve");
  assert.deepEqual(r.missing, []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  fs.writeFileSync(path.join(dir, "ev.json"), JSON.stringify(complete()));
  const p = spawnSync(process.execPath, [CLI, path.join(dir, "ev.json")], { encoding: "utf8" });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.match(p.stdout, /G2 approve/);
});

test("AT2 (GC6): one PR lacking a stored floor-guard result pauses and names it (exit 1)", () => {
  const ev = complete();
  delete ev.mergedPrs[1].floorGuard;
  const r = evaluateGate(ev);
  assert.equal(r.decision, "paused");
  assert.deepEqual(r.missing, ["(5) PR #71: no stored floor-guard result"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  fs.writeFileSync(path.join(dir, "ev.json"), JSON.stringify(ev));
  const p = spawnSync(process.execPath, [CLI, path.join(dir, "ev.json"), "--comment", path.join(dir, "c.md")], { encoding: "utf8" });
  assert.equal(p.status, 1);
  assert.match(p.stdout, /missing \(5\) PR #71: no stored floor-guard result/);
  const c = fs.readFileSync(path.join(dir, "c.md"), "utf8");
  assert.match(c, /^\[runner\] G2 PAUSED .*: missing/);
  assert.match(c, /no KK card/);
});

test("AT3: floor guard exit 2, open hits, a Keep on another SHA or by the Builder, a KK-only hit kept by Codex, a pending escalation, or inconsistent reports pause", () => {
  const keep = (sha, source = "codex", h = hitOf("test-skipped")) => ({ sha, source, text: `FLOOR-GUARD KEEP ${h.id} ${h.file}:${h.line} justified`, link: L("v") });
  const cases = [
    [(fg) => { fg.report.exit = 2; }, /floor guard exit 2 \(could not run is never clean\)/],
    [(fg) => { Object.assign(fg.report, { exit: 1, hits: [hitOf("test-skipped")] }); }, /without a valid disposition/],
    [(fg) => { Object.assign(fg.report, { exit: 1, hits: [hitOf("test-skipped")] }); fg.verdict = keep(H2); }, /without a valid disposition/],
    [(fg) => { Object.assign(fg.report, { exit: 1, hits: [hitOf("test-skipped")] }); fg.verdict = keep(H1, "builder"); }, /without a valid disposition/],
    [(fg) => { const h = hitOf("gitleaksignore-added"); Object.assign(fg.report, { exit: 1, hits: [h] }); fg.verdict = keep(H1, "codex", h); }, /needs KK's recorded answer/],
    [(fg) => { const h = hitOf("policy-weakened"); Object.assign(fg.report, { exit: 1, hits: [h] }); fg.kkResolutions = [{ hit: h.id, sha: H1, decision: "escalated", link: L("card") }]; }, /needs KK's recorded answer/],
    [(fg) => { fg.report.hits = [hitOf("test-skipped")]; }, /exit 0 but hits stored/],
    // one Keep naming line 3 does not clear an identical line 9 (GI-1 ids repeat for identical text)
    [(fg) => { Object.assign(fg.report, { exit: 1, hits: [hitOf("test-skipped"), hitOf("test-skipped", undefined, "a.test.ts", 9)] }); fg.verdict = keep(H1); }, /a\.test\.ts:9\) without a valid disposition/],
    // KK's restore, a pending escalation or conflicting answers override a Codex Keep on any hit
    [(fg) => { const h = hitOf("test-skipped", undefined, "billing.test.ts"); Object.assign(fg.report, { exit: 1, hits: [h] }); fg.verdict = keep(H1, "codex", h);
      fg.kkResolutions = [{ hit: h.id, file: h.file, line: h.line, sha: H1, decision: "restore", link: L("kk") }]; }, /KK's recorded answer is not keep \(restore\)/],
    [(fg) => { const h = hitOf("policy-weakened"); Object.assign(fg.report, { exit: 1, hits: [h] });
      fg.kkResolutions = [{ hit: h.id, file: h.file, line: h.line, sha: H1, decision: "keep", link: L("k1") }, { hit: h.id, file: h.file, line: h.line, sha: H1, decision: "restore", link: L("k2") }]; }, /not keep \(keep, restore\)/],
    // security-scanning CI removals and cut-off suppression texts are KK-only
    [(fg) => { const h = hitOf("ci-step-removed", undefined, ".github/workflows/security.yml", 12, "- run: gitleaks detect"); Object.assign(fg.report, { exit: 1, hits: [h] }); fg.verdict = keep(H1, "codex", h); }, /needs KK's recorded answer/],
    // PR84-r2: a security lint rule turned off, and lint ignores, are KK-only; an ordinary lint-rule-off is not
    [(fg) => { const h = hitOf("lint-rule-off", undefined, "eslint.config.mjs", 7, '"security/detect-eval-with-expression": "off",'); Object.assign(fg.report, { exit: 1, hits: [h] }); fg.verdict = keep(H1, "codex", h); }, /needs KK's recorded answer/],
    [(fg) => { const h = hitOf("lint-rule-off", undefined, "eslint.config.mjs", 7, 'ignores: ["src/**"],'); Object.assign(fg.report, { exit: 1, hits: [h] }); fg.verdict = keep(H1, "codex", h); }, /needs KK's recorded answer/],
    // PR84-r3: the security check applies to suppressions too (by file or by rule name). The fixture text is
    // concatenated (SUP) so the floor guard does not read the fixture itself as a new suppression.
    [(fg) => { const h = hitOf("suppression-added", undefined, "src/security/check.ts", 3, SUP); Object.assign(fg.report, { exit: 1, hits: [h] }); fg.verdict = keep(H1, "codex", h); }, /needs KK's recorded answer/],
    [(fg) => { const h = hitOf("suppression-added", undefined, "src/a.ts", 3, SUP + " no-eval"); Object.assign(fg.report, { exit: 1, hits: [h] }); fg.verdict = keep(H1, "codex", h); }, /needs KK's recorded answer/],
    // PR84-r1: a CI hit names only the step ("Checks" running npm audit), so every ci-* hit is KK-only
    [(fg) => { const h = hitOf("ci-step-removed", undefined, ".github/workflows/ci.yml", 30, "job build: step name:Checks removed"); Object.assign(fg.report, { exit: 1, hits: [h] }); fg.verdict = keep(H1, "codex", h); }, /needs KK's recorded answer/],
    [(fg) => { const h = hitOf("ci-disabled", undefined, ".github/workflows/ci.yml", 12, "if: false"); Object.assign(fg.report, { exit: 1, hits: [h] }); fg.verdict = keep(H1, "codex", h); }, /needs KK's recorded answer/],
    [(fg) => { const h = hitOf("suppression-added", undefined, "src/x.ts", 4, "x".repeat(200)); Object.assign(fg.report, { exit: 1, hits: [h] }); fg.verdict = keep(H1, "codex", h); }, /needs KK's recorded answer/],
    // PR84-r4: the 200-character cut applies to every rule, not only suppressions and lint-rule-off
    [(fg) => { const h = hitOf("failure-swallowed", undefined, "src/x.ts", 5, "y".repeat(200)); Object.assign(fg.report, { exit: 1, hits: [h] }); fg.verdict = keep(H1, "codex", h); }, /needs KK's recorded answer/],
    [(fg) => { const h = hitOf("test-skipped", undefined, "test/x.test.ts", 6, "z".repeat(250)); Object.assign(fg.report, { exit: 1, hits: [h] }); fg.verdict = keep(H1, "codex", h); }, /needs KK's recorded answer/],
    [(fg) => { fg.report.exit = 1; }, /exit 1 with no hits/],
    [(fg) => { fg.report.sha = H2; }, /floor-guard result is not for head/],
    [(fg) => { delete fg.link; }, /floor-guard result has no link/],
  ];
  for (const [mut, re] of cases) {
    const ev = complete();
    mut(ev.mergedPrs[0].floorGuard);
    const r = evaluateGate(ev);
    assert.equal(r.decision, "paused", String(re));
    assert.match(r.missing.join("\n"), re);
  }
});

test("AT4: a Codex Keep naming id and file:line on the same SHA, and KK's recorded keep on a KK-only hit, count as clean", () => {
  const ev = complete();
  const h1 = hitOf("test-skipped", "fg-aaaaaaaaaa"), h2 = hitOf("suppression-added", "fg-bbbbbbbbbb", "src/x.ts", 9, "// " + "nos" + "ec"); // split so the floor guard does not read the fixture as a suppression
  Object.assign(ev.mergedPrs[0].floorGuard, {
    report: { sha: H1, exit: 1, hits: [h1, h2] },
    verdict: { sha: H1, source: "codex", text: `Codex PASS\nFLOOR-GUARD KEEP ${h1.id} ${h1.file}:${h1.line} reason`, link: L("v") },
    kkResolutions: [{ hit: h2.id, file: h2.file, line: h2.line, sha: H1, decision: "keep", link: L("kk-answer") }],
  });
  const plain = complete();
  const h3 = hitOf("lint-rule-off", "fg-cccccccccc", "eslint.config.mjs", 5, '"no-console": "off",');
  Object.assign(plain.mergedPrs[0].floorGuard, { report: { sha: H1, exit: 1, hits: [h3] },
    verdict: { sha: H1, source: "codex", text: `FLOOR-GUARD KEEP ${h3.id} ${h3.file}:${h3.line} ok`, link: L("v3") } });
  assert.deepEqual(evaluateGate(plain).missing, [], "an ordinary lint rule off is cleared by a Codex Keep");
  const r = evaluateGate(ev);
  assert.deepEqual(r.missing, []);
  const c = renderComment(r, "t");
  assert.ok(c.includes(L("v")) && c.includes(L("kk-answer")), "GC7: the comment links the Codex Keep and KK's answer");
});

test("AT5: a module with no pass-rule result, a failing one, or one on another SHA pauses", () => {
  const muts = [
    [(m) => { delete m.passRule; }, /M2\.1: no stored pass-rule result/],
    [(m) => { m.passRule.result = "fail"; }, /M2\.1: pass rule fail/],
    [(m) => { m.passRule.sha = H1; }, /not for merged SHA/],
  ];
  for (const [mut, re] of muts) {
    const ev = complete();
    mut(ev.modules[0]);
    const r = evaluateGate(ev);
    assert.equal(r.decision, "paused");
    assert.match(r.missing.join("\n"), re);
  }
});

test("AT6: CI or codex-review missing, not success, or on another SHA pauses", () => {
  const muts = [
    [(pr) => { pr.ci.conclusion = "failure"; }, /CI failure/],
    [(pr) => { delete pr.codex; }, /codex-review missing/],
    [(pr) => { pr.codex.sha = H2; }, /codex-review is not for head/],
    [(pr) => { pr.ci.sha = H2; }, /CI result is not for head/],
    [(pr) => { delete pr.ci; }, /CI missing/],
    [(pr) => { delete pr.ci.link; }, /CI result has no link/],
    [(pr) => { delete pr.codex.link; }, /codex-review result has no link/],
    [(pr) => { delete pr.mergeGate; }, /no merge-gate record/],
    [(pr) => { pr.mergeGate.headSha = H2; }, /merge-gate record is not for head/],
    [(pr) => { pr.headSha = H1.slice(0, 7); }, /no head SHA/],
  ];
  for (const [mut, re] of muts) {
    const ev = complete();
    mut(ev.mergedPrs[0]);
    assert.match(evaluateGate(ev).missing.join("\n"), re);
  }
});

test("AT7: ADR-0013's four conditions — not Done, a failed or skipped server check, an unmet criterion, an open KK item — pause", () => {
  const muts = [
    [(ev) => { ev.blockers[0].status = "In Progress"; }, /\(1\) DEVOS-76 is not Done/],
    [(ev) => { ev.serverChecks.checks[0].state = "skipped"; }, /\(2\) server check server-check\/health: skipped/],
    [(ev) => { ev.serverChecks.checks = []; }, /\(2\) server checks: no stored results/],
    [(ev) => { ev.criteria[0].met = false; }, /\(3\) criterion not met/],
    [(ev) => { ev.openKkItems.push({ issue: "DEVOS-4" }); }, /\(4\) open KK item: DEVOS-4/],
    [(ev) => { ev.mergedPrs = []; }, /\(5\) no merged PRs/],
    [(ev) => { ev.serverChecks.checks[0].sha = H1; }, /not on the deployed SHA/],
    [(ev) => { delete ev.serverChecks.sha; }, /no deployed main SHA/],
    [(ev) => { ev.mergedPrs.pop(); }, /\(7\) M2\.1: PR #71 is not among the merged PRs/],
    [(ev) => { ev.mergedPrs.push(ev.mergedPrs[0]); }, /merged PR listed twice: 70/],
    [(ev) => { ev.modules.push({ ...ev.modules[0] }); }, /module listed twice: M2\.1/],
    [(ev) => { delete ev.modules[0].prs; }, /no merged PR numbers listed/],
    [(ev) => { const x = "f".repeat(40); ev.modules[0].mergedSha = x; ev.modules[0].passRule.sha = x; }, /is not the merge commit of any of its PRs/],
    [(ev) => { delete ev.mergedPrs[0].mergeGate.mergeSha; }, /merge-gate record has no merge SHA/],
  ];
  for (const [mut, re] of muts) {
    const ev = complete();
    mut(ev);
    assert.match(evaluateGate(ev).missing.join("\n"), re);
  }
});

test("AT8 (GC7): the approval comment links a stored result for every condition", () => {
  const r = evaluateGate(complete());
  const c = renderComment(r, "2026-11-13T06:30:00Z (12:00 IST, 13 Nov 2026)");
  assert.match(c, /^\[runner\] G2 APPROVED under KK's delegation/);
  for (const cond of r.conditions) {
    assert.ok(cond.results.length > 0, `condition ${cond.id} has no result`);
    const section = c.split(`\n${cond.id}. `)[1];
    assert.ok(section, `condition ${cond.id} missing from comment`);
  }
  const ev = complete();
  ev.criteria[0].text = "ok](https://evil.test) [";
  ev.criteria[0].link = "https://x.test/a)[b](c";
  assert.match(evaluateGate(ev).missing.join("\n"), /no link to a stored result/);
  ev.criteria[0].link = L("crit1");
  assert.ok(!renderComment(evaluateGate(ev), "t").includes("[ok](https://evil"), "label is escaped");
  for (const link of ["mg70", "mg71", "fg70", "fg71", "pr-m21", "ci70", "cx70", "ci71", "cx71", "sc1", "crit1", "kk-query", "DEVOS-9"]) {
    assert.ok(c.includes(L(link)), `comment lacks ${link}`);
  }
});

test("AT9: G5 or an unknown gate, malformed evidence, unreadable files and bad arguments exit 2", () => {
  assert.throws(() => evaluateGate({ ...complete(), gate: "G5" }), CannotRun);
  assert.throws(() => evaluateGate({ ...complete(), mergedPrs: null }), CannotRun);
  assert.throws(() => evaluateGate(null), CannotRun);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  fs.writeFileSync(path.join(dir, "bad.json"), "{not json");
  fs.writeFileSync(path.join(dir, "g5.json"), JSON.stringify({ ...complete(), gate: "G5" }));
  const link = path.join(dir, "link");
  fs.symlinkSync(path.join(ROOT, "scripts"), link);
  const viaLink = spawnSync(process.execPath, [path.join(link, "gates/evaluate-gate.mjs"), path.join(dir, "g5.json")], { encoding: "utf8" });
  assert.equal(viaLink.status, 2, "a symlinked path still evaluates (never a silent exit 0)");
  for (const args of [[], [path.join(dir, "nope.json")], [path.join(dir, "bad.json")], [path.join(dir, "g5.json")]]) {
    const p = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    assert.equal(p.status, 2, `args ${args}: ${p.stdout}${p.stderr}`);
    assert.match(p.stderr, /could not run/);
  }
});

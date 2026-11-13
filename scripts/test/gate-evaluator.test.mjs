// DEVOS-144 (gate integrity Part 4): gate evaluator. Contract: docs/modules/GI-4.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateGate, renderComment, CannotRun } from "../gates/evaluate-gate.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CLI = path.join(ROOT, "scripts/gates/evaluate-gate.mjs");
const H1 = "a".repeat(40), H2 = "b".repeat(40), M1 = "c".repeat(40), DEP = "d".repeat(40);
const L = (s) => `https://example.test/${s}`;

/** Complete, passing evidence for a two-PR, one-module phase. */
function complete() {
  return {
    gate: "G2",
    modules: [{ id: "M2.1", status: "Done", link: L("DEVOS-9"), mergedSha: M1, passRule: { result: "pass", sha: M1, link: L("pr-m21") } }],
    blockers: [{ issue: "DEVOS-76", status: "Done", link: L("DEVOS-76") }],
    serverChecks: { sha: DEP, checks: [{ name: "server-check/health", state: "success", sha: DEP, link: L("sc1") }] },
    criteria: [{ text: "intake round-trips a spec", met: true, link: L("crit1") }],
    openKkItems: [],
    openKkQuery: L("kk-query"),
    mergedPrs: [
      { number: 70, headSha: H1, ci: { sha: H1, conclusion: "success", link: L("ci70") }, codex: { sha: H1, state: "success", link: L("cx70") },
        floorGuard: { sha: H1, exit: 0, link: L("fg70") } },
      { number: 71, headSha: H2, ci: { sha: H2, conclusion: "success", link: L("ci71") }, codex: { sha: H2, state: "success", link: L("cx71") },
        floorGuard: { sha: H2, exit: 0, link: L("fg71") } },
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

test("AT3: floor guard exit 2, exit 1 with open hits, a disposition on another SHA, or a self-disposed Keep all pause", () => {
  const cases = [
    [(pr) => { pr.floorGuard.exit = 2; }, /floor guard exit 2 \(could not run is never clean\)/],
    [(pr) => { Object.assign(pr.floorGuard, { exit: 1, hits: ["skip-added:a.test.ts:3"] }); }, /without a valid disposition: skip-added/],
    [(pr) => { Object.assign(pr.floorGuard, { exit: 1, hits: ["h1"], dispositions: [{ hit: "h1", kind: "keep", source: "codex", sha: H2, link: L("d") }] }); }, /without a valid disposition: h1/],
    [(pr) => { Object.assign(pr.floorGuard, { exit: 1, hits: ["h1"], dispositions: [{ hit: "h1", kind: "keep", source: "builder", sha: H1, link: L("d") }] }); }, /without a valid disposition: h1/],
    [(pr) => { pr.floorGuard.sha = H2; }, /floor-guard result is not for head/],
    [(pr) => { delete pr.floorGuard.link; }, /floor-guard result has no link/],
  ];
  for (const [mut, re] of cases) {
    const ev = complete();
    mut(ev.mergedPrs[0]);
    const r = evaluateGate(ev);
    assert.equal(r.decision, "paused");
    assert.match(r.missing.join("\n"), re);
  }
});

test("AT4: hits disposed by a Codex Keep or a KK escalation on the same SHA count as clean", () => {
  const ev = complete();
  Object.assign(ev.mergedPrs[0].floorGuard, { exit: 1, hits: ["h1", "h2"], dispositions: [
    { hit: "h1", kind: "keep", source: "codex", sha: H1, link: L("d1") },
    { hit: "h2", kind: "escalate", source: "kk", sha: H1.slice(0, 7), link: L("d2") },
  ] });
  assert.equal(evaluateGate(ev).decision, "approve");
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
  for (const link of ["fg70", "fg71", "pr-m21", "ci70", "cx70", "ci71", "cx71", "sc1", "crit1", "kk-query", "DEVOS-9"]) {
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
  for (const args of [[], [path.join(dir, "nope.json")], [path.join(dir, "bad.json")], [path.join(dir, "g5.json")]]) {
    const p = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    assert.equal(p.status, 2, `args ${args}: ${p.stdout}${p.stderr}`);
    assert.match(p.stderr, /could not run/);
  }
});

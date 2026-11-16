// DEVOS-239 (GI-1e, docs/modules/GI-1e.md): KK's recorded answers to escalated floor-guard hits: one record shape
// for the Release path, ci-gate and the gate evaluator, parsed only from KK's own comments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { answersFor, isRunnerText, kkKeepProblem, parseKkAnswers } from "../release/kk-answers.mjs";
import { floorGuardProblems } from "../gates/evaluate-gate.mjs";

const SHA = "a".repeat(40);
const LINK = "https://linear.app/kishoremb/issue/DEVOS-200#comment-abc";
const H = { id: "fg-9a5389ff38", rule: "ci-step-changed", file: ".github/workflows/release images.yml", line: 0, text: "job scan: step gitleaks changed" };
const H2 = { id: "fg-0123456789", rule: "gitleaksignore-added", file: ".gitleaksignore", line: 3, text: "abc:rule:1" };

test("K1 parses one record per marker line, bound to id, file:line (spaces allowed) and the full SHA", () => {
  const body = `Keep both, they are fine.\nFLOOR-GUARD KK KEEP ${H2.id} ${H2.file}:${H2.line} ${SHA}\r\n  FLOOR-GUARD KK RESTORE fg-1111111111 src/a b.ts:12 ${SHA}  `;
  const { records, unreadable } = parseKkAnswers([{ body, link: LINK }]);
  assert.deepEqual(unreadable, []);
  assert.deepEqual(records, [
    { hit: H2.id, file: ".gitleaksignore", line: 3, sha: SHA, decision: "keep", link: LINK },
    { hit: "fg-1111111111", file: "src/a b.ts", line: 12, sha: SHA, decision: "restore", link: LINK },
  ]);
});

test("K2 never from a runner, never without an https link, never from a malformed line", () => {
  const line = `FLOOR-GUARD KK KEEP ${H2.id} ${H2.file}:${H2.line} ${SHA}`;
  for (const c of [
    { body: `[runner] ${line}`, link: LINK },
    { body: `  \n[runner B] note\n${line}`, link: LINK },
    { body: line, link: "http://linear.app/x" },
    { body: line },
    null,
    "text",
  ]) assert.deepEqual(parseKkAnswers([c]).records, [], JSON.stringify(c));
  assert.equal(isRunnerText("[runner] x"), true);
  assert.equal(isRunnerText("ok [runner]"), false);
  for (const bad of [
    `FLOOR-GUARD KK KEEP ${H2.id} ${H2.file}:${H2.line} ${SHA.slice(0, 7)}`, // short SHA
    `FLOOR-GUARD KK KEEP ${H2.id} ${H2.file} ${SHA}`, // no line
    `FLOOR-GUARD KK KEEP ${H2.id} ${H2.file}:${H2.line} ${SHA} because`, // text after the SHA
    `FLOOR-GUARD KK keep ${H2.id} ${H2.file}:${H2.line} ${SHA}`, // lower-case decision
    `FLOOR-GUARD KK ALLOW ${H2.id} ${H2.file}:${H2.line} ${SHA}`, // unknown decision
    `FLOOR-GUARD KK KEEP fg-XYZ ${H2.file}:${H2.line} ${SHA}`, // bad id
  ]) {
    const r = parseKkAnswers([{ body: bad, link: LINK }]);
    assert.deepEqual(r.records, [], bad);
    assert.equal(r.unreadable.length, 1, bad);
  }
  assert.deepEqual(parseKkAnswers(undefined), { records: [], unreadable: [] });
});

test("K3 exactly one keep for the occurrence and SHA clears; none, two, restore or a missing link do not", () => {
  const rec = { hit: H.id, file: H.file, line: H.line, sha: SHA, decision: "keep", link: LINK };
  assert.equal(kkKeepProblem([rec], H, SHA), null);
  assert.match(kkKeepProblem([], H, SHA), /no KK answer/);
  assert.match(kkKeepProblem([{ ...rec, sha: "b".repeat(40) }], H, SHA), /no KK answer/);
  assert.match(kkKeepProblem([{ ...rec, line: 1 }], H, SHA), /no KK answer/);
  assert.match(kkKeepProblem([{ ...rec, line: "0" }], H, SHA), /no KK answer/);
  assert.match(kkKeepProblem([rec, rec], H, SHA), /2 answers/);
  assert.match(kkKeepProblem([{ ...rec, decision: "restore" }], H, SHA), /restore, not keep/);
  assert.match(kkKeepProblem([{ ...rec, link: "" }], H, SHA), /no link/);
  assert.equal(answersFor([rec, null, "x", { ...rec, hit: "fg-0000000000" }], H, SHA).length, 1);
  assert.match(kkKeepProblem(null, H, SHA), /no KK answer/);
});

test("K4 a parsed record is the gate evaluator's kkResolutions shape: it clears the same KK-only hit there", () => {
  const { records } = parseKkAnswers([{ body: `FLOOR-GUARD KK KEEP ${H2.id} ${H2.file}:${H2.line} ${SHA}`, link: LINK }]);
  const fg = { report: { sha: SHA, exit: 1, hits: [H2] }, link: "https://github.com/x/y/actions/runs/1", kkResolutions: records };
  assert.deepEqual(floorGuardProblems(fg, SHA), []);
  assert.match(floorGuardProblems({ ...fg, kkResolutions: [] }, SHA).join(";"), /needs KK's recorded answer/);
  const restore = parseKkAnswers([{ body: `FLOOR-GUARD KK RESTORE ${H2.id} ${H2.file}:${H2.line} ${SHA}`, link: LINK }]).records;
  assert.match(floorGuardProblems({ ...fg, kkResolutions: restore }, SHA).join(";"), /not keep \(restore\)/);
});

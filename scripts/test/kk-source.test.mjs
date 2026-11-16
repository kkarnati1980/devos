// DEVOS-239 part b (GI-1e, docs/modules/GI-1e.md): KK's answers are read from his own Linear comment on the PR's
// issue; ci-gate reads them from the file the new workflow step writes; every failure yields no answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueIdsFor, isEntry, kkAnswersForPr, readKkComments, main, LINEAR_ENDPOINT, KEY_ENV, KK_LINEAR_USER_ID, MAX_ISSUES, MAX_RECORDS } from "../release/kk-source.mjs";
import { loadKkAnswers, KK_ANSWERS_FILE } from "../ci/ci-gate.mjs";
import { kkKeepProblem } from "../release/kk-answers.mjs";

const SHA = "b".repeat(40);
const KEY = "test-linear-key-not-real";
const HIT = { id: "fg-9a5389ff38", rule: "ci-step-changed", file: ".github/workflows/release-images.yml", line: 0 };
const KEEP = `FLOOR-GUARD KK KEEP ${HIT.id} ${HIT.file}:0 ${SHA}`;
const URL1 = "https://linear.app/kishoremb/issue/DEVOS-200#comment-1";
const node = (body, extra = {}) => ({ body, url: URL1, botActor: null, user: { id: KK_LINEAR_USER_ID }, ...extra });
const page = (nodes, next = null) => ({ data: { issue: { identifier: "DEVOS-200", comments: { nodes, pageInfo: { hasNextPage: !!next, endCursor: next } } } } });
const res = (status, json) => ({ status, json: async () => json });
const noSleep = async () => {};

/** A fake fetch that serves `responses` in order and records each call (url, headers, variables). */
function fake(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, vars: JSON.parse(init.body).variables, hasSignal: !!init.signal });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    if (!r) throw new Error("no more responses");
    return r;
  };
  return { fetchImpl, calls };
}

test("K5 the PR's issues come from its branch and Fixes/Closes/Resolves lines, unique, capped", () => {
  assert.deepEqual(issueIdsFor({ branch: "kishore/devos-200-s4-t2", body: "x\nFixes DEVOS-200\ncloses devos-17\nResolves DEVOS-9 and more" }), ["DEVOS-200", "DEVOS-17", "DEVOS-9"]);
  assert.deepEqual(issueIdsFor({ branch: "kishore/devos-200", body: null }), ["DEVOS-200"]);
  assert.deepEqual(issueIdsFor({ branch: "feature/x", body: "see DEVOS-5 (not a Fixes line)\n  Fixes  DEVOS-0" }), []);
  assert.deepEqual(issueIdsFor({ branch: "kishore/devos-0123-x" }), [], "no leading zero");
  assert.equal(issueIdsFor({ body: "Fixes DEVOS-1\nFixes DEVOS-2\nFixes DEVOS-3\nFixes DEVOS-4" }).length, MAX_ISSUES);
  assert.deepEqual(issueIdsFor(), []);
});

test("K6 reads KK's comments only from api.linear.app with the key, a timeout, and pages; drops runner, bot, user-less and other users' ones", async () => {
  const f = fake([
    res(200, page([node(KEEP), node(`[runner] ${KEEP}`), node(KEEP, { botActor: { id: "b" } }), node(KEEP, { user: null }), node(KEEP, { user: { id: "someone-else" } })], "c1")),
    res(200, page([node(KEEP, { url: "http://linear.app/x" }), node(KEEP, { url: "https://evil.example/x" }), node("plain note")])),
  ]);
  const out = await readKkComments({ ids: ["DEVOS-200"], key: ` ${KEY} `, fetchImpl: f.fetchImpl, sleep: noSleep });
  assert.deepEqual(out, [{ body: KEEP, link: URL1 }, { body: "plain note", link: URL1 }]);
  assert.equal(f.calls.length, 2);
  for (const c of f.calls) {
    assert.equal(c.url, LINEAR_ENDPOINT);
    assert.equal(c.headers.authorization, KEY);
    assert.equal(c.hasSignal, true);
  }
  assert.deepEqual(f.calls.map((c) => c.vars), [{ id: "DEVOS-200", after: null }, { id: "DEVOS-200", after: "c1" }]);
});

test("K7 a read is retried on 5xx, 429 and network errors only; other failures throw without the key", async () => {
  const ok = fake([res(502, {}), res(429, {}), res(200, page([node(KEEP)]))]);
  assert.equal((await readKkComments({ ids: ["DEVOS-200"], key: KEY, fetchImpl: ok.fetchImpl, sleep: noSleep })).length, 1);
  const timedOut = Object.assign(new Error("t"), { name: "TimeoutError" });
  const to = fake([timedOut, res(200, page([node(KEEP)]))]);
  assert.equal((await readKkComments({ ids: ["DEVOS-200"], key: KEY, fetchImpl: to.fetchImpl, sleep: noSleep })).length, 1, "a timed-out read is retried");
  await assert.rejects(readKkComments({ ids: ["DEVOS-200"], key: KEY, fetchImpl: fake([timedOut, timedOut, timedOut]).fetchImpl, sleep: noSleep }), /timed out/);
  for (const [name, responses] of [
    ["401", [res(401, {})]],
    ["graphql errors", [res(200, { errors: [{ message: `bad key ${KEY}` }] })]],
    ["no issue", [res(200, { data: { issue: null } })]],
    ["three 503s", [res(503, {}), res(503, {}), res(503, {})]],
    ["network", [new Error("x"), new Error("x"), new Error("x")]],
    ["too many pages", Array.from({ length: 6 }, (_, i) => res(200, page([node("n")], `c${i}`)))],
    ["page without a cursor", [res(200, { data: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } })]],
  ]) {
    const f = fake(responses);
    await assert.rejects(readKkComments({ ids: ["DEVOS-200"], key: KEY, fetchImpl: f.fetchImpl, sleep: noSleep }), (e) => !String(e.message).includes(KEY), name);
  }
  await assert.rejects(readKkComments({ ids: ["DEVOS-200"], key: "", fetchImpl: fake([]).fetchImpl }), /LINEAR_READ_KEY/);
  let t = 0;
  const slow = fake([res(503, {}), res(503, {}), res(200, page([node(KEEP)]))]);
  await assert.rejects(readKkComments({ ids: ["DEVOS-200"], key: KEY, fetchImpl: slow.fetchImpl, sleep: async () => { t += 40_000; }, now: () => t }), /time allowed/, "the whole read has a deadline");
});

test("K8 kkAnswersForPr: KK's keep becomes a record that clears the hit; every failure gives no records and an error", async () => {
  const f = fake([res(200, page([node(`ok\n${KEEP}`), node(`FLOOR-GUARD KK KEEP ${HIT.id} oops`)]))]);
  const r = await kkAnswersForPr({ branch: "kishore/devos-200-x", body: "", key: KEY, fetchImpl: f.fetchImpl, sleep: noSleep });
  assert.equal(r.error, null);
  assert.deepEqual(r.issues, ["DEVOS-200"]);
  assert.deepEqual(r.records, [{ hit: HIT.id, file: HIT.file, line: 0, sha: SHA, decision: "keep", link: URL1 }]);
  assert.equal(r.unreadable.length, 1);
  assert.equal(kkKeepProblem(r.records, HIT, SHA), null);
  assert.match(kkKeepProblem(r.records, HIT, "c".repeat(40)), /no KK answer/, "bound to the SHA");
  for (const [name, args] of [
    ["no key", { branch: "kishore/devos-200-x", key: undefined, fetchImpl: fake([]).fetchImpl }],
    ["no issue", { branch: "main", body: "", key: KEY, fetchImpl: fake([]).fetchImpl }],
    ["Linear down", { branch: "kishore/devos-200-x", key: KEY, fetchImpl: fake([res(500, {}), res(500, {}), res(500, {})]).fetchImpl }],
    ["runner-only comments", { branch: "kishore/devos-200-x", key: KEY, fetchImpl: fake([res(200, page([node(`[runner] ${KEEP}`)]))]).fetchImpl }],
  ]) {
    const x = await kkAnswersForPr({ ...args, sleep: noSleep });
    assert.deepEqual(x.records, [], name);
    if (name !== "runner-only comments") assert.ok(x.error, name);
    assert.ok(!JSON.stringify(x).includes(KEY), name);
  }
});

test("K9 the CLI writes the answers file from the event, logs no key, and exits 0 even when Linear fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kk-source-"));
  const event = join(dir, "event.json");
  writeFileSync(event, JSON.stringify({ pull_request: { head: { ref: "kishore/devos-200-x" }, body: "Fixes DEVOS-200" } }));
  const out = join(dir, "sub", KK_ANSWERS_FILE);
  const logs = [];
  const f = fake([res(200, page([node(KEEP)]))]);
  assert.equal(await main(["--event", event, "--out", out], { env: { [KEY_ENV]: KEY }, log: (l) => logs.push(l), fetchImpl: f.fetchImpl, sleep: noSleep }), 0);
  const written = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(written.records.length, 1);
  assert.equal(typeof written.unreadable, "number", "only a count of unreadable lines goes into the job output");
  assert.equal(loadKkAnswers(out).records.length, 1, "ci-gate reads what the step writes");
  const many = Array.from({ length: MAX_RECORDS + 1 }, (_, i) => `FLOOR-GUARD KK KEEP ${HIT.id} f${i}.ts:1 ${SHA}`).join("\n");
  assert.equal(await main(["--event", event, "--out", out], { env: { [KEY_ENV]: KEY }, log: (l) => logs.push(l), fetchImpl: fake([res(200, page([node(many)]))]).fetchImpl, sleep: noSleep }), 0);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")).records, [], "too many records: none (fail closed)");
  const down = fake([new Error("x"), new Error("x"), new Error("x")]);
  assert.equal(await main(["--event", event, "--out", out], { env: { [KEY_ENV]: KEY }, log: (l) => logs.push(l), fetchImpl: down.fetchImpl, sleep: noSleep }), 0);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")).records, []);
  assert.equal(await main(["--event", join(dir, "missing.json"), "--out", out], { env: {}, log: (l) => logs.push(l) }), 0);
  assert.equal(await main(["--event", event], { env: {}, log: (l) => logs.push(l) }), 2);
  assert.ok(logs.every((l) => !l.includes(KEY)), "the key is never logged");
});

test("K10 ci-gate's loadKkAnswers uses only a well-formed file; anything else gives no records", () => {
  const dir = mkdtempSync(join(tmpdir(), "kk-load-"));
  const p = join(dir, KK_ANSWERS_FILE);
  const rec = { hit: HIT.id, file: HIT.file, line: 0, sha: SHA, decision: "keep", link: URL1 };
  writeFileSync(p, JSON.stringify({ records: [rec], error: null }));
  assert.deepEqual(loadKkAnswers(p).records, [rec]);
  assert.deepEqual(loadKkAnswers("").records, [], "no RUNNER_TEMP");
  assert.deepEqual(loadKkAnswers(join(dir, "none.json")).records, [], "missing file");
  for (const bad of ["not json", "{}", JSON.stringify({ records: "x" }),
    ...[{ line: -1 }, { line: "0" }, { sha: "abc" }, { decision: "Keep" }, { link: "http://x" }, { hit: "fg-1" }, { file: "" }].map((o) => JSON.stringify({ records: [rec, { ...rec, ...o }] }))]) {
    writeFileSync(p, bad);
    assert.deepEqual(loadKkAnswers(p).records, [], bad);
  }
});

test("K12 ci-gate.yml reads the answers in a base-only kk-answers job that alone gets the key; ci-gate hands them over before the swap", async () => {
  const { parse } = await import("yaml");
  const { spawnSync } = await import("node:child_process");
  const { cpSync, existsSync } = await import("node:fs");
  const wf = parse(readFileSync(".github/workflows/ci-gate.yml", "utf8"));
  const job = wf.jobs["kk-answers"];
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.equal(job.outputs.answers, "${{ steps.read.outputs.answers }}");
  const co = job.steps.filter((s) => /^actions\/checkout@/.test(s.uses ?? ""));
  assert.equal(co.length, 1);
  assert.deepEqual(co[0].with, { ref: "${{ github.event.pull_request.base.sha }}", "sparse-checkout": "scripts/release", "persist-credentials": false }, "only the base");
  assert.ok(!job.steps.some((s) => /\b(pnpm|npm|yarn)\b/.test(`${s.run ?? ""} ${s.uses ?? ""}`)), "no install: nothing from the head or a lockfile runs");
  const step = job.steps.find((s) => s.id === "read");
  assert.deepEqual(step.env, { LINEAR_READ_KEY: "${{ secrets.LINEAR_READ_KEY }}" });
  const others = Object.entries(wf.jobs).flatMap(([n, j]) => j.steps.filter((s) => s !== step).map((s) => JSON.stringify(s)));
  assert.ok(others.every((t) => !t.includes("LINEAR_READ_KEY")), "no other step sees the key");
  const gate = wf.jobs["ci-gate"];
  assert.equal(gate.needs, "kk-answers");
  assert.equal(gate.if, "${{ !cancelled() }}", "a failed kk-answers job never skips the required gate");
  const hand = gate.steps.findIndex((s) => /^Hand KK's floor-guard answers to the gate/.test(s.name ?? ""));
  const stage = gate.steps.findIndex((s) => /^Use the base commit's copy of the gate's code/.test(s.name ?? ""));
  assert.ok(hand >= 0 && hand === stage - 1, "handed over right before the swap");
  assert.deepEqual(gate.steps[hand].env, { KK_ANSWERS: "${{ needs.kk-answers.outputs.answers }}", KK_RESULT: "${{ needs.kk-answers.result }}" });
  // Run both scripts as written: a base without the reader gives an empty answers output; with it (and no key) too.
  const ws = mkdtempSync(join(tmpdir(), "kk-step-")), rt = join(ws, "rt");
  const event = join(ws, "event.json"), ghOut = join(ws, "gh-output");
  writeFileSync(event, JSON.stringify({ pull_request: { head: { ref: "kishore/devos-200-x" }, body: "" } }));
  const env = { PATH: process.env.PATH, RUNNER_TEMP: rt, GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: ghOut, LINEAR_READ_KEY: "" };
  const { mkdirSync } = await import("node:fs");
  mkdirSync(rt, { recursive: true });
  const answersOut = () => { const l = readFileSync(ghOut, "utf8").trim().split("\n").at(-1); assert.match(l, /^answers=/); return l.slice(8); };
  const a = spawnSync("bash", ["-e", "-c", step.run], { cwd: ws, env, encoding: "utf8" });
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /no kk-source\.mjs; no KK answers are read/);
  assert.deepEqual(JSON.parse(answersOut()).records, []);
  for (const f of ["kk-source.mjs", "kk-answers.mjs"]) cpSync(join("scripts/release", f), join(ws, "scripts/release", f));
  const b = spawnSync("bash", ["-e", "-c", step.run], { cwd: ws, env, encoding: "utf8" });
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /none read: no Linear key/);
  const handed = answersOut();
  const c = spawnSync("bash", ["-e", "-c", gate.steps[hand].run], { cwd: ws, env: { ...env, KK_ANSWERS: handed, KK_RESULT: "success" }, encoding: "utf8" });
  assert.equal(c.status, 0, c.stderr);
  assert.ok(existsSync(join(rt, KK_ANSWERS_FILE)));
  assert.deepEqual(loadKkAnswers(join(rt, KK_ANSWERS_FILE)).records, []);
  const rec = { hit: HIT.id, file: HIT.file, line: 0, sha: SHA, decision: "keep", link: URL1 };
  const d = spawnSync("bash", ["-e", "-c", gate.steps[hand].run], { cwd: ws, env: { ...env, KK_ANSWERS: JSON.stringify({ records: [rec] }), KK_RESULT: "success" }, encoding: "utf8" });
  assert.equal(d.status, 0, d.stderr);
  assert.deepEqual(loadKkAnswers(join(rt, KK_ANSWERS_FILE)).records, [rec], "the gate reads what the job found");
  for (const result of ["failure", "skipped", "cancelled", ""]) {
    const e = spawnSync("bash", ["-e", "-c", gate.steps[hand].run], { cwd: ws, env: { ...env, KK_ANSWERS: JSON.stringify({ records: [rec] }), KK_RESULT: result }, encoding: "utf8" });
    assert.equal(e.status, 0, e.stderr);
    assert.deepEqual(loadKkAnswers(join(rt, KK_ANSWERS_FILE)).records, [], `kk-answers ${result || "(none)"}: no answers`);
  }
  assert.equal(isEntry(join(ws, "nope.mjs")), false);
});

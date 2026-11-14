// GI-1d (DEVOS-179, docs/modules/GI-1d.md): ci-gate passes a failed floor guard only under GI-1b's rules,
// using the Release path's own code (judgeFloorGuard, codexPass), never a copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchHistory, floorGuardDisposition, GateError, prFromEvent } from "../ci/ci-gate.mjs";
import { githubClient } from "../release/merge.mjs";
import { applyDispositions } from "../floor-guard/floor-guard.mjs";

const REPO = "kkarnati1980/devos";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const WATCHER = { login: "kkarnati1980" };
const SKIP = ["it", "skip"].join(".");
const HIT = { id: "fg-0123456789", rule: "test-skipped", file: "packages/x/test/a.test.ts", line: 2, text: `${SKIP}("a"` };
const KK_HIT = { id: "fg-9999999999", rule: "gitleaksignore-added", file: ".gitleaksignore", line: 1, text: "abc" };
const keep = (h) => ` FLOOR-GUARD KEEP ${h.id} ${h.file}:${h.line} the fixture is intentional`;
const passComment = (extra = "", { sha = HEAD, label = "PR7-r2", user = WATCHER } = {}) => ({
  user,
  created_at: "2026-11-14T10:01:00Z",
  updated_at: "2026-11-14T10:01:00Z",
  body: `### Codex review ${label} — **PASS**\n\n- **Commit:** \`${sha}\`\n- **Summary:** Looks right.${extra}\n\nMerge gate (D1).`,
});

function fake(over = {}) {
  const state = {
    pr: { number: 7, changed_files: 1, head: { sha: HEAD } },
    files: [{ filename: "packages/x/test/a.test.ts", status: "modified" }],
    comments: [passComment(keep(HIT))],
    statuses: [{ context: "codex-review", state: "success", description: "Codex PASS (PR7-r2)", creator: WATCHER, updated_at: "2026-11-14T10:00:00Z" }],
    ...over,
  };
  const fetchImpl = async (url) => {
    const p = url.replace("https://api.github.com", "");
    const page = Number(new URL(url).searchParams.get("page") || 1);
    const reply = (status, json) => ({ status, text: async () => JSON.stringify(json) });
    if (p === `/repos/${REPO}/pulls/7`) return reply(200, state.pr);
    if (p.startsWith(`/repos/${REPO}/pulls/7/files`)) return reply(200, state.files.slice((page - 1) * 100, page * 100));
    if (p.startsWith(`/repos/${REPO}/issues/7/comments`)) return reply(200, state.comments.slice((page - 1) * 100, page * 100));
    // DEVOS-212: as the real API: the list endpoint carries `creator`; the combined status does not.
    if (p.startsWith(`/repos/${REPO}/commits/${HEAD}/statuses`)) { const pg = Number(new URL(p, "https://x").searchParams.get("page") ?? 1); return reply(200, state.statuses.slice((pg - 1) * 100, pg * 100)); }
    if (p.startsWith(`/repos/${REPO}/commits/${HEAD}/status`)) return reply(200, { total_count: state.statuses.length, statuses: state.statuses.map(({ creator, ...rest }) => rest) });
    return reply(404, { message: "not found" });
  };
  return githubClient({ token: "t", fetchImpl, retries: 0, sleep: async () => {} });
}

const guard = (hits, { exit, sha } = {}) => {
  const calls = [];
  const fn = async ({ mainSha, sha: head }) => {
    calls.push(mainSha);
    return { report: { sha: sha ?? head, base: mainSha, exit: exit ?? (hits.length ? 1 : 0), hits }, applyDispositions };
  };
  fn.calls = calls;
  return fn;
};
const fgOnly = { state: "failure", failed: ["floor-guard=failure"], pending: [] };
const judge = (v, gh, guardReport, extra = {}) => floorGuardDisposition(v, { gh, repo: REPO, pr: "7", sha: HEAD, baseSha: BASE, guardReport, ...extra });

test("D1: only floor-guard failed and every hit has a valid Keep in the watcher's PASS → disposed; re-run uses the PR base", async () => {
  const g = guard([HIT]);
  const d = await judge(fgOnly, fake(), g);
  assert.deepEqual(d, { disposed: true, reasons: [] });
  assert.deepEqual(g.calls, [BASE]);
});

test("D2: any other failure, a pending check, a cancelled or timed-out floor guard is never judged", async () => {
  const g = guard([HIT]);
  for (const v of [
    { state: "failure", failed: ["floor-guard=failure", "build=failure"], pending: [] },
    { state: "failure", failed: ["build=failure"], pending: [] },
    { state: "failure", failed: ["floor-guard=failure"], pending: ["build"] },
    { state: "failure", failed: ["floor-guard=cancelled"], pending: [] },
    { state: "failure", failed: ["floor-guard=not-finished-in-time"], pending: [] },
    { state: "failure", failed: ["floor-guard=reported-by-more-than-one-workflow-run"], pending: [] },
  ]) {
    let loaded = false;
    assert.deepEqual(await judge(v, fake(), g, { release: async () => { loaded = true; throw new GateError("must not load"); } }), { disposed: false, reasons: [] });
    assert.equal(loaded, false, "the Release module is not loaded for another failure");
  }
  assert.equal(g.calls.length, 0, "the guard is not re-run");
});

test("D3: no PASS, a PASS from another account, for another PR, or a CHANGES_REQUESTED status → not disposed, never waits", async () => {
  const cases = [
    { statuses: [] },
    { statuses: [{ context: "codex-review", state: "success", description: "Codex PASS (PR7-r2)", creator: { login: "someone" } }] },
    { statuses: [{ context: "codex-review", state: "success", description: "Codex PASS (PR8-r2)", creator: WATCHER }] },
    { statuses: [{ context: "codex-review", state: "failure", description: "Codex CHANGES_REQUESTED (PR7-r2)", creator: WATCHER }] },
  ];
  for (const over of cases) {
    const d = await judge(fgOnly, fake(over), guard([HIT]));
    assert.equal(d.disposed, false);
    assert.ok(d.reasons.length > 0);
  }
});

test("D4: a missing Keep, a Keep in another SHA's comment, a KK-only hit, a clean or exit-2 re-run, or a report for another SHA → not disposed", async () => {
  const no = async (gh, g) => {
    const d = await judge(fgOnly, gh, g);
    assert.equal(d.disposed, false);
    assert.ok(d.reasons.length > 0);
    return d;
  };
  await no(fake({ comments: [passComment("")] }), guard([HIT]));
  await no(fake({ comments: [passComment(keep(HIT), { sha: BASE })] }), guard([HIT]));
  const kk = await no(fake({ comments: [passComment(keep(HIT) + keep(KK_HIT))] }), guard([HIT, KK_HIT]));
  assert.ok(kk.reasons.some((r) => /escalate to KK/.test(r)));
  await no(fake(), guard([]));
  await no(fake(), guard([], { exit: 2 }));
  await no(fake(), guard([HIT], { sha: BASE }));
});

test("D5: a guard-path change needs a CHANGE line and a decision note, as on the Release path", async () => {
  const files = [{ filename: "scripts/floor-guard/floor-guard.mjs", status: "modified" }];
  const d = await judge(fgOnly, fake({ files }), guard([HIT]));
  assert.equal(d.disposed, false);
  assert.ok(d.reasons.some((r) => /FLOOR-GUARD CHANGE scripts\/floor-guard\/floor-guard\.mjs/.test(r)));
  const ok = await judge(
    fgOnly,
    fake({ pr: { number: 7, changed_files: 2, head: { sha: HEAD } }, files: [...files, { filename: "docs/decisions/0099-x.md", status: "added" }], comments: [passComment(`${keep(HIT)} FLOOR-GUARD CHANGE scripts/floor-guard/floor-guard.mjs`)] }),
    guard([HIT]),
  );
  assert.deepEqual(ok, { disposed: true, reasons: [] });
});

test("D6: the PR's head moved, or the PR number or base SHA is missing → never disposed", async () => {
  const moved = await judge(fgOnly, fake({ pr: { number: 7, changed_files: 1, head: { sha: BASE } } }), guard([HIT]));
  assert.equal(moved.disposed, false);
  await assert.rejects(judge(fgOnly, fake(), guard([HIT]), { pr: null }), /pull request number/);
  await assert.rejects(judge(fgOnly, fake(), guard([HIT]), { baseSha: "main" }), /base SHA/);
});

test("D7: if the Release module cannot load, the gate errors (exit 2 path), never passes", async () => {
  await assert.rejects(judge(fgOnly, fake(), guard([HIT]), { release: async () => { throw new GateError("cannot load"); } }), /cannot load/);
});

test("D8: PR number and base SHA come from the event file; an unreadable file gives nulls (then an error)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gi1d-"));
  const f = join(dir, "event.json");
  writeFileSync(f, JSON.stringify({ pull_request: { number: 7, base: { sha: BASE } } }));
  assert.deepEqual(prFromEvent(f), { pr: 7, baseSha: BASE });
  assert.deepEqual(prFromEvent(join(dir, "missing.json")), { pr: null, baseSha: null });
});

test("D9: the history fetch passes the token only through git's environment, unshallows a shallow clone, and a failure errors", () => {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ args, env: opts.env });
    if (args[0] === "rev-parse") return { status: 0, stdout: "true\n" };
    return { status: 0, stdout: "" };
  };
  fetchHistory({ baseSha: BASE, sha: HEAD, token: "tok", run });
  const fetch = calls.find((c) => c.args[0] === "fetch");
  assert.deepEqual(fetch.args, ["fetch", "--quiet", "--no-tags", "--unshallow", "origin", BASE, HEAD]);
  assert.ok(!fetch.args.join(" ").includes("tok") && !fetch.args.join(" ").includes(Buffer.from("x-access-token:tok").toString("base64")));
  assert.equal(fetch.env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from("x-access-token:tok").toString("base64")}`);
  assert.throws(() => fetchHistory({ baseSha: BASE, sha: HEAD, token: "tok", run: (c, a) => (a[0] === "fetch" ? { status: 128 } : { status: 0, stdout: "false" }) }), /cannot fetch/);
});

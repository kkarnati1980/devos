// DEVOS-234 (M2.4-d3c part 1): fingerprint and inventory read for the AT13 probe CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeCredentialsUpdatedAt, probeFingerprint, readProbeInventory } from "../dist/provision-probe-cli-parts.js";

async function tree(files) {
  const root = await mkdtemp(join(tmpdir(), "probe-fp-"));
  for (const [p, body] of Object.entries(files)) {
    await mkdir(join(root, p, ".."), { recursive: true });
    await writeFile(join(root, p), body);
  }
  return root;
}

test("d3c: the fingerprint changes with provisioning code only, not with other API files", async () => {
  const base = {
    "packages/provision/dist/index.js": "a",
    "packages/isolation/dist/compose.js": "b",
    "apps/api/dist/provision-runtime.js": "c",
    "apps/api/dist/routes.js": "d",
  };
  const r1 = await tree(base);
  const r2 = await tree({ ...base, "apps/api/dist/routes.js": "changed" });
  const r3 = await tree({ ...base, "packages/isolation/dist/compose.js": "changed" });
  const r4 = await tree({ ...base, "apps/api/dist/provision-runtime.js": "changed" });
  const r5 = await tree({ ...base, "apps/api/dist/sub/provision-x.js": "nested", "packages/provision/dist/index.d.ts": "types", "packages/provision/dist/index.js.map": "map" });
  try {
    const f1 = await probeFingerprint(r1);
    assert.match(f1, /^[0-9a-f]{64}$/);
    assert.equal(await probeFingerprint(r2), f1, "an unrelated API file does not count");
    assert.notEqual(await probeFingerprint(r3), f1);
    assert.notEqual(await probeFingerprint(r4), f1);
    assert.equal(await probeFingerprint(r5), f1, "a nested API file and non-.js files do not count");
  } finally {
    for (const r of [r1, r2, r3, r4, r5]) await rm(r, { recursive: true, force: true });
  }
});

test("d3c: moving content between files changes the fingerprint; no files at all is an error", async () => {
  const a = await tree({ "packages/provision/dist/a.js": "xy", "packages/provision/dist/b.js": "" });
  const b = await tree({ "packages/provision/dist/a.js": "x", "packages/provision/dist/b.js": "y" });
  const empty = await tree({ "README.md": "x" });
  try {
    assert.notEqual(await probeFingerprint(a), await probeFingerprint(b));
    await assert.rejects(probeFingerprint(empty), /probe-fingerprint-empty/);
  } finally {
    for (const r of [a, b, empty]) await rm(r, { recursive: true, force: true });
  }
});

test("d3c: the inventory joins done steps to active resources; a lost row stays visible with an empty name", async () => {
  const seen = [];
  const db = {
    provisionStep: { findMany: async (q) => { seen.push(q.where); return [
      { key: "coolify_project", provider: "coolify", kind: "project", externalId: "p-1" },
      { key: "github_repo", provider: "github", kind: "repo", externalId: "42" },
      { key: "stack_preview", provider: "coolify", kind: "environment", externalId: null },
      { key: "github/core", provider: "github", kind: "core_commit", externalId: "c0ffee" },
      { key: "github/deploy_compose", provider: "github", kind: "deploy_compose", externalId: "d00d" },
      { key: "vault/app_secret/preview/db", provider: "vault", kind: "app_secret", externalId: "s-1" },
      { key: "vault/app_secret/live/db", provider: "vault", kind: "app_secret", externalId: null },
    ]; } },
    resource: { findMany: async (q) => { seen.push(q.where); return [
      { provider: "coolify", kind: "project", externalId: "p-1", name: "devos-probe-m24" },
      { provider: "github", kind: "repo", externalId: "42", name: "kkarnati1980/devos-probe-m24" },
      { provider: "github", kind: "repo", externalId: "99", name: "other" },
      { provider: "coolify", kind: "application", externalId: "p-1", name: "same id, other kind" },
    ]; } },
  };
  const txOpts = [];
  db.$transaction = async (fn, o) => { txOpts.push(o); return fn(db); };
  // The same pairs as @devos/provision's JOURNAL_ONLY_KINDS (its runner test pins that list).
  const journalOnly = (p, k) => [["github", "core_commit"], ["github", "deploy_compose"], ["vault", "app_secret"]].some(([a, b]) => a === p && b === k);
  const rows = await readProbeInventory(db, "proj-1", 1234, journalOnly);
  assert.deepEqual(txOpts, [{ timeout: 1234, maxWait: 1234 }], "one bounded transaction");
  assert.deepEqual(rows, [
    { key: "coolify_project", provider: "coolify", externalId: "p-1", name: "devos-probe-m24" },
    { key: "github_repo", provider: "github", externalId: "42", name: "kkarnati1980/devos-probe-m24" },
    { key: "stack_preview", provider: "coolify", externalId: "", name: "" },
    // AT13 part 8: journal-only steps have no resource row by design; their id is kept, a missing id is still a gap.
    { key: "github/core", provider: "github", externalId: "c0ffee", name: "(journal-only)" },
    { key: "github/deploy_compose", provider: "github", externalId: "d00d", name: "(journal-only)" },
    { key: "vault/app_secret/preview/db", provider: "vault", externalId: "s-1", name: "(journal-only)" },
    { key: "vault/app_secret/live/db", provider: "vault", externalId: "", name: "" },
  ]);
  assert.deepEqual(seen, [{ projectId: "proj-1", status: "done" }, { projectId: "proj-1", status: "active" }]);
});

import { probeCli, errorCode, safeDetail, offReasonFor, parseCommand } from "../dist/provision-probe-cli.js";
import { stepWiring } from "../dist/provision-probe-wiring.js";

const rec = (over = {}) => ({ cycle: 2, phase: "inventory1", at: "2026-11-16T00:00:00.000Z", fingerprint: "fp", ...over });
const logOf = (last) => ({ log: async () => ({ last: async () => last }), step: async () => { throw new Error("step deps must not be built"); } });

test("d3c-1: usage errors exit 2 and build nothing", async () => {
  for (const argv of [[], ["nope"], ["step", "extra"]]) {
    const r = await probeCli(argv, { log: async () => { throw new Error("built"); }, step: async () => { throw new Error("built"); } });
    assert.equal(r.code, 2);
    assert.equal(r.out.error, "usage");
  }
});

test("d3c-1: status is read-only and shows the newest phase, or idle", async () => {
  assert.deepEqual(await probeCli(["status"], logOf(null)), { code: 0, out: { command: "status", phase: "idle", cycle: 0 } });
  const r = await probeCli(["status"], logOf(rec()));
  assert.deepEqual(r, { code: 0, out: { command: "status", cycle: 2, phase: "inventory1", at: "2026-11-16T00:00:00.000Z" } });
  assert.ok(!("fingerprint" in r.out));
});

test("d3c-1: report is 3 with no cycle or a running one, 0 or 1 with the finished cycle's code", async () => {
  assert.equal((await probeCli(["report"], logOf(null))).out.code, "no-cycle");
  assert.equal((await probeCli(["report"], logOf(null))).code, 3);
  const running = await probeCli(["report"], logOf(rec({ phase: "purge", result: { ok: false, code: "inventory-differs" } })));
  assert.equal(running.code, 3);
  assert.equal(running.out.code, "in_progress");
  const ok = await probeCli(["report"], logOf(rec({ phase: "done", result: { ok: true, code: "pass" } })));
  assert.deepEqual([ok.code, ok.out.code], [0, "pass"]);
  const bad = await probeCli(["report"], logOf(rec({ phase: "done", result: { ok: false, code: "purge-permission", detail: "github_repo", cause: "x" } })));
  assert.deepEqual([bad.code, bad.out.code, bad.out.result.detail], [1, "purge-permission", "github_repo"]);
  // DEVOS-21 diagnostics: the earlier failure is printed too (same safe shape as detail), so one check line names both.
  assert.equal(bad.out.result.cause, "x");
  assert.equal(bad.out.result.causeDetail, undefined);
  const both = await probeCli(["report"], logOf(rec({ phase: "done", result: { ok: false, code: "purge-failed", detail: "purge-permission:github/repo", cause: "run1-failed", causeDetail: "provider_error" } })));
  assert.deepEqual([both.out.result.cause, both.out.result.causeDetail], ["run1-failed", "provider_error"]);
  const odd = await probeCli(["report"], logOf(rec({ phase: "done", result: { ok: false, code: "purge-failed", cause: "run1-failed", causeDetail: "token ghp_x leaked here" } })));
  assert.equal(odd.out.result.causeDetail, "probe-detail-hidden", "a cause detail outside our code shape is never printed");
});

test("DEVOS-21: step prints the earlier failure behind a failed purge", async () => {
  const records = [{ cycle: 1, phase: "purge", at: "2026-11-16T00:00:00.000Z", fingerprint: "fp", result: { ok: false, code: "run1-failed", detail: "provider_error" } }];
  const deps = {
    offReason: async () => null, last: async () => records.at(-1), record: async (r) => { records.push(r); },
    provisionOnce: async () => "done", inventory: async () => [], liveAsserts: async () => [], purge: async () => ({ error: "purge-permission:github/repo" }),
    fingerprint: "fp", now: () => new Date("2026-11-16T00:01:00Z"),
  };
  const r = await probeCli(["step"], { log: async () => { throw new Error("not needed"); }, step: async () => deps });
  assert.deepEqual([r.code, r.out.code, r.out.detail, r.out.cause, r.out.causeDetail], [1, "purge-failed", "purge-permission:github/repo", "run1-failed", "provider_error"]);
});

test("d3c-1: step runs one probeStep with the built deps and returns its exit", async () => {
  const records = [];
  const deps = {
    offReason: async () => null, last: async () => records.at(-1) ?? null, record: async (r) => { records.push(r); },
    provisionOnce: async () => "done", inventory: async () => [], liveAsserts: async () => [], purge: async () => "done",
    fingerprint: "fp", now: () => new Date("2026-11-16T00:00:00Z"),
  };
  const r = await probeCli(["step"], { log: async () => { throw new Error("not needed"); }, step: async () => deps });
  assert.deepEqual([r.code, r.out.phase, r.out.code], [3, "run1", "in_progress"]);
  assert.equal(records.length, 1);
  const off = await probeCli(["step"], { log: async () => ({}), step: async () => ({ ...deps, offReason: async () => "provision-sweep-off" }) });
  assert.deepEqual([off.code, off.out.code, off.out.detail], [3, "skipped", "provision-sweep-off"]);
});

test("d3c-1: a thrown error becomes exit 1 with a fixed code; provider or DB text is never printed", async () => {
  const boom = (m) => ({ log: async () => ({ last: async () => { throw new Error(m); } }), step: async () => { throw new Error(m); } });
  const a = await probeCli(["status"], boom("probe-phase-unreadable"));
  assert.deepEqual(a, { code: 1, out: { command: "status", error: "probe-phase-unreadable" } });
  const b = await probeCli(["step"], boom("connect ECONNREFUSED postgres://user:pw@db/devos"));
  assert.deepEqual(b, { code: 1, out: { command: "step", error: "probe-error" } });
  assert.equal(errorCode(new Error("probe-slug-taken")), "probe-slug-taken");
  assert.equal(errorCode("probe-x"), "probe-error");
});

test("d3c-1 pre-review 1: skipped while a provider token is missing or the ready check throws; ready otherwise", async () => {
  assert.equal(await offReasonFor({ off: "provision-vault-not-configured" }), "provision-vault-not-configured");
  assert.equal(await offReasonFor({ provisioner: { ready: async () => "provision-github-token-not-set" } }), "provision-github-token-not-set");
  assert.equal(await offReasonFor({ provisioner: { ready: async () => { throw new Error("db down"); } } }), "provision-ready-check-failed");
  assert.equal(await offReasonFor({ provisioner: { ready: async () => null } }), null);
});

test("d3c-1 pre-review 2: a detail prints only in code or step-key shape", async () => {
  assert.equal(safeDetail("github_repo"), "github_repo");
  assert.equal(safeDetail("missing:stack_preview"), "missing:stack_preview");
  assert.equal(safeDetail(undefined), undefined);
  assert.equal(safeDetail("Bad credentials for https://user:pw@api"), "probe-detail-hidden");
  assert.equal(safeDetail({ x: 1 }), "probe-detail-hidden");
  const r = await probeCli(["report"], logOf(rec({ phase: "done", result: { ok: false, code: "run1-failed", detail: "token ghp_x is invalid" } })));
  assert.equal(r.out.result.detail, "probe-detail-hidden");
});

test("d3c-1 pre-review 4: arguments are checked first", () => {
  assert.equal(parseCommand(["step"]), "step");
  assert.equal(parseCommand(["status", "x"]), null);
  assert.equal(parseCommand([]), null);
});

test("d3c-1 pre-review 5: the probe's wiring is off without a policy key or with a malformed vault key", async () => {
  assert.deepEqual(await stepWiring({}, "postgres://x", {}, 1000), { off: "policy-not-configured" });
  assert.deepEqual(await stepWiring({}, "postgres://x", { DEVOS_POLICY_HMAC_KEY: "k".repeat(32), DEVOS_VAULT_KEY: "not-a-key" }, 1000), { off: "provision-vault-not-configured" });
});

test("DEVOS-21: probeCredentialsUpdatedAt is the newest update of the GitHub and Coolify tokens only, or null", async () => {
  const meta = (name, updatedAt) => ({ name, set: updatedAt !== null, updatedAt });
  const v = (rows) => ({ list: async () => rows });
  assert.equal(await probeCredentialsUpdatedAt(v([meta("github_token", null), meta("coolify_api_token", null)])), null);
  assert.equal(await probeCredentialsUpdatedAt(v([
    meta("github_token", "2026-11-24T07:11:00.000Z"),
    meta("coolify_api_token", "2026-11-20T00:00:00.000Z"),
    meta("anthropic_api_key", "2026-11-25T00:00:00.000Z"),
  ])), "2026-11-24T07:11:00.000Z", "another secret never counts");
  assert.equal(await probeCredentialsUpdatedAt(v([meta("github_token", "2026-11-01T00:00:00.000Z"), meta("coolify_api_token", "2026-11-02T00:00:00.000Z")])), "2026-11-02T00:00:00.000Z");
  assert.equal(await probeCredentialsUpdatedAt(v([{ name: "github_token", set: false, updatedAt: "2026-11-02T00:00:00.000Z" }])), null, "an unset row is ignored");
});

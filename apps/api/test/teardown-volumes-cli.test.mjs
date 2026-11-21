// DEVOS-236 (docs/modules/M2.5.md "DEVOS-236 decisions"): the read-only purged-application list for the orphan-volume check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { purgedAppsCli, prismaDeletedApps, MAX_ROWS, SCAN_UUID_RE } from "../dist/teardown-volumes-cli.js";

const reader = (ids, live = []) => async () => ({ deletedApplicationIds: async () => ids, liveApplicationIds: async () => live });

test("DEVOS-236: lists the deleted application uuids, sorted and without duplicates", async () => {
  const r = await purgedAppsCli(["purged-apps"], reader(["zz9app0001", "ab12cd34ef", "zz9app0001"]));
  assert.equal(r.code, 0);
  assert.deepEqual(r.out, { uuids: ["ab12cd34ef", "zz9app0001"], live: [], invalid: 0 });
});

test("DEVOS-236: an id the check cannot match safely is counted, never printed", async () => {
  const r = await purgedAppsCli(["purged-apps"], reader(["ok12345678", "short", "has space x", "a;rm -rf /", "x".repeat(65)]));
  assert.equal(r.code, 0);
  assert.deepEqual(r.out, { uuids: ["ok12345678"], live: [], invalid: 4 });
  assert.ok(!JSON.stringify(r.out).includes("rm -rf"));
  assert.ok(SCAN_UUID_RE.test("abc-123-def") && !SCAN_UUID_RE.test("abc_1234567"));
});

test("DEVOS-236: a read error is a fixed code, never the database message", async () => {
  const r = await purgedAppsCli(["purged-apps"], async () => ({ deletedApplicationIds: async () => { throw new Error("password=hunter2 connection refused"); }, liveApplicationIds: async () => [] }));
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, { error: "teardown-volumes-read-failed" });
  const r2 = await purgedAppsCli(["purged-apps"], async () => ({ deletedApplicationIds: async () => [], liveApplicationIds: async () => { throw new Error("password=hunter2"); } }));
  assert.equal(r2.code, 1);
  assert.deepEqual(r2.out, { error: "teardown-volumes-read-failed" });
});

test("DEVOS-236: more rows than the limit fail instead of being cut silently", async () => {
  const ids = Array.from({ length: MAX_ROWS + 1 }, (_, i) => `app${String(i).padStart(8, "0")}`);
  const r = await purgedAppsCli(["purged-apps"], reader(ids));
  assert.equal(r.code, 1);
  assert.equal(r.out.error, "teardown-volumes-too-many-rows");
});

test("DEVOS-236: wrong arguments are usage (exit 2) and read nothing", async () => {
  let read = false;
  for (const argv of [[], ["purge"], ["purged-apps", "x"]]) {
    const r = await purgedAppsCli(argv, async () => { read = true; return { deletedApplicationIds: async () => [], liveApplicationIds: async () => [] }; });
    assert.equal(r.code, 2);
  }
  assert.equal(read, false);
});

test("DEVOS-236: the Prisma reader asks only for deleted Coolify application rows, read-only, with a limit and timeout", async () => {
  const calls = [];
  const tx = { resource: { findMany: async (q) => { calls.push(q); return [{ externalId: "abcd1234ef" }]; } } };
  const db = { $transaction: async (fn, opts) => { calls.push(opts); return fn(tx); } };
  const ids = await prismaDeletedApps(db, 10_000).deletedApplicationIds(7);
  assert.deepEqual(ids, ["abcd1234ef"]);
  assert.deepEqual(calls[0], { timeout: 10_000, maxWait: 10_000 });
  assert.deepEqual(calls[1].where, { provider: "coolify", kind: "application", status: "deleted" });
  assert.equal(calls[1].take, 7);
  // Codex PR209-r12: the live read asks for the same rows that are not deleted.
  const live = await prismaDeletedApps(db, 10_000).liveApplicationIds(9);
  assert.deepEqual(live, ["abcd1234ef"]);
  assert.deepEqual(calls[2], { timeout: 10_000, maxWait: 10_000 });
  assert.deepEqual(calls[3].where, { provider: "coolify", kind: "application", status: { not: "deleted" } });
  assert.equal(calls[3].take, 9);
  assert.deepEqual(Object.keys(tx.resource), ["findMany"]);
});

test("DEVOS-236: Codex PR209-r12 — live application uuids are listed; a uuid both deleted and live counts as live; too many live rows fail", async () => {
  const r = await purgedAppsCli(["purged-apps"], reader(["app12345", "both1234"], ["app12345-prod", "both1234", "bad id", "app12345-prod"]));
  assert.equal(r.code, 0);
  assert.deepEqual(r.out, { uuids: ["app12345"], live: ["app12345-prod", "both1234"], invalid: 0 });
  const many = Array.from({ length: MAX_ROWS + 1 }, (_, i) => `live${String(i).padStart(8, "0")}`);
  const r2 = await purgedAppsCli(["purged-apps"], reader([], many));
  assert.equal(r2.code, 1);
  assert.equal(r2.out.error, "teardown-volumes-too-many-rows");
});

// M2.6-b2b2 (DEVOS-247) AT7 on Postgres (pre-review 1): a teardown's Linear write waits for the sync's per-project
// advisory lock, runs once it is free, and a lock still held after the wait is "busy" (retryable), not any other error.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb } from "@devos/db";
import { withSyncLock, syncProjectLocked } from "../dist/index.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

function hold(id) {
  let release; const held = new Promise((r) => { release = r; });
  let locked; const isLocked = new Promise((r) => { locked = r; });
  const done = db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('devos:linear-sync'), hashtext($1))) AS l`, id);
    locked(); await held;
  }, { timeout: 30_000 });
  return { isLocked, release: () => { release(); return done; } };
}

test("AT7 on Postgres: a free lock runs the write", async () => {
  let ran = false;
  assert.equal(await withSyncLock(db, randomUUID(), async () => { ran = true; return 7; }, { waitMs: 2000, txMs: 10_000 }), 7);
  assert.equal(ran, true);
});

test("AT7 on Postgres: a held lock is waited for, then the write runs", async () => {
  const id = randomUUID(); const h = hold(id); await h.isLocked;
  let ran = false;
  const p = withSyncLock(db, id, async () => { ran = true; }, { waitMs: 5000, txMs: 10_000 });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(ran, false, "the write waits for the holder");
  await h.release(); await p;
  assert.equal(ran, true);
});

test("AT7 on Postgres: a lock still held after the wait is linear-sync-lock-busy and the write never runs", async () => {
  const id = randomUUID(); const h = hold(id); await h.isLocked;
  let ran = false;
  await assert.rejects(withSyncLock(db, id, async () => { ran = true; }, { waitMs: 300, txMs: 10_000 }), /linear-sync-lock-busy/);
  await h.release();
  assert.equal(ran, false);
});

test("AT7 on Postgres: it is the sync's own lock: a sync of the project is skipped while a teardown write holds it", async () => {
  const id = randomUUID();
  let release; const held = new Promise((r) => { release = r; });
  let inside; const isInside = new Promise((r) => { inside = r; });
  const w = withSyncLock(db, id, async () => { inside(); await held; }, { waitMs: 2000, txMs: 10_000 });
  await isInside;
  const r = await syncProjectLocked(db, id, async () => assert.fail("must not run"));
  assert.deepEqual(r, { skipped: true });
  release(); await w;
});

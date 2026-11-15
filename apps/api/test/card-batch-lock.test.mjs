// CR-b2b (DEVOS-215, docs/modules/ADR-0012.md): PrismaQueueStore.withBatchLock over a stub lock connection — the lock
// is released and the connection ended when `fn` throws (rule 10: the next flush can lock), `fn` never runs when the
// lock is taken, and every lock-connection call is bounded on the client (ADR-0011 timeouts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrismaQueueStore } from "../dist/card-batch-store.js";

const noDb = { $transaction: async () => { throw new Error("no db in this test"); } };

function stub({ ok = true, hang = null } = {}) {
  const calls = [];
  const conn = {
    calls,
    ended: 0,
    on() {},
    async query(sql) {
      calls.push(sql.includes("unlock") ? "unlock" : "lock");
      if (hang && sql.includes(hang)) return new Promise(() => {});
      return { rows: [{ ok }] };
    },
    async end() {
      conn.ended++;
      if (hang === "end") return new Promise(() => {});
    },
  };
  return conn;
}

test("withBatchLock: a throwing fn still unlocks and ends the connection", async () => {
  const conn = stub();
  const store = new PrismaQueueStore(noDb, { connectLock: async () => conn, timeoutMs: 200 });
  await assert.rejects(store.withBatchLock("b1", async () => { throw new Error("raise failed"); }), /raise failed/);
  assert.deepEqual(conn.calls, ["lock", "unlock"]);
  assert.equal(conn.ended, 1);
});

test("withBatchLock: a lock held elsewhere returns locked false, fn does not run, the connection is ended", async () => {
  const conn = stub({ ok: false });
  const store = new PrismaQueueStore(noDb, { connectLock: async () => conn, timeoutMs: 200 });
  let ran = false;
  assert.deepEqual(await store.withBatchLock("b1", async () => { ran = true; }), { locked: false });
  assert.equal(ran, false);
  assert.deepEqual(conn.calls, ["lock"]);
  assert.equal(conn.ended, 1);
});

test("withBatchLock: a hung connect, lock query or end is bounded by the store timeout", async () => {
  const late = stub();
  let resolveLate;
  const s1 = new PrismaQueueStore(noDb, { connectLock: () => new Promise((r) => { resolveLate = r; }), timeoutMs: 50 });
  await assert.rejects(s1.withBatchLock("b1", async () => 1), /card-batch-lock-timeout:connect/);
  resolveLate(late);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(late.ended, 1, "a connection that arrives after the bound is ended");

  const hungLock = stub({ hang: "pg_try_advisory_lock" });
  const s2 = new PrismaQueueStore(noDb, { connectLock: async () => hungLock, timeoutMs: 50 });
  await assert.rejects(s2.withBatchLock("b1", async () => 1), /card-batch-lock-timeout:lock/);
  assert.equal(hungLock.ended, 1);

  const hungEnd = stub({ hang: "end" });
  const s3 = new PrismaQueueStore(noDb, { connectLock: async () => hungEnd, timeoutMs: 50 });
  const t0 = Date.now();
  assert.deepEqual(await s3.withBatchLock("b1", async () => 7), { locked: true, value: 7 });
  assert.ok(Date.now() - t0 < 1000, "a hung end() does not hang the flush");
});

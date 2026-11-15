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

// Codex PR140-r1 finding 2: the batch card is raised only while the lock's session is alive.
function fenced() {
  let onError = null;
  const conn = {
    alive: true,
    queries: [],
    on(ev, cb) { if (ev === "error") onError = cb; },
    async query(sql) {
      conn.queries.push(sql);
      if (sql === "SELECT 1 AS ok") {
        if (!conn.alive) throw new Error("connection terminated");
        return { rows: [{ ok: 1 }] };
      }
      return { rows: [{ ok: true }] };
    },
    async end() {},
    drop() { conn.alive = false; onError?.(new Error("connection terminated")); },
  };
  return conn;
}

test("approvalBatchCards fence: a batch card is raised only while this process holds that batch's lock on a live session", async () => {
  const { approvalBatchCards } = await import("../dist/card-batch-store.js");
  const raised = [];
  const approvals = { raiseCard: async (input) => { raised.push(input.target); return { id: "c1" }; }, store: {} };
  const conn = fenced();
  const store = new PrismaQueueStore(noDb, { connectLock: async () => conn, timeoutMs: 200 });
  const cards = approvalBatchCards(approvals, undefined, store);
  const card = (target) => ({ gate: "decision", action: "a", target, reason: "r", projectId: "p" });
  // Outside the lock: refused, nothing raised.
  await assert.rejects(cards.raiseCard(card("batch:b1"), []), /batch-lock-lost/);
  // Inside the lock on a live session: raised, after one round trip on the lock's own session.
  await store.withBatchLock("b1", async () => cards.raiseCard(card("batch:b1"), []));
  assert.deepEqual(raised, ["batch:b1"]);
  assert.ok(conn.queries.includes("SELECT 1 AS ok"));
  // The session drops while fn runs (lock gone): the raise is refused and the error reaches the caller.
  await assert.rejects(store.withBatchLock("b2", async () => { conn.drop(); return cards.raiseCard(card("batch:b2"), []); }), /batch-lock-lost/);
  assert.deepEqual(raised, ["batch:b1"], "no card raised after the lock was lost");
  // Another batch's lock does not cover this batch; non-batch targets (member cards) are not fenced.
  const conn2 = fenced();
  const store2 = new PrismaQueueStore(noDb, { connectLock: async () => conn2, timeoutMs: 200 });
  const cards2 = approvalBatchCards(approvals, undefined, store2);
  await assert.rejects(store2.withBatchLock("b3", async () => cards2.raiseCard(card("batch:b4"), [])), /batch-lock-lost/);
  await cards2.raiseCard(card("question:q1"), []);
  assert.deepEqual(raised, ["batch:b1", "question:q1"]);
});

// S4-a2a (docs/modules/S4.md, "S4-a2 split"): record checks and error mapping of the Postgres isolation store,
// over a fake Prisma client. The real-Postgres half (constraints, uniqueness) is test-db/isolation-store.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { PrismaIsolationStore, IsolationStoreError, checkStackRecord } from "../dist/isolation-store.js";

const PID = "11111111-2222-4333-8444-555555555555";
const rec = (o = {}) => ({ projectId: PID, slug: "acme", env: "preview", idx: 0, network: "devos-p-acme-preview", subnet: "10.208.0.0/24", ...o });

function fakeDb({ fail } = {}) {
  const rows = [];
  const db = {
    rows,
    async $transaction(fn) {
      return fn({
        isolationStack: {
          async upsert({ where, update, create }) {
            if (fail) throw fail;
            const i = rows.findIndex((r) => r.projectId === where.projectId_env.projectId && r.env === where.projectId_env.env);
            if (i >= 0) rows[i] = { ...rows[i], ...update };
            else rows.push({ ...create });
            return { id: "x" };
          },
          async findMany() {
            if (fail) throw fail;
            return [...rows].sort((a, b) => a.idx - b.idx).map(({ projectId, slug, env, idx }) => ({ projectId, slug, env, idx }));
          },
        },
      });
    },
  };
  return db;
}

test("S4-a2a: only a record the hook would derive is accepted", () => {
  checkStackRecord(rec());
  checkStackRecord(rec({ env: "live", idx: 257, network: "devos-p-acme-live", subnet: "10.209.1.0/24" }));
  for (const bad of [
    rec({ projectId: "nope" }), rec({ slug: "Acme" }), rec({ env: "production" }), rec({ idx: 1024 }), rec({ idx: -1 }), rec({ idx: 1.5 }),
    rec({ network: "devos-p-other-preview" }), rec({ subnet: "10.208.1.0/24" }), rec({ subnet: "0.0.0.0/0" }), null,
  ]) {
    assert.throws(() => checkStackRecord(bad), (e) => e instanceof IsolationStoreError && e.code === "isolation-stack-invalid");
  }
});

test("S4-a2a: record is an upsert per (project, env); list returns exactly slug, env, idx by index", async () => {
  const db = fakeDb();
  const s = new PrismaIsolationStore(db, 1000);
  await s.recordStack(rec({ env: "live", idx: 1, network: "devos-p-acme-live", subnet: "10.208.1.0/24" }));
  await s.recordStack(rec());
  await s.recordStack(rec());
  assert.equal(db.rows.length, 2);
  assert.deepEqual(await s.listStacks(), [
    { projectId: PID, slug: "acme", env: "preview", idx: 0 },
    { projectId: PID, slug: "acme", env: "live", idx: 1 },
  ]);
});

test("S4-a2a: a unique violation is isolation-index-taken; any other failure is a fixed code, never the driver message", async () => {
  const taken = Object.assign(new Error("Unique constraint failed on the fields: (`idx`) value 10.208.0.0/24"), { code: "P2002" });
  await assert.rejects(new PrismaIsolationStore(fakeDb({ fail: taken }), 1000).recordStack(rec()),
    (e) => e instanceof IsolationStoreError && e.message === "isolation-index-taken");
  const other = new Error("connection to 10.0.0.5 password=hunter2 failed");
  await assert.rejects(new PrismaIsolationStore(fakeDb({ fail: other }), 1000).recordStack(rec()), (e) => e.message === "isolation-store-error");
  await assert.rejects(new PrismaIsolationStore(fakeDb({ fail: other }), 1000).listStacks(), (e) => e.message === "isolation-store-error");
});

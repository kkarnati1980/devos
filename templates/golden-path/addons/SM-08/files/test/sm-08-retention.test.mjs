// SM-08 add-on tests (docs/modules/S3.md, "S3-c2 SM-08 build notes").
// SM-08-L1: each data class has a declared retention period and a purge job that enforces it.
// SM-08-F1 (purge part): the purge removes expired rows only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { retentionPolicy, purgeExpired, purgeJob, purgeSql } from "../src/retention.mjs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-16T00:00:00.000Z");
const ago = (days, extraMs = 0) => new Date(NOW - days * DAY + extraMs).toISOString();

// A small emulation of the one DELETE the purge sends, matched as exact text against purgeSql(). The app's own test
// runs it on its real database; the template has none.
function fakeDb(tables) {
  const calls = [];
  const query = async (text, params) => {
    calls.push({ text, params });
    const m = /^DELETE FROM "([a-z_.]+)" WHERE "([a-z_]+)" IN \(SELECT "\2" FROM "\1" WHERE "([a-z_]+)" < \$1::timestamptz ORDER BY "\3" LIMIT \$2\) RETURNING "\2"$/.exec(text);
    if (!m) throw new Error(`unexpected SQL: ${text}`);
    const [, table, key, column] = m;
    const [cutoff, limit] = params;
    const rows = tables[table];
    const doomed = rows.filter((r) => r[column] !== null && r[column] < cutoff)
      .sort((a, b) => (a[column] < b[column] ? -1 : 1)).slice(0, limit);
    const ids = new Set(doomed.map((r) => r[key]));
    tables[table] = rows.filter((r) => !ids.has(r[key]));
    return { rows: doomed.map((r) => ({ [key]: r[key] })) };
  };
  return { query, calls };
}

const policy = () => retentionPolicy([
  { name: "audit.events", table: "audit_event", column: "created_at", days: 365 },
  { name: "sessions", table: "session", column: "last_seen_at", key: "sid", days: 30 },
]);

test("SM-08-L1: every data class declares its own period; there is no default", () => {
  const p = policy();
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p[0]));
  assert.deepEqual(p.map((c) => [c.name, c.days]), [["audit.events", 365], ["sessions", 30]]);
  assert.throws(() => retentionPolicy([{ name: "logs", table: "log", column: "at" }]), /days must be a whole number 1-36500 \(no default\)/);
  for (const days of [0, -1, 1.5, "30", 36_501, Number.NaN]) {
    assert.throws(() => retentionPolicy([{ name: "logs", table: "log", column: "at", days }]), /days/, String(days));
  }
  assert.throws(() => retentionPolicy([]), /at least one/);
  assert.throws(() => retentionPolicy("logs"), /at least one/);
  assert.throws(() => retentionPolicy([{ name: "a", table: "t", column: "c", days: 1 }, { name: "a", table: "u", column: "c", days: 1 }]), /declared twice/);
  assert.throws(() => retentionPolicy([{ name: "a", table: "t", column: "c", day: 1, days: 1 }]), /unknown field "day"/);
  assert.throws(() => retentionPolicy([{ name: "Bad Name", table: "t", column: "c", days: 1 }]), /class name/);
});

test("SM-08-L1: unsafe table, column or key names are refused, and names are quoted", () => {
  for (const [field, value] of [["table", 'log"; DROP TABLE x; --'], ["table", "a.b.c"], ["table", "Log"], ["column", "at at"],
    ["column", "s.at"], ["key", "id)"], ["table", ""], ["column", 7]]) {
    const cls = { name: "logs", table: "log", column: "at", days: 1, [field]: value };
    assert.throws(() => retentionPolicy([cls]), new RegExp(field), `${field}=${JSON.stringify(value)}`);
  }
  const [cls] = retentionPolicy([{ name: "logs", table: "app.log", column: "at", days: 7 }]);
  assert.equal(purgeSql(cls), 'DELETE FROM "app"."log" WHERE "id" IN (SELECT "id" FROM "app"."log" WHERE "at" < $1::timestamptz ORDER BY "at" LIMIT $2) RETURNING "id"');
});

test("SM-08-F1: the purge removes expired rows only (cutoff, newer and NULL rows are kept)", async () => {
  const tables = {
    audit_event: [
      { id: 1, created_at: ago(400) },
      { id: 2, created_at: ago(365, -1) }, // 1 ms older than the cutoff: expired
      { id: 3, created_at: ago(365) }, // exactly the cutoff: kept
      { id: 4, created_at: ago(10) },
      { id: 5, created_at: null },
    ],
    session: [
      { sid: "a", last_seen_at: ago(31) },
      { sid: "b", last_seen_at: ago(29) },
    ],
  };
  const db = fakeDb(tables);
  const r = await purgeExpired(db.query, policy(), { now: () => NOW });
  assert.deepEqual(tables.audit_event.map((x) => x.id), [3, 4, 5]);
  assert.deepEqual(tables.session.map((x) => x.sid), ["b"]);
  assert.deepEqual(r.classes, [
    { name: "audit.events", days: 365, cutoff: ago(365), deleted: 2, more: false },
    { name: "sessions", days: 30, cutoff: ago(30), deleted: 1, more: false },
  ]);
  // A second run finds nothing more.
  const again = await purgeExpired(db.query, policy(), { now: () => NOW });
  assert.deepEqual(again.classes.map((c) => c.deleted), [0, 0]);
});

test("SM-08-L1: large purges run in bounded batches, oldest first; maxBatches leaves the rest for the next run", async () => {
  const tables = { audit_event: Array.from({ length: 25 }, (_, i) => ({ id: i, created_at: ago(400 + i) })), session: [] };
  const db = fakeDb(tables);
  const p = policy();
  const r = await purgeExpired(db.query, p, { now: () => NOW, batchSize: 10, maxBatches: 2 });
  assert.deepEqual(r.classes[0], { name: "audit.events", days: 365, cutoff: ago(365), deleted: 20, more: true });
  assert.equal(tables.audit_event.length, 5);
  assert.deepEqual(tables.audit_event.map((x) => x.id).sort((a, b) => a - b), [0, 1, 2, 3, 4], "the oldest went first");
  assert.ok(db.calls.every((c) => c.params[1] === 10));
  const next = await purgeExpired(db.query, p, { now: () => NOW, batchSize: 10, maxBatches: 2 });
  assert.equal(next.classes[0].deleted, 5);
  assert.equal(next.classes[0].more, false);
  assert.equal(tables.audit_event.length, 0);
  await assert.rejects(purgeExpired(db.query, p, { batchSize: 0 }), /batchSize/);
  await assert.rejects(purgeExpired(db.query, [{ name: "x", table: '"x"', column: '"c"', key: '"id"', days: 1 }]), /retentionPolicy\(\)/);
});

test("SM-08-L1: the purge job enforces the policy, ignores its payload and stops on abort", async () => {
  const tables = { audit_event: Array.from({ length: 30 }, (_, i) => ({ id: i, created_at: ago(400) })), session: [{ sid: "x", last_seen_at: ago(90) }] };
  const db = fakeDb(tables);
  const handler = purgeJob(db.query, policy(), { now: () => NOW, batchSize: 10 });
  // A payload cannot widen the purge: days, tables and columns come only from the policy.
  const r = await handler({ days: 0, table: "user", batchSize: 1_000_000 }, { signal: new AbortController().signal, attempt: 1 });
  assert.deepEqual(r.classes.map((c) => c.deleted), [30, 1]);
  assert.ok(db.calls.every((c) => c.params[1] === 10));

  tables.audit_event = Array.from({ length: 30 }, (_, i) => ({ id: i, created_at: ago(400) }));
  const ac = new AbortController();
  let n = 0;
  const stopping = async (text, params) => { n += 1; if (n === 2) ac.abort(new Error("job timeout")); return db.query(text, params); };
  await assert.rejects(purgeJob(stopping, policy(), { now: () => NOW, batchSize: 10 })(null, { signal: ac.signal }), /job timeout/);
  assert.equal(n, 2, "no batch starts after the abort");
  assert.equal(tables.audit_event.length, 10);
});

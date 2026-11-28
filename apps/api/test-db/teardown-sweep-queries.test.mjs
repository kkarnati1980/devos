// DEVOS-112 follow-up (M2.5-b2, docs/modules/M2.5.md "M2.5-b2 follow-up: the sweep's queries on Postgres"):
// the teardown sweep's production queries (listDue, unspentGrant, Keep archived's locked conditional update (M2.5-b5b decision 3)) against real
// Postgres, through the exact code `buildTeardownSweep` uses (`teardownSweepQueries`).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDb } from "@devos/db";
import { teardownSweepQueries } from "../dist/teardown-runtime.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

const q = teardownSweepQueries(db, 5000);
const DAY = 86_400_000;
const mk = async (data) => {
  const slug = `m25b2q-${randomBytes(4).toString("hex")}`;
  return db.project.create({ data: { slug, name: `Project ${slug}`, ...data } });
};
const card = (projectId) =>
  db.approval.create({ data: { projectId, gate: "purge", action: "teardown.purge", target: `project:${projectId}`, reason: "test purge card" } });
const grant = (approvalId, projectId, data) =>
  db.approvalGrant.create({ data: { approvalId, projectId, scopeAction: "teardown.purge", issuedBy: "kk:test", expiresAt: new Date(Date.now() + DAY), ...data } });

test("listDue: only archived projects whose purge_after has passed, oldest first, with the row shape the sweep reads", async () => {
  // A fixed far-future "now" keeps the rows of other tests on the shared database out of the comparison: only rows
  // made here sit between base and now.
  const base = new Date(Date.UTC(2099, 0, 1));
  const now = new Date(base.getTime() + 10 * DAY);
  const at = (d) => new Date(base.getTime() + d * DAY);
  const older = await mk({ stage: "archived", archivedAt: at(-30), purgeAfter: at(2) });
  const newer = await mk({ stage: "archived", archivedAt: at(-20), purgeAfter: at(5) });
  const exact = await mk({ stage: "archived", archivedAt: at(-10), purgeAfter: now });
  const notYet = await mk({ stage: "archived", archivedAt: at(-5), purgeAfter: at(11) });
  const notArchived = await mk({ stage: "building", purgeAfter: at(1) });
  const noDate = await mk({ stage: "archived", archivedAt: at(-1) });

  const mine = new Set([older, newer, exact, notYet, notArchived, noDate].map((p) => p.id));
  // Codex PR199-r1 (low): a fixed 1,000-row page could miss these fixtures on a reused database with more earlier due
  // rows. The page is now every due row the database holds at `now` (counted with the query's own filter), plus one.
  const dueCount = await db.project.count({ where: { stage: "archived", purgeAfter: { lte: now } } });
  const all = await q.listDue(now, dueCount + 1);
  // Exact while this file runs alone on its database (CI: one Postgres per job, --test-concurrency=1).
  assert.equal(all.length, dueCount, "the page holds every due row");
  const due = all.filter((p) => mine.has(p.id));
  assert.deepEqual(due.map((p) => p.id), [older.id, newer.id, exact.id], "purge_after <= now (inclusive), ascending");
  for (const p of [notYet, notArchived, noDate]) assert.ok(!due.some((d) => d.id === p.id), p.slug);
  assert.deepEqual(due[0], { id: older.id, slug: older.slug, stage: "archived", purgeAfter: at(2), archivedAt: at(-30) });

  // The page limit is applied in the query, after the ordering.
  const page = await q.listDue(now, 1);
  assert.equal(page.length, 1);
  assert.equal(page[0].id, all[0].id, "the first page holds the oldest due row");
});

test("unspentGrant: an unrevoked, unexpired, unused grant of that card only; a used, revoked or expired grant is not", async () => {
  const p = await mk({ stage: "archived", archivedAt: new Date(), purgeAfter: new Date() });
  const now = new Date();
  const none = await card(p.id);
  assert.equal(await q.unspentGrant(none.id, now), null, "no grant at all");

  const c = await card(p.id);
  await grant(c.id, p.id, { uses: 1, maxUses: 1 });
  await grant(c.id, p.id, { revokedAt: now });
  // The database requires expires_at > issued_at (approval_grant_expiry), so past grants get an earlier issued_at.
  // A zero-use grant cannot exist (approval_grant_uses: max_uses >= 1); the code's maxUses check is defence in depth.
  const issuedAt = new Date(now.getTime() - DAY);
  await grant(c.id, p.id, { issuedAt, expiresAt: new Date(now.getTime() - 1000) });
  await grant(c.id, p.id, { issuedAt, expiresAt: now }); // expires_at > now is strict
  assert.equal(await q.unspentGrant(c.id, now), null, "used, revoked, expired and expiring-now grants are all spent");

  const good = await grant(c.id, p.id, {});
  assert.equal(await q.unspentGrant(c.id, now), good.id);
  const other = await card(p.id);
  assert.equal(await q.unspentGrant(other.id, now), null, "another card's grant is never returned");
});

// M2.5-b5b decision 3: Keep archived is one statement under the lifecycle lock on the database clock. It moves
// purge_after once, to the later of purge_after and the database now plus 30 days, only for a rejected card raised in
// this archive at or after purge_after.
const KEEP = 30 * DAY;
const rejected = (projectId, createdAt) =>
  db.approval.create({ data: { projectId, gate: "purge", action: "teardown.purge", target: `project:${projectId}`, reason: "test purge card", status: "rejected", decidedAt: createdAt, createdAt } });
const purgeAfterOf = async (id) => (await db.project.findUnique({ where: { id }, select: { purgeAfter: true } })).purgeAfter;
const dbNow = async () => (await db.$queryRaw`SELECT clock_timestamp() AS t`)[0].t.getTime();

test("keepArchived: a past purge_after moves once from the database now, with one audit row; a repeat, a stale value or a restored project changes nothing", async () => {
  const from = new Date(Date.now() - 2 * DAY);
  const p = await mk({ stage: "archived", archivedAt: new Date(from.getTime() - 30 * DAY), purgeAfter: from });
  const c = await rejected(p.id, new Date(from.getTime() + 1000));
  const audit = () => db.auditEvent.findMany({ where: { projectId: p.id, action: "teardown.keep_archived" } });

  const before = await dbNow();
  const to = await q.keepArchived(p.id, from, c.id);
  const afterT = await dbNow();
  assert.ok(to instanceof Date);
  assert.ok(to.getTime() >= before - 1 + KEEP && to.getTime() <= afterT + KEEP, "the database now plus 30 days");
  assert.deepEqual(await purgeAfterOf(p.id), to);
  const ev = await audit();
  assert.equal(ev.length, 1);
  assert.equal(String(ev[0].actor), "system");
  assert.equal(ev[0].summary, "Kept archived another 30 days (purge card rejected)");
  assert.deepEqual(ev[0].details, { approvalId: c.id, purgeAfter: to.toISOString() });

  assert.equal(await q.keepArchived(p.id, from, c.id), null, "a repeat from the old value is a no-op");
  assert.equal(await q.keepArchived(p.id, to, c.id), null, "the same card again moves nothing: it is now before purge_after");
  assert.deepEqual(await purgeAfterOf(p.id), to);
  assert.equal((await audit()).length, 1, "a no-op writes no audit row");

  const restored = await mk({ stage: "building", purgeAfter: from });
  const rc = await rejected(restored.id, new Date(from.getTime() + 1000));
  assert.equal(await q.keepArchived(restored.id, from, rc.id), null, "a project no longer archived is not moved");
  assert.deepEqual(await purgeAfterOf(restored.id), from);
});

test("keepArchived: a future purge_after moves from itself; an early-ask card, another archive's card or a pending card moves nothing", async () => {
  const from = new Date(Date.UTC(2030, 5, 1));
  const archivedAt = new Date(from.getTime() - 30 * DAY);
  const p = await mk({ stage: "archived", archivedAt, purgeAfter: from });
  const early = await rejected(p.id, new Date(from.getTime() - DAY));
  assert.equal(await q.keepArchived(p.id, from, early.id), null, "an early ask (before purge_after) moves nothing");
  const old = await mk({ stage: "archived", archivedAt: new Date(from.getTime() + DAY), purgeAfter: from });
  const oldCard = await rejected(old.id, new Date(from.getTime() + 1000));
  assert.equal(await q.keepArchived(old.id, from, oldCard.id), null, "a card raised before this archive moves nothing");
  const pending = await card(p.id);
  await db.$executeRaw`UPDATE approval SET created_at = ${new Date(from.getTime() + 1000)}::timestamptz WHERE id = ${pending.id}::uuid`;
  assert.equal(await q.keepArchived(p.id, from, pending.id), null, "a card that is not rejected moves nothing");
  const other = await mk({ stage: "archived", archivedAt, purgeAfter: from });
  const otherCard = await rejected(other.id, new Date(from.getTime() + 1000));
  assert.equal(await q.keepArchived(p.id, from, otherCard.id), null, "another project's card moves nothing");
  assert.deepEqual(await purgeAfterOf(p.id), from);
  const ok = await rejected(p.id, new Date(from.getTime() + 1000));
  assert.deepEqual(await q.keepArchived(p.id, from, ok.id), new Date(from.getTime() + KEEP), "from purge_after itself while it is in the future");
});

test("keepArchived: waits for a held lifecycle lock and then reads the row its holder left", async () => {
  const from = new Date(Date.now() - DAY);
  const p = await mk({ stage: "archived", archivedAt: new Date(from.getTime() - 30 * DAY), purgeAfter: from });
  const c = await rejected(p.id, new Date(from.getTime() + 1000));
  const holder = new pg.Client({ connectionString: url });
  await holder.connect();
  try {
    await holder.query("SELECT pg_advisory_lock(hashtext('devos:provision'), hashtext($1))", [p.id]);
    let settled = false;
    const keeping = q.keepArchived(p.id, from, c.id).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(settled, false, "Keep archived waits on the lifecycle lock");
    // The holder (a Restore) moves the row out of the archive before it lets go.
    await holder.query("UPDATE project SET stage = 'building', archived_at = NULL, purge_after = NULL WHERE id = $1::uuid", [p.id]);
    await holder.query("SELECT pg_advisory_unlock(hashtext('devos:provision'), hashtext($1))", [p.id]);
    assert.equal(await keeping, null);
    assert.equal(await purgeAfterOf(p.id), null);
  } finally {
    await holder.end();
  }
});

test("keepArchived: a failed audit insert rolls the purge_after move back", async () => {
  const from = new Date(Date.UTC(2031, 0, 1));
  const p = await mk({ stage: "archived", archivedAt: new Date(from.getTime() - 30 * DAY), purgeAfter: from });
  const c = await rejected(p.id, new Date(from.getTime() + 1000));
  // The audit insert is made to fail inside the same real transaction: the transaction client is wrapped so that
  // only auditEvent.create throws, after the real project update has run.
  const failing = {
    $transaction: (fn, opts) =>
      db.$transaction((t) => fn(new Proxy(t, { get: (o, k) => (k === "auditEvent" ? { create: async () => { throw new Error("audit down"); } } : typeof o[k] === "function" ? o[k].bind(o) : o[k]) })), opts),
  };
  const qf = teardownSweepQueries(failing, 5000);
  await assert.rejects(qf.keepArchived(p.id, from, c.id), /audit down/);
  assert.deepEqual(await purgeAfterOf(p.id), from, "the update is rolled back with the failed audit insert");
  assert.equal((await db.auditEvent.findMany({ where: { projectId: p.id, action: "teardown.keep_archived" } })).length, 0);
});

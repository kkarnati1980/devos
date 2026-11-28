// M2.5-b5a (DEVOS-255, docs/modules/M2.5.md "M2.5-b5a"): the guarded purge-card raise against real Postgres. One
// transaction takes the project's lifecycle lock (the same key Archive, Restore and Purge hold as a session lock),
// re-reads the row (the due check and the card's date at the database clock, M2.5-b5b decision 1) and writes the card only if the row is still the archive the caller read.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDb } from "@devos/db";
import { Approvals, PrismaApprovalStore } from "../dist/approvals.js";
import { purgeCard } from "../dist/teardown-sweep.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

const DAY = 86_400_000;
// The app clock is pinned far in the past (a clock moved back). Since M2.5-b5b it neither dates cards nor runs the due check.
const APP_NOW = Date.parse("2001-01-01T00:00:00Z");
const approvals = new Approvals({ store: new PrismaApprovalStore(db, 5000), grants: null, notifier: null, verifyKkSession: () => false, now: () => APP_NOW });

const mk = async (data) => {
  const slug = `m25b5a-${randomBytes(4).toString("hex")}`;
  return db.project.create({ data: { slug, name: `Project ${slug}`, ...data } });
};
const cardsOf = (projectId) => db.approval.findMany({ where: { projectId, action: "teardown.purge" } });

// M2.5-b5b decision 1 (supersedes b5a decisions 9 and 10, whose two app-clock tests these replace): the due check
// and the card's date use the database clock, read under the lock, whatever the app clock says.
const dbNow = async () => (await db.$queryRaw`SELECT clock_timestamp() AS t`)[0].t.getTime();

test("M2.5-b5b: an archived, due row gets one card, dated by the database clock in whole ms, with the app clock pinned to 2001", async () => {
  const archivedAt = new Date(Date.now() - 31 * DAY);
  const purgeAfter = new Date(Date.now() - DAY);
  const p = await mk({ stage: "archived", archivedAt, purgeAfter });
  const before = await dbNow();
  const c = await approvals.raiseGuardedCard(purgeCard(p, { github: 1 }), { projectId: p.id, archivedAt, due: true });
  const afterT = await dbNow();
  assert.equal(typeof c.id, "string", "due at the database clock, though the app clock (2001) is before purge_after");
  assert.notEqual(c.createdAt.getTime(), APP_NOW);
  assert.ok(c.createdAt.getTime() >= Math.floor(before) - 1 && c.createdAt.getTime() <= afterT, "dated by the database clock");
  assert.ok(c.createdAt.getTime() > purgeAfter.getTime(), "a daily card is dated after purge_after");
  const stored = (await db.$queryRaw`SELECT (created_at = date_trunc('milliseconds', created_at)) AS ms FROM approval WHERE id = ${c.id}::uuid`)[0];
  assert.equal(stored.ms, true, "cut to whole milliseconds");
  // An early ask on a row archived on the database clock is dated at or after its archive.
  const early = await mk({ stage: "archived", archivedAt, purgeAfter: new Date(Date.now() + DAY) });
  const b2 = await dbNow();
  const e = await approvals.raiseGuardedCard(purgeCard(early, {}), { projectId: early.id, archivedAt, due: false });
  const a2 = await dbNow();
  assert.ok(e.createdAt.getTime() >= Math.floor(b2) - 1 && e.createdAt.getTime() <= a2, "an early ask: the database clock too");
  assert.equal((await cardsOf(p.id)).length, 1);
  // A second guarded raise dedupes onto the pending card, as raiseCard does.
  const again = await approvals.raiseGuardedCard(purgeCard(p, { github: 1 }), { projectId: p.id, archivedAt, due: true });
  assert.equal(again.id, c.id);
  assert.equal((await cardsOf(p.id)).length, 1);
});

test("M2.5-b5b: an app clock far ahead of purge_after is not used: not-due while the database is before it", async () => {
  const archivedAt = new Date(Date.now() - 2 * DAY);
  const p = await mk({ stage: "archived", archivedAt, purgeAfter: new Date(Date.now() + DAY) });
  const ahead = new Approvals({ store: new PrismaApprovalStore(db, 5000), grants: null, notifier: null, verifyKkSession: () => false, now: () => Date.now() + 365 * DAY });
  assert.deepEqual(await ahead.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt, due: true }), { refused: "not-due" });
  assert.equal((await cardsOf(p.id)).length, 0);
});

test("refusals write nothing: not archived, another archive, not yet due, missing project", async () => {
  const archivedAt = new Date(Date.now() - 2 * DAY);
  const building = await mk({ stage: "building" });
  assert.deepEqual(await approvals.raiseGuardedCard(purgeCard(building, {}), { projectId: building.id, archivedAt, due: false }), { refused: "not_archived" });
  const rearchived = await mk({ stage: "archived", archivedAt: new Date(archivedAt.getTime() + 1000), purgeAfter: new Date(Date.now() - DAY) });
  assert.deepEqual(await approvals.raiseGuardedCard(purgeCard(rearchived, {}), { projectId: rearchived.id, archivedAt, due: true }), { refused: "archive-changed" });
  const kept = await mk({ stage: "archived", archivedAt, purgeAfter: new Date(Date.now() + 30 * DAY) });
  assert.deepEqual(await approvals.raiseGuardedCard(purgeCard(kept, {}), { projectId: kept.id, archivedAt, due: true }), { refused: "not-due" });
  // The early ask (due: false) on the same row raises.
  assert.equal(typeof (await approvals.raiseGuardedCard(purgeCard(kept, {}), { projectId: kept.id, archivedAt, due: false })).id, "string");
  for (const p of [building, rearchived]) assert.equal((await cardsOf(p.id)).length, 0, p.slug);
  const ghost = { id: "99999999-2222-4333-8444-555555555555", slug: "ghost" };
  assert.deepEqual(await approvals.raiseGuardedCard(purgeCard(ghost, {}), { projectId: ghost.id, archivedAt, due: false }), { refused: "project-not-found" });
});

test("the raise waits for the session lifecycle lock and sees the purge that held it: no card", async () => {
  const archivedAt = new Date(Date.now() - 31 * DAY);
  const p = await mk({ stage: "archived", archivedAt, purgeAfter: new Date(Date.now() - DAY) });
  const holder = new pg.Client({ connectionString: url });
  await holder.connect();
  try {
    // The purge's session lock (packages/provision LOCK_SQL).
    await holder.query("SELECT pg_advisory_lock(hashtext('devos:provision'), hashtext($1))", [p.id]);
    let settled = false;
    const raising = approvals.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt, due: true }).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(settled, false, "the raise waits on the lock");
    await holder.query("UPDATE project SET stage = 'purged' WHERE id = $1::uuid", [p.id]);
    await holder.query("SELECT pg_advisory_unlock(hashtext('devos:provision'), hashtext($1))", [p.id]);
    assert.deepEqual(await raising, { refused: "not_archived" });
    assert.equal((await cardsOf(p.id)).length, 0);
  } finally {
    await holder.end();
  }
});

test("Codex PR242-r1: an archive that differs from the snapshot only below the millisecond is refused", async () => {
  const archivedAt = new Date(Date.now() - 31 * DAY);
  const p = await mk({ stage: "archived", archivedAt, purgeAfter: new Date(Date.now() - DAY) });
  // Same millisecond, 400 microseconds later: another archive the JS snapshot cannot tell apart.
  await db.$executeRaw`UPDATE project SET archived_at = archived_at + interval '400 microseconds' WHERE id = ${p.id}::uuid`;
  assert.deepEqual(await approvals.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt, due: true }), { refused: "archive-changed" });
  assert.equal((await cardsOf(p.id)).length, 0);
});

test("Codex PR242-r6: a Keep archived update in flight during the raise is waited for and read: not-due, no card", async () => {
  const archivedAt = new Date(Date.now() - 31 * DAY);
  const p = await mk({ stage: "archived", archivedAt, purgeAfter: new Date(Date.now() - DAY) });
  const appNow = Date.now() + 60_000;
  const ahead = new Approvals({ store: new PrismaApprovalStore(db, 5000), grants: null, notifier: null, verifyKkSession: () => false, now: () => appNow });
  const keeper = new pg.Client({ connectionString: url });
  await keeper.connect();
  try {
    // A row writer that takes no lifecycle lock (Keep archived did before M2.5-b5b), open but not committed.
    await keeper.query("BEGIN");
    await keeper.query("UPDATE project SET purge_after = now() + interval '30 days' WHERE id = $1::uuid", [p.id]);
    let settled = false;
    const raising = ahead.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt, due: true }).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(settled, false, "the raise waits on the row Keep archived is updating");
    await keeper.query("COMMIT");
    assert.deepEqual(await raising, { refused: "not-due" });
    assert.equal((await cardsOf(p.id)).length, 0);
  } finally {
    await keeper.end();
  }
});

test("Codex PR242-r7: the raise's row lock does not block a foreign-key check (FOR KEY SHARE) on the project", async () => {
  const archivedAt = new Date(Date.now() - 31 * DAY);
  const p = await mk({ stage: "archived", archivedAt, purgeAfter: new Date(Date.now() - DAY) });
  const appNow = Date.now() + 60_000;
  const ahead = new Approvals({ store: new PrismaApprovalStore(db, 5000), grants: null, notifier: null, verifyKkSession: () => false, now: () => appNow });
  const other = new pg.Client({ connectionString: url });
  await other.connect();
  try {
    // What an audit_event insert's foreign-key check takes on the project row, held open during the raise.
    await other.query("BEGIN");
    await other.query("SELECT 1 FROM project WHERE id = $1::uuid FOR KEY SHARE", [p.id]);
    const c = await ahead.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt, due: true });
    assert.equal(typeof c.id, "string", "the raise is not blocked by the key-share lock");
    await other.query("COMMIT");
  } finally {
    await other.end();
  }
});

test("M2.5-b5b decision 12 (Codex PR244-r1): an app-clock archive ahead of the database dates its early card at the archive, never before", async () => {
  const archivedAt = new Date(Date.now() + 10 * 60_000); // stamped before b5b by an app clock 10 minutes ahead
  const p = await mk({ stage: "archived", archivedAt, purgeAfter: new Date(archivedAt.getTime() + 30 * DAY) });
  const c = await approvals.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt, due: false });
  assert.equal(c.createdAt.getTime(), archivedAt.getTime(), "the sweep's created_at >= archived_at holds");
  assert.deepEqual(await approvals.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt, due: true }), { refused: "not-due" }, "the daily raise stays not due");
});

test("DEVOS-254 decision 34: with reuseSince, an approved card raised in the window is returned under the lock, never doubled", async () => {
  const archivedAt = new Date(Date.now() - 2 * DAY);
  const p = await mk({ stage: "archived", archivedAt, purgeAfter: new Date(Date.now() + 28 * DAY) });
  const since = new Date(Date.now() - 60_000);
  // KK's earlier ask, already approved (a purge card needs its confirmation hash), inside the window.
  const asked = await db.approval.create({ data: { projectId: p.id, gate: "purge", action: "teardown.purge", target: `project:${p.id}`, reason: "asked", status: "approved", decidedAt: new Date(), decidedBy: "kk", confirmationHash: "h", createdAt: new Date(Date.now() - 1000) } });
  const got = await approvals.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt, due: false, reuseSince: since });
  assert.equal(got.id, asked.id);
  assert.equal((await cardsOf(p.id)).length, 1, "no second card");
  // Outside the window the approved card is not reused: a new pending card is raised, as every other caller gets.
  const fresh = await approvals.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt, due: false, reuseSince: new Date(asked.createdAt.getTime() + 1) });
  assert.notEqual(fresh.id, asked.id);
  assert.equal((await cardsOf(p.id)).length, 2);
});

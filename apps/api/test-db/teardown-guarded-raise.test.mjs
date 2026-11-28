// M2.5-b5a (DEVOS-255, docs/modules/M2.5.md "M2.5-b5a"): the guarded purge-card raise against real Postgres. One
// transaction takes the project's lifecycle lock (the same key Archive, Restore and Purge hold as a session lock),
// re-reads the row at the database clock and writes the card only if the row is still the archive the caller read.
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
// The app clock is pinned far in the past: a card's createdAt is then floored at the row's archived_at.
const APP_NOW = Date.parse("2001-01-01T00:00:00Z");
const approvals = new Approvals({ store: new PrismaApprovalStore(db, 5000), grants: null, notifier: null, verifyKkSession: () => false, now: () => APP_NOW });

const mk = async (data) => {
  const slug = `m25b5a-${randomBytes(4).toString("hex")}`;
  return db.project.create({ data: { slug, name: `Project ${slug}`, ...data } });
};
const cardsOf = (projectId) => db.approval.findMany({ where: { projectId, action: "teardown.purge" } });

test("an archived, due row gets one card, dated by the app clock but never before its archive", async () => {
  const archivedAt = new Date(Date.now() - 31 * DAY);
  const purgeAfter = new Date(Date.now() - DAY);
  // Codex PR242-r4: the due check and the card's date use one clock, the app clock. With it ahead of purge_after the
  // daily card is dated by the app clock itself (no purge_after floor).
  const appNow = Date.now() + 5 * 60_000;
  const ahead = new Approvals({ store: new PrismaApprovalStore(db, 5000), grants: null, notifier: null, verifyKkSession: () => false, now: () => appNow });
  const p = await mk({ stage: "archived", archivedAt, purgeAfter });
  const c = await ahead.raiseGuardedCard(purgeCard(p, { github: 1 }), { projectId: p.id, archivedAt, due: true });
  assert.equal(typeof c.id, "string");
  assert.equal(c.createdAt.getTime(), appNow, "a daily card: the app clock");
  // The app clock pinned to 2001, behind the archive: an early ask's card is floored at archived_at.
  const early = await mk({ stage: "archived", archivedAt, purgeAfter: new Date(Date.now() + DAY) });
  const e = await approvals.raiseGuardedCard(purgeCard(early, {}), { projectId: early.id, archivedAt, due: false });
  assert.equal(e.createdAt.getTime(), archivedAt.getTime(), "an early ask: the later of the app clock and archived_at");
  assert.equal((await cardsOf(p.id)).length, 1);
  // A second guarded raise dedupes onto the pending card, as raiseCard does.
  const again = await ahead.raiseGuardedCard(purgeCard(p, { github: 1 }), { projectId: p.id, archivedAt, due: true });
  assert.equal(again.id, c.id);
  assert.equal((await cardsOf(p.id)).length, 1);
});

test("Codex PR242-r4: the app clock pinned before purge_after gives not-due, even though Postgres sees the row as due", async () => {
  const archivedAt = new Date(Date.now() - 31 * DAY);
  const p = await mk({ stage: "archived", archivedAt, purgeAfter: new Date(Date.now() - DAY) });
  // `approvals` runs at 2001: purge_after (yesterday at the database clock) has not passed on the app clock.
  assert.deepEqual(await approvals.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt, due: true }), { refused: "not-due" });
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

// M2.5-b5a (DEVOS-255, docs/modules/M2.5.md "M2.5-b5a"): the guarded purge-card raise against real Postgres. One
// transaction takes the project's lifecycle lock (the same key Archive, Restore and Purge hold as a session lock),
// re-reads the row (the due check at the app clock, decision 9) and writes the card only if the row is still the archive the caller read.
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
// The app clock is pinned far in the past (a clock moved back): cards are still dated by it, with no floor.
const APP_NOW = Date.parse("2001-01-01T00:00:00Z");
const approvals = new Approvals({ store: new PrismaApprovalStore(db, 5000), grants: null, notifier: null, verifyKkSession: () => false, now: () => APP_NOW });

const mk = async (data) => {
  const slug = `m25b5a-${randomBytes(4).toString("hex")}`;
  return db.project.create({ data: { slug, name: `Project ${slug}`, ...data } });
};
const cardsOf = (projectId) => db.approval.findMany({ where: { projectId, action: "teardown.purge" } });

test("an archived, due row gets one card, dated by the app clock alone", async () => {
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
  // Codex PR242-r5: the app clock pinned to 2001, behind the archive, dates an early ask's card with no archived_at floor.
  const early = await mk({ stage: "archived", archivedAt, purgeAfter: new Date(Date.now() + DAY) });
  const e = await approvals.raiseGuardedCard(purgeCard(early, {}), { projectId: early.id, archivedAt, due: false });
  assert.equal(e.createdAt.getTime(), APP_NOW, "an early ask: the app clock, never floored at archived_at");
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

test("Codex PR242-r6: a Keep archived update in flight during the raise is waited for and read: not-due, no card", async () => {
  const archivedAt = new Date(Date.now() - 31 * DAY);
  const p = await mk({ stage: "archived", archivedAt, purgeAfter: new Date(Date.now() - DAY) });
  const appNow = Date.now() + 60_000;
  const ahead = new Approvals({ store: new PrismaApprovalStore(db, 5000), grants: null, notifier: null, verifyKkSession: () => false, now: () => appNow });
  const keeper = new pg.Client({ connectionString: url });
  await keeper.connect();
  try {
    // Keep archived's update (teardown-runtime keepArchived), which takes no lifecycle lock, open but not committed.
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

test("DEVOS-254 decision 34: with reuseSince, an approved card raised in the window is returned under the lock, never doubled", async () => {
  const archivedAt = new Date(Date.now() - 2 * DAY);
  const p = await mk({ stage: "archived", archivedAt, purgeAfter: new Date(Date.now() + 28 * DAY) });
  const since = new Date(APP_NOW - 60_000);
  // KK's earlier ask, already approved (a purge card needs its confirmation hash), inside the window.
  const asked = await db.approval.create({ data: { projectId: p.id, gate: "purge", action: "teardown.purge", target: `project:${p.id}`, reason: "asked", status: "approved", decidedAt: new Date(), decidedBy: "kk", confirmationHash: "h", createdAt: new Date(APP_NOW) } });
  const got = await approvals.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt, due: false, reuseSince: since });
  assert.equal(got.id, asked.id);
  assert.equal((await cardsOf(p.id)).length, 1, "no second card");
  // Outside the window the approved card is not reused: a new pending card is raised, as every other caller gets.
  const fresh = await approvals.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt, due: false, reuseSince: new Date(APP_NOW + 1) });
  assert.notEqual(fresh.id, asked.id);
  assert.equal((await cardsOf(p.id)).length, 2);
});

// M2.5-b5e: a live app clock, so a card is raised in the row's current archive (only such a card is bound, decision 21).
const liveApprovals = new Approvals({ store: new PrismaApprovalStore(db, 5000), grants: null, notifier: null, verifyKkSession: () => false, now: () => Date.now() });

test("M2.5-b5e decision 21 (Codex PR244-r6): a probe cycle's card is bound by id in the raise's transaction, and kept across a restore and re-archive", async () => {
  const { bindProbeCycleCard, probeCycleCard } = await import("../dist/provision-probe-purge.js");
  const archivedAt = new Date(Date.now() - 2 * DAY);
  const p = await mk({ stage: "archived", archivedAt, purgeAfter: new Date(Date.now() + 28 * DAY) });
  assert.equal(await probeCycleCard(db, p.id, 7, 5000), null);
  const a = await liveApprovals.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt, due: false, bindCycle: 7 });
  assert.equal(typeof a.id, "string");
  assert.equal(await probeCycleCard(db, p.id, 7, 5000), a.id, "bound in the raise's own transaction");
  assert.equal(await probeCycleCard(db, p.id, 8, 5000), null, "another cycle has no card");
  // KK restores and archives again; his raw re-archive moves archived_at, so a plain guarded raise is refused.
  const later = new Date(archivedAt.getTime() + 60_000);
  await db.project.update({ where: { id: p.id }, data: { archivedAt: later } });
  assert.deepEqual(await approvals.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt, due: false }), { refused: "archive-changed" });
  // The cycle's raise returns its bound card under the lock whatever the archive now is: never a second card.
  const again = await liveApprovals.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt: later, due: false, bindCycle: 7 });
  assert.equal(again.id, a.id);
  assert.equal((await cardsOf(p.id)).length, 1);
  // An adopted card is bound under the lifecycle lock; the first binding wins.
  assert.equal(await bindProbeCycleCard(db, p.id, 9, a.id, 5000), a.id);
  assert.equal(await bindProbeCycleCard(db, p.id, 9, "11111111-2222-4333-8444-555555555555", 5000), a.id);
  assert.equal(await bindProbeCycleCard(db, p.id, 7, "11111111-2222-4333-8444-555555555555", 5000), a.id);
  const rows = await db.auditEvent.findMany({ where: { projectId: p.id, action: "provision.probe_cycle_card" } });
  assert.equal(rows.length, 2, "one binding row per cycle");
  // A bad cycle number is refused before any write.
  await assert.rejects(liveApprovals.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt: later, due: false, bindCycle: 0 }), /invalid-input/);
  await assert.rejects(bindProbeCycleCard(db, p.id, 1.5, a.id, 5000), /probe-card-no-cycle/);
});

test("M2.5-b5e decision 21: a reuse is bound in the raise's transaction, only for a card of the current archive; a foreign id is never bound", async () => {
  const { bindProbeCycleCard, probeCycleCard } = await import("../dist/provision-probe-purge.js");
  const archivedAt = new Date(Date.now() - 2 * DAY);
  const p = await mk({ stage: "archived", archivedAt, purgeAfter: new Date(Date.now() + 28 * DAY) });
  // An early ask in this archive (dated by the 2001 app clock, so before archived_at): a reuse of it is not bound.
  const now = liveApprovals;
  const old = await approvals.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt, due: false });
  const reused = await now.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt, due: false, bindCycle: 3, reuseSince: new Date(0) });
  assert.equal(reused.id, old.id, "decision 34 reuse");
  assert.equal(await probeCycleCard(db, p.id, 3, 5000), null, "a card from before the current archive is not bound");
  // A card of the current archive found by the reuse window is bound in the same transaction.
  await db.approval.update({ where: { id: old.id }, data: { status: "rejected", decidedAt: new Date(), decidedBy: "kk" } });
  const fresh = await now.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt, due: false });
  const r2 = await now.raiseGuardedCard(purgeCard(p, {}), { projectId: p.id, archivedAt, due: false, bindCycle: 4, reuseSince: new Date(archivedAt.getTime()) });
  assert.equal(r2.id, fresh.id);
  assert.equal(await probeCycleCard(db, p.id, 4, 5000), fresh.id);
  // An id that is not this project's purge card is refused, and nothing is written.
  const other = await mk({ stage: "archived", archivedAt, purgeAfter: new Date(Date.now() + 28 * DAY) });
  const foreign = await now.raiseGuardedCard(purgeCard(other, {}), { projectId: other.id, archivedAt, due: false });
  await assert.rejects(bindProbeCycleCard(db, p.id, 5, foreign.id, 5000), /probe-card-bind-invalid/);
  await assert.rejects(bindProbeCycleCard(db, p.id, 5, "11111111-2222-4333-8444-555555555555", 5000), /probe-card-bind-invalid/);
  assert.equal(await probeCycleCard(db, p.id, 5, 5000), null);
});

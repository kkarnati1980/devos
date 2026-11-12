// M2.6-b2a AT8 on Postgres: the scheduled sweep lists only active projects (not archived, not purged) and
// syncs each one under its lock with the production `lockedSyncOne`; an in-memory Linear stands in for the API.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDb } from "@devos/db";
import { listActiveProjects, syncActiveProjects, lockedSyncOne } from "../dist/index.js";
import { fakeLinear } from "../test/fake-linear.mjs";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

async function project(data = {}) {
  const slug = `sched-${randomBytes(6).toString("hex")}`;
  const p = await db.project.create({ data: { slug, name: slug, ...data } });
  const m = await db.milestone.create({ data: { projectId: p.id, ordinal: 1, name: "Intake", gateName: "G1" } });
  await db.module.create({ data: { projectId: p.id, milestoneId: m.id, key: "M1.1", title: "Data", lane: 1, contractPath: "docs/modules/M1.1.md" } });
  return p.id;
}

test("AT8 on Postgres: archived and purged projects are not listed; active ones are", async () => {
  const live = await project({ stage: "building" });
  const archivedStage = await project({ stage: "archived" });
  const purged = await project({ stage: "purged" });
  const archivedAt = await project({ stage: "live", archivedAt: new Date() });
  const ids = await listActiveProjects(db);
  assert.ok(ids.includes(live));
  for (const gone of [archivedStage, purged, archivedAt]) assert.ok(!ids.includes(gone), `${gone} must be skipped`);
});

test("AT8 on Postgres: the sweep syncs every active project under its lock and skips a project whose lock is held", async () => {
  const a = await project({ stage: "building" }); const b = await project({ stage: "preview" });
  const skipped = await project({ stage: "archived" });
  const L = fakeLinear();
  const only = new Set([a, b, skipped]);
  // Hold b's lock in another transaction while the sweep runs.
  let release; const held = new Promise((r) => { release = r; });
  let locked; const isLocked = new Promise((r) => { locked = r; });
  const holder = db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('devos:linear-sync'), hashtext($1))`, b);
    locked(); await held;
  }, { timeout: 30_000 });
  await isLocked;
  const r = await syncActiveProjects({ list: async () => (await listActiveProjects(db)).filter((id) => only.has(id)), syncOne: lockedSyncOne(db, L.api) });
  release(); await holder;
  assert.deepEqual(r.synced, [a]); assert.deepEqual(r.skipped, [b]); assert.deepEqual(r.failed, []);
  assert.equal((await db.resource.count({ where: { projectId: a, provider: "linear", kind: "project" } })), 1);
  assert.equal((await db.resource.count({ where: { projectId: skipped, provider: "linear" } })), 0);
  const again = await syncActiveProjects({ list: async () => [b], syncOne: lockedSyncOne(db, L.api) });
  assert.deepEqual(again.synced, [b], "b syncs once its lock is free");
});

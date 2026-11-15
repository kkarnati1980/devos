// DEVOS-224 (M2.4-d1, docs/modules/M2.4.md "d1 runtime wiring"): PrismaProvisioningRows against real Postgres.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDb } from "@devos/db";
import { PrismaProvisioningRows } from "../dist/provision-runtime.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

const mk = async (data) => {
  const slug = `m24d1-${randomBytes(4).toString("hex")}`;
  return db.project.create({ data: { slug, name: `Project ${slug}`, ...data } });
};
const stage = async (id) => String((await db.project.findUnique({ where: { id }, select: { stage: true } })).stage);

test("d1 rows: only live provisioning projects are listed; markBuilding moves only from provisioning, once", async () => {
  const rows = new PrismaProvisioningRows(db, 5000);
  const live = await mk({ stage: "provisioning" });
  const paused = await mk({ stage: "provisioning", pausedAt: new Date() });
  const archived = await mk({ stage: "provisioning", archivedAt: new Date() });
  const intake = await mk({});
  const listed = (await rows.listProvisioning()).map((p) => p.id);
  assert.ok(listed.includes(live.id));
  for (const p of [paused, archived, intake]) assert.ok(!listed.includes(p.id), p.slug);
  assert.ok(!(await rows.listProvisioning([live.id])).some((p) => p.id === live.id), "an excluded (parked) project is left out in the query");
  const one = (await rows.listProvisioning()).find((p) => p.id === live.id);
  assert.deepEqual(one, { id: live.id, slug: live.slug, name: live.name });

  await rows.markBuilding(live.id);
  assert.equal(await stage(live.id), "building");
  await rows.markBuilding(live.id);
  assert.equal(await stage(live.id), "building", "a repeat is a no-op");
  await rows.markBuilding(intake.id);
  assert.equal(await stage(intake.id), "intake", "an intake project is never moved to building");
  assert.ok(!(await rows.listProvisioning()).some((p) => p.id === live.id));
  await rows.markBuilding(paused.id);
  assert.equal(await stage(paused.id), "provisioning", "a project paused during its run is not moved to building");
});

test("d3a budget record: the move to building writes one provision.budget_recorded audit row with the cap; a repeat or a non-move writes none", async () => {
  const rows = new PrismaProvisioningRows(db, 5000);
  const p = await mk({ stage: "provisioning", capUsd: "42.5" });
  const intake = await mk({});
  const budget = (id) => db.auditEvent.findMany({ where: { projectId: id, action: "provision.budget_recorded" } });
  await rows.markBuilding(p.id);
  await rows.markBuilding(p.id);
  const ev = await budget(p.id);
  assert.equal(ev.length, 1, "a repeat writes no second budget record");
  assert.equal(String(ev[0].actor), "system");
  assert.deepEqual(ev[0].details, { capUsd: "42.500000" });
  assert.equal(ev[0].summary, "Provisioned with a project budget cap of $42.50");
  await rows.markBuilding(intake.id);
  assert.equal((await budget(intake.id)).length, 0, "no move, no record");
});

test("d3a budget record: a failed audit insert rolls the move back, so the project stays in provisioning (pre-review L2)", async () => {
  const p = await mk({ stage: "provisioning", capUsd: "10" });
  // The real transaction, with an audit insert that fails after the stage update has run inside it.
  const failing = {
    $transaction: (fn, o) => db.$transaction((tx) => fn(new Proxy(tx, {
      get: (t, k) => (k === "auditEvent" ? { create: async () => { throw new Error("audit-insert-failed"); } } : t[k]),
    })), o),
  };
  await assert.rejects(new PrismaProvisioningRows(failing, 5000).markBuilding(p.id), /audit-insert-failed/);
  assert.equal(await stage(p.id), "provisioning", "the move to building is rolled back with its audit row");
  assert.equal(await db.auditEvent.count({ where: { projectId: p.id, action: "provision.budget_recorded" } }), 0);
  await new PrismaProvisioningRows(db, 5000).markBuilding(p.id);
  assert.equal(await stage(p.id), "building", "the next tick moves it");
});

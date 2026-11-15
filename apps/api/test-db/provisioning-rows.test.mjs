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

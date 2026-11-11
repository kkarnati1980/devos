// M2.6-a AT1–AT3 and AT9 on Postgres through the M1.1 Prisma client (linear-sync-db workflow), with an
// in-memory Linear standing in for the API.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDb } from "@devos/db";
import { syncProject, loadPlan, PrismaSyncStore } from "../dist/index.js";
import { fakeLinear } from "../test/fake-linear.mjs";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

async function seed() {
  const slug = `linear-${randomBytes(6).toString("hex")}`;
  const p = await db.project.create({ data: { slug, name: slug } });
  const m1 = await db.milestone.create({ data: { projectId: p.id, ordinal: 1, name: "Intake", gateName: "G1" } });
  const m2 = await db.milestone.create({ data: { projectId: p.id, ordinal: 2, name: "Build", gateName: "G2" } });
  const a = await db.module.create({ data: { projectId: p.id, milestoneId: m1.id, key: "M1.1", title: "Data", lane: 1, contractPath: "docs/modules/M1.1.md", status: "merged" } });
  const b = await db.module.create({ data: { projectId: p.id, milestoneId: m2.id, key: "M2.1", title: "API", lane: 2, contractPath: "docs/modules/M2.1.md" } });
  await db.moduleDependency.create({ data: { moduleId: b.id, dependsOnId: a.id } });
  await db.task.create({ data: { projectId: p.id, moduleId: b.id, kind: "human", assignee: "kk", title: "Create the key" } });
  await db.task.create({ data: { projectId: p.id, moduleId: a.id, kind: "build", title: "Schema", status: "done" } });
  return p.id;
}

test("AT9: resource_provider has the 'linear' value", async () => {
  const rows = await db.$queryRawUnsafe(`SELECT unnest(enum_range(NULL::resource_provider))::text AS v`);
  assert.ok(rows.some((r) => r.v === "linear"));
});

test("AT1/AT2 on Postgres: ids are stored (resource rows + linear_issue); a second sync writes nothing", async () => {
  const pid = await seed(); const L = fakeLinear(); const store = new PrismaSyncStore(db, pid);
  await syncProject(await loadPlan(db, pid), L.api, store);
  const res = await db.resource.findMany({ where: { projectId: pid, provider: "linear" } });
  assert.deepEqual(res.map((r) => r.kind).sort(), ["milestone", "milestone", "project"]);
  assert.ok((await db.module.findMany({ where: { projectId: pid } })).every((m) => m.linearIssue));
  assert.ok((await db.task.findMany({ where: { projectId: pid } })).every((t) => t.linearIssue));
  L.writes.length = 0;
  const r = await syncProject(await loadPlan(db, pid), L.api, store);
  assert.equal(r.writes, 0, JSON.stringify(L.writes));
});

test("AT3 on Postgres: an id lost before it was saved is adopted by marker; no duplicate resource rows", async () => {
  const pid = await seed(); const L = fakeLinear(); const store = new PrismaSyncStore(db, pid);
  await syncProject(await loadPlan(db, pid), L.api, store);
  await db.resource.deleteMany({ where: { projectId: pid, provider: "linear" } });
  await db.module.updateMany({ where: { projectId: pid }, data: { linearIssue: null } });
  await syncProject(await loadPlan(db, pid), L.api, store);
  assert.equal(L.projects.length, 1); assert.equal(L.issues.length, 4);
  assert.equal(await db.resource.count({ where: { projectId: pid, provider: "linear" } }), 3);
});

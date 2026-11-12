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

test("two concurrent locked syncs of one project: one runs, the other is skipped; one Linear project", async () => {
  const { syncProjectLocked, fencedApi } = await import("../dist/index.js");
  const pid = await seed(); const L = fakeLinear();
  let release; const gate = new Promise((r) => { release = r; });
  const first = syncProjectLocked(db, pid, async (plan, store, guard) => { await gate; return syncProject(plan, fencedApi(L.api, guard), store); });
  await new Promise((r) => setTimeout(r, 300));
  const second = await syncProjectLocked(db, pid, (plan, store) => syncProject(plan, L.api, store));
  release();
  assert.deepEqual(await first, { skipped: false });
  assert.deepEqual(second, { skipped: true });
  assert.equal(L.projects.length, 1);
});

test("Codex PR35-r1: a sync whose lock is about to expire makes no Linear write", async () => {
  const { syncProjectLocked, fencedApi, WRITE_MARGIN_MS } = await import("../dist/index.js");
  const pid = await seed(); const L = fakeLinear();
  let t = 1_000_000;
  const timeout = WRITE_MARGIN_MS + 5_000;
  await assert.rejects(syncProjectLocked(db, pid, async (plan, store, guard) => {
    t += 10_000; // the reads took 10 s: fewer than WRITE_MARGIN_MS left
    return syncProject(plan, fencedApi(L.api, guard), store);
  }, timeout, () => t), /linear-sync-lock-expiring/);
  assert.equal(L.projects.length, 0);
});

test("Codex PR35-r10: a slow lock probe is followed by a second margin check; no Linear write starts", async () => {
  const { syncProjectLocked, fencedApi, WRITE_MARGIN_MS } = await import("../dist/index.js");
  const pid = await seed(); const L = fakeLinear();
  // now() calls: 1 = the deadline, 2 = the guard's check before SELECT 1 (enough margin), 3 = after it. The probe
  // "took" long enough that less than WRITE_MARGIN_MS is left by call 3.
  const timeout = WRITE_MARGIN_MS + 20_000;
  let calls = 0;
  const now = () => (++calls >= 3 ? 1_000_000 + 30_000 : 1_000_000);
  await assert.rejects(syncProjectLocked(db, pid, (plan, store, guard) => syncProject(plan, fencedApi(L.api, guard), store), timeout, now), /linear-sync-lock-expiring/);
  assert.equal(L.projects.length, 0);
  assert.ok(calls >= 3);
});

test("Codex PR35-r4: an id write blocked by a row lock gives up within the bounded time instead of waiting past the sync lock", async () => {
  const pid = await seed();
  const mod = await db.module.findFirst({ where: { projectId: pid }, select: { id: true } });
  let release; const held = new Promise((r) => { release = r; });
  let locked; const isLocked = new Promise((r) => { locked = r; });
  const holder = db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT id FROM module WHERE id = $1::uuid FOR UPDATE`, mod.id);
    locked(); await held;
  }, { timeout: 60_000, maxWait: 10_000 });
  await isLocked;
  const store = new PrismaSyncStore(db, pid);
  const t0 = Date.now();
  await assert.rejects(store.setModuleIssue(mod.id, "issue-x"));
  const took = Date.now() - t0;
  release(); await holder;
  assert.ok(took < 20_000, `gave up after ${took} ms`);
  const row = await db.module.findUnique({ where: { id: mod.id }, select: { linearIssue: true } });
  assert.equal(row.linearIssue, null, "the blocked write never committed");
});

test("M2.6-b AT6 on Postgres: completeHumanTask marks only this project's open human task done, once, with an audit row", async () => {
  const pid = await seed();
  const human = await db.task.findFirst({ where: { projectId: pid, assignee: "kk" }, select: { id: true } });
  const agent = await db.task.create({ data: { projectId: pid, kind: "build", title: "Open agent task", status: "ready" } });
  // Another project's store, tried first while the human task is still open: the projectId guard alone must stop it.
  const other = new PrismaSyncStore(db, await seed());
  assert.equal(await other.completeHumanTask(human.id, "completed"), false);
  assert.notEqual((await db.task.findUnique({ where: { id: human.id } })).status, "done", "another project's store cannot touch this task");
  const store = new PrismaSyncStore(db, pid);
  assert.equal(await store.completeHumanTask(agent.id, "completed"), false);
  assert.equal((await db.task.findUnique({ where: { id: agent.id } })).status, "ready", "an agent task is never completed from Linear");
  assert.equal(await store.completeHumanTask(human.id, "canceled"), true);
  assert.equal(await store.completeHumanTask(human.id, "canceled"), false, "idempotent");
  assert.equal((await db.task.findUnique({ where: { id: human.id } })).status, "done");
  const audits = await db.auditEvent.findMany({ where: { action: { startsWith: "task." }, details: { path: ["taskId"], equals: human.id } } });
  assert.equal(audits.length, 1); assert.equal(audits[0].action, "task.canceled_in_linear"); assert.equal(audits[0].actor, "kk"); assert.equal(audits[0].projectId, pid);
});

test("M2.6-b AT6 end to end on Postgres: KK completes the human task in Linear; one sync makes it done", async () => {
  const pid = await seed(); const L = fakeLinear(); const store = new PrismaSyncStore(db, pid);
  await syncProject(await loadPlan(db, pid), L.api, store);
  L.issues.find((i) => i.title === "Create the key").stateId = "s-c";
  const r = await syncProject(await loadPlan(db, pid), L.api, store);
  assert.equal(r.inbound.length, 1);
  const t = await db.task.findFirst({ where: { projectId: pid, assignee: "kk" } });
  assert.equal(t.status, "done");
});

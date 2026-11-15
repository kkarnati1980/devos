// DEVOS-225 (M2.4-d2, docs/modules/M2.4.md "M2.4-d2 decisions"): PrismaProvisionReader against real Postgres
// (pre-review L2): the step read, its order, and the retry's locked stage check with its audit row.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDb } from "@devos/db";
import { PrismaProvisionReader } from "../dist/provision-routes.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

const mk = async (data) => {
  const slug = `m24d2-${randomBytes(4).toString("hex")}`;
  return db.project.create({ data: { slug, name: `Project ${slug}`, ...data } });
};
const audits = (projectId) => db.auditEvent.count({ where: { projectId, action: "provision.retry" } });

test("d2 reader: project by id and slug, steps ordered by key with enums as text", async () => {
  const r = new PrismaProvisionReader(db, 5000);
  const p = await mk({ stage: "provisioning" });
  await db.provisionStep.create({ data: { projectId: p.id, key: "github/repo", provider: "github", kind: "repo", status: "done", attempts: 1 } });
  await db.provisionStep.create({ data: { projectId: p.id, key: "coolify/project", provider: "coolify", kind: "project", status: "failed", attempts: 2, lastError: "provider_error: boom" } });
  assert.deepEqual(await r.project(p.id), { id: p.id, stage: "provisioning" });
  assert.deepEqual(await r.projectBySlug(p.slug), { id: p.id, stage: "provisioning" });
  assert.equal(await r.project("00000000-0000-4000-8000-000000000000"), null);
  assert.equal(await r.projectBySlug(`missing-${randomBytes(3).toString("hex")}`), null);
  const steps = await r.steps(p.id);
  assert.deepEqual(steps.map((s) => s.key), ["coolify/project", "github/repo"]);
  assert.equal(steps[0].provider, "coolify");
  assert.equal(steps[0].status, "failed");
  assert.equal(steps[0].lastError, "provider_error: boom");
  assert.ok(steps[0].updatedAt instanceof Date);
});

test("d2 reader: recordRetry writes one audit row only while the project is in provisioning", async () => {
  const r = new PrismaProvisionReader(db, 5000);
  const live = await mk({ stage: "provisioning" });
  const intake = await mk({});
  assert.equal(await r.recordRetry(live.id), true);
  assert.equal(await audits(live.id), 1);
  const row = await db.auditEvent.findFirst({ where: { projectId: live.id, action: "provision.retry" } });
  assert.equal(String(row.actor), "kk");
  assert.equal(await r.recordRetry(intake.id), false);
  assert.equal(await audits(intake.id), 0, "no audit row outside provisioning");
});

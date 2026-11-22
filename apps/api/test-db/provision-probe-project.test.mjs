// DEVOS-21 (M2.4, docs/modules/M2.4.md "AT13 probe row on the real schema"): ensureProbeProject against real
// Postgres. The first server run (aace3de, 22 Nov 2026) failed `probe-error` because the probe row's cap of 0 broke
// the `project_cap_positive` CHECK; the fake DB in test/provision-probe.test.mjs has no CHECKs, so this runs the
// create, the adopt and the cycle start on the migrated schema.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "@devos/db";
import { ensureProbeProject, PROBE_SLUG } from "../dist/provision-probe.js";
import { probeCycleStart } from "../dist/provision-probe-purge.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

test("AT13 probe row: created paused with a positive cap on the real schema, adopted again, cycle start runs", async () => {
  const now = new Date();
  const p = await ensureProbeProject(db, now, 5000);
  const row = await db.project.findUnique({ where: { id: p.id }, select: { slug: true, capUsd: true, pausedAt: true, stage: true } });
  assert.equal(row.slug, PROBE_SLUG);
  assert.equal(row.capUsd.toString(), "0.000001");
  assert.ok(Number(row.capUsd) > 0, "the project_cap_positive CHECK holds");
  assert.ok(row.pausedAt, "paused from creation, so the sweep never lists it");
  assert.equal(String(row.stage), "intake");
  assert.equal(await db.auditEvent.count({ where: { projectId: p.id, action: "provision.probe_started" } }), 1);

  // A second call adopts the same row and writes no second started row.
  const again = await ensureProbeProject(db, now, 5000);
  assert.equal(again.id, p.id);
  assert.equal(await db.auditEvent.count({ where: { projectId: p.id, action: "provision.probe_started" } }), 1);

  // The cycle start reads the real row: blocked without a grant, ready with one (no resources yet).
  assert.deepEqual(await probeCycleStart(db, p.id, 5000, async () => false), { blocked: "probe-purge-not-approved" });
  assert.equal(await probeCycleStart(db, p.id, 5000, async () => true), "ready");
});

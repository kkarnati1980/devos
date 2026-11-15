// M2.4-d3a (docs/modules/M2.4.md "M2.4-d3a decisions"): the backup_schedule/nightly record and its teardown ops.
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, backupScheduleStep, backupScheduleOps, backupScheduleId, runProvision, allowAll, StepError } from "../dist/index.js";

const P = { id: "11111111-2222-4333-8444-555555555555", slug: "acme" };
const Q = { id: "22222222-2222-4333-8444-555555555555", slug: "beta" };

test("AT1/AT2 d3a: the backup record is created once, recorded under the project, and a re-run adds nothing", async () => {
  const store = new MemoryStore();
  const out = await runProvision(P.id, [backupScheduleStep(store, P)], { store, authorize: allowAll });
  assert.deepEqual(out, [{ key: "backup_schedule/nightly", externalId: `${P.id}/live`, outcome: "created" }]);
  assert.deepEqual(store.resources.map((r) => [r.projectId, r.provider, r.kind, r.externalId, r.name]),
    [[P.id, "backup_schedule", "nightly", `${P.id}/live`, "acme/live"]]);
  const again = await runProvision(P.id, [backupScheduleStep(store, P)], { store, authorize: allowAll });
  assert.equal(again[0].outcome, "recorded");
  assert.equal(store.resources.length, 1);
  // AT3 shape: the journal is lost after the record was written; the re-run adopts the row, no second row.
  const fresh = new MemoryStore();
  fresh.resources.push(...store.resources);
  const adopted = await runProvision(P.id, [backupScheduleStep(fresh, P)], { store: fresh, authorize: allowAll });
  assert.equal(adopted[0].outcome, "adopted");
  assert.equal(fresh.resources.length, 1);
});

test("d3a: two projects get distinct records; another project's row is never adopted", async () => {
  const store = new MemoryStore();
  await runProvision(P.id, [backupScheduleStep(store, P)], { store, authorize: allowAll });
  await runProvision(Q.id, [backupScheduleStep(store, Q)], { store, authorize: allowAll });
  assert.deepEqual(store.resources.map((r) => r.externalId).sort(), [backupScheduleId(P.id), backupScheduleId(Q.id)].sort());
  // Pre-review L2: with only Q's row present, P's lookup ignores it, even under the same name.
  const only = new MemoryStore();
  only.resources.push({ projectId: Q.id, provider: "backup_schedule", kind: "nightly", externalId: backupScheduleId(P.id), name: "acme/live" });
  assert.equal(await backupScheduleStep(only, P).lookup(), null);
  await assert.rejects(runProvision(P.id, [backupScheduleStep(only, P)], { store: only, authorize: allowAll }),
    (e) => e instanceof StepError && e.code === "resource_owned_elsewhere");
});

test("AT12 shape d3a: a deny on provision.backup_schedule.nightly records nothing and counts no attempt", async () => {
  const store = new MemoryStore();
  const seen = [];
  await assert.rejects(runProvision(P.id, [backupScheduleStep(store, P)], { store, authorize: async (a) => { seen.push(a); return "deny"; } }),
    (e) => e instanceof StepError && e.code === "policy_denied" && e.countsAsAttempt === false);
  assert.deepEqual(seen, ["provision.backup_schedule.nightly"]);
  assert.equal(store.resources.length, 0);
});

test("d3a: a bad slug or project id is refused before any step runs", () => {
  const store = new MemoryStore();
  assert.throws(() => backupScheduleStep(store, { id: P.id, slug: "Bad/Slug" }), /slug-invalid/);
  assert.throws(() => backupScheduleStep(store, { id: "not-a-uuid", slug: "acme" }), /project-id-invalid/);
});

test("d3a teardown ops: nothing exists at a provider, so inspect reports gone; a malformed row stops the purge", async () => {
  const ops = backupScheduleOps();
  assert.equal(ops.provider, "backup_schedule");
  assert.equal(ops.kind, "nightly");
  const item = { provider: "backup_schedule", kind: "nightly", externalId: `${P.id}/live`, name: "acme/live" };
  assert.equal(await ops.inspect(item), null);
  await ops.remove(item);
  for (const bad of [`${P.id}/preview`, "x/live", `${P.id}/live/extra`, P.id]) {
    await assert.rejects(ops.inspect({ ...item, externalId: bad }), /backup-schedule-id-invalid/, bad);
  }
  await assert.rejects(ops.inspect({ ...item, name: "../live" }), /backup-schedule-id-invalid/);
});

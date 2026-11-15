// M2.4-d3a (docs/modules/M2.4.md, decision 9 and "M2.4-d3a decisions"): the `backup_schedule/nightly` record.
// The record lives in the DevOS inventory only: no provider call. Its meaning is fixed by its kind: a nightly dump
// of the live stack's database, kept on the server until M4.5 adds the off-site target (R2, H7 DEVOS-34).
// The S3 core stack has no database, so no Coolify scheduled backup is set here; the database add-on (M3.2) does
// that when it adds one (follow-up filed on DEVOS-226).

import type { InventoryItem, ResourceOps } from "./teardown-ops.js";
import type { ProvisionStore, StepSpec } from "./runner.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The record's external id: the project id plus the stack, so it can never collide with another project's row. */
export const backupScheduleId = (projectId: string): string => `${projectId}/live`;

/**
 * Create-or-get the nightly backup record. Lookup = this project's active inventory row with the deterministic name
 * `<slug>/live`; create = the inventory row itself (the runner records it), after the policy check and the
 * runner's lock re-check, like every other step.
 */
export function backupScheduleStep(store: ProvisionStore, p: { id: string; slug: string }): StepSpec {
  if (!SLUG_RE.test(p.slug)) throw new Error("slug-invalid");
  if (!UUID_RE.test(p.id)) throw new Error("project-id-invalid");
  const name = `${p.slug}/live`;
  const externalId = backupScheduleId(p.id);
  return {
    key: "backup_schedule/nightly",
    provider: "backup_schedule",
    kind: "nightly",
    name,
    action: "provision.backup_schedule.nightly",
    lookup: async () => {
      const mine = (await store.listResources("backup_schedule", "nightly")).find((r) => r.projectId === p.id && r.externalId === externalId && r.active);
      return mine ? { externalId, name: mine.name, owned: true } : null;
    },
    create: async () => ({ externalId, name, owned: true }),
  };
}

/**
 * Teardown ops for the record (M2.5): nothing exists at a provider, so `inspect` reports nothing to delete and the
 * purge only marks the row deleted. An id that is not this record's shape stops the purge (never guessed).
 */
export function backupScheduleOps(): ResourceOps {
  return {
    provider: "backup_schedule",
    kind: "nightly",
    inspect: async (item: InventoryItem) => {
      const [id, stack, ...rest] = item.externalId.split("/");
      if (rest.length || stack !== "live" || !id || !UUID_RE.test(id) || !/^[a-z0-9][a-z0-9-]{0,62}\/live$/.test(item.name)) {
        throw new Error("backup-schedule-id-invalid");
      }
      return null;
    },
    remove: async () => {},
  };
}

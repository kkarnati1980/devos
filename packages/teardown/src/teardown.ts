// M2.5-a teardown core (docs/modules/M2.5.md): Archive, Restore, Purge over the M2.4 inventory, then the
// leftover scan. Purge is reachable only with a policy `allow` for `teardown.purge` (default require_approval:
// KK's approved purge card supplies the grant). A row is marked deleted only after the provider confirms, so a
// crash at any point leaves the rest `active` and a re-run continues (decision 5).

import { ProviderError, type InventoryItem, type LeftoverHit, type LeftoverScanner, type ResourceOps } from "@devos/provision";

export type Stage = string;

export interface TeardownProject {
  id: string;
  slug: string;
  stage: Stage;
  /** The stage before Archive, restored by Restore. */
  previousStage: Stage | null;
  archivedAt: Date | null;
  purgeAfter: Date | null;
}

export interface ActiveResource extends InventoryItem {
  /** Inventory row id. */
  id: string;
}

export interface ScanReport {
  projectId: string;
  scannedAt: string;
  hits: LeftoverHit[];
  /** Scanners that failed; a failed scanner makes the report not clean. */
  errors: { scanner: string; error: string }[];
}

export interface TeardownStore {
  /** Same lock as provisioning (decision 5): provisioning and teardown of one project never interleave. */
  withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T>;
  assertLockHeld(projectId: string): Promise<void>;
  project(projectId: string): Promise<TeardownProject | null>;
  /** stage → archived, remembering the previous stage; sets archived_at and purge_after. */
  markArchived(projectId: string, at: Date, purgeAfter: Date): Promise<void>;
  /** stage → previous stage; clears archived_at and purge_after. */
  markRestored(projectId: string): Promise<void>;
  /** The project's active inventory rows, oldest first. */
  activeResources(projectId: string): Promise<ActiveResource[]>;
  markResourceDeleted(resourceId: string, at: Date): Promise<void>;
  /** Removes the project's `provision_step` rows (M2.4 hand-off: no stale `done` rows after a purge). */
  resetSteps(projectId: string): Promise<void>;
  saveScan(projectId: string, report: ScanReport): Promise<void>;
  markPurged(projectId: string): Promise<void>;
}

export type TeardownErrorCode =
  | "project_not_found"
  | "not_archived"
  | "already_archived"
  | "policy_denied"
  | "approval_required"
  | "ownership_mismatch"
  | "unsupported_resource"
  | "delete_unconfirmed"
  | "provider_forbidden"
  | "provider_error"
  | "scan_incomplete";

export class TeardownError extends Error {
  constructor(
    public readonly code: TeardownErrorCode,
    public readonly retryable: boolean,
    message: string,
    /** The resource the error is about, if any (never a secret: provider, kind, external id, name). */
    public readonly resource?: Pick<InventoryItem, "provider" | "kind" | "externalId" | "name">,
  ) {
    super(message);
    this.name = "TeardownError";
  }
}

export type Authorize = (action: string, resource: string) => Promise<"allow" | "deny" | "require_approval">;

export interface TeardownOptions {
  store: TeardownStore;
  /** ADR-0006: required; every external write is checked. */
  authorize: Authorize;
  /** Ops by `provider/kind`. A resource kind with no ops stops the purge (`unsupported_resource`). */
  ops: ResourceOps[];
  now?: () => number;
}

export interface ArchiveOptions extends TeardownOptions {
  /** Archive window in days (setting; default 30). */
  windowDays?: number;
  /** Stops the project's queued and running work (M1.5 cancel) before anything is archived; wired in M2.5-b. */
  cancelRuns?: (projectId: string) => Promise<void>;
}

export interface PurgeOptions extends TeardownOptions {
  scanners: LeftoverScanner[];
  /** Checks run after the policy check and before any delete (e.g. the GitHub token scope, M2.5-a2). */
  preflight?: (() => Promise<void>)[];
}

export interface PurgeResult {
  deleted: number;
  report: ScanReport;
  purged: boolean;
}

const DAY_MS = 86_400_000;
/** Deletion order across providers: the GitHub repo goes last (decision table); within a rank, newest first. */
const RANK: Record<string, number> = { coolify: 0, vault: 1, backup_schedule: 2, r2: 3, cloudflare: 4, github: 9 };

const opsKey = (provider: string, kind: string): string => `${provider}/${kind}`;

function opsMap(list: ResourceOps[]): Map<string, ResourceOps> {
  const m = new Map<string, ResourceOps>();
  for (const o of list) {
    const k = opsKey(o.provider, o.kind);
    if (m.has(k)) throw new Error(`duplicate teardown ops: ${k}`);
    m.set(k, o);
  }
  return m;
}

const describe = (r: InventoryItem): string => `${r.provider} ${r.kind} ${r.name}`;
const pick = (r: InventoryItem) => ({ provider: r.provider, kind: r.kind, externalId: r.externalId, name: r.name });

async function check(opts: TeardownOptions, action: string, projectId: string): Promise<void> {
  if (typeof opts.authorize !== "function") throw new Error("teardown: authorize is required (ADR-0006)");
  const d = await opts.authorize(action, `project:${projectId}`);
  if (d === "allow") return;
  throw new TeardownError(d === "deny" ? "policy_denied" : "approval_required", false,
    `${action} is ${d === "deny" ? "denied by policy" : "waiting for KK's approval"}`);
}

/** Maps a provider failure on a write to a teardown error (decision 4, decision 9). */
function writeError(e: unknown, what: string, r: InventoryItem): TeardownError {
  if (e instanceof ProviderError && e.code === "http" && (e.status === 401 || e.status === 403)) {
    return new TeardownError("provider_forbidden", false, `${what} of ${describe(r)} was refused by ${r.provider}: the token lacks the permission`, pick(r));
  }
  if (e instanceof ProviderError && e.transient) {
    return new TeardownError("provider_error", true, `${what} of ${describe(r)} failed (${e.code}); safe to retry`, pick(r));
  }
  const msg = e instanceof ProviderError ? e.message : "unexpected error";
  return new TeardownError("provider_error", false, `${what} of ${describe(r)} failed: ${msg}`, pick(r));
}

async function inspect(ops: ResourceOps, r: InventoryItem): Promise<{ owned: boolean } | null> {
  try {
    return await ops.inspect(r);
  } catch (e) {
    throw writeError(e, "lookup", r);
  }
}

async function loadProject(store: TeardownStore, projectId: string): Promise<TeardownProject> {
  const p = await store.project(projectId);
  if (!p) throw new TeardownError("project_not_found", false, "project not found");
  return p;
}

/**
 * Archive (reversible): cancel the project's runs, archive every owned resource that has an archive op (the
 * GitHub repo becomes read-only), then stage → archived with purge_after = now + window. Nothing is deleted.
 */
export async function archiveProject(projectId: string, opts: ArchiveOptions): Promise<{ archivedAt: Date; purgeAfter: Date }> {
  const windowDays = opts.windowDays ?? 30;
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) throw new Error("archive window must be 1–365 days");
  const map = opsMap(opts.ops);
  return opts.store.withProjectLock(projectId, async () => {
    const p = await loadProject(opts.store, projectId);
    if (p.stage === "archived" || p.stage === "purged") throw new TeardownError("already_archived", false, `project is already ${p.stage}`);
    await check(opts, "teardown.archive", projectId);
    await opts.cancelRuns?.(projectId);
    // Pre-review finding 3: prove ownership of every resource before the first write, so a mismatch never
    // leaves the project half archived.
    const todo: { r: ActiveResource; ops: ResourceOps }[] = [];
    for (const r of await opts.store.activeResources(projectId)) {
      const ops = map.get(opsKey(r.provider, r.kind));
      if (!ops?.archive) continue;
      const got = await inspect(ops, r);
      if (!got) continue;
      if (!got.owned) throw new TeardownError("ownership_mismatch", false, `${describe(r)} no longer carries this project's marker; not touched`, pick(r));
      todo.push({ r, ops });
    }
    for (const { r, ops } of todo) {
      await opts.store.assertLockHeld(projectId);
      try {
        await ops.archive!(r);
      } catch (e) {
        throw writeError(e, "archive", r);
      }
    }
    const at = new Date((opts.now ?? Date.now)());
    const purgeAfter = new Date(at.getTime() + windowDays * DAY_MS);
    await opts.store.markArchived(projectId, at, purgeAfter);
    return { archivedAt: at, purgeAfter };
  });
}

/** Restore: un-archive what Archive archived and move the stage back. Stacks stay stopped until the next deploy. */
export async function restoreProject(projectId: string, opts: TeardownOptions): Promise<void> {
  const map = opsMap(opts.ops);
  await opts.store.withProjectLock(projectId, async () => {
    const p = await loadProject(opts.store, projectId);
    if (p.stage !== "archived") throw new TeardownError("not_archived", false, `project is ${p.stage}, not archived`);
    await check(opts, "teardown.restore", projectId);
    // Pre-review finding 3: prove ownership of every resource before the first write, so a mismatch never
    // leaves the project half restored.
    const todo: { r: ActiveResource; ops: ResourceOps }[] = [];
    for (const r of await opts.store.activeResources(projectId)) {
      const ops = map.get(opsKey(r.provider, r.kind));
      if (!ops?.unarchive) continue;
      const got = await inspect(ops, r);
      if (!got) continue;
      if (!got.owned) throw new TeardownError("ownership_mismatch", false, `${describe(r)} no longer carries this project's marker; not touched`, pick(r));
      todo.push({ r, ops });
    }
    for (const { r, ops } of todo) {
      await opts.store.assertLockHeld(projectId);
      try {
        await ops.unarchive!(r);
      } catch (e) {
        throw writeError(e, "restore", r);
      }
    }
    await opts.store.markRestored(projectId);
  });
}

/** Runs every scanner; a scanner that fails is recorded, and a report with errors is never clean. */
export async function scanLeftovers(project: { id: string; slug: string }, scanners: LeftoverScanner[], now: () => number = Date.now): Promise<ScanReport> {
  const hits: LeftoverHit[] = [];
  const errors: { scanner: string; error: string }[] = [];
  for (const s of scanners) {
    try {
      hits.push(...(await s.scan(project)));
    } catch (e) {
      const msg = e instanceof ProviderError ? e.message : e instanceof Error ? e.message : "scan failed";
      errors.push({ scanner: s.name, error: msg.slice(0, 200) });
    }
  }
  return { projectId: project.id, scannedAt: new Date(now()).toISOString(), hits, errors };
}

/**
 * Purge (irreversible; decision 1): only an archived project, only with a policy `allow` for `teardown.purge`.
 * Deletes every active inventory row's resource (GitHub repo last), each only after proving ownership (decision 3),
 * marks each row deleted after the provider confirms, resets the step journal, then scans. `purged` only at 0 hits.
 */
export async function purgeProject(projectId: string, opts: PurgeOptions): Promise<PurgeResult> {
  const map = opsMap(opts.ops);
  const now = opts.now ?? Date.now;
  return opts.store.withProjectLock(projectId, async () => {
    const p = await loadProject(opts.store, projectId);
    if (p.stage !== "archived") throw new TeardownError("not_archived", false, `project is ${p.stage}; archive it before a purge`);
    await check(opts, "teardown.purge", projectId);
    const rows = (await opts.store.activeResources(projectId))
      .map((r, i) => ({ r, i }))
      .sort((a, b) => (RANK[a.r.provider] ?? 5) - (RANK[b.r.provider] ?? 5) || b.i - a.i)
      .map((x) => x.r);
    // Every row must have ops before anything is deleted: a half purge that stops on an unknown kind is worse.
    for (const r of rows) {
      if (!map.has(opsKey(r.provider, r.kind))) throw new TeardownError("unsupported_resource", false, `no teardown for ${r.provider} ${r.kind} yet`, pick(r));
    }
    // Codex PR48-r1: the leftover scan must be independent and complete (decision 6), or `purged` could be claimed
    // without looking. Required: the inventory scanner, plus one scanner per provider that has teardown ops or rows.
    const names = new Set(opts.scanners.map((x) => x.name));
    const needed = new Set(["inventory", ...opts.ops.map((o) => o.provider), ...rows.map((r) => r.provider)]);
    const missing = [...needed].filter((n) => !names.has(n)).sort();
    if (missing.length) throw new TeardownError("scan_incomplete", false, `purge needs leftover scanners for: ${missing.join(", ")}`);
    for (const check of opts.preflight ?? []) {
      try {
        await check();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "preflight failed";
        throw new TeardownError("provider_forbidden", false, `purge preflight: ${msg.slice(0, 200)}`);
      }
    }
    // Pre-review finding 1: reset the step journal before the first delete, so a purge that stops half way (then
    // Restore) can never leave a stale `done` step for a resource that is gone. Safe under the shared lock:
    // provisioning always looks a resource up before trusting or creating it.
    await opts.store.resetSteps(projectId);
    let deleted = 0;
    for (const r of rows) {
      const ops = map.get(opsKey(r.provider, r.kind))!;
      const before = await inspect(ops, r);
      if (before) {
        if (!before.owned) throw new TeardownError("ownership_mismatch", false, `${describe(r)} no longer carries this project's marker; not deleted`, pick(r));
        await opts.store.assertLockHeld(projectId);
        try {
          await ops.remove(r);
        } catch (e) {
          if (!(e instanceof ProviderError && e.transient)) throw writeError(e, "delete", r);
          // Outcome unknown (timeout/5xx): look again; never a second delete in this run (decision 4).
          if (await inspect(ops, r)) {
            throw new TeardownError("delete_unconfirmed", true, `delete of ${describe(r)} not confirmed; the next purge run retries it`, pick(r));
          }
        }
        deleted++;
      }
      await opts.store.markResourceDeleted(r.id, new Date(now()));
    }
    const report = await scanLeftovers({ id: p.id, slug: p.slug }, opts.scanners, now);
    await opts.store.saveScan(projectId, report);
    const purged = report.hits.length === 0 && report.errors.length === 0;
    if (purged) await opts.store.markPurged(projectId);
    return { deleted, report, purged };
  });
}

/** The inventory as a leftover source (decision 6): any still-active row is a hit. */
export function inventoryScanner(store: Pick<TeardownStore, "activeResources">): LeftoverScanner {
  return {
    name: "inventory",
    scan: async (p) => (await store.activeResources(p.id)).map((r) => ({ provider: r.provider, kind: `inventory:${r.kind}`, externalId: r.externalId, name: r.name })),
  };
}

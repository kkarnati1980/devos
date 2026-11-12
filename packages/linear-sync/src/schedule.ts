// M2.6-b2a (DEVOS-156, AT8): the scheduled Linear sync. Every interval (10 minutes by default) the job reads the
// active projects (not archived, not purged) and syncs them one after another; each project's sync runs under its
// own advisory lock (`syncProjectLocked`), so it never overlaps a sync of the same project from another worker or
// the on-demand trigger. One project's failure is logged and does not stop the others. Ticks never overlap: the
// next one is armed only after the current one finishes.
import { bounded, fencedApi, syncProjectLocked, type PrismaLike } from "./prisma-store.js";
import { syncProject, type SyncOptions } from "./sync.js";
import type { LinearApi } from "./types.js";

export const SYNC_INTERVAL_MS = 10 * 60_000;
/** Stages whose projects the scheduled job skips (AT8). */
export const INACTIVE_STAGES = ["archived", "purged"] as const;

/** Active projects, oldest first: not in an inactive stage and not archived. One bounded read (ADR-0011 §9). */
export async function listActiveProjects(db: PrismaLike): Promise<string[]> {
  const rows: { id: string }[] = await bounded(db, (tx) => tx.project.findMany({
    where: { stage: { notIn: [...INACTIVE_STAGES] }, archivedAt: null },
    select: { id: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  }));
  return rows.map((r) => r.id);
}

/** `skipped`: another holder has the project's lock. `inactive`: archived or purged after the list was read. */
export type ProjectOutcome = "synced" | "skipped" | "inactive" | "failed";
export interface SweepResult { synced: string[]; skipped: string[]; inactive: string[]; failed: { projectId: string; error: string }[] }

export interface SweepDeps {
  list: () => Promise<string[]>;
  /** Sync one project; resolves `skipped` when another holder has its lock, `inactive` when it was archived or purged. */
  syncOne: (projectId: string) => Promise<Exclude<ProjectOutcome, "failed">>;
  log?: (line: string) => void;
}

/** One pass over the active projects, strictly one project at a time. */
export async function syncActiveProjects(deps: SweepDeps): Promise<SweepResult> {
  const out: SweepResult = { synced: [], skipped: [], inactive: [], failed: [] };
  for (const projectId of await deps.list()) {
    try {
      const r = await deps.syncOne(projectId);
      out[r].push(projectId);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      out.failed.push({ projectId, error });
      deps.log?.(`linear-sync: project ${projectId} failed: ${error}`);
    }
  }
  return out;
}

/**
 * The production `syncOne`: plan read, fenced Linear writes and fenced id writes under the project's lock. The
 * project's stage is read again under the lock, so a project archived or purged after the sweep listed it is not
 * synced (pre-review). Each sync's divergence log and inbound completions go to `log`.
 */
export function lockedSyncOne(db: PrismaLike, api: LinearApi, opts: SyncOptions & { log?: (line: string) => void } = {}): SweepDeps["syncOne"] {
  const { log, ...syncOpts } = opts;
  return async (projectId) => {
    let inactive = false;
    const r = await syncProjectLocked(db, projectId, async (plan, store, guard) => {
      if (!(await isActive(db, projectId))) { inactive = true; return; }
      const res = await syncProject(plan, fencedApi(api, guard), store, syncOpts);
      for (const line of res.log) log?.(`linear-sync: project ${projectId}: ${line}`);
      for (const line of res.inbound) log?.(`linear-sync: project ${projectId} inbound: ${line}`);
    });
    if (r.skipped) return "skipped";
    return inactive ? "inactive" : "synced";
  };
}

async function isActive(db: PrismaLike, projectId: string): Promise<boolean> {
  const p: { stage: string; archivedAt: Date | null } | null = await bounded(db, (tx) => tx.project.findUnique({ where: { id: projectId }, select: { stage: true, archivedAt: true } }));
  return !!p && !(INACTIVE_STAGES as readonly string[]).includes(p.stage) && p.archivedAt === null;
}

export interface Schedule { stop: () => Promise<void> }

/**
 * Run `tick` `intervalMs` after the previous tick ended (so ticks never overlap; the period is the interval plus
 * the sweep's own time), the first one interval after the start. A tick that throws is logged; the schedule keeps going.
 * `stop()` cancels the next tick and resolves once a running tick has finished.
 */
export function startSchedule(tick: () => Promise<unknown>, opts: { intervalMs?: number; log?: (line: string) => void } = {}): Schedule {
  const intervalMs = opts.intervalMs ?? SYNC_INTERVAL_MS;
  if (!(intervalMs > 0)) throw new Error("linear-sync: schedule interval must be positive");
  let stopped = false;
  let running: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      running = (async () => {
        try { await tick(); } catch (e) { opts.log?.(`linear-sync: scheduled tick failed: ${e instanceof Error ? e.message : String(e)}`); }
      })().finally(() => { running = null; arm(); });
    }, intervalMs);
  };
  arm();
  return {
    stop: async () => {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (running) await running;
    },
  };
}

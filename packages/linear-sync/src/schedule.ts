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

export type ProjectOutcome = "synced" | "skipped" | "failed";
export interface SweepResult { synced: string[]; skipped: string[]; failed: { projectId: string; error: string }[] }

export interface SweepDeps {
  list: () => Promise<string[]>;
  /** Sync one project; resolves `skipped` when another holder has its lock. */
  syncOne: (projectId: string) => Promise<Exclude<ProjectOutcome, "failed">>;
  log?: (line: string) => void;
}

/** One pass over the active projects, strictly one project at a time. */
export async function syncActiveProjects(deps: SweepDeps): Promise<SweepResult> {
  const out: SweepResult = { synced: [], skipped: [], failed: [] };
  for (const projectId of await deps.list()) {
    try {
      const r = await deps.syncOne(projectId);
      (r === "skipped" ? out.skipped : out.synced).push(projectId);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      out.failed.push({ projectId, error });
      deps.log?.(`linear-sync: project ${projectId} failed: ${error}`);
    }
  }
  return out;
}

/** The production `syncOne`: plan read, fenced Linear writes and fenced id writes under the project's lock. */
export function lockedSyncOne(db: PrismaLike, api: LinearApi, opts: SyncOptions = {}): SweepDeps["syncOne"] {
  return async (projectId) => {
    const r = await syncProjectLocked(db, projectId, (plan, store, guard) => syncProject(plan, fencedApi(api, guard), store, opts));
    return r.skipped ? "skipped" : "synced";
  };
}

export interface Schedule { stop: () => Promise<void> }

/**
 * Run `tick` every `intervalMs`, first after one interval. A tick that throws is logged; the schedule keeps going.
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

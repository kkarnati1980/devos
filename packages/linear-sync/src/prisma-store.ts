// M2.6-a: the DevOS side of the sync over the M1.1 Prisma client (@devos/db createDb). Typed structurally so
// this package has no runtime dependency on the generated client (same pattern as @devos/policy).
// Linear project and milestone ids are resource rows (provider 'linear'); module/task issues use linear_issue.
import type { DevosPlan, LinearApi, SyncStore } from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Delegate = any;
export interface PrismaLike {
  project: Delegate; milestone: Delegate; module: Delegate; moduleDependency: Delegate; task: Delegate; resource: Delegate;
  $transaction<T>(fn: (tx: any) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T>;
}

const RES = (kind: "project" | "milestone") => ({ provider: "linear", kind });

/** Read the plan of one project, with the Linear ids already known. */
export async function loadPlan(db: PrismaLike, projectId: string): Promise<DevosPlan> {
  const p = await db.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
  if (!p) throw new Error("linear-sync: project not found");
  const [milestones, modules, tasks, resources] = await Promise.all([
    db.milestone.findMany({ where: { projectId }, orderBy: { ordinal: "asc" }, select: { id: true, ordinal: true, name: true, gateName: true } }),
    db.module.findMany({ where: { projectId }, orderBy: { key: "asc" }, select: { id: true, milestoneId: true, key: true, title: true, lane: true, contractPath: true, status: true, linearIssue: true } }),
    db.task.findMany({ where: { projectId }, orderBy: { createdAt: "asc" }, select: { id: true, moduleId: true, title: true, kind: true, assignee: true, status: true, linearIssue: true } }),
    db.resource.findMany({ where: { projectId, provider: "linear", status: "active" }, select: { kind: true, externalId: true, name: true } }),
  ]);
  const moduleIds = modules.map((m: { id: string }) => m.id);
  const dependencies = moduleIds.length
    ? await db.moduleDependency.findMany({ where: { moduleId: { in: moduleIds } }, select: { moduleId: true, dependsOnId: true } })
    : [];
  // Resource rows name what they mirror: the project row's name is the project id, a milestone row's is the milestone id.
  const res = (kind: string, name: string) => resources.find((r: { kind: string; name: string }) => r.kind === kind && r.name === name)?.externalId ?? null;
  return {
    project: { id: p.id, name: p.name, linearProjectId: res("project", p.id) },
    milestones: milestones.map((m: any) => ({ ...m, linearMilestoneId: res("milestone", m.id) })),
    modules, dependencies, tasks,
  };
}

export class PrismaSyncStore implements SyncStore {
  constructor(private readonly db: PrismaLike, private readonly projectId: string) {}

  private async upsertResource(kind: "project" | "milestone", name: string, externalId: string) {
    const existing = await this.db.resource.findFirst({ where: { projectId: this.projectId, ...RES(kind), name, status: "active" }, select: { id: true, externalId: true } });
    if (existing?.externalId === externalId) return;
    // The same Linear object may have a soft-deleted row (resource is unique on provider + kind + external id): reuse it.
    const prior = await this.db.resource.findFirst({ where: { ...RES(kind), externalId }, select: { id: true, projectId: true } });
    if (prior && prior.projectId === this.projectId) {
      if (existing) await this.db.resource.update({ where: { id: existing.id }, data: { status: "deleted", deletedAt: new Date() } });
      await this.db.resource.update({ where: { id: prior.id }, data: { status: "active", deletedAt: null, name } });
      return;
    }
    if (existing) await this.db.resource.update({ where: { id: existing.id }, data: { externalId } });
    else await this.db.resource.create({ data: { projectId: this.projectId, ...RES(kind), name, externalId } });
  }
  setProjectId(projectId: string, linearProjectId: string) { return this.upsertResource("project", projectId, linearProjectId); }
  setMilestoneId(milestoneId: string, linearMilestoneId: string) { return this.upsertResource("milestone", milestoneId, linearMilestoneId); }
  async setModuleIssue(moduleId: string, issueId: string) { await this.db.module.update({ where: { id: moduleId }, data: { linearIssue: issueId } }); }
  async setTaskIssue(taskId: string, issueId: string) { await this.db.task.update({ where: { id: taskId }, data: { linearIssue: issueId } }); }
}

/** Throws when the sync lock can no longer be trusted to outlive the next outbound write (Codex PR35-r1). */
export type LockGuard = () => Promise<void>;

/** The Linear writes; every one is fenced by the lock guard. Reads are not (they change nothing). */
const WRITES = ["createLabel", "createProject", "updateProject", "createMilestone", "updateMilestone", "createIssue", "updateIssue", "addBlockedBy"] as const;

/** Wraps a LinearApi so every write first checks the lock guard. A failed guard stops the sync before the write. */
export function fencedApi(api: LinearApi, guard: LockGuard): LinearApi {
  const out: LinearApi = { ...api };
  for (const k of WRITES) {
    const fn = api[k] as (...a: unknown[]) => Promise<unknown>;
    (out as unknown as Record<string, unknown>)[k] = async (...a: unknown[]) => { await guard(); return fn.apply(api, a); };
  }
  return out;
}

/** Wraps a SyncStore so every id write first checks the lock guard. */
function fencedStore(store: SyncStore, guard: LockGuard): SyncStore {
  return {
    setProjectId: async (a, b) => { await guard(); return store.setProjectId(a, b); },
    setMilestoneId: async (a, b) => { await guard(); return store.setMilestoneId(a, b); },
    setModuleIssue: async (a, b) => { await guard(); return store.setModuleIssue(a, b); },
    setTaskIssue: async (a, b) => { await guard(); return store.setTaskIssue(a, b); },
  };
}

/** Longest a single Linear write can take (client timeout 15 s) plus slack: the lock must outlive it. */
export const WRITE_MARGIN_MS = 60_000;

/**
 * Sync one project under a per-project Postgres advisory lock, so two syncs of the same project never run at once
 * (two would both miss the marker and both create). A sync that finds the lock taken is skipped, not queued: the
 * holder is already bringing Linear up to date. The lock is transaction-scoped and released on commit or crash;
 * the transaction does nothing else, so it pins one connection but locks no rows.
 *
 * Codex PR35-r1 (fencing): the lock lives only as long as its transaction, which has a timeout. `run` gets a
 * `guard` and must route Linear writes through `fencedApi(api, guard)`; the store it gets is already fenced. The
 * guard refuses (`linear-sync-lock-expiring`) once less than WRITE_MARGIN_MS of the transaction's time is left, and
 * pings the transaction (`SELECT 1`), which fails once Prisma has closed it. So no write starts unless the lock is
 * held and will still be held when the write's own timeout ends; the next scheduled sync finishes the work.
 */
export async function syncProjectLocked(db: PrismaLike, projectId: string,
                                        run: (plan: DevosPlan, store: SyncStore, guard: LockGuard) => Promise<unknown>,
                                        timeoutMs = 10 * 60_000, now: () => number = Date.now): Promise<{ skipped: boolean }> {
  if (timeoutMs <= WRITE_MARGIN_MS) throw new Error("linear-sync: lock timeout must exceed the write margin");
  return db.$transaction(async (tx: any) => {
    const deadline = now() + timeoutMs;
    const rows = await tx.$queryRawUnsafe(`SELECT pg_try_advisory_xact_lock(hashtext('devos:linear-sync'), hashtext($1)) AS ok`, projectId);
    if (!rows?.[0]?.ok) return { skipped: true };
    const guard: LockGuard = async () => {
      if (deadline - now() < WRITE_MARGIN_MS) throw new Error("linear-sync-lock-expiring");
      try {
        await tx.$queryRawUnsafe("SELECT 1");
      } catch {
        throw new Error("linear-sync-lock-lost");
      }
    };
    // The transaction only holds the lock. Reads and id writes use the plain client, so each id commits at once
    // and no module/task row stays locked during the Linear round trips.
    await run(await loadPlan(db, projectId), fencedStore(new PrismaSyncStore(db, projectId), guard), guard);
    return { skipped: false };
  }, { timeout: timeoutMs, maxWait: 10_000 });
}

// M2.6-a: the DevOS side of the sync over the M1.1 Prisma client (@devos/db createDb). Typed structurally so
// this package has no runtime dependency on the generated client (same pattern as @devos/policy).
// Linear project and milestone ids are resource rows (provider 'linear'); module/task issues use linear_issue.
import type { DevosPlan, LinearApi, SyncStore } from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Delegate = any;
export interface PrismaLike {
  project: Delegate; milestone: Delegate; module: Delegate; moduleDependency: Delegate; task: Delegate; resource: Delegate; auditEvent: Delegate;
  $transaction<T>(fn: (tx: any) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T>;
}

const RES = (kind: "project" | "milestone") => ({ provider: "linear", kind });

/**
 * Codex PR35-r4 (ADR-0011 timeouts, fencing): every store operation runs in its own short transaction with a
 * statement and lock timeout, so a write that passed the guard either commits or rolls back within
 * STORE_WAIT_MS + STORE_OP_MS, well inside WRITE_MARGIN_MS. It can never be left waiting on a row lock until
 * after the sync lock has expired and a later sync has taken it.
 */
export const STORE_OP_MS = 15_000;
export const STORE_WAIT_MS = 5_000;
const STATEMENT_MS = 10_000;
export async function bounded<T>(db: PrismaLike, fn: (tx: any) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${STATEMENT_MS}`);
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${STATEMENT_MS}`);
    return fn(tx);
  }, { timeout: STORE_OP_MS, maxWait: STORE_WAIT_MS });
}

/** Read the plan of one project, with the Linear ids already known. */
export async function loadPlan(client: PrismaLike, projectId: string): Promise<DevosPlan> {
  return bounded(client, (db) => readPlan(db, projectId));
}

async function readPlan(db: any, projectId: string): Promise<DevosPlan> {
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

  private upsertResource(kind: "project" | "milestone", name: string, externalId: string) {
    return bounded(this.db, async (tx) => {
      const existing = await tx.resource.findFirst({ where: { projectId: this.projectId, ...RES(kind), name, status: "active" }, select: { id: true, externalId: true } });
      if (existing?.externalId === externalId) return;
      // The same Linear object may have a soft-deleted row (resource is unique on provider + kind + external id): reuse it.
      const prior = await tx.resource.findFirst({ where: { ...RES(kind), externalId }, select: { id: true, projectId: true } });
      if (prior && prior.projectId === this.projectId) {
        if (existing) await tx.resource.update({ where: { id: existing.id }, data: { status: "deleted", deletedAt: new Date() } });
        await tx.resource.update({ where: { id: prior.id }, data: { status: "active", deletedAt: null, name } });
        return;
      }
      if (existing) await tx.resource.update({ where: { id: existing.id }, data: { externalId } });
      else await tx.resource.create({ data: { projectId: this.projectId, ...RES(kind), name, externalId } });
    });
  }
  setProjectId(projectId: string, linearProjectId: string) { return this.upsertResource("project", projectId, linearProjectId); }
  setMilestoneId(milestoneId: string, linearMilestoneId: string) { return this.upsertResource("milestone", milestoneId, linearMilestoneId); }
  async setModuleIssue(moduleId: string, issueId: string) { await bounded(this.db, (tx) => tx.module.update({ where: { id: moduleId }, data: { linearIssue: issueId } })); }
  async setTaskIssue(taskId: string, issueId: string) { await bounded(this.db, (tx) => tx.task.update({ where: { id: taskId }, data: { linearIssue: issueId } })); }
  /** Only a human task of this project that is not yet done changes; the change and its audit row commit together. */
  async completeHumanTask(taskId: string, how: "completed" | "canceled") {
    await bounded(this.db, async (tx) => {
      const n = await tx.task.updateMany({ where: { id: taskId, projectId: this.projectId, assignee: "kk", status: { not: "done" } }, data: { status: "done" } });
      if (!n.count) return;
      await tx.auditEvent.create({ data: { actor: "kk", projectId: this.projectId, action: how === "canceled" ? "task.canceled_in_linear" : "task.completed_in_linear",
        summary: how === "canceled" ? "Human task cancelled in Linear; marked done" : "Human task completed in Linear; marked done", details: { taskId, how } } });
    });
  }
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
    completeHumanTask: async (a, b) => { await guard(); return store.completeHumanTask(a, b); },
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
  if (STORE_WAIT_MS + STORE_OP_MS >= WRITE_MARGIN_MS) throw new Error("linear-sync: a store write must fit in the write margin");
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
      // Codex PR35-r10: the probe itself can be slow, so the margin is checked again after it, right before the
      // caller is allowed to write.
      if (deadline - now() < WRITE_MARGIN_MS) throw new Error("linear-sync-lock-expiring");
    };
    // The transaction only holds the lock. Reads and id writes use the plain client in their own bounded
    // transactions, so each id commits at once, no module/task row stays locked during the Linear round trips,
    // and no id write can outlive the lock (Codex PR35-r4).
    await run(await loadPlan(db, projectId), fencedStore(new PrismaSyncStore(db, projectId), guard), guard);
    return { skipped: false };
  }, { timeout: timeoutMs, maxWait: 10_000 });
}

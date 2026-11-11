// Prisma-backed ProvisionStore (docs/modules/M2.4.md, decision 4). Typed structurally so the package
// builds without the generated client; the API/worker pass the @devos/db client.
//
// Lock (pre-review r1): a **session** advisory lock on (hashtext('devos:provision'), hashtext(project id)),
// taken on a dedicated connection that does nothing else. It is held until the run ends (released in
// `finally`) or the connection drops, never by a transaction timer, so a long run cannot lose it midway.
// A waiter gives up after `lockWaitMs` (Postgres `lock_timeout`). Before every external create the runner
// calls `assertLockHeld`, which pings the lock connection: a dropped connection (= a released lock) stops
// the run before it can create anything. Journal and inventory writes use the normal client and commit at
// once, so a crash never loses the record of a resource that exists at the provider.
import pg from "pg";
import type { ProvisionStore, ResourceRecord, StepRecord, StepSpec } from "./runner.js";

type Spec = Pick<StepSpec, "key" | "provider" | "kind">;

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaLike {
  provisionStep: any;
  resource: any;
}

/** The part of a pg client the lock needs (a real `pg.Client`, or a stub in tests). */
export interface LockConnection {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
  on(event: "error", cb: (e: Error) => void): unknown;
}

export interface PrismaStoreOptions {
  /** Opens the dedicated lock connection. Default: a new `pg.Client` on `databaseUrl`. */
  connectLock?: () => Promise<LockConnection>;
  databaseUrl?: string;
  /** How long a second run waits for the project lock before failing (default 15 minutes). */
  lockWaitMs?: number;
  /** Timeout on every journal / inventory call and on the lock ping (ADR-0011 §9; default 10 s). */
  dbTimeoutMs?: number;
}

export function bounded<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${label}_timeout`)), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

const LOCK_SQL = "SELECT pg_advisory_lock(hashtext('devos:provision'), hashtext($1))";
const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext('devos:provision'), hashtext($1))";

export class PrismaStore implements ProvisionStore {
  private readonly held = new Map<string, { conn: LockConnection; lost: boolean }>();
  private readonly dbMs: number;

  constructor(private readonly db: PrismaLike, private readonly o: PrismaStoreOptions = {}) {
    this.dbMs = o.dbTimeoutMs ?? 10_000;
    if (!o.connectLock && !o.databaseUrl) throw new Error("PrismaStore: connectLock or databaseUrl is required");
  }

  private async openLock(): Promise<LockConnection> {
    if (this.o.connectLock) return this.o.connectLock();
    const c = new pg.Client({ connectionString: this.o.databaseUrl, connectionTimeoutMillis: this.dbMs });
    await c.connect();
    return c as unknown as LockConnection;
  }

  private readonly queue = new Map<string, Promise<unknown>>();

  /** Runs for the same project in this process queue up first, then take the DB lock (other processes wait there). */
  withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queue.get(projectId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.lockAndRun(projectId, fn));
    const tail = run.catch(() => {});
    this.queue.set(projectId, tail);
    void tail.then(() => { if (this.queue.get(projectId) === tail) this.queue.delete(projectId); });
    return run;
  }

  private async lockAndRun<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const conn = await this.openLock();
    const state = { conn, lost: false };
    conn.on("error", () => { state.lost = true; });
    try {
      const wait = Math.max(1, Math.floor(Number(this.o.lockWaitMs ?? 15 * 60_000)));
      if (!Number.isFinite(wait)) throw new Error("provision_lock_wait_invalid");
      await conn.query(`SET lock_timeout = ${wait}`);
      try {
        await conn.query(LOCK_SQL, [projectId]);
      } catch (e) {
        // 55P03 lock_not_available: another run holds the project; typed so the caller retries later (not an attempt).
        if ((e as { code?: string }).code === "55P03") throw new Error("provision_busy");
        throw e;
      }
      this.held.set(projectId, state);
      try {
        return await fn();
      } finally {
        this.held.delete(projectId);
        await bounded(conn.query(UNLOCK_SQL, [projectId]), this.dbMs, "provision_unlock").catch(() => {});
      }
    } finally {
      await conn.end().catch(() => {}); // closing the session also releases the lock
    }
  }

  async assertLockHeld(projectId: string): Promise<void> {
    const s = this.held.get(projectId);
    if (!s || s.lost) throw new Error("provision_lock_lost");
    try {
      await bounded(s.conn.query("SELECT 1"), this.dbMs, "provision_lock_ping");
    } catch {
      s.lost = true;
      throw new Error("provision_lock_lost");
    }
  }

  async getStep(projectId: string, key: string): Promise<StepRecord | null> {
    const r = await bounded(this.db.provisionStep.findUnique({ where: { projectId_key: { projectId, key } } }), this.dbMs, "provision_db") as any;
    return r ? { projectId: r.projectId, key: r.key, status: r.status, attempts: r.attempts, externalId: r.externalId, lastError: r.lastError } : null;
  }

  private upsertStep(projectId: string, spec: Spec, create: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown> {
    return bounded(this.db.provisionStep.upsert({
      where: { projectId_key: { projectId, key: spec.key } },
      create: { projectId, key: spec.key, provider: spec.provider, kind: spec.kind, ...create },
      update,
    }), this.dbMs, "provision_db");
  }

  async markPending(projectId: string, spec: Spec): Promise<void> {
    await this.upsertStep(projectId, spec, { status: "pending", attempts: 1 }, { status: "pending", attempts: { increment: 1 } });
  }

  async markDone(projectId: string, spec: Spec, externalId: string): Promise<void> {
    await this.upsertStep(projectId, spec, { status: "done", externalId }, { status: "done", externalId, lastError: null });
  }

  async markFailed(projectId: string, spec: Spec, error: string): Promise<void> {
    const lastError = error.slice(0, 300);
    await this.upsertStep(projectId, spec, { status: "failed", lastError }, { status: "failed", lastError });
  }

  async recordResource(projectId: string, r: ResourceRecord): Promise<void> {
    const where = { provider_kind_externalId: { provider: r.provider, kind: r.kind, externalId: r.externalId } };
    const q = <T>(p: Promise<T>) => bounded(p, this.dbMs, "provision_db");
    const hit = await q(this.db.resource.findUnique({ where })) as any;
    if (hit) {
      if (hit.projectId !== projectId) throw new Error("resource_owned_elsewhere");
      if (hit.status !== "active") await q(this.db.resource.update({ where, data: { status: "active", deletedAt: null, name: r.name } }));
      return;
    }
    try {
      await q(this.db.resource.create({ data: { projectId, provider: r.provider, kind: r.kind, externalId: r.externalId, name: r.name } }));
    } catch (e) {
      // A concurrent insert of the same row (P2002) is fine if it is ours.
      if ((e as { code?: string }).code !== "P2002") throw e;
      const again = await q(this.db.resource.findUnique({ where })) as any;
      if (!again || again.projectId !== projectId) throw new Error("resource_owned_elsewhere");
    }
  }
}

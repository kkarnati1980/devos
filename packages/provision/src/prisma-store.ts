// Prisma-backed ProvisionStore (docs/modules/M2.4.md, decision 4). Typed structurally so the package
// builds without the generated client; the API/worker pass the @devos/db client.
//
// Lock: a transaction-scoped Postgres advisory lock on (hashtext('devos:provision'), hashtext(project id)),
// held by a transaction that does nothing else, so journal and inventory writes commit at once
// (a crash mid-run never rolls back the record of a resource that already exists at the provider).
import type { ProvisionStore, ResourceRecord, StepRecord, StepSpec } from "./runner.js";

type Spec = Pick<StepSpec, "key" | "provider" | "kind">;

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaLike {
  $transaction<T>(fn: (tx: any) => Promise<T>, opts?: { timeout?: number; maxWait?: number }): Promise<T>;
  provisionStep: any;
  resource: any;
}

export interface PrismaStoreOptions {
  /** How long a provisioning run may hold the project lock (default 15 minutes). */
  lockTimeoutMs?: number;
  /** How long a second run waits for the lock before failing (default 15 minutes). */
  lockWaitMs?: number;
}

export class PrismaStore implements ProvisionStore {
  constructor(private readonly db: PrismaLike, private readonly o: PrismaStoreOptions = {}) {}

  async withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const timeout = this.o.lockTimeoutMs ?? 15 * 60_000;
    return this.db.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('devos:provision'), hashtext(${projectId}))`;
      return fn();
    }, { timeout, maxWait: this.o.lockWaitMs ?? timeout });
  }

  async getStep(projectId: string, key: string): Promise<StepRecord | null> {
    const r = await this.db.provisionStep.findUnique({ where: { projectId_key: { projectId, key } } });
    return r ? { projectId: r.projectId, key: r.key, status: r.status, attempts: r.attempts, externalId: r.externalId, lastError: r.lastError } : null;
  }

  async markPending(projectId: string, spec: Spec): Promise<void> {
    await this.db.provisionStep.upsert({
      where: { projectId_key: { projectId, key: spec.key } },
      create: { projectId, key: spec.key, provider: spec.provider, kind: spec.kind, status: "pending", attempts: 1 },
      update: { status: "pending", attempts: { increment: 1 } },
    });
  }

  async markDone(projectId: string, spec: Spec, externalId: string): Promise<void> {
    await this.db.provisionStep.upsert({
      where: { projectId_key: { projectId, key: spec.key } },
      create: { projectId, key: spec.key, provider: spec.provider, kind: spec.kind, status: "done", externalId },
      update: { status: "done", externalId, lastError: null },
    });
  }

  async markFailed(projectId: string, spec: Spec, error: string): Promise<void> {
    const lastError = error.slice(0, 300);
    await this.db.provisionStep.upsert({
      where: { projectId_key: { projectId, key: spec.key } },
      create: { projectId, key: spec.key, provider: spec.provider, kind: spec.kind, status: "failed", lastError },
      update: { status: "failed", lastError },
    });
  }

  async recordResource(projectId: string, r: ResourceRecord): Promise<void> {
    const where = { provider_kind_externalId: { provider: r.provider, kind: r.kind, externalId: r.externalId } };
    const hit = await this.db.resource.findUnique({ where });
    if (hit) {
      if (hit.projectId !== projectId) throw new Error("resource_owned_elsewhere");
      if (hit.status !== "active") await this.db.resource.update({ where, data: { status: "active", deletedAt: null, name: r.name } });
      return;
    }
    try {
      await this.db.resource.create({ data: { projectId, provider: r.provider, kind: r.kind, externalId: r.externalId, name: r.name } });
    } catch (e) {
      // A concurrent insert of the same row (P2002) is fine if it is ours.
      if ((e as { code?: string }).code !== "P2002") throw e;
      const again = await this.db.resource.findUnique({ where });
      if (!again || again.projectId !== projectId) throw new Error("resource_owned_elsewhere");
    }
  }
}

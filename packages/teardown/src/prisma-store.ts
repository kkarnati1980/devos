// M2.5-a2 Postgres TeardownStore (docs/modules/M2.5.md, decisions 5–8). Extends M2.4's PrismaStore, so
// teardown takes the same session advisory lock as provisioning and shares its inventory and step journal.
// Typed structurally (no generated client at build time). Every DB call is bounded (ADR-0011 §9).
// The stage before Archive is kept in the `teardown.archived` audit event (no schema change, ADR-0011 §10).
import { PrismaStore, bounded, type PrismaStoreOptions } from "@devos/provision";
import type { ActiveResource, ScanReport, TeardownProject, TeardownStore } from "./teardown.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface TeardownPrismaLike {
  project: any;
  resource: any;
  provisionStep: any;
  auditEvent: any;
  vaultSecret: any;
  $transaction<T>(fn: (tx: any) => Promise<T>, o?: { timeout?: number; maxWait?: number }): Promise<T>;
}

const STAGES = new Set(["intake", "provisioning", "building", "preview", "live", "archived", "purged"]);

export class PrismaTeardownStore extends PrismaStore implements TeardownStore {
  private readonly tdb: TeardownPrismaLike;
  private readonly ms: number;

  constructor(db: TeardownPrismaLike, o: PrismaStoreOptions = {}) {
    super(db, o);
    this.tdb = db;
    this.ms = o.dbTimeoutMs ?? 10_000;
  }

  private q<T>(p: Promise<T>): Promise<T> {
    return bounded(p, this.ms, "teardown_db");
  }

  private async previousStage(projectId: string, client: any = this.tdb): Promise<string | null> {
    const ev = await this.q(client.auditEvent.findFirst({
      where: { projectId, action: "teardown.archived", actor: "system" },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      select: { details: true },
    })) as any;
    const s = ev?.details?.previousStage;
    return typeof s === "string" && STAGES.has(s) && s !== "archived" && s !== "purged" ? s : null;
  }

  async project(projectId: string): Promise<TeardownProject | null> {
    const p = await this.q(this.tdb.project.findUnique({
      where: { id: projectId },
      select: { id: true, slug: true, stage: true, archivedAt: true, purgeAfter: true },
    })) as any;
    if (!p) return null;
    return {
      id: p.id, slug: p.slug, stage: p.stage,
      previousStage: p.stage === "archived" ? await this.previousStage(projectId) : null,
      archivedAt: p.archivedAt ?? null, purgeAfter: p.purgeAfter ?? null,
    };
  }

  async markArchived(projectId: string, at: Date, purgeAfter: Date): Promise<void> {
    await this.tdb.$transaction(async (tx: any) => {
      const p = await tx.project.findUnique({ where: { id: projectId }, select: { stage: true } });
      if (!p) throw new Error("project_not_found");
      await tx.project.update({ where: { id: projectId }, data: { stage: "archived", archivedAt: at, purgeAfter } });
      await tx.auditEvent.create({ data: {
        actor: "system", projectId, action: "teardown.archived",
        summary: `Project archived; purge only after KK confirms (not before ${purgeAfter.toISOString()})`,
        details: { previousStage: p.stage, purgeAfter: purgeAfter.toISOString() },
      } });
    }, { timeout: this.ms, maxWait: this.ms });
  }

  async markRestored(projectId: string): Promise<void> {
    await this.tdb.$transaction(async (tx: any) => {
      const back = (await this.previousStage(projectId, tx)) ?? "building";
      await tx.project.update({ where: { id: projectId }, data: { stage: back, archivedAt: null, purgeAfter: null } });
      await tx.auditEvent.create({ data: { actor: "system", projectId, action: "teardown.restored", summary: `Project restored to ${back}`, details: { stage: back } } });
    }, { timeout: this.ms, maxWait: this.ms });
  }

  async activeResources(projectId: string): Promise<ActiveResource[]> {
    const rows = await this.q(this.tdb.resource.findMany({
      where: { projectId, status: "active" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, provider: true, kind: true, externalId: true, name: true },
    })) as any[];
    return rows.map((r) => ({ id: r.id, provider: r.provider, kind: r.kind, externalId: r.externalId, name: r.name }));
  }

  async markResourceDeleted(resourceId: string, at: Date): Promise<void> {
    await this.q(this.tdb.resource.updateMany({ where: { id: resourceId, status: "active" }, data: { status: "deleted", deletedAt: at } }));
  }

  async resetSteps(projectId: string): Promise<void> {
    await this.q(this.tdb.provisionStep.deleteMany({ where: { projectId } }));
  }

  async saveScan(projectId: string, report: ScanReport): Promise<void> {
    const n = report.hits.length;
    await this.q(this.tdb.auditEvent.create({ data: {
      actor: "system", projectId, action: "teardown.scan",
      summary: n === 0 && report.errors.length === 0 ? "Leftover scan: 0 hits" : `Leftover scan: ${n} hit(s), ${report.errors.length} scanner error(s)`,
      details: JSON.parse(JSON.stringify(report)),
    } }));
  }

  /** The newest stored scan report (shown on the project page, M2.5-b). */
  async lastScan(projectId: string): Promise<ScanReport | null> {
    const ev = await this.q(this.tdb.auditEvent.findFirst({ where: { projectId, action: "teardown.scan", actor: "system" }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], select: { details: true } })) as any;
    return (ev?.details as ScanReport) ?? null;
  }

  /** DEVOS-131: hard delete; ciphertext of a purged project is a liability, and the purge is KK's decision (M2.3). */
  async deleteProjectSecrets(projectId: string): Promise<number> {
    const r = await this.q(this.tdb.vaultSecret.deleteMany({ where: { projectId } })) as { count: number };
    return r.count;
  }

  async markPurged(projectId: string): Promise<void> {
    await this.tdb.$transaction(async (tx: any) => {
      await tx.project.update({ where: { id: projectId }, data: { stage: "purged" } });
      await tx.auditEvent.create({ data: { actor: "system", projectId, action: "teardown.purged", summary: "Project purged; the leftover scan found 0" } });
    }, { timeout: this.ms, maxWait: this.ms });
  }
}

/**
 * Vault leftover scan (decision 6): any `vault_secret` row still scoped to the project is a hit, listed by name only.
 * The ciphertext is never selected (decision 7).
 */
export function vaultScanner(db: { vaultSecret: any }, dbTimeoutMs = 10_000) {
  return {
    name: "vault",
    scan: async (p: { id: string; slug: string }) => {
      const rows = await bounded(db.vaultSecret.findMany({ where: { projectId: p.id }, select: { id: true, name: true } }), dbTimeoutMs, "teardown_db") as any[];
      return rows.map((r) => ({ provider: "vault", kind: "secret", externalId: r.id, name: r.name }));
    },
  };
}

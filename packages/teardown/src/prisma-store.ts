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
  isolationStack: any;
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

  async markArchived(projectId: string, at: Date, purgeAfter: Date): Promise<{ archivedAt: Date; purgeAfter: Date }> {
    const windowMs = purgeAfter.getTime() - at.getTime();
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) throw new Error("archive window must be positive");
    return this.tdb.$transaction(async (tx: any) => {
      const p = await tx.project.findUnique({ where: { id: projectId }, select: { stage: true } });
      if (!p) throw new Error("project_not_found");
      // M2.5-b5b decision 1: one database clock, cut to whole milliseconds, so the guarded raise's exact archive
      // equality (b5a decision 7) holds for the millisecond Date every reader gets, and `purge_after` is the window
      // after that same instant. `at` (the app clock) only carries the window.
      const rows: { archivedAt: Date; purgeAfter: Date }[] = await tx.$queryRaw`
        WITH n AS (SELECT date_trunc('milliseconds', clock_timestamp()) AS t)
        UPDATE project SET stage = 'archived', archived_at = n.t, purge_after = n.t + (${windowMs}::bigint * interval '1 millisecond'), updated_at = n.t
        FROM n WHERE project.id = ${projectId}::uuid
        RETURNING project.archived_at AS "archivedAt", project.purge_after AS "purgeAfter"`;
      const row = rows[0];
      if (!row || !(row.archivedAt instanceof Date) || !(row.purgeAfter instanceof Date)) throw new Error("project_not_found");
      // M2.5-b5b decision 11 (Codex PR244-r1, high): a new Archive retires every earlier purge card of the project in
      // the same transaction, so no card is bound to an archive by comparing times from two clocks. An earlier card's
      // unspent grants are revoked and a pending one expires; only a card raised in this archive can then purge it.
      const target = `project:${projectId}`;
      // Pre-review (r1 fix): expire first, then revoke. `approve` issues its grant before it decides the card, so a
      // card it approved before the expiry has a committed grant the later revoke sees; one it decides after waits on
      // this row lock, finds the card expired, and revokes its own grant.
      const expired: number = await tx.$executeRaw`
        UPDATE approval SET status = 'expired', decided_at = ${row.archivedAt}::timestamptz, decided_by = 'system:teardown.archive', updated_at = ${row.archivedAt}::timestamptz
        WHERE project_id = ${projectId}::uuid AND action = 'teardown.purge' AND target = ${target} AND status = 'pending'`;
      const revoked: number = await tx.$executeRaw`
        UPDATE approval_grant SET revoked_at = ${row.archivedAt}::timestamptz
        WHERE revoked_at IS NULL AND approval_id IN (
          SELECT id FROM approval WHERE project_id = ${projectId}::uuid AND action = 'teardown.purge' AND target = ${target})`;
      // M2.5-b5b decisions 14-15 (Codex PR244-r2/r3): every earlier purge card is also retired by id, not by time:
      // its id goes in this Archive's `retired` list (any status, each id listed once across archives). Keep
      // archived, the probe's lookups and the guarded raise's reuse exclude listed cards, so a card stamped by the old
      // app clock can never extend, stand for or be reused by this archive, however its timestamp sorts.
      const listed: { id: string }[] = await tx.$queryRaw`
        SELECT a.id::text AS id FROM approval a
        WHERE a.project_id = ${projectId}::uuid AND a.action = 'teardown.purge' AND a.target = ${target}
          AND NOT EXISTS (SELECT 1 FROM audit_event e WHERE e.project_id = a.project_id
            AND e.action = 'teardown.archive_retired_cards' AND e.details -> 'retired' @> jsonb_build_array(a.id::text))
        ORDER BY a.id`;
      const retired = listed.map((r) => r.id);
      if (revoked > 0 || expired > 0 || retired.length > 0) {
        await tx.auditEvent.create({ data: {
          actor: "system", projectId, action: "teardown.archive_retired_cards",
          // b5b decision 20 (pre-review r6): stamped with this Archive's database-clock time. The column's default is
          // filled by the Prisma client (the app clock), and the probe's cycle lookup compares it with a database time.
          occurredAt: row.archivedAt,
          summary: "Earlier purge cards retired by a new Archive",
          details: { grantsRevoked: revoked, cardsExpired: expired, retired },
        } });
      }
      await tx.auditEvent.create({ data: {
        actor: "system", projectId, action: "teardown.archived",
        summary: `Project archived; purge only after KK confirms (not before ${row.purgeAfter.toISOString()})`,
        details: { previousStage: p.stage, purgeAfter: row.purgeAfter.toISOString() },
      } });
      return { archivedAt: row.archivedAt, purgeAfter: row.purgeAfter };
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
      select: { id: true, provider: true, kind: true, externalId: true, name: true, deleteStartedAt: true },
    })) as any[];
    return rows.map((r) => ({ id: r.id, provider: r.provider, kind: r.kind, externalId: r.externalId, name: r.name, deleteStartedAt: r.deleteStartedAt ?? null }));
  }

  async markDeleteStarted(resourceId: string, at: Date): Promise<void> {
    // First start only: a retried delete keeps the time of the first attempt.
    await this.q(this.tdb.resource.updateMany({ where: { id: resourceId, status: "active", deleteStartedAt: null }, data: { deleteStartedAt: at } }));
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

  /**
   * DEVOS-131: hard delete; ciphertext of a purged project is a liability, and the purge is KK's decision (M2.3).
   * Like every vault mutation (apps/api/src/vault.ts), the delete and its audit event commit together; the event
   * lists names and the count, never a value.
   */
  async deleteProjectSecrets(projectId: string): Promise<number> {
    return this.tdb.$transaction(async (tx: any) => {
      const rows = (await tx.vaultSecret.findMany({ where: { projectId }, select: { id: true, name: true }, orderBy: { name: "asc" } })) as { id: string; name: string }[];
      if (!rows.length) return 0;
      const r = (await tx.vaultSecret.deleteMany({ where: { projectId, id: { in: rows.map((x) => x.id) } } })) as { count: number };
      await tx.auditEvent.create({ data: {
        actor: "system", projectId, action: "teardown.secrets_deleted",
        summary: `Purge deleted ${r.count} vault secret(s)`,
        details: { count: r.count, names: rows.map((x) => x.name) },
      } });
      return r.count;
    }, { timeout: this.ms, maxWait: this.ms });
  }

  /**
   * DEVOS-175: the project's `isolation_stack` rows (S4) are deleted in the same transaction that marks it purged,
   * so its unique stack index, subnet and network are freed for a later project (otherwise `isolation-index-taken`).
   * Only this project's rows; the count goes into the `teardown.purged` audit event.
   */
  async markPurged(projectId: string): Promise<void> {
    await this.tdb.$transaction(async (tx: any) => {
      const stacks = (await tx.isolationStack.deleteMany({ where: { projectId } })) as { count: number };
      await tx.project.update({ where: { id: projectId }, data: { stage: "purged" } });
      await tx.auditEvent.create({ data: {
        actor: "system", projectId, action: "teardown.purged", summary: "Project purged; the leftover scan found 0",
        details: { isolationStacksDeleted: stacks.count },
      } });
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

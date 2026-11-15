// DEVOS-225 (M2.4-d2, docs/modules/M2.4.md "M2.4-d2 decisions"): the provisioning status and retry routes.
// GET never writes (ADR-0011 §1). POST is the retry: it sits behind the global Origin and CSRF checks, acts only on a
// project in `provisioning`, un-parks it so the sweep's next tick runs it again, and writes an audit event.
// Only fixed codes leave the API: a step's stored error is cut to the code before its first ':'.
import { Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { httpError } from "./auth.js";
import { writeAudit } from "./settings.js";

export const PROVISION = Symbol("devos:provision");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9_-]{0,63}$/;

/** The d1 step order: the status lists steps in the order the sweep runs them. */
/** A key ending in "/" is a family (one step per environment or secret). */
export const STEP_ORDER = [
  "github/repo", "github/core", "coolify/project", "coolify/environment/", "coolify/port/",
  "coolify/deploy_key", "github/deploy_key", "github/deploy_compose", "coolify/application/", "vault/app_secret/",
];

export interface StepRow { key: string; provider: string; kind: string; status: string; attempts: number; lastError: string | null; updatedAt: Date }
export interface StepView { key: string; provider: string; kind: string; status: string; attempts: number; code: string | null; updatedAt: string }

export interface ProvisionReader {
  project(id: string): Promise<{ id: string; stage: string } | null>;
  steps(projectId: string): Promise<StepRow[]>;
  /** Writes the `provision.retry` audit event; false when the project is no longer in `provisioning`. */
  recordRetry(projectId: string): Promise<boolean>;
}

export interface ProvisionServices {
  reader: ProvisionReader | null;
  sweep: { retry(projectId: string): void; isParked(projectId: string): boolean } | null;
}

/** The fixed code of a stored error line (`<code>: <message>`), or null; anything not code-shaped is `error`. */
export function errorCode(line: string | null): string | null {
  if (!line) return null;
  const head = line.split(":", 1)[0]!.trim();
  return CODE.test(head) ? head : "error";
}

const rank = (key: string): number => {
  const i = STEP_ORDER.findIndex((k) => (k.endsWith("/") ? key.startsWith(k) : key === k));
  return i >= 0 ? i : STEP_ORDER.length;
};

export function stepViews(rows: readonly StepRow[]): StepView[] {
  return [...rows]
    .sort((a, b) => rank(a.key) - rank(b.key) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((r) => ({ key: r.key, provider: r.provider, kind: r.kind, status: r.status, attempts: r.attempts, code: errorCode(r.lastError), updatedAt: r.updatedAt.toISOString() }));
}

@Controller("projects")
export class ProvisionController {
  constructor(@Inject(PROVISION) private readonly svc: ProvisionServices) {}

  private wired(): { reader: ProvisionReader; sweep: NonNullable<ProvisionServices["sweep"]> } {
    if (!this.svc.reader || !this.svc.sweep) throw httpError(503, "provision-not-configured");
    return { reader: this.svc.reader, sweep: this.svc.sweep };
  }

  @Get(":id/provision")
  async status(@Param("id") id: string) {
    if (!UUID.test(id)) throw httpError(400, "invalid:id");
    const { reader, sweep } = this.wired();
    const p = await reader.project(id).catch(() => { throw httpError(503, "provision-store-failed"); });
    if (!p) throw httpError(404, "project-not-found");
    const rows = await reader.steps(id).catch(() => { throw httpError(503, "provision-store-failed"); });
    return { stage: p.stage, parked: sweep.isParked(id), steps: stepViews(rows) };
  }

  @Post(":id/provision")
  @HttpCode(202)
  async retry(@Param("id") id: string) {
    if (!UUID.test(id)) throw httpError(400, "invalid:id");
    const { reader, sweep } = this.wired();
    const p = await reader.project(id).catch(() => { throw httpError(503, "provision-store-failed"); });
    if (!p) throw httpError(404, "project-not-found");
    if (p.stage !== "provisioning") throw httpError(409, "project-not-provisioning");
    const ok = await reader.recordRetry(id).catch(() => { throw httpError(503, "provision-store-failed"); });
    if (!ok) throw httpError(409, "project-not-provisioning");
    sweep.retry(id);
    return { queued: true };
  }
}

/** Postgres reads for the routes; every call is bounded (ADR-0011 §9). */
export class PrismaProvisionReader implements ProvisionReader {
  constructor(private readonly db: any, private readonly timeoutMs: number) {}

  private tx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return this.db.$transaction(fn, { timeout: this.timeoutMs, maxWait: this.timeoutMs });
  }

  async project(id: string) {
    const p: { id: string; stage: unknown } | null = await this.tx((tx) => tx.project.findUnique({ where: { id }, select: { id: true, stage: true } }));
    return p ? { id: p.id as string, stage: String(p.stage) } : null;
  }

  async steps(projectId: string): Promise<StepRow[]> {
    const rows = await this.tx((tx) => tx.provisionStep.findMany({
      where: { projectId },
      select: { key: true, provider: true, kind: true, status: true, attempts: true, lastError: true, updatedAt: true },
      take: 200,
    }));
    return (rows as any[]).map((r) => ({ ...r, provider: String(r.provider), status: String(r.status) }));
  }

  /** The audit row commits only while the project is still in `provisioning` (locked row, same transaction). */
  async recordRetry(projectId: string): Promise<boolean> {
    return this.tx(async (tx) => {
      const rows: { stage: string }[] = await tx.$queryRaw`SELECT stage::text AS stage FROM project WHERE id = ${projectId}::uuid FOR UPDATE`;
      if (rows[0]?.stage !== "provisioning") return false;
      await writeAudit(tx, { action: "provision.retry", summary: "Provisioning retry requested", details: {}, projectId });
      return true;
    });
  }
}

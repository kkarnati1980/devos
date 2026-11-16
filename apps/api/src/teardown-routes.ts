// DEVOS-244 (M2.5-b1, docs/modules/M2.5.md "M2.5-b1 decisions"): Archive, Restore and the teardown state.
// POST archive/restore sit behind the global session, Origin and CSRF checks (KK only, ADR-0011) and run in the
// request, bounded by TEARDOWN_ROUTE_TIMEOUT_MS. A purge never runs from a route. GET never writes. Only fixed codes
// leave the API: a TeardownError is reported by its code, never its message, and a scan error by its code only.
import { Controller, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { httpError, KK_SESSIONS, KkSessionRegistry, type KkSession } from "./auth.js";
import type { DevosRequest } from "./http.js";

export const TEARDOWN = Symbol("devos:teardown");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9-]{2,40}$/;
const CODE = /^[a-z][a-z0-9_-]{0,63}$/;

/** Decision 3: Archive stops every application and archives the repo; two Coolify apps take about a minute. */
export const TEARDOWN_ROUTE_TIMEOUT_MS = 120_000;

export interface TeardownProjectRow { id: string; slug: string; stage: string; archivedAt: Date | null; purgeAfter: Date | null }
export interface ScanReportLike { scannedAt?: unknown; hits?: unknown; errors?: unknown }

export interface TeardownReader {
  project(id: string): Promise<TeardownProjectRow | null>;
  projectBySlug(slug: string): Promise<TeardownProjectRow | null>;
  activeResources(projectId: string): Promise<readonly { provider: string; kind: string }[]>;
  lastScan(projectId: string): Promise<ScanReportLike | null>;
  /** `app_settings.archive_days` (M1.1), the `teardown.archive_days` setting; default 30. */
  archiveDays(): Promise<number>;
}

export interface TeardownActions {
  archive(session: KkSession, projectId: string, windowDays: number): Promise<{ archivedAt: Date; purgeAfter: Date }>;
  restore(session: KkSession, projectId: string): Promise<void>;
}

export interface TeardownServices {
  reader: TeardownReader | null;
  actions: TeardownActions | null;
  /** Pre-review 1: the outcome of a run that ended after its 504 is logged by fixed code (absent → not logged). */
  log?: (e: Record<string, unknown>) => void;
}

/** Decision 4: TeardownError codes → HTTP status; the body carries only the code. */
export const TEARDOWN_STATUS: Readonly<Record<string, number>> = Object.freeze({
  project_not_found: 404,
  not_archived: 409,
  already_archived: 409,
  policy_denied: 403,
  approval_required: 403,
  ownership_mismatch: 409,
  unsupported_resource: 500,
  delete_unconfirmed: 502,
  provider_forbidden: 502,
  provider_error: 502,
  scan_incomplete: 409,
});

/** The fixed code of a thrown error; anything else is `teardown-failed`. Never the message of a TeardownError. */
export function teardownFailure(e: unknown): { status: number; code: string } {
  const err = e as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (err && err.name === "TeardownError" && typeof err.code === "string" && Object.hasOwn(TEARDOWN_STATUS, err.code)) {
    return { status: TEARDOWN_STATUS[err.code]!, code: err.code };
  }
  // Plain errors the store throws by fixed message (packages/provision PrismaStore).
  const m = err && typeof err.message === "string" ? err.message : "";
  if (m === "provision_busy") return { status: 409, code: "project-busy" };
  if (m === "project_not_found") return { status: 404, code: "project-not-found" };
  return { status: 503, code: "teardown-failed" };
}

const scanErrorCode = (s: unknown): string => {
  if (typeof s !== "string") return "error";
  const head = s.split(":", 1)[0]!.trim();
  return CODE.test(head) ? head : "error";
};
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** The stored scan report, reduced to known fields (hits keep provider, kind, id and name as text; errors their code). */
export function scanView(r: ScanReportLike | null): { scannedAt: string; hits: { provider: string; kind: string; externalId: string; name: string }[]; errors: { scanner: string; code: string }[] } | null {
  if (!r || typeof r !== "object") return null;
  const hits = Array.isArray(r.hits) ? r.hits.slice(0, 200) : [];
  const errors = Array.isArray(r.errors) ? r.errors.slice(0, 50) : [];
  return {
    scannedAt: str(r.scannedAt, 40),
    hits: hits.map((h: any) => ({ provider: str(h?.provider, 40), kind: str(h?.kind, 60), externalId: str(h?.externalId, 200), name: str(h?.name, 200) })),
    errors: errors.map((x: any) => ({ scanner: str(x?.scanner, 60), code: scanErrorCode(x?.error) })),
  };
}

/** Per-provider counts of active inventory rows, providers in name order. */
export function activeCounts(rows: readonly { provider: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of [...new Set(rows.map((r) => String(r.provider)))].sort()) out[p] = rows.filter((r) => String(r.provider) === p).length;
  return out;
}

/**
 * The run raced against the route bound. After a 504 the run goes on under the project lock; its late outcome is
 * logged by fixed code only (`teardown-late-done` / `teardown-late-failed`), so "still running" and "failed" differ.
 */
function bounded<T>(p: Promise<T>, ms: number, late: (e: Record<string, unknown>) => void): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => {
      p.then(() => late({ level: "info", msg: "teardown-late-done" }), (e) => late({ level: "warn", msg: "teardown-late-failed", code: teardownFailure(e).code }));
      reject(httpError(504, "teardown-timeout"));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

@Controller("projects")
export class TeardownController {
  constructor(
    @Inject(TEARDOWN) private readonly svc: TeardownServices,
    @Inject(KK_SESSIONS) private readonly kk: KkSessionRegistry,
  ) {}

  /** Test hook: the route bound (production: TEARDOWN_ROUTE_TIMEOUT_MS). */
  static timeoutMs = TEARDOWN_ROUTE_TIMEOUT_MS;

  private reader(): TeardownReader {
    if (!this.svc.reader) throw httpError(503, "teardown-not-configured");
    return this.svc.reader;
  }

  private actions(): TeardownActions {
    if (!this.svc.reader || !this.svc.actions) throw httpError(503, "teardown-not-configured");
    return this.svc.actions;
  }

  private late(op: string, projectId: string) {
    return (e: Record<string, unknown>) => { try { this.svc.log?.({ ...e, op, projectId }); } catch { /* logging never fails a route */ } };
  }

  private read<T>(p: Promise<T>): Promise<T> {
    return p.catch(() => { throw httpError(503, "teardown-store-failed"); });
  }

  private async view(p: TeardownProjectRow | null) {
    if (!p) throw httpError(404, "project-not-found");
    const reader = this.reader();
    const [rows, scan] = await Promise.all([this.read(reader.activeResources(p.id)), this.read(reader.lastScan(p.id))]);
    return {
      projectId: p.id,
      slug: p.slug,
      stage: p.stage,
      archivedAt: p.archivedAt ? p.archivedAt.toISOString() : null,
      purgeAfter: p.purgeAfter ? p.purgeAfter.toISOString() : null,
      active: activeCounts(rows),
      lastScan: scanView(scan),
    };
  }

  @Get(":id/teardown")
  async state(@Param("id") id: string) {
    if (!UUID.test(id)) throw httpError(400, "invalid:id");
    return this.view(await this.read(this.reader().project(id)));
  }

  @Get("by-slug/:slug/teardown")
  async stateBySlug(@Param("slug") slug: string) {
    if (!SLUG.test(slug)) throw httpError(400, "invalid:slug");
    return this.view(await this.read(this.reader().projectBySlug(slug)));
  }

  @Post(":id/archive")
  @HttpCode(200)
  async archive(@Req() req: DevosRequest, @Param("id") id: string) {
    if (!UUID.test(id)) throw httpError(400, "invalid:id");
    const actions = this.actions();
    const days = await this.read(this.reader().archiveDays());
    if (!Number.isInteger(days) || days < 1 || days > 365) throw httpError(503, "archive-days-invalid");
    const session = this.kk.mint(req.devos.login!);
    const r = await bounded(actions.archive(session, id, days), TeardownController.timeoutMs, this.late("archive", id)).catch((e) => {
      if (e && typeof e === "object" && typeof (e as { getStatus?: unknown }).getStatus === "function") throw e;
      const f = teardownFailure(e);
      throw httpError(f.status, f.code);
    });
    return { stage: "archived", archivedAt: r.archivedAt.toISOString(), purgeAfter: r.purgeAfter.toISOString() };
  }

  @Post(":id/restore")
  @HttpCode(200)
  async restore(@Req() req: DevosRequest, @Param("id") id: string) {
    if (!UUID.test(id)) throw httpError(400, "invalid:id");
    const actions = this.actions();
    const session = this.kk.mint(req.devos.login!);
    await bounded(actions.restore(session, id), TeardownController.timeoutMs, this.late("restore", id)).catch((e) => {
      if (e && typeof e === "object" && typeof (e as { getStatus?: unknown }).getStatus === "function") throw e;
      const f = teardownFailure(e);
      throw httpError(f.status, f.code);
    });
    // Pre-review 3: the restore succeeded; a failed re-read must not turn that into an error KK would retry.
    const p = await this.reader().project(id).catch(() => null);
    return { stage: p?.stage ?? null };
  }
}

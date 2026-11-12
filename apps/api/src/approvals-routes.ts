// M2.3-b1 (docs/modules/M2.3.md, "Routes" and "M2.3-b split"): the six /approvals routes over the M2.3-a core.
// All routes are `session` (deny by default); the guard (M1.2) admits only KK's tailnet login with a live session
// and checks CSRF on every POST. Only fixed codes leave this file: an ApprovalError keeps its code, an M1.7
// `grant-*` validation code is a 400, and anything else (a driver or store error) is 503 `approvals-store-error`.
// No error message is returned or logged.
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { httpError, KK_SESSIONS, KkSessionRegistry } from "./auth.js";
import { ApprovalError, type Approvals, type Card, type CardStatus } from "./approvals.js";
import type { DevosRequest } from "./http.js";

export const APPROVALS = Symbol("devos:approvals");

/** One grant as the inbox shows it (never its use history). */
export interface GrantSummary {
  id: string;
  scopeAction: string;
  scopeResource: string | null;
  projectId: string | null;
  sha: string | null;
  expiresAt: Date;
  maxUses: number;
  uses: number;
  revokedAt: Date | null;
}

export interface ApprovalRouteServices {
  /** null → every route answers 503 `approvals-not-configured` (no database). */
  approvals: Approvals | null;
  /** Grants issued for one card, newest first (M1.7's approval_grant rows with this approval id). */
  grantsFor: ((approvalId: string) => Promise<GrantSummary[]>) | null;
  /** M1.7 `revokeGrant` (the policy engine); null → the revoke route answers 503. */
  revokeGrant: ((session: unknown, grantId: string) => Promise<boolean>) | null;
}

export const APPROVALS_PAGE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUSES: readonly CardStatus[] = ["pending", "approved", "rejected", "expired"];

/** Maps any failure to a fixed code (DEVOS-104 item 3). */
export function mapApprovalError(e: unknown) {
  if (e instanceof Error && "getStatus" in e) return e;
  // Pre-review 3: every store failure is 503, whatever status the core chose for it.
  if (e instanceof ApprovalError) return httpError(e.code === "approvals-store-error" ? 503 : e.status, e.code);
  const msg = e instanceof Error ? e.message : "";
  // Pre-review 8: the engine's issuer checks are authorisation failures, not bad input.
  if (msg === "grant-issuer-not-kk" || msg === "grant-issuer-session-unverified") return httpError(403, msg);
  if (/^grant-[a-z0-9-]+$/.test(msg)) return httpError(400, msg);
  return httpError(503, "approvals-store-error");
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw mapApprovalError(e);
  }
}

/** A grant that can still lift a decision: not revoked, not expired, uses left. */
const isLive = (g: GrantSummary, now: number): boolean => g.revokedAt === null && g.expiresAt.getTime() > now && g.uses < g.maxUses;
/** Pre-review 1: the summary shows the newest live grant (a revoked race loser must not hide it), else the newest. */
export function pickGrant(grants: readonly GrantSummary[], now = Date.now()): GrantSummary | null {
  return grants.find((g) => isLive(g, now)) ?? grants[0] ?? null;
}

const iso = (d: Date | null | undefined): string | null => (d instanceof Date ? d.toISOString() : null);

function cardView(c: Card) {
  return {
    id: c.id,
    gate: c.gate,
    action: c.action,
    target: c.target,
    reason: c.reason,
    consequence: c.consequence,
    costUsd: c.costUsd,
    projectId: c.projectId,
    status: c.status,
    createdAt: iso(c.createdAt),
    decidedAt: iso(c.decidedAt),
    decidedBy: c.decidedBy,
  };
}

function grantView(g: GrantSummary) {
  return {
    id: g.id,
    scopeAction: g.scopeAction,
    scopeResource: g.scopeResource,
    projectId: g.projectId,
    sha: g.sha,
    expiresAt: iso(g.expiresAt),
    maxUses: g.maxUses,
    uses: g.uses,
    revoked: g.revokedAt !== null,
  };
}

@Controller("approvals")
export class ApprovalsController {
  constructor(
    @Inject(APPROVALS) private readonly svc: ApprovalRouteServices,
    @Inject(KK_SESSIONS) private readonly kk: KkSessionRegistry,
  ) {}

  private ready(): { approvals: Approvals; grantsFor: (id: string) => Promise<GrantSummary[]> } {
    if (!this.svc.approvals || !this.svc.grantsFor) throw httpError(503, "approvals-not-configured");
    return { approvals: this.svc.approvals, grantsFor: this.svc.grantsFor };
  }

  private session(req: DevosRequest) {
    return this.kk.mint(req.devos.login!);
  }

  /** Newest first, 50 per page; each card with its blocked-task count and its newest grant. */
  @Get()
  async list(@Query("status") status?: string, @Query("projectId") projectId?: string, @Query("cursor") cursor?: string) {
    if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) throw httpError(400, "invalid-input");
    if (projectId !== undefined && !UUID.test(projectId)) throw httpError(400, "invalid-input");
    if (cursor !== undefined && !UUID.test(cursor)) throw httpError(400, "invalid-input");
    const { approvals, grantsFor } = this.ready();
    return guarded(async () => {
      const cards = await approvals.store.list({
        ...(status ? { status: status as CardStatus } : {}),
        ...(projectId ? { projectId } : {}),
        ...(cursor ? { cursor } : {}),
        limit: APPROVALS_PAGE + 1,
      });
      // Pre-review 4: one extra row decides whether there is a next page.
      const page = cards.slice(0, APPROVALS_PAGE);
      const rows = [];
      for (const c of page) {
        const [blocked, grants] = await Promise.all([approvals.store.blockedTasks(c.id), grantsFor(c.id)]);
        const g = pickGrant(grants);
        rows.push({ ...cardView(c), blockedTasks: blocked.length, grant: g ? grantView(g) : null });
      }
      return { approvals: rows, nextCursor: cards.length > APPROVALS_PAGE ? page[page.length - 1]!.id : null };
    });
  }

  @Get(":id")
  async detail(@Param("id") id: string) {
    if (!UUID.test(id)) throw httpError(404, "card-not-found");
    const { approvals, grantsFor } = this.ready();
    return guarded(async () => {
      const c = await approvals.store.get(id);
      if (!c) throw new ApprovalError("card-not-found", 404);
      const [comments, blocked, grants] = await Promise.all([approvals.store.comments(id), approvals.store.blockedTasks(id), grantsFor(id)]);
      return {
        approval: cardView(c),
        comments: comments.map((x) => ({ id: x.id, author: x.author, body: x.body, createdAt: iso(x.createdAt) })),
        blockedTasks: blocked.map((t) => ({ id: t.id, title: t.title, status: t.status })),
        grant: ((g) => (g ? grantView(g) : null))(pickGrant(grants)),
      };
    });
  }

  @Post(":id/approve")
  @HttpCode(200)
  async approve(@Req() req: DevosRequest, @Param("id") id: string, @Body() body: unknown) {
    const { approvals } = this.ready();
    return guarded(async () => {
      const { card, grantId } = await approvals.approve(this.session(req), id, body ?? {});
      return { approval: cardView(card), grantId };
    });
  }

  @Post(":id/reject")
  @HttpCode(200)
  async reject(@Req() req: DevosRequest, @Param("id") id: string, @Body() body: unknown) {
    const b = body ?? {};
    if (typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => k !== "comment")) throw httpError(400, "invalid-input");
    const { approvals } = this.ready();
    return guarded(async () => ({ approval: cardView(await approvals.reject(this.session(req), id, (b as { comment?: unknown }).comment)) }));
  }

  @Post(":id/comments")
  @HttpCode(201)
  async comment(@Req() req: DevosRequest, @Param("id") id: string, @Body() body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "body")) throw httpError(400, "invalid-input");
    const { approvals } = this.ready();
    return guarded(async () => {
      const c = await approvals.comment(this.session(req), id, (body as { body?: unknown }).body);
      return { comment: { id: c.id, author: c.author, body: c.body, createdAt: iso(c.createdAt) } };
    });
  }

  /**
   * KK revokes the card's live grants (M1.7 `revokeGrant`): every grant of the card that is not revoked, not expired
   * and has uses left (pre-review 2: a failed race-loser revoke can leave two). The request is audited first; if the
   * audit cannot be written nothing is revoked. 404 `grant-not-found` when the card has no live grant.
   */
  @Post(":id/grant/revoke")
  @HttpCode(200)
  async revoke(@Req() req: DevosRequest, @Param("id") id: string) {
    if (!UUID.test(id)) throw httpError(404, "card-not-found");
    const { approvals, grantsFor } = this.ready();
    const revokeGrant = this.svc.revokeGrant;
    if (!revokeGrant) throw httpError(503, "approvals-not-configured");
    return guarded(async () => {
      const c = await approvals.store.get(id);
      if (!c) throw new ApprovalError("card-not-found", 404);
      const now = Date.now();
      const live = (await grantsFor(id)).filter((g) => isLive(g, now));
      if (!live.length) throw new ApprovalError("grant-not-found", 404);
      const grantIds = live.map((g) => g.id);
      await approvals.store.recordAudit({ action: "approval.grant_revoke_requested", summary: `Grant revoke requested for: ${c.action}`, details: { approvalId: id, grantIds } });
      const session = this.session(req);
      const revoked: string[] = [];
      for (const g of grantIds) if (await revokeGrant(session, g)) revoked.push(g);
      return { revoked: revoked.length > 0, grantIds: revoked };
    });
  }
}

// M1.2 routes. Every route is listed in openapi.yaml; the contract test checks both directions.
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { Access, GRANTS, KK_SESSIONS, KkSessionRegistry, READINESS, SESSIONS, httpError } from "./auth.js";
import type { KkSession } from "./auth.js";
import type { DevosRequest } from "./http.js";
import type { SessionService } from "./session.js";

/** The slice of the M1.7 PolicyEngine the API uses (PolicyEngine satisfies it). */
export interface GrantService {
  issueGrant(session: KkSession, scope: GrantScopeInput): Promise<unknown>;
  revokeGrant(session: KkSession, grantId: string): Promise<boolean>;
}
export interface GrantScopeInput {
  approvalId?: string | null;
  scopeAction: string;
  scopeResource?: string | null;
  projectId?: string | null;
  sha?: string | null;
  expiresAt: Date;
  maxUses?: number;
}
export type ReadinessProbe = () => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const GRANT_KEYS = new Set(["approvalId", "scopeAction", "scopeResource", "projectId", "sha", "expiresAt", "maxUses"]);

/** BS-A01: validate before anything reaches the engine or the database. Returns a code on failure. */
export function parseGrantScope(body: unknown): GrantScopeInput | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body-must-be-object";
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!GRANT_KEYS.has(k)) return `unknown-field:${k}`;
  const optStr = (k: string, re?: RegExp, max = 200): string | null | undefined | false => {
    const v = b[k];
    if (v === undefined || v === null) return v as null | undefined;
    if (typeof v !== "string" || v.length === 0 || v.length > max) return false;
    if (re && !re.test(v)) return false;
    return v;
  };
  if (typeof b.scopeAction !== "string" || b.scopeAction.length === 0 || b.scopeAction.length > 200) return "invalid:scopeAction";
  const scopeResource = optStr("scopeResource", undefined, 500);
  if (scopeResource === false) return "invalid:scopeResource";
  const projectId = optStr("projectId", UUID);
  if (projectId === false) return "invalid:projectId";
  const approvalId = optStr("approvalId", UUID);
  if (approvalId === false) return "invalid:approvalId";
  const sha = optStr("sha", SHA);
  if (sha === false) return "invalid:sha";
  if (typeof b.expiresAt !== "string" || !ISO.test(b.expiresAt) || Number.isNaN(Date.parse(b.expiresAt))) return "invalid:expiresAt";
  if (b.maxUses !== undefined && (!Number.isInteger(b.maxUses) || (b.maxUses as number) < 1 || (b.maxUses as number) > 1000)) {
    return "invalid:maxUses";
  }
  return {
    scopeAction: b.scopeAction,
    scopeResource: scopeResource ?? null,
    projectId: projectId ?? null,
    approvalId: approvalId ?? null,
    sha: sha ?? null,
    expiresAt: new Date(b.expiresAt),
    ...(b.maxUses !== undefined ? { maxUses: b.maxUses as number } : {}),
  };
}

@Controller()
export class HealthController {
  private readonly startedAt = new Date().toISOString();
  constructor(@Inject(READINESS) private readonly ready: ReadinessProbe) {}

  @Get("health")
  @Access("open")
  health() {
    return { status: "ok", sha: process.env.GIT_SHA ?? "unknown", startedAt: this.startedAt };
  }

  @Get("ready")
  @Access("open")
  async readiness() {
    try {
      await this.ready();
    } catch {
      throw httpError(503, "not-ready");
    }
    return { status: "ready" };
  }
}

@Controller("auth")
export class AuthController {
  constructor(@Inject(SESSIONS) private readonly sessions: SessionService) {}

  /** Sign-in: KK's live tailnet identity → a new 12-hour session (rotated every time). */
  @Post("session")
  @Access("tailnet")
  @HttpCode(201)
  signIn(@Req() req: DevosRequest, @Res({ passthrough: true }) res: Response) {
    const { token, claims } = this.sessions.issue(req.devos.login!);
    req.devos.claims = claims;
    res.setHeader("Set-Cookie", this.sessions.setCookie(token, claims));
    return { login: claims.login, expiresAt: new Date(claims.exp).toISOString(), csrfToken: this.sessions.csrfToken(claims) };
  }

  @Get("session")
  current(@Req() req: DevosRequest) {
    const claims = req.devos.claims!;
    return { login: claims.login, expiresAt: new Date(claims.exp).toISOString(), csrfToken: this.sessions.csrfToken(claims) };
  }

  @Delete("session")
  @HttpCode(204)
  signOut(@Res({ passthrough: true }) res: Response) {
    res.setHeader("Set-Cookie", this.sessions.clearCookie());
  }
}

/** Approval grants (ADR-0006): issued and revoked only by KK through the M1.7 engine. */
@Controller("grants")
export class GrantsController {
  constructor(
    @Inject(GRANTS) private readonly grants: GrantService | null,
    @Inject(KK_SESSIONS) private readonly kk: KkSessionRegistry,
  ) {}

  private engine(): GrantService {
    if (!this.grants) throw httpError(503, "policy-engine-not-configured");
    return this.grants;
  }

  @Post()
  @HttpCode(201)
  async issue(@Req() req: DevosRequest, @Body() body: unknown) {
    const scope = parseGrantScope(body);
    if (typeof scope === "string") throw httpError(400, scope);
    try {
      return { grant: await this.engine().issueGrant(this.kk.mint(req.devos.login!), scope) };
    } catch (e) {
      throw mapEngineError(e);
    }
  }

  @Post(":id/revoke")
  @HttpCode(200)
  async revoke(@Req() req: DevosRequest, @Param("id") id: string) {
    if (!UUID.test(id)) throw httpError(400, "invalid:id");
    try {
      return { revoked: await this.engine().revokeGrant(this.kk.mint(req.devos.login!), id) };
    } catch (e) {
      throw mapEngineError(e);
    }
  }
}

function mapEngineError(e: unknown) {
  if (e instanceof Error && "getStatus" in e) return e;
  const msg = e instanceof Error ? e.message : "";
  // Engine validation codes (`grant-*`) are the caller's fault; anything else fails closed as 503.
  if (/^grant-[a-z0-9-]+$/.test(msg)) return httpError(400, msg);
  return httpError(503, "policy-engine-error");
}

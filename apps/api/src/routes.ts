// M1.2 routes. Every route is listed in openapi.yaml; the contract test checks both directions.
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { Access, GRANTS, KK_SESSIONS, KkSessionRegistry, READINESS, SESSIONS, SETUP, httpError } from "./auth.js";
import type { KkSession } from "./auth.js";
import type { DevosRequest } from "./http.js";
import type { SessionService } from "./session.js";
import { parseAppSettings, parseProjectSettings, type SettingsStore } from "./settings.js";
import { SECRET_NAMES, Vault, checkSecretValue, isSecretName } from "./vault.js";

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

// ---------- M1.4 setup wizard, settings and vault (docs/modules/M1.4.md) ----------

export interface SetupServices {
  settings: SettingsStore | null;
  vault: Vault | null;
}

const ok = <T>(v: T | null, code: string): T => {
  if (!v) throw httpError(503, code);
  return v;
};

/** Store failures never echo a driver message (it could carry a value); they fail closed as 503. */
async function guarded<T>(fn: () => Promise<T>, code: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Error && "getStatus" in e) throw e;
    throw httpError(503, code);
  }
}

@Controller("setup")
export class SetupController {
  constructor(@Inject(SETUP) private readonly svc: SetupServices) {}

  /** Wizard state: caps confirmed? which secrets are set? Names and dates only. */
  @Get()
  async status() {
    const settings = ok(this.svc.settings, "settings-not-configured");
    const s = await guarded(() => settings.get(), "settings-store-error");
    const secrets = this.svc.vault
      ? (await guarded(() => this.svc.vault!.list(), "vault-store-error")).map((m) => ({ name: m.name, set: m.set }))
      : SECRET_NAMES.map((name) => ({ name, set: false }));
    const vaultConfigured = this.svc.vault !== null;
    return {
      capsConfirmed: s.capsConfirmedAt !== null,
      vaultConfigured,
      secrets,
      complete: s.capsConfirmedAt !== null && vaultConfigured && secrets.every((x) => x.set),
    };
  }

  /** Wizard caps step: all three caps are required (O5); stamps capsConfirmedAt. */
  @Put("caps")
  @HttpCode(200)
  async caps(@Body() body: unknown) {
    return { settings: await saveSettings(this.svc, body, true) };
  }
}

async function saveSettings(svc: SetupServices, body: unknown, requireCaps: boolean) {
  const settings = ok(svc.settings, "settings-not-configured");
  const current = await guarded(() => settings.get(), "settings-store-error");
  const patch = parseAppSettings(body, current.maxLanes, requireCaps);
  if (typeof patch === "string") throw httpError(400, patch);
  // DEVOS-176 (pre-review finding 3): the model pass spends money, so its new value is kept in the audit row.
  const details = { fields: Object.keys(patch), ...(patch.analystModelPass !== undefined ? { analystModelPass: patch.analystModelPass } : {}) };
  const audit = { action: "settings.updated", summary: "Settings saved", details };
  return guarded(() => settings.update(patch, new Date(), audit), "settings-store-error");
}

@Controller("settings")
export class SettingsController {
  constructor(@Inject(SETUP) private readonly svc: SetupServices) {}

  @Get()
  async get() {
    const settings = ok(this.svc.settings, "settings-not-configured");
    return { settings: await guarded(() => settings.get(), "settings-store-error") };
  }

  /** Settings page: any subset of caps, default lanes and deadlock attempts. */
  @Put()
  @HttpCode(200)
  async put(@Body() body: unknown) {
    return { settings: await saveSettings(this.svc, body, false) };
  }
}

@Controller("projects")
export class ProjectSettingsController {
  constructor(@Inject(SETUP) private readonly svc: SetupServices) {}

  /** Per-project cap and lanes (1–3). */
  @Put(":id/settings")
  @HttpCode(200)
  async put(@Param("id") id: string, @Body() body: unknown) {
    if (!UUID.test(id)) throw httpError(400, "invalid:id");
    const settings = ok(this.svc.settings, "settings-not-configured");
    const current = await guarded(() => settings.get(), "settings-store-error");
    const patch = parseProjectSettings(body, current.maxLanes);
    if (typeof patch === "string") throw httpError(400, patch);
    const audit = { action: "project.settings.updated", summary: "Project settings saved", details: { fields: Object.keys(patch) }, projectId: id };
    const r = await guarded(() => settings.updateProject(id, patch, audit), "settings-store-error");
    if (r === "not-found") throw httpError(404, "project-not-found");
    if (r === "archived") throw httpError(409, "project-archived");
    return { project: r };
  }
}

@Controller("vault")
export class VaultController {
  constructor(@Inject(SETUP) private readonly svc: SetupServices) {}

  /** Names, last 4 characters and dates. Never a value. */
  @Get("secrets")
  async list() {
    const vault = ok(this.svc.vault, "vault-not-configured");
    return { secrets: await guarded(() => vault.list(), "vault-store-error") };
  }

  /** Save or rotate one secret. Write-only: the response carries metadata only. */
  @Put("secrets/:name")
  @HttpCode(200)
  async put(@Param("name") name: string, @Body() body: unknown) {
    if (!isSecretName(name)) throw httpError(400, "invalid:name");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError(400, "body-must-be-object");
    const b = body as Record<string, unknown>;
    for (const k of Object.keys(b)) if (k !== "value") throw httpError(400, "unknown-field");
    const problem = checkSecretValue(b.value);
    if (problem) throw httpError(400, problem);
    const vault = ok(this.svc.vault, "vault-not-configured");
    // The secret and its audit event commit in one transaction (PR17-r1).
    const { meta, rotated } = await guarded(() => vault.put(name, b.value as string), "vault-store-error");
    return { secret: meta, rotated };
  }
}

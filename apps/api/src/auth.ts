// Deny-by-default access (BS-A02 / ADR-0011): every route needs KK's live tailnet identity AND a
// valid session bound to that same login, unless it is marked open (`/health`, `/ready`) or
// tailnet-only (sign-in). Every state-changing request also passes the CSRF checks (ADR-0011 §1).
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ApiConfig } from "./config.js";
import type { DevosRequest } from "./http.js";
import type { IdentityResolver } from "./identity.js";
import type { SessionService } from "./session.js";

export type AccessLevel = "open" | "tailnet" | "session";
export const ACCESS_KEY = "devos:access";
/** Route access; anything not marked is `session`. */
export const Access = (level: AccessLevel) => SetMetadata(ACCESS_KEY, level);

export const CONFIG = Symbol("devos:config");
export const IDENTITY = Symbol("devos:identity");
export const SESSIONS = Symbol("devos:sessions");
export const GRANTS = Symbol("devos:grants");
export const READINESS = Symbol("devos:readiness");
export const KK_SESSIONS = Symbol("devos:kk-sessions");
export const SETUP = Symbol("devos:setup");

export const CSRF_HEADER = "x-devos-csrf";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** M1.7 `KkSession` shape (structural: `@devos/policy` engine.ts). */
export interface KkSession {
  identity: { id: string; type: "kk" };
  tailscaleLogin: string;
}

/**
 * KK sessions minted by this process for a request that passed identity + session checks.
 * `verify` is the `verifyKkSession` hook for the M1.7 PolicyEngine: an object not minted here
 * (built by an agent, copied, or deserialised) is never accepted.
 */
export class KkSessionRegistry {
  private readonly minted = new WeakSet<object>();
  mint(login: string): KkSession {
    const s: KkSession = Object.freeze({ identity: Object.freeze({ id: `kk:${login}`, type: "kk" as const }), tailscaleLogin: login });
    this.minted.add(s);
    return s;
  }
  readonly verify = (session: unknown): boolean => typeof session === "object" && session !== null && this.minted.has(session);
}

/** Origin (or, without it, Referer) must be an allowed origin; cross-site fetch metadata is refused. */
export function sameOriginProblem(req: DevosRequest, allowed: readonly string[]): string | null {
  const site = req.headers["sec-fetch-site"];
  const origin = req.headers.origin;
  // M1.4: the dashboard and the API are the same site on different ports, so the browser sends
  // `same-site`. That is accepted only together with an exact allowed Origin; `cross-site` never is.
  const sameSiteAllowed = site === "same-site" && typeof origin === "string" && allowed.includes(origin);
  if (typeof site === "string" && site !== "same-origin" && site !== "none" && !sameSiteAllowed) return "csrf-cross-site";
  if (typeof origin === "string") return allowed.includes(origin) ? null : "csrf-origin-refused";
  const referer = req.headers.referer;
  if (typeof referer === "string") {
    try {
      return allowed.includes(new URL(referer).origin) ? null : "csrf-referer-refused";
    } catch {
      return "csrf-referer-refused";
    }
  }
  return "csrf-origin-missing";
}

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(IDENTITY) private readonly identity: IdentityResolver,
    @Inject(SESSIONS) private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const level =
      this.reflector.getAllAndOverride<AccessLevel>(ACCESS_KEY, [context.getHandler(), context.getClass()]) ?? "session";
    if (level === "open") return true;

    const req = context.switchToHttp().getRequest<DevosRequest>();
    const stateChanging = !SAFE_METHODS.has(req.method);
    if (stateChanging) {
      const problem = sameOriginProblem(req, this.config.allowedOrigins);
      if (problem) throw new ForbiddenException({ statusCode: 403, code: problem });
    }

    let who;
    try {
      who = await this.identity.whois(req.socket.remoteAddress ?? "", req.socket.remotePort ?? 0);
    } catch {
      // Fail closed: no identity, no access.
      throw new ServiceUnavailableException({ statusCode: 503, code: "identity-unavailable" });
    }
    if (!who || who.login !== this.config.kkLogin) throw new ForbiddenException({ statusCode: 403, code: "not-kk" });
    req.devos.login = who.login;
    if (level === "tailnet") return true;

    const claims = this.sessions.verify(this.sessions.readCookie(req.headers.cookie));
    if (!claims || claims.login !== who.login) throw new UnauthorizedException({ statusCode: 401, code: "session-required" });
    if (stateChanging) {
      const presented = req.headers[CSRF_HEADER];
      if (!this.sessions.checkCsrf(claims, typeof presented === "string" ? presented : undefined)) {
        throw new ForbiddenException({ statusCode: 403, code: "csrf-token-invalid" });
      }
    }
    req.devos.claims = claims;
    return true;
  }
}

export function httpError(status: number, code: string): HttpException {
  return new HttpException({ statusCode: status, code }, status);
}

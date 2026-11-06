// Dashboard session (ADR-0011 §1, §3): a signed, HttpOnly, SameSite=Strict cookie with a 12-hour
// ABSOLUTE lifetime (never extended), a fresh random id at every sign-in (rotation), and a
// per-session CSRF token derived from that id.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SESSION_TTL_MS } from "./config.js";

export interface SessionClaims {
  v: 1;
  sid: string;
  login: string;
  iat: number;
  exp: number;
}

const b64u = (buf: Buffer) => buf.toString("base64url");

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class SessionService {
  readonly cookieName: string;

  constructor(
    private readonly key: Buffer,
    private readonly secure: boolean,
    private readonly now: () => number = Date.now,
  ) {
    // `__Host-` needs Secure; without HTTPS (ADR-0005) the plain name is used.
    this.cookieName = secure ? "__Host-devos_session" : "devos_session";
  }

  private mac(label: string, data: string): string {
    return b64u(createHmac("sha256", this.key).update(`${label}\n${data}`).digest());
  }

  /** New session for `login`: a new random id every time (rotation at sign-in). */
  issue(login: string): { token: string; claims: SessionClaims } {
    const iat = this.now();
    const claims: SessionClaims = { v: 1, sid: b64u(randomBytes(32)), login, iat, exp: iat + SESSION_TTL_MS };
    const payload = b64u(Buffer.from(JSON.stringify(claims), "utf8"));
    return { token: `${payload}.${this.mac("session", payload)}`, claims };
  }

  /** Claims if the token is authentic and inside its absolute lifetime; otherwise null. */
  verify(token: string | undefined): SessionClaims | null {
    if (!token || token.length > 1024) return null;
    const dot = token.indexOf(".");
    if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
    const payload = token.slice(0, dot);
    if (!safeEqual(token.slice(dot + 1), this.mac("session", payload))) return null;
    let claims: SessionClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionClaims;
    } catch {
      return null;
    }
    if (claims?.v !== 1 || typeof claims.sid !== "string" || typeof claims.login !== "string") return null;
    if (!Number.isFinite(claims.iat) || claims.exp !== claims.iat + SESSION_TTL_MS) return null;
    const t = this.now();
    if (t >= claims.exp || claims.iat > t + 60_000) return null;
    return claims;
  }

  csrfToken(claims: SessionClaims): string {
    return this.mac("csrf", claims.sid);
  }

  checkCsrf(claims: SessionClaims, presented: string | undefined): boolean {
    return typeof presented === "string" && safeEqual(presented, this.csrfToken(claims));
  }

  /** Set-Cookie value. Max-Age is the time left on the absolute lifetime. */
  setCookie(token: string, claims: SessionClaims): string {
    const maxAge = Math.max(0, Math.floor((claims.exp - this.now()) / 1000));
    return [
      `${this.cookieName}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${maxAge}`,
      ...(this.secure ? ["Secure"] : []),
    ].join("; ");
  }

  clearCookie(): string {
    return [`${this.cookieName}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0", ...(this.secure ? ["Secure"] : [])].join("; ");
  }

  /** Read this service's cookie from a Cookie header (first occurrence only). */
  readCookie(header: string | undefined): string | undefined {
    if (!header) return undefined;
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === this.cookieName) return part.slice(eq + 1).trim();
    }
    return undefined;
  }
}

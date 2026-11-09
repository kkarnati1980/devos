// M1.2 configuration. Every value comes from the environment (Coolify env / server vault);
// nothing secret is defaulted or logged. docs/modules/M1.2.md "Configuration".
import { readFileSync } from "node:fs";

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // ADR-0011 §3: 12-hour absolute lifetime.
export const MIN_SESSION_KEY_BYTES = 32;

export interface ApiConfig {
  /** KK's Tailscale login (e.g. `kk@example.com`). Only this login may sign in. */
  kkLogin: string;
  /** HMAC key for session cookies and CSRF tokens (≥ 32 bytes). */
  sessionKey: Buffer;
  /** Origins allowed on state-changing requests (exact `scheme://host[:port]`). */
  allowedOrigins: string[];
  /** `Secure` cookies + HSTS; on once the dashboard has browser-trusted HTTPS (ADR-0011 §6, M1.3). */
  secureCookies: boolean;
  /** tailscaled LocalAPI socket. */
  tailscaleSocket: string;
  /** Timeout for every outbound call (ADR-0011 §9). */
  outboundTimeoutMs: number;
  host: string;
  port: number;
}

function originOf(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`config-origin-invalid`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("config-origin-invalid");
  if (url.origin !== value.replace(/\/$/, "")) throw new Error("config-origin-invalid");
  return url.origin;
}

const CONFIG_CODE = /^config-[a-z0-9-]+$/;
const NODE_ERROR_CODE = /^E[A-Z0-9_]{1,40}$/;

/**
 * PR14-r2: map any start-up failure to a controlled code before it is logged. Only our own
 * `config-*` codes and a bare Node system error code (e.g. `ENOTFOUND`, `EADDRINUSE`) pass;
 * `e.message` from a dependency is never logged, because it can carry configuration values
 * (a hostname, a path, a URL).
 */
export function startupErrorCode(e: unknown): string {
  if (e instanceof Error) {
    if (CONFIG_CODE.test(e.message)) return e.message;
    const sys = (e as { code?: unknown }).code;
    if (typeof sys === "string" && NODE_ERROR_CODE.test(sys)) return `startup-${sys.toLowerCase()}`;
  }
  return "startup-failed";
}

/** Parse and validate the environment. Throws a code (never the value) on a bad setting. */
export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const kkLogin = (env.DEVOS_KK_LOGIN ?? "").trim().toLowerCase();
  if (!kkLogin || !/^[^\s@]+@[^\s@]+$/.test(kkLogin)) throw new Error("config-kk-login-required");

  const rawKey = env.DEVOS_SESSION_KEY ?? "";
  const sessionKey = Buffer.from(rawKey, "utf8");
  if (sessionKey.length < MIN_SESSION_KEY_BYTES) throw new Error("config-session-key-too-short");

  const allowedOrigins = (env.DEVOS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(originOf);
  if (allowedOrigins.length === 0) throw new Error("config-allowed-origins-required");

  const outboundTimeoutMs = Number(env.DEVOS_OUTBOUND_TIMEOUT_MS ?? 3000);
  if (!Number.isInteger(outboundTimeoutMs) || outboundTimeoutMs < 100 || outboundTimeoutMs > 30_000) {
    throw new Error("config-outbound-timeout-invalid");
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("config-port-invalid");

  // PR14-r2: only "1" (on) or "0"/unset (off). Anything else ("true", "yes", …) stops start-up,
  // so a typo can never silently drop Secure cookies, the __Host- name and HSTS.
  const rawSecure = env.DEVOS_COOKIE_SECURE;
  if (rawSecure !== undefined && rawSecure !== "" && rawSecure !== "0" && rawSecure !== "1") {
    throw new Error("config-cookie-secure-invalid");
  }

  return {
    kkLogin,
    sessionKey,
    allowedOrigins,
    secureCookies: rawSecure === "1",
    tailscaleSocket: env.DEVOS_TAILSCALE_SOCKET ?? "/var/run/tailscale/tailscaled.sock",
    outboundTimeoutMs,
    host: env.HOST ?? "0.0.0.0",
    port,
  };
}

/** PEM bytes of the certificate and key for in-process HTTPS (R3-a). */
export interface ApiTls {
  cert: Buffer;
  key: Buffer;
}

/** File contents, or null when the path cannot be read as a non-empty file. Never logs the path. */
function readPem(path: string, read: (p: string) => Buffer): Buffer | null {
  try {
    const buf = read(path);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * R3-a (DEVOS-81): in-process HTTPS with the `tailscale cert` files, same rules as the dashboard (M1.3-a,
 * DEVOS-84). An HTTPS dashboard page cannot call a plain-HTTP API (mixed content), so with
 * `DEVOS_COOKIE_SECURE=1` the API never falls back to plain HTTP: both files must be readable, or start-up
 * stops with `config-tls-required`. With 0/unset, no files = plain HTTP (local tests, CI); half a pair or an
 * unreadable file stops start-up. Errors carry a code only, never a path or file content.
 */
export function loadTls(env: NodeJS.ProcessEnv, secure: boolean, read: (p: string) => Buffer = readFileSync): ApiTls | null {
  const certPath = env.DEVOS_TLS_CERT_FILE ?? "";
  const keyPath = env.DEVOS_TLS_KEY_FILE ?? "";
  if (secure) {
    const cert = certPath ? readPem(certPath, read) : null;
    const key = keyPath ? readPem(keyPath, read) : null;
    if (!cert || !key) throw new Error("config-tls-required");
    return { cert, key };
  }
  if (Boolean(certPath) !== Boolean(keyPath)) throw new Error("config-tls-incomplete");
  if (!certPath) return null;
  const cert = readPem(certPath, read);
  const key = readPem(keyPath, read);
  if (!cert || !key) throw new Error("config-tls-unreadable");
  return { cert, key };
}

// Request IDs, JSON request logs and the security-header set (ADR-0011 §1–2, Phase PS M1.2 amendment).
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { SessionClaims } from "./session.js";

export interface RequestContext {
  requestId: string;
  login?: string;
  claims?: SessionClaims;
}

export type DevosRequest = Request & { devos: RequestContext };

/** One JSON object per line. Never receives cookies, tokens, bodies or query strings. */
export type LogSink = (entry: Record<string, unknown>) => void;
export const stdoutSink: LogSink = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);

const INCOMING_ID = /^[A-Za-z0-9._-]{8,64}$/;

export function requestContext(log: LogSink) {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers["x-request-id"];
    const requestId = typeof incoming === "string" && INCOMING_ID.test(incoming) ? incoming : randomUUID();
    (req as DevosRequest).devos = { requestId };
    res.setHeader("X-Request-Id", requestId);
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const ctx = (req as DevosRequest).devos;
      log({
        ts: new Date().toISOString(),
        level: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
        msg: "request",
        requestId: ctx.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        identity: ctx.login ? `kk:${ctx.login}` : null,
      });
    });
    next();
  };
}

/** The API serves JSON only, so its CSP denies everything; the dashboard sets its own (M1.3). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
  "X-DNS-Prefetch-Control": "off",
  "X-Permitted-Cross-Domain-Policies": "none",
};
export const HSTS = "max-age=31536000; includeSubDomains";

export function securityHeaders(secure: boolean) {
  return (_req: Request, res: Response, next: NextFunction) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (secure) res.setHeader("Strict-Transport-Security", HSTS);
    res.removeHeader("X-Powered-By");
    next();
  };
}

/** Run `fn` with a hard deadline (ADR-0011 §9). */
export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, code = "timeout"): Promise<T> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error(code));
    }, ms);
  });
  try {
    return await Promise.race([fn(ac.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// M1.4: the dashboard calls the API straight from the browser, so the API still sees KK's tailnet
// peer (no proxy: M1.2 identity, M1.3 HTTPS decision). CORS is answered only for an exact
// `DEVOS_ALLOWED_ORIGINS` entry, with credentials; any other origin gets no CORS headers, so the
// browser keeps the response from it. CORS is not access control: every request still passes the
// identity, session and CSRF checks.
import type { NextFunction, Request, Response } from "express";

export const CORS_METHODS = "GET, PUT, POST, DELETE";
export const CORS_HEADERS = "content-type, x-devos-csrf, x-request-id";

export function cors(allowed: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.append("Vary", "Origin");
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !allowed.includes(origin)) return next();
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Expose-Headers", "x-request-id");
    if (req.method === "OPTIONS" && typeof req.headers["access-control-request-method"] === "string") {
      res.setHeader("Access-Control-Allow-Methods", CORS_METHODS);
      res.setHeader("Access-Control-Allow-Headers", CORS_HEADERS);
      res.setHeader("Access-Control-Max-Age", "600");
      res.status(204).end();
      return;
    }
    next();
  };
}

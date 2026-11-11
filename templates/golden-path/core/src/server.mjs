// Core HTTP server: /health (liveness), /ready (readiness checks), deny by default (404 everywhere else),
// one JSON log line per request with its request ID.
import http from "node:http";
import { loadConfig } from "./config.mjs";
import { log, requestId } from "./log.mjs";

export function createApp({ config = loadConfig(), readyChecks = [], routes = {}, out = process.stdout } = {}) {
  const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
  return http.createServer(async (req, res) => {
    const id = requestId(req.headers["x-request-id"]);
    res.setHeader("x-request-id", id);
    const started = Date.now();
    res.on("finish", () => log({ level: "info", requestId: id, method: req.method, path: (req.url || "").split("?")[0], status: res.statusCode, ms: Date.now() - started }, out));
    try {
      const path = new URL(req.url || "/", "http://app").pathname;
      if (req.method === "GET" && path === "/health") return send(res, 200, { status: "ok", sha: config.server.sha });
      if (req.method === "GET" && path === "/ready") {
        const failed = [];
        for (const c of readyChecks) {
          try { if (!(await c.check())) failed.push(c.name); } catch { failed.push(c.name); }
        }
        return failed.length ? send(res, 503, { status: "not-ready", failed }) : send(res, 200, { status: "ready" });
      }
      const h = routes[`${req.method} ${path}`];
      if (h) return await h(req, res, { requestId: id, config });
      return send(res, 404, { error: "not-found" });
    } catch (e) {
      log({ level: "error", requestId: id, error: String(e && e.message) }, out);
      if (!res.headersSent) send(res, 500, { error: "internal", requestId: id });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  createApp({ config }).listen(config.server.port, config.server.host, () => log({ level: "info", msg: "listening", port: config.server.port }));
}

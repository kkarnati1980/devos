// A stand-in for the M1.4 API routes in browser tests: CORS for one origin with credentials, a
// session cookie, a CSRF token, and write-only secrets (metadata back, values only recorded here).
import http from "node:http";

const NAMES = ["anthropic_api_key", "openai_api_key", "github_token", "linear_api_key", "r2_access_key_id", "r2_secret_access_key", "coolify_api_token"];

export async function startStubApi(allowedOrigin) {
  const state = { received: [], csrfSeen: [], settings: { anthropicCapUsd: "15.00", openaiCapUsd: "15.00", defaultProjectCapUsd: "15.00", defaultLanes: 2, maxLanes: 3, deadlockAttempts: 3, capsConfirmedAt: null, updatedAt: null }, secrets: new Map() };
  const meta = (name) => {
    const v = state.secrets.get(name);
    return v ? { name, set: true, hint: v.slice(-4), keyVersion: 1, createdAt: "2026-11-06T10:00:00.000Z", updatedAt: "2026-11-06T10:00:00.000Z" } : { name, set: false, hint: null, keyVersion: null, createdAt: null, updatedAt: null };
  };
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    res.setHeader("Vary", "Origin");
    if (origin === allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE");
      res.setHeader("Access-Control-Allow-Headers", "content-type, x-devos-csrf, x-request-id");
      res.writeHead(204).end();
      return;
    }
    let body = "";
    for await (const c of req) body += c;
    const json = (status, v) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    const url = req.url ?? "";
    if (req.method !== "GET" && req.method !== "POST") state.csrfSeen.push(req.headers["x-devos-csrf"] ?? null);
    if (req.method === "POST" && url === "/auth/session") {
      res.setHeader("Set-Cookie", "devos_session=stub; HttpOnly; SameSite=Strict; Path=/");
      return json(201, { login: "kk@example.com", expiresAt: "2026-11-06T22:00:00.000Z", csrfToken: "stub-csrf" });
    }
    if (!/devos_session=stub/.test(req.headers.cookie ?? "")) return json(401, { statusCode: 401, code: "session-required" });
    if (req.method !== "GET" && req.headers["x-devos-csrf"] !== "stub-csrf") return json(403, { statusCode: 403, code: "csrf-token-invalid" });
    if (req.method === "GET" && url === "/setup") {
      return json(200, { capsConfirmed: state.settings.capsConfirmedAt !== null, vaultConfigured: true, secrets: NAMES.map((n) => ({ name: n, set: state.secrets.has(n) })), complete: false });
    }
    if (req.method === "GET" && url === "/settings") return json(200, { settings: state.settings });
    if (req.method === "PUT" && (url === "/setup/caps" || url === "/settings")) {
      state.received.push({ url, body });
      const b = JSON.parse(body);
      for (const k of ["anthropicCapUsd", "openaiCapUsd", "defaultProjectCapUsd"]) if (b[k] !== undefined) b[k] = Number(b[k]).toFixed(2);
      state.settings = { ...state.settings, ...b, capsConfirmedAt: "2026-11-06T10:00:00.000Z" };
      return json(200, { settings: state.settings });
    }
    if (req.method === "GET" && url === "/vault/secrets") return json(200, { secrets: NAMES.map(meta) });
    const m = url.match(/^\/vault\/secrets\/([a-z0-9_]+)$/);
    if (req.method === "PUT" && m && NAMES.includes(m[1])) {
      const rotated = state.secrets.has(m[1]);
      state.secrets.set(m[1], JSON.parse(body).value);
      state.received.push({ url, body: "(secret)" });
      return json(200, { secret: meta(m[1]), rotated });
    }
    return json(404, { statusCode: 404, code: "not-found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { state, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

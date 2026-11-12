// A stand-in for the M1.4 API routes in browser tests: CORS for one origin with credentials, a
// session cookie, a CSRF token, and write-only secrets (metadata back, values only recorded here).
import http from "node:http";

const NAMES = ["anthropic_api_key", "openai_api_key", "github_token", "linear_api_key", "r2_access_key_id", "r2_secret_access_key", "coolify_api_token", "mybrain_bell_key", "smtp_password"];

export async function startStubApi(allowedOrigin) {
  const state = { signIns: 0, received: [], csrfSeen: [], settings: { anthropicCapUsd: "15.00", openaiCapUsd: "15.00", defaultProjectCapUsd: "15.00", defaultLanes: 2, maxLanes: 3, deadlockAttempts: 3, capsConfirmedAt: null, updatedAt: null }, secrets: new Map(), deadLetters: [{ jobId: "run-7", runId: "run-7", reason: "run-provider_error <img src=x onerror=window.__xss2=1>", attemptsMade: 3, failedAt: "2026-11-06T09:00:00.000Z" }, { jobId: "run-8", runId: "run-8", reason: "run-tool_denied", attemptsMade: 1, failedAt: null }], notices: [], channels: [{ kind: "dashboard", enabled: true, target: null, configured: true }, { kind: "mybrain", enabled: true, target: null, configured: true }, { kind: "email", enabled: true, target: null, configured: true }] };
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
    // Like M1.2: every sign-in rotates the cookie and its CSRF token; GET /auth/session returns
    // the token for the cookie presented; a write needs the token of the current cookie.
    if (req.method === "POST" && url === "/auth/session") {
      const n = ++state.signIns;
      res.setHeader("Set-Cookie", `devos_session=stub-${n}; HttpOnly; SameSite=Strict; Path=/`);
      return json(201, { login: "kk@example.com", expiresAt: "2026-11-06T22:00:00.000Z", csrfToken: `stub-csrf-${n}` });
    }
    const sid = (req.headers.cookie ?? "").match(/devos_session=stub-(\d+)/)?.[1];
    if (!sid || Number(sid) !== state.signIns) return json(401, { statusCode: 401, code: "session-required" });
    if (req.method === "GET" && url === "/auth/session") {
      return json(200, { login: "kk@example.com", expiresAt: "2026-11-06T22:00:00.000Z", csrfToken: `stub-csrf-${sid}` });
    }
    if (req.method !== "GET" && req.headers["x-devos-csrf"] !== `stub-csrf-${sid}`) {
      state.csrfRefused = (state.csrfRefused ?? 0) + 1;
      return json(403, { statusCode: 403, code: "csrf-token-invalid" });
    }
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
    // M1.6 notifications
    if (req.method === "GET" && url === "/notifications") return json(200, { notices: state.notices });
    if (req.method === "GET" && url === "/notifications/channels") return json(200, { channels: state.channels });
    const ch = url.match(/^\/notifications\/channels\/(dashboard|mybrain|email)$/);
    if (req.method === "PUT" && ch) {
      state.received.push({ url, body });
      const c = state.channels.find((x) => x.kind === ch[1]);
      Object.assign(c, JSON.parse(body));
      return json(200, { channel: { kind: c.kind, enabled: c.enabled, target: c.target } });
    }
    // DEVOS-77 dead-letter view
    if (req.method === "GET" && url === "/runs/dead-letters") return json(200, { deadLetters: state.deadLetters });
    const dl = url.match(/^\/runs\/dead-letters\/([A-Za-z0-9._-]+)\/retry$/);
    if (req.method === "POST" && dl) {
      state.received.push({ url, body });
      const i = state.deadLetters.findIndex((d) => d.jobId === dl[1]);
      if (i < 0) return json(404, { statusCode: 404, code: "dead-letter-not-found" });
      state.deadLetters.splice(i, 1);
      return json(200, { retried: dl[1] });
    }
    if (req.method === "POST" && url === "/notifications/test") {
      state.received.push({ url, body });
      const deliveries = state.channels.filter((c) => c.enabled).map((c) => ({ channel: c.kind, status: "sent", error: null }));
      const id = `00000000-0000-4000-8000-${String(state.notices.length + 1).padStart(12, "0")}`;
      state.notices.unshift({ id, kind: "test", title: "DevOS test card <script>window.__xss=1</script>", body: "This is a test notice.", reasons: ["Sent from the dashboard"], createdAt: "2026-11-06T10:00:00.000Z", deliveries });
      return json(201, { notice: state.notices[0], deliveries });
    }
    return json(404, { statusCode: 404, code: "not-found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { state, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

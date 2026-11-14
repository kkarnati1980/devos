// A stand-in for the M1.4 API routes in browser tests: CORS for one origin with credentials, a
// session cookie, a CSRF token, and write-only secrets (metadata back, values only recorded here).
import http from "node:http";

const NAMES = ["anthropic_api_key", "openai_api_key", "github_token", "linear_api_key", "r2_access_key_id", "r2_secret_access_key", "coolify_api_token", "mybrain_bell_key", "smtp_password"];

export async function startStubApi(allowedOrigin) {
  const state = { signIns: 0, received: [], csrfSeen: [], settings: { anthropicCapUsd: "15.00", openaiCapUsd: "15.00", defaultProjectCapUsd: "15.00", defaultLanes: 2, maxLanes: 3, deadlockAttempts: 3, analystModelPass: false, capsConfirmedAt: null, updatedAt: null }, secrets: new Map(), deadLetters: [{ jobId: "run-7", runId: "run-7", reason: "run-provider_error <img src=x onerror=window.__xss2=1>", attemptsMade: 3, failedAt: "2026-11-06T09:00:00.000Z" }, { jobId: "run-8", runId: "run-8", reason: "run-tool_denied", attemptsMade: 1, failedAt: null }], notices: [], channels: [{ kind: "dashboard", enabled: true, target: null, configured: true }, { kind: "mybrain", enabled: true, target: null, configured: true }, { kind: "email", enabled: true, target: null, configured: true }] };
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
    // ADR-0012 CR-a3 (DEVOS-199): one approved project waiting for a secret, with seeded markup in its texts.
    if (req.method === "GET" && url === "/projects/by-slug/xss-probe/preflight") {
      return json(200, {
        preflight: {
          continuousRun: true,
          state: "approved",
          open: false,
          items: [
            { id: "PF-1", kind: "decision", text: "Who pays for SMS? <img src=x onerror=window.__xss3=1>", default: "Architect decides" },
            { id: "PF-2", kind: "decision", text: "Monthly spend cap for this project", default: "USD 15 (the project's budget envelope)" },
            { id: "PF-3", kind: "secret", text: "SMS_API_KEY", default: "enter in setup wizard" },
          ],
          missingSecrets: ["SMS_API_KEY"],
          secretsUnverified: false,
          decisions: [
            { itemId: "PF-1", answer: "the client <b>pays</b>", source: "kk", createdAt: "2026-11-14T10:00:00.000Z" },
            { itemId: "PF-2", answer: "USD 15 (the project's budget envelope)", source: "default", createdAt: "2026-11-14T10:00:00.000Z" },
          ],
        },
      });
    }
    if (req.method === "GET" && url.startsWith("/projects/by-slug/")) return json(404, { statusCode: 404, code: "project-not-found" });
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
    // M2.3-b2 (DEVOS-135) approvals inbox
    const A1 = "00000000-0000-4000-8000-0000000000a1";
    const A2 = "00000000-0000-4000-8000-0000000000a2";
    const A3 = "00000000-0000-4000-8000-0000000000a3";
    state.approvals ??= [
      { id: A3, gate: "purge", action: "purge", target: "project:old", reason: "teardown", consequence: "deletes the project's data", costUsd: null, projectId: null, status: "pending", createdAt: "2026-11-10T10:00:00.000Z", decidedAt: null, decidedBy: null, blockedTasks: 0, grant: null },
      { id: A1, gate: "decision", action: "deploy <img src=x onerror=window.__xss3=1>", target: "project:shop", reason: "first deploy", consequence: null, costUsd: "2.50", projectId: null, status: "pending", createdAt: "2026-11-12T10:00:00.000Z", decidedAt: null, decidedBy: null, blockedTasks: 1, grant: null },
      { id: "00000000-0000-4000-8000-0000000000a4", gate: "decision", action: "old approve", target: "x", reason: "older", consequence: null, costUsd: null, projectId: null, status: "rejected", createdAt: "2026-11-09T10:00:00.000Z", decidedAt: "2026-11-09T11:00:00.000Z", decidedBy: "kk", blockedTasks: 0, grant: null },
      { id: "00000000-0000-4000-8000-0000000000a5", gate: "decision", action: "oldest reject", target: "y", reason: "oldest", consequence: null, costUsd: null, projectId: null, status: "rejected", createdAt: "2026-11-08T10:00:00.000Z", decidedAt: "2026-11-08T11:00:00.000Z", decidedBy: "kk", blockedTasks: 0, grant: null },
      { id: A2, gate: "decision", action: "spend", target: "openai", reason: "old", consequence: null, costUsd: null, projectId: null, status: "rejected", createdAt: "2026-11-11T10:00:00.000Z", decidedAt: "2026-11-11T11:00:00.000Z", decidedBy: "kk", blockedTasks: 0, grant: null },
    ];
    state.approvalComments ??= [];
    if (req.method === "GET" && url.startsWith("/approvals?") || req.method === "GET" && url === "/approvals") {
      // Newest first, as the API returns; the decided card is deliberately listed first to check pending-first sorting.
      // Newest first and 2 a page (the API pages at 50), so the dashboard's paging is exercised.
      const q = new URL(url, "http://stub").searchParams;
      const status = q.get("status");
      state.approvalReads = [...(state.approvalReads ?? []), url];
      const all = [...state.approvals].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).filter((c) => !status || c.status === status);
      const from = q.get("cursor") ? all.findIndex((c) => c.id === q.get("cursor")) + 1 : 0;
      const page = all.slice(from, from + 2);
      return json(200, { approvals: page, nextCursor: from + 2 < all.length ? page[page.length - 1].id : null });
    }
    const ap = url.match(/^\/approvals\/([0-9a-f-]{36})(\/(approve|reject|comments))?$/);
    if (ap) {
      const card = state.approvals.find((c) => c.id === ap[1]);
      if (!card) return json(404, { statusCode: 404, code: "card-not-found" });
      const view = () => { const { blockedTasks, grant, ...c } = card; return c; };
      if (req.method === "GET" && !ap[2]) return json(200, { approval: view(), comments: state.approvalComments, blockedTasks: card.blockedTasks ? [{ id: "t1", title: "Deploy shop <b>live</b>", status: "blocked" }] : [], grant: card.grant });
      if (req.method === "POST") state.received.push({ url, body });
      if (req.method === "POST" && ap[3] === "approve") {
        if (card.status !== "pending") return json(409, { statusCode: 409, code: "card-not-pending" });
        Object.assign(card, { status: "approved", decidedBy: "kk", decidedAt: "2026-11-12T10:05:00.000Z", blockedTasks: 0 });
        const b = JSON.parse(body || "{}");
        card.grant = { id: "g1", scopeAction: card.action, scopeResource: card.target, projectId: null, sha: null, expiresAt: "2026-11-15T10:05:00.000Z", maxUses: b.maxUses ?? 1, uses: 0, revoked: false };
        return json(200, { approval: view(), grantId: "g1" });
      }
      if (req.method === "POST" && ap[3] === "reject") {
        if (card.status !== "pending") return json(409, { statusCode: 409, code: "card-not-pending" });
        Object.assign(card, { status: "rejected", decidedBy: "kk" });
        return json(200, { approval: view() });
      }
      if (req.method === "POST" && ap[3] === "comments") {
        const c = { id: `c${state.approvalComments.length + 1}`, author: "kk", body: JSON.parse(body).body, createdAt: "2026-11-12T10:06:00.000Z" };
        state.approvalComments.push(c);
        return json(201, { comment: c });
      }
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

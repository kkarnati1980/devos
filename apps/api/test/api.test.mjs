// M1.2 acceptance tests (docs/modules/M1.2.md). Runs against the compiled app on a real socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { MemoryPolicyStore, PolicyEngine } from "@devos/policy";
import { createApp } from "../dist/app.js";
import { KkSessionRegistry } from "../dist/auth.js";
import { loadConfig, SESSION_TTL_MS, startupErrorCode } from "../dist/config.js";
import { SECURITY_HEADERS } from "../dist/http.js";
import { parseWhois, TailscaleWhoisResolver } from "../dist/identity.js";
import { buildRuntime, dbReadiness } from "../dist/runtime.js";

const KK = "kk@example.com";
const ORIGIN = "http://devos:3000";
const ENV = {
  DEVOS_KK_LOGIN: KK,
  DEVOS_SESSION_KEY: "test-only-session-key-0123456789abcdef",
  DEVOS_ALLOWED_ORIGINS: ORIGIN,
};

/** Fake tailscaled: whoever `who.login` says is behind every peer. */
function fakeIdentity() {
  const state = { login: KK, fail: false, calls: 0 };
  return {
    state,
    async whois() {
      state.calls++;
      if (state.fail) throw new Error("whois-timeout");
      return state.login ? { login: state.login, node: "kk-laptop" } : null;
    },
  };
}

async function start(extra = {}) {
  const logs = [];
  const clock = { t: Date.parse("2026-11-06T10:00:00Z") };
  const identity = extra.identity ?? fakeIdentity();
  const kkSessions = new KkSessionRegistry();
  const engine =
    extra.engine === null
      ? null
      : new PolicyEngine({
          store: new MemoryPolicyStore({ mode: "observe", rules: [] }),
          hmacKey: Buffer.alloc(32, 7),
          now: () => clock.t,
          verifyKkSession: kkSessions.verify,
        });
  const app = await createApp({
    config: loadConfig({ ...ENV, ...(extra.env ?? {}) }),
    identity,
    grants: engine,
    readiness: extra.readiness,
    log: (e) => logs.push(e),
    now: () => clock.t,
    kkSessions,
  });
  await app.listen(0, "127.0.0.1");
  const port = app.getHttpServer().address().port;
  return { app, port, logs, clock, identity, engine };
}

function call(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function signIn(port) {
  const r = await call(port, "POST", "/auth/session", { headers: { origin: ORIGIN } });
  assert.equal(r.status, 201, r.text);
  const cookie = r.headers["set-cookie"][0].split(";")[0];
  return { cookie, csrf: r.json.csrfToken, res: r };
}

const futureIso = (clock, days = 7) => new Date(clock.t + days * 86_400_000).toISOString();

test("AT1 contract: every registered route is in openapi.yaml with the same access level, and vice versa", async () => {
  const { app } = await start();
  try {
    const spec = YAML.parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));
    const documented = new Set();
    for (const [p, ops] of Object.entries(spec.paths)) for (const m of Object.keys(ops)) documented.add(`${m.toUpperCase()} ${p}`);
    const router = app.getHttpAdapter().getInstance().router ?? app.getHttpAdapter().getInstance()._router;
    const registered = new Set();
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const m of Object.keys(layer.route.methods)) {
        registered.add(`${m.toUpperCase()} ${layer.route.path.replace(/:([A-Za-z]+)/g, "{$1}")}`);
      }
    }
    assert.deepEqual([...registered].sort(), [...documented].sort());
    const open = Object.entries(spec.paths).flatMap(([p, ops]) =>
      Object.entries(ops).filter(([, op]) => op["x-devos-access"] === "open").map(([m]) => `${m.toUpperCase()} ${p}`),
    );
    assert.deepEqual(open.sort(), ["GET /health", "GET /ready"]);
  } finally {
    await app.close();
  }
});

test("AT2 deny by default: only /health and /ready answer without identity + session", async () => {
  const s = await start();
  try {
    assert.equal((await call(s.port, "GET", "/health")).status, 200);
    assert.equal((await call(s.port, "GET", "/ready")).status, 200);
    // KK on the tailnet but no session.
    let r = await call(s.port, "GET", "/auth/session");
    assert.equal(r.status, 401);
    assert.equal(r.json.code, "session-required");
    // Not KK (another tailnet user) is refused, even at sign-in.
    s.identity.state.login = "someone@example.com";
    r = await call(s.port, "POST", "/auth/session", { headers: { origin: ORIGIN } });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "not-kk");
    // Not a tailnet peer at all.
    s.identity.state.login = null;
    assert.equal((await call(s.port, "GET", "/auth/session")).status, 403);
    // tailscaled down or slow: fail closed.
    s.identity.state.login = KK;
    s.identity.state.fail = true;
    r = await call(s.port, "GET", "/auth/session");
    assert.equal(r.status, 503);
    assert.equal(r.json.code, "identity-unavailable");
  } finally {
    await s.app.close();
  }
});

test("AT3 a session works only for the same live tailnet login, and a forged or tampered cookie is refused", async () => {
  const s = await start();
  try {
    const { cookie } = await signIn(s.port);
    assert.equal((await call(s.port, "GET", "/auth/session", { headers: { cookie } })).status, 200);
    s.identity.state.login = "someone@example.com";
    assert.equal((await call(s.port, "GET", "/auth/session", { headers: { cookie } })).status, 403);
    s.identity.state.login = KK;
    const [name, value] = cookie.split("=");
    const flipped = value.slice(0, 5) + (value[5] === "A" ? "B" : "A") + value.slice(6);
    assert.equal((await call(s.port, "GET", "/auth/session", { headers: { cookie: `${name}=${flipped}` } })).status, 401);
    // A cookie signed with another key is refused.
    const other = await start({ env: { DEVOS_SESSION_KEY: "another-test-only-key-zyxwvutsrqponmlkji" } });
    try {
      const foreign = await signIn(other.port);
      assert.equal((await call(s.port, "GET", "/auth/session", { headers: { cookie: foreign.cookie } })).status, 401);
    } finally {
      await other.app.close();
    }
  } finally {
    await s.app.close();
  }
});

test("AT4 PS: the session is rejected after 12 h (absolute, not extended by use) and rotates at sign-in", async () => {
  const s = await start();
  try {
    const first = await signIn(s.port);
    const setCookie = first.res.headers["set-cookie"][0];
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}`));
    assert.equal(first.res.json.expiresAt, new Date(s.clock.t + SESSION_TTL_MS).toISOString());
    // Using the session at 11 h does not extend it.
    s.clock.t += 11 * 3_600_000;
    assert.equal((await call(s.port, "GET", "/auth/session", { headers: { cookie: first.cookie } })).status, 200);
    s.clock.t += 3_600_000 - 1;
    assert.equal((await call(s.port, "GET", "/auth/session", { headers: { cookie: first.cookie } })).status, 200);
    s.clock.t += 1; // exactly 12 h
    const r = await call(s.port, "GET", "/auth/session", { headers: { cookie: first.cookie } });
    assert.equal(r.status, 401);
    // Signing in again gives a new session id and a new CSRF token.
    const second = await signIn(s.port);
    assert.notEqual(second.cookie, first.cookie);
    assert.notEqual(second.csrf, first.csrf);
  } finally {
    await s.app.close();
  }
});

test("AT5 PS: a cross-origin POST to an approval route is refused (Origin, Referer, Sec-Fetch-Site, CSRF token)", async () => {
  const s = await start();
  try {
    const { cookie, csrf } = await signIn(s.port);
    const body = { scopeAction: "deploy", expiresAt: futureIso(s.clock) };
    const attempts = [
      { origin: "http://evil.example", cookie, "x-devos-csrf": csrf },
      { referer: "http://evil.example/page", cookie, "x-devos-csrf": csrf },
      { origin: ORIGIN, "sec-fetch-site": "cross-site", cookie, "x-devos-csrf": csrf },
      { cookie, "x-devos-csrf": csrf }, // no Origin and no Referer
      { origin: ORIGIN, cookie }, // no CSRF token
      { origin: ORIGIN, cookie, "x-devos-csrf": csrf.slice(0, -1) + (csrf.endsWith("A") ? "B" : "A") },
      { origin: "null", cookie, "x-devos-csrf": csrf },
    ];
    for (const headers of attempts) {
      const r = await call(s.port, "POST", "/grants", { headers, body });
      assert.equal(r.status, 403, JSON.stringify(headers));
      assert.match(r.json.code, /^csrf-/);
    }
    // Sign-in itself is refused cross-origin.
    assert.equal((await call(s.port, "POST", "/auth/session", { headers: { origin: "http://evil.example" } })).status, 403);
    // Nothing was issued.
    const store = s.engine.store ?? null;
    if (store?.grants) assert.equal(store.grants.length, 0);
    // The same request from the dashboard origin with the token succeeds.
    const ok = await call(s.port, "POST", "/grants", { headers: { origin: ORIGIN, cookie, "x-devos-csrf": csrf }, body });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.grant.issuedBy, `kk:${KK}`);
    // A Referer from the allowed origin is accepted when Origin is absent.
    const viaReferer = await call(s.port, "POST", "/grants", {
      headers: { referer: `${ORIGIN}/approvals`, cookie, "x-devos-csrf": csrf },
      body,
    });
    assert.equal(viaReferer.status, 201);
  } finally {
    await s.app.close();
  }
});

test("AT6 PS: the full security-header set is on every response, including errors", async () => {
  const s = await start({ env: { DEVOS_COOKIE_SECURE: "1" } });
  try {
    for (const [method, path] of [["GET", "/health"], ["GET", "/auth/session"], ["GET", "/nope"]]) {
      const r = await call(s.port, method, path);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers[k.toLowerCase()], v, `${path} ${k}`);
      assert.match(r.headers["strict-transport-security"], /max-age=31536000/);
      assert.equal(r.headers["x-powered-by"], undefined);
    }
    const { res } = await signIn(s.port);
    assert.match(res.headers["set-cookie"][0], /^__Host-devos_session=.*; Secure$/);
  } finally {
    await s.app.close();
  }
});

test("AT7 PS: every request gets a request ID in a JSON log line, without secrets", async () => {
  const s = await start();
  try {
    const { cookie, csrf } = await signIn(s.port);
    const r = await call(s.port, "GET", "/auth/session?x=secret-query", { headers: { cookie, "x-request-id": "req-abc-123456" } });
    assert.equal(r.headers["x-request-id"], "req-abc-123456");
    const bad = await call(s.port, "GET", "/health", { headers: { "x-request-id": "bad id <script>" } });
    assert.match(bad.headers["x-request-id"], /^[0-9a-f-]{36}$/);
    await new Promise((res) => setTimeout(res, 20));
    const line = s.logs.find((e) => e.requestId === "req-abc-123456");
    assert.ok(line, "log line with the request id");
    assert.deepEqual(
      { msg: line.msg, method: line.method, path: line.path, status: line.status, identity: line.identity },
      { msg: "request", method: "GET", path: "/auth/session", status: 200, identity: `kk:${KK}` },
    );
    assert.ok(s.logs.every((e) => typeof e.requestId === "string" && typeof e.ts === "string"));
    const all = JSON.stringify(s.logs);
    for (const secret of [cookie.split("=")[1], csrf, ENV.DEVOS_SESSION_KEY, "secret-query"]) assert.ok(!all.includes(secret));
  } finally {
    await s.app.close();
  }
});

test("AT8 approval route: input is validated before the engine; only KK's API-minted session can issue or revoke", async () => {
  const s = await start();
  try {
    const { cookie, csrf } = await signIn(s.port);
    const h = { origin: ORIGIN, cookie, "x-devos-csrf": csrf };
    const bad = [
      [{ scopeAction: "" }, "invalid:scopeAction"],
      [{ scopeAction: "deploy", expiresAt: "tomorrow" }, "invalid:expiresAt"],
      [{ scopeAction: "deploy", expiresAt: futureIso(s.clock), sha: "abc" }, "invalid:sha"],
      [{ scopeAction: "deploy", expiresAt: futureIso(s.clock), projectId: "1" }, "invalid:projectId"],
      [{ scopeAction: "deploy", expiresAt: futureIso(s.clock), maxUses: 0 }, "invalid:maxUses"],
      [{ scopeAction: "deploy", expiresAt: futureIso(s.clock), issuedBy: "agent:x" }, "unknown-field:issuedBy"],
      [[1, 2], "body-must-be-object"],
    ];
    for (const [body, code] of bad) {
      const r = await call(s.port, "POST", "/grants", { headers: h, body });
      assert.equal(r.status, 400);
      assert.equal(r.json.code, code);
    }
    // Engine rules still apply (expiry over 90 days).
    const far = await call(s.port, "POST", "/grants", { headers: h, body: { scopeAction: "deploy", expiresAt: futureIso(s.clock, 91) } });
    assert.equal(far.status, 400);
    assert.match(far.json.code, /^grant-/);
    assert.equal(s.engine.store.grants.length, 0);

    const ok = await call(s.port, "POST", "/grants", { headers: h, body: { scopeAction: "deploy", expiresAt: futureIso(s.clock) } });
    assert.equal(ok.status, 201);
    const id = ok.json.grant.id;
    assert.equal((await call(s.port, "POST", `/grants/not-a-uuid/revoke`, { headers: h })).status, 400);
    const rv = await call(s.port, "POST", `/grants/${id}/revoke`, { headers: h });
    assert.equal(rv.status, 200);
    assert.equal(rv.json.revoked, true);

    // A KkSession built outside the API (e.g. by an agent) is not accepted by the engine.
    await assert.rejects(
      s.engine.issueGrant({ identity: { id: `kk:${KK}`, type: "kk" }, tailscaleLogin: KK }, { scopeAction: "x", expiresAt: new Date(s.clock.t + 1000) }),
      /grant-issuer-session-unverified/,
    );
  } finally {
    await s.app.close();
  }
  // Without an engine wired, grant routes fail closed.
  const n = await start({ engine: null });
  try {
    const { cookie, csrf } = await signIn(n.port);
    const r = await call(n.port, "POST", "/grants", {
      headers: { origin: ORIGIN, cookie, "x-devos-csrf": csrf },
      body: { scopeAction: "deploy", expiresAt: futureIso(n.clock) },
    });
    assert.equal(r.status, 503);
  } finally {
    await n.app.close();
  }
});

test("AT9 PS timeouts: the whois call and the readiness probe have hard deadlines", async () => {
  // A unix socket that accepts and never answers.
  const dir = (await import("node:fs")).mkdtempSync((await import("node:os")).tmpdir() + "/devos-ts-");
  const sock = `${dir}/tailscaled.sock`;
  const server = net.createServer(() => {}).listen(sock);
  await new Promise((r) => server.once("listening", r));
  try {
    const resolver = new TailscaleWhoisResolver(sock, 200);
    const t0 = Date.now();
    await assert.rejects(resolver.whois("100.64.0.1", 50000), /whois-timeout/);
    assert.ok(Date.now() - t0 < 2000);
  } finally {
    server.close();
  }
  const s = await start({ readiness: () => Promise.reject(new Error("db-timeout")) });
  try {
    const r = await call(s.port, "GET", "/ready");
    assert.equal(r.status, 503);
    assert.equal(r.json.code, "not-ready");
  } finally {
    await s.app.close();
  }
});

test("AT10 whois parsing and configuration fail closed", () => {
  assert.deepEqual(parseWhois({ Node: { Name: "kk-laptop" }, UserProfile: { LoginName: "KK@Example.com" } }), {
    login: "kk@example.com",
    node: "kk-laptop",
  });
  assert.equal(parseWhois({ Node: { Name: "ci", Tags: ["tag:server"] }, UserProfile: { LoginName: "tagged-devices" } }), null);
  assert.equal(parseWhois({}), null);
  assert.throws(() => loadConfig({ ...ENV, DEVOS_SESSION_KEY: "short" }), /config-session-key-too-short/);
  assert.throws(() => loadConfig({ ...ENV, DEVOS_KK_LOGIN: "" }), /config-kk-login-required/);
  assert.throws(() => loadConfig({ ...ENV, DEVOS_ALLOWED_ORIGINS: "" }), /config-allowed-origins-required/);
  assert.throws(() => loadConfig({ ...ENV, DEVOS_ALLOWED_ORIGINS: "http://devos:3000/path" }), /config-origin-invalid/);
  assert.equal(randomUUID().length, 36);
});

test("AT9 PS (PR14-r1): whois has a hard elapsed deadline, not only an inactivity timeout", async () => {
  // A tailscaled that sends headers, then a byte every 40 ms forever (never idle for 200 ms).
  const dir = (await import("node:fs")).mkdtempSync((await import("node:os")).tmpdir() + "/devos-ts-");
  const sock = `${dir}/tailscaled.sock`;
  const timers = new Set();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const t = setInterval(() => res.write(" "), 40);
    timers.add(t);
    res.on("close", () => clearInterval(t));
  });
  server.listen(sock);
  await new Promise((r) => server.once("listening", r));
  try {
    const resolver = new TailscaleWhoisResolver(sock, 300);
    const t0 = Date.now();
    await assert.rejects(resolver.whois("100.64.0.1", 50000), /whois-timeout/);
    const took = Date.now() - t0;
    assert.ok(took < 1000, `whois took ${took} ms with a 300 ms limit`);
  } finally {
    for (const t of timers) clearInterval(t);
    server.closeAllConnections?.();
    server.close();
  }
});

test("AT9 PS (PR14-r1): the readiness probe bounds the database operation itself", async () => {
  const calls = [];
  let options;
  const db = {
    async $transaction(fn, opts) {
      options = opts;
      return fn({ $queryRaw: async (strings, ...values) => calls.push([strings.join("?"), ...values]) });
    },
  };
  await dbReadiness(db, 1234)();
  assert.deepEqual(options, { timeout: 1234, maxWait: 1234 });
  assert.match(calls[0][0], /set_config\('statement_timeout', \?, true\)/);
  assert.equal(calls[0][1], "1234");
  assert.match(calls[1][0], /SELECT 1/);

  // A stalled database: the probe still answers within the limit.
  const stalled = { $transaction: () => new Promise(() => {}) };
  const t0 = Date.now();
  await assert.rejects(dbReadiness(stalled, 150)(), /db-timeout/);
  assert.ok(Date.now() - t0 < 1000);
});

test("AT9 PS (PR14-r1): /ready needs both DATABASE_URL and DEVOS_POLICY_HMAC_KEY", async () => {
  const kkSessions = new KkSessionRegistry();
  const okDb = { $transaction: async (fn) => fn({ $queryRaw: async () => [] }) };
  let loads = 0;
  const loadDb = async () => {
    loads++;
    return okDb;
  };
  const opts = { outboundTimeoutMs: 500, kkSessions, loadDb };

  const none = await buildRuntime({}, opts);
  assert.equal(none.grants, null);
  await assert.rejects(none.readiness(), /database-not-configured/);

  const noKey = await buildRuntime({ DATABASE_URL: "postgresql://x/y" }, opts);
  assert.equal(noKey.grants, null);
  await assert.rejects(noKey.readiness(), /policy-not-configured/);
  assert.equal(loads, 0);
  const s = await start({ readiness: noKey.readiness });
  try {
    const r = await call(s.port, "GET", "/ready");
    assert.equal(r.status, 503);
    assert.equal(r.json.code, "not-ready");
  } finally {
    await s.app.close();
  }

  const both = await buildRuntime({ DATABASE_URL: "postgresql://x/y", DEVOS_POLICY_HMAC_KEY: "test-only-policy-hmac-key-0123456789abcdef" }, opts);
  assert.notEqual(both.grants, null);
  await both.readiness();
  assert.equal(loads, 1);
});

test("PR14-r1: @devos/db is a declared dependency of @devos/api and resolves from apps/api", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.dependencies["@devos/db"], "workspace:*");
  // Resolution goes through apps/api/node_modules (pnpm workspace link) to packages/db.
  const resolved = realpathSync(new URL("../node_modules/@devos/db", import.meta.url));
  assert.match(resolved, /packages\/db$/);
  assert.match(import.meta.resolve("@devos/db"), /\/@devos\/db\/dist\/index\.js$/);
});

test("AT10 (PR14-r2): DEVOS_COOKIE_SECURE accepts only 1, 0 or unset; anything else stops start-up", () => {
  assert.equal(loadConfig({ ...ENV }).secureCookies, false);
  assert.equal(loadConfig({ ...ENV, DEVOS_COOKIE_SECURE: "" }).secureCookies, false);
  assert.equal(loadConfig({ ...ENV, DEVOS_COOKIE_SECURE: "0" }).secureCookies, false);
  assert.equal(loadConfig({ ...ENV, DEVOS_COOKIE_SECURE: "1" }).secureCookies, true);
  for (const bad of ["true", "yes", "on", "TRUE", " 1", "2"]) {
    // The error is the fixed code only; the bad value is never echoed.
    assert.throws(() => loadConfig({ ...ENV, DEVOS_COOKIE_SECURE: bad }), { message: "config-cookie-secure-invalid" });
  }
});

test("AT10 (PR14-r2): start-up failures are logged as a controlled code, never the error message", async () => {
  // Our own config codes pass through unchanged.
  assert.equal(startupErrorCode(new Error("config-cookie-secure-invalid")), "config-cookie-secure-invalid");
  // A dependency error carrying a configuration value is reduced to its system code.
  const secretHost = "secret-host.internal.example";
  const dns = Object.assign(new Error(`getaddrinfo ENOTFOUND ${secretHost}`), { code: "ENOTFOUND" });
  assert.equal(startupErrorCode(dns), "startup-enotfound");
  // Real listen failure on an unresolvable HOST: the code holds no hostname.
  const server = http.createServer();
  const err = await new Promise((resolve) => {
    server.once("error", resolve);
    server.listen(0, "unresolvable-host.invalid");
  });
  const code = startupErrorCode(err);
  assert.match(code, /^startup-e[a-z0-9_]+$/);
  assert.ok(!code.includes("unresolvable"));
  // Anything else (no code, a message with values, a non-Error) → generic code.
  assert.equal(startupErrorCode(new Error(`connect to postgresql://u:p@db/${secretHost} failed`)), "startup-failed");
  assert.equal(startupErrorCode(Object.assign(new Error("x"), { code: `E ${secretHost}` })), "startup-failed");
  assert.equal(startupErrorCode("boom"), "startup-failed");
  assert.equal(startupErrorCode(undefined), "startup-failed");
});

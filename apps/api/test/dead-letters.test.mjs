// DEVOS-77 acceptance tests (docs/modules/dead-letters.md): the dead-letter view lists run jobs that
// failed for good and retries one, behind a session and CSRF, audited, with fixed error codes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../dist/app.js";
import { KkSessionRegistry } from "../dist/auth.js";
import { loadConfig, startupErrorCode } from "../dist/config.js";
import { buildRuntime, parseRedisUrl } from "../dist/runtime.js";
import { DEAD_LETTER_LIMIT, isJobId, REASON_CODES, reasonCode, toView } from "../dist/dead-letters.js";

const KK = "kk@example.com";
const ORIGIN = "http://devos:3000";
const ENV = { DEVOS_KK_LOGIN: KK, DEVOS_SESSION_KEY: "test-only-session-key-0123456789abcdef", DEVOS_ALLOWED_ORIGINS: ORIGIN };
const T0 = Date.UTC(2026, 10, 11, 9, 0, 0);

/** A fake M1.5 RunQueue: the failed set and what retryDead was asked. */
class FakeQueue {
  constructor(dead = []) {
    this.dead = dead;
    this.retried = [];
    this.fail = null;
  }
  async deadLetters(limit = 100) {
    if (this.fail) throw new Error(this.fail);
    this.lastLimit = limit;
    return this.dead.slice(0, limit);
  }
  async retryDead(jobId) {
    if (this.fail) throw new Error(this.fail);
    const i = this.dead.findIndex((d) => d.jobId === jobId);
    if (i < 0) return false;
    this.dead.splice(i, 1);
    this.retried.push(jobId);
    return true;
  }
}

function auditLog({ fail = false } = {}) {
  const rows = [];
  return { rows, audit: async (e) => { if (fail) throw new Error("audit db down: secret detail"); rows.push(e); } };
}

async function start(deadLetters) {
  const logs = [];
  const app = await createApp({
    config: loadConfig(ENV),
    identity: { whois: async () => ({ login: KK, node: "kk-laptop" }) },
    log: (e) => logs.push(e),
    kkSessions: new KkSessionRegistry(),
    ...(deadLetters ? { deadLetters } : {}),
  });
  await app.listen(0, "127.0.0.1");
  return { app, port: app.getHttpServer().address().port, logs };
}

function call(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : undefined, text }));
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function kk(port) {
  const raw = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/auth/session", headers: { origin: ORIGIN } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(t) }));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(raw.status, 201);
  const cookie = raw.headers["set-cookie"][0].split(";")[0];
  const h = { cookie, origin: ORIGIN, "x-devos-csrf": raw.json.csrfToken };
  return {
    get: (p) => call(port, "GET", p, { headers: { cookie } }),
    post: (p, extra = {}) => call(port, "POST", p, { headers: { ...h, ...extra } }),
  };
}

const row = (n, extra = {}) => ({ jobId: `run-${n}`, runId: `run-${n}`, reason: "run-provider_error", attemptsMade: 3, failedAt: T0 + n, ...extra });

test("DL AT1: GET /runs/dead-letters lists each failed job (run, reason, attempts, time), at most 100", async () => {
  const q = new FakeQueue(Array.from({ length: 120 }, (_, i) => row(i)));
  const { audit } = auditLog();
  const s = await start({ queue: q, audit });
  try {
    const api = await kk(s.port);
    const r = await api.get("/runs/dead-letters");
    assert.equal(r.status, 200);
    assert.equal(q.lastLimit, DEAD_LETTER_LIMIT);
    assert.equal(r.json.deadLetters.length, 100);
    assert.deepEqual(r.json.deadLetters[0], { jobId: "run-0", runId: "run-0", reason: "run-provider_error", attemptsMade: 3, failedAt: new Date(T0).toISOString() });
  } finally {
    await s.app.close();
  }
});

test("DL AT2: retry re-queues the job, writes one audit event first, and the job leaves the list", async () => {
  const q = new FakeQueue([row(1), row(2)]);
  const log = auditLog();
  const s = await start({ queue: q, audit: log.audit });
  try {
    const api = await kk(s.port);
    const r = await api.post("/runs/dead-letters/run-1/retry");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { retried: "run-1" });
    assert.deepEqual(q.retried, ["run-1"]);
    assert.equal(log.rows.length, 1);
    assert.equal(log.rows[0].action, "run.dead_letter.retry_requested");
    assert.deepEqual(log.rows[0].details, { jobId: "run-1" });
    const after = await api.get("/runs/dead-letters");
    assert.deepEqual(after.json.deadLetters.map((d) => d.jobId), ["run-2"]);
  } finally {
    await s.app.close();
  }
});

test("DL AT3: both routes need a session; the retry needs CSRF, origin and same-site — nothing is retried otherwise", async () => {
  const q = new FakeQueue([row(1)]);
  const log = auditLog();
  const s = await start({ queue: q, audit: log.audit });
  try {
    assert.equal((await call(s.port, "GET", "/runs/dead-letters")).status, 401);
    assert.equal((await call(s.port, "POST", "/runs/dead-letters/run-1/retry", { headers: { origin: ORIGIN } })).status, 401);
    const api = await kk(s.port);
    for (const extra of [{ "x-devos-csrf": "wrong" }, { origin: "http://evil.test" }, { "sec-fetch-site": "cross-site" }]) {
      assert.equal((await api.post("/runs/dead-letters/run-1/retry", extra)).status, 403, JSON.stringify(extra));
    }
    assert.deepEqual(q.retried, []);
    assert.equal(log.rows.length, 0);
  } finally {
    await s.app.close();
  }
});

test("DL AT4: a bad job id is 400 with no audit; an unknown one is 404, audited as a request only, nothing retried", async () => {
  const q = new FakeQueue([row(1)]);
  const log = auditLog();
  const s = await start({ queue: q, audit: log.audit });
  try {
    const api = await kk(s.port);
    for (const bad of ["%2E%2E", "a%20b", "-x", "x".repeat(129), "a%3Ab"]) {
      const r = await api.post(`/runs/dead-letters/${bad}/retry`);
      assert.equal(r.status, 400, bad);
      assert.equal(r.json.code, "invalid:job-id");
    }
    assert.equal(log.rows.length, 0);
    const r = await api.post("/runs/dead-letters/run-9/retry");
    assert.equal(r.status, 404);
    assert.equal(r.json.code, "dead-letter-not-found");
    assert.deepEqual(q.retried, []);
    assert.deepEqual(log.rows.map((x) => x.action), ["run.dead_letter.retry_requested"]);
    assert.equal(isJobId("0b1c2d3e-aaaa-4bbb-8ccc-123456789abc"), true);
  } finally {
    await s.app.close();
  }
});

test("DL AT5: an audit failure retries nothing; queue errors answer fixed codes and never leak the message", async () => {
  const q = new FakeQueue([row(1)]);
  const s = await start({ queue: q, audit: auditLog({ fail: true }).audit });
  try {
    const api = await kk(s.port);
    const r = await api.post("/runs/dead-letters/run-1/retry");
    assert.equal(r.status, 503);
    assert.equal(r.json.code, "dead-letters-audit-error");
    assert.deepEqual(q.retried, []);
    q.fail = "redis://user:TESTONLY-pass@redis:6379 timeout";
    for (const res of [await api.get("/runs/dead-letters"), await call(s.port, "GET", "/runs/dead-letters")]) {
      assert.ok(!res.text.includes("TESTONLY"));
    }
    const g = await api.get("/runs/dead-letters");
    assert.equal(g.status, 503);
    assert.equal(g.json.code, "dead-letters-unavailable");
    assert.ok(!JSON.stringify(s.logs).includes("TESTONLY"));
  } finally {
    await s.app.close();
  }
});

test("DL AT6: without a queue (no REDIS_URL or no database) both routes answer 503 dead-letters-not-configured", async () => {
  const s = await start();
  try {
    const api = await kk(s.port);
    const g = await api.get("/runs/dead-letters");
    assert.equal(g.status, 503);
    assert.equal(g.json.code, "dead-letters-not-configured");
    const p = await api.post("/runs/dead-letters/run-1/retry");
    assert.equal(p.status, 503);
    assert.equal(p.json.code, "dead-letters-not-configured");
  } finally {
    await s.app.close();
  }
});

test("DL AT7: REDIS_URL parsing and runtime wiring (absent → off; malformed → a config code; set → the queue is opened)", async () => {
  assert.equal(parseRedisUrl(undefined), null);
  assert.equal(parseRedisUrl("  "), null);
  assert.equal(parseRedisUrl("redis://redis:6379"), "redis://redis:6379");
  assert.equal(parseRedisUrl("rediss://h:6380/0"), "rediss://h:6380/0");
  for (const bad of ["http://redis:6379", "redis:6379", "redis://a b", "redis://redis:bad", "redis:///", "redis://", "redis://h:0", "redis://h:70000"]) {
    assert.throws(() => parseRedisUrl(bad), (e) => startupErrorCode(e) === "config-redis-url-invalid", bad);
  }
  const fakeDb = { $transaction: async (fn) => fn({ auditEvent: { create: async () => ({}) } }) };
  const opened = [];
  const base = { outboundTimeoutMs: 1000, kkSessions: new KkSessionRegistry(), loadDb: async () => fakeDb, loadQueue: async (u) => (opened.push(u), new FakeQueue()) };
  const env = { DATABASE_URL: "postgresql://x@localhost/x", DEVOS_POLICY_HMAC_KEY: "test-only-hmac-key-0123456789abcdef" };
  const off = await buildRuntime(env, base);
  assert.equal(off.deadLetters.queue, null);
  const on = await buildRuntime({ ...env, REDIS_URL: "redis://redis:6379" }, base);
  assert.ok(on.deadLetters.queue);
  assert.deepEqual(opened, ["redis://redis:6379"]);
  await on.deadLetters.audit({ action: "x", summary: "y", details: {} });
  const noDb = await buildRuntime({ REDIS_URL: "redis://redis:6379" }, base);
  assert.equal(noDb.deadLetters.queue, null);
});

test("DL AT8: only fixed run-* codes are shown as the reason; raw messages become run-failed; a missing time is null", () => {
  const v = toView({ jobId: "run-1", runId: "run-1", reason: "line1\nline2\u0007" + "x".repeat(400), attemptsMade: -1, failedAt: null });
  assert.equal(v.reason, "run-failed");
  assert.equal(reasonCode("run-provider_error"), "run-provider_error");
  assert.equal(reasonCode("run-max-turns"), "run-max-turns");
  assert.equal(reasonCode("run-secret-token-123"), "run-failed"); // PR36-r1: pattern-shaped is not a code
  for (const t of ["provider_error", "rate_limited", "policy_denied", "budget_exceeded", "timeout", "cancelled", "missing_input", "sandbox_error", "internal"]) assert.ok(REASON_CODES.has(`run-${t}`), t);
  for (const raw of ["Invalid prisma.run.update() invocation: password=TESTONLY", "queue-retry-timeout", "run-x \n secret", "", "run-" + "a".repeat(80)]) assert.equal(reasonCode(raw), "run-failed", raw);
  assert.equal(v.attemptsMade, 0);
  assert.equal(v.failedAt, null);
});

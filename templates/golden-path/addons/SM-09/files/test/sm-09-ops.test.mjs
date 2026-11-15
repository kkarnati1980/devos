// SM-09 add-on tests (docs/modules/S3.md, "S3-c3 SM-09 build notes").
// SM-09-L1: /health answers liveness; /ready checks the database, queue and critical dependencies.
// SM-09-L2: logs are JSON with a request or job ID and contain no secrets or personal data; errors reach monitoring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import {
  readyCheck, dbReady, queueReady, dependencyReady, redact, logger, errorMonitor, webhookReporter, watchProcess,
} from "../src/ops.mjs";

const config = { server: { sha: "abc123", port: 0, host: "127.0.0.1" } };
const sink = () => { const lines = []; return { lines, write(s) { lines.push(...s.trim().split("\n").map((l) => JSON.parse(l))); } }; };

async function serve(readyChecks, out = sink()) {
  const app = createApp({ config, readyChecks, out });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.address().port}`;
  return { base, out, close: () => new Promise((r) => app.close(r)) };
}

test("SM-09-L1: /health answers liveness; /ready checks the database, the queue and a critical dependency", async () => {
  let dbUp = true;
  let queued = 0;
  let depStatus = 200;
  const db = async (text) => { if (!dbUp) throw new Error("connect ECONNREFUSED"); assert.equal(text, "SELECT 1 AS ok"); return { rows: [{ ok: 1 }] }; };
  const queue = { stats: () => ({ queued, running: 0, dead: 0 }) };
  const seen = [];
  const fakeFetch = async (url, opts) => { seen.push({ url, opts }); return { status: depStatus }; };
  const s = await serve([dbReady(db), queueReady(queue, { maxQueued: 5 }), dependencyReady("payments", "https://pay.example.com/health", { http: fakeFetch })]);
  try {
    const h = await fetch(`${s.base}/health`);
    assert.equal(h.status, 200);
    assert.deepEqual(await h.json(), { status: "ok", sha: "abc123" });
    let r = await fetch(`${s.base}/ready`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: "ready" });
    assert.equal(seen[0].url, "https://pay.example.com/health");
    assert.equal(seen[0].opts.method, "GET");
    dbUp = false; queued = 6; depStatus = 503;
    r = await fetch(`${s.base}/ready`);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { status: "not-ready", failed: ["db", "queue", "payments"] });
    dbUp = true; queued = 5; depStatus = 204;
    assert.equal((await fetch(`${s.base}/ready`)).status, 200);
    // /health stays up while a dependency is down: liveness never depends on readiness.
    dbUp = false;
    assert.equal((await fetch(`${s.base}/health`)).status, 200);
  } finally { await s.close(); }
});

test("SM-09-L1: a hung check is cut at its timeout and aborted, so /ready answers", async () => {
  let aborted = null;
  const hung = readyCheck("search", (signal) => new Promise(() => { signal.addEventListener("abort", () => { aborted = signal.reason.message; }); }), { timeoutMs: 50 });
  const s = await serve([hung]);
  try {
    const t0 = Date.now();
    const r = await fetch(`${s.base}/ready`);
    assert.equal(r.status, 503);
    assert.deepEqual((await r.json()).failed, ["search"]);
    assert.ok(Date.now() - t0 < 2000, "answered within the timeout, not hung");
    assert.equal(aborted, "ready-check-timeout");
  } finally { await s.close(); }
  assert.equal(await readyCheck("x", () => 0).check(), false, "falsy is not ready");
  assert.equal(await readyCheck("x", () => "yes").check(), true);
  await assert.rejects(readyCheck("x", () => { throw new Error("boom"); }).check(), /boom/, "a throw is reported by the core as not ready");
  assert.throws(() => readyCheck("Bad Name", () => true), /name/);
  assert.throws(() => readyCheck("x", () => true, { timeoutMs: 0 }), /timeoutMs/);
  assert.equal(await queueReady({}).check(), false, "a queue without stats() is not ready");
  assert.equal(await dbReady(async () => ({ rows: [] })).check(), false);
});

test("SM-09-L2: logs are JSON with a request or job ID, and secrets and personal data are redacted", () => {
  const out = sink();
  const log = logger({ out, context: { requestId: "req-12345678" } });
  log.info("signed in", {
    userId: "u1", email: "asha@example.com", password: "hunter2", headers: { authorization: "Bearer abc.def", cookie: "sid=1" },
    note: "token for asha@example.com is Bearer eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl",
    db: "postgres://app:s3cret@db:5432/app", key: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa", phone: "+91 98765 43210",
    nested: { profile: { fullName: "Asha K", city: "Pune" } },
  });
  const job = log.child({ jobId: "job-1" });
  job.warn("retrying", { attempt: 2 });
  log.info("cache", { url: "redis://:hunter3pass@cache:6379", counts: { "ravi@example.com": 3 }, username: "ravi_k", raw: Buffer.from("hunter4"),
    stripe: "sk_live_abcdefghijklmnop", time: "1999-01-01T00:00:00Z" });
  const [a, b, c] = out.lines;
  assert.equal(c.url, "redis://:[redacted]@cache:6379");
  assert.deepEqual(c.counts, { "[redacted-email]": 3 });
  assert.equal(c.username, "[redacted]");
  assert.equal(c.raw, "[binary 7 bytes]");
  assert.equal(c.stripe, "[redacted-key]");
  assert.notEqual(c.time, "1999-01-01T00:00:00Z", "a field cannot forge the time");
  assert.equal(a.level, "info");
  assert.equal(a.msg, "signed in");
  assert.equal(a.requestId, "req-12345678");
  assert.ok(a.time);
  assert.equal(a.userId, "u1");
  for (const k of ["email", "password", "phone"]) assert.equal(a[k], "[redacted]", k);
  assert.deepEqual(a.headers, { authorization: "[redacted]", cookie: "[redacted]" });
  assert.equal(a.note, "token for [redacted-email] is Bearer [redacted]");
  assert.equal(a.db, "postgres://app:[redacted]@db:5432/app");
  assert.equal(a.key, "[redacted-key]");
  assert.deepEqual(a.nested, { profile: { fullName: "[redacted]", city: "Pune" } });
  const text = JSON.stringify(out.lines);
  for (const leak of ["hunter2", "hunter3", "ravi", "sk_live", "asha@example.com", "s3cret", "ghp_aaaa", "98765", "Asha K", "abc.def", "sid=1"]) assert.ok(!text.includes(leak), leak);
  assert.deepEqual([b.level, b.msg, b.requestId, b.jobId, b.attempt], ["warn", "retrying", "req-12345678", "job-1", 2]);
  // A field cannot overwrite the line's own context or level.
  logger({ out, context: { jobId: "j9" } }).info("x", { jobId: "forged", level: "debug" });
  assert.deepEqual([out.lines[3].jobId, out.lines[3].level], ["j9", "info"]);
  // Non-object fields and an unprintable message never throw.
  logger({ out }).info(Object.create(null), "plain");
  assert.deepEqual([out.lines[4].msg, out.lines[4].data], ["[unprintable]", "plain"]);
});

test("SM-09-L2: redact never throws (cycles, BigInt, depth, size, throwing getters)", () => {
  const cyc = { a: 1 }; cyc.self = cyc;
  assert.deepEqual(redact(cyc), { a: 1, self: "[cycle]" });
  assert.equal(redact(10n), "10");
  assert.equal(redact({ a: { b: { c: { d: { e: { f: 1 } } } } } }).a.b.c.d.e, "[depth]");
  assert.equal(Object.keys(redact(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i])))).length, 50);
  assert.ok(redact("x".repeat(5000)).endsWith("…[truncated]"));
  // A secret straddling the cut is masked before the cut, never left half-visible.
  const straddle = redact(`${"x".repeat(1990)} ghp_${"a".repeat(30)}`);
  assert.ok(!straddle.includes("ghp_"), straddle.slice(-40));
  // The e-mail pattern stays fast on long strings without an @.
  const t0 = performance.now();
  for (let i = 0; i < 20; i += 1) redact("a".repeat(20_000));
  assert.ok(performance.now() - t0 < 1000, "bounded cost");
  const bad = { get boom() { throw new Error("no"); } };
  assert.equal(redact(bad), "[unloggable]");
  assert.deepEqual(redact(new Error("mail asha@example.com")), { name: "Error", message: "mail [redacted-email]" });
});

test("SM-09-L2: errors reach monitoring once, redacted, with the request or job ID; a failing reporter never throws", async () => {
  const out = sink();
  const sent = [];
  const fakeFetch = async (url, opts) => { sent.push({ url, opts }); return { status: sent.length === 1 ? 202 : 500 }; };
  const report = webhookReporter("https://errors.example.com/intake", { http: fakeFetch });
  const monitor = errorMonitor({ report, log: logger({ out }), release: "abc123" });
  assert.equal(await monitor.capture(Object.assign(new Error("payment failed for asha@example.com"), { code: "card-declined" }), { requestId: "req-12345678" }), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://errors.example.com/intake");
  assert.equal(sent[0].opts.method, "POST");
  const event = JSON.parse(sent[0].opts.body);
  assert.deepEqual({ ...event, time: undefined }, { time: undefined, name: "Error", message: "payment failed for [redacted-email]", code: "card-declined", requestId: "req-12345678", release: "abc123" });
  assert.equal(out.lines[0].level, "error");
  assert.equal(out.lines[0].requestId, "req-12345678");
  assert.ok(!JSON.stringify(out.lines).includes("asha@"));
  // A refused report is logged as a warning and the call still returns.
  assert.equal(await monitor.capture("job blew up", { jobId: "job-7" }), false);
  assert.deepEqual(out.lines.slice(-2).map((l) => [l.level, l.msg, l.jobId ?? l.code]), [["error", "error", "job-7"], ["warn", "error-report-failed", "webhook-500"]]);
  // A rejection reason that cannot be turned into text is still captured.
  assert.equal(await monitor.capture(Object.create(null)), false);
  assert.equal(out.lines.at(-2).error.message, "[unprintable]");
  // Nor does a missing or unprintable context.
  assert.equal(await monitor.capture(new Error("y"), null), false);
  assert.equal(await monitor.capture(new Error("z"), { requestId: Object.create(null) }), false);
  // No reporter: still logged.
  assert.equal(await errorMonitor({ log: logger({ out }) }).capture(new Error("x")), false);
  assert.throws(() => webhookReporter("http://errors.example.com/intake"), /https/);
  assert.throws(() => webhookReporter("not a url"), /URL/);
});

test("SM-09-L1/L2: the default reporter and dependency check go through safeFetch, so an internal URL is blocked (F2)", async () => {
  const out = sink();
  const monitor = errorMonitor({ report: webhookReporter("https://127.0.0.1/intake", { timeoutMs: 500 }), log: logger({ out }) });
  assert.equal(await monitor.capture(new Error("x")), false);
  assert.equal(out.lines.at(-1).msg, "error-report-failed");
  assert.match(String(out.lines.at(-1).code), /block|internal|private|loopback/i);
  // dependencyReady's default path is safeFetch too: an internal URL is refused (and /ready counts it not ready).
  await assert.rejects(dependencyReady("internal", "https://127.0.0.1/health", { timeoutMs: 300 }).check(), (e) => e.code === "blocked-address");
});

test("SM-09-L2: watchProcess reports unhandled rejections and crashes, then exits 1 on a crash", async () => {
  const { EventEmitter } = await import("node:events");
  const proc = new EventEmitter();
  const got = [];
  const exits = [];
  const undo = watchProcess({ capture: async (e) => { got.push(String(e?.message ?? e)); } }, { proc, exit: (c) => exits.push(c) });
  proc.emit("unhandledRejection", new Error("lost promise"));
  proc.emit("uncaughtException", new Error("crash"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, ["lost promise", "crash"]);
  assert.deepEqual(exits, [1]);
  undo();
  // A reporter that never settles cannot keep a crashed process up.
  const exits2 = [];
  const undo2 = watchProcess({ capture: () => new Promise(() => {}) }, { proc, exit: (c) => exits2.push(c), exitAfterMs: 30 });
  proc.emit("uncaughtException", new Error("crash"));
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(exits2, [1]);
  undo2();
  assert.equal(proc.listenerCount("uncaughtException") + proc.listenerCount("unhandledRejection"), 0);
});

// SM-05 add-on: background work (docs/modules/S3.md, "S3-b5 SM-05 build notes").
// SM-05-L1: work over about 2 s runs from a queue; a poisoned job lands in the dead-letter list and can be retried.
// No dependency: one process, one queue, jobs kept in a store. `fileStore(path)` keeps them across restarts.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class JobTimeout extends Error {
  constructor(ms) { super(`job attempt timed out after ${ms} ms`); this.name = "JobTimeout"; }
}

const TYPE = /^[a-z][a-z0-9._-]{0,63}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ERROR = 500; // characters of the last error kept on a job (never the payload)

function positiveInt(v, name, max) {
  if (!Number.isInteger(v) || v < 1 || v > max) throw new TypeError(`createQueue: ${name} must be an integer 1–${max}`);
  return v;
}

/** In-memory store (tests, or work that may be lost on restart). */
export function memoryStore() {
  let jobs = [];
  return { load: () => jobs.map((j) => ({ ...j })), save: (all) => { jobs = all.map((j) => ({ ...j })); } };
}

/**
 * JSON-file store: every change is written to a temporary file and renamed over the old one, so a crash leaves the
 * old or the new list, never half a file. A job that was running when the process stopped is queued again on load.
 */
export function fileStore(path) {
  if (typeof path !== "string" || !path) throw new TypeError("fileStore: path is required");
  return {
    load() {
      let text;
      try { text = readFileSync(path, "utf8"); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new TypeError(`fileStore: ${path} does not hold a job list`);
      return data;
    },
    save(all) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

function errorText(e) {
  const s = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return s.length > MAX_ERROR ? `${s.slice(0, MAX_ERROR)}…` : s;
}

/**
 * createQueue({ handlers: { "<type>": async (payload, { signal, attempt }) => … } }).
 * - maxAttempts (default 3): attempts before a job is dead-lettered.
 * - backoffMs (default [1000, 5000, 30000]): wait before attempt n+1 (the last value repeats).
 * - timeoutMs (default 60000): each attempt is aborted (signal) and counted as failed after this long.
 * - concurrency (default 1): jobs run at once.
 * A job with no handler for its type is refused at enqueue. Jobs move queued → running → done | queued (retry) | dead.
 * Done jobs are dropped from the store; dead jobs stay until retried or removed.
 */
export function createQueue({ handlers, store = memoryStore(), maxAttempts = 3, backoffMs = [1000, 5000, 30000], timeoutMs = 60_000, concurrency = 1, now = Date.now, onEvent = () => {} } = {}) {
  if (!handlers || typeof handlers !== "object") throw new TypeError("createQueue: handlers is required");
  for (const [type, fn] of Object.entries(handlers)) {
    if (!TYPE.test(type) || typeof fn !== "function") throw new TypeError(`createQueue: bad handler ${JSON.stringify(type)}`);
  }
  positiveInt(maxAttempts, "maxAttempts", 100);
  positiveInt(timeoutMs, "timeoutMs", 3_600_000);
  positiveInt(concurrency, "concurrency", 64);
  if (!Array.isArray(backoffMs) || backoffMs.length === 0 || !backoffMs.every((n) => Number.isInteger(n) && n >= 0 && n <= 86_400_000)) {
    throw new TypeError("createQueue: backoffMs must be a non-empty list of integers 0–86400000");
  }

  // Jobs left running by a stopped process are queued again; their attempt is not counted (it never finished).
  let jobs = store.load().map((j) => (j.status === "running" ? { ...j, status: "queued", runAfter: 0 } : j));
  const running = new Map(); // id → AbortController
  const stopping = new Set(); // ids aborted by stop()
  let timer = null;
  let started = false;
  let idleWaiters = [];

  const save = () => store.save(jobs);
  const pub = (j) => ({ id: j.id, type: j.type, status: j.status, attempts: j.attempts, lastError: j.lastError ?? null, enqueuedAt: j.enqueuedAt, deadAt: j.deadAt ?? null });

  function wait(ms) {
    if (!started) return;
    clearTimeout(timer);
    timer = setTimeout(pump, Math.max(0, ms));
    timer.unref?.();
  }

  function settleIdle() {
    if (running.size === 0 && !jobs.some((j) => j.status === "queued" && j.runAfter <= now())) {
      const w = idleWaiters; idleWaiters = []; for (const r of w) r();
    }
  }

  async function runOne(job) {
    const ac = new AbortController();
    running.set(job.id, ac);
    job.status = "running";
    job.attempts += 1;
    save();
    let t;
    try {
      // The attempt ends at the timeout or on stop() even if the handler ignores its signal.
      const aborted = new Promise((_, rej) => ac.signal.addEventListener("abort", () => rej(ac.signal.reason), { once: true }));
      t = setTimeout(() => ac.abort(new JobTimeout(timeoutMs)), timeoutMs);
      await Promise.race([Promise.resolve().then(() => handlers[job.type](job.payload, { signal: ac.signal, attempt: job.attempts })), aborted]);
      jobs = jobs.filter((j) => j.id !== job.id);
      onEvent({ event: "job.done", id: job.id, type: job.type, attempts: job.attempts });
    } catch (e) {
      if (stopping.has(job.id)) {
        // Stopped, not failed: the attempt does not count and the job runs again on the next start.
        job.status = "queued"; job.attempts -= 1; job.runAfter = 0;
        return;
      }
      job.lastError = errorText(e);
      if (job.attempts >= maxAttempts) {
        job.status = "dead";
        job.deadAt = new Date(now()).toISOString();
        onEvent({ event: "job.dead", id: job.id, type: job.type, attempts: job.attempts });
      } else {
        job.status = "queued";
        job.runAfter = now() + backoffMs[Math.min(job.attempts - 1, backoffMs.length - 1)];
        onEvent({ event: "job.retry", id: job.id, type: job.type, attempts: job.attempts });
      }
    } finally {
      clearTimeout(t);
      running.delete(job.id);
      stopping.delete(job.id);
      save();
      pump();
    }
  }

  function pump() {
    if (!started) return;
    const t = now();
    while (running.size < concurrency) {
      const next = jobs.find((j) => j.status === "queued" && j.runAfter <= t);
      if (!next) break;
      void runOne(next);
    }
    const later = jobs.filter((j) => j.status === "queued").map((j) => j.runAfter);
    if (later.length && running.size < concurrency) wait(Math.min(...later) - t);
    settleIdle();
  }

  return {
    /** Adds a job; returns its id. The payload must be JSON (it is stored); never put a secret in it. */
    enqueue(type, payload = null) {
      if (typeof type !== "string" || !Object.hasOwn(handlers, type)) throw new TypeError(`enqueue: no handler for ${JSON.stringify(type)}`);
      const copy = JSON.parse(JSON.stringify(payload ?? null));
      const job = { id: randomUUID(), type, payload: copy, status: "queued", attempts: 0, runAfter: 0, enqueuedAt: new Date(now()).toISOString() };
      jobs.push(job);
      save();
      pump();
      return job.id;
    },
    /** Dead-lettered jobs, oldest first: id, type, attempts, last error, when (no payload). */
    deadLetters() {
      return jobs.filter((j) => j.status === "dead").map(pub);
    },
    /** Counts by status (queued, running, dead). */
    stats() {
      const c = { queued: 0, running: 0, dead: 0 };
      for (const j of jobs) c[j.status] += 1;
      return c;
    },
    /** Queues a dead job again with a fresh attempt count; false if no dead job has that id. */
    retryDead(id) {
      const j = jobs.find((x) => x.id === id && x.status === "dead");
      if (!j) return false;
      Object.assign(j, { status: "queued", attempts: 0, runAfter: 0, deadAt: null });
      save();
      onEvent({ event: "job.requeued", id: j.id, type: j.type });
      pump();
      return true;
    },
    /** Drops a dead job for good; false if no dead job has that id. */
    discardDead(id) {
      const before = jobs.length;
      jobs = jobs.filter((x) => !(x.id === id && x.status === "dead"));
      if (jobs.length === before) return false;
      save();
      return true;
    },
    start() { started = true; pump(); },
    /** Stops taking new jobs; running attempts are aborted and will run again on the next start. */
    stop() {
      started = false;
      clearTimeout(timer);
      for (const [id, ac] of running) { stopping.add(id); ac.abort(new Error("queue stopped")); }
    },
    /** Resolves when nothing is running and nothing queued is due (tests and graceful shutdown). */
    idle() { return new Promise((r) => { idleWaiters.push(r); settleIdle(); }); },
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * Admin routes for the dead-letter list. They are NOT protected here: mount them behind the app's auth guard
 * (SM-02) and, for the POSTs, its origin guard (SM-03). POST bodies are {"id":"<uuid>"} (at most 1 KB).
 */
export function deadLetterRoutes(queue, prefix = "/admin/dead-letters") {
  const readId = (req) => new Promise((resolve) => {
    let size = 0; const parts = [];
    // Past 1 KB the rest is read and dropped (not kept), so the client still gets its 400; past 64 KB, or after
    // 10 s, the connection is closed (ADR-0011 timeouts).
    const t = setTimeout(() => { req.destroy(); resolve(null); }, 10_000);
    req.on("close", () => clearTimeout(t));
    req.on("data", (c) => { size += c.length; if (size <= 1024) parts.push(c); else if (size > 65_536) { clearTimeout(t); req.destroy(); resolve(null); } });
    req.on("end", () => { clearTimeout(t); if (size > 1024) return resolve(null); try { const v = JSON.parse(Buffer.concat(parts).toString("utf8")); resolve(typeof v?.id === "string" && ID.test(v.id) ? v.id : null); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
  const act = (fn) => async (req, res) => {
    const id = await readId(req);
    if (!id) return sendJson(res, 400, { error: "invalid-input" });
    return fn(id) ? sendJson(res, 200, { ok: true, id }) : sendJson(res, 404, { error: "not-found" });
  };
  return {
    [`GET ${prefix}`]: (req, res) => sendJson(res, 200, { deadLetters: queue.deadLetters(), stats: queue.stats() }),
    [`POST ${prefix}/retry`]: act((id) => queue.retryDead(id)),
    [`POST ${prefix}/discard`]: act((id) => queue.discardDead(id)),
  };
}

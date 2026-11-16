// SM-09 ops and observability (Lite), on top of the core's /health, /ready and JSON request log (src/server.mjs,
// src/log.mjs). This add-on brings no driver and no vendor SDK.
// - Readiness (SM-09-L1): readyCheck() bounds each check with a timeout; dbReady(), queueReady() and
//   dependencyReady() are the usual checks, passed to createApp({ readyChecks }).
// - Logs (SM-09-L2): redact() removes secrets and personal data; logger() writes JSON lines with a request or job ID.
// - Errors (SM-09-L2): errorMonitor() logs each error once and sends it to a reporter (webhookReporter() over the
//   core's safeFetch, so the F2 internal-URL block holds); watchProcess() reports crashes and unhandled rejections.
import { log } from "./log.mjs";
import { safeFetch } from "./safe-fetch.mjs";

const NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * A readiness check for createApp({ readyChecks }). `fn(signal)` resolves truthy when ready. A check that resolves
 * falsy or takes longer than timeoutMs resolves false; one that throws rejects, which the core's /ready also counts
 * as not ready. So a hung dependency never hangs /ready.
 */
export function readyCheck(name, fn, { timeoutMs = 2000 } = {}) {
  if (typeof name !== "string" || !NAME.test(name)) throw new TypeError(`readyCheck: name must match ${NAME}`);
  if (typeof fn !== "function") throw new TypeError("readyCheck: fn must be a function");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new TypeError("readyCheck: timeoutMs must be 1-30000");
  return Object.freeze({
    name,
    async check() {
      const ac = new AbortController();
      let timer;
      const late = new Promise((resolve) => { timer = setTimeout(() => { ac.abort(new Error("ready-check-timeout")); resolve(false); }, timeoutMs); });
      try {
        return Boolean(await Promise.race([Promise.resolve().then(() => fn(ac.signal)), late]));
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

/** The database answers `SELECT 1`. `query(text)` is any client (e.g. a pg Pool). */
export const dbReady = (query, opts) => readyCheck("db", async () => {
  const r = await query("SELECT 1 AS ok");
  return Array.isArray(r?.rows) && r.rows.length === 1;
}, opts);

/**
 * The SM-05 queue answers stats() and its backlog is under maxQueued (default 10000), so a stuck worker that lets
 * jobs pile up takes the instance out of rotation instead of accepting more work.
 */
export const queueReady = (queue, { maxQueued = 10_000, ...opts } = {}) => {
  if (!Number.isInteger(maxQueued) || maxQueued < 0) throw new TypeError("queueReady: maxQueued must be a whole number");
  return readyCheck("queue", () => {
    const s = queue?.stats?.();
    return Number.isInteger(s?.queued) && s.queued <= maxQueued;
  }, opts);
};

/**
 * A critical HTTP dependency answers 2xx on `url`, through safeFetch (F2: internal addresses are blocked unless the
 * host is declared in allowHosts). The body is never read into the answer.
 */
export const dependencyReady = (name, url, { timeoutMs = 2000, allowHosts = [], http = safeFetch } = {}) =>
  readyCheck(name, async () => {
    const r = await http(url, { method: "GET", timeoutMs, maxBytes: 65_536, allowHosts });
    return r.status >= 200 && r.status < 300;
  }, { timeoutMs: timeoutMs + 500 });

// ---- Redaction (SM-09-L2) ----

const SECRET_KEY = /pass(word|phrase)?|secret|token|auth|cookie|session|api[-_]?key|private|credential|signature|otp|pin$/i;
const PERSONAL_KEY = /e-?mail|phone|mobile|address|^name$|full[-_]?name|first[-_]?name|last[-_]?name|user[-_]?name|display[-_]?name|^login$|birth|dob|ssn|aadhaar|pan$|ip$|ip[-_]?addr/i;
const VALUE_PATTERNS = [
  // URL credentials first (Codex PR152-r1): the e-mail pattern would otherwise eat "secret@host" and leave the rest
  // of the password ("super!") with no "@" for this pattern to anchor on.
  [/(\/\/[^/\s:@]{0,256}:)[^@\s/]{1,256}@/g, "$1[redacted]@"], // also redis://:password@host
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[redacted-jwt]"],
  [/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g, "[redacted-email]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|[sr]k_(live|test)_[A-Za-z0-9]{10,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, "[redacted-key]"],
];
const KEEP = new Set(["requestId", "jobId", "level", "time", "msg", "method", "path", "status", "ms", "code", "type", "attempt"]);

const safeString = (v) => { try { return String(v); } catch { return "[unprintable]"; } };

const redactString = (s) => {
  // Mask first, then cut, so a secret straddling the cut is never left half-visible. Strings are bounded first at
  // 20000 characters so the patterns' cost stays small.
  let out = s.length > 20_000 ? s.slice(0, 20_000) : s;
  for (const [re, to] of VALUE_PATTERNS) out = out.replace(re, to);
  return out.length > 2000 ? `${out.slice(0, 2000)}…[truncated]` : out;
};

/**
 * A redacted copy of `value` for a log line: values under secret-like or personal-data keys become "[redacted]",
 * tokens, JWTs, e-mail addresses and URL passwords inside strings are masked, long strings are cut, and nesting
 * stops at depth 5 and 50 entries per object. Never throws (cycles, BigInt, getters that throw).
 */
export function redact(value, depth = 0, seen = new WeakSet()) {
  try {
    if (typeof value === "string") return redactString(value);
    if (typeof value === "bigint") return value.toString();
    if (value === null || typeof value !== "object") return typeof value === "function" || typeof value === "symbol" ? `[${typeof value}]` : value;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (value instanceof Error) return { name: redactString(String(value.name)), message: redactString(String(value.message)), ...(value.code ? { code: redactString(String(value.code)) } : {}) };
    if (seen.has(value)) return "[cycle]";
    if (depth >= 5) return "[depth]";
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1, seen));
    const out = {};
    for (const k of Object.keys(value).slice(0, 50)) {
      out[redactString(k)] = !KEEP.has(k) && (SECRET_KEY.test(k) || PERSONAL_KEY.test(k)) ? "[redacted]" : redact(value[k], depth + 1, seen);
    }
    return out;
  } catch {
    return "[unloggable]";
  }
}

/**
 * JSON logger: logger({ out, context }).info(msg, fields) / .warn / .error, and .child({ jobId }) for a job or a
 * request. Every line is redacted; context fields (requestId, jobId) are on every line.
 */
export function logger({ out = process.stdout, context = {} } = {}) {
  const ctx = redact(context);
  // The line's own fields win: a field can never forge time, level, msg or the context's IDs. Without a context,
  // requestId and jobId given as fields are kept as written (redacted).
  const write = (level) => (msg, fields = {}) => {
    const red = redact(fields);
    const { time: _t, ...rest } = red !== null && typeof red === "object" && !Array.isArray(red) ? red : { data: red };
    log({ ...rest, ...ctx, level, msg: redactString(safeString(msg)) }, out);
  };
  return Object.freeze({
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    child: (more) => logger({ out, context: { ...context, ...more } }),
  });
}

// ---- Error monitoring (SM-09-L2) ----

/**
 * errorMonitor({ report, log }) → { capture(err, context) }. Each capture writes one redacted error line and sends
 * { time, name, message, code, requestId, jobId, release } to `report` (e.g. webhookReporter). The report is
 * redacted too, and a failing reporter is logged once per capture, never thrown: monitoring must not break the app.
 */
export function errorMonitor({ report = null, log: lg = logger(), release = process.env.GIT_SHA ?? "unknown" } = {}) {
  if (report !== null && typeof report !== "function") throw new TypeError("errorMonitor: report must be a function");
  return Object.freeze({
    async capture(err, context = {}) {
      const e = redact(err instanceof Error ? err : new Error(safeString(err)));
      const c = context !== null && typeof context === "object" ? context : {};
      const ids = { ...(c.requestId ? { requestId: redact(safeString(c.requestId)) } : {}), ...(c.jobId ? { jobId: redact(safeString(c.jobId)) } : {}) };
      lg.error("error", { ...ids, error: e });
      if (!report) return false;
      try {
        await report({ time: new Date().toISOString(), name: e.name, message: e.message, ...(e.code ? { code: e.code } : {}), ...ids, release: redact(String(release)) });
        return true;
      } catch (reportErr) {
        lg.warn("error-report-failed", { code: reportErr?.code ?? "report-failed" });
        return false;
      }
    },
  });
}

/**
 * A reporter that POSTs the error as JSON to an HTTPS webhook (an error-monitoring service's intake URL), through
 * safeFetch. The URL comes from configuration (e.g. ERROR_WEBHOOK_URL in the vault), never from a request.
 */
export function webhookReporter(url, { timeoutMs = 3000, http = safeFetch, headers = {} } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new TypeError("webhookReporter: url is not a URL"); }
  if (parsed.protocol !== "https:") throw new TypeError("webhookReporter: url must be https");
  return async (event) => {
    const r = await http(parsed.href, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(event), timeoutMs, maxBytes: 65_536 });
    if (r.status < 200 || r.status >= 300) throw Object.assign(new Error("error webhook refused the report"), { code: `webhook-${r.status}` });
  };
}

/**
 * Reports uncaught exceptions (then exits 1, as Node would, at most exitAfterMs later) and unhandled rejections.
 * Note: while it listens, an unhandled rejection is reported and the process keeps running (Node's default is to
 * crash). Returns an undo.
 */
export function watchProcess(monitor, { proc = process, exit = (code) => proc.exit(code), exitAfterMs = 5000 } = {}) {
  const onRejection = (reason) => { Promise.resolve().then(() => monitor.capture(reason, {})).catch(() => {}); };
  // A crash exits 1 after the report, or after exitAfterMs if the reporter hangs: the process never stays up.
  const onException = (err) => {
    let done = false;
    const finish = () => { if (!done) { done = true; exit(1); } };
    const timer = setTimeout(finish, exitAfterMs);
    Promise.resolve().then(() => monitor.capture(err, {})).catch(() => {}).finally(() => { clearTimeout(timer); finish(); });
  };
  proc.on("unhandledRejection", onRejection);
  proc.on("uncaughtException", onException);
  return () => { proc.off("unhandledRejection", onRejection); proc.off("uncaughtException", onException); };
}

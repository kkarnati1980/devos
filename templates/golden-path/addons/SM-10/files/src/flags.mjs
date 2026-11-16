// SM-10 feature flags (Lite): one kill switch per spec phase, read at run time, so turning a phase off hides its
// features without a redeploy or a restart. This add-on brings no driver and no dependency.
// - killSwitches({ phases, source }): the app's switches. `source()` returns { [phase]: true | false } from a place an
//   operator can change while the app runs: fileSource(path) (a JSON file on a mounted volume) or dbSource(query)
//   (the kill_switch table). The state is re-read at most every `refreshMs`.
// - switches.guard(phase, handler): a route that answers 404 (the core's deny-by-default answer) while its phase is off.
//   After the first read, requests never wait for the source: a stale state is re-read in the background.
// - switches.clientFlags(): { [phase]: boolean } for the UI, so it hides the phase's screens and links.
// - setKillSwitch(query, phase, enabled, by): turns a phase on or off in the kill_switch table (an operator action).
import { readFile } from "node:fs/promises";

const PHASE = /^[a-z][a-z0-9-]{0,63}$/;
const BY = /^[\w.@:-]{1,128}$/;

/** The table dbSource() reads. The app puts it in a migration; a phase without a row is at its default. */
export const KILL_SWITCH_SQL = `CREATE TABLE IF NOT EXISTS kill_switch (
  phase text PRIMARY KEY CHECK (phase ~ '^[a-z][a-z0-9-]{0,63}$'),
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL
)`;

const checkPhase = (phase) => {
  if (typeof phase !== "string" || !PHASE.test(phase)) throw new TypeError(`flags: phase ${JSON.stringify(phase)} must match ${PHASE}`);
  return phase;
};

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/**
 * The app's kill switches, one per spec phase.
 * - `phases`: every phase name, declared once (a typo in guard() or isOn() then throws instead of hiding nothing).
 * - `source()`: async, returns { [phase]: boolean }. It gets { signal } and is cut after `timeoutMs`.
 * - `defaults`: { [phase]: boolean } used before the first good read and for a phase the source does not list.
 *   A phase with no default is on: a kill switch hides a phase only when someone turns it off.
 * - If a read fails (an error, a timeout, a value that is not an object), the last good state is kept and `onError`
 *   is told; a value that is not true or false keeps that phase's last good value. Unknown names are reported, not used.
 */
export function killSwitches({ phases, source, defaults = {}, refreshMs = 5000, timeoutMs = 2000, now = Date.now, onError = () => {} } = {}) {
  if (!Array.isArray(phases) || phases.length === 0) throw new TypeError("flags: declare at least one phase");
  const known = new Set();
  for (const p of phases) {
    checkPhase(p);
    if (known.has(p)) throw new TypeError(`flags: phase ${JSON.stringify(p)} is declared twice`);
    known.add(p);
  }
  if (typeof source !== "function") throw new TypeError("flags: source must be a function");
  if (!isPlainObject(defaults)) throw new TypeError("flags: defaults must be an object");
  for (const [p, v] of Object.entries(defaults)) {
    if (!known.has(p)) throw new TypeError(`flags: default for undeclared phase ${JSON.stringify(p)}`);
    if (typeof v !== "boolean") throw new TypeError(`flags: default for ${JSON.stringify(p)} must be true or false`);
  }
  for (const [n, v, min, max] of [["refreshMs", refreshMs, 0, 3_600_000], ["timeoutMs", timeoutMs, 1, 60_000]]) {
    if (!Number.isInteger(v) || v < min || v > max) throw new TypeError(`flags: ${n} must be a whole number ${min}-${max}`);
  }
  const report = (err) => { try { onError(err); } catch { /* reporting must not break the app */ } };
  const base = Object.fromEntries(phases.map((p) => [p, defaults[p] ?? true]));
  let state = Object.freeze({ ...base });
  let readAt = -Infinity;
  let inFlight = null;
  let pendingSource = null; // a source() call that timed out and has not settled yet
  let lastUnknown = "";

  const apply = (value) => {
    if (!isPlainObject(value)) throw new TypeError("flags: source() must return an object of phase: true|false");
    const next = { ...base };
    for (const p of phases) {
      if (!Object.hasOwn(value, p)) continue;
      if (typeof value[p] === "boolean") next[p] = value[p];
      else { next[p] = state[p]; report(new TypeError(`flags: value for ${JSON.stringify(p)} is not true or false; kept ${state[p]}`)); }
    }
    const unknown = Object.keys(value).filter((k) => !known.has(k)).map((k) => JSON.stringify(k)).join(", ");
    // Reported once per change of the set, not on every read (a stale row would otherwise be reported every refreshMs).
    if (unknown && unknown !== lastUnknown) report(new TypeError(`flags: unknown phase in source: ${unknown}`));
    lastUnknown = unknown;
    state = Object.freeze(next);
  };

  const readOnce = async () => {
    if (pendingSource) {
      // The last read timed out and is still running (a hung query holding a pool connection): never stack another.
      report(new Error("flags: previous source read still pending; kept the last good state"));
      readAt = now();
      return;
    }
    const ac = new AbortController();
    let timer;
    let timedOut = false;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { timedOut = true; ac.abort(); reject(new Error(`flags: source did not answer within ${timeoutMs} ms`)); }, timeoutMs);
    });
    const call = Promise.resolve().then(() => source({ signal: ac.signal }));
    call.catch(() => {}); // a late failure of a timed-out read is not unhandled
    try {
      apply(await Promise.race([call, timeout]));
    } catch (err) {
      report(err); // keep the last good state
      if (timedOut) {
        pendingSource = call;
        call.then(() => {}, () => {}).finally(() => { if (pendingSource === call) pendingSource = null; });
      }
    } finally {
      clearTimeout(timer);
      readAt = now();
    }
  };

  /** Re-reads the source now (one read at a time; callers during a read share it). Never throws. */
  const refresh = () => {
    if (!inFlight) inFlight = readOnce().finally(() => { inFlight = null; });
    return inFlight;
  };
  /** Re-reads the source if the state is older than refreshMs, waits for it, and returns the state. Never throws. */
  const current = async () => {
    if (now() - readAt >= refreshMs) await refresh();
    return state;
  };
  /**
   * The request path: the first read is awaited; after that the current state is returned at once and a stale one
   * is re-read in the background (stale-while-revalidate), so a slow source never delays a request.
   */
  const fresh = async () => {
    if (readAt === -Infinity) return current();
    if (now() - readAt >= refreshMs) refresh();
    return state;
  };
  const isOn = (phase) => {
    if (!known.has(phase)) throw new TypeError(`flags: unknown phase ${JSON.stringify(phase)}`);
    return state[phase];
  };

  return Object.freeze({
    phases: Object.freeze([...phases]),
    refresh,
    current,
    /** Resolves when no read is in flight (for tests and graceful shutdown). */
    settled: () => (inFlight ? inFlight.then(() => {}) : Promise.resolve()),
    isOn,
    /** The phase state for the UI: { [phase]: boolean }. Hiding in the UI is not enough; guard the routes too. */
    clientFlags: async () => ({ ...(await fresh()) }),
    /** A route handler that answers 404 while `phase` is off, exactly as the core does for a route that does not exist. */
    guard(phase, handler) {
      if (!known.has(phase)) throw new TypeError(`flags: unknown phase ${JSON.stringify(phase)}`);
      if (typeof handler !== "function") throw new TypeError("flags: guard() needs a handler");
      return async (req, res, ctx) => {
        if (!(await fresh())[phase]) {
          res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
          return res.end(JSON.stringify({ error: "not-found" }));
        }
        return handler(req, res, ctx);
      };
    },
  });
}

/**
 * A source that reads a JSON file such as {"phase-2": false}. A missing file means every phase is at its default;
 * a file that is not valid JSON is an error (the last good state is kept).
 */
export function fileSource(path) {
  if (typeof path !== "string" || path === "") throw new TypeError("flags: fileSource needs a path");
  return async ({ signal } = {}) => {
    let text;
    try {
      text = await readFile(path, { encoding: "utf8", signal });
    } catch (err) {
      if (err && err.code === "ENOENT") return {};
      throw err;
    }
    return JSON.parse(text);
  };
}

/** A source that reads the kill_switch table (KILL_SWITCH_SQL) through any `query(text, params) → { rows }`. */
export function dbSource(query) {
  if (typeof query !== "function") throw new TypeError("flags: dbSource needs a query function");
  // The signal is passed on for drivers that can cancel a query; killSwitches() never starts a second read while one hangs.
  return async ({ signal } = {}) => {
    const res = await query("SELECT phase, enabled FROM kill_switch", [], { signal });
    if (!Array.isArray(res?.rows)) throw new TypeError("flags: query() must return { rows }");
    const out = {};
    for (const r of res.rows) out[r.phase] = r.enabled;
    return out;
  };
}

/** Turns a phase on or off in the kill_switch table, recording who did it. Takes effect within refreshMs. */
export async function setKillSwitch(query, phase, enabled, by) {
  if (typeof query !== "function") throw new TypeError("flags: setKillSwitch needs a query function");
  checkPhase(phase);
  if (typeof enabled !== "boolean") throw new TypeError("flags: enabled must be true or false");
  if (typeof by !== "string" || !BY.test(by)) throw new TypeError(`flags: by must match ${BY}`);
  await query(
    "INSERT INTO kill_switch (phase, enabled, updated_at, updated_by) VALUES ($1, $2, now(), $3) "
      + "ON CONFLICT (phase) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now(), updated_by = EXCLUDED.updated_by",
    [phase, enabled, by],
  );
}

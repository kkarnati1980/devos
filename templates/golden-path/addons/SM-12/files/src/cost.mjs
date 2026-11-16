// SM-12 cost and rate (Lite): every paid service is declared once with a monthly cap, and every paid call goes through
// the meter, which reserves its cost against the cap before the call and records what it really cost after it.
// This add-on brings no driver and no dependency. Amounts are whole numbers in the service's own unit (e.g. US cents),
// so sums never drift.
// - paidServices([{ name, unit, monthlyCap }]): the declaration. There is no default cap: each cap is the app owner's decision.
// - costMeter({ services, store }).charge(service, estimate, fn): estimate is an upper bound (>= 1); refuses (CapExceededError, before fn runs) when the
//   month-to-date spend plus the estimate would pass the cap; otherwise runs fn and records its real cost.
// - meter.report(): the budget record for the project budget: month, and per service its unit, cap and spend.
// - memoryStore() (one process, tests) and pgStore(query) (the paid_usage table, PAID_USAGE_SQL) keep the spend.

const NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
const UNIT = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX = Number.MAX_SAFE_INTEGER;
const SERVICES = new WeakSet();

export class CapExceededError extends Error {
  constructor(service, month, spent, estimate, cap) {
    super(`cost: ${service} would pass its monthly cap (${month}: ${spent} spent + ${estimate} > ${cap})`);
    this.name = "CapExceededError";
    this.code = "cap-exceeded";
    this.status = 429;
    Object.assign(this, { service, month, spent, estimate, cap });
  }
}

const whole = (what, v, min = 0) => {
  if (!Number.isSafeInteger(v) || v < min) throw new TypeError(`cost: ${what} must be a whole number >= ${min}`);
  return v;
};

/** Checks and freezes the paid-service declaration: [{ name, unit, monthlyCap }]. */
export function paidServices(list) {
  if (!Array.isArray(list) || list.length === 0) throw new TypeError("cost: declare at least one paid service");
  const seen = new Set();
  const services = Object.freeze(list.map((s) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new TypeError("cost: each paid service is an object");
    for (const k of Object.keys(s)) if (!["name", "unit", "monthlyCap"].includes(k)) throw new TypeError(`cost: unknown field ${JSON.stringify(k)}`);
    if (typeof s.name !== "string" || !NAME.test(s.name)) throw new TypeError(`cost: service name ${JSON.stringify(s.name)} must match ${NAME}`);
    if (seen.has(s.name)) throw new TypeError(`cost: service ${JSON.stringify(s.name)} is declared twice`);
    seen.add(s.name);
    if (typeof s.unit !== "string" || !UNIT.test(s.unit)) throw new TypeError(`cost: ${s.name}: unit must match ${UNIT} (e.g. "usd-cents")`);
    whole(`${s.name}: monthlyCap (no default)`, s.monthlyCap, 1);
    return Object.freeze({ name: s.name, unit: s.unit, monthlyCap: s.monthlyCap });
  }));
  SERVICES.add(services);
  return services;
}

/** "YYYY-MM" of `ms` in `timeZone` (the month the budget counts in). */
export function monthOf(ms, timeZone = "UTC") {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}`;
}

/**
 * One process only (tests, a single instance). A multi-instance app uses pgStore, so every instance counts
 * against the same cap.
 */
export function memoryStore() {
  const spent = new Map();
  const key = (service, month) => `${service} ${month}`;
  return {
    async reserve(service, month, amount, cap) {
      const now = spent.get(key(service, month)) ?? 0;
      if (now + amount > cap) return { ok: false, spent: now };
      spent.set(key(service, month), now + amount);
      return { ok: true, spent: now + amount };
    },
    async adjust(service, month, delta) {
      spent.set(key(service, month), Math.max(0, (spent.get(key(service, month)) ?? 0) + delta));
    },
    async read(month) {
      const out = {};
      for (const [k, v] of spent) { const [s, m] = k.split(" "); if (m === month) out[s] = v; }
      return out;
    },
  };
}

/** The table pgStore() uses; the app puts it in a migration. One row per service and month. */
export const PAID_USAGE_SQL = `CREATE TABLE IF NOT EXISTS paid_usage (
  service text NOT NULL,
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
  spent bigint NOT NULL DEFAULT 0 CHECK (spent >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service, month)
)`;

/**
 * The spend in Postgres through any `query(text, params) → { rows }`. The reserve is one conditional UPDATE: Postgres
 * re-checks `spent + amount <= cap` on the newest row version, so concurrent callers on any instance can never pass the cap together.
 */
export function pgStore(query) {
  if (typeof query !== "function") throw new TypeError("cost: pgStore needs a query function");
  const rowsOf = (res) => {
    if (!Array.isArray(res?.rows)) throw new TypeError("cost: query() must return { rows }");
    return res.rows;
  };
  return {
    async reserve(service, month, amount, cap) {
      await query("INSERT INTO paid_usage (service, month) VALUES ($1, $2) ON CONFLICT (service, month) DO NOTHING", [service, month]);
      const won = rowsOf(await query(
        "UPDATE paid_usage SET spent = spent + $3, updated_at = now() WHERE service = $1 AND month = $2 AND spent + $3 <= $4 RETURNING spent",
        [service, month, amount, cap],
      ));
      if (won.length === 1) return { ok: true, spent: Number(won[0].spent) };
      const cur = rowsOf(await query("SELECT spent FROM paid_usage WHERE service = $1 AND month = $2", [service, month]));
      return { ok: false, spent: Number(cur[0]?.spent ?? 0) };
    },
    async adjust(service, month, delta) {
      rowsOf(await query("UPDATE paid_usage SET spent = GREATEST(0, spent + $3), updated_at = now() WHERE service = $1 AND month = $2 RETURNING spent", [service, month, delta]));
    },
    async read(month) {
      const out = {};
      for (const r of rowsOf(await query("SELECT service, spent FROM paid_usage WHERE month = $1", [month]))) out[r.service] = Number(r.spent);
      return out;
    },
  };
}

/**
 * The meter. `charge(service, estimate, fn)`:
 * 1. reserves `estimate` against this month's cap; if that would pass the cap, throws CapExceededError and fn never runs;
 *    The estimate must be an upper bound of the real cost (e.g. max tokens × price) and at least 1: concurrent calls
 *    are held under the cap by their estimates, so each concurrent underestimate adds its own overrun.
 * 2. runs fn; if it returns { cost }, the reservation is corrected to that real cost (which may pass the cap: it is
 *    what was spent, and the next charge is refused). If that correction fails (a bad cost, a store error), the
 *    estimate stays, onError is told, and fn's result is still returned: the call was paid for, so it must not fail
 *    and invite a paid retry;
 * 3. if fn throws, the reservation stays: a failed paid call may still have been billed, so the meter over-counts
 *    rather than under-counts. Returns fn's result.
 */
export function costMeter({ services, store = memoryStore(), now = Date.now, timeZone = "UTC", onError = () => {} } = {}) {
  if (!SERVICES.has(services)) throw new TypeError("cost: pass services from paidServices()");
  for (const m of ["reserve", "adjust", "read"]) if (typeof store?.[m] !== "function") throw new TypeError(`cost: store.${m} must be a function`);
  monthOf(0, timeZone); // an unknown time zone throws here, not on the first paid call
  const byName = new Map(services.map((s) => [s.name, s]));
  const service = (name) => {
    const s = byName.get(name);
    if (!s) throw new TypeError(`cost: undeclared paid service ${JSON.stringify(name)}`);
    return s;
  };
  const month = () => monthOf(now(), timeZone);

  return Object.freeze({
    async charge(name, estimate, fn) {
      const s = service(name);
      whole(`${name}: estimate`, estimate, 1);
      if (estimate > MAX / 2) throw new TypeError(`cost: ${name}: estimate is too large`);
      if (typeof fn !== "function") throw new TypeError("cost: charge() needs a function to run");
      const m = month();
      const r = await store.reserve(s.name, m, estimate, s.monthlyCap);
      if (!r.ok) throw new CapExceededError(s.name, m, r.spent, estimate, s.monthlyCap);
      const result = await fn();
      if (result && typeof result === "object" && Object.hasOwn(result, "cost")) {
        try {
          whole(`${name}: reported cost`, result.cost, 0);
          if (result.cost !== estimate) await store.adjust(s.name, m, result.cost - estimate);
        } catch (err) {
          // Reporting must not break the app: a throwing or a rejecting (async) onError is swallowed.
          Promise.resolve().then(() => onError(err)).catch(() => {});
        }
      }
      return result;
    },
    /** The budget record: { month, services: [{ service, unit, monthlyCap, spent, remaining }] }. */
    async report() {
      const m = month();
      const spent = await store.read(m);
      return {
        month: m,
        services: services.map((s) => ({
          service: s.name, unit: s.unit, monthlyCap: s.monthlyCap, spent: spent[s.name] ?? 0,
          remaining: Math.max(0, s.monthlyCap - (spent[s.name] ?? 0)),
        })),
      };
    },
  });
}

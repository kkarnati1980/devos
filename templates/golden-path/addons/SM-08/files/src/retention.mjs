// SM-08 data retention (Lite). This add-on brings no driver: `query(text, params)` is any client that returns
// `{ rows }` (e.g. a pg Pool). Postgres-style $n placeholders.
// - retentionPolicy(classes): each data class declares its table, age column, key column and retention period in days.
//   There is no default period: every app declares its own (SM-08-L1).
// - purgeExpired(query, policy, options): deletes rows older than each class's period, in bounded batches.
// - purgeJob(query, policy, options): the same purge as an SM-05 job handler `(payload, { signal })` (SM-08-L1).

const DAY_MS = 86_400_000;
const NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const FIELDS = new Set(["name", "table", "column", "key", "type", "days"]);
// The cutoff ($1, an ISO instant) in the column's own type, so the comparison never depends on the session TimeZone.
const CUTOFF = Object.freeze({
  timestamptz: "$1::timestamptz",
  timestamp: "($1::timestamptz AT TIME ZONE 'UTC')", // a timestamp without time zone holding UTC (e.g. Prisma DateTime)
  date: "($1::timestamptz AT TIME ZONE 'UTC')::date", // a row dated on the cutoff day (UTC) is kept
});
const POLICIES = new WeakSet();

const ident = (what, cls, value, { qualified = false } = {}) => {
  const parts = typeof value === "string" ? value.split(".") : [];
  const ok = parts.length >= 1 && parts.length <= (qualified ? 2 : 1) && parts.every((p) => IDENT.test(p));
  if (!ok) throw new TypeError(`retention: class ${JSON.stringify(cls)}: ${what} must be a lower-case SQL name${qualified ? " (schema.table allowed)" : ""}`);
  return parts.map((p) => `"${p}"`).join(".");
};

/**
 * Checks and freezes the app's retention policy. Each class: { name, table, column, key = "id", type = "timestamptz", days }.
 * `column` is the row's age; `type` is its SQL type: "timestamptz", "timestamp" (without time zone, holding UTC) or
 * "date". `key` is a unique, NOT NULL column (the primary key) used to delete in batches.
 */
export function retentionPolicy(classes) {
  if (!Array.isArray(classes) || classes.length === 0) throw new TypeError("retention: declare at least one data class");
  const seen = new Set();
  const policy = Object.freeze(classes.map((c) => {
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new TypeError("retention: each data class is an object");
    const name = c.name;
    if (typeof name !== "string" || !NAME.test(name)) throw new TypeError(`retention: class name ${JSON.stringify(name)} must match ${NAME}`);
    if (seen.has(name)) throw new TypeError(`retention: class ${JSON.stringify(name)} is declared twice`);
    seen.add(name);
    for (const k of Object.keys(c)) if (!FIELDS.has(k)) throw new TypeError(`retention: class ${JSON.stringify(name)}: unknown field ${JSON.stringify(k)}`);
    if (!Number.isInteger(c.days) || c.days < 1 || c.days > 36_500) {
      throw new TypeError(`retention: class ${JSON.stringify(name)}: days must be a whole number 1-36500 (no default)`);
    }
    return Object.freeze({
      name,
      days: c.days,
      table: ident("table", name, c.table, { qualified: true }),
      column: ident("column", name, c.column),
      key: ident("key", name, c.key ?? "id"),
      type: (() => {
        const t = c.type === undefined ? "timestamptz" : c.type;
        if (typeof t !== "string" || !Object.hasOwn(CUTOFF, t)) throw new TypeError(`retention: class ${JSON.stringify(name)}: type must be one of ${Object.keys(CUTOFF).join(", ")}`);
        return t;
      })(),
    });
  }));
  POLICIES.add(policy);
  return policy;
}

const checkPolicy = (policy) => {
  if (!POLICIES.has(policy)) throw new TypeError("retention: pass a policy from retentionPolicy()");
};

const int = (name, v, min, max) => {
  if (!Number.isInteger(v) || v < min || v > max) throw new TypeError(`retention: ${name} must be a whole number ${min}-${max}`);
  return v;
};

/**
 * The DELETE for one batch of one class: only rows whose age column is strictly older than the cutoff ($1, cast to the
 * column's type). The age test is repeated outside the sub-select, so a row whose age changed after the statement
 * started (a refreshed session, a restored recycle-bin row) is re-checked by Postgres and kept.
 */
export const purgeSql = (cls) => {
  const old = `${cls.column} < ${CUTOFF[cls.type]}`;
  return `DELETE FROM ${cls.table} WHERE ${cls.key} IN (SELECT ${cls.key} FROM ${cls.table} WHERE ${old} ORDER BY ${cls.column} LIMIT $2) AND ${old} RETURNING ${cls.key}`;
};

/**
 * Deletes expired rows, class by class, at most `batchSize` rows per statement and `maxBatches` statements per
 * class per run. A row whose age is exactly the cutoff, newer, or NULL is kept. The cutoff is fixed once per run.
 * Between batches an aborted `signal` stops the run (its reason is thrown). Returns
 * { classes: [{ name, days, cutoff, deleted, more }] }; `more` means the class hit maxBatches, so rows may remain for the next run.
 */
export async function purgeExpired(query, policy, { now = Date.now, batchSize = 1000, maxBatches = 100, signal } = {}) {
  if (typeof query !== "function") throw new TypeError("retention: query must be a function");
  checkPolicy(policy);
  int("batchSize", batchSize, 1, 100_000);
  int("maxBatches", maxBatches, 1, 100_000);
  const at = now();
  if (!Number.isFinite(at)) throw new TypeError("retention: now() must return a time in ms");
  const classes = [];
  for (const cls of policy) {
    const cutoff = new Date(at - cls.days * DAY_MS).toISOString();
    const text = purgeSql(cls);
    let deleted = 0;
    let more = false;
    for (let batch = 0; ; batch += 1) {
      if (signal?.aborted) throw signal.reason ?? new Error("retention: aborted");
      if (batch === maxBatches) { more = true; break; }
      const res = await query(text, [cutoff, batchSize]);
      if (!Array.isArray(res?.rows)) throw new TypeError("retention: query() must return { rows } (RETURNING is used to count)");
      const n = res.rows.length;
      deleted += n;
      if (n < batchSize) break;
    }
    classes.push({ name: cls.name, days: cls.days, cutoff, deleted, more });
  }
  return { classes };
}

/**
 * An SM-05 handler that runs the purge. The payload is ignored: periods and tables come only from the policy, so a
 * job's payload can never widen what is deleted. Schedule it daily, e.g. queue.enqueue("retention.purge").
 */
export function purgeJob(query, policy, options = {}) {
  checkPolicy(policy);
  return (_payload, ctx = {}) => purgeExpired(query, policy, { ...options, signal: ctx.signal });
}

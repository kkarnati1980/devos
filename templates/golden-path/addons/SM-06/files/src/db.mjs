// SM-06 data layer (Lite). Two helpers any database client can use; this add-on brings no driver.
// - poolConfig(env): the per-project pool limit and statement timeout, read once and range-checked (SM-06-L1).
// - withTransaction(client, fn): related writes share one transaction (SM-06-L1). `client` is anything with an
//   async `query(sql)` method on ONE connection (e.g. a pg PoolClient), never the pool itself, or BEGIN and the
//   writes could run on different connections.

const ACTIVE = Symbol("sm06.transaction");

const int = (env, name, { min, max, fallback }) => {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    if (fallback === undefined) throw new Error(`db: ${name} is required (${min}-${max})`);
    return fallback;
  }
  if (!/^\d{1,9}$/.test(String(raw))) throw new Error(`db: ${name} must be a whole number (${min}-${max})`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`db: ${name} must be ${min}-${max}`);
  return n;
};

/** The pool settings an app passes to its driver. DB_POOL_MAX has no default: every project sets its own limit. */
export function poolConfig(env = process.env) {
  return Object.freeze({
    max: int(env, "DB_POOL_MAX", { min: 1, max: 50 }),
    statementTimeoutMs: int(env, "DB_STATEMENT_TIMEOUT_MS", { min: 100, max: 600_000, fallback: 10_000 }),
    connectTimeoutMs: int(env, "DB_CONNECT_TIMEOUT_MS", { min: 100, max: 60_000, fallback: 5_000 }),
  });
}

/**
 * Runs fn(client) between BEGIN and COMMIT. If fn throws (or COMMIT fails) the transaction is rolled back and the
 * original error is re-thrown; a failed ROLLBACK never hides it. Nested use is refused: one transaction per call.
 */
export async function withTransaction(client, fn) {
  if (!client || typeof client.query !== "function") throw new TypeError("withTransaction: client needs a query() method");
  if (typeof fn !== "function") throw new TypeError("withTransaction: fn must be a function");
  if (client[ACTIVE]) throw new Error("withTransaction: already inside a transaction on this client");
  client[ACTIVE] = true;
  try {
    await client.query("BEGIN");
    let result;
    try {
      result = await fn(client);
      await client.query("COMMIT");
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* the original error matters more */ }
      throw err;
    }
    return result;
  } finally {
    client[ACTIVE] = false;
  }
}

// SM-07 add-on (idempotency, SM-07-L1): create routes and job handlers take an idempotency key, and the key is stored
// under a unique constraint, so a double submit or a replayed job runs its effect once.
// No dependencies, no driver: the SQL store takes any `query(text, params) -> { rows }` (a pg client or pool works).
//
//   claim:    the first caller for (scope, key) inserts a `running` row and runs the effect;
//   done:     a later caller with the same request gets the stored result back (a replay), and the effect never reruns;
//   running:  a caller that arrives while the first is still running is refused (409), never run in parallel;
//   mismatch: the same key with a different request is refused (422), never answered with another request's result;
//   failure:  a failed effect frees the key, so a retry runs it again.
// Keys are per caller: a route behind SM-02's protect() keys by (scope, caller id, key), so one caller can neither
// replay nor probe another caller's key. A process that dies mid-effect, or a result that cannot be stored, leaves
// its row `running` (fail closed): the key answers 409 until the row is cleared.
import { createHash } from "node:crypto";

export const KEY_HEADER = "idempotency-key";
export const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const MAX_CLAIM_TRIES = 3;

/** The table the SQL store needs. Put it in a migration; the primary key is the unique constraint SM-07-L1 asks for.
 * `owner` is the caller id ('' for a route without callers). */
export const IDEMPOTENCY_SQL = `CREATE TABLE IF NOT EXISTS idempotency_key (
  scope text NOT NULL,
  owner text NOT NULL DEFAULT '',
  key text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('running', 'done')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (scope, owner, key)
);`;

export class IdempotencyError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "IdempotencyError";
    this.code = code;
    this.status = status;
  }
}

/** A stable hash of the request: object keys sorted, so `{a,b}` and `{b,a}` are the same request. */
export function requestHash(request) {
  const stable = (v) => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
    return v === undefined ? null : v;
  };
  return createHash("sha256").update(JSON.stringify(stable(request ?? null))).digest("hex");
}

/** For tests and single-process apps. Same semantics as the SQL store; a Map key is unique by construction. */
export function memoryStore() {
  const rows = new Map();
  const id = (scope, owner, key) => JSON.stringify([scope, owner, key]);
  return {
    rows,
    async claim(scope, owner, key, hash) {
      const k = id(scope, owner, key);
      const row = rows.get(k);
      if (!row) { rows.set(k, { hash, state: "running", result: null }); return { state: "new" }; }
      return { state: row.state, hash: row.hash, result: row.result };
    },
    async complete(scope, owner, key, result) {
      const row = rows.get(id(scope, owner, key));
      if (row && row.state === "running") Object.assign(row, { state: "done", result: JSON.parse(JSON.stringify(result ?? null)) });
    },
    async release(scope, owner, key) {
      const k = id(scope, owner, key);
      if (rows.get(k)?.state === "running") rows.delete(k);
    },
  };
}

/** Postgres store over IDEMPOTENCY_SQL. `query(text, params)` must resolve to `{ rows }` (node-postgres does). */
export function sqlStore(query) {
  if (typeof query !== "function") throw new TypeError("sqlStore: query must be a function");
  return {
    async claim(scope, owner, key, hash) {
      for (let i = 0; i < MAX_CLAIM_TRIES; i++) {
        const ins = await query(
          "INSERT INTO idempotency_key (scope, owner, key, request_hash, state) VALUES ($1, $2, $3, $4, 'running') ON CONFLICT (scope, owner, key) DO NOTHING RETURNING key",
          [scope, owner, key, hash],
        );
        if (ins.rows.length === 1) return { state: "new" };
        const sel = await query("SELECT request_hash, state, result FROM idempotency_key WHERE scope = $1 AND owner = $2 AND key = $3", [scope, owner, key]);
        const row = sel.rows[0];
        // A driver that hands jsonb back as text (custom type parsers) gets it parsed here.
        if (row) return { state: row.state, hash: row.request_hash, result: typeof row.result === "string" ? JSON.parse(row.result) : row.result ?? null };
        // The row was released between the two statements: claim again.
      }
      throw new IdempotencyError("idempotency-claim-contended", 409);
    },
    async complete(scope, owner, key, result) {
      await query("UPDATE idempotency_key SET state = 'done', result = $4, completed_at = now() WHERE scope = $1 AND owner = $2 AND key = $3 AND state = 'running'",
        [scope, owner, key, JSON.stringify(result ?? null)]);
    },
    async release(scope, owner, key) {
      await query("DELETE FROM idempotency_key WHERE scope = $1 AND owner = $2 AND key = $3 AND state = 'running'", [scope, owner, key]);
    },
  };
}

function checkArgs(store, scope) {
  if (!store || typeof store.claim !== "function" || typeof store.complete !== "function" || typeof store.release !== "function") {
    throw new TypeError("idempotency: store must have claim, complete and release");
  }
  if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope)) throw new TypeError("idempotency: scope must be a short lower-case name");
}

/**
 * Runs `fn()` at most once for (scope, key). Returns `{ result, replayed }`. Throws IdempotencyError:
 * 400 `idempotency-key-invalid`, 409 `idempotency-key-in-progress`, 422 `idempotency-key-reused`.
 * `result` must be JSON (it is stored and replayed as JSON).
 */
export async function idempotent(store, { scope, owner = "", key, request }, fn) {
  checkArgs(store, scope);
  if (typeof owner !== "string" || owner.length > 200) throw new TypeError("idempotency: owner must be a short string");
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) throw new IdempotencyError("idempotency-key-invalid", 400);
  const hash = requestHash(request);
  const claim = await store.claim(scope, owner, key, hash);
  if (claim.state !== "new") {
    if (claim.hash !== hash) throw new IdempotencyError("idempotency-key-reused", 422);
    if (claim.state === "done") return { result: claim.result, replayed: true };
    throw new IdempotencyError("idempotency-key-in-progress", 409);
  }
  let result;
  try {
    result = await fn();
  } catch (e) {
    // A failed release must not hide the effect's own error; the row then stays `running` (fail closed).
    await store.release(scope, owner, key).catch(() => {});
    throw e;
  }
  // If the result is not JSON (BigInt, a cycle) or this write fails, the effect has run and the row stays `running`
  // (fail closed: retries get 409, the effect never runs twice).
  const stored = JSON.parse(JSON.stringify(result ?? null));
  await store.complete(scope, owner, key, stored);
  return { result: stored, replayed: false };
}

const sendJson = (res, status, body, extra = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify(body));
};

/**
 * A create route keyed by the `Idempotency-Key` header. `handler(req, ctx)` returns `{ status, body }` and does not
 * write `res` itself, so the first answer can be stored and replayed.
 * Behind SM-02's `protect()` the key belongs to `ctx.caller.id`. The request is the method, the path and
 * `ctx.input` (put SM-01's `validated()` outside this wrapper) or `fingerprint(req, ctx)` when given.
 * A missing key is a 400 `idempotency-key-required`. A replay carries `idempotent-replayed: true`.
 */
export function withIdempotency(store, scope, handler, { fingerprint } = {}) {
  checkArgs(store, scope);
  if (typeof handler !== "function") throw new TypeError("withIdempotency: handler must be a function");
  const wrapped = async (req, res, ctx = {}) => {
    const raw = req.headers[KEY_HEADER];
    if (raw === undefined) return sendJson(res, 400, { error: "idempotency-key-required" });
    if (Array.isArray(raw) || !KEY_PATTERN.test(raw)) return sendJson(res, 400, { error: "idempotency-key-invalid" });
    const path = new URL(req.url || "/", "http://app").pathname;
    const request = fingerprint ? fingerprint(req, ctx) : { method: req.method, path, input: ctx.input ?? null };
    try {
      const { result, replayed } = await idempotent(store, { scope, owner: ctx.caller?.id ?? "", key: raw, request }, async () => {
        const out = await handler(req, ctx);
        if (!out || !Number.isInteger(out.status) || out.status < 200 || out.status > 599) throw new TypeError("withIdempotency: handler must return { status, body }");
        if (out.status >= 500) throw Object.assign(new Error("handler-failed"), { reply: out }); // not stored: a retry runs again
        return { status: out.status, body: out.body ?? null };
      });
      return sendJson(res, result.status, result.body, replayed ? { "idempotent-replayed": "true" } : {});
    } catch (e) {
      if (e instanceof IdempotencyError) return sendJson(res, e.status, { error: e.code });
      if (e && e.reply) return sendJson(res, e.reply.status, e.reply.body ?? null);
      throw e;
    }
  };
  return wrapped;
}

/**
 * A job handler (SM-05's `(payload, ctx)`) keyed by `keyOf(payload)` (default `payload.idempotencyKey`), so a replayed
 * or re-enqueued job runs its effect once. A job without a valid key fails (and SM-05 dead-letters it).
 */
export function idempotentJob(store, scope, handler, { keyOf = (p) => p?.idempotencyKey } = {}) {
  checkArgs(store, scope);
  if (typeof handler !== "function") throw new TypeError("idempotentJob: handler must be a function");
  return async (payload, ctx) => {
    const { result } = await idempotent(store, { scope, key: keyOf(payload), request: payload }, () => handler(payload, ctx));
    return result;
  };
}

// SM-07 add-on tests (docs/modules/S3.md, "S3-c1 SM-07 build notes").
// SM-07-L1: create endpoints and job handlers accept an idempotency key and store it with a unique constraint; a
// double submit and a replayed job cause no duplicate effect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import {
  idempotent, withIdempotency, idempotentJob, memoryStore, sqlStore, requestHash, IdempotencyError, IDEMPOTENCY_SQL,
} from "../src/idempotency.mjs";

const config = { server: { sha: "test", port: 0, host: "127.0.0.1" } };
const quiet = { write() {} };

async function serve(routes) {
  const app = createApp({ config, routes, out: quiet });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.address().port}`;
  return { base, close: () => new Promise((r) => app.close(r)) };
}

const post = (base, path, { key, body } = {}) => fetch(base + path, {
  method: "POST",
  headers: { "content-type": "application/json", ...(key === undefined ? {} : { "idempotency-key": key }) },
  body: JSON.stringify(body ?? {}),
});

// A create route over the core router: the handler is the only effect, and counts its runs.
function orders(store) {
  const created = [];
  let gate = null;
  const route = withIdempotency(store, "orders.create", async (req, ctx) => {
    if (gate) await gate;
    created.push(ctx.input.body);
    return { status: 201, body: { id: `o${created.length}`, item: ctx.input.body.item } };
  });
  // SM-01's validated() would set ctx.input; this test reads the body itself so the add-on is tested alone.
  const withInput = async (req, res, ctx) => {
    let raw = "";
    for await (const c of req) raw += c;
    return route(req, res, { ...ctx, input: { body: JSON.parse(raw || "{}") } });
  };
  return { created, routes: { "POST /orders": withInput }, hold: (p) => { gate = p; } };
}

test("SM-07-L1 create route: a double submit creates once and replays the first answer", async () => {
  const o = orders(memoryStore());
  const s = await serve(o.routes);
  try {
    const a = await post(s.base, "/orders", { key: "k-1", body: { item: "book" } });
    assert.equal(a.status, 201);
    assert.deepEqual(await a.json(), { id: "o1", item: "book" });
    assert.equal(a.headers.get("idempotent-replayed"), null);
    const b = await post(s.base, "/orders", { key: "k-1", body: { item: "book" } });
    assert.equal(b.status, 201);
    assert.deepEqual(await b.json(), { id: "o1", item: "book" }, "the replay is the first answer");
    assert.equal(b.headers.get("idempotent-replayed"), "true");
    assert.equal(o.created.length, 1, "no duplicate effect");
    const c = await post(s.base, "/orders", { key: "k-2", body: { item: "book" } });
    assert.deepEqual(await c.json(), { id: "o2", item: "book" }, "a new key is a new create");
  } finally { await s.close(); }
});

test("SM-07-L1 create route: missing, malformed or repeated keys are refused before the handler runs", async () => {
  const o = orders(memoryStore());
  const s = await serve(o.routes);
  try {
    const none = await post(s.base, "/orders", { body: { item: "x" } });
    assert.equal(none.status, 400);
    assert.deepEqual(await none.json(), { error: "idempotency-key-required" });
    for (const bad of ["has space", "x".repeat(201), "semi;colon"]) {
      const r = await post(s.base, "/orders", { key: bad, body: { item: "x" } });
      assert.equal(r.status, 400, bad);
      assert.deepEqual(await r.json(), { error: "idempotency-key-invalid" });
    }
    assert.equal(o.created.length, 0);
  } finally { await s.close(); }
});

test("SM-07 create route: the same key with another request is 422, and a key in flight is 409", async () => {
  const o = orders(memoryStore());
  const s = await serve(o.routes);
  try {
    await post(s.base, "/orders", { key: "k-1", body: { item: "book" } });
    const other = await post(s.base, "/orders", { key: "k-1", body: { item: "lamp" } });
    assert.equal(other.status, 422);
    assert.deepEqual(await other.json(), { error: "idempotency-key-reused" });

    let open;
    o.hold(new Promise((r) => { open = r; }));
    const first = post(s.base, "/orders", { key: "k-9", body: { item: "pen" } });
    await new Promise((r) => setTimeout(r, 50));
    const second = await post(s.base, "/orders", { key: "k-9", body: { item: "pen" } });
    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), { error: "idempotency-key-in-progress" });
    open();
    assert.equal((await first).status, 201);
    assert.equal(o.created.length, 2, "book once, pen once");
  } finally { await s.close(); }
});

test("SM-07 create route: a failed handler (throw or 5xx) frees the key, so a retry runs again", async () => {
  const store = memoryStore();
  let runs = 0;
  const route = withIdempotency(store, "pay", async () => {
    runs++;
    if (runs === 1) throw new Error("db down");
    if (runs === 2) return { status: 503, body: { error: "busy" } };
    return { status: 200, body: { ok: true } };
  });
  const s = await serve({ "POST /pay": route });
  try {
    assert.equal((await post(s.base, "/pay", { key: "p-1" })).status, 500);
    const busy = await post(s.base, "/pay", { key: "p-1" });
    assert.equal(busy.status, 503);
    assert.deepEqual(await busy.json(), { error: "busy" });
    assert.equal((await post(s.base, "/pay", { key: "p-1" })).status, 200);
    const replay = await post(s.base, "/pay", { key: "p-1" });
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    assert.equal(runs, 3);
  } finally { await s.close(); }
});

test("SM-07-L1 job handler: a replayed job runs its effect once; a job without a key fails", async () => {
  const store = memoryStore();
  const sent = [];
  const handler = idempotentJob(store, "email.welcome", async (payload) => { sent.push(payload.to); return { sent: payload.to }; });
  const job = { idempotencyKey: "user-42-welcome", to: "a@example.test" };
  assert.deepEqual(await handler(job, {}), { sent: "a@example.test" });
  assert.deepEqual(await handler({ ...job }, {}), { sent: "a@example.test" }, "a replay returns the stored result");
  assert.deepEqual(sent, ["a@example.test"]);
  await assert.rejects(handler({ to: "b@example.test" }, {}), (e) => e instanceof IdempotencyError && e.code === "idempotency-key-invalid");
  await assert.rejects(handler({ ...job, to: "c@example.test" }, {}), (e) => e.code === "idempotency-key-reused");
  assert.deepEqual(sent, ["a@example.test"]);
});

test("SM-07 idempotent(): parallel callers run the effect once; set-up mistakes are refused", async () => {
  const store = memoryStore();
  let runs = 0;
  const fn = async () => { runs++; await new Promise((r) => setTimeout(r, 20)); return { n: runs }; };
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => idempotent(store, { scope: "s", key: "k", request: { a: 1 } }, fn)));
  assert.equal(runs, 1);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "idempotency-key-in-progress"));
  assert.equal(requestHash({ a: 1, b: [1, { c: 2, d: 3 }] }), requestHash({ b: [1, { d: 3, c: 2 }], a: 1 }), "key order does not change the request");
  assert.notEqual(requestHash({ a: 1 }), requestHash({ a: 2 }));
  assert.throws(() => withIdempotency({}, "s", () => {}), /store/);
  assert.throws(() => withIdempotency(store, "Bad Scope", () => {}), /scope/);
  assert.throws(() => idempotentJob(store, "s", null), /handler/);
});

// The SQL store against a small emulation of the four statements it sends: the table is a Map keyed by (scope, key),
// as the primary key makes it. The statements and the table are checked as text, so the app's real database gets
// exactly these (the app's own test runs them on its database).
function fakePg() {
  const rows = new Map();
  const log = [];
  const id = (p) => JSON.stringify([p[0], p[1]]);
  const query = async (text, p) => {
    log.push(text);
    if (text.startsWith("INSERT INTO idempotency_key") && text.includes("ON CONFLICT (scope, key) DO NOTHING RETURNING key")) {
      if (rows.has(id(p))) return { rows: [] };
      rows.set(id(p), { request_hash: p[2], state: "running", result: null });
      return { rows: [{ key: p[1] }] };
    }
    if (text.startsWith("SELECT request_hash, state, result FROM idempotency_key WHERE scope = $1 AND key = $2")) {
      const r = rows.get(id(p));
      return { rows: r ? [{ ...r }] : [] };
    }
    if (text.startsWith("UPDATE idempotency_key SET state = 'done'") && text.endsWith("AND state = 'running'")) {
      const r = rows.get(id(p));
      if (r && r.state === "running") Object.assign(r, { state: "done", result: JSON.parse(p[2]) });
      return { rows: [] };
    }
    if (text.startsWith("DELETE FROM idempotency_key WHERE scope = $1 AND key = $2 AND state = 'running'")) {
      if (rows.get(id(p))?.state === "running") rows.delete(id(p));
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${text}`);
  };
  return { query, rows, log };
}

test("SM-07-L1 SQL store: the key is stored under a (scope, key) primary key; claim, replay, release", async () => {
  assert.match(IDEMPOTENCY_SQL, /PRIMARY KEY \(scope, key\)/, "the unique constraint");
  assert.match(IDEMPOTENCY_SQL, /CHECK \(state IN \('running', 'done'\)\)/);
  const pg = fakePg();
  const store = sqlStore(pg.query);
  let runs = 0;
  const run = (request) => idempotent(store, { scope: "orders.create", key: "k-1", request }, async () => ({ id: ++runs }));
  assert.deepEqual(await run({ item: "a" }), { result: { id: 1 }, replayed: false });
  assert.deepEqual(await run({ item: "a" }), { result: { id: 1 }, replayed: true });
  await assert.rejects(run({ item: "b" }), (e) => e.code === "idempotency-key-reused");
  assert.equal(runs, 1);
  await assert.rejects(idempotent(store, { scope: "orders.create", key: "k-2", request: {} }, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(pg.rows.has(JSON.stringify(["orders.create", "k-2"])), false, "a failed effect releases its key");
  assert.deepEqual(await idempotent(store, { scope: "orders.create", key: "k-2", request: {} }, async () => ({ ok: true })), { result: { ok: true }, replayed: false });
  assert.throws(() => sqlStore(null), /query/);
});

test("SM-07 SQL store: a row released between INSERT and SELECT is claimed again; endless contention is a 409", async () => {
  let selects = 0;
  const flaky = async (text, p) => {
    if (text.startsWith("INSERT")) return { rows: selects >= 1 ? [{ key: p[1] }] : [] };
    if (text.startsWith("SELECT")) { selects++; return { rows: [] }; }
    return { rows: [] };
  };
  assert.deepEqual(await sqlStore(flaky).claim("s", "k", "h"), { state: "new" });
  const never = async (text) => ({ rows: [] });
  await assert.rejects(sqlStore(never).claim("s", "k", "h"), (e) => e.code === "idempotency-claim-contended" && e.status === 409);
});

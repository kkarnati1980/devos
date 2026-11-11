// M2.6-a AT4/AT5 (client part): timeouts, retries for reads only, rate-limit pause, no key in errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LinearClient, LinearError, withMarker, readMarker, stripMarkers } from "../dist/index.js";

const KEY = "lin_api_" + "Zq9fake0000000000000000000000000000000";
const res = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function client(responses, extra = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(init) : r;
  };
  const sleeps = [];
  const c = new LinearClient({ apiKey: () => KEY, fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, ...extra });
  return { c, calls, sleeps };
}

test("a query sends the key in the authorization header and a timeout signal", async () => {
  const { c, calls } = client([res(200, { data: { viewer: { id: "u1" } } })]);
  assert.deepEqual(await c.query("query { viewer { id } }"), { viewer: { id: "u1" } });
  assert.equal(calls[0].url, "https://api.linear.app/graphql");
  assert.equal(calls[0].init.headers.authorization, KEY);
  assert.ok(calls[0].init.signal instanceof AbortSignal, "every call carries a timeout signal");
});

test("reads are retried on network errors, 429 and 5xx with backoff; at most 3 attempts", async () => {
  const net = Object.assign(new Error("boom"), { name: "TypeError" });
  const { c, calls, sleeps } = client([net, res(503, {}), res(200, { data: { ok: true } })]);
  assert.deepEqual(await c.query("query { ok }"), { ok: true });
  assert.equal(calls.length, 3); assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1] >= sleeps[0] / 2, "backoff grows");
  const t = client([res(429, {}, { "retry-after": "2" }), res(500, {}), res(502, {})]);
  await assert.rejects(t.c.query("query { ok }"), (e) => e instanceof LinearError && e.status === 502);
  assert.equal(t.calls.length, 3); assert.ok(t.sleeps[0] >= 2000, "Retry-After is honoured");
});

test("mutations are never retried; 4xx and GraphQL errors are not retried", async () => {
  const m = client([res(503, {}), res(200, { data: {} })]);
  await assert.rejects(m.c.mutate("mutation { x }"), (e) => e.status === 503);
  assert.equal(m.calls.length, 1);
  const q = client([res(400, {}), res(200, { data: {} })]);
  await assert.rejects(q.c.query("query { x }"), (e) => e.status === 400);
  assert.equal(q.calls.length, 1);
  const g = client([res(200, { errors: [{ message: `bad ${KEY}`, extensions: { code: "INVALID_INPUT" } }] })]);
  await assert.rejects(g.c.query("query { x }"), (e) => e.code === "graphql" && !e.message.includes(KEY) && !e.message.includes("bad"));
});

test("a timeout is a LinearError('timeout') and is retried for reads", async () => {
  const to = Object.assign(new Error("t"), { name: "TimeoutError" });
  const { c, calls } = client([to, to, to]);
  await assert.rejects(c.query("query { x }"), (e) => e.code === "timeout");
  assert.equal(calls.length, 3);
});

test("low rate-limit headroom pauses further calls until the reset time", async () => {
  let now = 1_000_000;
  const { c, calls } = client([res(200, { data: { a: 1 } }, { "x-ratelimit-requests-remaining": "10", "x-ratelimit-requests-reset": String(now + 30_000) }), res(200, { data: { a: 2 } })], { now: () => now });
  await c.query("query { a }");
  await assert.rejects(c.query("query { a }"), (e) => e.code === "rate-limited" && e.retryAfterMs === 30_000);
  assert.equal(calls.length, 1, "no call while paused");
  now += 30_001;
  assert.deepEqual(await c.query("query { a }"), { a: 2 });
});

test("AT5: the key never appears in any error message", async () => {
  for (const r of [res(401, { message: KEY }), res(200, { errors: [{ message: KEY }] }), new Error(KEY)]) {
    const { c } = client([r], { maxAttempts: 1 });
    await assert.rejects(c.query("query { x }"), (e) => !String(e.message).includes(KEY) && !String(e.stack).includes(KEY));
  }
});

test("markers: written once, read back by kind, other text ignored", () => {
  const id = "0b9f6c1e-2c1a-4d8e-9f00-1234567890ab";
  const t = withMarker("Contract: docs/modules/M2.6.md", "module", id);
  assert.equal(readMarker(t, "module"), id);
  assert.equal(readMarker(t, "task"), null);
  assert.equal(withMarker(t, "module", id), t, "idempotent");
  assert.equal(stripMarkers(t), "Contract: docs/modules/M2.6.md");
  assert.equal(readMarker("devos-ref: module/not-a-uuid-at-all-xxxxxxxxxxxxxxxxxxxxx", "module"), null);
  assert.throws(() => withMarker("x", "task", "1; drop"), /not a uuid/);
});

test("a rate-limit error on a 4xx is retried as 429; Retry-After is capped; a vault failure is not a network error", async () => {
  const rl = res(400, { errors: [{ message: "x", extensions: { code: "RATELIMITED" } }] }, { "retry-after": "3600" });
  const { c, calls, sleeps } = client([rl, res(200, { data: { ok: 1 } })]);
  assert.deepEqual(await c.query("query { ok }"), { ok: 1 });
  assert.equal(calls.length, 2); assert.ok(sleeps[0] <= 60_000);
  const v = new LinearClient({ apiKey: () => { throw new Error(KEY); }, fetchImpl: async () => res(200, { data: {} }), sleep: async () => {} });
  await assert.rejects(v.query("query { x }"), (e) => e.code === "bad-response" && !e.message.includes(KEY));
});

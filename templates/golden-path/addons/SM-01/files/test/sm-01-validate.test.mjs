// SM-01 add-on tests. SM-01-L1: each route validates body, query and params against a schema; contract tests send
// invalid payloads and get 4xx, and the handler (the only path to the database) is never reached.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import http from "node:http";
import { validate, validated, invalidCases, assertAllValidated } from "../src/validate.mjs";

const NOTE = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 80 },
    priority: { type: "integer", min: 1, max: 5 },
    tags: { type: "array", items: { type: "string", maxLength: 20 }, maxItems: 5 },
    status: { type: "string", enum: ["open", "done"] },
    pinned: { type: "boolean" },
  },
  required: ["title", "priority"],
};
const LIST = { type: "object", properties: { page: { type: "integer", min: 1, max: 1000 }, q: { type: "string", maxLength: 50 } } };
const VALID = { title: "Buy milk", priority: 2, tags: ["home"], status: "open", pinned: false };

async function withRoutes(routes, fn) {
  const out = { write: () => {} };
  const app = createApp({ config: loadConfig({ GIT_SHA: "abc1234" }), out, routes });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${app.address().port}`); } finally { app.close(); }
}

function noteRoutes(reached) {
  return {
    "POST /notes": validated({ body: NOTE }, (req, res, ctx) => { reached.push(ctx.input.body); res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); }),
    "GET /notes": validated({ query: LIST }, (req, res, ctx) => { reached.push(ctx.input.query); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(ctx.input.query)); }),
  };
}

const post = (base, body, headers = { "content-type": "application/json" }) =>
  fetch(`${base}/notes`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

test("SM-01-L1: contract tests: every invalid body generated from the schema gets 400 and never reaches the handler", async () => {
  const reached = [];
  const cases = invalidCases(NOTE, VALID);
  assert.ok(cases.length >= 15, `cases: ${cases.length}`);
  await withRoutes(noteRoutes(reached), async (base) => {
    for (const c of cases) {
      const r = await post(base, c.value);
      assert.equal(r.status, 400, c.name);
      const j = await r.json();
      assert.equal(j.error, "invalid-input", c.name);
      assert.ok(j.details.length > 0 && j.details.every((d) => d.in === "body"), c.name);
    }
    assert.equal(reached.length, 0, "the handler never ran");
    const ok = await post(base, VALID);
    assert.equal(ok.status, 201);
    assert.deepEqual(reached, [VALID]);
  });
});

test("SM-01-L1: the query is validated too (types coerced from text), and an unexpected body or query is refused", async () => {
  const reached = [];
  await withRoutes(noteRoutes(reached), async (base) => {
    for (const q of ["page=0", "page=abc", "page=1.5", "page=1&page=2", "q=" + "x".repeat(51), "other=1"]) {
      const r = await fetch(`${base}/notes?${q}`);
      assert.equal(r.status, 400, q);
      assert.ok((await r.json()).details.every((d) => d.in === "query"), q);
    }
    assert.equal((await fetch(`${base}/notes`)).status, 200, "no query and no body is fine");
    const ok = await fetch(`${base}/notes?page=3&q=milk`);
    assert.deepEqual(await ok.json(), { page: 3, q: "milk" });
    // A route with no query schema refuses any query.
    assert.equal((await post(base, VALID)).status, 201);
    const withQuery = await fetch(`${base}/notes?x=1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(VALID) });
    assert.equal(withQuery.status, 400);
    assert.equal(reached.length, 3);
  });
});

test("SM-01-L1: route params from the router are validated (ctx.params)", async () => {
  const reached = [];
  const h = validated({ params: { type: "object", properties: { id: { type: "string", pattern: /^[0-9a-f]{8}$/ } }, required: ["id"] } }, (req, res, ctx) => { reached.push(ctx.input.params); res.end("ok"); });
  const run = (params) => new Promise((resolve) => {
    const res = { headersSent: false, status: 200, writeHead(c) { this.status = c; this.headersSent = true; }, end(b) { resolve({ status: this.status, body: String(b) }); } };
    const req = { headers: {}, url: "/x", on(ev, f) { if (ev === "end") setImmediate(f); }, destroy() {} };
    h(req, res, { params });
  });
  assert.equal((await run({ id: "../../etc" })).status, 400);
  assert.equal((await run({})).status, 400);
  assert.equal((await run({ id: "deadbeef" })).status, 200);
  assert.deepEqual(reached, [{ id: "deadbeef" }]);
});

test("SM-01-L1: malformed bodies get 4xx: not JSON (400), wrong content type (415), too large (413)", async () => {
  const reached = [];
  await withRoutes(noteRoutes(reached), async (base) => {
    assert.equal((await post(base, "{not json")).status, 400);
    assert.equal((await post(base, JSON.stringify(VALID), { "content-type": "text/plain" })).status, 415);
    assert.equal((await post(base, { ...VALID, title: "x".repeat(200_000) })).status, 413);
    assert.equal((await post(base, '{"title":"a","priority":1,"__proto__":{"admin":true}}')).status, 400, "__proto__ is an unknown field");
    for (const q of ["__proto__=a", "__proto__=a&__proto__=b", "constructor=x"]) {
      assert.equal((await fetch(`${base}/notes?${q}`)).status, 400, `GET ?${q}`);
      assert.equal((await fetch(`${base}/notes?${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(VALID) })).status, 400, `POST ?${q}`);
    }
    // A chunked body over the limit gets a 413 answer, not a connection reset.
    const status = await new Promise((resolve, reject) => {
      const u = new URL(`${base}/notes`);
      const r = http.request({ host: u.hostname, port: u.port, path: "/notes", method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }, (res) => { res.resume(); resolve(res.statusCode); });
      r.on("error", reject);
      const chunk = "x".repeat(16_000);
      let n = 0;
      const pump = () => { while (n < 25) { n++; if (!r.write(chunk)) return r.once("drain", pump); } r.end(); };
      pump();
    });
    assert.equal(status, 413);
    assert.equal(reached.length, 0);
  });
});

test("SM-01-L1: error messages name the field and rule, never echo the value sent", () => {
  const errs = validate(NOTE, { title: "<script>alert(1)</script>".repeat(10), priority: 9, extra: 1, "<img src=x onerror=alert(1)>": 1 });
  const text = JSON.stringify(errs);
  assert.ok(!text.includes("<script>"));
  assert.ok(!text.includes("<img"));
  assert.deepEqual(errs.map((e) => e.path).sort(), ["(root)", "(root)", "priority", "title"]);
  assert.throws(() => validate({ type: "nope" }, 1), /unknown schema type/);
  // Schema mistakes fail when the route is set up, not on the first request.
  assert.throws(() => validated({ body: { type: "object", properties: { tags: { type: "array" } } } }, () => {}), /list without items/);
  assert.throws(() => validated({ query: { type: "object", properties: { n: { type: "strng" } } } }, () => {}), /bad schema/);
  assert.throws(() => invalidCases(NOTE, { title: "" }), /not valid/);
});

test("SM-01-L1: an over-long value never reaches the pattern (no ReDoS); +json bodies are JSON; every route is wrapped", async () => {
  const evil = { type: "string", maxLength: 10, pattern: /^(a+)+$/ };
  const t0 = Date.now();
  assert.equal(validate(evil, "a".repeat(40) + "!").length, 1);
  assert.ok(Date.now() - t0 < 200, "the pattern did not run on the over-long value");
  const reached = [];
  const routes = { "PATCH /notes": validated({ body: { type: "object", properties: { title: { type: "string", maxLength: 80 } } } }, (req, res) => { reached.push(1); res.end("{}"); }) };
  await withRoutes(routes, async (base) => {
    const r = await fetch(`${base}/notes`, { method: "PATCH", headers: { "content-type": "application/merge-patch+json" }, body: JSON.stringify({ title: "x" }) });
    assert.equal(r.status, 200);
    assert.equal((await fetch(`${base}/notes`, { method: "PATCH", headers: { "content-type": "text/json+evil" }, body: "{}" })).status, 415);
  });
  assert.equal(reached.length, 1);
  assert.doesNotThrow(() => assertAllValidated({ ...noteRoutes([]), ...routes }));
  assert.throws(() => assertAllValidated({ ...routes, "DELETE /notes": async () => {} }), /DELETE \/notes/);
  assert.throws(() => validated({ body: { type: "object", properties: {}, required: ["titel"] } }, () => {}), /required "titel"/);
});

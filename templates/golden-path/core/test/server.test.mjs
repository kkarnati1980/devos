// Core server: /health, /ready, deny by default, JSON logs with a request ID; F1 client config allow-list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";

async function withApp(opts, fn) {
  const lines = []; const out = { write: (s) => lines.push(JSON.parse(s)) };
  const app = createApp({ config: loadConfig({ GIT_SHA: "abc1234" }), out, ...opts });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${app.address().port}`, lines); } finally { app.close(); }
}

test("/health answers with the SHA; unknown paths are 404; logs are JSON with a request ID", async () => {
  await withApp({}, async (base, lines) => {
    const h = await fetch(`${base}/health`, { headers: { "x-request-id": "req-12345678" } });
    assert.equal(h.status, 200); assert.deepEqual(await h.json(), { status: "ok", sha: "abc1234" });
    assert.equal(h.headers.get("x-request-id"), "req-12345678");
    const n = await fetch(`${base}/admin`, { method: "POST", headers: { "x-request-id": "bad id <script>" } });
    assert.equal(n.status, 404);
    assert.match(n.headers.get("x-request-id"), /^[0-9a-f-]{36}$/, "an unsafe incoming id is replaced");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(lines[0].requestId, "req-12345678"); assert.equal(lines[0].status, 200);
    assert.equal(lines[1].status, 404); assert.notEqual(lines[1].requestId, "bad id <script>");
  });
});

test("/ready is 503 with the failing check's name, 200 when all pass", async () => {
  let dbUp = false;
  await withApp({ readyChecks: [{ name: "db", check: async () => dbUp }, { name: "cache", check: async () => { throw new Error("x"); } }] }, async (base) => {
    const r = await fetch(`${base}/ready`);
    assert.equal(r.status, 503); assert.deepEqual((await r.json()).failed, ["db", "cache"]);
  });
  dbUp = true;
  await withApp({ readyChecks: [{ name: "db", check: async () => dbUp }] }, async (base) => {
    assert.equal((await fetch(`${base}/ready`)).status, 200);
  });
});

test("F1: clientConfig returns only allow-listed keys; a secret-shaped key stops start-up", () => {
  const c = loadConfig({ PUBLIC_APP_NAME: "Demo", DATABASE_URL: "postgres://x", API_TOKEN: "t" }, ["PUBLIC_APP_NAME"]);
  assert.deepEqual(c.clientConfig(), { PUBLIC_APP_NAME: "Demo" });
  assert.throws(() => loadConfig({}, ["PUBLIC_API_TOKEN"]), /secret-shaped key/);
  assert.throws(() => loadConfig({}, ["STRIPE_SECRET"]), /secret-shaped key/);
  assert.throws(() => loadConfig({ PORT: "99999" }), /PORT/);
});

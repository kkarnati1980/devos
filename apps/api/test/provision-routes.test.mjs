// DEVOS-225 (M2.4-d2, docs/modules/M2.4.md "M2.4-d2 decisions"): GET/POST /projects/{id}/provision on a real socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../dist/app.js";
import { KkSessionRegistry } from "../dist/auth.js";
import { loadConfig } from "../dist/config.js";
import { errorCode, stepViews } from "../dist/provision-routes.js";

const KK = "kk@example.com";
const ORIGIN = "http://devos:3000";
const ENV = { DEVOS_KK_LOGIN: KK, DEVOS_SESSION_KEY: "test-only-session-key-0123456789abcdef", DEVOS_ALLOWED_ORIGINS: ORIGIN };
const P1 = "4b7d1c1e-2f6a-4a8e-9d55-0c1f2a3b4c5d";
const P2 = "5b7d1c1e-2f6a-4a8e-9d55-0c1f2a3b4c5d";
const at = new Date("2026-11-16T00:00:00Z");
const row = (key, status = "done", lastError = null) => ({ key, provider: key.split("/")[0], kind: "k", status, attempts: 1, lastError, updatedAt: at });

async function start({ configured = true } = {}) {
  const projects = new Map([[P1, { id: P1, stage: "provisioning" }], [P2, { id: P2, stage: "building" }]]);
  const audits = [];
  const parked = new Set([P1]);
  const retried = [];
  const reader = {
    project: async (id) => projects.get(id) ?? null,
    projectBySlug: async (slug) => (slug === "shop" ? projects.get(P1) : null),
    steps: async () => [
      row("vault/app_secret/preview/SESSION_SECRET", "pending"),
      row("coolify/port/preview"),
      row("github/core"),
      row("github/repo", "failed", "name_conflict: github repo \"devos-shop\" exists; provider said token=ghp_secret"),
      row("coolify/project"),
    ],
    recordRetry: async (id) => { if (projects.get(id)?.stage !== "provisioning") return false; audits.push(id); return true; },
  };
  const sweep = { retry: (id) => { retried.push(id); parked.delete(id); }, isParked: (id) => parked.has(id) };
  const app = await createApp({
    config: loadConfig(ENV),
    identity: { async whois() { return { login: KK, node: "kk-laptop" }; } },
    grants: null,
    log: () => {},
    kkSessions: new KkSessionRegistry(),
    provision: configured ? { reader, sweep } : undefined,
  });
  await app.listen(0, "127.0.0.1");
  return { app, port: app.getHttpServer().address().port, audits, retried, projects };
}

function call(port, method, path, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, agent: false, headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => { let json; try { json = text ? JSON.parse(text) : undefined; } catch {} resolve({ status: res.statusCode, headers: res.headers, json, text }); });
    });
    req.on("error", reject);
    req.end();
  });
}

async function signIn(port) {
  const r = await call(port, "POST", "/auth/session", { headers: { origin: ORIGIN } });
  assert.equal(r.status, 201);
  return { origin: ORIGIN, cookie: r.headers["set-cookie"][0].split(";")[0], "x-devos-csrf": r.json.csrfToken };
}

test("d2 GET: session required; steps in run order with only the fixed code; parked flag; 400/404", async () => {
  const { app, port } = await start();
  try {
    assert.equal((await call(port, "GET", `/projects/${P1}/provision`)).status, 401);
    const h = await signIn(port);
    const g = await call(port, "GET", `/projects/${P1}/provision`, { headers: { cookie: h.cookie } });
    assert.equal(g.status, 200);
    assert.equal(g.json.stage, "provisioning");
    assert.equal(g.json.parked, true);
    assert.deepEqual(g.json.steps.map((s) => s.key), ["github/repo", "github/core", "coolify/project", "coolify/port/preview", "vault/app_secret/preview/SESSION_SECRET"]);
    assert.equal(g.json.steps[0].code, "name_conflict");
    assert.ok(!g.text.includes("ghp_secret") && !g.text.includes("devos-shop"), "the provider message never leaves the API");
    assert.ok(!("externalId" in g.json.steps[0]) && !("lastError" in g.json.steps[0]));
    assert.equal(g.json.projectId, P1);
    const bySlug = await call(port, "GET", "/projects/by-slug/shop/provision", { headers: { cookie: h.cookie } });
    assert.equal(bySlug.status, 200);
    assert.deepEqual(bySlug.json, g.json, "the slug view is the same document");
    assert.equal((await call(port, "GET", "/projects/by-slug/other/provision", { headers: { cookie: h.cookie } })).status, 404);
    assert.equal((await call(port, "GET", "/projects/by-slug/Bad_Slug/provision", { headers: { cookie: h.cookie } })).status, 400);
    assert.equal((await call(port, "GET", `/projects/nope/provision`, { headers: { cookie: h.cookie } })).status, 400);
    assert.equal((await call(port, "GET", `/projects/6b7d1c1e-2f6a-4a8e-9d55-0c1f2a3b4c5d/provision`, { headers: { cookie: h.cookie } })).status, 404);
  } finally { await app.close(); }
});

test("d2 POST (AT11 CSRF half): refused without CSRF; un-parks with an audit row; 409 outside provisioning", async () => {
  const { app, port, audits, retried } = await start();
  try {
    const h = await signIn(port);
    const noCsrf = await call(port, "POST", `/projects/${P1}/provision`, { headers: { origin: ORIGIN, cookie: h.cookie } });
    assert.equal(noCsrf.status, 403);
    assert.deepEqual(retried, [], "a refused POST changes nothing");
    const ok = await call(port, "POST", `/projects/${P1}/provision`, { headers: h });
    assert.equal(ok.status, 202);
    assert.deepEqual(ok.json, { queued: true });
    assert.deepEqual(retried, [P1]);
    assert.deepEqual(audits, [P1]);
    const g = await call(port, "GET", `/projects/${P1}/provision`, { headers: { cookie: h.cookie } });
    assert.equal(g.json.parked, false);
    const wrong = await call(port, "POST", `/projects/${P2}/provision`, { headers: h });
    assert.equal(wrong.status, 409);
    assert.ok(wrong.text.includes("project-not-provisioning"));
    assert.deepEqual(retried, [P1]);
  } finally { await app.close(); }
});

test("d2: 503 provision-not-configured without the sweep", async () => {
  const { app, port } = await start({ configured: false });
  try {
    const h = await signIn(port);
    const g = await call(port, "GET", `/projects/${P1}/provision`, { headers: { cookie: h.cookie } });
    assert.equal(g.status, 503);
    assert.ok(g.text.includes("provision-not-configured"));
    assert.equal((await call(port, "POST", `/projects/${P1}/provision`, { headers: h })).status, 503);
  } finally { await app.close(); }
});

test("d2: errorCode keeps only a code-shaped head; stepViews puts unknown keys last", () => {
  assert.equal(errorCode(null), null);
  assert.equal(errorCode("policy_denied"), "policy_denied");
  assert.equal(errorCode("provider_error: github POST /user/repos 500"), "provider_error");
  assert.equal(errorCode("Some Text with a token ghp_x: more"), "error");
  const v = stepViews([row("zzz/other"), row("github/repo")]);
  assert.deepEqual(v.map((s) => s.key), ["github/repo", "zzz/other"]);
  assert.equal(v[0].updatedAt, at.toISOString());
});

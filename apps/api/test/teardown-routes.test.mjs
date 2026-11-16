// DEVOS-244 (M2.5-b1, docs/modules/M2.5.md "M2.5-b1 decisions"): archive, restore and the teardown state on a real
// socket. AT2 runs through the routes on M2.4's fake providers with the real @devos/teardown runners; AT9's route half
// (403 without CSRF) and a non-KK caller are refused with nothing changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { allowAll, GitHubClient, CoolifyClient, githubRepoStep, coolifyProjectStep, runProvision, githubRepoOps, coolifyProjectOps } from "@devos/provision";
import { archiveProject, restoreProject, MemoryTeardownStore, TeardownError } from "@devos/teardown";
import { createApp } from "../dist/app.js";
import { KkSessionRegistry } from "../dist/auth.js";
import { loadConfig } from "../dist/config.js";
import { TeardownController, teardownFailure, scanView, activeCounts, TEARDOWN_ROUTE_TIMEOUT_MS } from "../dist/teardown-routes.js";
import { kkAuthorizer } from "../dist/teardown-runtime.js";
import { fakeProviders } from "../../../packages/provision/test/fakes.mjs";

const KK = "kk@example.com";
const ORIGIN = "http://devos:3000";
const ENV = { DEVOS_KK_LOGIN: KK, DEVOS_SESSION_KEY: "test-only-session-key-0123456789abcdef", DEVOS_ALLOWED_ORIGINS: ORIGIN };
const TOKEN = "ghp_TESTONLY_not_a_real_token_0123456789";
const P = { id: "11111111-2222-4333-8444-555555555555", slug: "acme", name: "Acme app" };
const DAY = 86_400_000;

/** M2.4's fakes plus the repo PATCH that Archive and Restore send; every call is recorded. */
function fakes() {
  const base = fakeProviders();
  const calls = [];
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push({ method, path: u.pathname });
    const m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/);
    if (u.origin === "https://api.github.com" && m && method === "PATCH") {
      const r = base.repos.get(`${m[1]}/${m[2]}`.toLowerCase());
      if (!r) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      Object.assign(r, JSON.parse(init.body));
      return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
    }
    return base.fetchImpl(url, init);
  }
  return { ...base, fetchImpl, calls };
}

async function start({ policy = "allow", actions: override, configured = true, login = KK, days = 30 } = {}) {
  const fake = fakes();
  const sleep = async () => {};
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep });
  const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep });
  const store = new MemoryTeardownStore();
  store.addProject({ id: P.id, slug: P.slug, stage: "live" });
  await runProvision(P.id, [githubRepoStep(gh, P, "kkarnati1980"), coolifyProjectStep(cf, P)], { store, authorize: allowAll });
  const decisions = [];
  const engine = { decide: async (r) => (decisions.push(r), { enforcedOutcome: policy }) };
  const ops = [githubRepoOps(gh, P.id), coolifyProjectOps(cf, P.id)];
  const actions = override ?? {
    archive: (session, id, windowDays) => archiveProject(id, { store, ops, authorize: kkAuthorizer(engine, session, id), windowDays }),
    restore: (session, id) => restoreProject(id, { store, ops, authorize: kkAuthorizer(engine, session, id) }),
  };
  const row = async (id) => {
    const p = await store.project(id);
    return p ? { id: p.id, slug: p.slug, stage: p.stage, archivedAt: p.archivedAt, purgeAfter: p.purgeAfter } : null;
  };
  const reader = {
    project: row,
    projectBySlug: async (slug) => (slug === P.slug ? row(P.id) : null),
    activeResources: (id) => store.activeResources(id),
    lastScan: async () => store.scans.at(-1) ?? null,
    archiveDays: async () => days,
  };
  const app = await createApp({
    config: loadConfig(ENV),
    identity: { async whois() { return { login, node: "kk-laptop" }; } },
    grants: null,
    log: () => {},
    kkSessions: new KkSessionRegistry(),
    teardown: configured ? { reader, actions } : undefined,
  });
  await app.listen(0, "127.0.0.1");
  return { app, port: app.getHttpServer().address().port, fake, store, decisions };
}

function call(port, method, path, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, agent: false, headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => { let json; try { json = text ? JSON.parse(text) : undefined; } catch {} resolve({ status: res.statusCode, json, text }); });
    });
    req.on("error", reject);
    req.end();
  });
}

// Signs in and returns the cookie and CSRF headers (call() does not return response headers).
async function session(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/auth/session", agent: false, headers: { origin: ORIGIN } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        assert.equal(res.statusCode, 201);
        resolve({ origin: ORIGIN, cookie: res.headers["set-cookie"][0].split(";")[0], "x-devos-csrf": JSON.parse(text).csrfToken });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("AT2 through the routes: archive (repo archived, purge_after = archived_at + archive_days), restore, zero deletes", async () => {
  const { app, port, fake, store, decisions } = await start({ days: 14 });
  try {
    const h = await session(port);
    const a = await call(port, "POST", `/projects/${P.id}/archive`, { headers: h });
    assert.equal(a.status, 200, a.text);
    assert.equal(a.json.stage, "archived");
    assert.equal(Date.parse(a.json.purgeAfter) - Date.parse(a.json.archivedAt), 14 * DAY, "the window is the archive_days setting");
    assert.equal(fake.repos.get("kkarnati1980/devos-acme").archived, true);
    assert.deepEqual(decisions.map((d) => [d.identity.id, d.identity.type, d.action.type, d.action.resource, d.action.projectId]),
      [[`kk:${KK}`, "kk", "teardown.archive", `project:${P.id}`, P.id]], "M1.7 decides for KK's own session, never allowAll");

    const g = await call(port, "GET", `/projects/${P.id}/teardown`, { headers: { cookie: h.cookie } });
    assert.equal(g.status, 200);
    assert.equal(g.json.stage, "archived");
    assert.equal(g.json.purgeAfter, a.json.purgeAfter);
    assert.deepEqual(g.json.active, { coolify: 1, github: 1 });
    assert.equal(g.json.lastScan, null);
    const bySlug = await call(port, "GET", `/projects/by-slug/acme/teardown`, { headers: { cookie: h.cookie } });
    assert.deepEqual(bySlug.json, g.json);

    const again = await call(port, "POST", `/projects/${P.id}/archive`, { headers: h });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, "already_archived");

    const r = await call(port, "POST", `/projects/${P.id}/restore`, { headers: h });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { stage: "live" });
    assert.equal(fake.repos.get("kkarnati1980/devos-acme").archived, false);
    assert.equal((await store.project(P.id)).stage, "live");
    assert.equal(fake.calls.filter((c) => c.method === "DELETE").length, 0, "nothing is ever deleted");
    const notArchived = await call(port, "POST", `/projects/${P.id}/restore`, { headers: h });
    assert.deepEqual([notArchived.status, notArchived.json.code], [409, "not_archived"]);
  } finally { await app.close(); }
});

test("AT9 route half: archive/restore without the CSRF token are 403 and change nothing; a non-KK caller is refused", async () => {
  const { app, port, fake, store, decisions } = await start();
  try {
    const h = await session(port);
    for (const path of [`/projects/${P.id}/archive`, `/projects/${P.id}/restore`]) {
      const r = await call(port, "POST", path, { headers: { origin: ORIGIN, cookie: h.cookie } });
      assert.equal(r.status, 403, path);
    }
    assert.equal((await store.project(P.id)).stage, "live");
    assert.deepEqual(decisions, []);
    assert.equal(fake.calls.filter((c) => c.method === "PATCH").length, 0);
  } finally { await app.close(); }
  const other = await start({ login: "someone@example.com" });
  try {
    const r = await call(other.port, "POST", `/projects/${P.id}/archive`, { headers: { origin: ORIGIN } });
    assert.equal(r.status, 403);
    const g = await call(other.port, "GET", `/projects/${P.id}/teardown`);
    assert.equal(g.status, 403);
    assert.equal((await other.store.project(P.id)).stage, "live");
    assert.deepEqual(other.decisions, []);
  } finally { await other.app.close(); }
});

test("policy deny or approval needed → 403 with the code only; the provider is not touched", async () => {
  for (const [policy, code] of [["deny", "policy_denied"], ["require_approval", "approval_required"]]) {
    const { app, port, fake, store } = await start({ policy });
    try {
      const h = await session(port);
      const r = await call(port, "POST", `/projects/${P.id}/archive`, { headers: h });
      assert.deepEqual([r.status, r.json.code], [403, code]);
      assert.ok(!/teardown\.archive|project:|denied|approval/i.test(r.text.replace(code, "")), "no TeardownError message leaves the API");
      assert.equal(fake.calls.filter((c) => c.method === "PATCH").length, 0);
      assert.equal((await store.project(P.id)).stage, "live");
    } finally { await app.close(); }
  }
});

test("GET shows the stored scan report as text: hits keep their fields, errors only their code", async () => {
  const { app, port, store } = await start();
  try {
    store.scans.push({
      projectId: P.id, scannedAt: "2026-11-16T15:00:00.000Z",
      hits: [{ provider: "github", kind: "repo", externalId: "1", name: "<script>alert(1)</script>", extra: "x" }],
      errors: [{ scanner: "coolify", error: "provider_error: GET /api/v1/projects 500 token=sk-secret" }, { scanner: "vault", error: "Weird text ghp_abc" }],
    });
    const h = await session(port);
    const g = await call(port, "GET", `/projects/${P.id}/teardown`, { headers: { cookie: h.cookie } });
    assert.equal(g.status, 200);
    assert.deepEqual(g.json.lastScan, {
      scannedAt: "2026-11-16T15:00:00.000Z",
      hits: [{ provider: "github", kind: "repo", externalId: "1", name: "<script>alert(1)</script>" }],
      errors: [{ scanner: "coolify", code: "provider_error" }, { scanner: "vault", code: "error" }],
    });
    assert.match(g.text, /\\u003c|<script>/, "JSON text; the dashboard escapes it on render");
    assert.ok(!g.text.includes("sk-secret") && !g.text.includes("ghp_abc"), "scanner error text never leaves the API");
    assert.equal((await call(port, "GET", `/projects/nope/teardown`, { headers: { cookie: h.cookie } })).status, 400);
    assert.equal((await call(port, "GET", `/projects/6b7d1c1e-2f6a-4a8e-9d55-0c1f2a3b4c5d/teardown`, { headers: { cookie: h.cookie } })).status, 404);
    assert.equal((await call(port, "GET", `/projects/by-slug/Bad_Slug/teardown`, { headers: { cookie: h.cookie } })).status, 400);
  } finally { await app.close(); }
});

test("a route is bounded (504 teardown-timeout); a busy project is 409; a store failure is 503 without its text; not configured is 503", async () => {
  const hang = { archive: () => new Promise(() => {}), restore: () => new Promise(() => {}) };
  const saved = TeardownController.timeoutMs;
  TeardownController.timeoutMs = 50;
  const a = await start({ actions: hang });
  try {
    const h = await session(a.port);
    const r = await call(a.port, "POST", `/projects/${P.id}/archive`, { headers: h });
    assert.deepEqual([r.status, r.json.code], [504, "teardown-timeout"]);
    const r2 = await call(a.port, "POST", `/projects/${P.id}/restore`, { headers: h });
    assert.deepEqual([r2.status, r2.json.code], [504, "teardown-timeout"]);
  } finally { TeardownController.timeoutMs = saved; await a.app.close(); }
  assert.equal(TEARDOWN_ROUTE_TIMEOUT_MS, 120_000);

  const busy = await start({ actions: { archive: async () => { throw new Error("provision_busy"); }, restore: async () => { throw new Error("db password=hunter2 failed"); } } });
  try {
    const h = await session(busy.port);
    const r = await call(busy.port, "POST", `/projects/${P.id}/archive`, { headers: h });
    assert.deepEqual([r.status, r.json.code], [409, "project-busy"]);
    const r2 = await call(busy.port, "POST", `/projects/${P.id}/restore`, { headers: h });
    assert.deepEqual([r2.status, r2.json.code], [503, "teardown-failed"]);
    assert.ok(!r2.text.includes("hunter2"));
  } finally { await busy.app.close(); }

  const badDays = await start({ days: 0 });
  try {
    const h = await session(badDays.port);
    const r = await call(badDays.port, "POST", `/projects/${P.id}/archive`, { headers: h });
    assert.deepEqual([r.status, r.json.code], [503, "archive-days-invalid"]);
    assert.equal((await badDays.store.project(P.id)).stage, "live");
  } finally { await badDays.app.close(); }

  const off = await start({ configured: false });
  try {
    const h = await session(off.port);
    for (const [m, path] of [["GET", `/projects/${P.id}/teardown`], ["POST", `/projects/${P.id}/archive`], ["POST", `/projects/${P.id}/restore`]]) {
      const r = await call(off.port, m, path, { headers: m === "GET" ? { cookie: h.cookie } : h });
      assert.deepEqual([r.status, r.json.code], [503, "teardown-not-configured"], path);
    }
  } finally { await off.app.close(); }
});

test("teardownFailure, scanView and activeCounts keep only fixed codes and known fields", () => {
  assert.deepEqual(teardownFailure(new TeardownError("ownership_mismatch", false, "repo devos-acme lost its marker")), { status: 409, code: "ownership_mismatch" });
  assert.deepEqual(teardownFailure(Object.assign(new Error("x"), { name: "TeardownError", code: "made_up" })), { status: 503, code: "teardown-failed" });
  assert.deepEqual(teardownFailure(Object.assign(new Error("x"), { name: "TeardownError", code: "constructor" })), { status: 503, code: "teardown-failed" });
  assert.deepEqual(teardownFailure(new Error("project_not_found")), { status: 404, code: "project-not-found" });
  assert.deepEqual(teardownFailure(null), { status: 503, code: "teardown-failed" });
  assert.equal(scanView(null), null);
  assert.deepEqual(scanView({ hits: "nope", errors: [{ scanner: 7, error: 9 }] }), { scannedAt: "", hits: [], errors: [{ scanner: "", code: "error" }] });
  assert.deepEqual(activeCounts([{ provider: "github" }, { provider: "coolify" }, { provider: "coolify" }]), { coolify: 2, github: 1 });
});

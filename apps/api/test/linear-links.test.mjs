// DEVOS-248 (M2.6-b2b3, docs/modules/M2.6.md "M2.6-b2b3 decisions"): the "Open in Linear" links on a real socket.
// Off → `enabled: false` and no Linear call; on → only stored ids are asked for and only https://linear.app URLs
// leave the API; a Linear failure is a fixed code with no Linear text; without a session the route is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../dist/app.js";
import { KkSessionRegistry } from "../dist/auth.js";
import { loadConfig } from "../dist/config.js";
import { LinearLinksController, buildLinearLinks, linksView } from "../dist/linear-links.js";

/**
 * A fake of @devos/linear-sync's `linearLinks` (the api test build does not build that package; its own
 * test/links.test.mjs runs the real code). It passes every URL through, so the API's own linear.app filter is tested.
 */
async function linearLinks(client, { projectId, issueIds }) {
  const out = { project: null, issues: {} };
  if (projectId) out.project = (await client.query("query project", { id: projectId })).projects.nodes.find((n) => n.id === projectId)?.url ?? null;
  if (issueIds.length) for (const n of (await client.query("query issues", { ids: issueIds })).issues.nodes) out.issues[n.id] = n.url;
  return out;
}

const KK = "kk@example.com";
const ORIGIN = "http://devos:3000";
const ENV = { DEVOS_KK_LOGIN: KK, DEVOS_SESSION_KEY: "test-only-session-key-0123456789abcdef", DEVOS_ALLOWED_ORIGINS: ORIGIN };
const LP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const I1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const I2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function start(linearLinksSvc) {
  const app = await createApp({
    config: loadConfig(ENV),
    identity: { async whois() { return { login: KK, node: "kk-laptop" }; } },
    grants: null,
    log: () => {},
    kkSessions: new KkSessionRegistry(),
    linearLinks: linearLinksSvc,
  });
  await app.listen(0, "127.0.0.1");
  return { app, port: app.getHttpServer().address().port };
}

function request(port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, agent: false, headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => { let json; try { json = text ? JSON.parse(text) : undefined; } catch {} resolve({ status: res.statusCode, json, text, headers: res.headers }); });
    });
    req.on("error", reject);
    req.end();
  });
}

async function cookie(port) {
  const r = await request(port, "POST", "/auth/session", { origin: ORIGIN });
  assert.equal(r.status, 201);
  return r.headers["set-cookie"][0].split(";")[0];
}

/** The real service over a fake database and a fake Linear client (records every query). */
function service({ rows, linear }) {
  const queries = [];
  const db = {
    project: { findUnique: async (a) => (rows[a.where.slug] ? { id: rows[a.where.slug].id } : null) },
    resource: { findFirst: async (a) => {
      assert.deepEqual(a.where, { projectId: a.where.projectId, provider: "linear", kind: "project", status: "active" });
      const r = Object.values(rows).find((x) => x.id === a.where.projectId);
      return r?.linearProjectId ? { externalId: r.linearProjectId } : null;
    } },
    module: { findMany: async (a) => Object.values(rows).find((x) => x.id === a.where.projectId)?.modules ?? [] },
  };
  class FakeClient {
    constructor(o) { this.apiKey = o.apiKey; }
    async query(q, v) {
      queries.push({ q, v, key: await this.apiKey() });
      return linear(q, v);
    }
  }
  const vault = { reveal: async (name) => (name === "linear_api_key" ? "lin_api_TESTONLY" : null) };
  const svc = buildLinearLinks({ mod: { LinearClient: FakeClient, linearLinks }, db, vault, env: { DEVOS_LINEAR_SYNC: "on" } });
  return { svc, queries };
}

const ROWS = {
  acme: { id: "11111111-2222-4333-8444-555555555555", linearProjectId: LP, modules: [
    { key: "M1.1", linearIssue: I1 },
    { key: "M1.2", linearIssue: I2 },
    { key: "M1.3", linearIssue: null },
  ] },
  bare: { id: "22222222-2222-4333-8444-555555555555", linearProjectId: null, modules: [{ key: "M1.1", linearIssue: null }] },
};
const LINEAR = (q) => (q.includes("project")
  ? { projects: { nodes: [{ id: LP, url: "https://linear.app/kishoremb/project/acme-0f1e2d3c4b5a" }] } }
  : { issues: { nodes: [
    { id: I1, url: "https://linear.app/kishoremb/issue/DEVOS-301/m11" },
    { id: I2, url: "javascript:alert(1)" },
  ] } });

test("off (sync not switched on): enabled false, no Linear call, every off code", async () => {
  const { app, port } = await start(null);
  try {
    const c = await cookie(port);
    const r = await request(port, "GET", "/projects/by-slug/acme/linear-links", { cookie: c });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { enabled: false, project: null, modules: [] });
  } finally { await app.close(); }
  const base = { mod: { LinearClient: class {}, linearLinks: async () => ({}) }, db: {}, vault: { reveal: async () => null }, env: { DEVOS_LINEAR_SYNC: "on" } };
  assert.deepEqual(buildLinearLinks({ ...base, env: {} }), { off: "linear-sync-disabled" });
  assert.deepEqual(buildLinearLinks({ ...base, db: null }), { off: "linear-sync-no-database" });
  assert.deepEqual(buildLinearLinks({ ...base, vault: null }), { off: "linear-sync-vault-not-configured" });
  assert.deepEqual(buildLinearLinks({ ...base, mod: null }), { off: "linear-sync-not-loaded" });
  assert.deepEqual(buildLinearLinks({ ...base, mod: { LinearClient: class {} } }), { off: "linear-sync-not-loaded" });
  assert.deepEqual(buildLinearLinks({ ...base, mod: { LinearClient: class { constructor() { throw new Error("x"); } }, linearLinks: async () => ({}) } }), { off: "linear-sync-not-loaded" });
});

test("on: the project and modules with a stored id get linear.app links; no link without a stored id or a safe URL", async () => {
  const { svc, queries } = service({ rows: ROWS, linear: LINEAR });
  const { app, port } = await start(svc);
  try {
    const c = await cookie(port);
    const r = await request(port, "GET", "/projects/by-slug/acme/linear-links", { cookie: c });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, {
      enabled: true,
      project: "https://linear.app/kishoremb/project/acme-0f1e2d3c4b5a",
      modules: [{ key: "M1.1", url: "https://linear.app/kishoremb/issue/DEVOS-301/m11" }],
    });
    assert.equal(queries.length, 2);
    assert.deepEqual(queries[1].v, { ids: [I1, I2] }, "only stored ids are asked for");
    assert.ok(queries.every((x) => x.key === "lin_api_TESTONLY" && /^query/.test(x.q)), "key read by name; reads only");
    assert.ok(!r.text.includes("lin_api_TESTONLY"));

    const bare = await request(port, "GET", "/projects/by-slug/bare/linear-links", { cookie: c });
    assert.deepEqual(bare.json, { enabled: true, project: null, modules: [] });
    assert.equal(queries.length, 2, "no stored id → no Linear call");

    assert.equal((await request(port, "GET", "/projects/by-slug/nope/linear-links", { cookie: c })).json.code, "project-not-found");
    assert.equal((await request(port, "GET", "/projects/by-slug/NOPE!/linear-links", { cookie: c })).status, 400);
  } finally { await app.close(); }
});

test("Linear failing or slow → 502 linear-unreachable with no Linear text; store failing → 503", async () => {
  const { svc } = service({ rows: ROWS, linear: () => { throw new Error("Linear says <secret detail>"); } });
  const { app, port } = await start(svc);
  try {
    const c = await cookie(port);
    const r = await request(port, "GET", "/projects/by-slug/acme/linear-links", { cookie: c });
    assert.equal(r.status, 502);
    assert.equal(r.json.code, "linear-unreachable");
    assert.ok(!r.text.includes("secret detail"));
  } finally { await app.close(); }

  // DEVOS-97: the bound also aborts the signal handed to the service, so the client's retries stop too.
  let given;
  const slow = { ids: async () => ROWS.acme, links: (_ids, signal) => { given = signal; return new Promise(() => {}); } };
  const s = await start(slow);
  const saved = LinearLinksController.timeoutMs;
  LinearLinksController.timeoutMs = 50;
  try {
    const c = await cookie(s.port);
    const r = await request(s.port, "GET", "/projects/by-slug/acme/linear-links", { cookie: c });
    assert.equal(r.status, 502);
    assert.equal(r.json.code, "linear-unreachable");
    assert.ok(given instanceof AbortSignal, "the service gets a signal");
    assert.equal(given.aborted, true, "the signal is aborted when the bound ends");
  } finally { LinearLinksController.timeoutMs = saved; await s.app.close(); }

  const broken = await start({ ids: async () => { throw new Error("db down"); }, links: async () => ({}) });
  try {
    const c = await cookie(broken.port);
    const r = await request(broken.port, "GET", "/projects/by-slug/acme/linear-links", { cookie: c });
    assert.equal(r.status, 503);
    assert.equal(r.json.code, "linear-links-store-failed");
  } finally { await broken.app.close(); }
});

test("without a session the route is refused", async () => {
  const { svc, queries } = service({ rows: ROWS, linear: LINEAR });
  const { app, port } = await start(svc);
  try {
    const r = await request(port, "GET", "/projects/by-slug/acme/linear-links");
    assert.equal(r.status, 401);
    assert.equal(queries.length, 0);
  } finally { await app.close(); }
});

test("linksView drops prototype keys, non-linear.app URLs and modules without an id", () => {
  const v = linksView(
    { linearProjectId: LP, modules: [{ key: "a", linearIssue: "__proto__" }, { key: "b", linearIssue: I1 }, { key: "c", linearIssue: null }] },
    { project: "https://evil.example/p", issues: { [I1]: "https://linear.app/x/issue/A-1" } },
  );
  assert.deepEqual(v, { enabled: true, project: null, modules: [{ key: "b", url: "https://linear.app/x/issue/A-1" }] });
});

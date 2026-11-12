// M2.3-b1 acceptance tests over HTTP (docs/modules/M2.3.md: AT6 and AT11 at the route level, plus the inbox reads):
// the six /approvals routes behind KK's session and CSRF, with fixed error codes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { MemoryPolicyStore, PolicyEngine } from "@devos/policy";
import { createApp } from "../dist/app.js";
import { KkSessionRegistry } from "../dist/auth.js";
import { loadConfig } from "../dist/config.js";
import { Approvals, MemoryApprovalStore, purgeConfirmationHash } from "../dist/approvals.js";
import { mapApprovalError, pickGrant, APPROVALS_PAGE } from "../dist/approvals-routes.js";
import { ApprovalError } from "../dist/approvals.js";

const KK = "kk@example.com";
const ORIGIN = "http://devos:3000";
const ENV = { DEVOS_KK_LOGIN: KK, DEVOS_SESSION_KEY: "test-only-session-key-0123456789abcdef", DEVOS_ALLOWED_ORIGINS: ORIGIN };
const KEY = Buffer.alloc(32, 7);
const T1 = "11111111-1111-4111-8111-111111111111";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const MISSING = "99999999-9999-4999-8999-999999999999";

async function start({ login = KK, wired = true, storeFail = null } = {}) {
  const kkSessions = new KkSessionRegistry();
  const policyStore = new MemoryPolicyStore({ mode: "enforce", rules: [] });
  const engine = new PolicyEngine({ store: policyStore, hmacKey: KEY, verifyKkSession: kkSessions.verify });
  const store = new MemoryApprovalStore();
  store.addTask(T1, "deploy preview", "ready", PROJECT);
  if (storeFail) for (const m of storeFail.methods) store[m] = async () => { throw new Error(storeFail.message); };
  const approvals = new Approvals({ store, grants: engine, notifier: null, verifyKkSession: kkSessions.verify });
  const grantsFor = async (id) => policyStore.grants.filter((g) => g.approvalId === id).reverse();
  const logs = [];
  const app = await createApp({
    config: loadConfig(ENV),
    identity: { whois: async () => ({ login, node: "kk-laptop" }) },
    log: (e) => logs.push(e),
    kkSessions,
    ...(wired ? { approvals: { approvals, grantsFor, revokeGrant: (s, id) => engine.revokeGrant(s, id) } } : {}),
  });
  await app.listen(0, "127.0.0.1");
  return { app, port: app.getHttpServer().address().port, logs, store, approvals, policyStore };
}

function call(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : undefined, text }));
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function session(port) {
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/auth/session", headers: { origin: ORIGIN } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, json: t ? JSON.parse(t) : undefined }));
    });
    req.on("error", reject);
    req.end();
  });
  if (r.status !== 201) return null;
  const cookie = r.headers["set-cookie"][0].split(";")[0];
  const h = { cookie, origin: ORIGIN, "x-devos-csrf": r.json.csrfToken };
  return {
    cookie,
    get: (p) => call(port, "GET", p, { headers: { cookie } }),
    post: (p, body, extra = {}) => call(port, "POST", p, { headers: { ...h, ...extra }, body }),
  };
}

const card = (over = {}) => ({ gate: "decision", action: "deploy.preview", target: "repo:devos-app", reason: "First preview deploy", projectId: PROJECT, ...over });

test("M2.3-b1: list and detail show the card, its blocked tasks, comments and grant; approve issues one grant", async () => {
  const s = await start();
  try {
    const c = await s.approvals.raiseCard(card(), [T1]);
    const api = await session(s.port);
    let r = await api.get("/approvals?status=pending");
    assert.equal(r.status, 200);
    assert.equal(r.json.approvals.length, 1);
    assert.equal(r.json.approvals[0].id, c.id);
    assert.equal(r.json.approvals[0].blockedTasks, 1);
    assert.equal(r.json.approvals[0].grant, null);
    assert.equal(r.json.nextCursor, null);
    r = await api.post(`/approvals/${c.id}/comments`, { body: "Looks fine" });
    assert.equal(r.status, 201);
    r = await api.post(`/approvals/${c.id}/approve`, { expiresInHours: 2, maxUses: 1 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.approval.status, "approved");
    assert.match(r.json.grantId, /^[0-9a-f-]{36}$/);
    r = await api.get(`/approvals/${c.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.approval.status, "approved");
    assert.deepEqual(r.json.comments.map((x) => x.body), ["Looks fine"]);
    assert.deepEqual(r.json.blockedTasks, [{ id: T1, title: "deploy preview", status: "ready" }]);
    assert.equal(r.json.grant.maxUses, 1);
    assert.equal(r.json.grant.revoked, false);
    assert.equal(r.json.grant.scopeResource, "repo:devos-app");
    assert.equal(s.policyStore.grants.length, 1);
    // A second approve is refused with a fixed code.
    r = await api.post(`/approvals/${c.id}/approve`, {});
    assert.deepEqual([r.status, r.json.code], [409, "card-not-pending"]);
  } finally {
    await s.app.close();
  }
});

test("M2.3-b1: reject keeps the tasks blocked; grant revoke is audited and needs a live grant", async () => {
  const s = await start();
  try {
    const api = await session(s.port);
    const a = await s.approvals.raiseCard(card(), [T1]);
    let r = await api.post(`/approvals/${a.id}/grant/revoke`);
    assert.deepEqual([r.status, r.json.code], [404, "grant-not-found"]);
    r = await api.post(`/approvals/${a.id}/approve`, {});
    assert.equal(r.status, 200);
    r = await api.post(`/approvals/${a.id}/grant/revoke`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.revoked, true);
    assert.ok(s.store.audit.some((e) => e.action === "approval.grant_revoke_requested" && e.details.approvalId === a.id));
    assert.equal((await api.get(`/approvals/${a.id}`)).json.grant.revoked, true);
    r = await api.post(`/approvals/${a.id}/grant/revoke`);
    assert.deepEqual([r.status, r.json.code], [404, "grant-not-found"]);

    const b = await s.approvals.raiseCard(card({ target: "repo:other" }), [T1]);
    r = await api.post(`/approvals/${b.id}/reject`, { comment: "Not yet" });
    assert.equal(r.status, 200);
    assert.equal(r.json.approval.status, "rejected");
    assert.equal(s.store.tasks.get(T1).status, "blocked");
  } finally {
    await s.app.close();
  }
});

test("M2.3-b1 AT6 over HTTP: no session → 401, another login → 403 not-kk, a POST without CSRF → 403; nothing changes", async () => {
  const s = await start();
  try {
    const c = await s.approvals.raiseCard(card(), [T1]);
    let r = await call(s.port, "GET", "/approvals");
    assert.deepEqual([r.status, r.json.code], [401, "session-required"]);
    const api = await session(s.port);
    r = await call(s.port, "POST", `/approvals/${c.id}/approve`, { headers: { cookie: api.cookie, origin: ORIGIN }, body: {} });
    assert.deepEqual([r.status, r.json.code], [403, "csrf-token-invalid"]);
    r = await api.post(`/approvals/${c.id}/approve`, {}, { origin: "http://evil.example" });
    assert.deepEqual([r.status, r.json.code], [403, "csrf-origin-refused"]);
    assert.equal((await s.store.get(c.id)).status, "pending");
    assert.equal(s.policyStore.grants.length, 0);
  } finally {
    await s.app.close();
  }
  const other = await start({ login: "agent@example.com" });
  try {
    const c = await other.approvals.raiseCard(card(), [T1]);
    let r = await call(other.port, "GET", "/approvals");
    assert.deepEqual([r.status, r.json.code], [403, "not-kk"]);
    for (const p of [`/approvals/${c.id}/approve`, `/approvals/${c.id}/reject`, `/approvals/${c.id}/comments`, `/approvals/${c.id}/grant/revoke`]) {
      r = await call(other.port, "POST", p, { headers: { origin: ORIGIN }, body: { body: "x" } });
      assert.deepEqual([r.status, r.json.code], [403, "not-kk"], p);
    }
    assert.equal((await other.store.get(c.id)).status, "pending");
    assert.equal(other.store.commentsList.length, 0);
    assert.equal(other.policyStore.grants.length, 0);
  } finally {
    await other.app.close();
  }
});

test("M2.3-b1 AT11 over HTTP: bad input, unknown cards, purge mismatch and store failures answer fixed codes only", async () => {
  const s = await start();
  try {
    const api = await session(s.port);
    for (const q of ["?status=nope", "?projectId=x", "?cursor=../x"]) {
      const r = await api.get(`/approvals${q}`);
      assert.deepEqual([r.status, r.json.code], [400, "invalid-input"], q);
    }
    let r = await api.get(`/approvals/${MISSING}`);
    assert.deepEqual([r.status, r.json.code], [404, "card-not-found"]);
    r = await api.get("/approvals/not-a-uuid");
    assert.deepEqual([r.status, r.json.code], [404, "card-not-found"]);
    r = await api.post(`/approvals/${MISSING}/approve`, {});
    assert.deepEqual([r.status, r.json.code], [404, "card-not-found"]);
    const c = await s.approvals.raiseCard(card(), [T1]);
    r = await api.post(`/approvals/${c.id}/approve`, { expiresInHours: 0 });
    assert.deepEqual([r.status, r.json.code], [400, "invalid-input"]);
    r = await api.post(`/approvals/${c.id}/reject`, { comment: "x", extra: 1 });
    assert.deepEqual([r.status, r.json.code], [400, "invalid-input"]);
    r = await api.post(`/approvals/${c.id}/comments`, {});
    assert.deepEqual([r.status, r.json.code], [400, "invalid-input"]);
    r = await api.post(`/approvals/${c.id}/comments`, ["body"]);
    assert.deepEqual([r.status, r.json.code], [400, "invalid-input"]);
    const p = await s.approvals.raiseCard(card({ gate: "purge", action: "project.purge", target: "project:demo" }), []);
    r = await api.post(`/approvals/${p.id}/approve`, { confirmation: "purge something-else" });
    assert.deepEqual([r.status, r.json.code], [409, "purge-confirmation-mismatch"]);
    assert.equal((await s.store.get(p.id)).status, "pending");
    assert.ok(purgeConfirmationHash);
    const secret = `token ${["sk", "live", "abcdef123456"].join("-")}`;
    r = await api.post(`/approvals/${c.id}/comments`, { body: secret });
    assert.deepEqual([r.status, r.json.code], [400, "card-contains-secret"]);
    r = await api.post(`/approvals/${c.id}/reject`, { comment: secret });
    assert.deepEqual([r.status, r.json.code], [400, "card-contains-secret"]);
    assert.ok(!r.text.includes("abcdef123456"));
    assert.equal((await s.store.get(c.id)).status, "pending");
  } finally {
    await s.app.close();
  }
  const broken = await start({ storeFail: { methods: ["list", "get"], message: "connection to 10.0.0.5 failed: password=hunter2" } });
  try {
    const api = await session(broken.port);
    for (const r of [await api.get("/approvals"), await api.get(`/approvals/${MISSING}`)]) {
      assert.deepEqual([r.status, r.json.code], [503, "approvals-store-error"]);
      assert.ok(!r.text.includes("hunter2") && !r.text.includes("10.0.0.5"));
    }
    assert.ok(!JSON.stringify(broken.logs).includes("hunter2"), "the driver message is never logged");
  } finally {
    await broken.app.close();
  }
  const off = await start({ wired: false });
  try {
    const r = await (await session(off.port)).get("/approvals");
    assert.deepEqual([r.status, r.json.code], [503, "approvals-not-configured"]);
  } finally {
    await off.app.close();
  }
});

test("M2.3-b1: the list pages 50 at a time with a cursor; mapApprovalError keeps only fixed codes", async () => {
  const s = await start();
  try {
    for (let i = 0; i < APPROVALS_PAGE + 3; i++) await s.approvals.raiseCard(card({ target: `repo:r${i}` }), []);
    const api = await session(s.port);
    const a = await api.get("/approvals");
    assert.equal(a.json.approvals.length, APPROVALS_PAGE);
    assert.ok(a.json.nextCursor);
    const b = await api.get(`/approvals?cursor=${a.json.nextCursor}`);
    assert.equal(b.json.approvals.length, 3);
    assert.equal(b.json.nextCursor, null);
    const ids = new Set([...a.json.approvals, ...b.json.approvals].map((x) => x.id));
    assert.equal(ids.size, APPROVALS_PAGE + 3);
  } finally {
    await s.app.close();
  }
  assert.equal(mapApprovalError(new Error("grant-scope-resource")).getStatus(), 400);
  assert.deepEqual(mapApprovalError(new Error("db exploded: secret")).getResponse(), { statusCode: 503, code: "approvals-store-error" });
});

test("M2.3-b1 pre-review: an exact last page has no cursor; the summary shows the live grant, not a revoked race loser", async () => {
  const s = await start();
  try {
    for (let i = 0; i < APPROVALS_PAGE; i++) await s.approvals.raiseCard(card({ target: `repo:p${i}` }), []);
    const api = await session(s.port);
    const r = await api.get("/approvals");
    assert.equal(r.json.approvals.length, APPROVALS_PAGE);
    assert.equal(r.json.nextCursor, null, "exactly one full page: no next page");
    // Two grants on one card, the newer one revoked (the AT7 race loser): the detail shows the live one.
    const c = await s.approvals.raiseCard(card({ target: "repo:race" }), []);
    assert.equal((await api.post(`/approvals/${c.id}/approve`, {})).status, 200);
    const winner = s.policyStore.grants.at(-1);
    s.policyStore.grants.push({ ...winner, id: "77777777-7777-4777-8777-777777777777", issuedAt: new Date(winner.issuedAt.getTime() + 1), revokedAt: new Date() });
    const d = await api.get(`/approvals/${c.id}`);
    assert.equal(d.json.grant.id, winner.id);
    assert.equal(d.json.grant.revoked, false);
  } finally {
    await s.app.close();
  }
  const now = Date.now();
  const g = (id, over = {}) => ({ id, scopeAction: "a", scopeResource: "r", projectId: null, sha: null, expiresAt: new Date(now + 3_600_000), maxUses: 1, uses: 0, revokedAt: null, ...over });
  assert.equal(pickGrant([g("loser", { revokedAt: new Date(now) }), g("winner")], now).id, "winner");
  assert.equal(pickGrant([g("used", { uses: 1 }), g("old", { expiresAt: new Date(now - 1) })], now).id, "used");
  assert.equal(pickGrant([], now), null);
});

test("M2.3-b1 pre-review: revoke takes every live grant of the card and skips expired or used-up ones", async () => {
  const s = await start();
  try {
    const api = await session(s.port);
    const c = await s.approvals.raiseCard(card({ target: "repo:two" }), []);
    let r = await api.post(`/approvals/${c.id}/approve`, { maxUses: 2 });
    assert.equal(r.status, 200);
    // A second live grant on the same card, as a failed race-loser revoke leaves behind.
    const first = s.policyStore.grants[0];
    s.policyStore.grants.push({ ...first, id: "55555555-5555-4555-8555-555555555555", issuedAt: new Date(first.issuedAt.getTime() + 1) });
    s.policyStore.grants.push({ ...first, id: "66666666-6666-4666-8666-666666666666", expiresAt: new Date(Date.now() - 1) });
    r = await api.post(`/approvals/${c.id}/grant/revoke`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([...r.json.grantIds].sort(), [first.id, "55555555-5555-4555-8555-555555555555"].sort());
    assert.equal(s.policyStore.grants.find((x) => x.id === "66666666-6666-4666-8666-666666666666").revokedAt, null);
    r = await api.post(`/approvals/${c.id}/grant/revoke`);
    assert.deepEqual([r.status, r.json.code], [404, "grant-not-found"]);
  } finally {
    await s.app.close();
  }
  assert.equal(mapApprovalError(new ApprovalError("approvals-store-error", 500)).getStatus(), 503);
  assert.equal(mapApprovalError(new Error("grant-issuer-not-kk")).getStatus(), 403);
});


// SM-02 add-on tests (access control, Lite).
// SM-02-L1: the route inventory shows every route behind the guard except /health and /ready, and a route that is
//           not behind it is caught; an unauthenticated caller gets 401 on every app route.
// SM-02-L2: for each route with an ID, another owner's resource answers 404, the same as a missing one.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createApp } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import { createGuard, owned, singleParam, routeInventory, assertAllGuarded, assertOwned, tokenDigest, serviceTokensFromEnv } from "../src/access.mjs";

const KK = "kk@example.com";
const OTHER = "someone@example.com";
const TOKEN = crypto.randomBytes(32).toString("base64url");
const CI_TOKEN = crypto.randomBytes(32).toString("base64url");
const LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
const opts = (extra = {}) => ({ tailnetLogins: [KK, OTHER], identityProxy: "tailscale-serve", trustedProxies: LOOPBACK, serviceTokens: { worker: tokenDigest(TOKEN), ci: tokenDigest(CI_TOKEN) }, ...extra });

// Notes owned by callers; the ID is a query parameter (the core router matches exact paths).
const NOTES = new Map([["n1", { owner: `tailnet:${KK}`, text: "mine" }], ["n2", { owner: `tailnet:${OTHER}`, text: "theirs" }], ["n3", { owner: "service:worker", text: "job" }]]);
// The resolver reads the ID once (exactly one "id" key); the handler uses only ctx.resource.
const resolveNote = (req) => { const id = singleParam(req, "id"); const n = id && NOTES.get(id); return n ? { id, owner: n.owner, value: n } : null; };
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

function appRoutes(guard, reached) {
  return guard.protectAll({
    "GET /notes": (req, res, ctx) => { reached.push(ctx.caller.id); json(res, 200, [...NOTES].filter(([, n]) => n.owner === ctx.caller.id).map(([id]) => id)); },
    "GET /note": owned(resolveNote, (req, res, ctx) => { reached.push(ctx.resource.id); json(res, 200, ctx.resource.value); }),
    "DELETE /note": owned(resolveNote, (req, res, ctx) => { reached.push(`del:${ctx.resource.id}`); json(res, 200, { ok: true }); }),
  });
}

async function withApp(routes, fn) {
  const app = createApp({ config: loadConfig({ GIT_SHA: "abc1234" }), out: { write: () => {} }, routes });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${app.address().port}`); } finally { app.close(); }
}
const asKK = { "tailscale-user-login": KK };
const asOther = { "tailscale-user-login": OTHER };
const bearer = (t) => ({ authorization: `Bearer ${t}` });

test("SM-02-L1: the route inventory shows every app route behind the guard; only /health and /ready are open", () => {
  const guard = createGuard(opts());
  const routes = appRoutes(guard, []);
  const inv = routeInventory(routes);
  assert.deepEqual(inv.filter((r) => r.open).map((r) => r.route), ["GET /health", "GET /ready"]);
  assert.deepEqual(inv.filter((r) => !r.open).map((r) => [r.route, r.guarded]), [["GET /notes", true], ["GET /note", true], ["DELETE /note", true]]);
  assert.deepEqual(inv.filter((r) => r.ownerChecked).map((r) => r.route), ["GET /note", "DELETE /note"]);
  assert.doesNotThrow(() => assertAllGuarded(routes));
  // A route added without the guard is caught, and so is a handler that only claims to be guarded.
  const forged = Object.assign(() => {}, { [Symbol.for("devos.sm02.guarded")]: true, guarded: true });
  assert.throws(() => assertAllGuarded({ ...routes, "POST /notes": () => {}, "GET /x": forged }), /POST \/notes, GET \/x/);
  assert.throws(() => guard.protectAll({ "GET /health": () => {} }), /core open route/);
  // SM-02-L2 helper: every route that takes an ID is owner-checked; a guarded but unchecked ID route is caught.
  assert.doesNotThrow(() => assertOwned(routes, ["GET /note", "DELETE /note"]));
  const more = { ...routes, ...guard.protectAll({ "GET /note2": (q, s) => json(s, 200, {}) }) };
  assert.throws(() => assertOwned(more, ["GET /note", "GET /note2", "PUT /missing"]), /GET \/note2, PUT \/missing/);
});

test("SM-02-L1: with no caller, every app route is 401 and no handler runs; /health and /ready stay open", async () => {
  const reached = [];
  await withApp(appRoutes(createGuard(opts()), reached), async (base) => {
    for (const [m, p] of [["GET", "/notes"], ["GET", "/note?id=n1"], ["DELETE", "/note?id=n1"]]) {
      const r = await fetch(base + p, { method: m });
      assert.equal(r.status, 401, `${m} ${p}`);
      assert.equal(r.headers.get("www-authenticate"), "Bearer");
      assert.deepEqual(await r.json(), { error: "unauthenticated" });
    }
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/ready`)).status, 200);
    assert.equal((await fetch(`${base}/unknown`, { headers: asKK })).status, 404, "deny by default: unknown route");
  });
  assert.deepEqual(reached, []);
});

test("SM-02-L1: callers are KK's tailnet identity (from the local proxy only) or a service token", async () => {
  const reached = [];
  await withApp(appRoutes(createGuard(opts()), reached), async (base) => {
    assert.deepEqual(await (await fetch(`${base}/notes`, { headers: asKK })).json(), ["n1"]);
    assert.deepEqual(await (await fetch(`${base}/notes`, { headers: { "tailscale-user-login": KK.toUpperCase() } })).json(), ["n1"]);
    assert.deepEqual(await (await fetch(`${base}/notes`, { headers: bearer(TOKEN) })).json(), ["n3"]);
    assert.equal((await fetch(`${base}/notes`, { headers: { authorization: `bearer ${TOKEN}` } })).status, 200, "scheme is case-insensitive");
    assert.equal((await fetch(`${base}/notes`, { headers: bearer(CI_TOKEN) })).status, 200);
    // Unknown login on the tailnet: 403. Wrong, malformed or short token: 401. A bad token never falls back to the header.
    const r403 = await fetch(`${base}/notes`, { headers: { "tailscale-user-login": "stranger@example.com" } });
    assert.equal(r403.status, 403);
    assert.ok(!(await r403.text()).includes("stranger"), "no reflection");
    for (const h of [bearer(crypto.randomBytes(32).toString("base64url")), bearer("short"), { authorization: `Basic ${TOKEN}` }, { authorization: `Bearer ${TOKEN} x` }, { ...bearer("x".repeat(40)), ...asKK }]) {
      const r = await fetch(`${base}/notes`, { headers: h });
      assert.equal(r.status, 401, JSON.stringify(Object.keys(h)));
      assert.ok(!(await r.text()).includes(TOKEN));
    }
  });
  assert.deepEqual(reached, [`tailnet:${KK}`, `tailnet:${KK}`, "service:worker", "service:worker", "service:ci"]);

  // The identity header from anywhere but a trusted proxy is ignored (anyone can send it).
  const far = [];
  await withApp(appRoutes(createGuard(opts({ trustedProxies: ["10.255.255.1"], nonLoopbackProxy: true })), far), async (base) => {
    assert.equal((await fetch(`${base}/notes`, { headers: asKK })).status, 401);
    assert.equal((await fetch(`${base}/notes`, { headers: bearer(TOKEN) })).status, 200, "tokens do not depend on the proxy");
  });
  assert.deepEqual(far, ["service:worker"]);
});

test("SM-02-L2: changing the ID to another owner's resource answers 404, like a missing one, and the handler never runs", async () => {
  const reached = [];
  await withApp(appRoutes(createGuard(opts()), reached), async (base) => {
    assert.equal((await fetch(`${base}/note?id=n1`, { headers: asKK })).status, 200);
    for (const [m, id, h] of [["GET", "n2", asKK], ["DELETE", "n2", asKK], ["GET", "n1", asOther], ["DELETE", "n1", asOther], ["GET", "n1", bearer(TOKEN)], ["GET", "n3", asKK], ["GET", "nope", asKK], ["GET", "", asKK], ["GET", "n1&id=n2", asKK], ["DELETE", "n1&id=n2", asKK], ["GET", "n2&id=n1", asKK]]) {
      const r = await fetch(`${base}/note?id=${id}`, { method: m, headers: h });
      assert.equal(r.status, 404, `${m} ${id}`);
      assert.deepEqual(await r.json(), { error: "not-found" });
    }
    assert.equal((await fetch(`${base}/note?id=n2`, { method: "DELETE", headers: asOther })).status, 200);
  });
  assert.deepEqual(reached, ["n1", "del:n2"]);
  // owned() used without the guard fails closed.
  await withApp({ "GET /note": owned(() => ({ id: "n1", owner: `tailnet:${KK}` }), (q, s) => json(s, 200, {})) }, async (base) => {
    assert.equal((await fetch(`${base}/note?id=n1`, { headers: asKK })).status, 401);
  });
});

test("the guard refuses a bad set-up: no callers, plain-text tokens, bad names", () => {
  assert.throws(() => createGuard({}), /no callers configured/);
  // Tailnet callers are opt-in and need the proxy named, an explicit IP list, and a statement for a non-loopback proxy.
  const svc = { worker: tokenDigest(TOKEN) };
  assert.throws(() => createGuard({ tailnetLogins: [KK], trustedProxies: LOOPBACK }), /identityProxy/);
  assert.throws(() => createGuard({ tailnetLogins: [KK], identityProxy: "tailscale-serve" }), /need trustedProxies/);
  assert.throws(() => createGuard({ tailnetLogins: [KK], identityProxy: "tailscale-serve", trustedProxies: ["172.17.0.1"] }), /nonLoopbackProxy/);
  for (const bad of ["10.0.0.0/8", "", "proxy.local", "1.2.3", "::1]:80/[::1", "0:0:0:0:0:0:0:1", "::FFFF:127.0.0.1", "FE80::1"]) assert.throws(() => createGuard({ serviceTokens: svc, tailnetLogins: [KK], identityProxy: "tailscale-serve", trustedProxies: [bad] }), /IP addresses/, bad);
  assert.throws(() => createGuard({ serviceTokens: svc, trustedProxies: LOOPBACK }), /without tailnetLogins/);
  assert.doesNotThrow(() => createGuard({ tailnetLogins: [KK], identityProxy: "tailscale-serve", trustedProxies: ["172.17.0.1", "fd7a:115c:a1e0::1", "::ffff:10.0.0.2"], nonLoopbackProxy: true }));
  assert.throws(() => createGuard({ serviceTokens: { worker: TOKEN } }), /SHA-256 hex digest/);
  assert.throws(() => createGuard({ serviceTokens: { "Bad Name": tokenDigest(TOKEN) } }), /bad service name/);
  assert.throws(() => createGuard({ tailnetLogins: ["a b"], identityProxy: "tailscale-serve", trustedProxies: LOOPBACK }), /bad tailnet login/);
  assert.deepEqual(serviceTokensFromEnv({ SERVICE_TOKEN_SHA256_DEPLOY_BOT: tokenDigest(TOKEN).toUpperCase(), OTHER: "x" }), { "deploy-bot": tokenDigest(TOKEN) });
});

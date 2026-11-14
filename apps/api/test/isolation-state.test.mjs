// S4-a2b: GET /internal/isolation-state — the HTTP half of S4 AT4 (loopback only, token, exact fields).
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { Socket } from "node:net";
import {
  ISOLATION_STATE_PATH, buildIsolationState, isolationStateConfig, isolationStateHandler, startIsolationStateServer, tokenMatches,
} from "../dist/isolation-state.js";

// A test value built from parts, so it does not look like a real key to secret scanners.
const TOKEN = ["test", "isolation", "state", "token", "only", "x"].join("-");
const ROWS = [
  { projectId: "p1", slug: "alpha", env: "preview", idx: 3 },
  { projectId: "p1", slug: "alpha", env: "live", idx: 4 },
];
const source = (rows = ROWS) => ({ listStacks: async () => rows.map((r) => ({ ...r })) });

function get(port, { path = ISOLATION_STATE_PATH, method = "GET", auth } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: auth === undefined ? {} : { authorization: auth } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: body ? JSON.parse(body) : null }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function withServer(opts, fn) {
  const server = await startIsolationStateServer({ token: TOKEN, source: source(), port: 0, ...opts });
  try { return await fn(server.address().port, server); } finally { await new Promise((r) => server.close(r)); }
}

test("AT4 (HTTP): with the token, 200 and exactly {stacks:[{slug, env, idx, egress, tailnet}]}; egress off, no tailnet", async () => {
  await withServer({}, async (port) => {
    const r = await get(port, { auth: `Bearer ${TOKEN}` });
    assert.equal(r.status, 200);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.deepEqual(r.body, { stacks: [
      { slug: "alpha", env: "preview", idx: 3, egress: false, tailnet: [] },
      { slug: "alpha", env: "live", idx: 4, egress: false, tailnet: [] },
    ] });
    assert.deepEqual(Object.keys(r.body), ["stacks"]);
    for (const s of r.body.stacks) assert.deepEqual(Object.keys(s), ["slug", "env", "idx", "egress", "tailnet"], "no projectId or any other key");
  });
});

test("AT4 (HTTP): no token, a wrong token, a token of another length or a non-Bearer scheme is 401 with no document", async () => {
  await withServer({}, async (port) => {
    for (const auth of [undefined, "", "Bearer", `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, `Bearer ${TOKEN.toUpperCase()}`, TOKEN, `Basic ${TOKEN}`, `Bearer  ${TOKEN}`, `bearer ${TOKEN}`]) {
      const r = await get(port, { auth });
      assert.equal(r.status, 401, String(auth));
      assert.deepEqual(r.body, { error: "unauthorized" });
    }
  });
});

test("AT4 (HTTP): another path or method is 404, even with the token", async () => {
  await withServer({}, async (port) => {
    for (const [path, method] of [["/internal/isolation-state/", "GET"], ["/", "GET"], ["/internal/other", "GET"], [ISOLATION_STATE_PATH, "POST"], [ISOLATION_STATE_PATH, "HEAD"]]) {
      const r = await get(port, { path, method, auth: `Bearer ${TOKEN}` });
      assert.equal(r.status, 404, `${method} ${path}`);
    }
    const q = await get(port, { path: `${ISOLATION_STATE_PATH}?x=1`, auth: `Bearer ${TOKEN}` });
    assert.equal(q.status, 200, "a query string does not change the route");
  });
});

test("AT4 (HTTP): a caller whose socket is not loopback gets 404 before the token is looked at", async () => {
  const handler = isolationStateHandler({ token: TOKEN, source: source() });
  for (const remoteAddress of ["100.64.1.2", "10.0.0.5", "::ffff:10.0.0.5", "0.0.0.0", undefined]) {
    const socket = new Socket();
    Object.defineProperty(socket, "remoteAddress", { value: remoteAddress });
    const out = { status: 0, body: "" };
    const res = { headersSent: false, writeHead(s) { out.status = s; this.headersSent = true; }, end(b) { out.body = b; }, destroy() {} };
    await handler({ socket, method: "GET", url: ISOLATION_STATE_PATH, headers: { authorization: `Bearer ${TOKEN}` } }, res);
    assert.equal(out.status, 404, String(remoteAddress));
    assert.deepEqual(JSON.parse(out.body), { error: "not-found" });
    socket.destroy();
  }
});

test("the listener binds 127.0.0.1 only", async () => {
  await withServer({}, async (_port, server) => {
    assert.equal(server.address().address, "127.0.0.1");
  });
});

test("a store failure or a document stateDocument refuses is 503 with a fixed code, never the message", async () => {
  const codes = [];
  const failing = { listStacks: async () => { throw new Error("connection to db.secret.host refused: password=..."); } };
  await withServer({ source: failing, onError: (c) => codes.push(c) }, async (port) => {
    const r = await get(port, { auth: `Bearer ${TOKEN}` });
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { error: "isolation-state-unavailable" });
  });
  const dup = source([{ projectId: "p1", slug: "alpha", env: "preview", idx: 3 }, { projectId: "p2", slug: "beta", env: "preview", idx: 3 }]);
  await withServer({ source: dup, onError: (c) => codes.push(c) }, async (port) => {
    const r = await get(port, { auth: `Bearer ${TOKEN}` });
    assert.equal(r.status, 503, "a duplicate index refuses the whole document");
  });
  assert.deepEqual(codes, ["isolation-state-unavailable", "isolation-state-unavailable"]);
});

test("buildIsolationState never copies projectId or any other row field into the document", async () => {
  const doc = await buildIsolationState(source([{ projectId: "p1", slug: "alpha", env: "live", idx: 0, network: "x", egress: true, tailnet: ["100.64.0.0/10"] }]));
  assert.deepEqual(doc, { stacks: [{ slug: "alpha", env: "live", idx: 0, egress: false, tailnet: [] }] }, "egress and tailnet are the decision-3 defaults, never row values");
});

test("tokenMatches: exact Bearer token only", () => {
  assert.equal(tokenMatches(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(tokenMatches(undefined, TOKEN), false);
  assert.equal(tokenMatches(`Bearer ${TOKEN} `, TOKEN), false);
  assert.equal(tokenMatches("Bearer ", TOKEN), false);
});

test("config: no token keeps the listener off; a short or non-printable token, or a bad port, stops start-up with a code", () => {
  assert.equal(isolationStateConfig({}), null);
  assert.equal(isolationStateConfig({ DEVOS_ISOLATION_STATE_TOKEN: "" }), null);
  assert.deepEqual(isolationStateConfig({ DEVOS_ISOLATION_STATE_TOKEN: TOKEN }), { token: TOKEN, port: 3002 });
  assert.deepEqual(isolationStateConfig({ DEVOS_ISOLATION_STATE_TOKEN: TOKEN, API_INTERNAL_PORT: "4100" }), { token: TOKEN, port: 4100 });
  assert.throws(() => isolationStateConfig({ DEVOS_ISOLATION_STATE_TOKEN: "short" }), /config-isolation-state-token-invalid/);
  assert.throws(() => isolationStateConfig({ DEVOS_ISOLATION_STATE_TOKEN: `${TOKEN} with space` }), /config-isolation-state-token-invalid/);
  for (const p of ["0", "70000", "abc", "3.5"]) assert.throws(() => isolationStateConfig({ DEVOS_ISOLATION_STATE_TOKEN: TOKEN, API_INTERNAL_PORT: p }), /config-isolation-state-port-invalid/, p);
  assert.throws(() => isolationStateHandler({ token: "short", source: source() }), /config-isolation-state-token-invalid/);
});

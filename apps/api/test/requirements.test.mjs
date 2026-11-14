// M2.2-d2 route tests (docs/modules/M2.2.md, AT-R1…R5): the compiled app on a real socket, with the M2.2-d1
// pipeline over the in-memory store and a fake card reader.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { MemoryRequirementsStore, RequirementsPipeline } from "@devos/analyst";
import { createApp } from "../dist/app.js";
import { KkSessionRegistry } from "../dist/auth.js";
import { loadConfig } from "../dist/config.js";

const KK = "kk@example.com";
const ORIGIN = "http://devos:3000";
const ENV = { DEVOS_KK_LOGIN: KK, DEVOS_SESSION_KEY: "test-only-session-key-0123456789abcdef", DEVOS_ALLOWED_ORIGINS: ORIGIN };
const P1 = "4b7d1c1e-2f6a-4a8e-9d55-0c1f2a3b4c5d";
const SPEC = `# Shop

## Phase 1: Launch

- FR-1: Owner login
  - Login works
- FR-2: Menu page
  - Menu shows prices
`;

async function start({ configured = true } = {}) {
  const store = new MemoryRequirementsStore();
  store.addProject({ id: P1, name: "Shop", stage: "intake" });
  const cards = new Map();
  let n = 0;
  const raise = (gate) => async (c) => {
    const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    cards.set(id, { id, gate, status: "pending" });
    return { id };
  };
  const pipeline = new RequirementsPipeline({ store, raiseRequirementsCard: raise("requirements"), raiseQuestionCard: raise("decision") });
  const app = await createApp({
    config: loadConfig(ENV),
    identity: { async whois() { return { login: KK, node: "kk-laptop" }; } },
    grants: null,
    log: () => {},
    kkSessions: new KkSessionRegistry(),
    requirements: configured ? { pipeline, store, cards: { get: async (id) => cards.get(id) ?? null } } : undefined,
  });
  await app.listen(0, "127.0.0.1");
  return { app, port: app.getHttpServer().address().port, store, cards };
}

function call(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, agent: false, headers: { ...(body !== undefined ? { "content-length": Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json;
        try { json = text ? JSON.parse(text) : undefined; } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** A raw HTTP exchange: the response is collected even if the server closes the socket mid-upload. */
function rawPost(port, path, headers, chunks) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    let data = "";
    sock.on("data", (c) => (data += c));
    sock.on("error", () => {});
    sock.on("close", () => resolve(data));
    const head = [`POST ${path} HTTP/1.1`, "host: 127.0.0.1", "connection: close", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)].join("\r\n");
    sock.write(head + "\r\n\r\n");
    (async () => {
      for (const c of chunks) {
        if (sock.destroyed) break;
        await new Promise((r) => sock.write(c, () => r()));
      }
      if (!sock.destroyed) sock.end();
    })().catch(() => {});
  });
}

async function signIn(port) {
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/auth/session", headers: { origin: ORIGIN } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(r.status, 201);
  return { origin: ORIGIN, cookie: r.headers["set-cookie"][0].split(";")[0], "x-devos-csrf": r.json.csrfToken };
}

test("AT-R1 paste: 201 with versions and a linked card; GET shows the draft and the rows", async () => {
  const { app, port } = await start();
  try {
    const h = await signIn(port);
    const r = await call(port, "POST", `/projects/${P1}/spec`, { headers: { ...h, "content-type": "text/markdown; charset=utf-8" }, body: SPEC });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.result.specVersion, 1);
    assert.ok(r.json.result.approvalId);
    assert.match(r.json.result.markdown, /FR-1/);
    const g = await call(port, "GET", `/projects/${P1}/requirements`, { headers: { cookie: h.cookie } });
    assert.equal(g.status, 200, g.text);
    assert.equal(g.json.doc.status, "draft");
    assert.deepEqual(g.json.requirements, [], "the in-memory store has no row view; the Prisma store does");
  } finally {
    await app.close();
  }
});

test("AT-R2 file upload needs a file name; a refused type keeps the M2.1 code; GET is read-only and the sync POST (CSRF) applies an approved card", async () => {
  const { app, port, cards } = await start();
  try {
    const h = await signIn(port);
    const noName = await call(port, "POST", `/projects/${P1}/spec`, { headers: { ...h, "content-type": "application/octet-stream" }, body: SPEC });
    assert.deepEqual([noName.status, noName.json.code], [400, "invalid:filename"]);
    const exe = await call(port, "POST", `/projects/${P1}/spec`, { headers: { ...h, "content-type": "application/octet-stream", "x-devos-filename": "tool.exe" }, body: "MZ" });
    assert.deepEqual([exe.status, exe.json.code], [400, "type-unknown"]);
    const up = await call(port, "POST", `/projects/${P1}/spec`, { headers: { ...h, "content-type": "application/octet-stream", "x-devos-filename": "shop.md" }, body: SPEC });
    assert.equal(up.status, 201, up.text);
    cards.get(up.json.result.approvalId).status = "approved";
    // GET never writes (ADR-0011 §1, PR66-r1): the doc stays a draft until the sync POST.
    const g0 = await call(port, "GET", `/projects/${P1}/requirements`, { headers: { cookie: h.cookie } });
    assert.equal(g0.json.doc.status, "draft");
    const noCsrf = await call(port, "POST", `/projects/${P1}/requirements/sync`, { headers: { origin: ORIGIN, cookie: h.cookie } });
    assert.equal(noCsrf.status, 403);
    const sync = await call(port, "POST", `/projects/${P1}/requirements/sync`, { headers: h });
    assert.deepEqual([sync.status, sync.json.doc.status], [200, "approved"]);
    const g = await call(port, "GET", `/projects/${P1}/requirements`, { headers: { cookie: h.cookie } });
    assert.equal(g.json.doc.status, "approved");
    const again = await call(port, "POST", `/projects/${P1}/spec`, { headers: { ...h, "content-type": "text/markdown" }, body: SPEC });
    assert.deepEqual([again.status, again.json.code], [409, "requirements-already-approved"]);
  } finally {
    await app.close();
  }
});

test("AT-R3 refusals: no CSRF token 403, wrong type 415, bad UTF-8 400, oversize 413, unknown project 404, bad id 400", async () => {
  const { app, port } = await start();
  try {
    const h = await signIn(port);
    const noCsrf = await call(port, "POST", `/projects/${P1}/spec`, { headers: { origin: ORIGIN, cookie: h.cookie, "content-type": "text/markdown" }, body: SPEC });
    assert.equal(noCsrf.status, 403);
    const json = await call(port, "POST", `/projects/${P1}/spec`, { headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ text: SPEC }) });
    assert.deepEqual([json.status, json.json.code], [415, "body-unsupported-type"]);
    const bad = await new Promise((resolve, reject) => {
      const body = Buffer.from([0x23, 0x20, 0xff, 0xfe]);
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: `/projects/${P1}/spec`, headers: { ...h, "content-type": "text/markdown", "content-length": body.length } }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(t) }));
      });
      req.on("error", reject);
      req.end(body);
    });
    assert.deepEqual([bad.status, bad.json.code], [400, "text-not-utf8"]);
    // Declared too large: refused before any body is read.
    const big = await rawPost(port, `/projects/${P1}/spec`, { ...h, "content-type": "text/markdown", "content-length": String(10 * 1024 * 1024 + 1) }, []);
    assert.match(big, /^HTTP\/1\.1 413 /);
    assert.match(big, /"code":"spec-too-large"/);
    const unknown = await call(port, "POST", `/projects/5b7d1c1e-2f6a-4a8e-9d55-0c1f2a3b4c5d/spec`, { headers: { ...h, "content-type": "text/markdown" }, body: SPEC });
    assert.deepEqual([unknown.status, unknown.json.code], [404, "project-not-found"]);
    const badId = await call(port, "GET", `/projects/nope/requirements`, { headers: { cookie: h.cookie } });
    assert.deepEqual([badId.status, badId.json.code], [400, "invalid:id"]);
  } finally {
    await app.close();
  }
});

test("AT-R4 the body limit holds while streaming, without a Content-Length", async () => {
  const { app, port } = await start();
  try {
    const h = await signIn(port);
    // 11 chunks of 1 MiB, chunked encoding, no Content-Length: the 413 must come from the streaming cap.
    const mib = Buffer.alloc(1024 * 1024, 0x61);
    const chunk = Buffer.concat([Buffer.from(`${mib.length.toString(16)}\r\n`), mib, Buffer.from("\r\n")]);
    const r = await rawPost(port, `/projects/${P1}/spec`, { ...h, "content-type": "text/markdown", "transfer-encoding": "chunked" }, [...Array(11).fill(chunk), Buffer.from("0\r\n\r\n")]);
    assert.match(r, /^HTTP\/1\.1 413 /);
    assert.match(r, /"code":"spec-too-large"/);
  } finally {
    await app.close();
  }
});

test("AT-R5 not configured → 503", async () => {
  const { app, port } = await start({ configured: false });
  try {
    const h = await signIn(port);
    const r = await call(port, "POST", `/projects/${P1}/spec`, { headers: { ...h, "content-type": "text/markdown" }, body: SPEC });
    assert.deepEqual([r.status, r.json.code], [503, "requirements-not-configured"]);
  } finally {
    await app.close();
  }
});

test("AT-CA3a route (CR-a3, DEVOS-199): GET /projects/by-slug/:slug/preflight — session, 400 bad slug, 404 unknown, fixed 500, 503 without the reads", async () => {
  const store = new MemoryRequirementsStore();
  store.addProject({ id: P1, name: "Shop", stage: "intake", continuousRun: true, capUsd: 15 });
  let failDecisions = false;
  // The memory store has no slug or decision-log reads; the Prisma store does (test-db covers its SQL).
  const viewStore = Object.assign(Object.create(store), {
    projectBySlug: async (slug) => (slug === "shop" ? { id: P1, continuousRun: true } : null),
    decisions: async () => {
      if (failDecisions) throw new Error("db down: secret detail");
      return [];
    },
    preflightSnapshot: async () => ({ state: "pending", items: [{ id: "PF-1", kind: "secret", text: "SMS_API_KEY", default: "enter in setup wizard" }] }),
  });
  const make = async (s) => {
    const app = await createApp({
      config: loadConfig(ENV),
      identity: { async whois() { return { login: KK, node: "kk-laptop" }; } },
      grants: null,
      log: () => {},
      kkSessions: new KkSessionRegistry(),
      requirements: { pipeline: null, store: s, cards: null },
    });
    await app.listen(0, "127.0.0.1");
    return { app, port: app.getHttpServer().address().port };
  };
  const { app, port } = await make(viewStore);
  try {
    assert.equal((await call(port, "GET", "/projects/by-slug/shop/preflight")).status, 401, "session required");
    const h = await signIn(port);
    const ok = await call(port, "GET", "/projects/by-slug/shop/preflight", { headers: { cookie: h.cookie } });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(
      { state: ok.json.preflight.state, open: ok.json.preflight.open, missing: ok.json.preflight.missingSecrets, unverified: ok.json.preflight.secretsUnverified },
      { state: "pending", open: false, missing: ["SMS_API_KEY"], unverified: true },
      "no vault wired: every secret name listed, unverified",
    );
    const bad = await call(port, "GET", "/projects/by-slug/Bad_Slug/preflight", { headers: { cookie: h.cookie } });
    assert.deepEqual([bad.status, bad.json.code], [400, "invalid:slug"]);
    const none = await call(port, "GET", "/projects/by-slug/nope/preflight", { headers: { cookie: h.cookie } });
    assert.deepEqual([none.status, none.json.code], [404, "project-not-found"]);
    failDecisions = true;
    const fault = await call(port, "GET", "/projects/by-slug/shop/preflight", { headers: { cookie: h.cookie } });
    assert.deepEqual([fault.status, fault.json.code], [500, "requirements-store-error"]);
    assert.ok(!fault.text.includes("secret detail"), "never the error message");
  } finally {
    await app.close();
  }
  const plain = await make(store);
  try {
    const h = await signIn(plain.port);
    const r = await call(plain.port, "GET", "/projects/by-slug/shop/preflight", { headers: { cookie: h.cookie } });
    assert.deepEqual([r.status, r.json.code], [503, "preflight-not-configured"]);
  } finally {
    await plain.app.close();
  }
});

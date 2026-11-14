// M1.4 acceptance tests (docs/modules/M1.4.md): setup wizard caps, settings, write-only vault.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../dist/app.js";
import { KkSessionRegistry } from "../dist/auth.js";
import { loadConfig, startupErrorCode } from "../dist/config.js";
import { buildRuntime } from "../dist/runtime.js";
import { MemorySettingsStore, PrismaSettingsStore } from "../dist/settings.js";
import { MemoryVaultStore, PrismaVaultStore, SECRET_NAMES, Vault, parseVaultKey, parseVaultKeyVersion } from "../dist/vault.js";

const KK = "kk@example.com";
const ORIGIN = "http://devos:3000";
const ENV = { DEVOS_KK_LOGIN: KK, DEVOS_SESSION_KEY: "test-only-session-key-0123456789abcdef", DEVOS_ALLOWED_ORIGINS: ORIGIN };
const KEY = randomBytes(32);

/** A fake secret per name: long, unique, and easy to search for in any output. */
const secretFor = (name, n = 1) => `TESTONLY-${name}-${n}-${randomBytes(12).toString("hex")}`;

async function start(extra = {}) {
  const logs = [];
  const clock = { t: Date.parse("2026-11-06T10:00:00Z") };
  const settings = extra.settings === null ? null : (extra.settings ?? new MemorySettingsStore(() => clock.t));
  const vaultStore = extra.vaultStore ?? new MemoryVaultStore(() => clock.t);
  const vault = extra.vault === null ? null : (extra.vault ?? new Vault(vaultStore, KEY, 1));
  const app = await createApp({
    config: loadConfig(ENV),
    identity: { whois: async () => ({ login: KK, node: "kk-laptop" }) },
    grants: null,
    log: (e) => logs.push(e),
    now: () => clock.t,
    kkSessions: new KkSessionRegistry(),
    setup: { settings, vault },
  });
  await app.listen(0, "127.0.0.1");
  return { app, port: app.getHttpServer().address().port, logs, settings, vault, vaultStore };
}

function call(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function session(port) {
  const r = await call(port, "POST", "/auth/session", { headers: { origin: ORIGIN } });
  assert.equal(r.status, 201, r.text);
  const cookie = r.headers["set-cookie"][0].split(";")[0];
  const h = { cookie, origin: ORIGIN, "x-devos-csrf": r.json.csrfToken };
  return {
    get: (p) => call(port, "GET", p, { headers: { cookie } }),
    put: (p, body, headers = {}) => call(port, "PUT", p, { headers: { ...h, ...headers }, body }),
  };
}

const CAPS = { anthropicCapUsd: 15, openaiCapUsd: "15.00", defaultProjectCapUsd: 15 };

test("M1.4 AT1: the wizard asks for all three caps; they are saved, confirmed and editable", async () => {
  const s = await start();
  try {
    const kk = await session(s.port);
    let st = await kk.get("/setup");
    assert.equal(st.status, 200);
    assert.equal(st.json.capsConfirmed, false);
    assert.equal(st.json.complete, false);

    const missing = await kk.put("/setup/caps", { anthropicCapUsd: 15, openaiCapUsd: 15 });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "missing:defaultProjectCapUsd");

    const saved = await kk.put("/setup/caps", CAPS);
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.settings.anthropicCapUsd, "15.00");
    assert.equal(saved.json.settings.openaiCapUsd, "15.00");
    assert.equal(saved.json.settings.defaultProjectCapUsd, "15.00");
    assert.equal(saved.json.settings.deadlockAttempts, 3);
    st = await kk.get("/setup");
    assert.equal(st.json.capsConfirmed, true);

    const edit = await kk.put("/settings", { openaiCapUsd: "20.5", defaultLanes: 3, deadlockAttempts: 3 });
    assert.equal(edit.status, 200, edit.text);
    const got = await kk.get("/settings");
    assert.equal(got.json.settings.openaiCapUsd, "20.50");
    assert.equal(got.json.settings.anthropicCapUsd, "15.00");
    assert.equal(got.json.settings.defaultLanes, 3);
    assert.deepEqual(
      s.settings.audits.map((a) => a.action),
      ["settings.updated", "settings.updated"],
    );
  } finally {
    await s.app.close();
  }
});

test("DEVOS-176 AT-CA9a: analyst.model_pass is a settings field, default off, saved on and off with an audit event", async () => {
  const s = await start();
  try {
    const kk = await session(s.port);
    await kk.put("/setup/caps", CAPS);
    assert.equal((await kk.get("/settings")).json.settings.analystModelPass, false, "default off");
    const on = await kk.put("/settings", { analystModelPass: true });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json.settings.analystModelPass, true);
    assert.equal((await kk.get("/settings")).json.settings.analystModelPass, true);
    const off = await kk.put("/settings", { analystModelPass: false });
    assert.equal(off.json.settings.analystModelPass, false);
    assert.equal((await kk.get("/settings")).json.settings.analystModelPass, false);
    const last = s.settings.audits.at(-1);
    assert.equal(last.action, "settings.updated");
    assert.deepEqual(last.details, { fields: ["analystModelPass"], analystModelPass: false }, "the new value is audited");
    assert.deepEqual(s.settings.audits.at(-2).details, { fields: ["analystModelPass"], analystModelPass: true });
  } finally {
    await s.app.close();
  }
});

test("M1.4 AT2: invalid settings are refused with a field code and change nothing", async () => {
  const s = await start();
  try {
    const kk = await session(s.port);
    await kk.put("/setup/caps", CAPS);
    const before = (await kk.get("/settings")).json.settings;
    const bad = [
      [{ anthropicCapUsd: 0 }, "invalid:anthropicCapUsd"],
      [{ anthropicCapUsd: 10000.01 }, "invalid:anthropicCapUsd"],
      [{ openaiCapUsd: 1.234 }, "invalid:openaiCapUsd"],
      [{ openaiCapUsd: "abc" }, "invalid:openaiCapUsd"],
      [{ defaultProjectCapUsd: -1 }, "invalid:defaultProjectCapUsd"],
      [{ defaultLanes: 4 }, "invalid:defaultLanes"],
      [{ defaultLanes: 0 }, "invalid:defaultLanes"],
      [{ deadlockAttempts: 0 }, "invalid:deadlockAttempts"],
      [{ deadlockAttempts: 6 }, "invalid:deadlockAttempts"],
      [{ deadlockAttempts: 2.5 }, "invalid:deadlockAttempts"],
      [{ maxLanes: 5 }, "unknown-field:maxLanes"],
      [{ analystModelPass: "true" }, "invalid:analystModelPass"],
      [{ analystModelPass: 1 }, "invalid:analystModelPass"],
      [{ analystModelPass: null }, "invalid:analystModelPass"],
      [{}, "body-empty"],
      [[1], "body-must-be-object"],
    ];
    for (const [body, code] of bad) {
      const r = await kk.put("/settings", body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.code, code, JSON.stringify(body));
    }
    assert.deepEqual((await kk.get("/settings")).json.settings, before);
  } finally {
    await s.app.close();
  }
});

test("M1.4 AT3 (amendment): every secret type is saved and rotated; no value appears in any response, log or audit", async () => {
  const s = await start();
  const values = [];
  try {
    const kk = await session(s.port);
    await kk.put("/setup/caps", CAPS);
    const texts = [];
    for (const name of SECRET_NAMES) {
      for (const n of [1, 2]) {
        const value = secretFor(name, n);
        values.push(value);
        const r = await kk.put(`/vault/secrets/${name}`, { value });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json.secret.name, name);
        assert.equal(r.json.secret.hint, value.slice(-4));
        assert.equal(r.json.secret.set, true);
        assert.equal(r.json.rotated, n === 2);
        texts.push(r.text);
        // Server-side consumers get the newest value back.
        assert.equal(await s.vault.reveal(name), value);
      }
    }
    const list = await kk.get("/vault/secrets");
    assert.equal(list.status, 200);
    assert.equal(list.json.secrets.length, SECRET_NAMES.length);
    for (const m of list.json.secrets) {
      assert.deepEqual(Object.keys(m).sort(), ["createdAt", "hint", "keyVersion", "name", "set", "updatedAt"]);
      assert.equal(m.set, true);
      assert.match(m.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    }
    texts.push(list.text, (await kk.get("/setup")).text, (await kk.get("/settings")).text);
    const st = await kk.get("/setup");
    assert.equal(st.json.complete, true);

    const actions = s.vaultStore.audits.map((a) => a.action);
    assert.equal(actions.filter((a) => a === "vault.secret.saved").length, SECRET_NAMES.length);
    assert.equal(actions.filter((a) => a === "vault.secret.rotated").length, SECRET_NAMES.length);

    const everything = [...texts, ...s.logs.map((l) => JSON.stringify(l)), JSON.stringify(s.settings.audits), JSON.stringify(s.vaultStore.audits)].join("\n");
    for (const v of values) {
      assert.ok(!everything.includes(v), "a secret value leaked");
      assert.ok(!everything.includes(v.slice(0, 20)), "a secret prefix leaked");
    }
    // Stored at rest only as ciphertext.
    for (const row of s.vaultStore.rows.values()) {
      for (const v of values) assert.ok(!row.ciphertext.includes(Buffer.from(v)), "plaintext at rest");
    }
  } finally {
    await s.app.close();
  }
});

test("M1.4 AT4: write-only — no route reads a value back, and refused input never echoes it", async () => {
  const s = await start();
  try {
    const kk = await session(s.port);
    const value = secretFor("github_token");
    await kk.put("/vault/secrets/github_token", { value });
    const read = await kk.get("/vault/secrets/github_token");
    assert.equal(read.status, 404);
    assert.ok(!read.text.includes(value));

    const cases = [
      { path: "/vault/secrets/github_token", body: `{"value":"${value}"` }, // malformed JSON
      { path: "/vault/secrets/github_token", body: { value: `${value} with space` } },
      { path: "/vault/secrets/github_token", body: { value: value.slice(0, 10) } },
      { path: "/vault/secrets/github_token", body: { value, extra: value } },
      { path: "/vault/secrets/not_a_secret", body: { value } },
    ];
    const codes = [];
    for (const c of cases) {
      const r = await kk.put(c.path, c.body);
      assert.equal(r.status, 400, r.text);
      assert.ok(!r.text.includes(value) && !r.text.includes(value.slice(0, 10)), `echoed: ${r.text}`);
      codes.push(r.json.code);
    }
    assert.deepEqual(codes, ["body-invalid-json", "invalid:value-characters", "invalid:value-too-short", "unknown-field", "invalid:name"]);
    assert.ok(!s.logs.map((l) => JSON.stringify(l)).join("\n").includes(value.slice(0, 10)));
    // The rejected attempts did not overwrite the stored value.
    assert.equal(await s.vault.reveal("github_token"), value);
  } finally {
    await s.app.close();
  }
});

test("M1.4 AT5: saving a secret or settings needs the session, an allowed origin and the CSRF token", async () => {
  const s = await start();
  try {
    const kk = await session(s.port);
    const value = secretFor("openai_api_key");
    const noCsrf = await kk.put("/vault/secrets/openai_api_key", { value }, { "x-devos-csrf": "wrong" });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.json.code, "csrf-token-invalid");
    const foreign = await kk.put("/vault/secrets/openai_api_key", { value }, { origin: "https://evil.example" });
    assert.equal(foreign.status, 403);
    const crossSite = await kk.put("/settings", { openaiCapUsd: 99 }, { "sec-fetch-site": "cross-site" });
    assert.equal(crossSite.status, 403);
    const anon = await call(s.port, "PUT", "/vault/secrets/openai_api_key", { headers: { origin: ORIGIN }, body: { value } });
    assert.equal(anon.status, 401);
    const anonGet = await call(s.port, "GET", "/vault/secrets");
    assert.equal(anonGet.status, 401);
    assert.equal(s.vaultStore.rows.size, 0);
    assert.equal((await kk.get("/settings")).json.settings.openaiCapUsd, "15.00");
  } finally {
    await s.app.close();
  }
});

test("M1.4 AT6: AES-256-GCM bound to the secret name and key version; tampering and a wrong key are refused", async () => {
  const store = new MemoryVaultStore();
  const vault = new Vault(store, KEY, 1);
  const a = secretFor("anthropic_api_key");
  const b = secretFor("openai_api_key");
  await vault.put("anthropic_api_key", a);
  await vault.put("openai_api_key", b);
  const rowA = store.rows.get("anthropic_api_key");
  const rowB = store.rows.get("openai_api_key");
  assert.notDeepEqual(rowA.nonce, rowB.nonce);

  // Swap ciphertexts between names: the AAD makes both fail.
  store.rows.set("anthropic_api_key", { ...rowA, ciphertext: rowB.ciphertext, nonce: rowB.nonce });
  await assert.rejects(vault.reveal("anthropic_api_key"), /vault-secret-corrupt/);
  store.rows.set("anthropic_api_key", rowA);
  assert.equal(await vault.reveal("anthropic_api_key"), a);

  const flipped = Buffer.from(rowA.ciphertext);
  flipped[0] ^= 1;
  store.rows.set("anthropic_api_key", { ...rowA, ciphertext: flipped });
  await assert.rejects(vault.reveal("anthropic_api_key"), /vault-secret-corrupt/);
  store.rows.set("anthropic_api_key", rowA);

  await assert.rejects(new Vault(store, randomBytes(32), 1).reveal("anthropic_api_key"), /vault-secret-corrupt/);
  await assert.rejects(new Vault(store, KEY, 2).reveal("anthropic_api_key"), /vault-key-version-mismatch/);
  assert.equal(await vault.reveal("github_token"), null);
});

test("M2.4-c2b AT7: project app secrets are sealed under their project, audited by name only, kept apart from global rows", async () => {
  const { createDecipheriv } = await import("node:crypto");
  const store = new MemoryVaultStore();
  const vault = new Vault(store, KEY, 1);
  const P1 = "11111111-2222-4333-8444-555555555555";
  const P2 = "99999999-2222-4333-8444-555555555555";
  const v1 = randomBytes(32).toString("base64url");
  const v2 = randomBytes(32).toString("base64url");
  const port = vault.projectSecrets();
  assert.equal(await port.has(P1, "preview/SESSION_SECRET"), false);
  assert.equal(await port.put(P1, "preview/SESSION_SECRET", v1), undefined, "the port returns nothing about the value");
  assert.deepEqual(await vault.putProject(P1, "preview/SESSION_SECRET", v2), { rotated: true });
  assert.equal(await port.has(P1, "preview/SESSION_SECRET"), true);
  assert.equal(await port.has(P2, "preview/SESSION_SECRET"), false, "scoped to its project");
  assert.equal(store.rows.size, 0, "no global row is written");
  assert.equal((await vault.list()).filter((m) => m.set).length, 0, "the wizard list shows no app secret");
  const row = store.projectRows.get(`${P1}\npreview/SESSION_SECRET`);
  assert.equal(row.hint, null, "no hint for app secrets");
  assert.ok(!row.ciphertext.includes(Buffer.from(v2)));
  const open = (projectId) => {
    const d = createDecipheriv("aes-256-gcm", KEY, row.nonce);
    d.setAAD(Buffer.from(`devos-vault/v1\nproject:${projectId}\npreview/SESSION_SECRET\n1`, "utf8"));
    d.setAuthTag(row.ciphertext.subarray(row.ciphertext.length - 16));
    return Buffer.concat([d.update(row.ciphertext.subarray(0, row.ciphertext.length - 16)), d.final()]).toString("utf8");
  };
  assert.equal(open(P1), v2, "sealed with the project-bound AAD");
  assert.equal(await port.matches(P1, "preview/SESSION_SECRET", v2), true);
  assert.equal(await port.matches(P1, "preview/SESSION_SECRET", v1), false, "an old value does not match");
  assert.equal(await port.matches(P2, "preview/SESSION_SECRET", v2), false, "another project has no copy");
  store.projectRows.set(`${P2}\npreview/SESSION_SECRET`, row);
  assert.equal(await port.matches(P2, "preview/SESSION_SECRET", v2), false, "a row moved to another project does not open");
  store.projectRows.delete(`${P2}\npreview/SESSION_SECRET`);
  assert.equal(await new Vault(store, randomBytes(32), 1).matchesProject(P1, "preview/SESSION_SECRET", v2), false, "a wrong key is false, not a throw");
  assert.throws(() => open(P2), "a row moved to another project fails to open");
  assert.deepEqual(store.audits.map((a) => [a.action, a.projectId, a.details.name]),
    [["vault.app_secret.saved", P1, "preview/SESSION_SECRET"], ["vault.app_secret.rotated", P1, "preview/SESSION_SECRET"]]);
  assert.ok(!JSON.stringify(store.audits).includes(v1) && !JSON.stringify(store.audits).includes(v2));
  for (const [pid, name, val, code] of [
    ["not-a-uuid", "preview/SESSION_SECRET", v1, "invalid:project"],
    [P1, "anthropic_api_key", v1, "invalid:name"],
    [P1, "staging/SESSION_SECRET", v1, "invalid:name"],
    [P1, "preview/session", v1, "invalid:name"],
    [P1, "preview/SESSION_SECRET", "abc", "invalid:value-too-short"],
  ]) {
    await assert.rejects(vault.putProject(pid, name, val), (e) => e.message === code && !e.message.includes(val));
  }
  await assert.rejects(vault.hasProject(P1, "../x"), /invalid:name/);
  store.failAudit = true;
  await assert.rejects(vault.putProject(P1, "production/DB_PASSWORD", v1));
  assert.equal(await vault.hasProject(P1, "production/DB_PASSWORD"), false, "a failed audit stores nothing");
});

test("M1.4 AT7: vault key configuration fails closed with a code, never the value", async () => {
  assert.equal(parseVaultKey(undefined), null);
  assert.equal(parseVaultKey(KEY.toString("base64")).length, 32);
  const short = randomBytes(16).toString("base64");
  for (const raw of [short, "not base64 !!", randomBytes(33).toString("base64")]) {
    try {
      parseVaultKey(raw);
      assert.fail("accepted a bad key");
    } catch (e) {
      assert.equal(e.message, "config-vault-key-invalid");
      assert.ok(!e.message.includes(raw));
      assert.equal(startupErrorCode(e), "config-vault-key-invalid");
    }
  }
  assert.equal(parseVaultKeyVersion(undefined), 1);
  assert.equal(parseVaultKeyVersion("3"), 3);
  assert.throws(() => parseVaultKeyVersion("0"), /config-vault-key-version-invalid/);

  const opts = { outboundTimeoutMs: 500, kkSessions: new KkSessionRegistry(), loadDb: async () => ({}) };
  const db = { DATABASE_URL: "postgresql://x/y", DEVOS_POLICY_HMAC_KEY: "test-only-policy-hmac-key-0123456789abcdef" };
  await assert.rejects(buildRuntime({ ...db, DEVOS_VAULT_KEY: short }, opts), /config-vault-key-invalid/);
  const noKey = await buildRuntime(db, opts);
  assert.notEqual(noKey.setup.settings, null);
  assert.equal(noKey.setup.vault, null);
  const withKey = await buildRuntime({ ...db, DEVOS_VAULT_KEY: KEY.toString("base64") }, opts);
  assert.notEqual(withKey.setup.vault, null);
  const none = await buildRuntime({}, opts);
  assert.deepEqual(none.setup, { settings: null, vault: null });

  // Without a vault key the vault routes answer 503 and the wizard is never complete.
  const s = await start({ vault: null });
  try {
    const kk = await session(s.port);
    const r = await kk.put("/vault/secrets/github_token", { value: secretFor("github_token") });
    assert.equal(r.status, 503);
    assert.equal(r.json.code, "vault-not-configured");
    assert.equal((await kk.get("/vault/secrets")).json.code, "vault-not-configured");
    const st = await kk.get("/setup");
    assert.equal(st.json.vaultConfigured, false);
    assert.equal(st.json.complete, false);
  } finally {
    await s.app.close();
  }
});

test("M1.4 AT8: per-project cap and lanes (1–3); unknown or archived projects are refused", async () => {
  const s = await start();
  try {
    const kk = await session(s.port);
    const id = randomUUID();
    const archived = randomUUID();
    s.settings.projects.set(id, { id, slug: "pilot", capUsd: "15.00", lanes: 2, archived: false });
    s.settings.projects.set(archived, { id: archived, slug: "old", capUsd: "15.00", lanes: 2, archived: true });
    const r = await kk.put(`/projects/${id}/settings`, { capUsd: 25, lanes: 3 });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.project, { id, slug: "pilot", capUsd: "25.00", lanes: 3 });
    for (const [body, code] of [
      [{ lanes: 4 }, "invalid:lanes"],
      [{ lanes: 0 }, "invalid:lanes"],
      [{ capUsd: 0 }, "invalid:capUsd"],
      [{ name: "x" }, "unknown-field:name"],
      [{}, "body-empty"],
    ]) {
      const bad = await kk.put(`/projects/${id}/settings`, body);
      assert.equal(bad.status, 400);
      assert.equal(bad.json.code, code);
    }
    assert.equal((await kk.put(`/projects/not-a-uuid/settings`, { lanes: 1 })).json.code, "invalid:id");
    const missing = await kk.put(`/projects/${randomUUID()}/settings`, { lanes: 1 });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, "project-not-found");
    const old = await kk.put(`/projects/${archived}/settings`, { lanes: 1 });
    assert.equal(old.status, 409);
    assert.equal(old.json.code, "project-archived");
    assert.deepEqual(s.settings.projects.get(id).lanes, 3);
    assert.equal(s.settings.audits.at(-1).action, "project.settings.updated");
    assert.equal(s.settings.audits.at(-1).projectId, id);
  } finally {
    await s.app.close();
  }
});

test("M1.4 AT9: a store failure answers a fixed code; the driver's message (which may quote a value) is never returned", async () => {
  const value = secretFor("linear_api_key");
  const leaky = {
    async upsert() {
      throw new Error(`duplicate key value violates constraint: (${value})`);
    },
    async list() {
      throw new Error(`boom ${value}`);
    },
    async get() {
      return null;
    },
  };
  const s = await start({ vaultStore: leaky });
  try {
    const kk = await session(s.port);
    const r = await kk.put("/vault/secrets/linear_api_key", { value });
    assert.equal(r.status, 503);
    assert.equal(r.json.code, "vault-store-error");
    assert.ok(!r.text.includes(value));
    const l = await kk.get("/vault/secrets");
    assert.equal(l.status, 503);
    assert.ok(!l.text.includes(value));
    assert.ok(!s.logs.map((x) => JSON.stringify(x)).join("\n").includes(value));
  } finally {
    await s.app.close();
  }
});

test("M1.4 AT10: settings routes answer 503 when no database is configured", async () => {
  const s = await start({ settings: null, vault: null });
  try {
    const kk = await session(s.port);
    for (const r of [await kk.get("/setup"), await kk.get("/settings"), await kk.put("/setup/caps", CAPS)]) {
      assert.equal(r.status, 503);
      assert.equal(r.json.code, "settings-not-configured");
    }
  } finally {
    await s.app.close();
  }
});

test("M1.4 AT11: CORS only for the exact allowed origin, with credentials; same-site needs that origin too", async () => {
  const s = await start();
  try {
    const pre = await call(s.port, "OPTIONS", "/vault/secrets/github_token", {
      headers: { origin: ORIGIN, "access-control-request-method": "PUT", "access-control-request-headers": "content-type, x-devos-csrf" },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers["access-control-allow-origin"], ORIGIN);
    assert.equal(pre.headers["access-control-allow-credentials"], "true");
    assert.match(pre.headers["access-control-allow-methods"], /PUT/);
    assert.match(pre.headers["access-control-allow-headers"], /x-devos-csrf/);
    assert.match(pre.headers.vary, /Origin/);
    assert.equal(pre.headers["x-content-type-options"], "nosniff");

    const foreign = await call(s.port, "OPTIONS", "/vault/secrets/github_token", {
      headers: { origin: "https://evil.example", "access-control-request-method": "PUT" },
    });
    assert.notEqual(foreign.status, 204);
    assert.equal(foreign.headers["access-control-allow-origin"], undefined);

    const kk = await session(s.port);
    const value = secretFor("github_token");
    const sameSite = await kk.put("/vault/secrets/github_token", { value }, { "sec-fetch-site": "same-site" });
    assert.equal(sameSite.status, 200, sameSite.text);
    assert.equal(sameSite.headers["access-control-allow-origin"], ORIGIN);
    const sameSiteForeign = await kk.put("/vault/secrets/github_token", { value: secretFor("github_token", 2) }, {
      "sec-fetch-site": "same-site",
      origin: "http://devos:9999",
    });
    assert.equal(sameSiteForeign.status, 403);
    assert.equal(sameSiteForeign.json.code, "csrf-cross-site");
    assert.equal(sameSiteForeign.headers["access-control-allow-origin"], undefined);
    assert.equal(await s.vault.reveal("github_token"), value);
  } finally {
    await s.app.close();
  }
});

test("M1.4 AT15 (PR17-r1): a change and its audit event commit together; a failed audit changes nothing", async () => {
  const s = await start();
  try {
    const kk = await session(s.port);
    await kk.put("/setup/caps", CAPS);
    const id = randomUUID();
    s.settings.projects.set(id, { id, slug: "pilot", capUsd: "15.00", lanes: 2, archived: false });
    const value = secretFor("coolify_api_token");
    await kk.put("/vault/secrets/coolify_api_token", { value });
    const before = (await kk.get("/settings")).json.settings;

    s.settings.failAudit = true;
    s.vaultStore.failAudit = true;
    const set = await kk.put("/settings", { openaiCapUsd: 99 });
    assert.equal(set.status, 503);
    assert.equal(set.json.code, "settings-store-error");
    const caps = await kk.put("/setup/caps", { ...CAPS, anthropicCapUsd: 99 });
    assert.equal(caps.status, 503);
    const proj = await kk.put(`/projects/${id}/settings`, { lanes: 3 });
    assert.equal(proj.status, 503);
    const sec = await kk.put("/vault/secrets/coolify_api_token", { value: secretFor("coolify_api_token", 2) });
    assert.equal(sec.status, 503);
    assert.equal(sec.json.code, "vault-store-error");

    assert.deepEqual((await kk.get("/settings")).json.settings, before);
    assert.equal(s.settings.projects.get(id).lanes, 2);
    assert.equal(await s.vault.reveal("coolify_api_token"), value);
  } finally {
    await s.app.close();
  }
});

test("M1.4 AT16 (PR17-r1): every Prisma store operation, reads included, runs in a bounded transaction with its audit", async () => {
  const calls = [];
  const ops = [];
  const model = (name, rows) => new Proxy({}, {
    get: (_t, op) => async () => {
      ops.push(`${name}.${String(op)}`);
      return rows(op);
    },
  });
  const row = { name: "github_token", ciphertext: Buffer.alloc(40, 1), nonce: Buffer.alloc(12, 1), keyVersion: 1, hint: "abcd", createdAt: new Date(), updatedAt: new Date() };
  const settingsRow = { anthropicCapUsd: "15", openaiCapUsd: "15", defaultProjectCapUsd: "15", defaultLanes: 2, maxLanes: 3, deadlockAttempts: 3, capsConfirmedAt: null, updatedAt: new Date() };
  const tx = {
    appSettings: model("appSettings", () => settingsRow),
    project: model("project", (op) => (op === "findUnique" ? { id: "p", archivedAt: null } : { id: "p", slug: "s", capUsd: "15", lanes: 2 })),
    vaultSecret: model("vaultSecret", (op) => (op === "findMany" ? [row] : op === "findFirst" ? null : row)),
    auditEvent: model("auditEvent", () => ({})),
  };
  const db = new Proxy({ $transaction: async (fn, opts) => { calls.push(opts); return fn(tx); } }, {
    get: (t, k) => (k === "$transaction" ? t.$transaction : (() => { throw new Error(`direct client call: ${String(k)}`); })()),
  });
  const settings = new PrismaSettingsStore(db, 1234);
  const vault = new PrismaVaultStore(db, 1234);
  const audit = { action: "x", summary: "x", details: {} };
  await settings.get();
  await settings.update({ deadlockAttempts: 3 }, new Date(), audit);
  await settings.updateProject("p", { lanes: 1 }, audit);
  await vault.list();
  await vault.get("github_token");
  await vault.upsert(row, () => audit);
  assert.equal(calls.length, 6);
  for (const c of calls) assert.deepEqual(c, { timeout: 1234, maxWait: 1234 });
  assert.equal(ops.filter((o) => o === "auditEvent.create").length, 3);
});

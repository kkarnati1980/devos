// M2.4-c2b acceptance tests on fake GitHub + Coolify (docs/modules/M2.4.md: AT7, and AT1–AT4 for the secret steps).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  allowAll, CoolifyClient, GitHubClient, MemoryStore, coolifyProjectStep, githubRepoStep, stackSteps, applicationSteps,
  appSecretSteps, appSecretStep, appSecretVaultName, generateAppSecret, listAppEnvKeys, APP_SECRET_NAMES, parsePortRange, runProvision, StepError,
} from "../dist/index.js";
import { fakeProviders } from "./fakes.mjs";

const TOKEN = "ghp_TESTONLY_not_a_real_token_0123456789";
const P = { id: "11111111-2222-4333-8444-555555555555", slug: "acme", name: "Acme" };
const RANGE = parsePortRange("20000-20999");
const noSleep = async () => {};
const CORE_COMPOSE = readFileSync(new URL("../../../templates/golden-path/core/compose.yaml", import.meta.url));
const sha1 = (b) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest("hex");

/** Stands in for apps/api's project-scoped vault: records names and audit-like events; plaintext only in `values`. */
function fakeVault() {
  const values = new Map(); // `${projectId}/${name}` -> value (the real vault keeps ciphertext only)
  const events = []; // what the real vault would audit: name and project, never the value
  let failPut = false;
  return {
    values, events,
    set failPut(v) { failPut = v; },
    has: async (projectId, name) => values.has(`${projectId}/${name}`),
    matches: async (projectId, name, candidate) => values.get(`${projectId}/${name}`) === candidate,
    put: async (projectId, name, value) => {
      if (failPut) throw new Error("vault-unavailable");
      const k = `${projectId}/${name}`;
      events.push({ action: values.has(k) ? "vault.app_secret.rotated" : "vault.app_secret.saved", projectId, name });
      values.set(k, value);
    },
  };
}

async function setup({ fake = fakeProviders(), store = new MemoryStore(), vault = fakeVault() } = {}) {
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep: noSleep });
  const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep: noSleep });
  const hooks = { afterStack: async (_p, env) => ({ compose: env.compose }) };
  const base = [githubRepoStep(gh, P, "kkarnati1980"), coolifyProjectStep(cf, P), ...stackSteps(cf, store, P, RANGE)];
  await runProvision(P.id, base, { store, authorize: allowAll });
  // A core commit with the S3 compose.yaml, journalled as done (as in application.test.mjs).
  const g = fake.gitOf(`kkarnati1980/devos-${P.slug}`);
  const s = sha1(CORE_COMPOSE);
  g.blobs.set(s, CORE_COMPOSE);
  const tree = [{ path: "compose.yaml", mode: "100644", type: "blob", sha: s }];
  const t = createHash("sha1").update(JSON.stringify(tree)).digest("hex");
  g.trees.set(t, tree);
  const c = createHash("sha1").update(`commit ${t}`).digest("hex");
  g.commits.set(c, { tree: t, parents: [] });
  g.main = c;
  await store.markDone(P.id, { key: "github/core", provider: "github", kind: "core" }, c);
  // M2.4-c2c2: the git-based create needs the c2c1 deploy key rows (as in application.test.mjs).
  fake.keys.set("pkaaaaaaaaaa", { id: 1, uuid: "pkaaaaaaaaaa", name: "k", description: `devos:${P.id}`, private_key: "-----BEGIN OPENSSH x", is_git_related: true });
  await store.markDone(P.id, { key: "coolify/deploy_key", provider: "coolify", kind: "private_key" }, "pkaaaaaaaaaa");
  await store.markDone(P.id, { key: "github/deploy_key", provider: "github", kind: "deploy_key" }, "kkarnati1980/devos-acme#7");
  const apps = applicationSteps(cf, gh, store, P, { owner: "kkarnati1980", serverUuid: "srv-0123456789", tailnetIp: "100.101.102.103", range: RANGE, hooks });
  await runProvision(P.id, apps, { store, authorize: allowAll });
  const steps = () => appSecretSteps(cf, store, vault, P);
  return { fake, store, vault, cf, steps };
}

const envWrites = (fake) => fake.creates().filter((c) => /^\/api\/v1\/applications\/[^/]+\/envs$/.test(c.path));
const appOf = (fake, env) => [...fake.apps.values()].find((a) => a.name === `devos-acme-${env === "production" ? "live" : "preview"}`);

test("AT1 each environment gets SESSION_SECRET and DB_PASSWORD as Coolify env vars, sealed in the vault under the project", async () => {
  const s = await setup();
  const out = await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  assert.deepEqual(out.map((o) => o.key), [
    "vault/app_secret/preview/SESSION_SECRET", "vault/app_secret/preview/DB_PASSWORD",
    "vault/app_secret/production/SESSION_SECRET", "vault/app_secret/production/DB_PASSWORD",
  ]);
  assert.ok(out.every((o) => o.outcome === "created"));
  assert.deepEqual(out.map((o) => o.externalId), ["acme/preview/SESSION_SECRET", "acme/preview/DB_PASSWORD", "acme/production/SESSION_SECRET", "acme/production/DB_PASSWORD"]);
  const seen = new Set();
  for (const env of ["preview", "production"]) {
    const app = appOf(s.fake, env);
    assert.deepEqual(app.envs.map((e) => e.key), [...APP_SECRET_NAMES]);
    for (const e of app.envs) {
      assert.equal(e.is_preview, false);
      assert.equal(e.is_literal, true, "Coolify must not interpolate the value");
      assert.match(e.value, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
      assert.equal(s.vault.values.get(`${P.id}/${appSecretVaultName(env, e.key)}`), e.value, "the vault holds the same value");
      seen.add(e.value);
    }
  }
  assert.equal(seen.size, 4, "every secret is generated separately");
  assert.equal(s.store.resources.filter((r) => r.kind === "app_secret").length, 0, "not inventory rows (DEVOS-131)");
  assert.deepEqual(s.vault.events.map((e) => e.action), Array(4).fill("vault.app_secret.saved"));
});

test("AT7 a generated value appears in no request but its env-var write, no journal row, inventory row, audit event or log line", async () => {
  const logged = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, out: process.stdout.write, err: process.stderr.write };
  const grab = (...a) => { logged.push(a.map(String).join(" ")); };
  console.log = console.error = console.warn = console.info = grab;
  process.stdout.write = (c, ...r) => { logged.push(String(c)); return true; };
  process.stderr.write = (c, ...r) => { logged.push(String(c)); return true; };
  let s;
  try {
    s = await setup();
    await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
    // A failing run too: its journal error line must not carry a value either.
    s.fake.faults.push({ match: (m, p) => m === "PATCH" && p.endsWith("/envs"), action: { status: 400 } });
    for (const k of ["preview/SESSION_SECRET"]) s.store.steps.delete(`${P.id}/vault/app_secret/${k}`);
    s.vault.values.delete(`${P.id}/preview/SESSION_SECRET`);
    await assert.rejects(runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll }), StepError);
  } finally {
    Object.assign(console, { log: orig.log, error: orig.error, warn: orig.warn, info: orig.info });
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
  }
  const values = [...s.vault.values.values()];
  for (const a of s.fake.apps.values()) for (const e of a.envs ?? []) values.push(e.value);
  assert.ok(values.length >= 4);
  const allowed = new Set(envWrites(s.fake));
  const captured = JSON.stringify({
    requests: s.fake.calls.filter((c) => !allowed.has(c)),
    steps: [...s.store.steps.values()],
    resources: s.store.resources,
    audits: s.vault.events,
    logged,
  });
  for (const v of values) assert.ok(!captured.includes(v), "a generated value leaked into captured output");
  // The env-var writes are the only requests carrying a value, and each carries exactly its own key's value.
  for (const c of allowed) assert.deepEqual(Object.keys(c.body).sort(), ["is_literal", "is_preview", "key", "value"]);
  assert.match([...s.store.steps.values()].find((r) => r.key === "vault/app_secret/preview/SESSION_SECRET").lastError, /^provider_error/);
});

test("AT2 a re-run writes nothing; a lost journal adopts every secret without rotating it", async () => {
  const s = await setup();
  await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  const writes = envWrites(s.fake).length;
  const before = new Map(s.vault.values);
  const again = await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  assert.ok(again.every((o) => o.outcome === "recorded"));
  for (const k of s.store.steps.keys()) if (k.includes("/vault/app_secret/")) s.store.steps.delete(k);
  const out = await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  assert.ok(out.every((o) => o.outcome === "adopted"));
  assert.equal(envWrites(s.fake).length, writes, "no env-var write");
  assert.deepEqual(s.vault.values, before, "no rotation");
});

test("AT3 a crash between the vault put and the env-var write re-runs as a rotation, with one value in both places", async () => {
  const s = await setup();
  s.fake.faults.push({ match: (m, p) => m === "POST" && p.endsWith("/envs"), action: { status: 400 } });
  await assert.rejects(runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll }), (e) => e instanceof StepError && e.code === "provider_error");
  const first = s.vault.values.get(`${P.id}/preview/SESSION_SECRET`);
  assert.ok(first, "the vault row was written before the env var");
  assert.deepEqual(appOf(s.fake, "preview").envs ?? [], [], "the env var was not written");
  await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  const now = s.vault.values.get(`${P.id}/preview/SESSION_SECRET`);
  assert.notEqual(now, first, "rotated");
  assert.equal(appOf(s.fake, "preview").envs.find((e) => e.key === "SESSION_SECRET").value, now, "Coolify and the vault agree");
  assert.equal(s.vault.events.filter((e) => e.name === "preview/SESSION_SECRET").map((e) => e.action).join(","), "vault.app_secret.saved,vault.app_secret.rotated");
});

test("AT4 an env-var POST that times out after it happened is adopted, one POST; one that did not happen is create_unconfirmed", async () => {
  const s = await setup();
  s.fake.faults.push({ match: (m, p) => m === "POST" && p.endsWith("/envs"), action: "timeout-after" });
  const out = await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  assert.equal(out[0].outcome, "adopted");
  assert.equal(envWrites(s.fake).length, 4, "one write per secret");

  const t = await setup();
  t.fake.faults.push({ match: (m, p) => m === "POST" && p.endsWith("/envs"), action: "timeout-before" });
  await assert.rejects(runProvision(P.id, t.steps(), { store: t.store, authorize: allowAll }), (e) => e.code === "create_unconfirmed" && e.retryable);
  const out2 = await runProvision(P.id, t.steps(), { store: t.store, authorize: allowAll });
  assert.equal(out2[0].outcome, "created");
  const app = appOf(t.fake, "preview");
  assert.equal(app.envs.find((e) => e.key === "SESSION_SECRET").value, t.vault.values.get(`${P.id}/preview/SESSION_SECRET`));
});

test("an env key already on the application without a vault row is rotated in place with PATCH, never duplicated", async () => {
  const s = await setup();
  const app = appOf(s.fake, "preview");
  app.envs = [{ uuid: "ev-x", key: "SESSION_SECRET", value: "set-by-someone-else-0123456789", is_preview: false }];
  await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  const w = envWrites(s.fake).filter((c) => c.path === `/api/v1/applications/${app.uuid}/envs`);
  assert.deepEqual(w.map((c) => `${c.method} ${c.body.key}`), ["PATCH SESSION_SECRET", "POST DB_PASSWORD"]);
  assert.equal(app.envs.filter((e) => e.key === "SESSION_SECRET").length, 1);
  assert.equal(app.envs[0].value, s.vault.values.get(`${P.id}/preview/SESSION_SECRET`));
});

test("AT3/AT4 on the PATCH path: a rejected, crashed or timed-out PATCH leaves a mismatch that the re-run rotates, never adopts", async () => {
  for (const fault of [{ action: { status: 400 } }, { action: "timeout-before" }, { action: { status: 422 } }, { crash: true }]) {
    const s = await setup();
    const app = appOf(s.fake, "preview");
    app.envs = [{ uuid: "ev-x", key: "SESSION_SECRET", value: "set-by-someone-else-0123456789", is_preview: false }];
    if (fault.crash) {
      // A lost lock right after the vault put stands in for a crash between the two writes.
      let n = 0;
      const orig = s.store.assertLockHeld.bind(s.store);
      s.store.assertLockHeld = async (id) => { if (++n === 4) throw new Error("provision_lock_lost"); return orig(id); };
    } else {
      s.fake.faults.push({ match: (m, p) => m === "PATCH" && p.endsWith("/envs"), ...fault });
    }
    await assert.rejects(runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll }));
    const v1 = s.vault.values.get(`${P.id}/preview/SESSION_SECRET`);
    assert.ok(v1, "the vault copy was written first");
    assert.notEqual(app.envs[0].value, v1, "the PATCH did not land");
    if (fault.crash) s.store.assertLockHeld = MemoryStore.prototype.assertLockHeld.bind(s.store);
    const out = await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
    assert.notEqual(out[0].outcome, "adopted", `a mismatch is never adopted (${JSON.stringify(fault)})`);
    assert.equal(app.envs.filter((e) => e.key === "SESSION_SECRET").length, 1);
    assert.equal(app.envs[0].value, s.vault.values.get(`${P.id}/preview/SESSION_SECRET`), "Coolify and the vault agree after the re-run");
  }
});

test("a lost journal with a mismatched value rotates instead of adopting", async () => {
  const s = await setup();
  await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  appOf(s.fake, "production").envs.find((e) => e.key === "DB_PASSWORD").value = "changed-by-hand-0123456789abcdef";
  for (const k of s.store.steps.keys()) if (k.includes("/vault/app_secret/")) s.store.steps.delete(k);
  const out = await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  assert.deepEqual(out.map((o) => o.outcome), ["adopted", "adopted", "adopted", "created"]);
  assert.equal(appOf(s.fake, "production").envs.find((e) => e.key === "DB_PASSWORD").value, s.vault.values.get(`${P.id}/production/DB_PASSWORD`));
});

test("pre-review r2 L1: another variable with a null value does not block; a key listed without a value is rewritten with PATCH", async () => {
  const s = await setup();
  const app = appOf(s.fake, "preview");
  app.envs = [{ uuid: "ev-n", key: "OTHER", value: null, is_preview: false }, { uuid: "ev-h", key: "SESSION_SECRET", is_preview: false }];
  await s.vault.put(P.id, "preview/SESSION_SECRET", "z".repeat(43));
  const out = await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  assert.equal(out[0].outcome, "created");
  const w = envWrites(s.fake).filter((c) => c.path === `/api/v1/applications/${app.uuid}/envs`);
  assert.deepEqual(w.map((c) => `${c.method} ${c.body.key}`), ["PATCH SESSION_SECRET", "POST DB_PASSWORD"]);
});

test("Coolify's pull-request preview entries do not count as present", async () => {
  const s = await setup();
  const app = appOf(s.fake, "preview");
  app.envs = [{ uuid: "ev-p", key: "SESSION_SECRET", value: "pr-preview-value-0123456789", is_preview: true }];
  await s.vault.put(P.id, "preview/SESSION_SECRET", "x".repeat(43));
  assert.deepEqual([...(await listAppEnvKeys(s.cf, app.uuid))], []);
  const out = await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  assert.equal(out[0].outcome, "created");
});

test("fail closed: no application, a policy deny, a lost lock, a vault failure or an inconclusive env list writes nothing", async () => {
  {
    const fake = fakeProviders();
    const store = new MemoryStore();
    const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep: noSleep });
    await assert.rejects(runProvision(P.id, appSecretSteps(cf, store, fakeVault(), P), { store, authorize: allowAll }), StepError);
    assert.equal(fake.creates().length, 0);
  }
  {
    const s = await setup();
    await assert.rejects(runProvision(P.id, s.steps(), { store: s.store, authorize: async (a) => (a === "provision.vault.app_secret" ? "deny" : "allow") }),
      (e) => e.code === "policy_denied" && !e.countsAsAttempt);
    assert.equal(envWrites(s.fake).length, 0);
    assert.equal(s.vault.values.size, 0);
  }
  {
    const s = await setup();
    let n = 0;
    const assertLockHeld = s.store.assertLockHeld.bind(s.store);
    s.store.assertLockHeld = async (id) => { if (++n > 2) throw new Error("provision_lock_lost"); return assertLockHeld(id); };
    await assert.rejects(runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll }));
    assert.equal(envWrites(s.fake).length, 0);
    assert.equal(s.vault.values.size, 0, "the lock is checked again before the vault put");
  }
  {
    const s = await setup();
    s.vault.failPut = true;
    await assert.rejects(runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll }), (e) => e.code === "provider_error");
    assert.equal(envWrites(s.fake).length, 0, "no env var without its vault copy");
  }
  for (const body of [{ status: 500 }, { status: 404 }]) {
    const s = await setup();
    await s.vault.put(P.id, "preview/SESSION_SECRET", "y".repeat(43));
    s.fake.faults.push({ match: (m, p) => m === "GET" && p.endsWith("/envs"), action: body, once: false });
    await assert.rejects(runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll }), (e) => e.code === "provider_error");
    assert.equal(envWrites(s.fake).length, 0);
  }
});

test("names, generation and construction checks", () => {
  const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => TOKEN, fetchImpl: fakeProviders().fetchImpl, sleep: noSleep });
  const store = new MemoryStore();
  assert.equal(appSecretVaultName("production", "DB_PASSWORD"), "production/DB_PASSWORD");
  const a = generateAppSecret();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, generateAppSecret());
  assert.throws(() => appSecretStep(cf, store, fakeVault(), { id: P.id, slug: "Bad Slug" }, "preview", "DB_PASSWORD"), /slug-invalid/);
  assert.throws(() => appSecretStep(cf, store, fakeVault(), P, "preview", "bad-key"), /app-secret-name-invalid/);
  assert.throws(() => appSecretStep(cf, store, undefined, P, "preview", "DB_PASSWORD"), /project-secrets-required/);
  assert.throws(() => appSecretStep(cf, store, { has: async () => true, put: async () => {} }, P, "preview", "DB_PASSWORD"), /project-secrets-required/);
  const st = appSecretStep(cf, store, fakeVault(), P, "preview", "DB_PASSWORD");
  assert.deepEqual([st.key, st.provider, st.kind, st.name, st.action, st.inventory], ["vault/app_secret/preview/DB_PASSWORD", "vault", "app_secret", "acme/preview/DB_PASSWORD", "provision.vault.app_secret", false]);
});

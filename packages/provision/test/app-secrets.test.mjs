// M2.4-c2b acceptance tests (docs/modules/M2.4.md: AT7, and AT1–AT4 for the app-secret steps).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  allowAll, CoolifyClient, GitHubClient, MemoryStore, coolifyProjectStep, githubRepoStep, stackSteps, applicationSteps,
  appSecretSteps, APP_SECRET_NAMES, parsePortRange, runProvision, StepError,
} from "../dist/index.js";
import { fakeProviders } from "./fakes.mjs";

const TOKEN = "ghp_TESTONLY_not_a_real_token_0123456789";
const P = { id: "11111111-2222-4333-8444-555555555555", slug: "acme", name: "Acme" };
const RANGE = parsePortRange("20000-20999");
const SERVER = "srv-0123456789";
const noSleep = async () => {};
const CORE_COMPOSE = readFileSync(new URL("../../../templates/golden-path/core/compose.yaml", import.meta.url));
const sha1 = (b) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest("hex");

/** A hook that records its calls and marks the Compose it returns, standing in for S4's isolationHook. */
function recordingHook() {
  const calls = [];
  return { calls, afterStack: async (project, env) => { calls.push({ project, env }); return { compose: { ...env.compose, "x-hardened": env.name } }; } };
}

/** Puts a core commit holding `files` on the fake repo's main and journals the `github/core` step as done. */
async function pushCore(fake, store, files = { "compose.yaml": CORE_COMPOSE }) {
  const g = fake.gitOf(`kkarnati1980/devos-${P.slug}`);
  const tree = [];
  for (const [path, content] of Object.entries(files)) { const s = sha1(content); g.blobs.set(s, content); tree.push({ path, mode: "100644", type: "blob", sha: s }); }
  const t = createHash("sha1").update(JSON.stringify(tree)).digest("hex");
  g.trees.set(t, tree);
  const c = createHash("sha1").update(`commit ${t}`).digest("hex");
  g.commits.set(c, { tree: t, parents: [] });
  g.main = c;
  await store.markDone(P.id, { key: "github/core", provider: "github", kind: "core" }, c);
  return c;
}

async function setup({ fake = fakeProviders(), store = new MemoryStore(), hook = recordingHook(), files } = {}) {
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep: noSleep });
  const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep: noSleep });
  const opts = { owner: "kkarnati1980", serverUuid: SERVER, range: RANGE, hooks: { afterStack: hook.afterStack } };
  const base = [githubRepoStep(gh, P, "kkarnati1980"), coolifyProjectStep(cf, P), ...stackSteps(cf, store, P, RANGE)];
  await runProvision(P.id, base, { store, authorize: allowAll });
  await pushCore(fake, store, files);
  const steps = () => [...base, ...applicationSteps(cf, gh, store, P, opts)];
  return { fake, store, hook, gh, cf, opts, steps };
}


/** An in-memory project vault that keeps the values (only to prove where they went). */
function memoryVault() {
  const rows = new Map();
  return { rows, puts: [], has: async (pid, n) => rows.has(`${pid}/${n}`), put: async function (pid, n, v) { this.puts.push(n); rows.set(`${pid}/${n}`, v); } };
}

async function withApps(opts = {}) {
  const s = await setup(opts);
  const vault = memoryVault();
  await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  const all = () => [...s.steps(), ...appSecretSteps(s.cf, s.store, vault, P)];
  return { ...s, vault, all };
}

const envWrites = (fake) => fake.creates().filter((c) => /\/envs$/.test(c.path));

test("AT7/AT1 each stack gets every secret as a Coolify env var and a sealed vault copy; values differ", async () => {
  const s = await withApps();
  const out = await runProvision(P.id, s.all(), { store: s.store, authorize: allowAll });
  assert.equal(out.length, 8 + 4);
  assert.ok(out.slice(-4).every((o) => o.outcome === "created"));
  const values = [];
  for (const app of s.fake.apps.values()) {
    const preview = app.name.endsWith("-preview");
    for (const n of APP_SECRET_NAMES) {
      const e = app.envs.find((x) => x.key === n);
      assert.ok(e && e.is_preview === preview && e.is_literal === true, `${app.name} ${n}`);
      assert.equal(e.value, s.vault.rows.get(`${P.id}/${preview ? "preview" : "production"}/${n}`), "the vault holds the same value");
      assert.match(e.value, /^[A-Za-z0-9_-]{43}$/);
      values.push(e.value);
    }
  }
  assert.equal(new Set(values).size, 4, "every secret is distinct");
  assert.equal(s.store.resources.filter((r) => r.kind === "app_secret").length, 0, "not inventory rows (DEVOS-131)");
});

test("AT7 no generated value appears in the journal, inventory, results, errors or any request except its env-var write", async () => {
  const s = await withApps();
  const out = await runProvision(P.id, s.all(), { store: s.store, authorize: allowAll });
  const values = [...s.vault.rows.values()];
  const envBodies = new Set(envWrites(s.fake));
  const elsewhere = JSON.stringify({
    out, steps: [...s.store.steps.values()], resources: s.store.resources,
    calls: s.fake.calls.filter((c) => !envBodies.has(c)).map((c) => ({ ...c, auth: undefined })),
  });
  for (const v of values) assert.ok(!elsewhere.includes(v), "a secret value leaked");
  // A failing env write: the error and the journal row name no value.
  const t = await withApps();
  t.fake.faults.push({ match: (m, p) => m === "POST" && p.endsWith("/envs"), action: { status: 422 }, once: false });
  const err = await runProvision(P.id, t.all(), { store: t.store, authorize: allowAll }).catch((e) => e);
  assert.ok(err instanceof StepError);
  const dump = JSON.stringify({ msg: err.message, stack: err.stack, steps: [...t.store.steps.values()] });
  for (const v of t.vault.rows.values()) assert.ok(!dump.includes(v));
});

test("AT2 a re-run writes nothing; a lost journal adopts when both halves exist", async () => {
  const s = await withApps();
  await runProvision(P.id, s.all(), { store: s.store, authorize: allowAll });
  const writes = envWrites(s.fake).length, puts = s.vault.puts.length;
  await runProvision(P.id, s.all(), { store: s.store, authorize: allowAll });
  for (const k of [...s.store.steps.keys()].filter((k) => k.includes("/vault/app_secret/"))) s.store.steps.delete(k);
  const out = await runProvision(P.id, s.all(), { store: s.store, authorize: allowAll });
  assert.ok(out.slice(-4).every((o) => o.outcome === "adopted"));
  assert.equal(envWrites(s.fake).length, writes);
  assert.equal(s.vault.puts.length, puts);
});

test("AT3 a half-done secret (vault written, env var missing, and the reverse) is finished by one rotation", async () => {
  const s = await withApps();
  await runProvision(P.id, s.all(), { store: s.store, authorize: allowAll });
  const app = [...s.fake.apps.values()].find((a) => a.name.endsWith("-preview"));
  app.envs = app.envs.filter((e) => e.key !== "DB_PASSWORD");                     // env var lost
  s.vault.rows.delete(`${P.id}/preview/SESSION_SECRET`);                           // vault copy lost
  for (const k of [...s.store.steps.keys()].filter((k) => k.includes("/vault/app_secret/preview/"))) s.store.steps.delete(k);
  const out = await runProvision(P.id, s.all(), { store: s.store, authorize: allowAll });
  assert.deepEqual(out.slice(-4).map((o) => o.outcome), ["created", "created", "recorded", "recorded"]);
  for (const n of APP_SECRET_NAMES) {
    const e = app.envs.filter((x) => x.key === n);
    assert.equal(e.length, 1, `one ${n}`);
    assert.equal(e[0].value, s.vault.rows.get(`${P.id}/preview/${n}`), "env var and vault agree after the rotation");
  }
  assert.ok(envWrites(s.fake).some((c) => c.method === "PATCH"), "an existing key is patched, not duplicated");
});

test("AT4 an env-var write that times out after it happened is adopted, not written twice", async () => {
  const s = await withApps();
  s.fake.faults.push({ match: (m, p) => m === "POST" && p.endsWith("/envs"), action: "timeout-after" });
  const out = await runProvision(P.id, s.all(), { store: s.store, authorize: allowAll });
  assert.equal(out.at(-4).outcome, "adopted");
  assert.equal(envWrites(s.fake).length, 4);
});

test("no application, no vault port, a policy deny or a lost lock → no env-var write", async () => {
  const s = await withApps();
  assert.throws(() => appSecretSteps(s.cf, s.store, undefined, P), /project-secrets-required/);
  s.store.steps.delete(`${P.id}/coolify/application/preview`);
  await assert.rejects(runProvision(P.id, [...s.all().slice(-4)], { store: s.store, authorize: allowAll }), (e) => e.code === "provider_error");
  assert.equal(envWrites(s.fake).length, 0);

  const t = await withApps();
  await assert.rejects(runProvision(P.id, t.all(), { store: t.store, authorize: async (a) => (a === "provision.vault.app_secret" ? "deny" : "allow") }), (e) => e.code === "policy_denied");
  assert.equal(envWrites(t.fake).length, 0); assert.equal(t.vault.puts.length, 0);

  const u = await withApps();
  const put = u.vault.put;
  u.vault.put = async function (...a) { await put.apply(this, a); u.store.lockLost = true; };
  await assert.rejects(runProvision(P.id, u.all(), { store: u.store, authorize: allowAll }));
  assert.equal(envWrites(u.fake).length, 0, "the lock is checked after the vault write, before the env write");
});

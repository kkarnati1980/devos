// DEVOS-247 (M2.6-b2b2, AT7, docs/modules/M2.6.md "M2.6-b2b2 decisions"): the Linear part of every teardown.
// buildLinearTeardown is on only with the sync, and the real @devos/teardown archive and purge drive the Linear ops
// through teardownWiring: archive marks the Linear project completed, purge archives it and marks its rows deleted.
// The Linear module is faked here (the api test build does not build @devos/linear-sync); the ops' own behaviour and
// lock are proven by packages/linear-sync/test/teardown-ops.test.mjs on the real code.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as realProvision from "@devos/provision";
import * as realTeardown from "@devos/teardown";
import { buildLinearTeardown } from "../dist/linear-sync-runtime.js";
import { teardownWiring } from "../dist/teardown-wiring.js";

const PID = "11111111-1111-4111-8111-111111111111";
const vault = (key = "lin_key") => { const reads = []; return { reads, reveal: async (n) => { reads.push(n); return key; } }; };
const providerError = (p, c, m, s) => new realProvision.ProviderError(p, c, m, s);

/** A fake @devos/linear-sync with the ops' contract: archive → completed, remove → archived in Linear. */
function fakeLinear() {
  const L = { writes: [], archived: false, clientOpts: null };
  L.mod = {
    LinearClient: class { constructor(o) { L.clientOpts = o; } },
    graphqlApi: (c) => ({ client: c }),
    linearTeardownOps: (db, api, projectId, makeError) => {
      L.args = { db, api, projectId, makeError };
      return [
        { provider: "linear", kind: "project", inspect: async () => (L.archived ? null : { owned: true }),
          archive: async (r) => { L.writes.push(["completed", r.externalId]); },
          unarchive: async (r) => { L.writes.push(["started", r.externalId]); },
          remove: async (r) => { L.writes.push(["archived", r.externalId]); L.archived = true; } },
        { provider: "linear", kind: "milestone", inspect: async () => null, remove: async () => { throw new Error("never"); } },
      ];
    },
    linearScanner: (_api, teamKey) => ({ name: "linear", teamKey, scan: async () => (L.archived ? [] : [{ provider: "linear", kind: "project", externalId: "lp1", name: PID }]) }),
  };
  return L;
}

test("decision 1: off unless the sync is on, with a fixed code for each missing piece", () => {
  const L = fakeLinear();
  const on = { DEVOS_LINEAR_SYNC: "on" };
  const base = { mod: L.mod, db: {}, vault: vault(), env: on, providerError };
  assert.deepEqual(buildLinearTeardown({ ...base, env: {} }), { off: "linear-sync-disabled" });
  assert.deepEqual(buildLinearTeardown({ ...base, db: null }), { off: "linear-sync-no-database" });
  assert.deepEqual(buildLinearTeardown({ ...base, vault: null }), { off: "linear-sync-vault-not-configured" });
  assert.deepEqual(buildLinearTeardown({ ...base, mod: null }), { off: "linear-sync-not-loaded" });
  assert.deepEqual(buildLinearTeardown({ ...base, mod: { ...L.mod, linearScanner: undefined } }), { off: "linear-sync-not-loaded" });
  assert.deepEqual(buildLinearTeardown({ ...base, providerError: null }), { off: "linear-sync-not-loaded" });
  assert.deepEqual(buildLinearTeardown({ ...base, mod: { ...L.mod, graphqlApi: () => { throw new Error("x"); } } }), { off: "linear-sync-not-loaded" });
  assert.deepEqual(buildLinearTeardown({ ...base, env: { ...on, DEVOS_LINEAR_TEAM_KEY: "bad key!" } }), { off: "linear-team-key-invalid" });
  assert.equal(typeof buildLinearTeardown(base), "function");
});

test("decision 1: the parts use the vault key by name, the team key, and provider errors that @devos/teardown can classify", async () => {
  const L = fakeLinear(); const v = vault(); const db = { tag: "db" };
  const parts = buildLinearTeardown({ mod: L.mod, db, vault: v, env: { DEVOS_LINEAR_SYNC: "on", DEVOS_LINEAR_TEAM_KEY: "ABC" }, providerError });
  const { ops, scanners } = parts(PID);
  assert.deepEqual(ops.map((o) => `${o.provider}/${o.kind}`), ["linear/project", "linear/milestone"]);
  assert.deepEqual(scanners.map((s) => [s.name, s.teamKey]), [["linear", "ABC"]]);
  assert.equal(L.args.db, db); assert.equal(L.args.projectId, PID);
  assert.equal(await L.clientOpts.apiKey(), "lin_key"); assert.deepEqual(v.reads, ["linear_api_key"]);
  const e = L.args.makeError("timeout", "linear project archive: timed out");
  assert.ok(e instanceof realProvision.ProviderError); assert.equal(e.provider, "linear"); assert.equal(e.transient, true);
  const none = buildLinearTeardown({ mod: L.mod, db, vault: { reveal: async () => null }, env: { DEVOS_LINEAR_SYNC: "on" }, providerError });
  none(PID);
  await assert.rejects(L.clientOpts.apiKey(), /linear-key-not-set/);
});

function wiringModules() {
  return {
    pm: { ...realProvision, pinnedGitHub: async () => ({}), pinnedCoolify: async () => ({}),
      githubScanner: () => ({ name: "github", scan: async () => [] }), coolifyScanner: () => ({ name: "coolify", scan: async () => [] }) },
  };
}

test("AT7: through the real teardown, Archive marks the Linear project completed and Restore starts it again", async () => {
  const L = fakeLinear(); const { pm } = wiringModules();
  const parts = buildLinearTeardown({ mod: L.mod, db: {}, vault: vault(), env: { DEVOS_LINEAR_SYNC: "on" }, providerError });
  const store = new realTeardown.MemoryTeardownStore();
  store.addProject({ id: PID, slug: "demo", stage: "building" });
  await store.recordResource(PID, { provider: "linear", kind: "project", externalId: "lp1", name: PID });
  const w = await teardownWiring(pm, realTeardown, { gh: {}, cf: {}, store, db: {}, projectId: PID, owner: "kkarnati1980", timeoutMs: 1000, linear: parts });
  await realTeardown.archiveProject(PID, { store, authorize: async () => "allow", ops: w.ops });
  assert.deepEqual(L.writes, [["completed", "lp1"]]);
  assert.equal((await store.project(PID)).stage, "archived");
  await realTeardown.restoreProject(PID, { store, authorize: async () => "allow", ops: w.ops });
  assert.deepEqual(L.writes, [["completed", "lp1"], ["started", "lp1"]]);
});

test("AT7: through the real teardown, Purge archives the Linear project, marks its rows deleted and reaches purged", async () => {
  const L = fakeLinear(); const { pm } = wiringModules();
  const parts = buildLinearTeardown({ mod: L.mod, db: {}, vault: vault(), env: { DEVOS_LINEAR_SYNC: "on" }, providerError });
  const store = new realTeardown.MemoryTeardownStore();
  store.addProject({ id: PID, slug: "demo", stage: "archived" });
  await store.recordResource(PID, { provider: "linear", kind: "project", externalId: "lp1", name: PID });
  await store.recordResource(PID, { provider: "linear", kind: "milestone", externalId: "lm1", name: "22222222-1111-4111-8111-111111111111" });
  const db = { vaultSecret: { findMany: async () => [] } };
  const w = await teardownWiring(pm, realTeardown, { gh: {}, cf: {}, store, db, projectId: PID, owner: "kkarnati1980", timeoutMs: 1000, linear: parts });
  const r = await realTeardown.purgeProject(PID, { store, authorize: async () => "allow", ops: w.ops, scanners: w.scanners, preflight: [] });
  assert.deepEqual(L.writes, [["archived", "lp1"]], "archived in Linear, never deleted; the milestone has no write of its own");
  assert.equal(r.purged, true); assert.equal(r.deleted, 1);
  assert.deepEqual(await store.activeResources(PID), [], "both Linear rows are marked deleted (G2 evidence)");
});

test("AT7: without the Linear parts, a project with a Linear row is not purged half way (unsupported_resource before any delete)", async () => {
  const { pm } = wiringModules();
  const store = new realTeardown.MemoryTeardownStore();
  store.addProject({ id: PID, slug: "demo", stage: "archived" });
  await store.recordResource(PID, { provider: "linear", kind: "project", externalId: "lp1", name: PID });
  const w = await teardownWiring(pm, realTeardown, { gh: {}, cf: {}, store, db: {}, projectId: PID, owner: "kkarnati1980", timeoutMs: 1000, linear: null });
  assert.equal(w.scanners.some((s) => s.name === "linear"), false);
  await assert.rejects(realTeardown.purgeProject(PID, { store, authorize: async () => "allow", ops: w.ops, scanners: w.scanners, preflight: [] }),
    (e) => e.code === "unsupported_resource");
  assert.equal((await store.activeResources(PID)).length, 1);
});

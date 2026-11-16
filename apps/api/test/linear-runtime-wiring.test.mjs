// DEVOS-97 follow-ups (docs/modules/M2.6.md "DEVOS-97 follow-up: one shared Linear client and the buildRuntime
// pass-through test"): buildRuntime builds ONE LinearClient for the sync job, the teardown parts and the links, and it
// hands the Linear teardown parts to both the teardown routes (archive/restore) and the purge job.
// The provision and teardown modules are faked here: buildRuntime only wires them, and their own behaviour is proven by
// teardown-routes.test.mjs, teardown-sweep.test.mjs and linear-teardown.test.mjs (AT7 through the real @devos/teardown).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as realProvision from "@devos/provision";
import { buildRuntime } from "../dist/runtime.js";
import { KkSessionRegistry } from "../dist/auth.js";
import { buildLinearLinks } from "../dist/linear-links.js";
import { buildLinearSync, buildLinearTeardown, linearKeyReader, sharedLinearClient } from "../dist/linear-sync-runtime.js";

const PID = "11111111-1111-4111-8111-111111111111";
const ENV = {
  DATABASE_URL: "postgresql://x/y",
  DEVOS_POLICY_HMAC_KEY: "test-only-policy-hmac-key-0123456789abcdef",
  DEVOS_GITHUB_OWNER: "kkarnati1980",
  DEVOS_COOLIFY_URL: "https://coolify.example.test/",
  DEVOS_COOLIFY_SERVER_UUID: "abcdefghijklmnopqrstuvwx",
  DEVOS_TAILNET_IP: "100.64.0.10",
  GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
};

/** A fake @devos/linear-sync: every client it builds, and the api each teardown op and scanner was given. */
function fakeLinearSync() {
  const L = { clients: [], apis: [], linkClients: [] };
  L.mod = {
    LinearClient: class { constructor(o) { this.o = o; L.clients.push(this); } },
    graphqlApi: (client) => { const api = { client }; L.apis.push(api); return api; },
    listActiveProjects: async () => [],
    syncActiveProjects: async () => ({ synced: [], skipped: [], inactive: [], failed: [] }),
    lockedSyncOne: (_db, api) => { L.syncApi = api; return async () => "synced"; },
    startSchedule: () => ({ stop: async () => {} }),
    linearTeardownOps: (_db, api, projectId) => [{ provider: "linear", kind: "project", tag: "linear-op", projectId, api }],
    linearScanner: (api, teamKey) => ({ name: "linear", teamKey, api, scan: async () => [] }),
    linearLinks: async (client) => { L.linkClients.push(client); return { project: null, modules: {} }; },
  };
  return L;
}

/** A fake @devos/teardown: archive/restore/purge record the ops and scanners buildRuntime handed them. */
function fakeTeardown() {
  const T = { calls: [] };
  T.mod = {
    PrismaTeardownStore: class {
      async project(id) { return { id, slug: "demo", stage: "archived", purgeAfter: null, archivedAt: new Date(0) }; }
      async activeResources() { return []; }
      async lastScan() { return null; }
    },
    archiveProject: async (projectId, o) => { T.calls.push({ what: "archive", projectId, ops: o.ops }); return { archivedAt: new Date(0), purgeAfter: new Date(0) }; },
    restoreProject: async (projectId, o) => { T.calls.push({ what: "restore", projectId, ops: o.ops }); return {}; },
    purgeProject: async (projectId, o) => { T.calls.push({ what: "purge", projectId, ops: o.ops, scanners: o.scanners }); return { purged: true, deleted: 0 }; },
    inventoryScanner: () => ({ name: "inventory", scan: async () => [] }),
    vaultScanner: () => ({ name: "vault", scan: async () => [] }),
  };
  return T;
}

const provisionModule = () => ({
  ...realProvision,
  GitHubClient: class {}, CoolifyClient: class {},
  pinnedGitHub: async () => ({}), pinnedCoolify: async () => ({}),
  githubScanner: () => ({ name: "github", scan: async () => [] }), coolifyScanner: () => ({ name: "coolify", scan: async () => [] }),
});

async function runtime(env, L, T) {
  const db = { $transaction: async (fn) => fn({ $queryRaw: async () => [] }) };
  return buildRuntime({ ...ENV, DEVOS_VAULT_KEY: randomBytes(32).toString("base64"), ...env }, {
    outboundTimeoutMs: 500,
    kkSessions: new KkSessionRegistry(),
    loadDb: async () => db,
    loadProvision: async () => ({ mod: provisionModule(), apply: async () => ({}), isolationHook: () => async () => {} }),
    loadTeardown: async () => T.mod,
    loadLinearSync: async () => L.mod,
  });
}

const linearOps = (ops) => ops.filter((o) => o.provider === "linear");

test("buildRuntime passes the Linear teardown parts into the teardown routes (archive and restore) and the purge job", async () => {
  const L = fakeLinearSync(); const T = fakeTeardown();
  const rt = await runtime({ DEVOS_LINEAR_SYNC: "on" }, L, T);
  assert.ok(rt.teardown.actions, "teardown routes are on");
  assert.ok(rt.teardownSweep, "the purge job is on");
  await rt.teardown.actions.archive({}, PID, 30);
  await rt.teardown.actions.restore({}, PID);
  // The purge job's purge step (what an approved card runs), called directly: its card rules are teardown-sweep.test.mjs's.
  await rt.teardownSweep.d.purge(PID, "grant-1", new Date(1));
  assert.deepEqual(T.calls.map((c) => c.what), ["archive", "restore", "purge"]);
  for (const c of T.calls) {
    assert.equal(linearOps(c.ops).length, 1, `${c.what} got the Linear op`);
    assert.equal(linearOps(c.ops)[0].projectId, PID);
  }
  const purge = T.calls[2];
  assert.ok(purge.scanners.some((s) => s.name === "linear" && s.teamKey === "DEVOS"), "the purge got the linear scanner");
});

test("with the sync off, buildRuntime gives the teardown no Linear parts and builds no Linear client", async () => {
  const L = fakeLinearSync(); const T = fakeTeardown();
  const rt = await runtime({}, L, T);
  await rt.teardown.actions.archive({}, PID, 30);
  await rt.teardownSweep.d.purge(PID, "grant-1", new Date(1));
  for (const c of T.calls) assert.equal(linearOps(c.ops).length, 0);
  assert.equal(T.calls[1].scanners.some((s) => s.name === "linear"), false);
  assert.equal(L.clients.length, 0);
  assert.equal(rt.linearSync, null);
  assert.equal(rt.linearLinks, null);
});

test("one LinearClient: the sync, every teardown op and scanner, and the links all use the same client", async () => {
  const L = fakeLinearSync(); const T = fakeTeardown();
  const rt = await runtime({ DEVOS_LINEAR_SYNC: "on" }, L, T);
  assert.equal(L.clients.length, 1, "exactly one client is built");
  const [client] = L.clients;
  assert.equal(L.syncApi.client, client, "the sync job's api wraps the shared client");
  await rt.teardown.actions.archive({}, PID, 30);
  await rt.teardownSweep.d.purge(PID, "grant-1", new Date(1));
  for (const c of T.calls) assert.equal(linearOps(c.ops)[0].api.client, client, `${c.what} op uses the shared client`);
  assert.equal(T.calls[1].scanners.find((s) => s.name === "linear").api.client, client);
  await rt.linearLinks.links({ projectId: null, issueIds: [] }, new AbortController().signal);
  assert.deepEqual(L.linkClients, [client], "the links read through the shared client");
  // The shared client reads the key at call time through linearKeyReader (tested below), never at start-up.
  assert.equal(typeof client.o.apiKey, "function");
});

test("sharedLinearClient is null when off or incomplete; a constructor that throws never stops start-up", () => {
  const L = fakeLinearSync();
  const vault = { reveal: async () => "k" };
  assert.equal(sharedLinearClient({ mod: L.mod, vault, env: {} }), null);
  assert.equal(sharedLinearClient({ mod: L.mod, vault: null, env: { DEVOS_LINEAR_SYNC: "on" } }), null);
  assert.equal(sharedLinearClient({ mod: null, vault, env: { DEVOS_LINEAR_SYNC: "on" } }), null);
  assert.equal(sharedLinearClient({ mod: { LinearClient: 1 }, vault, env: { DEVOS_LINEAR_SYNC: "on" } }), null);
  assert.equal(sharedLinearClient({ mod: { LinearClient: class { constructor() { throw new Error("bad"); } } }, vault, env: { DEVOS_LINEAR_SYNC: "on" } }), null);
  assert.ok(sharedLinearClient({ mod: L.mod, vault, env: { DEVOS_LINEAR_SYNC: "on" } }));
});

test("each builder still builds its own client when none is shared (unchanged behaviour)", () => {
  const L = fakeLinearSync();
  const vault = { reveal: async () => "k" };
  const env = { DEVOS_LINEAR_SYNC: "on" };
  buildLinearSync({ mod: L.mod, db: {}, vault, env, log: () => {} });
  buildLinearTeardown({ mod: L.mod, db: {}, vault, env, providerError: (p, c, m) => new Error(`${p} ${c} ${m}`) });
  buildLinearLinks({ mod: L.mod, db: {}, vault, env });
  assert.equal(L.clients.length, 3);
});

test("linearKeyReader reads linear_api_key by name; an empty key is the fixed not-set error", async () => {
  const names = [];
  assert.equal(await linearKeyReader({ reveal: async (n) => (names.push(n), "k1") })(), "k1");
  await assert.rejects(linearKeyReader({ reveal: async (n) => (names.push(n), null) })(), (e) => e.message === "linear-key-not-set");
  assert.deepEqual(names, ["linear_api_key", "linear_api_key"]);
});

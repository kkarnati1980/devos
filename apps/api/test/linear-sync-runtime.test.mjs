// DEVOS-163 (M2.6-b2b1, docs/modules/M2.6.md "M2.6-b2b split and M2.6-b2b1 decisions"): the scheduled Linear sync's
// runtime wiring. The schedule starts and stops with the process, and it is off, with a fixed code, unless switched on.
// The module is faked here (the api test build does not build @devos/linear-sync); its sweep and schedule follow the
// package's contract (one project at a time, failures isolated; ticks never overlap; stop waits), which the package's
// own tests (packages/linear-sync/test/schedule.test.mjs) prove on the real code.
import { test } from "node:test";
import assert from "node:assert/strict";

/** As @devos/linear-sync's syncActiveProjects: one at a time, in order; a throw is recorded, the rest still sync. */
async function syncActiveProjects({ list, syncOne }) {
  const r = { synced: [], skipped: [], inactive: [], failed: [] };
  for (const id of await list()) {
    try { r[await syncOne(id)].push(id); } catch (e) { r.failed.push({ projectId: id, error: e instanceof Error ? e.message : String(e) }); }
  }
  return r;
}

/** As @devos/linear-sync's startSchedule: the next tick only after the current one ends; stop waits for a running tick. */
function startSchedule(tick, { intervalMs, log }) {
  let timer = null;
  let running = null;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      running = (async () => { try { await tick(); } catch (e) { log?.(String(e)); } })().finally(() => { running = null; arm(); });
    }, intervalMs);
  };
  arm();
  return { stop: async () => { stopped = true; clearTimeout(timer); await running; } };
}
import { buildLinearSync } from "../dist/linear-sync-runtime.js";

const P1 = "11111111-2222-4333-8444-555555555555";
const P2 = "22222222-2222-4333-8444-555555555555";
const KEY = "lin_api_TESTONLY_not_a_real_key_0123456789";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeModule({ projects = [P1, P2], failFor = null } = {}) {
  const seen = { clients: [], keys: [], lists: 0, synced: [], teamKeys: [] };
  const mod = {
    LinearClient: class { constructor(o) { this.o = o; seen.clients.push(this); } },
    graphqlApi: (client) => ({ client }),
    listActiveProjects: async (db) => { seen.lists++; assert.equal(db.tag, "db"); return projects; },
    lockedSyncOne: (db, api, opts) => {
      seen.teamKeys.push(opts.teamKey);
      return async (id) => {
        seen.keys.push(await api.client.o.apiKey());
        if (id === failFor) throw new Error(`Linear said: token ${KEY} refused`);
        opts.log?.(`linear-sync: project ${id}: task t-1 "${"Build the search page ".repeat(30)}": state started -> unstarted (reverted)`);
        opts.log?.(`linear-sync: project ${id} inbound: task t-2 completed in Linear`);
        seen.synced.push(id);
        return "synced";
      };
    },
    syncActiveProjects,
    startSchedule: (tick, opts) => { seen.intervals = [...(seen.intervals ?? []), opts.intervalMs]; return startSchedule(tick, opts); },
  };
  return { mod, seen };
}

const vault = (key = KEY) => ({ reveal: async (name) => (name === "linear_api_key" ? key : null) });
const ON = { DEVOS_LINEAR_SYNC: "on" };

test("AT (wiring): switched on, the schedule ticks every interval over active projects and stops with the process", async () => {
  const { mod, seen } = fakeModule();
  const logs = [];
  const job = buildLinearSync({ mod, db: { tag: "db" }, vault: vault(), env: ON, log: (e) => logs.push(e), intervalMs: 20 });
  assert.equal(typeof job.start, "function");
  assert.equal(seen.lists, 0, "nothing runs before start");
  job.start();
  job.start();
  await sleep(150);
  await job.stop();
  const ticks = seen.lists;
  assert.ok(ticks >= 3, `ticked ${ticks} times`);
  assert.equal(seen.clients.length, 1, "one client; a second start is a no-op");
  assert.deepEqual(seen.teamKeys, ["DEVOS"]);
  assert.deepEqual(seen.synced.slice(0, 2), [P1, P2], "one project at a time, in list order");
  assert.ok(seen.keys.every((k) => k === KEY), "the key is read from the vault by name at call time");
  assert.ok(logs.some((l) => l.msg === "linear-sync-started"));
  assert.ok(logs.some((l) => l.msg === "linear-sync-swept" && l.synced === 2 && l.failed === 0));
  // Pre-review 1 (AT6 "and logged"): the sync's divergence and inbound lines reach the log, structured and capped.
  const div = logs.find((l) => l.msg === "linear-sync-divergence" && l.projectId === P1);
  assert.ok(div && div.detail.startsWith('task t-1 "Build the search page') && div.detail.length <= 300);
  assert.deepEqual(logs.find((l) => l.msg === "linear-sync-inbound" && l.projectId === P2), { level: "info", msg: "linear-sync-inbound", projectId: P2, detail: "task t-2 completed in Linear" });
  await sleep(80);
  assert.equal(seen.lists, ticks, "no tick after stop");
  await job.stop();
});

test("decision 4: a failing project is logged by fixed code and id only; a missing key fails ticks, never the process", async () => {
  const { mod, seen } = fakeModule({ failFor: P1 });
  const logs = [];
  const job = buildLinearSync({ mod, db: { tag: "db" }, vault: vault(), env: { ...ON, DEVOS_LINEAR_TEAM_KEY: "ACME" }, log: (e) => logs.push(e), intervalMs: 20 });
  job.start();
  await sleep(70);
  await job.stop();
  assert.deepEqual(seen.teamKeys, ["ACME"]);
  assert.ok(seen.synced.includes(P2), "the other project still syncs");
  const failed = logs.filter((l) => l.msg === "linear-sync-project-failed");
  assert.ok(failed.length >= 1);
  assert.deepEqual(failed[0], { level: "warn", msg: "linear-sync-project-failed", code: "linear-sync-failed", projectId: P1 });
  assert.ok(!JSON.stringify(logs).includes(KEY), "no key in the logs");
  assert.ok(!JSON.stringify(logs).includes("Linear said"), "no error text in the logs");

  const noKey = fakeModule();
  const logs2 = [];
  const job2 = buildLinearSync({ mod: noKey.mod, db: { tag: "db" }, vault: vault(null), env: ON, log: (e) => logs2.push(e), intervalMs: 20 });
  job2.start();
  await sleep(70);
  await job2.stop();
  assert.equal(noKey.seen.synced.length, 0);
  assert.equal(noKey.seen.lists, 0, "no key: no project is listed, locked or synced");
  const skips = logs2.filter((l) => l.msg === "linear-sync-skipped");
  assert.ok(skips.length >= 2, "one warning per tick; the schedule goes on");
  assert.deepEqual(skips[0], { level: "warn", msg: "linear-sync-skipped", code: "linear-key-not-set" });
  const broken = fakeModule();
  const logs3 = [];
  const job3 = buildLinearSync({ mod: broken.mod, db: { tag: "db" }, vault: { reveal: async () => { throw new Error("vault-key-version-mismatch"); } }, env: ON, log: (e) => logs3.push(e), intervalMs: 20 });
  job3.start();
  await sleep(50);
  await job3.stop();
  assert.deepEqual(logs3.find((l) => l.msg === "linear-sync-skipped"), { level: "warn", msg: "linear-sync-skipped", code: "linear-key-unreadable" });
  assert.equal(broken.seen.lists, 0);
});

test("decision 2–3: off, with a fixed code, unless switched on and fully configured", () => {
  const { mod } = fakeModule();
  const base = { mod, db: { tag: "db" }, vault: vault(), log: () => {} };
  assert.deepEqual(buildLinearSync({ ...base, env: {} }), { off: "linear-sync-disabled" });
  assert.deepEqual(buildLinearSync({ ...base, env: { DEVOS_LINEAR_SYNC: "true" } }), { off: "linear-sync-disabled" });
  assert.deepEqual(buildLinearSync({ ...base, db: null, env: ON }), { off: "linear-sync-no-database" });
  assert.deepEqual(buildLinearSync({ ...base, vault: null, env: ON }), { off: "linear-sync-vault-not-configured" });
  assert.deepEqual(buildLinearSync({ ...base, mod: null, env: ON }), { off: "linear-sync-not-loaded" });
  assert.deepEqual(buildLinearSync({ ...base, env: { ...ON, DEVOS_LINEAR_TEAM_KEY: "DEVOS; drop" } }), { off: "linear-team-key-invalid" });
  for (const k of ["LinearClient", "graphqlApi", "listActiveProjects", "syncActiveProjects", "lockedSyncOne", "startSchedule"]) {
    assert.deepEqual(buildLinearSync({ ...base, mod: { ...mod, [k]: undefined }, env: ON }), { off: "linear-sync-not-loaded" }, `a module without ${k} never stops the API`);
  }
});

test("buildRuntime: the Linear sync is null when switched off, and with no loader; a loader that throws never stops the API", async () => {
  const { buildRuntime } = await import("../dist/runtime.js");
  const { KkSessionRegistry } = await import("../dist/auth.js");
  const env = { DATABASE_URL: "postgresql://x/y", DEVOS_POLICY_HMAC_KEY: "test-only-policy-hmac-key-0123456789abcdef" };
  const db = { $transaction: async (fn) => fn({ $queryRaw: async () => [] }) };
  const opts = { outboundTimeoutMs: 500, kkSessions: new KkSessionRegistry(), loadDb: async () => db };
  let loads = 0;
  const off = await buildRuntime(env, { ...opts, loadLinearSync: async () => (loads++, fakeModule().mod) });
  assert.equal(off.linearSync, null, "off without DEVOS_LINEAR_SYNC=on");
  const thrown = await buildRuntime({ ...env, ...ON }, { ...opts, loadLinearSync: async () => { throw new Error("no module"); } });
  assert.equal(thrown.linearSync, null);
  const none = await buildRuntime({ ...env, ...ON }, opts);
  assert.equal(none.linearSync, null);
  assert.ok(loads <= 1);
  // Switched on, with the vault and the module: a job main.ts starts and stops.
  const { randomBytes } = await import("node:crypto");
  const on = await buildRuntime({ ...env, ...ON, DEVOS_VAULT_KEY: randomBytes(32).toString("base64") }, { ...opts, loadLinearSync: async () => fakeModule().mod });
  assert.equal(typeof on.linearSync?.start, "function");
  assert.equal(typeof on.linearSync?.stop, "function");
});

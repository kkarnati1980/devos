// M2.6-b2a AT8 (unit): the scheduled sweep syncs every active project one at a time, keeps going past a
// failure, reports lock skips, and the schedule never overlaps its ticks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { syncActiveProjects, startSchedule, SYNC_INTERVAL_MS, INACTIVE_STAGES } from "../dist/index.js";

test("AT8: the default interval is 10 minutes and archived/purged are the inactive stages", () => {
  assert.equal(SYNC_INTERVAL_MS, 600_000);
  assert.deepEqual([...INACTIVE_STAGES], ["archived", "purged"]);
});

test("AT8: every listed project is synced, strictly one at a time, in list order", async () => {
  let inFlight = 0, maxInFlight = 0; const order = [];
  const r = await syncActiveProjects({
    list: async () => ["p1", "p2", "p3"],
    syncOne: async (id) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((x) => setTimeout(x, 5)); order.push(id); inFlight--; return "synced"; },
  });
  assert.equal(maxInFlight, 1); assert.deepEqual(order, ["p1", "p2", "p3"]);
  assert.deepEqual(r, { synced: ["p1", "p2", "p3"], skipped: [], failed: [] });
});

test("AT8: a failing project is logged and the rest still sync; a held lock is reported as skipped", async () => {
  const logs = [];
  const r = await syncActiveProjects({
    list: async () => ["p1", "p2", "p3"],
    syncOne: async (id) => { if (id === "p1") throw new Error("linear 500"); return id === "p2" ? "skipped" : "synced"; },
    log: (l) => logs.push(l),
  });
  assert.deepEqual(r.synced, ["p3"]); assert.deepEqual(r.skipped, ["p2"]);
  assert.deepEqual(r.failed, [{ projectId: "p1", error: "linear 500" }]);
  assert.match(logs[0], /p1 failed: linear 500/);
});

test("AT8: the schedule ticks every interval, never overlaps, survives a failing tick and stop() waits for the running tick", async () => {
  let inFlight = 0, maxInFlight = 0, ticks = 0; const logs = [];
  const s = startSchedule(async () => {
    ticks++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((x) => setTimeout(x, 30)); inFlight--;
    if (ticks === 1) throw new Error("boom");
  }, { intervalMs: 10, log: (l) => logs.push(l) });
  await new Promise((x) => setTimeout(x, 200));
  await s.stop();
  const after = ticks;
  assert.ok(ticks >= 3, `expected several ticks, got ${ticks}`);
  assert.equal(maxInFlight, 1); assert.equal(inFlight, 0, "stop() resolved only after the running tick finished");
  assert.match(logs[0], /scheduled tick failed: boom/);
  await new Promise((x) => setTimeout(x, 60));
  assert.equal(ticks, after, "no tick after stop()");
});

test("AT8: the first tick waits one interval, and a non-positive interval is refused", async () => {
  let ticks = 0;
  const s = startSchedule(async () => { ticks++; }, { intervalMs: 50 });
  await new Promise((x) => setTimeout(x, 20));
  assert.equal(ticks, 0);
  await s.stop();
  assert.throws(() => startSchedule(async () => {}, { intervalMs: 0 }), /interval must be positive/);
});

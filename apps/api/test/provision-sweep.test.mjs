// DEVOS-224 (M2.4-d1, docs/modules/M2.4.md): the provisioning sweep, with injected fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ProvisionSweepJob } from "../dist/provision-sweep.js";

class StepError extends Error {
  constructor(step, code, retryable) { super(`${code}: provider said token=ghp_secret`); this.name = "StepError"; this.step = step; this.code = code; this.retryable = retryable; }
}

function harness({ projects = [{ id: "p1", slug: "one", name: "One" }], provision = async () => [] } = {}) {
  const logs = [], building = [], cards = [], calls = [];
  const job = new ProvisionSweepJob({
    listProvisioning: async (exclude) => projects.filter((p) => !building.includes(p.id) && !exclude.includes(p.id)),
    provision: async (p) => { calls.push(p.id); return provision(p); },
    markBuilding: async (id) => { building.push(id); },
    raiseNameConflict: async (p, step) => { cards.push(`${p.id}/${step}`); },
    log: (e) => logs.push(e),
  });
  return { job, logs, building, cards, calls };
}

test("d1: a provisioning project whose steps all finish moves to building, once", async () => {
  const h = harness();
  assert.equal(await h.job.tick(), 1);
  assert.deepEqual(h.building, ["p1"]);
  assert.equal(await h.job.tick(), 0, "a building project is not taken again");
  assert.deepEqual(h.calls, ["p1"]);
});

test("d1: a retryable failure is re-run on the next tick; 5 in a row park the project until retry()", async () => {
  let fail = true;
  const h = harness({ provision: async () => { if (fail) throw new StepError("coolify/project", "provider_error", true); } });
  for (let i = 0; i < 5; i++) await h.job.tick();
  assert.equal(h.calls.length, 5);
  assert.ok(h.job.isParked("p1"));
  await h.job.tick();
  assert.equal(h.calls.length, 5, "a parked project is skipped");
  fail = false;
  h.job.retry("p1");
  assert.equal(await h.job.tick(), 1);
  assert.deepEqual(h.building, ["p1"]);
});

test("d1: a non-retryable stop (policy_denied) parks at once and never marks building", async () => {
  const h = harness({ provision: async () => { throw new StepError("github/repo", "policy_denied", false); } });
  await h.job.tick();
  await h.job.tick();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.building, []);
  assert.ok(h.logs.some((l) => l.msg === "provision-parked" && l.code === "policy_denied" && l.step === "github/repo"));
});

test("d1: name_conflict raises one card for (project, step); logs carry codes, never error text", async () => {
  const h = harness({ provision: async () => { throw new StepError("github/repo", "name_conflict", false); } });
  await h.job.tick();
  h.job.retry("p1");
  await h.job.tick();
  assert.deepEqual(h.cards, ["p1/github/repo", "p1/github/repo"], "the card store de-duplicates; the sweep asks once per stop");
  assert.ok(!JSON.stringify(h.logs).includes("ghp_secret"));
});

test("d1: one project's failure does not stop the others; ticks never overlap", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({
    projects: [{ id: "a", slug: "a", name: "A" }, { id: "b", slug: "b", name: "B" }],
    provision: async (p) => { if (p.id === "a") throw new Error("boom"); await gate; },
  });
  const first = h.job.tick();
  assert.equal(await h.job.tick(), 0, "a second tick while one runs does nothing");
  release();
  assert.equal(await first, 1);
  assert.deepEqual(h.building, ["b"]);
  assert.ok(h.logs.some((l) => l.projectId === "a" && l.code === "provision-failed"));
});

test("d1: the name_conflict card is a deduplicable decision card in plain language", async () => {
  const { nameConflictCard } = await import("../dist/provision-sweep.js");
  const c = nameConflictCard({ id: "p1", slug: "shop", name: "Shop" }, "github/repo");
  assert.equal(c.gate, "decision");
  assert.equal(c.action, "provision.name_conflict");
  assert.equal(c.target, "project:p1/github/repo");
  assert.equal(c.projectId, "p1");
  assert.match(c.reason, /rename the project, or tell DevOS to adopt/);
});

test("d1 (pre-review L6): a stage-move failure after a full run is logged, never counted, and the next tick moves it", async () => {
  let fail = true;
  const building = [], logs = [];
  const job = new ProvisionSweepJob({
    listProvisioning: async () => (building.includes("p1") ? [] : [{ id: "p1", slug: "one", name: "One" }]),
    provision: async () => [],
    markBuilding: async (id) => { if (fail) throw new Error("db"); building.push(id); },
    raiseNameConflict: async () => {},
    log: (e) => logs.push(e),
    maxFailures: 1,
  });
  assert.equal(await job.tick(), 0);
  assert.equal(job.isParked("p1"), false);
  assert.equal(logs.at(-1).msg, "provision-mark-building-failed");
  fail = false;
  assert.equal(await job.tick(), 1);
  assert.deepEqual(building, ["p1"]);
});

test("d1 (pre-review M1): a ready() code skips the tick for everyone and counts nothing; a throwing check is a code too", async () => {
  let code = "provision-github-token-not-set";
  const calls = [];
  const job = new ProvisionSweepJob({
    listProvisioning: async () => [{ id: "p1", slug: "one", name: "One" }],
    provision: async (p) => { calls.push(p.id); throw new Error("x"); },
    markBuilding: async () => {},
    raiseNameConflict: async () => {},
    ready: async () => { if (code === "throw") throw new Error("vault down"); return code; },
    log: () => {},
    maxFailures: 1,
  });
  await job.tick();
  code = "throw";
  await job.tick();
  assert.deepEqual(calls, []);
  assert.equal(job.isParked("p1"), false);
  code = null;
  await job.tick();
  assert.deepEqual(calls, ["p1"]);
});

test("PR145-r1: parked projects are excluded before the list limit, so newer projects are never starved", async () => {
  const seen = [];
  const all = Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, slug: `s${i}`, name: `N${i}` }));
  const job = new ProvisionSweepJob({
    // A list limited to 1: without the exclusion, the parked p0 would hide p1 and p2 for ever.
    listProvisioning: async (exclude) => { seen.push([...exclude]); return all.filter((p) => !exclude.includes(p.id)).slice(0, 1); },
    provision: async (p) => { if (p.id === "p0") { const e = new Error("x"); e.name = "StepError"; e.code = "policy_denied"; e.step = "github/repo"; e.retryable = false; throw e; } },
    markBuilding: async (id) => { const i = all.findIndex((p) => p.id === id); all.splice(i, 1); },
    raiseNameConflict: async () => {},
    log: () => {},
  });
  await job.tick();
  assert.equal(job.isParked("p0"), true);
  assert.equal(await job.tick(), 1, "the next tick reaches p1 past the parked p0");
  assert.deepEqual(seen.at(-1), ["p0"]);
});

test("PR145-r1: a name_conflict card that fails to raise is retried on later ticks until delivered, though the project is parked", async () => {
  let failCard = 1;
  const cards = [];
  const job = new ProvisionSweepJob({
    listProvisioning: async (exclude) => [{ id: "p1", slug: "one", name: "One" }].filter((p) => !exclude.includes(p.id)),
    provision: async () => { const e = new Error("x"); e.name = "StepError"; e.code = "name_conflict"; e.step = "github/repo"; e.retryable = false; throw e; },
    markBuilding: async () => {},
    raiseNameConflict: async (p, step) => { if (failCard-- > 0) throw new Error("db down"); cards.push(`${p.id}/${step}`); },
    log: () => {},
  });
  await job.tick();
  assert.equal(job.isParked("p1"), true);
  assert.deepEqual(cards, []);
  await job.tick();
  assert.deepEqual(cards, ["p1/github/repo"], "delivered on a later tick");
  await job.tick();
  assert.deepEqual(cards, ["p1/github/repo"], "delivered once; nothing owed afterwards");
});

// DEVOS-224 (M2.4-d1, docs/modules/M2.4.md): the provisioning sweep, with injected fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ProvisionSweepJob } from "../dist/provision-sweep.js";

class StepError extends Error {
  constructor(step, code, retryable) { super(`${code}: provider said token=ghp_secret`); this.name = "StepError"; this.step = step; this.code = code; this.retryable = retryable; }
}

function harness({ projects = [{ id: "p1", slug: "one" }], provision = async () => [] } = {}) {
  const logs = [], building = [], cards = [], calls = [];
  const job = new ProvisionSweepJob({
    listProvisioning: async () => projects.filter((p) => !building.includes(p.id)),
    provision: async (p) => { calls.push(p.id); return provision(p); },
    markBuilding: async (id) => { building.push(id); },
    raiseNameConflict: async (id, step) => { cards.push(`${id}/${step}`); },
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
    projects: [{ id: "a", slug: "a" }, { id: "b", slug: "b" }],
    provision: async (p) => { if (p.id === "a") throw new Error("boom"); await gate; },
  });
  const first = h.job.tick();
  assert.equal(await h.job.tick(), 0, "a second tick while one runs does nothing");
  release();
  assert.equal(await first, 1);
  assert.deepEqual(h.building, ["b"]);
  assert.ok(h.logs.some((l) => l.projectId === "a" && l.code === "provision-failed"));
});

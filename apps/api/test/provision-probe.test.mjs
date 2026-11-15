// DEVOS-228 (M2.4-d3b, docs/modules/M2.4.md "Part 2"): the AT13 probe's phase machine, with fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeStep, inventoryDiff, probeProvisionOnce, PROBE_EVERY_MS, PROBE_PHASE_MAX_MS } from "../dist/provision-probe.js";

const ROWS = [
  { key: "github_repo", provider: "github", externalId: "1", name: "devos-probe-m24" },
  { key: "coolify_project", provider: "coolify", externalId: "p-1", name: "devos-probe-m24" },
];

function fake(over = {}) {
  const log = [];
  const calls = { provision: 0, inventory: 0, asserts: 0, purge: 0 };
  let t = Date.parse("2026-11-16T00:00:00Z");
  const d = {
    log, calls,
    fingerprint: "fp-1",
    now: () => new Date(t),
    tick: (ms) => { t += ms; },
    offReason: async () => null,
    last: async () => log.at(-1) ?? null,
    record: async (r) => { log.push(structuredClone(r)); },
    provisionOnce: async () => { calls.provision++; return "done"; },
    inventory: async () => { calls.inventory++; return ROWS; },
    liveAsserts: async () => { calls.asserts++; return []; },
    purge: async () => { calls.purge++; return "done"; },
    ...over,
  };
  return d;
}

async function runToEnd(d, max = 20) {
  const ticks = [];
  for (let i = 0; i < max; i++) {
    const r = await probeStep(d);
    ticks.push(r);
    if (r.exit !== 3 || r.code === "skipped" || r.code === "probed") break;
  }
  return ticks;
}

test("a full cycle runs the phases in order, one per tick, and passes once", async () => {
  const d = fake();
  const ticks = await runToEnd(d);
  assert.deepEqual(ticks.map((t) => t.phase), ["inventory1", "run2", "inventory2", "assert", "purge", "done"]);
  assert.deepEqual(ticks.at(-1), { exit: 0, phase: "done", cycle: 1, code: "pass", detail: undefined });
  assert.deepEqual(d.calls, { provision: 2, inventory: 2, asserts: 1, purge: 1 });
  // later ticks within 7 days are skipped with the stored result, and nothing is called
  const again = await probeStep(d);
  assert.deepEqual(again, { exit: 3, phase: "done", cycle: 1, code: "probed", detail: "pass" });
  assert.deepEqual(d.calls, { provision: 2, inventory: 2, asserts: 1, purge: 1 });
});

test("skipped while the sweep is off: no record, no provider call", async () => {
  const d = fake({ offReason: async () => "provision-vault-not-configured" });
  const r = await probeStep(d);
  assert.equal(r.exit, 3);
  assert.equal(r.detail, "provision-vault-not-configured");
  assert.equal(d.log.length, 0);
  assert.equal(d.calls.provision, 0);
});

test("a run still in progress keeps its phase and is resumed next tick", async () => {
  let n = 0;
  const d = fake({ provisionOnce: async () => (++n === 1 ? "in_progress" : "done") });
  const a = await probeStep(d);
  assert.deepEqual([a.exit, a.phase, a.code], [3, "run1", "in_progress"]);
  const b = await probeStep(d);
  assert.equal(b.phase, "inventory1");
});

test("unequal inventories fail with the row named, after the purge", async () => {
  let n = 0;
  const d = fake({ inventory: async () => (++n === 1 ? ROWS : [ROWS[0], { ...ROWS[1], externalId: "p-2" }]) });
  const ticks = await runToEnd(d);
  const end = ticks.at(-1);
  assert.deepEqual([end.exit, end.code, end.detail], [1, "inventory-differs", "differs:coolify_project"]);
  assert.equal(d.calls.purge, 1);
  assert.equal(d.calls.asserts, 0, "live asserts are skipped once the compare failed");
});

test("a failed live assert fails the cycle with its code, after the purge", async () => {
  const d = fake({ liveAsserts: async () => ["default-branch-not-main"] });
  const end = (await runToEnd(d)).at(-1);
  assert.deepEqual([end.exit, end.code, end.detail], [1, "live-assert-failed", "default-branch-not-main"]);
  assert.equal(d.calls.purge, 1);
});

test("a failed run purges what it created, then fails with the run's code", async () => {
  const d = fake({ provisionOnce: async () => ({ error: "provider_error" }) });
  const end = (await runToEnd(d)).at(-1);
  assert.deepEqual([end.exit, end.code, end.detail], [1, "run1-failed", "provider_error"]);
  assert.equal(d.calls.purge, 1);
});

test("a refused purge fails with purge-failed and its code; nothing else is tried", async () => {
  const d = fake({ purge: async () => ({ error: "purge-permission" }) });
  const end = (await runToEnd(d)).at(-1);
  assert.deepEqual([end.exit, end.code, end.detail], [1, "purge-failed", "purge-permission"]);
});

test("a new cycle starts after 7 days, or at once when the provisioning code changed", async () => {
  const d = fake();
  await runToEnd(d);
  d.tick(PROBE_EVERY_MS - 1);
  assert.equal((await probeStep(d)).code, "probed");
  d.tick(1);
  const r = await probeStep(d);
  assert.deepEqual([r.cycle, r.phase], [2, "inventory1"]);

  const e = fake();
  await runToEnd(e);
  e.fingerprint = "fp-2";
  const s = await probeStep(e);
  assert.deepEqual([s.cycle, s.phase], [2, "inventory1"]);
});

test("inventoryDiff ignores row order and names a missing or extra row", () => {
  assert.equal(inventoryDiff(ROWS, [...ROWS].reverse()), null);
  assert.equal(inventoryDiff(ROWS, [ROWS[0]]), "missing-in-run2:coolify_project");
  assert.equal(inventoryDiff([ROWS[0]], ROWS), "extra-in-run2:coolify_project");
});

test("inventoryDiff flags a key recorded twice in one run", () => {
  assert.equal(inventoryDiff([...ROWS, ROWS[0]], ROWS), "duplicate-in-run1:github_repo");
});

test("a run or purge in progress for longer than the phase limit ends the cycle as a timeout", async () => {
  const d = fake({ provisionOnce: async () => "in_progress" });
  assert.equal((await probeStep(d)).code, "in_progress");
  d.tick(PROBE_PHASE_MAX_MS);
  const r = await probeStep(d);
  assert.deepEqual([r.phase, r.code], ["purge", "in_progress"]);
  const end = await probeStep(d);
  assert.deepEqual([end.exit, end.code, end.detail], [1, "run1-failed", "timeout"]);

  const e = fake({ purge: async () => "in_progress" });
  for (let i = 0; i < 5; i++) await probeStep(e); // run1 .. assert, now in purge
  assert.equal(e.log.at(-1).phase, "purge");
  e.tick(PROBE_PHASE_MAX_MS);
  const p = await probeStep(e);
  assert.deepEqual([p.exit, p.code, p.detail], [1, "purge-failed", "timeout"]);
});

const P = { id: "11111111-1111-4111-8111-111111111111", slug: "devos-probe-m24", name: "probe" };
const stop = (code, retryable) => Object.assign(new Error("provider said: secret-ish text"), { name: "StepError", code, retryable });

test("probeProvisionOnce: done, a missing token, a retryable stop, a final stop (fixed codes only)", async () => {
  const pv = (ready, run) => ({ ready: async () => ready, run });
  assert.equal(await probeProvisionOnce(pv(null, async () => ({})), P), "done");
  let ran = false;
  assert.deepEqual(await probeProvisionOnce(pv("provision-github-token-not-set", async () => { ran = true; }), P), { error: "provision-github-token-not-set" });
  assert.equal(ran, false, "nothing runs without both tokens");
  assert.equal(await probeProvisionOnce(pv(null, async () => { throw stop("provider_error", true); }), P), "in_progress");
  const r = await probeProvisionOnce(pv(null, async () => { throw stop("name_conflict", false); }), P);
  assert.deepEqual(r, { error: "name_conflict" });
  assert.equal(JSON.stringify(r).includes("secret-ish"), false);
  assert.equal(await probeProvisionOnce(pv(null, async () => { throw new Error("boom"); }), P), "in_progress");
});

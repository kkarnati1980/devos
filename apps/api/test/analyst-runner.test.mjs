// M2.2-d3b1: the analyst model pass as one M1.5 run per call (contract docs/modules/M2.2.md, "M2.2-d3b").
// The real RunEngine, M1.7 PolicyEngine and Claude adapter (with a fake SDK query) over the memory stores.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { MemoryPolicyStore, PolicyEngine } from "@devos/policy";
import { ClaudeAgentSdkAdapter, MemoryRunStore, RunEngine } from "@devos/run-engine";
import { MemoryRequirementsStore } from "@devos/analyst";
import { Approvals, MemoryApprovalStore } from "../dist/approvals.js";
import { requirementsServices } from "../dist/runtime.js";
import { runEngineModelRunner, ANALYST_MODEL, ANALYST_MAX_OUTPUT_BYTES, AnalystRunSweepJob, ANALYST_SWEEP_BATCH, ANALYST_SWEEP_MS } from "../dist/analyst-runner.js";

const P1 = "4b7d1c1e-2f6a-4a8e-9d55-0c1f2a3b4c5d";
// The overview paragraph is not yet a requirement, so the model pass is called (the M2.2-d1 PL6 fixture).
const SPEC = `# Bakery app

## Overview

The shop owner can publish a daily menu with prices for each bread.

## Phase 1: Launch

- FR-1: Owner login
`;

/** The task/run rows over MemoryRunStore (the Postgres twin is PrismaAnalystRunRows, test-db). */
function memoryRows(runStore) {
  const tasks = new Map();
  let n = 0;
  return {
    tasks,
    created: [],
    async createRun(input) {
      const taskId = `task-${++n}`;
      tasks.set(taskId, { kind: "analysis", assignee: "agent", status: "running", title: input.title, projectId: input.projectId });
      const runId = `run-${randomBytes(4).toString("hex")}`;
      runStore.envelopes.set(runId, input.envelope);
      runStore.runs.set(runId, { id: runId, taskId, projectId: input.projectId, role: "analyst", model: input.model, attempt: 1, status: "queued", maxTurns: input.maxTurns, maxSeconds: input.maxSeconds, maxCostUsd: input.maxCostUsd, turns: 0 });
      this.created.push({ runId, ...input });
      return runId;
    },
    async textEvents(runId) {
      return runStore.events.filter((e) => e.runId === runId && e.type === "text").sort((a, b) => a.seq - b.seq).map((e) => e.payload.text);
    },
    async finishTask(runId, ok) {
      tasks.get(runStore.runs.get(runId).taskId).status = ok ? "done" : "failed";
    },
  };
}

/** A fake Agent SDK query: one assistant turn whose text is `text`, then a result with `cost`. Records its options. */
function sdk(text, { cost = 0.02, fail = false, calls = [] } = {}) {
  return ({ options }) => (calls.push({ ...options, cwdExisted: existsSync(options.cwd) }), async function* () {
    yield { type: "system", subtype: "init", session_id: "s1" };
    if (fail) throw Object.assign(new Error("bad request"), { status: 400 });
    yield { type: "assistant", message: { model: ANALYST_MODEL, content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 50 } } };
    yield { type: "result", subtype: "success", is_error: false, total_cost_usd: cost, result: "ok" };
  })();
}

function setup({ text = "", budgets = [], fail = false, mode = "observe" } = {}) {
  const runStore = new MemoryRunStore();
  const pstore = new MemoryPolicyStore({ mode });
  const policy = new PolicyEngine({ store: pstore, hmacKey: randomBytes(32), budgets });
  const calls = [];
  const engine = new RunEngine({ store: runStore, policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: sdk(text, { fail, calls }) }) });
  const rows = memoryRows(runStore);
  const reqStore = new MemoryRequirementsStore();
  reqStore.addProject({ id: P1, name: "Shop", stage: "intake" });
  const approvalStore = new MemoryApprovalStore();
  const approvals = new Approvals({ store: approvalStore, grants: { issueGrant: async () => ({ id: "g" }) }, notifier: null, verifyKkSession: () => false });
  const svc = requirementsServices(reqStore, approvals, approvalStore, runEngineModelRunner(rows, engine));
  return { runStore, rows, reqStore, svc, pstore, calls };
}

const proposal = (blocks) => JSON.stringify({ requirements: [{ block: blocks, title: "Owner publishes daily menu with prices" }], criteria: [] });

test("AT-MR1 one analysis task and one analyst run (Sonnet, max_turns 2, one turn used); the run's text is the model output", async () => {
  // Block 2 is the overview paragraph (blocks: title, Overview, paragraph, Phase 1, FR-1).
  const s = setup({ text: proposal(2) });
  const r = await s.svc.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  assert.equal(r.counts.proposed, 1, "a grounded proposal from the run's text was stored");
  assert.deepEqual(r.warnings, []);
  assert.equal(s.rows.created.length, 1);
  const [c] = s.rows.created;
  assert.equal(c.projectId, P1);
  assert.equal(c.model, "claude-sonnet-5-5");
  assert.equal(c.maxTurns, 2);
  const run = s.runStore.runs.get(c.runId);
  assert.equal(run.role, "analyst");
  assert.equal(s.runStore.finished.get(c.runId).status, "succeeded");
  assert.equal(s.runStore.finished.get(c.runId).turns, 1);
  const task = s.rows.tasks.get(run.taskId);
  assert.deepEqual([task.kind, task.assignee, task.status], ["analysis", "agent", "done"]);
  // Pre-review finding 1: the run's envelope is deny-all, so the model may only answer in text, and it works in a
  // private empty directory that is removed afterwards.
  const env = s.runStore.envelopes.get(c.runId);
  assert.deepEqual([env.tools, env.readPaths, env.writePaths, env.network, env.networkAllowList], [[], [], [], false, null]);
  assert.equal(env.maxCostUsd, 0.5);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.calls[0].allowedTools, [], "the adapter is given the envelope's empty tool list");
  assert.equal(s.calls[0].model, "claude-sonnet-5-5");
  assert.ok(s.calls[0].cwd.startsWith(tmpdir()) && s.calls[0].cwd !== tmpdir() && /devos-analyst-/.test(s.calls[0].cwd));
  assert.equal(s.calls[0].cwdExisted, true);
  assert.equal(existsSync(s.calls[0].cwd), false, "the working directory is removed");
});

test("AT-MR2 the engine records the cost (one cost_entry for the run); the runner adds none of its own", async () => {
  const s = setup({ text: "{}" });
  await s.svc.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  const [c] = s.rows.created;
  const costs = s.runStore.costs.filter((x) => x.runId === c.runId);
  assert.equal(costs.length, 1);
  assert.equal(costs[0].role, "analyst");
  assert.ok(Math.abs(costs[0].usd - 0.02) < 1e-9);
  assert.equal(s.runStore.costs.length, 1);
  assert.equal(s.runStore.finished.get(c.runId).status, "succeeded");
  const res = s.pstore.reservations.filter((x) => x.runId === c.runId);
  assert.equal(res.length, 1, "one M1.7 reservation for the run");
  assert.equal(res[0].status, "reconciled");
  assert.ok(Math.abs(res[0].actualUsd - 0.02) < 1e-9);
});

test("AT-MR3 an adapter error and a budget stop each give assist-failed with the deterministic requirements kept", async () => {
  const cases = {
    "adapter error": setup({ fail: true }),
    "budget stop (the project budget refuses the reservation)": setup({ text: "{}", budgets: [{ id: "cap", projectId: P1, maxCostUsd: 0.01, maxTokens: 10_000_000 }], mode: "enforce" }),
  };
  for (const [name, s] of Object.entries(cases)) {
    const r = await s.svc.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
    assert.deepEqual(r.warnings, ["assist-failed"], name);
    assert.ok(s.reqStore.requirements.get(P1).has("FR-1"), `${name}: deterministic FR-1 stored`);
    assert.equal(r.counts.proposed, 0, name);
    const [c] = s.rows.created;
    assert.notEqual(s.runStore.finished.get(c.runId)?.status, "succeeded", name);
    assert.equal(s.rows.tasks.get(s.runStore.runs.get(c.runId).taskId).status, "failed", `${name}: task closed as failed`);
  }
});

test("AT-MR4 output over 256 KiB is refused before the validator", async () => {
  // Valid JSON the validator would accept, padded past the cap: only the byte cap can refuse it.
  const s = setup({ text: `{"requirements":[],"criteria":[],"pad":"${"x".repeat(ANALYST_MAX_OUTPUT_BYTES)}"}` });
  const r = await s.svc.pipeline.submitSpec(P1, { kind: "paste", text: SPEC });
  assert.deepEqual(r.warnings, ["assist-failed"]);
  const runner = runEngineModelRunner(s.rows, { execute: async () => ({ status: "succeeded" }) });
  s.rows.textEvents = async () => ["é".repeat(ANALYST_MAX_OUTPUT_BYTES / 2 + 1)];
  s.rows.createRun = async () => "r-x";
  s.rows.finishTask = async () => {};
  const ok = setup({ text: '{"requirements":[],"criteria":[],"pad":"x"}' });
  assert.deepEqual((await ok.svc.pipeline.submitSpec(P1, { kind: "paste", text: SPEC })).warnings, [], "the same output under the cap is accepted");
  await assert.rejects(runner({ prompt: "p", tag: "analyst_assist", projectId: P1 }), /analyst-output-too-long/, "bytes, not characters");
  await assert.rejects(runner({ prompt: "p", tag: "analyst_assist" }), /analyst-run-no-project/);
});

test("AT-MR5 buildRuntime keeps the model pass off without loadAnalystEngine; with it, the runner records a run over the database", async () => {
  const { buildRuntime } = await import("../dist/runtime.js");
  const { KkSessionRegistry } = await import("../dist/auth.js");
  const env = { DATABASE_URL: "postgresql://x/y", DEVOS_POLICY_HMAC_KEY: "test-only-policy-hmac-key-0123456789abcdef" };
  const writes = [];
  const tx = {
    $queryRaw: async () => [],
    task: { create: async (a) => (writes.push(["task.create", a.data]), { id: "t1" }), update: async (a) => writes.push(["task.update", a.where, a.data]) },
    run: { create: async (a) => (writes.push(["run.create", a.data]), { id: "r1" }), findUnique: async () => ({ taskId: "t1" }), updateMany: async (a) => writes.push(["run.updateMany", a.where, a.data.status, a.data.error]) },
    capabilityEnvelope: { create: async (a) => writes.push(["capabilityEnvelope.create", a.data]) },
    runEvent: { findMany: async (a) => (writes.push(["runEvent.findMany", a.where, a.orderBy]), [{ payload: { text: "{" } }, { payload: { text: "}" } }]) },
  };
  const db = { $transaction: async (fn) => fn(tx) };
  const opts = { outboundTimeoutMs: 500, kkSessions: new KkSessionRegistry(), loadDb: async () => db };
  const off = await buildRuntime(env, opts);
  assert.equal(off.requirements.pipeline.ports.runner, null, "no engine → deterministic only");

  const seen = [];
  const on = await buildRuntime(env, { ...opts, loadAnalystEngine: async (d, policy) => {
    seen.push([d === db, typeof policy.decide]);
    return { execute: async (input) => (seen.push(input), { status: "succeeded" }) };
  } });
  const runner = on.requirements.pipeline.ports.runner;
  assert.equal(typeof runner, "function");
  assert.deepEqual(seen[0], [true, "function"], "the engine is built over this database and the M1.7 policy engine");
  assert.deepEqual(await runner({ prompt: "p", tag: "analyst_assist", projectId: P1 }), { output: "{}" });
  assert.deepEqual(writes[0], ["task.create", { projectId: P1, kind: "analysis", assignee: "agent", title: "Analyst assist", status: "running" }]);
  assert.deepEqual(writes[1], ["run.create", { taskId: "t1", projectId: P1, role: "analyst", model: "claude-sonnet-5-5", maxTurns: 2, maxSeconds: 90, maxCostUsd: "0.500000" }]);
  const envRow = writes[2][1];
  assert.equal(writes[2][0], "capabilityEnvelope.create");
  assert.deepEqual({ ...envRow, expiresAt: undefined }, { runId: "r1", tools: [], readPaths: [], writePaths: [], network: false, networkAllowList: null, maxCostUsd: "0.500000", maxTokens: 200000, maxConcurrency: 1, expiresAt: undefined, depth: 0 });
  assert.ok(envRow.expiresAt instanceof Date && envRow.expiresAt.getTime() > Date.now());
  assert.match(seen[1].cwd, /devos-analyst-/);
  assert.deepEqual(seen[1], { runId: "r1", provider: "anthropic", prompt: "p", cwd: seen[1].cwd, tag: "analyst_assist" });
  assert.deepEqual(writes[3], ["runEvent.findMany", { runId: "r1", type: "text" }, { seq: "asc" }]);
  assert.deepEqual(writes[4], ["task.update", { id: "t1" }, { status: "done" }]);
  assert.equal(writes.length, 5, "a succeeded run is not touched");

  // Pre-review finding 2: an engine that throws (in-process, never re-queued) leaves no run queued or running.
  writes.length = 0;
  const thrown = await buildRuntime(env, { ...opts, loadAnalystEngine: async () => ({ execute: async () => { throw new Error("store down"); } }) });
  await assert.rejects(thrown.requirements.pipeline.ports.runner({ prompt: "p", tag: "analyst_assist", projectId: P1 }), /store down/);
  assert.deepEqual(writes.slice(-2), [["task.update", { id: "t1" }, { status: "failed" }], ["run.updateMany", { id: "r1", status: { in: ["queued", "running"] } }, "failed", "analyst-run-abandoned"]]);

  // A paused project: the engine returns without running; the run is closed as paused, not abandoned (round 2, 2).
  writes.length = 0;
  const paused = await buildRuntime(env, { ...opts, loadAnalystEngine: async () => ({ execute: async () => ({ status: "paused" }) }) });
  await assert.rejects(paused.requirements.pipeline.ports.runner({ prompt: "p", tag: "analyst_assist", projectId: P1 }), /analyst-run-paused/);
  assert.deepEqual(writes.at(-1), ["run.updateMany", { id: "r1", status: { in: ["queued", "running"] } }, "failed", "analyst-run-paused"]);
});

test("AT-MR7b (DEVOS-161) the runner's policy lock key is M1.7's", async () => {
  const { readFile } = await import("node:fs/promises");
  const { POLICY_LOCK_KEY } = await import("../dist/analyst-runner.js");
  const src = await readFile(new URL("../../../packages/policy/src/prisma-store.ts", import.meta.url), "utf8");
  assert.match(src, new RegExp(`const LOCK_KEY = "${POLICY_LOCK_KEY}";`));
});

test("AT-MR8 (DEVOS-171) the sweep closes each stale run once, logs a failure by id and moves on, never overlaps, and is wired by buildRuntime", async () => {
  const closed = [], logs = [];
  let listed = 0;
  const sweeper = {
    staleRunIds: async (limit) => (listed++, assert.equal(limit, ANALYST_SWEEP_BATCH), ["r1", "r2", "r3"]),
    closeStale: async (id) => { if (id === "r2") throw new Error("db down: secret text"); closed.push(id); return id === "r1"; },
  };
  const job = new AnalystRunSweepJob(sweeper, (e) => logs.push(e));
  assert.equal(job.intervalMs, ANALYST_SWEEP_MS);
  assert.equal(await job.tick(), 1, "r1 closed; r3 was no longer stale (closeStale false); r2 failed");
  assert.deepEqual(closed, ["r1", "r3"]);
  assert.deepEqual(logs, [{ level: "warn", msg: "analyst-sweep-failed", runId: "r2" }], "a fixed code and the run id, never the error text");

  // A failed listing is logged once and the pass ends.
  logs.length = 0;
  const down = new AnalystRunSweepJob({ staleRunIds: async () => { throw new Error("down"); }, closeStale: async () => assert.fail("no close") }, (e) => logs.push(e));
  assert.equal(await down.tick(), 0);
  assert.deepEqual(logs, [{ level: "warn", msg: "analyst-sweep-list-failed" }]);

  // Ticks never overlap.
  let release;
  const slow = new AnalystRunSweepJob({ staleRunIds: () => new Promise((r) => { release = () => r([]); }), closeStale: async () => true }, () => {});
  const first = slow.tick();
  assert.equal(await slow.tick(), null, "a tick during a running tick does nothing");
  release();
  assert.equal(await first, 0);

  // start() runs the start-up pass at once; stop() clears the timer.
  listed = 0;
  job.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(listed, 1, "start-up sweep");
  job.stop();

  // buildRuntime returns the sweep with the database wired, and none without one.
  const { buildRuntime } = await import("../dist/runtime.js");
  const { KkSessionRegistry } = await import("../dist/auth.js");
  const opts = { outboundTimeoutMs: 500, kkSessions: new KkSessionRegistry(), loadDb: async () => ({ $transaction: async (fn) => fn({ $queryRaw: async () => [] }) }) };
  const off = await buildRuntime({}, opts);
  assert.equal(off.analystSweep, null);
  const on = await buildRuntime({ DATABASE_URL: "postgresql://x/y", DEVOS_POLICY_HMAC_KEY: "test-only-policy-hmac-key-0123456789abcdef" }, opts);
  assert.ok(on.analystSweep instanceof AnalystRunSweepJob);
  assert.equal(await on.analystSweep.tick(), 0, "an empty stale list closes nothing");
});

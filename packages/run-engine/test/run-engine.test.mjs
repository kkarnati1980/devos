// M1.5 acceptance tests against MemoryRunStore + the real M1.7 PolicyEngine (MemoryPolicyStore).
// Postgres (PrismaRunStore) and BullMQ/Redis tests live in test-db/ (workflow run-engine-db).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryPolicyStore, PolicyEngine } from "@devos/policy";
import { ClaudeAgentSdkAdapter, CodexExecAdapter, MemoryRunStore, RunEngine, backoffDelay, settleOutcome, RETRYABLE } from "../dist/index.js";

const KEY = randomBytes(32);
const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

function setup({ budgets = [], maxTurns = 50, maxSeconds = 600, maxCostUsd = 5 } = {}) {
  const store = new MemoryRunStore();
  const pstore = new MemoryPolicyStore({ mode: "observe" });
  const policy = new PolicyEngine({ store: pstore, hmacKey: KEY, budgets });
  const runId = `run-${randomBytes(4).toString("hex")}`;
  store.runs.set(runId, { id: runId, taskId: "task-1", projectId: "proj-1", role: "builder", model: "claude-sonnet", attempt: 1, status: "queued", maxTurns, maxSeconds, maxCostUsd, turns: 0 });
  return { store, pstore, policy, runId };
}

/** A fake Agent SDK `query`: n assistant turns with usage and a tool result, then a result message. */
function fakeQuery({ turns = 2, cost = 0.12, hang = false, calls = [], throwAfter = false, failFirst = 0 } = {}) {
  return ({ prompt, options }) => {
    calls.push({ prompt, options });
    return (async function* () {
      if (failFirst > 0 && calls.length <= failFirst) throw Object.assign(new Error("rate"), { status: 429 });
      yield { type: "system", subtype: "init", session_id: options.resume ?? "sess-1" };
      for (let t = 1; t <= turns; t++) {
        yield { type: "assistant", message: { model: "claude-sonnet", content: [{ type: "text", text: `t${t}` }, { type: "tool_use", id: `u${t}`, name: "Read", input: {} }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 10 } } };
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `u${t}`, content: "y".repeat(64) }] } };
      }
      if (throwAfter) throw Object.assign(new Error("overloaded"), { status: 529 });
      if (hang) {
        await new Promise((resolve, reject) => {
          if (options.abortController.signal.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          options.abortController.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      }
      yield { type: "result", subtype: "success", is_error: false, total_cost_usd: cost, result: "done" };
    })();
  };
}

/** Codex adapter whose binary is `node fake-codex.mjs`. */
function fakeCodexAdapter(mode, extra = {}, args) {
  const a = new CodexExecAdapter({ ...(args ? { args } : {}), bin: process.execPath, estimateUsd: 0.4, prices: { "gpt-codex": { input: 1, cachedInput: 0.1, output: 10 } }, env: { FAKE_CODEX_MODE: mode, ...extra }, killGraceMs: 1000, scriptArgs: [FAKE_CODEX] });
  return a;
}

/** Alive = exists and is not a zombie (a killed orphan may wait for PID 1 to reap it). */
function alive(pid) {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z";
  } catch {
    return false;
  }
}

function assertGapless(store, runId) {
  const evs = store.events.filter((e) => e.runId === runId);
  evs.forEach((e, i) => assert.equal(e.seq, i + 1, "gapless seq"));
  return evs;
}

test("AT1 Claude adapter: gapless numbered events ending in done; cost from the SDK result", async () => {
  const s = setup();
  const engine = new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery() }) });
  const out = await engine.execute({ runId: s.runId, provider: "anthropic", prompt: "build", cwd: "." });
  assert.equal(out.status, "succeeded");
  const evs = assertGapless(s.store, s.runId);
  assert.equal(evs.at(-1).type, "done");
  assert.ok(evs.some((e) => e.type === "tool_call") && evs.some((e) => e.type === "tool_result") && evs.some((e) => e.type === "usage"));
  assert.equal(s.store.costs.length, 1);
  assert.equal(s.store.costs[0].usd, 0.12);
  assert.equal(out.costEstimated, false);
});

test("AT1 Codex adapter: gapless events ending in done; a failing exec ends in a typed error", async () => {
  for (const [mode, last, status] of [["ok", "done", "succeeded"], ["fail", "error", "failed"]]) {
    const s = setup();
    const engine = new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => fakeCodexAdapter(mode) });
    s.store.runs.get(s.runId).model = "gpt-codex";
    const out = await engine.execute({ runId: s.runId, provider: "openai", prompt: "review", cwd: ".", reserveUsd: 0.4 });
    assert.equal(out.status, status, mode);
    const evs = assertGapless(s.store, s.runId);
    assert.equal(evs.at(-1).type, last, mode);
    if (last === "error") assert.equal(evs.at(-1).payload.type, "provider_error");
  }
});

test("AT2 cancel stops each runtime within 10 s and records cancelled", async () => {
  // Claude: SDK abort controller.
  {
    const s = setup();
    const engine = new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ hang: true }) }) });
    const p = engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." });
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    assert.equal(await engine.cancel(s.runId), true);
    const out = await p;
    assert.ok(Date.now() - t0 < 10_000);
    assert.equal(out.status, "cancelled");
    assert.equal(s.store.finished.get(s.runId).status, "cancelled");
    assert.equal(s.store.errors.at(-1).type, "cancelled");
    assert.equal(s.store.errors.at(-1).countsAsAttempt, false);
  }
  // Codex: process-group kill, including a grandchild that ignores nothing and a parent that ignores TERM.
  {
    const s = setup();
    const pidfile = join(mkdtempSync(join(tmpdir(), "m15-")), "gc.pid");
    const engine = new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => fakeCodexAdapter("hang", { FAKE_CODEX_PIDFILE: pidfile }) });
    const p = engine.execute({ runId: s.runId, provider: "openai", prompt: "x", cwd: ".", reserveUsd: 0.4 });
    for (let i = 0; i < 50 && !existsSync(pidfile); i++) await new Promise((r) => setTimeout(r, 50));
    const gc = Number(readFileSync(pidfile, "utf8"));
    const t0 = Date.now();
    await engine.cancel(s.runId);
    const out = await p;
    assert.ok(Date.now() - t0 < 10_000, "cancelled within 10 s");
    assert.equal(out.status, "cancelled");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(alive(gc), false, "grandchild killed with the group");
    assert.equal(assertGapless(s.store, s.runId).at(-1).type, "error");
  }
});

test("AT3 budget exceeded → paused at a checkpoint, card raised, project paused, not an attempt", async () => {
  const s = setup({ budgets: [{ id: "proj-cap", projectId: "proj-1", maxCostUsd: 1, maxTokens: 10_000_000 }], maxCostUsd: 5 });
  let started = false;
  const engine = new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => ({ ...new ClaudeAgentSdkAdapter({ query: fakeQuery() }), start: async () => { started = true; } }) });
  const out = await engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(out.status, "limit_hit");
  assert.equal(out.errorType, "budget_exceeded");
  assert.equal(out.countsAsAttempt, false);
  assert.equal(started, false, "the runtime never starts");
  assert.ok(s.store.checkpoints.some((c) => c.runId === s.runId), "checkpoint written");
  assert.equal(s.store.cards.length, 1);
  assert.equal(s.store.cards[0].action, "raise-budget");
  assert.ok(s.store.paused.has("proj-1"), "project paused");
  assert.deepEqual(s.store.errors.map((e) => [e.type, e.countsAsAttempt]), [["budget_exceeded", false]]);
  assert.equal(assertGapless(s.store, s.runId).at(-1).type, "error");
  // The next run of a paused project does not start.
  const s2runId = "run-next";
  s.store.runs.set(s2runId, { ...s.store.runs.get(s.runId), id: s2runId, status: "queued" });
  const out2 = await engine.execute({ runId: s2runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(out2.status, "paused");
  assert.equal(s.pstore.decisions.length, 1, "no policy decision for a paused project");
});

test("AT3b cost over the run's max_cost_usd ends limit_hit, pauses and raises a card", async () => {
  const s = setup({ maxCostUsd: 0.1 });
  const engine = new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ cost: 0.25 }) }) });
  const out = await engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(out.status, "limit_hit");
  assert.equal(out.errorType, "budget_exceeded");
  assert.equal(s.store.cards.length, 1);
  assert.ok(s.store.paused.has("proj-1"));
});

test("AT4 every Claude and Codex run has a reservation and a reconciled actual (or a flagged estimate)", async () => {
  const s = setup();
  const engine = new RunEngine({ store: s.store, policy: s.policy, adapterFor: (p) => (p === "anthropic" ? new ClaudeAgentSdkAdapter({ query: fakeQuery() }) : fakeCodexAdapter("ok")) });
  await engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." });
  const codexRun = "run-codex";
  s.store.runs.set(codexRun, { ...s.store.runs.get(s.runId), id: codexRun, model: "gpt-codex", status: "queued" });
  const metered = await engine.execute({ runId: codexRun, provider: "openai", prompt: "x", cwd: ".", reserveUsd: 0.4 });
  const estRun = "run-codex-est";
  s.store.runs.set(estRun, { ...s.store.runs.get(s.runId), id: estRun, model: "gpt-codex", status: "queued" });
  const engineNoUsage = new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => fakeCodexAdapter("nousage") });
  const est = await engineNoUsage.execute({ runId: estRun, provider: "openai", prompt: "x", cwd: ".", reserveUsd: 0.4 });

  const res = s.pstore.reservations;
  assert.equal(res.length, 3, "one reservation per run");
  assert.ok(res.every((r) => r.status === "reconciled" && r.actualUsd !== null));
  // Codex metered: (1600 input + 400 cached·0.1 + 100 output·10) per M → 0.00264
  assert.equal(metered.costEstimated, false);
  assert.ok(Math.abs(metered.costUsd - (1600 * 1 + 400 * 0.1 + 100 * 10) / 1e6) < 1e-12);
  assert.equal(est.costEstimated, true, "no usage → flagged estimate");
  assert.equal(est.costUsd, 0.4);
  assert.equal(s.store.costs.length, 3);
});

test("AT5 telemetry rows per turn with token counts and tool-result bytes; selection tokens tagged", async () => {
  const s = setup();
  const engine = new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ turns: 3 }) }) });
  await engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: ".", tag: "standard_selection" });
  const rows = s.store.telemetry.filter((t) => t.runId === s.runId);
  assert.deepEqual(rows.map((r) => r.turn), [1, 2, 3]);
  for (const r of rows) {
    assert.equal(r.inputTokens, 100);
    assert.equal(r.outputTokens, 20);
    assert.equal(r.cacheReadTokens, 300);
    assert.equal(r.contextTokens, 410);
    assert.equal(r.tag, "standard_selection");
  }
  assert.deepEqual(rows.map((r) => r.toolResultBytes), [0, 64, 64]);
  // Codex telemetry: per turn too.
  const c = setup();
  c.store.runs.get(c.runId).model = "gpt-codex";
  await new RunEngine({ store: c.store, policy: c.policy, adapterFor: () => fakeCodexAdapter("ok") }).execute({ runId: c.runId, provider: "openai", prompt: "x", cwd: ".", reserveUsd: 0.4 });
  assert.deepEqual(c.store.telemetry.map((r) => [r.turn, r.inputTokens, r.cacheReadTokens, r.outputTokens]), [[1, 800, 200, 50], [2, 800, 200, 50]]);
  assert.equal(c.store.telemetry[0].tag, undefined, "untagged unless the run is a selection run");
});

test("AT6 a killed run resumes from its checkpoint (same session, gapless seq, turns continue)", async () => {
  const s = setup();
  // The worker dies when appending the 6th event (after turn 1's usage event and checkpoint).
  s.store.failAppendAt = 7;
  const calls = [];
  const e1 = new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ turns: 2, calls }) }) });
  await assert.rejects(e1.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." }), /store-down/);
  const cp = await s.store.latestCheckpoint(s.runId);
  assert.ok(cp && cp.data.turn >= 1, "checkpoint survived");
  const seqBefore = await s.store.lastEventSeq(s.runId);
  assert.equal(cp.data.lastSeq <= seqBefore, true);

  s.store.failAppendAt = null;
  const e2 = new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ turns: 1, calls }) }) });
  const out = await e2.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(out.status, "succeeded");
  assert.equal(calls[1].options.resume, "sess-1", "resumed the same SDK session");
  const evs = assertGapless(s.store, s.runId);
  assert.equal(evs.find((e) => e.seq === seqBefore + 1).payload.state, "resumed");
  assert.equal(out.turns, cp.data.turn + 1, "turn count continues from the checkpoint");
  assert.equal(evs.at(-1).type, "done");
  // The interrupted attempt's reservation was settled, the resumed one reserved anew.
  assert.equal(s.pstore.reservations.length, 2);
  assert.ok(s.pstore.reservations.every((r) => r.status !== "reserved"));
});

test("AT7 limits: max turns and max seconds end limit_hit and never count as an attempt", async () => {
  const s = setup({ maxTurns: 2 });
  const out = await new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ turns: 5, hang: true }) }) }).execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(out.status, "limit_hit");
  assert.equal(s.store.errors.at(-1).message, "max-turns");
  assert.equal(out.countsAsAttempt, false);
  const t = setup({ maxSeconds: 1 });
  const t0 = Date.now();
  const out2 = await new RunEngine({ store: t.store, policy: t.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ turns: 1, hang: true }) }) }).execute({ runId: t.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(out2.status, "limit_hit");
  assert.equal(out2.errorType, "timeout");
  assert.ok(Date.now() - t0 < 5000);
});

test("AT8 policy denial (envelope) stops before the runtime, raises a card, not an attempt", async () => {
  const s = setup();
  s.store.envelopes.set(s.runId, { tools: ["Read"], readPaths: ["src"], writePaths: [], network: false, networkAllowList: null, maxCostUsd: 0.5, maxTokens: 1000, maxConcurrency: 1, expiresAt: Date.now() + 60_000, depth: 1 });
  const out = await new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery() }) }).execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." });
  // reserve = remaining max_cost_usd (5) > envelope maxCostUsd (0.5) → envelope deny, enforced in observe.
  assert.equal(out.status, "failed");
  assert.equal(out.errorType, "policy_denied");
  assert.equal(out.countsAsAttempt, false);
  assert.equal(s.store.cards[0].action, "review-policy-denial");
  assert.equal(s.store.paused.size, 0, "a policy denial does not pause the project");
});

test("AT9 retries: backoff is exponential with full jitter; non-retryable errors are never retried", async () => {
  const p = { baseMs: 1000, maxMs: 8000 };
  assert.equal(backoffDelay(1, p, () => 0.999999), 999);
  assert.equal(backoffDelay(3, p, () => 0.999999), 3999);
  assert.equal(backoffDelay(10, p, () => 0.999999), 7999, "capped");
  assert.equal(backoffDelay(4, p, () => 0), 0);
  assert.deepEqual([...RETRYABLE].sort(), ["provider_error", "rate_limited", "timeout"]);
  const base = { runId: "r", costUsd: 0, costEstimated: false, turns: 0, lastSeq: 1, countsAsAttempt: true };
  assert.throws(() => settleOutcome({ ...base, status: "failed", errorType: "internal", retryable: false }), (e) => e.name === "UnrecoverableError");
  assert.throws(() => settleOutcome({ ...base, status: "failed", errorType: "rate_limited", retryable: true }), (e) => e.name === "RunFailure");
  assert.equal(settleOutcome({ ...base, status: "limit_hit", errorType: "budget_exceeded", retryable: false }).status, "limit_hit", "a budget stop is not a queue failure");
});

test("AT10 a tool gate (policy) can deny a tool call through the SDK canUseTool hook", async () => {
  const calls = [];
  const a = new ClaudeAgentSdkAdapter({ query: fakeQuery({ calls }), toolGate: async (tool) => tool === "Read" });
  await a.start({ runId: "r", taskId: "t", projectId: "p", role: "builder", model: "m", provider: "anthropic", prompt: "x", cwd: "." }, null);
  for await (const _ of a.events());
  const gate = calls[0].options.canUseTool;
  assert.equal((await gate("Read", {})).behavior, "allow");
  assert.equal((await gate("Bash", {})).behavior, "deny");
});

// ---- Codex PR16-r1 regressions ----

test("r1-1 an SDK error after billable turns charges the whole reservation (fail-closed), flagged estimated", async () => {
  const s = setup({ maxCostUsd: 2 });
  const out = await new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ turns: 2, throwAfter: true }) }) }).execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(out.status, "failed");
  assert.equal(out.costUsd, 2);
  assert.equal(out.costEstimated, true);
  assert.equal(s.pstore.reservations[0].status, "reconciled");
  assert.equal(s.pstore.reservations[0].actualUsd, 2);
  // A cancel after billable turns is charged the same way.
  const c = setup({ maxCostUsd: 3 });
  const engine = new RunEngine({ store: c.store, policy: c.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ turns: 1, hang: true }) }) });
  const p = engine.execute({ runId: c.runId, provider: "anthropic", prompt: "x", cwd: "." });
  await new Promise((r) => setTimeout(r, 100));
  await engine.cancel(c.runId);
  const co = await p;
  assert.equal(co.status, "cancelled");
  assert.equal(co.costUsd, 3);
});

test("r1-2 after a crash the next reservation is only what is left of max_cost_usd", async () => {
  const s = setup({ maxCostUsd: 5 });
  s.store.failAppendAt = 7;
  await assert.rejects(new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ turns: 2 }) }) }).execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." }));
  const spent = s.store.costs.reduce((a, c) => a + c.usd, 0);
  assert.ok(spent > 0, "the interrupted execution's cost was recorded");
  s.store.failAppendAt = null;
  await new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ turns: 1 }) }) }).execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.ok(Math.abs(s.pstore.reservations[1].reservedUsd - (5 - spent)) < 1e-6, "reserved the remainder, not the full cap");
});

test("r1-3 cost over max_cost_usd pauses and raises a card even when max-turns ended the run", async () => {
  const s = setup({ maxTurns: 1, maxCostUsd: 0.1 });
  const out = await new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ turns: 3, cost: 0.5 }) }) }).execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(out.status, "limit_hit");
  assert.equal(out.errorType, "budget_exceeded");
  assert.ok(s.store.paused.has("proj-1"));
  assert.equal(s.store.cards.length, 1);
});

test("r1-4 a failure after the outcome is recorded never reruns the runtime; exactly one terminal event", async () => {
  const s = setup();
  const calls = [];
  const engine = new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ calls }) }) });
  s.store.failFinishTimes = 1;
  await assert.rejects(engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." }), /store-down/);
  const out = await engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(out.status, "succeeded");
  assert.equal(calls.length, 1, "runtime started once");
  assert.equal(s.store.finished.get(s.runId).status, "succeeded");
  assert.equal(assertGapless(s.store, s.runId).filter((e) => e.type === "done" || e.type === "error").length, 1);
  assert.equal(s.pstore.reservations.length, 1, "no second reservation");
  // Outcome checkpointed but the terminal event itself was lost: the retry writes it, still no rerun.
  const t = setup();
  const tcalls = [];
  const e2 = new RunEngine({ store: t.store, policy: t.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ calls: tcalls }) }) });
  const realAppend = t.store.appendEvent.bind(t.store);
  let dropDone = true;
  t.store.appendEvent = async (e) => {
    if (dropDone && e.type === "done") {
      dropDone = false;
      throw new Error("store-down");
    }
    return realAppend(e);
  };
  await assert.rejects(e2.execute({ runId: t.runId, provider: "anthropic", prompt: "x", cwd: "." }));
  const o2 = await e2.execute({ runId: t.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(o2.status, "succeeded");
  assert.equal(tcalls.length, 1);
  assert.equal(assertGapless(t.store, t.runId).filter((e) => e.type === "done").length, 1);
});

test("r1-5 Codex cancel kills a TERM-ignoring grandchild even when the parent exits on SIGTERM", async () => {
  const s = setup();
  const pidfile = join(mkdtempSync(join(tmpdir(), "m15-")), "gc.pid");
  const engine = new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => fakeCodexAdapter("orphan", { FAKE_CODEX_PIDFILE: pidfile }) });
  const p = engine.execute({ runId: s.runId, provider: "openai", prompt: "x", cwd: ".", reserveUsd: 0.4 });
  for (let i = 0; i < 50 && !existsSync(pidfile); i++) await new Promise((r) => setTimeout(r, 50));
  const gc = Number(readFileSync(pidfile, "utf8"));
  await engine.cancel(s.runId);
  assert.equal((await p).status, "cancelled");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(alive(gc), false, "grandchild killed");
});

test("r1-6 Codex telemetry carries the turn's command-output bytes and tool name", async () => {
  const c = setup();
  c.store.runs.get(c.runId).model = "gpt-codex";
  await new RunEngine({ store: c.store, policy: c.policy, adapterFor: () => fakeCodexAdapter("ok") }).execute({ runId: c.runId, provider: "openai", prompt: "x", cwd: ".", reserveUsd: 0.4 });
  assert.deepEqual(c.store.telemetry.map((r) => [r.toolName, r.toolResultBytes]), [["shell", 100], ["shell", 200]]);
});

// ---- Codex PR16-r2 regressions ----

test("r2-1 a retryable failure is rerun on the next execute; a final failure only with rerun (dead-letter retry)", async () => {
  const s = setup();
  const calls = [];
  const engine = new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ calls, failFirst: 1 }) }) });
  const first = await engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(first.status, "failed");
  assert.equal(first.errorType, "rate_limited");
  assert.equal(first.retryable, true);
  const second = await engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(second.status, "succeeded");
  assert.equal(calls.length, 2, "the runtime ran again");
  const evs = assertGapless(s.store, s.runId);
  assert.deepEqual(evs.filter((e) => e.type === "done" || e.type === "error").map((e) => e.type), ["error", "done"]);
  assert.ok(evs.some((e) => e.payload.state === "retrying"));

  const t = setup();
  const tcalls = [];
  const bad = new RunEngine({ store: t.store, policy: t.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: (a) => { tcalls.push(a); return (async function* () { throw Object.assign(new Error("bad"), { status: 400 }); })(); } }) });
  const f1 = await bad.execute({ runId: t.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(f1.retryable, false);
  const f2 = await bad.execute({ runId: t.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(f2.status, "failed");
  assert.equal(tcalls.length, 1, "a final failure is not rerun by a plain retry");
  const ok = new RunEngine({ store: t.store, policy: t.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ calls: tcalls }) }) });
  const f3 = await ok.execute({ runId: t.runId, provider: "anthropic", prompt: "x", cwd: ".", rerun: true });
  assert.equal(f3.status, "succeeded");
  assert.equal(tcalls.length, 2, "rerun: true (dead-letter retry) runs it again");
});

test("r2-2 a store failure during settlement resumes the bookkeeping, never the runtime; spend recorded once", async () => {
  const s = setup();
  const calls = [];
  const engine = new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ calls }) }) });
  s.store.failAddCostTimes = 1;
  await assert.rejects(engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." }), /store-down/);
  assert.equal(s.pstore.reservations[0].status, "reconciled", "settled before the failure");
  const out = await engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(out.status, "succeeded");
  assert.equal(calls.length, 1, "no rerun");
  assert.equal(s.store.costs.length, 1);
  assert.equal(s.store.costs[0].usd, 0.12);
  assert.equal(s.pstore.reservations.length, 1, "no second reservation");
  assert.equal(assertGapless(s.store, s.runId).filter((e) => e.type === "done").length, 1);
});

test("r2-3 Codex always runs with --sandbox read-only; sandbox/approval overrides and write envelopes are refused", async () => {
  const s = setup();
  s.store.runs.get(s.runId).model = "gpt-codex";
  const argvfile = join(mkdtempSync(join(tmpdir(), "m15-")), "argv.json");
  await new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => fakeCodexAdapter("ok", { FAKE_CODEX_ARGVFILE: argvfile }) }).execute({ runId: s.runId, provider: "openai", prompt: "x", cwd: ".", reserveUsd: 0.4 });
  const argv = JSON.parse(readFileSync(argvfile, "utf8"));
  assert.equal(argv[argv.indexOf("--sandbox") + 1], "read-only");
  assert.equal(argv.filter((a) => a === "--sandbox").length, 1);
  for (const args of [["--sandbox", "workspace-write"], ["--full-auto"], ["-c", "sandbox_mode=danger-full-access"], ["--dangerously-bypass-approvals-and-sandbox"]]) {
    const t = setup();
    const t0 = Date.now();
    const out = await new RunEngine({ store: t.store, policy: t.policy, adapterFor: () => fakeCodexAdapter("ok", {}, args) }).execute({ runId: t.runId, provider: "openai", prompt: "x", cwd: ".", reserveUsd: 0.4 });
    assert.equal(out.status, "failed", args.join(" "));
    assert.equal(out.errorType, "policy_denied");
    assert.equal(out.countsAsAttempt, false);
    assert.ok(Date.now() - t0 < 3000, "refused at once");
  }
  const w = setup();
  w.store.envelopes.set(w.runId, { tools: ["shell"], readPaths: ["src"], writePaths: ["src"], network: false, networkAllowList: null, maxCostUsd: 1, maxTokens: 2_000_000, maxConcurrency: 1, expiresAt: Date.now() + 60_000, depth: 1 });
  const wo = await new RunEngine({ store: w.store, policy: w.policy, adapterFor: () => fakeCodexAdapter("ok") }).execute({ runId: w.runId, provider: "openai", prompt: "x", cwd: ".", reserveUsd: 0.4, reserveTokens: 1000 });
  assert.equal(wo.errorType, "policy_denied");
});

// ---- Codex PR16-r3 regressions ----

test("r3-1 a store failure on the first usage event still charges the billable usage (fail-closed)", async () => {
  const s = setup({ maxCostUsd: 2 });
  s.store.failTelemetryTimes = 1;
  // The SDK reports usage but no cost (aborted after the crash): runTokens is 0, result.usage is not.
  const engine = new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ turns: 1, hang: true }) }) });
  await assert.rejects(engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." }), /store-down/);
  const r = s.pstore.reservations[0];
  assert.equal(r.status, "reconciled", "not released");
  assert.equal(r.actualUsd, 2, "charged the whole reservation");
  assert.equal(s.store.costs.length, 1);
  assert.equal(s.store.costs[0].usd, 2);
});

test("r3-2 a failed ending checkpoint settles the money at once; the retry never double-charges or leaves it open", async () => {
  const s = setup();
  s.store.failCheckpoint = { when: (d) => Boolean(d.state.ending), times: 1 };
  const engine = new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ turns: 1, cost: 0.2 }) }) });
  await assert.rejects(engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." }), /store-down/);
  assert.equal(s.pstore.reservations[0].status, "reconciled");
  assert.deepEqual(s.store.costs.map((c) => c.usd), [0.2]);
  const out = await engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(out.status, "succeeded");
  assert.ok(s.pstore.reservations.every((r) => r.status !== "reserved"), "nothing left open");
  assert.deepEqual(s.store.costs.map((c) => c.usd), [0.2, 0.2], "the first attempt's spend counted once");
  // The resumed attempt reserved only what was left.
  assert.ok(Math.abs(s.pstore.reservations[1].reservedUsd - (5 - 0.2)) < 1e-6);
});

test("r3-3 if the store is down for cost and checkpoint, the next execute charges the open reservation in full", async () => {
  const s = setup({ maxCostUsd: 3 });
  s.store.failCheckpoint = { when: (d) => Boolean(d.state.ending), times: 1 };
  s.store.failAddCostTimes = 1;
  const engine = new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ turns: 1, cost: 0.2 }) }) });
  await assert.rejects(engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." }), /store-down/);
  assert.equal(s.pstore.reservations[0].status, "reserved", "left open: cost was not recorded");
  const out = await engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(s.pstore.reservations[0].status, "reconciled");
  assert.equal(s.pstore.reservations[0].actualUsd, 3, "orphan charged in full");
  assert.equal(s.store.costs[0].usd, 3);
  assert.ok(assertGapless(s.store, s.runId).some((e) => e.payload.state === "recovered"));
  // 3 already spent of 3: the resumed attempt is a budget stop before the runtime, paused, card.
  assert.equal(out.status, "limit_hit");
  assert.equal(out.errorType, "budget_exceeded");
  assert.equal(s.pstore.reservations.length, 1, "no new reservation once max_cost_usd is spent");
  assert.ok(s.store.paused.has("proj-1"));
});

// ---- Codex PR16-r4 regression ----

test("r4-1 a failure during orphan recovery never loses the orphan's charge", async () => {
  for (const failAt of ["cost", "checkpoint", "settle"]) {
    const s = setup({ maxCostUsd: 3 });
    // Leave an orphan: outcome checkpoint and cost both fail on the first attempt.
    s.store.failCheckpoint = { when: (d) => Boolean(d.state.ending), times: 1 };
    s.store.failAddCostTimes = 1;
    let reconcileFails = 0;
    const policy = { decide: (r) => s.policy.decide(r), release: (id) => s.policy.release(id), reconcile: async (id, u, t) => { if (reconcileFails > 0) { reconcileFails -= 1; throw new Error("policy-down"); } return s.policy.reconcile(id, u, t); } };
    const engine = new RunEngine({ store: s.store, policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ turns: 1, cost: 0.2 }) }) });
    await assert.rejects(engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." }));
    assert.equal(s.pstore.reservations[0].status, "reserved", failAt);
    // Recovery fails at one point.
    if (failAt === "cost") s.store.failAddCostTimes = 1;
    if (failAt === "checkpoint") s.store.failCheckpoint = { when: (d) => Boolean(d.state.attempt?.costRecorded), times: 1 };
    if (failAt === "settle") reconcileFails = 1;
    await assert.rejects(engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." }), failAt);
    // The next execute finishes recovery.
    const out = await engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." });
    const spent = s.store.costs.reduce((a, c) => a + c.usd, 0);
    assert.ok(spent >= 3, `${failAt}: the orphan's full charge is recorded (${spent})`);
    assert.equal(s.pstore.reservations[0].status, "reconciled", failAt);
    assert.equal(out.errorType, "budget_exceeded", `${failAt}: max_cost_usd is spent, no new reservation`);
    assert.equal(s.pstore.reservations.length, 1, failAt);
  }
});

// ---- Codex PR16-r5 regressions ----

test("r5-1 a cancel that arrives before the runtime starts means it never starts", async () => {
  for (const kind of ["codex", "claude"]) {
    const s = setup();
    s.store.runs.get(s.runId).model = "gpt-codex";
    const argvfile = join(mkdtempSync(join(tmpdir(), "m15-")), "argv.json");
    let release;
    const gate = new Promise((r) => (release = r));
    const realMark = s.store.markRunning.bind(s.store);
    s.store.markRunning = async (id) => { await gate; return realMark(id); };
    const calls = [];
    const engine = new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => (kind === "codex" ? fakeCodexAdapter("ok", { FAKE_CODEX_ARGVFILE: argvfile }) : new ClaudeAgentSdkAdapter({ query: fakeQuery({ calls }) })) });
    const p = engine.execute({ runId: s.runId, provider: kind === "codex" ? "openai" : "anthropic", prompt: "x", cwd: ".", reserveUsd: 0.4 });
    for (let i = 0; i < 50 && !(await engine.cancel(s.runId)); i++) await new Promise((r) => setTimeout(r, 10));
    release();
    const out = await p;
    assert.equal(out.status, "cancelled", kind);
    assert.equal(existsSync(argvfile), false, `${kind}: codex never spawned`);
    assert.equal(calls.length, 0, `${kind}: SDK query never called`);
  }
});

test("r5-2 a Codex child that exits before reading a large prompt is a typed failure, not a worker crash", async () => {
  const s = setup();
  s.store.runs.get(s.runId).model = "gpt-codex";
  const out = await new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => fakeCodexAdapter("exit-early") }).execute({ runId: s.runId, provider: "openai", prompt: "p".repeat(8 * 1024 * 1024), cwd: ".", reserveUsd: 0.4 });
  assert.equal(out.status, "failed");
  assert.equal(out.errorType, "provider_error");
  assert.equal(assertGapless(s.store, s.runId).at(-1).type, "error");
});

test("r5-3 a failed finishRun is retried as bookkeeping; only a fully finished retryable failure is rerun", async () => {
  const s = setup();
  const calls = [];
  const engine = new RunEngine({ store: s.store, policy: s.policy, adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ calls, failFirst: 1 }) }) });
  s.store.failFinishTimes = 1;
  await assert.rejects(engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." }), /store-down/);
  const again = await engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(again.status, "failed");
  assert.equal(again.errorType, "rate_limited");
  assert.equal(calls.length, 1, "finishRun retried, runtime not started");
  assert.equal(s.store.finished.get(s.runId).status, "failed");
  const third = await engine.execute({ runId: s.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(third.status, "succeeded");
  assert.equal(calls.length, 2, "now the retryable failure is rerun");
});

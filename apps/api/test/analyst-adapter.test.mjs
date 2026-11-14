// M2.2-d3b2: the production adapter for the analyst model pass (contract docs/modules/M2.2.md, "M2.2-d3b2").
// The real RunEngine, M1.7 PolicyEngine and ClaudeAgentSdkAdapter over the memory stores, with a fake fetch in
// place of the Anthropic Messages API (no network in tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MemoryPolicyStore, PolicyEngine } from "@devos/policy";
import * as runEngineModule from "@devos/run-engine";
import { MemoryRunStore } from "@devos/run-engine";
import {
  ANTHROPIC_MESSAGES_URL, ANTHROPIC_KEY_NAME, ANALYST_ANSWER_MAX_TOKENS, MAX_RESPONSE_BYTES,
  analystModelPassAllowed, buildAnalystEngine, costUsd, messagesQuery, isBlockedAddress, pinnedFetch, toResponse, isPreSendError,
} from "../dist/analyst-adapter.js";
import { runEngineModelRunner, ANALYST_MODEL } from "../dist/analyst-runner.js";

const P1 = "4b7d1c1e-2f6a-4a8e-9d55-0c1f2a3b4c5d";
const KEY = "test-only-not-a-real-key";

/** A Messages API reply in the real shape: an adaptive-thinking block, then the answer split over two text blocks. */
function reply({ text = ['{"requirements":', "[]}"], stop = "end_turn", usage = { input_tokens: 1000, output_tokens: 500 }, extra = [] } = {}) {
  return {
    id: "msg_test", type: "message", role: "assistant", model: ANALYST_MODEL, stop_reason: stop, usage,
    content: [{ type: "thinking", thinking: "…", signature: "x" }, ...text.map((t) => ({ type: "text", text: t })), ...extra],
  };
}

function fakeFetch(respond) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = await respond(calls.length);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { f, calls };
}

/** Memory task/run rows (the Postgres twin is PrismaAnalystRunRows, covered by d3b1's test-db). */
function memoryRows(runStore) {
  let n = 0;
  return {
    async createRun(input) {
      const runId = `run-${++n}`;
      runStore.envelopes.set(runId, input.envelope);
      runStore.runs.set(runId, { id: runId, taskId: `task-${n}`, projectId: input.projectId, role: "analyst", model: input.model, attempt: 1, status: "queued", maxTurns: input.maxTurns, maxSeconds: input.maxSeconds, maxCostUsd: input.maxCostUsd, turns: 0 });
      return runId;
    },
    async textEvents(runId) {
      return runStore.events.filter((e) => e.runId === runId && e.type === "text").sort((a, b) => a.seq - b.seq).map((e) => e.payload.text);
    },
    async finishTask() {},
  };
}

/** buildAnalystEngine with the real run-engine module, the memory run store in place of Postgres. */
function setup({ respond, key = KEY } = {}) {
  const { f, calls } = fakeFetch(respond ?? (() => reply()));
  return { ...setupWith(f, key), calls };
}

function setupWith(f, key = KEY) {
  const runStore = new MemoryRunStore();
  const adapters = [];
  const m = {
    ...runEngineModule,
    PrismaRunStore: function () { return runStore; },
    ClaudeAgentSdkAdapter: class extends runEngineModule.ClaudeAgentSdkAdapter {
      constructor(o) { super(o); adapters.push(o); }
    },
  };
  const policy = new PolicyEngine({ store: new MemoryPolicyStore({ mode: "observe" }), hmacKey: randomBytes(32) });
  const keyReads = [];
  const engine = buildAnalystEngine(m, {}, policy, { apiKey: async () => (keyReads.push(1), key), timeoutMs: 5_000, fetch: f });
  const runner = runEngineModelRunner(memoryRows(runStore), engine);
  return { runStore, runner, adapters, keyReads, engine };
}

test("AT-CA1 one Messages API request: the vault key by header, the analyst model, a bounded answer, no tools, no redirects", async () => {
  const { runner, calls, keyReads } = setup();
  await runner({ prompt: "spec text", tag: "analyst_assist", projectId: P1 });
  assert.equal(calls.length, 1, "one request per call, no retry");
  const { url, init, body } = calls[0];
  assert.equal(url, ANTHROPIC_MESSAGES_URL);
  assert.equal(init.method, "POST");
  assert.equal(init.headers["x-api-key"], KEY);
  assert.equal(init.headers["anthropic-version"], "2023-06-01");
  assert.equal(init.redirect, "error");
  assert.ok(init.signal instanceof AbortSignal, "the request carries an abort/timeout signal");
  assert.deepEqual(body, { model: ANALYST_MODEL, max_tokens: ANALYST_ANSWER_MAX_TOKENS, messages: [{ role: "user", content: "spec text" }] });
  assert.equal("tools" in body, false, "no tool is ever offered to the model");
  assert.equal(keyReads.length, 1, "the key is read at call time");
  assert.equal(ANTHROPIC_KEY_NAME, "anthropic_api_key");
});

test("AT-CA2 the real message shape fits one turn: split text blocks join in order, thinking is not output, cost is metered once", async () => {
  const { runner, runStore } = setup();
  const out = await runner({ prompt: "p", tag: "analyst_assist", projectId: P1 });
  assert.deepEqual(out, { output: '{"requirements":[]}' });
  const run = [...runStore.runs.values()][0];
  assert.equal(run.status, "succeeded", "not limit_hit: max_turns 2 leaves room for the one answer turn");
  assert.equal(run.turns, 1);
  const cost = (1000 * 2 + 500 * 10) / 1_000_000;
  assert.equal(runStore.costs.length, 1, "one cost_entry, recorded by the engine");
  assert.ok(Math.abs(runStore.costs[0].usd - cost) < 1e-9, `cost ${runStore.costs[0].usd} = ${cost}`);
  assert.equal(costUsd(ANALYST_MODEL, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }), 2.6);
});

test("AT-CA3 every tool call is refused: the tool gate denies, allowedTools is refused, a tool_use block is never forwarded", async () => {
  const { runner, adapters, runStore } = setup({ respond: () => reply({ extra: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "id" } }] }) });
  await runner({ prompt: "p", tag: "analyst_assist", projectId: P1 });
  assert.equal(adapters.length, 1);
  assert.equal(await adapters[0].toolGate("Bash", { command: "id" }), false);
  assert.equal(await adapters[0].toolGate("Read", {}), false);
  assert.equal(runStore.events.filter((e) => e.type === "tool_call").length, 0, "no tool_call event");
  const q = messagesQuery({ apiKey: async () => KEY, timeoutMs: 1000, fetch: async () => assert.fail("no request") });
  const it = q({ prompt: "p", options: { abortController: new AbortController(), model: ANALYST_MODEL, allowedTools: ["Bash"] } });
  await assert.rejects(async () => { for await (const _ of it) void _; }, /analyst-tools-refused/);
  // Any provider other than anthropic is refused.
  assert.throws(() => buildAnalystEngine({ ...runEngineModule, RunEngine: class { constructor(o) { o.adapterFor("openai"); } } }, {}, {}, { apiKey: async () => KEY, timeoutMs: 1 }), /analyst-provider-refused/);
});

test("AT-CA4 failures end the run failed and the call assist-failed, with no retry and no response text kept", async () => {
  // charged: "none" = no cost (no request, or an unbilled error reply); "usage" = the reply's usage × price;
  // "reservation" = the request was sent but no usable reply came back, so the engine settles fail-closed.
  const cases = [
    { name: "no key", key: null, respond: () => assert.fail("no request without a key"), requests: 0, charged: "none" },
    { name: "HTTP 429", respond: () => new Response('{"error":{"message":"secret-ish detail"}}', { status: 429 }), requests: 1, charged: "none" },
    { name: "HTTP 500", respond: () => new Response("oops", { status: 500 }), requests: 1, charged: "none" },
    { name: "max_tokens stop", respond: () => reply({ stop: "max_tokens" }), requests: 1, charged: "usage" },
    { name: "bad JSON", respond: () => new Response("not json", { status: 200 }), requests: 1, charged: "reservation" },
    { name: "no content", respond: () => ({ id: "m", stop_reason: "end_turn", usage: {} }), requests: 1, charged: "reservation" },
    { name: "no usage", respond: () => ({ ...reply(), usage: undefined }), requests: 1, charged: "reservation" },
    { name: "too large", respond: () => new Response("x".repeat(MAX_RESPONSE_BYTES + 1), { status: 200 }), requests: 1, charged: "reservation" },
    { name: "connection lost", respond: () => { throw Object.assign(new Error("socket hang up"), { name: "TypeError" }); }, requests: 1, charged: "reservation" },
  ];
  for (const c of cases) {
    const { runner, runStore, calls } = setup({ respond: c.respond, key: c.key === undefined ? KEY : c.key });
    await assert.rejects(runner({ prompt: "p", tag: "analyst_assist", projectId: P1 }), /analyst-run-failed/, c.name);
    assert.equal(calls.length, c.requests, `${c.name}: requests`);
    const run = [...runStore.runs.values()][0];
    assert.equal(run.status, "failed", c.name);
    assert.doesNotMatch(JSON.stringify([...runStore.runs.values(), ...runStore.events]), /secret-ish|oops|not json|socket hang up|requirements/, `${c.name}: no response text stored`);
    const usd = runStore.costs.reduce((a, r) => a + r.usd, 0);
    if (c.charged === "none") assert.equal(usd, 0, `${c.name}: not charged`);
    if (c.charged === "usage") assert.ok(Math.abs(usd - 0.007) < 1e-9, `${c.name}: charged its usage (${usd})`);
    if (c.charged === "reservation") assert.ok(usd >= 0.5 - 1e-9, `${c.name}: charged fail-closed, not $0 (${usd})`);
  }
  // An unpriced model is refused before any request, so the meter never gets a guess.
  const q = messagesQuery({ apiKey: async () => KEY, timeoutMs: 1000, fetch: async () => assert.fail("no request") });
  await assert.rejects(async () => { for await (const _ of q({ prompt: "p", options: { abortController: new AbortController(), model: "claude-unknown" } })) void _; }, /analyst-model-unpriced/);
});

test("AT-CA5 a request past its timeout is aborted and typed timeout; an engine cancel aborts the request", async () => {
  // AbortSignal.timeout's timer does not hold the event loop open (the API server does); this test does.
  const keepAlive = setInterval(() => {}, 1000);
  const hang = async (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const q = messagesQuery({ apiKey: async () => KEY, timeoutMs: 50, fetch: hang });
  await assert.rejects(async () => { for await (const _ of q({ prompt: "p", options: { abortController: new AbortController(), model: ANALYST_MODEL } })) void _; }, (e) => e.name === "TimeoutError");
  const ac = new AbortController();
  const q2 = messagesQuery({ apiKey: async () => KEY, timeoutMs: 60_000, fetch: hang });
  const p = (async () => { for await (const _ of q2({ prompt: "p", options: { abortController: ac, model: ANALYST_MODEL } })) void _; })();
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, (e) => e.name === "AbortError");
  // Round 2, finding 4: a signal already aborted before the request sends nothing and charges nothing.
  const pre = new AbortController();
  pre.abort();
  const q3 = messagesQuery({ apiKey: async () => KEY, timeoutMs: 60_000, fetch: async () => assert.fail("no request after an abort") });
  const seen3 = [];
  await assert.rejects(async () => { for await (const m of q3({ prompt: "p", options: { abortController: pre, model: ANALYST_MODEL } })) seen3.push(m); }, /cancelled/);
  assert.deepEqual(seen3, [], "no usage reported for a call never sent");
  // Pre-review finding 4: the engine's cancel reaches the request, and the run is charged fail-closed, not $0.
  let seenSignal = null;
  const cancelled = setupWith(async (url, init) => ((seenSignal = init.signal), hang(url, init)));
  const call = cancelled.runner({ prompt: "p", tag: "analyst_assist", projectId: P1 });
  while (!seenSignal) await new Promise((r) => setTimeout(r, 5));
  const runId = [...cancelled.runStore.runs.keys()][0];
  assert.equal(await cancelled.engine.cancel(runId), true);
  await assert.rejects(call, /analyst-run-cancelled/);
  assert.equal(seenSignal.aborted, true, "the fetch signal is aborted by the engine's cancel");
  assert.equal(cancelled.runStore.runs.get(runId).status, "cancelled");
  assert.ok(cancelled.runStore.costs.reduce((a, r) => a + r.usd, 0) >= 0.5 - 1e-9, "a cancelled, dispatched call is charged fail-closed");
  clearInterval(keepAlive);
});

test("AT-CA6 (DEVOS-176) DEVOS_ANALYST_MODEL_PASS other than unset or on is a hard off; buildRuntime hands the engine a vault key reader", async () => {
  // The setting `analyst.model_pass` (default off) decides per call (AT-CA9); the env can only forbid loading the engine.
  assert.equal(analystModelPassAllowed({ DEVOS_ANALYST_MODEL_PASS: "off" }), false);
  assert.equal(analystModelPassAllowed({}), true);
  assert.equal(analystModelPassAllowed({ DEVOS_ANALYST_MODEL_PASS: "on" }), true);
  for (const v of ["OFF", "false", "0", "no", "off ", "On"]) assert.equal(analystModelPassAllowed({ DEVOS_ANALYST_MODEL_PASS: v }), false, `fail-safe: ${v}`);
  assert.equal(analystModelPassAllowed({ DEVOS_ANALYST_MODEL_PASS: "" }), true, "empty = unset"); 
  const { buildRuntime } = await import("../dist/runtime.js");
  const { KkSessionRegistry } = await import("../dist/auth.js");
  const env = { DATABASE_URL: "postgresql://x/y", DEVOS_POLICY_HMAC_KEY: "test-only-policy-hmac-key-0123456789abcdef" };
  let reader = null;
  await buildRuntime(env, {
    outboundTimeoutMs: 500, kkSessions: new KkSessionRegistry(), loadDb: async () => ({}),
    loadAnalystEngine: async (_db, _policy, apiKey) => ((reader = apiKey), { execute: async () => ({ status: "succeeded" }) }),
  });
  assert.equal(typeof reader, "function");
  assert.equal(await reader(), null, "no vault configured → no key → the call fails assist-failed");

  // Pre-review finding 5: with a vault, the reader returns the secret stored under `anthropic_api_key`, read each call.
  const rows = [];
  const tx = {
    vaultSecret: {
      findFirst: async ({ where }) => rows.find((r) => r.projectId === where.projectId && r.name === where.name) ?? null,
      create: async ({ data }) => { const r = { id: `v${rows.length}`, createdAt: new Date(), updatedAt: new Date(), ...data }; rows.push(r); return r; },
      update: async ({ where, data }) => Object.assign(rows.find((r) => r.id === where.id), data, { updatedAt: new Date() }),
    },
    auditEvent: { create: async () => ({}) },
  };
  const db = { $transaction: async (fn) => fn(tx) };
  const withVault = { ...env, DEVOS_VAULT_KEY: randomBytes(32).toString("base64") };
  const rt = await buildRuntime(withVault, {
    outboundTimeoutMs: 500, kkSessions: new KkSessionRegistry(), loadDb: async () => db,
    loadAnalystEngine: async (_db, _policy, apiKey) => ((reader = apiKey), { execute: async () => ({ status: "succeeded" }) }),
  });
  assert.equal(await reader(), null, "no key stored yet");
  await rt.setup.vault.put(ANTHROPIC_KEY_NAME, "test-only-key-one-0123456789");
  assert.equal(await reader(), "test-only-key-one-0123456789");
  await rt.setup.vault.put(ANTHROPIC_KEY_NAME, "test-only-key-two-0123456789");
  assert.equal(await reader(), "test-only-key-two-0123456789", "a rotation applies at the next call");
});

test("AT-CA7 (Codex PR92-r2, F2) the production call refuses internal addresses before sending, and is pinned and abortable", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2002:a00:1::", "not-an-ip"]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} is blocked`);
  }
  for (const ip of ["160.79.104.10", "8.8.8.8", "2607:6bc0::10"]) assert.equal(isBlockedAddress(ip), false, `${ip} is public`);

  // The default fetch (no test fetch injected) is the pinned one: an internal resolution is refused with nothing sent,
  // so no upper-bound charge event is yielded either.
  let lookups = 0;
  const events = [];
  const q = messagesQuery({ apiKey: async () => KEY, timeoutMs: 5_000, lookup: async () => (lookups++, [{ address: "10.0.0.7", family: 4 }]) });
  await assert.rejects(async () => {
    for await (const e of q({ prompt: "p", options: { abortController: new AbortController(), model: ANALYST_MODEL } })) events.push(e);
  }, /analyst-blocked-address/);
  assert.equal(lookups, 1, "the host is resolved once");
  assert.deepEqual(events, [], "refused before sending: no usage, no charge");

  // One internal address among public ones is enough to refuse; only https is allowed.
  const f = pinnedFetch(async () => [{ address: "160.79.104.10", family: 4 }, { address: "127.0.0.1", family: 4 }]);
  await assert.rejects(f(ANTHROPIC_MESSAGES_URL, { method: "POST" }), /analyst-blocked-address/);
  await assert.rejects(pinnedFetch(async () => [{ address: "160.79.104.10", family: 4 }])("http://api.anthropic.com/v1/messages"), /analyst-blocked-address/);

  // The caller's signal aborts a slow lookup with its own reason (the timeout and the engine's cancel keep working).
  const ac = new AbortController();
  const slow = pinnedFetch(() => new Promise(() => {}));
  const p = slow(ANTHROPIC_MESSAGES_URL, { method: "POST", signal: ac.signal });
  const reason = Object.assign(new Error("cancelled"), { name: "AbortError" });
  ac.abort(reason);
  await assert.rejects(p, (e) => e === reason);
  await assert.rejects(slow(ANTHROPIC_MESSAGES_URL, { signal: AbortSignal.abort(reason) }), (e) => e === reason);
});

test("AT-CA8 (Codex PR92-r3) a null-body reply never crashes the process; a call that fails before dispatch is not charged", async () => {
  const { Readable } = await import("node:stream");
  // 1. A 204/205 reply gets a null body instead of making `new Response` throw inside the https callback.
  for (const status of [204, 205]) {
    const r = toResponse(Readable.from([]), status);
    assert.equal(r.status, status);
    assert.equal(r.body, null);
  }
  assert.equal(toResponse(Readable.from(["x"]), 200).status, 200);
  assert.equal(toResponse(Readable.from(["x"]), 99).status, 502, "a status outside 200-599 becomes 502");
  // ...and messagesQuery turns an empty 204 into a typed failure (the run fails, deterministic analysis stays).
  const q204 = messagesQuery({ apiKey: async () => KEY, timeoutMs: 5_000, fetch: async () => new Response(null, { status: 204 }) });
  await assert.rejects(async () => { for await (const _ of q204({ prompt: "p", options: { abortController: new AbortController(), model: ANALYST_MODEL } })) void _; }, /analyst-bad-response/);

  // 2. A DNS failure: no request exists, so no upper-bound usage is yielded (nothing charged).
  const dnsFail = messagesQuery({ apiKey: async () => KEY, timeoutMs: 5_000, lookup: async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); } });
  const seenDns = [];
  await assert.rejects(async () => { for await (const m of dnsFail({ prompt: "p", options: { abortController: new AbortController(), model: ANALYST_MODEL } })) seenDns.push(m); }, /fetch failed/);
  assert.deepEqual(seenDns, [], "a DNS failure is not charged");

  // 3. A cancel and a timeout during the lookup: typed cancelled / TimeoutError, nothing charged.
  const keepAlive = setInterval(() => {}, 1000);
  const ac = new AbortController();
  const slowCancel = messagesQuery({ apiKey: async () => KEY, timeoutMs: 60_000, lookup: () => new Promise(() => {}) });
  const seenCancel = [];
  const pc = (async () => { for await (const m of slowCancel({ prompt: "p", options: { abortController: ac, model: ANALYST_MODEL } })) seenCancel.push(m); })();
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(pc, /cancelled/);
  assert.deepEqual(seenCancel, [], "a cancel during the lookup is not charged");
  const slowTimeout = messagesQuery({ apiKey: async () => KEY, timeoutMs: 30, lookup: () => new Promise(() => {}) });
  const seenTimeout = [];
  await assert.rejects(async () => { for await (const m of slowTimeout({ prompt: "p", options: { abortController: new AbortController(), model: ANALYST_MODEL } })) seenTimeout.push(m); }, (e) => e.name === "TimeoutError");
  assert.deepEqual(seenTimeout, [], "a timeout during the lookup is not charged");
  clearInterval(keepAlive);

  // 4. The caller's own abort reason is marked, not replaced (AT-CA7 still sees e === reason), and an ordinary
  // error is never pre-send.
  const reason = Object.assign(new Error("cancelled"), { name: "AbortError" });
  await assert.rejects(pinnedFetch(() => new Promise(() => {}))(ANTHROPIC_MESSAGES_URL, { signal: AbortSignal.abort(reason) }), (e) => e === reason && isPreSendError(e));
  assert.equal(isPreSendError(new Error("x")), false);
});

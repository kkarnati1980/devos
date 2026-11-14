// R2 AT1–AT4 (docs/modules/R2.md): the G1 probe adapter and the in-image check helper, against the real
// RunEngine (MemoryRunStore + PolicyEngine) and a fake Prisma surface. No Redis, database or provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MemoryPolicyStore, PolicyEngine } from "@devos/policy";
import { MemoryRunStore, RunEngine } from "../dist/index.js";
import { PROBE_MODEL, PROBE_TURNS, ProbeAdapter, ProbeGateAdapter } from "../dist/probe-adapter.js";
import { probeGated } from "../dist/worker-main.js";
import { checkCaps, checkReceipts, probeStart, probeGuard, probeStatus, errorCode, cli, micros, PROBE_RESERVE_USD, PROBE_MAX_COST_USD, PROBE_STALE_MS } from "../dist/g1-cli.js";

const fast = () => new ProbeAdapter({ turnMs: 5 });
const jobs = (enqueue, fate = "absent") => ({ enqueue, retire: async () => { if (fate instanceof Error) throw fate; return fate; } });

function setup(model) {
  const store = new MemoryRunStore();
  const pstore = new MemoryPolicyStore({ mode: "observe" });
  const policy = new PolicyEngine({ store: pstore, hmacKey: randomBytes(32) });
  const runId = `run-${randomBytes(4).toString("hex")}`;
  store.runs.set(runId, { id: runId, taskId: "t", projectId: "p", role: "tester", model, attempt: 1, status: "queued", maxTurns: 10, maxSeconds: 60, maxCostUsd: PROBE_MAX_COST_USD, turns: 0 });
  return { store, pstore, policy, runId };
}

test("AT1 the probe runs every turn through the real engine, reconciles its reservation and records one cost entry", async () => {
  const { store, pstore, policy, runId } = setup(PROBE_MODEL);
  const engine = new RunEngine({ store, policy, adapterFor: (p) => new ProbeGateAdapter(p, () => { throw new Error("normal adapter must not be used"); }, fast) });
  const out = await engine.execute({ runId, provider: "anthropic", prompt: "g1 probe", cwd: "/tmp", reserveUsd: PROBE_RESERVE_USD, reserveTokens: 1000 });
  assert.equal(out.status, "succeeded");
  assert.equal(out.turns, PROBE_TURNS);
  assert.equal(store.costs.length, 1, "exactly one cost entry");
  assert.ok(store.costs[0].usd > 0 && store.costs[0].usd < PROBE_RESERVE_USD, "a ledger-only micro-cost, under the reservation");
  assert.equal(pstore.reservations.filter((r) => r.status === "reserved").length, 0, "no reservation left open");
  assert.equal(pstore.reservations.filter((r) => r.status === "reconciled").length, 1);
});

test("AT1 the probe resumes after its checkpoint's turn and never repeats a turn", async () => {
  const a = new ProbeAdapter({ turnMs: 1 });
  await a.start({ runId: "r", taskId: "t", projectId: "p", role: "tester", model: PROBE_MODEL, provider: "anthropic", prompt: "", cwd: "/tmp", resume: { turn: 2, lastSeq: 5, costUsd: 0, tokens: 4, state: {} } }, null);
  const turns = [];
  for await (const ev of a.events()) if (ev.type === "usage") turns.push(ev.payload.turn);
  assert.deepEqual(turns, [3, 4]);
  assert.equal((await a.result()).status, "succeeded");
});

test("AT1 a probe the engine stops reading still settles its result (cancel)", async () => {
  const a = new ProbeAdapter({ turnMs: 1 });
  await a.start({ runId: "r", taskId: "t", projectId: "p", role: "tester", model: PROBE_MODEL, provider: "anthropic", prompt: "", cwd: "/tmp" }, null);
  for await (const ev of a.events()) if (ev.type === "usage") break;
  const r = await a.result();
  assert.equal(r.status, "cancelled");
  assert.equal(r.usage.inputTokens, 1);
});

test("AT2 the probe answers only to its own model; every other run keeps the worker's normal adapter (R1 unchanged)", async () => {
  await assert.rejects(new ProbeAdapter().start({ model: "claude-sonnet" }, null), /probe-model-mismatch/);
  const { store, pstore, policy, runId } = setup("claude-sonnet");
  const engine = new RunEngine({ store, policy, adapterFor: probeGated({}) });
  const out = await engine.execute({ runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(out.status, "failed");
  assert.equal(out.retryable, false, "unconfigured provider: non-retryable, as in R1");
  assert.equal(store.costs.reduce((s, c) => s + c.usd, 0), 0);
  assert.equal(pstore.reservations.filter((r) => r.status === "reserved").length, 0);
});

// ---- fake Prisma surface ----
function fakeDb(seed = {}) {
  const db = {
    rows: { project: [], task: [], run: [], ...seed },
    appSettings: { findFirst: async () => seed.appSettings ?? null },
    policyDecision: { groupBy: async () => (seed.chains ?? []).map((chain) => ({ chain })) },
    project: {
      findUnique: async ({ where }) => db.rows.project.find((p) => p.slug === where.slug) ?? null,
      create: async ({ data }) => { const p = { id: "11111111-1111-4111-8111-111111111111", pausedAt: null, ...data }; db.rows.project.push(p); return p; },
    },
    task: {
      findFirst: async ({ where }) => db.rows.task.find((t) => t.projectId === where.projectId) ?? null,
      create: async ({ data }) => { const t = { id: "t1", ...data }; db.rows.task.push(t); return t; },
    },
    run: {
      count: async ({ where }) => db.rows.run.filter((r) => (typeof where.status === "string" ? r.status === where.status : where.status.in.includes(r.status)) && (where.projectId.not ? r.projectId !== where.projectId.not : r.projectId === where.projectId)).length,
      create: async ({ data }) => { const r = { id: "22222222-2222-4222-8222-222222222222", status: "queued", createdAt: new Date(), ...data }; db.rows.run.push(r); return r; },
      update: async ({ where, data }) => Object.assign(db.rows.run.find((r) => r.id === where.id), data),
      findMany: async ({ where }) => db.rows.run.filter((r) => r.projectId === where.projectId && where.status.in.includes(r.status) && r.createdAt < where.createdAt.lt).map((r) => ({ id: r.id })),
      updateMany: async ({ where, data }) => {
        const hit = db.rows.run.filter((r) => r.id === where.id && where.status.in.includes(r.status));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
      findUnique: async ({ where }) => db.rows.run.find((r) => r.id === where.id) ?? null,
    },
    runEvent: { findMany: async () => seed.events ?? [] },
    checkpoint: { findMany: async () => (seed.turn === undefined ? [] : [{ data: { turn: seed.turn } }]) },
    budgetReservation: { findMany: async () => seed.reservations ?? [] },
    costEntry: { findMany: async () => seed.costs ?? [] },
  };
  return db;
}

test("AT3 caps: skipped before H9, pass on confirmed positive caps, fail on a zero cap", async () => {
  assert.equal((await checkCaps(fakeDb())).code, 3);
  assert.equal((await checkCaps(fakeDb({ appSettings: { anthropicCapUsd: "15", openaiCapUsd: "15", defaultProjectCapUsd: "15", capsConfirmedAt: null } }))).code, 3);
  const good = await checkCaps(fakeDb({ appSettings: { anthropicCapUsd: "15", openaiCapUsd: "10", defaultProjectCapUsd: "5", capsConfirmedAt: new Date("2026-11-06T00:00:00Z") } }));
  assert.equal(good.code, 0);
  assert.equal(good.out.openaiCapUsd, 10);
  const bad = await checkCaps(fakeDb({ appSettings: { anthropicCapUsd: "15", openaiCapUsd: "0", defaultProjectCapUsd: "5", capsConfirmedAt: new Date() } }));
  assert.equal(bad.code, 1);
  assert.deepEqual(bad.out.fields, ["openaiCapUsd"]);
});

test("AT3 receipts: skipped with no receipts, pass when every chain verifies, fail on the first broken chain", async () => {
  assert.equal((await checkReceipts(fakeDb(), async () => ({ valid: true, length: 0 }))).code, 3);
  const pass = await checkReceipts(fakeDb({ chains: ["main", "review"] }), async () => ({ valid: true, length: 3 }));
  assert.equal(pass.code, 0);
  assert.equal(pass.out.receipts, 6);
  const fail = await checkReceipts(fakeDb({ chains: ["main"] }), async () => ({ valid: false, length: 3, error: "receipt-hash-mismatch", at: 2 }));
  assert.equal(fail.code, 1);
  assert.equal(fail.out.reason, "receipt-hash-mismatch");
});

test("AT3 receipts over the real PolicyEngine: a changed receipt byte fails", async () => {
  const pstore = new MemoryPolicyStore({ mode: "observe" });
  const key = randomBytes(32);
  const policy = new PolicyEngine({ store: pstore, hmacKey: key });
  await policy.decide({ identity: { id: "g1", type: "system" }, action: { type: "model.run", resource: "run:x" } });
  await policy.decide({ identity: { id: "g1", type: "system" }, action: { type: "model.run", resource: "run:y" } });
  assert.equal((await checkReceipts(fakeDb({ chains: ["main"] }), (c) => policy.verify(c))).code, 0);
  const rows = await pstore.readChain("main");
  rows[0].bundleHash = "tampered";
  const tampered = new PolicyEngine({ store: { ...pstore, readChain: async () => rows }, hmacKey: key });
  assert.equal((await checkReceipts(fakeDb({ chains: ["main"] }), (c) => tampered.verify(c))).code, 1);
});

test("AT4 probe-start: creates the g1-probe project, task and run, queues it; never while another run is active", async () => {
  const db = fakeDb();
  const queued = [];
  const v = await probeStart(db, jobs(async (i) => queued.push(i)));
  assert.equal(v.code, 0);
  assert.equal(db.rows.project[0].slug, "g1-probe");
  // DEVOS-205: a system project, created with continuous-run off and its pre-flight approved (preflightOpen stays true).
  assert.equal(db.rows.project[0].continuousRun, false);
  assert.equal(db.rows.project[0].preflightState, "approved");
  assert.equal(db.rows.run[0].model, PROBE_MODEL);
  assert.equal(queued[0].runId, v.out.runId);
  assert.equal(queued[0].reserveUsd, PROBE_RESERVE_USD);
  assert.ok(PROBE_RESERVE_USD * 2 < PROBE_MAX_COST_USD, "a hard-killed attempt's full charge still leaves room to resume");
  // the probe run is unfinished: a second start fails instead of stacking runs
  assert.equal((await probeStart(db, jobs(async () => {}))).code, 1);
  // a real run is active: skipped, nothing queued (the check must never kill a worker holding a real run)
  const busy = fakeDb({ run: [{ id: "r", projectId: "other", status: "running" }] });
  const q2 = [];
  const b = await probeStart(busy, jobs(async (i) => q2.push(i)));
  assert.equal(b.code, 3);
  assert.equal(b.out.reason, "worker-busy");
  assert.equal(q2.length, 0);
});

const RUN = "22222222-2222-4222-8222-222222222222";
const ev = (types) => types.map((t, i) => ({ seq: i + 1, type: t.split(":")[0], payload: t.includes(":") ? { state: t.split(":")[1] } : {} }));
const runRow = (status) => ({ run: [{ id: RUN, model: PROBE_MODEL, status, maxCostUsd: "0.01" }] });
const resumedEvents = ev(["status:started", "text", "usage", "status:recovered", "status:resumed", "text", "usage", "usage", "usage", "done"]);

test("AT4 probe-status: pass when the killed run resumed, finished and every reservation was charged once", async () => {
  const v = await probeStatus(fakeDb({ ...runRow("succeeded"), turn: 4, events: resumedEvents,
    reservations: [{ status: "reconciled", actualUsd: "0.001" }, { status: "reconciled", actualUsd: "0.000003" }], costs: [{ usd: "0.001" }, { usd: "0.000003" }] }), RUN, true);
  assert.equal(v.code, 0, JSON.stringify(v.out));
  assert.equal(v.out.resumed, true);
  assert.equal(v.out.recovered, true);
});

test("AT4 probe-status: still running is 3; each broken property is its own failure", async () => {
  const base = { ...runRow("succeeded"), turn: 4, events: resumedEvents, reservations: [{ status: "reconciled", actualUsd: "0.000004" }], costs: [{ usd: "0.000004" }] };
  assert.equal((await probeStatus(fakeDb({ ...base, ...runRow("running") }), RUN, true)).code, 3);
  const cases = [
    [{ ...runRow("failed") }, "probe-run-failed"],
    [{ turn: 2 }, "turns-incomplete"],
    [{ events: [{ seq: 1, type: "status", payload: { state: "resumed" } }, { seq: 3, type: "done", payload: {} }] }, "event-seq-gap"],
    [{ events: ev(["status:started", "usage", "done"]) }, "no-resume-event"],
    [{ reservations: [{ status: "reserved", actualUsd: null }] }, "reservation-open"],
    [{ costs: [] }, "no-cost-entry"],
    [{ costs: [{ usd: "0.000004" }, { usd: "0.000004" }] }, "cost-not-reconciled"],
    [{ reservations: [{ status: "reconciled", actualUsd: "0.02" }], costs: [{ usd: "0.02" }] }, "cost-over-max"],
  ];
  for (const [patch, reason] of cases) {
    const v = await probeStatus(fakeDb({ ...base, ...patch }), RUN, true);
    assert.equal(v.code, 1, reason);
    assert.equal(v.out.reason, reason);
  }
  assert.equal((await probeStatus(fakeDb(base), "not-a-uuid", true)).code, 2);
  assert.equal((await probeStatus(fakeDb({ run: [] }), RUN, true)).out.reason, "probe-run-not-found");
});

test("AT4 the helper prints codes, never values", async () => {
  const secret = "postgresql://devos:hunter2@db/devos";
  assert.equal(errorCode(new Error(`connect failed ${secret}`)), "error");
  assert.equal(errorCode(Object.assign(new Error(secret), { code: "ECONNREFUSED" })), "error-econnrefused");
  assert.equal(errorCode(Object.assign(new Error(secret), { code: "P1001" })), "prisma-P1001");
  assert.equal((await cli(["nope"], {})).code, 2);
  const v = await cli(["caps"], { DATABASE_URL: "mysql://x" });
  assert.equal(v.out.reason, "config-database-url-required");
  assert.ok(!JSON.stringify(v.out).includes("mysql"));
});

test("AT5 PR21: a killed worker's job resumes quickly: lock 15 s and stalled check 5 s reach the BullMQ worker", async () => {
  const { LOCK_DURATION_MS, STALLED_INTERVAL_MS } = await import("../dist/worker-main.js");
  assert.ok(LOCK_DURATION_MS >= 3 * STALLED_INTERVAL_MS && LOCK_DURATION_MS + STALLED_INTERVAL_MS <= 30_000);
  const { RunQueue } = await import("../dist/queue.js");
  const q = new RunQueue({ redisUrl: "redis://127.0.0.1:1", lockDurationMs: LOCK_DURATION_MS, stalledIntervalMs: STALLED_INTERVAL_MS, opTimeoutMs: 500 });
  const w = q.start({ execute: async () => ({}) });
  assert.equal(w.opts.lockDuration, LOCK_DURATION_MS);
  assert.equal(w.opts.stalledInterval, STALLED_INTERVAL_MS);
  await q.close().catch(() => undefined);
});

test("PR21-r1 probe-start: a failed enqueue closes the new run as failed, so the next check can start", async () => {
  const db = fakeDb();
  const v = await probeStart(db, jobs(async () => { throw Object.assign(new Error("connect ECONNREFUSED redis://secret@x"), { code: "ECONNREFUSED" }); }));
  assert.equal(v.code, 1);
  assert.equal(v.out.reason, "probe-enqueue-failed");
  assert.ok(!JSON.stringify(v.out).includes("secret"));
  assert.equal(db.rows.run[0].status, "failed");
  db.rows.run[0].id = "33333333-3333-4333-8333-333333333333";
  assert.equal((await probeStart(db, jobs(async () => {}))).code, 0, "not blocked by the failed enqueue");
});

test("PR21-r1 probe-start: a stale unfinished probe run (lost job) is closed; a recent one still blocks", async () => {
  const db = fakeDb();
  await probeStart(db, jobs(async () => {}));
  assert.equal((await probeStart(db, jobs(async () => {}))).code, 1, "a recent unfinished probe blocks");
  db.rows.run[0].id = "44444444-4444-4444-8444-444444444444";
  const later = Date.now() + PROBE_STALE_MS + 1000;
  const v = await probeStart(db, jobs(async () => {}), () => later);
  assert.equal(v.code, 0);
  assert.equal(v.out.closedStaleProbeRuns, 1);
  assert.equal(db.rows.run[0].error, "probe-stale");
});

test("PR21-r1 probe-guard: the kill is allowed only while the worker holds the probe alone, mid-run", async () => {
  const seed = (status, turn, extra = []) => ({ project: [{ id: "pp", slug: "g1-probe" }], run: [{ id: RUN, projectId: "pp", model: PROBE_MODEL, status }, ...extra], turn });
  assert.equal((await probeGuard(fakeDb(seed("running", 1)), RUN, [RUN], 1)).code, 0);
  const skips = [
    [seed("running", 1), [RUN], 2, "worker-concurrency-not-1"],
    [seed("running", 1), [RUN, "other-job"], 1, "queue-active-not-only-probe"],
    [seed("running", 1), [], 1, "queue-active-not-only-probe"],
    [seed("running", 1, [{ id: "x", projectId: "real", status: "running" }]), [RUN], 1, "worker-busy"],
    [seed("succeeded", 4), [RUN], 1, "probe-not-running"],
    [seed("running", 3), [RUN], 1, "probe-turn-out-of-window"],
    [seed("running", 0), [RUN], 1, "probe-turn-out-of-window"],
  ];
  for (const [db, active, conc, reason] of skips) {
    const v = await probeGuard(fakeDb(db), RUN, active, conc);
    assert.equal(v.code, 3, reason);
    assert.equal(v.out.reason, reason);
  }
});

test("PR21-r1 probe-status: money is compared in exact microdollars (a duplicate 1 µUSD charge fails)", async () => {
  assert.equal(micros("0.001003"), 1003);
  assert.equal(micros("15"), 15_000_000);
  assert.ok(Number.isNaN(micros("1e-7")));
  const base = { ...runRow("succeeded"), turn: 4, events: resumedEvents };
  const exact = await probeStatus(fakeDb({ ...base, reservations: [{ status: "reconciled", actualUsd: "0.001003" }], costs: [{ usd: "0.001" }, { usd: "0.000003" }] }), RUN, true);
  assert.equal(exact.code, 0, JSON.stringify(exact.out));
  const dup = await probeStatus(fakeDb({ ...base, reservations: [{ status: "reconciled", actualUsd: "0.001003" }], costs: [{ usd: "0.001" }, { usd: "0.000004" }] }), RUN, true);
  assert.equal(dup.code, 1);
  assert.equal(dup.out.reason, "cost-not-reconciled");
});

test("PR21-r2 a probe run is closed only once its queue job is confirmed gone; otherwise it stays open", async () => {
  const boom = async () => { throw new Error("queue-enqueue-timeout"); };
  for (const fate of ["present", "unknown", new Error("redis down")]) {
    const db = fakeDb();
    const v = await probeStart(db, jobs(boom, fate));
    assert.equal(v.out.reason, "probe-enqueue-uncertain", String(fate));
    assert.equal(db.rows.run[0].status, "queued", "a run whose job may still execute is never closed");
  }
  for (const fate of ["removed", "absent"]) {
    const db = fakeDb();
    assert.equal((await probeStart(db, jobs(boom, fate))).out.reason, "probe-enqueue-failed");
    assert.equal(db.rows.run[0].status, "failed");
  }
  // a stale probe whose job a worker holds is not closed, and still blocks a new probe
  const db = fakeDb();
  await probeStart(db, jobs(async () => {}));
  const later = Date.now() + PROBE_STALE_MS + 1000;
  const held = await probeStart(db, jobs(async () => {}, "present"), () => later);
  assert.equal(held.out.reason, "probe-run-unfinished");
  assert.equal(db.rows.run.length, 1, "no second probe while the old job can still run");
});

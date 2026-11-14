// M2.2-d3b1 AT-MR6: the analyst task/run rows on real Postgres (FKs, the additive `analysis` task kind, the
// run_event read in seq order and the task closed when the run ends).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDb } from "@devos/db";
import { PrismaAnalystRunRows, PrismaAnalystRunSweeper, runEngineModelRunner, ANALYST_MODEL } from "../dist/analyst-runner.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

async function project() {
  const slug = `m22b-${randomBytes(6).toString("hex")}`;
  return db.project.create({ data: { slug, name: slug, stage: "intake" } });
}

test("AT-MR6 task (kind analysis) and analyst run rows satisfy the FKs; text events are read in seq order; the task is closed", async () => {
  const p = await project();
  const rows = new PrismaAnalystRunRows(db, 5_000);
  let runId;
  // The engine is stood in by direct run_event writes (M1.5's own store is tested in run-engine-db).
  const engine = {
    execute: async (input) => {
      runId = input.runId;
      await db.runEvent.create({ data: { runId, seq: 1, type: "status", payload: { state: "started" } } });
      await db.runEvent.create({ data: { runId, seq: 2, type: "text", payload: { text: "{\"requirements\":" } } });
      await db.runEvent.create({ data: { runId, seq: 3, type: "text", payload: { text: "[]}" } } });
      return { status: "succeeded" };
    },
  };
  const out = await runEngineModelRunner(rows, engine)({ prompt: "p", tag: "analyst_assist", projectId: p.id });
  assert.equal(out.output, "{\"requirements\":[]}");
  const run = await db.run.findUnique({ where: { id: runId }, include: { task: true } });
  assert.equal(run.projectId, p.id);
  assert.equal(run.role, "analyst");
  assert.equal(run.model, ANALYST_MODEL);
  assert.equal(run.maxTurns, 2);
  assert.equal(run.maxSeconds, 90);
  assert.equal(Number(run.maxCostUsd), 0.5);
  assert.equal(run.task.projectId, p.id);
  assert.equal(run.task.kind, "analysis");
  assert.equal(run.task.assignee, "agent");
  assert.equal(run.task.status, "done");
  const env = await db.capabilityEnvelope.findFirst({ where: { runId } });
  assert.deepEqual([env.tools, env.readPaths, env.writePaths, env.network, env.networkAllowList], [[], [], [], false, null], "deny-all envelope");
  assert.equal(Number(env.maxCostUsd), 0.5);

  const failing = { execute: async () => ({ status: "limit_hit" }) };
  await assert.rejects(runEngineModelRunner(rows, failing)({ prompt: "p", tag: "analyst_assist", projectId: p.id }), /analyst-run-limit_hit/);
  const tasks = await db.task.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(tasks.map((t) => t.status).sort(), ["done", "failed"]);

  // An engine that throws leaves the run queued; the runner closes it as failed (it is never re-queued).
  let thrownRun;
  const throwing = { execute: async (input) => { thrownRun = input.runId; throw new Error("store down"); } };
  await assert.rejects(runEngineModelRunner(rows, throwing)({ prompt: "p", tag: "analyst_assist", projectId: p.id }), /store down/);
  const abandoned = await db.run.findUnique({ where: { id: thrownRun } });
  assert.deepEqual([abandoned.status, abandoned.error], ["failed", "analyst-run-abandoned"]);
  assert.ok(abandoned.endedAt);
});

test("AT-MR6 an unknown project is refused by the FK and leaves no task", async () => {
  const rows = new PrismaAnalystRunRows(db, 5_000);
  const ghost = "00000000-0000-4000-8000-00000000abcd";
  await assert.rejects(rows.createRun({ projectId: ghost, title: "Analyst assist", model: ANALYST_MODEL, maxTurns: 2, maxSeconds: 90, maxCostUsd: 0.5 }));
  assert.equal(await db.task.count({ where: { projectId: ghost } }), 0);
});

test("AT-MR7 (DEVOS-161) an abandoned run's open reservation is settled fail-closed with its cost entry; other rows and engine-closed runs are left alone", async () => {
  const p = await project();
  const rows = new PrismaAnalystRunRows(db, 5_000);
  const reserve = (runId, data = {}) =>
    db.budgetReservation.create({ data: { projectId: p.id, runId, provider: "anthropic", reservedUsd: "0.500000", reservedTokens: 200_000, ...data } });
  const ledger = async (runId) => {
    const cost = (await db.costEntry.findMany({ where: { runId } })).reduce((a, c) => a + Number(c.usd), 0);
    const settled = (await db.budgetReservation.findMany({ where: { runId, status: "reconciled" } })).reduce((a, r) => a + Number(r.actualUsd), 0);
    return { cost: Math.round(cost * 1e6), settled: Math.round(settled * 1e6) };
  };
  const run = (engine) => runEngineModelRunner(rows, engine)({ prompt: "p", tag: "analyst_assist", projectId: p.id });

  // Another run's open reservation, to prove the run scoping.
  let otherRun;
  await run({ execute: async (i) => { otherRun = i.runId; return { status: "succeeded" }; } });
  const otherOpen = (await reserve(otherRun)).id;

  // 1. The engine reserves, then throws before recording or settling: the whole reservation is charged and reconciled.
  let r1, open1, settled1;
  await assert.rejects(run({
    execute: async (i) => {
      r1 = i.runId;
      open1 = (await reserve(i.runId)).id;
      settled1 = (await reserve(i.runId, { status: "reconciled", reservedUsd: "0.200000", actualUsd: "0.010000", actualTokens: 900 })).id;
      await db.costEntry.create({ data: { projectId: p.id, runId: i.runId, provider: "anthropic", model: ANALYST_MODEL, role: "analyst", usd: "0.010000" } });
      throw new Error("store down");
    },
  }), /store down/);
  const o1 = await db.budgetReservation.findUnique({ where: { id: open1 } });
  assert.deepEqual([o1.status, Number(o1.actualUsd), o1.actualTokens], ["reconciled", 0.5, 200_000], "charged the whole reservation");
  const s1 = await db.budgetReservation.findUnique({ where: { id: settled1 } });
  assert.deepEqual([s1.status, Number(s1.actualUsd), s1.actualTokens], ["reconciled", 0.01, 900], "an already settled reservation is unchanged");
  assert.deepEqual(await ledger(r1), { cost: 510_000, settled: 510_000 }, "the ledger matches the reconciled actuals (M1.5 invariant)");
  assert.equal((await db.run.findUnique({ where: { id: r1 } })).error, "analyst-run-abandoned");

  // 2. The engine recorded the crash cost but failed to settle: only the remainder is charged, never twice.
  let r2;
  await assert.rejects(run({
    execute: async (i) => {
      r2 = i.runId;
      await reserve(i.runId);
      await db.costEntry.create({ data: { projectId: p.id, runId: i.runId, provider: "anthropic", model: ANALYST_MODEL, role: "analyst", usd: "0.500000" } });
      throw new Error("settle failed");
    },
  }), /settle failed/);
  assert.deepEqual(await ledger(r2), { cost: 500_000, settled: 500_000 }, "no second charge for cost already recorded");

  // 3. The engine closed the run itself (it settles its own reservation): the runner does not touch it.
  let closedOpen;
  await assert.rejects(run({
    execute: async (i) => {
      closedOpen = (await reserve(i.runId)).id;
      await db.run.update({ where: { id: i.runId }, data: { status: "failed", error: "engine-error", endedAt: new Date() } });
      return { status: "failed" };
    },
  }), /analyst-run-failed/);
  assert.equal((await db.budgetReservation.findUnique({ where: { id: closedOpen } })).status, "reserved");
  assert.equal((await db.budgetReservation.findUnique({ where: { id: otherOpen } })).status, "reserved", "another run's reservation");
});

test("AT-MR8 (DEVOS-171) a run left open past max_seconds + grace is closed stale, its task failed and its reservation settled fail-closed; fresh, closed and non-analyst runs are left alone", async () => {
  const p = await project();
  const sweeper = new PrismaAnalystRunSweeper(db, 5_000);
  const mk = async ({ role = "analyst", status = "running", ageSec = 3600, startedAgo = null } = {}) => {
    const task = await db.task.create({ data: { projectId: p.id, kind: "analysis", assignee: "agent", title: "Analyst assist", status: "running" } });
    const created = new Date(Date.now() - ageSec * 1000);
    const run = await db.run.create({
      data: {
        taskId: task.id, projectId: p.id, role, model: ANALYST_MODEL, status, maxTurns: 2, maxSeconds: 90, maxCostUsd: "0.500000",
        createdAt: created, startedAt: startedAgo === null ? null : new Date(Date.now() - startedAgo * 1000),
      },
    });
    const res = await db.budgetReservation.create({ data: { projectId: p.id, runId: run.id, provider: "anthropic", reservedUsd: "0.500000", reservedTokens: 200_000 } });
    return { run: run.id, task: task.id, res: res.id };
  };
  const stale = await mk();                                   // created an hour ago, never started
  const staleStarted = await mk({ startedAgo: 600 });         // started 10 min ago: past 90 s + 5 min
  const fresh = await mk({ ageSec: 3600, startedAgo: 60 });    // started a minute ago: still within its bound
  const done = await mk({ status: "succeeded" });
  const builder = await mk({ role: "builder" });

  // A large limit, so stale runs other tests leave in the shared CI database cannot push these out of the batch.
  const ids = await sweeper.staleRunIds(10_000);
  assert.ok(ids.includes(stale.run) && ids.includes(staleStarted.run), "both stale runs are listed");
  for (const x of [fresh, done, builder]) assert.ok(!ids.includes(x.run), "fresh, closed and non-analyst runs are not listed");

  assert.equal(await sweeper.closeStale(stale.run), true);
  assert.equal(await sweeper.closeStale(stale.run), false, "a second close finds nothing open");
  assert.equal(await sweeper.closeStale(staleStarted.run), true);
  assert.equal(await sweeper.closeStale(fresh.run), false, "the bound is re-checked inside the transaction");

  for (const x of [stale, staleStarted]) {
    const run = await db.run.findUnique({ where: { id: x.run }, include: { task: true } });
    assert.deepEqual([run.status, run.error, run.task.status], ["failed", "analyst-run-stale", "failed"]);
    assert.ok(run.endedAt);
    const res = await db.budgetReservation.findUnique({ where: { id: x.res } });
    assert.deepEqual([res.status, Number(res.actualUsd)], ["reconciled", 0.5], "settled at the full reservation");
    const cost = (await db.costEntry.findMany({ where: { runId: x.run } })).reduce((a, c) => a + Number(c.usd), 0);
    assert.equal(Math.round(cost * 1e6), 500_000, "one cost entry for the charge");
  }
  for (const x of [fresh, done, builder]) {
    assert.equal((await db.budgetReservation.findUnique({ where: { id: x.res } })).status, "reserved", "untouched");
    assert.equal((await db.task.findUnique({ where: { id: x.task } })).status, "running", "untouched");
  }
});

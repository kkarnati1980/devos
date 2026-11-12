// M2.2-d3b1 AT-MR6: the analyst task/run rows on real Postgres (FKs, the additive `analysis` task kind, the
// run_event read in seq order and the task closed when the run ends).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDb } from "@devos/db";
import { PrismaAnalystRunRows, runEngineModelRunner, ANALYST_MODEL } from "../dist/analyst-runner.js";

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

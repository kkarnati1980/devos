// M1.5 against real Postgres 17 through the M1.1 Prisma client and the M1.7 PrismaPolicyStore
// (workflow run-engine-db). Proves the store works with the M1.1 triggers and checks.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDb } from "@devos/db";
import { PolicyEngine, PrismaPolicyStore } from "@devos/policy";
import { ClaudeAgentSdkAdapter, PrismaRunStore, RunEngine } from "../dist/index.js";
import { fakeQuery, runFixture } from "./helpers.mjs";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());
const KEY = randomBytes(32);
const policyFor = (budgets = []) => new PolicyEngine({ store: new PrismaPolicyStore(db), hmacKey: KEY, budgets });

test("DB: a run stores gapless events, per-turn telemetry with the tag, cost and a reconciled reservation", async () => {
  const f = await runFixture(db);
  const engine = new RunEngine({ store: new PrismaRunStore(db), policy: policyFor(), adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ turns: 2 }) }) });
  const out = await engine.execute({ runId: f.runId, provider: "anthropic", prompt: "x", cwd: ".", tag: "standard_selection" });
  assert.equal(out.status, "succeeded");
  const evs = await db.runEvent.findMany({ where: { runId: f.runId }, orderBy: { seq: "asc" } });
  evs.forEach((e, i) => assert.equal(e.seq, i + 1));
  assert.equal(evs.at(-1).type, "done");
  const tel = await db.runTelemetry.findMany({ where: { runId: f.runId }, orderBy: { turn: "asc" } });
  assert.deepEqual(tel.map((t) => [t.turn, t.inputTokens, t.toolResultBytes, t.tag]), [[1, 100, 0, "standard_selection"], [2, 100, 64, "standard_selection"]]);
  const cost = await db.costEntry.findMany({ where: { runId: f.runId } });
  assert.equal(cost.length, 1);
  assert.equal(String(cost[0].usd), "0.12");
  const res = await db.budgetReservation.findMany({ where: { runId: f.runId } });
  assert.equal(res.length, 1);
  assert.equal(res[0].status, "reconciled");
  const run = await db.run.findUnique({ where: { id: f.runId } });
  assert.equal(run.status, "succeeded");
  assert.equal(run.turns, 2);
});

test("DB: a killed run resumes from its checkpoint; the gapless trigger accepts the continued seq", async () => {
  const f = await runFixture(db);
  const real = new PrismaRunStore(db);
  let n = 0;
  const dying = Object.create(real);
  dying.appendEvent = async (e) => {
    if (++n >= 7) throw new Error("worker-killed");
    return real.appendEvent(e);
  };
  const calls = [];
  await assert.rejects(new RunEngine({ store: dying, policy: policyFor(), adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ turns: 2, calls }) }) }).execute({ runId: f.runId, provider: "anthropic", prompt: "x", cwd: "." }), /worker-killed/);
  const cp = await db.checkpoint.findFirst({ where: { runId: f.runId }, orderBy: { seq: "desc" } });
  assert.ok(cp.data.turn >= 1);
  const out = await new RunEngine({ store: real, policy: policyFor(), adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery({ turns: 1, calls }) }) }).execute({ runId: f.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(out.status, "succeeded");
  assert.equal(calls[1].options.resume, "sess-db");
  const evs = await db.runEvent.findMany({ where: { runId: f.runId }, orderBy: { seq: "asc" } });
  evs.forEach((e, i) => assert.equal(e.seq, i + 1));
  assert.ok(evs.some((e) => e.payload.state === "resumed"));
  assert.equal((await db.run.findUnique({ where: { id: f.runId } })).turns, cp.data.turn + 1);
});

test("DB: a budget stop records budget_exceeded (not an attempt), pauses the project and raises a card", async () => {
  const f = await runFixture(db);
  const engine = new RunEngine({ store: new PrismaRunStore(db), policy: policyFor([{ id: `cap-${f.projectId}`, projectId: f.projectId, maxCostUsd: 1, maxTokens: 10_000_000 }]), adapterFor: () => new ClaudeAgentSdkAdapter({ query: fakeQuery() }) });
  const out = await engine.execute({ runId: f.runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(out.status, "limit_hit");
  const errs = await db.runError.findMany({ where: { runId: f.runId } });
  assert.deepEqual(errs.map((e) => [e.type, e.countsAsAttempt]), [["budget_exceeded", false]]);
  assert.ok((await db.project.findUnique({ where: { id: f.projectId } })).pausedAt);
  const cards = await db.approval.findMany({ where: { projectId: f.projectId } });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, "pending");
  assert.equal(cards[0].gate, "destructive_or_spend");
  assert.ok(await db.checkpoint.findFirst({ where: { runId: f.runId } }));
  assert.equal((await db.run.findUnique({ where: { id: f.runId } })).status, "limit_hit");
});

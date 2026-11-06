// M1.7 AT6–AT8 and grants against real Postgres through the M1.1 Prisma client (policy-db workflow).
// Rows are committed (policy_decision is append-only), so every test uses its own chain and project.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createDb } from "@devos/db";
import { PolicyEngine, PrismaPolicyStore, verifyLedger } from "../dist/index.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

const KEY = randomBytes(32);
const KK = { identity: { id: "kk:kk@kiot.io", type: "kk" }, tailscaleLogin: "kk@kiot.io" };
const AGENT = { id: "agent:builder:run-1", type: "agent", roles: ["builder"] };

async function project() {
  const slug = `policy-${randomBytes(8).toString("hex")}`;
  return (await db.project.create({ data: { slug, name: slug } })).id;
}

async function rule(name, effect, actions, constraints = {}) {
  return db.policyRule.create({
    data: { name: `${name}-${randomUUID()}`, version: 1, priority: 0, actions, resources: [], principals: [], roles: [], environments: [], effect, constraints, createdBy: "kk:kk@kiot.io" },
  });
}

const engineFor = (budgets = []) => new PolicyEngine({
  store: new PrismaPolicyStore(db),
  hmacKey: KEY,
  budgets,
  verifyKkSession: (s) => s.tailscaleLogin === "kk@kiot.io",
});

test("loadPolicy: no policy_state row means observe", async () => {
  const { mode } = await new PrismaPolicyStore(db).loadPolicy();
  const state = await db.policyState.findFirst({ where: { singleton: true } });
  assert.equal(mode, state?.mode ?? "observe");
});

test("AT6 (db): 20 concurrent budget decisions never exceed the ceiling", async () => {
  const projectId = await project();
  await rule("llm", "allow", ["llm.call"]);
  const engine = engineFor([{ id: "cap", provider: "openai", projectId, maxCostUsd: 1, maxTokens: 1_000_000 }]);
  const chain = `at6-${randomUUID()}`;
  const call = () => engine.decide({ chain, identity: AGENT, action: { type: "llm.call", budgeted: true, provider: "openai", projectId, costUsd: 0.15, tokens: 10 } });
  const results = await Promise.all(Array.from({ length: 20 }, call));
  assert.equal(results.filter((r) => r.enforcedOutcome === "allow").length, 6);
  const sum = await db.budgetReservation.aggregate({ where: { projectId, status: "reserved" }, _sum: { reservedUsd: true } });
  assert.ok(Number(String(sum._sum.reservedUsd)) <= 1, String(sum._sum.reservedUsd));
  const rows = await db.policyDecision.findMany({ where: { chain }, orderBy: { seq: "asc" } });
  assert.deepEqual(rows.map((r) => r.seq), Array.from({ length: 20 }, (_, i) => i + 1), "gapless chain under concurrency");
  const allowed = results.find((r) => r.enforcedOutcome === "allow");
  await engine.reconcile(allowed.reservationId, 0.01, 1);
  assert.equal((await call()).enforcedOutcome, "allow");
});

test("AT7 (db): the stored chain verifies; one changed byte fails; the table rejects edits", async () => {
  await rule("a", "allow", ["x"]);
  const engine = engineFor();
  const chain = `at7-${randomUUID()}`;
  for (let i = 0; i < 4; i++) await engine.decide({ chain, identity: AGENT, action: { type: "x", resource: `r${i}`, costUsd: 0.1 } });
  assert.deepEqual(await engine.verify(chain), { valid: true, length: 4 });
  const rows = await new PrismaPolicyStore(db).readChain(chain);
  const copy = structuredClone(rows);
  copy[1].action.request.resource = "r9";
  assert.equal(verifyLedger(copy, KEY).valid, false);
  await assert.rejects(db.policyDecision.updateMany({ where: { chain }, data: { outcome: "deny" } }));
  await assert.rejects(db.policyDecision.deleteMany({ where: { chain } }));
});

test("AT8 (db): the row exists when decide resolves; a failed insert rolls back the reservation", async () => {
  await rule("llm", "allow", ["llm.call"]);
  const engine = engineFor([{ id: "c", provider: "anthropic", maxCostUsd: 1000, maxTokens: 1e9 }]);
  const chain = `at8-${randomUUID()}`;
  const d = await engine.decide({ chain, identity: AGENT, action: { type: "llm.call", budgeted: true, provider: "anthropic", costUsd: 0.2, tokens: 5 } });
  const row = await db.policyDecision.findUnique({ where: { hash: d.receipt.hash } });
  assert.ok(row);
  assert.equal(row.enforcedOutcome, "allow");
  // A run id that does not exist fails a run FK inside the decision transaction: decide must reject,
  // and nothing from that transaction (reservation or receipt) may remain.
  const before = await db.budgetReservation.count();
  await assert.rejects(engine.decide({ chain, identity: AGENT, action: { type: "llm.call", budgeted: true, provider: "anthropic", runId: randomUUID(), costUsd: 0.2, tokens: 5 } }));
  assert.equal(await db.budgetReservation.count(), before);
  assert.equal(await db.policyDecision.count({ where: { chain } }), 1);
});

test("AT4 (db): grants are KK-only, limited-use and revocable", async () => {
  const action = `deploy-${randomUUID()}`;
  await rule("needs-kk", "require_approval", [action]);
  const engine = engineFor();
  const chain = `at4-${randomUUID()}`;
  const grant = await engine.issueGrant(KK, { scopeAction: action, expiresAt: new Date(Date.now() + 3_600_000), maxUses: 1 });
  assert.equal((await engine.decide({ chain, identity: AGENT, action: { type: action }, approvalGrantId: grant.id })).outcome, "allow");
  const again = await engine.decide({ chain, identity: AGENT, action: { type: action }, approvalGrantId: grant.id });
  assert.match(again.reason, /grant-used-up/);
  assert.equal((await db.approvalGrant.findUnique({ where: { id: grant.id } })).uses, 1);
  const g2 = await engine.issueGrant(KK, { scopeAction: action, expiresAt: new Date(Date.now() + 3_600_000) });
  assert.equal(await engine.revokeGrant(KK, g2.id), true);
  assert.equal(await engine.revokeGrant(KK, g2.id), false);
  assert.match((await engine.decide({ chain, identity: AGENT, action: { type: action }, approvalGrantId: g2.id })).reason, /grant-revoked/);
});

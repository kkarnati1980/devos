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

const engineFor = (budgets = [], now = Date.now) => new PolicyEngine({
  store: new PrismaPolicyStore(db),
  hmacKey: KEY,
  budgets,
  now,
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
  // PR13-r2: the reservation insert must SUCCEED and the receipt insert then fail in Postgres (a
  // hash that breaks the policy_decision_hash_format CHECK). Both writes must be absent afterwards.
  const store = new PrismaPolicyStore(db);
  const realDecide = store.decide.bind(store);
  let reservationsInTx = -1;
  store.decide = (fn) => realDecide((tx) => fn({
    ...tx,
    insertReservation: async (r) => {
      const id = await tx.insertReservation(r);
      reservationsInTx = 1;
      return id;
    },
    insertDecision: (row) => tx.insertDecision({ ...row, hash: "not-a-sha256" }),
  }));
  const failing = new PolicyEngine({ store, hmacKey: KEY, budgets: [{ id: "c", provider: "anthropic", maxCostUsd: 1000, maxTokens: 1e9 }] });
  const reservationsBefore = await db.budgetReservation.count();
  const decisionsBefore = await db.policyDecision.count();
  await assert.rejects(failing.decide({ chain, identity: AGENT, action: { type: "llm.call", budgeted: true, provider: "anthropic", costUsd: 0.2, tokens: 5 } }), /hash_format|check|constraint/i);
  assert.equal(reservationsInTx, 1, "the reservation was written inside the failed transaction");
  assert.equal(await db.budgetReservation.count(), reservationsBefore, "reservation rolled back");
  assert.equal(await db.policyDecision.count(), decisionsBefore, "no receipt");
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

test("AT4 (db, PR13-r1): self-approval, expiry, scope and issuer checks against PrismaPolicyStore", async () => {
  const action = `release-${randomUUID()}`;
  await rule("needs-kk", "require_approval", [action]);
  let now = Date.now();
  const engine = engineFor([], () => now);
  const chain = `at4b-${randomUUID()}`;
  const ask = (identity, grant, extra = {}) => engine.decide({ chain, identity, action: { type: action, ...extra }, approvalGrantId: grant.id });
  const hour = 3_600_000;
  const before = await db.approvalGrant.count();
  await assert.rejects(engine.issueGrant({ identity: AGENT, tailscaleLogin: "kk@kiot.io" }, { scopeAction: action, expiresAt: new Date(now + hour) }), /grant-issuer-not-kk/);
  await assert.rejects(engine.issueGrant({ ...KK, tailscaleLogin: "mallory@example.com" }, { scopeAction: action, expiresAt: new Date(now + hour) }), /unverified/);
  await assert.rejects(engine.issueGrant(KK, { scopeAction: action, expiresAt: new Date(now + 91 * 24 * hour) }), /grant-expiry-invalid/);
  assert.equal(await db.approvalGrant.count(), before, "refused issuances write nothing");

  const self = await engine.issueGrant(KK, { scopeAction: action, expiresAt: new Date(now + hour) });
  const dSelf = await ask(KK.identity, self);
  assert.equal(dSelf.outcome, "require_approval");
  assert.match(dSelf.reason, /grant-self-approval/);

  const projectId = await project();
  const scoped = await engine.issueGrant(KK, { scopeAction: action, projectId, sha: "a".repeat(40), expiresAt: new Date(now + hour) });
  assert.match((await ask(AGENT, scoped)).reason, /grant-scope-project/);
  assert.match((await ask(AGENT, scoped, { projectId, sha: "b".repeat(40) })).reason, /grant-scope-sha/);
  assert.equal((await ask(AGENT, scoped, { projectId, sha: "a".repeat(40) })).outcome, "allow");

  const expiring = await engine.issueGrant(KK, { scopeAction: action, expiresAt: new Date(now + hour) });
  now += hour;
  assert.match((await ask(AGENT, expiring)).reason, /grant-expired/);
  const unused = await db.approvalGrant.findUnique({ where: { id: expiring.id } });
  assert.equal(unused.uses, 0, "a rejected grant is not consumed");
});

test("AT6 (db, PR13-r3): reconcile waits for the policy lock, so a decision never double-counts a row", async () => {
  const projectId = await project();
  await rule("llm", "allow", ["llm.call"]);
  const budgets = [{ id: "cap", provider: "openai", projectId, maxCostUsd: 1, maxTokens: 1e9 }];
  const base = engineFor(budgets);
  const chain = `r3-${randomUUID()}`;
  const ask = (engine, costUsd) => engine.decide({ chain, identity: AGENT, action: { type: "llm.call", budgeted: true, provider: "openai", projectId, costUsd, tokens: 1 } });
  const first = await ask(base, 0.6);
  assert.equal(first.enforcedOutcome, "allow");

  // A decision that pauses inside its usage read while holding the lock.
  const store = new PrismaPolicyStore(db);
  const realDecide = store.decide.bind(store);
  let release;
  const paused = new Promise((r) => { release = r; });
  let inUsage;
  const reached = new Promise((r) => { inUsage = r; });
  store.decide = (fn) => realDecide((tx) => fn({ ...tx, usage: async (f) => { const u = await tx.usage(f); inUsage(); await paused; return u; } }));
  const slow = new PolicyEngine({ store, hmacKey: KEY, budgets });
  const pending = ask(slow, 0.3);
  await reached;
  let reconciled = false;
  const rec = base.reconcile(first.reservationId, 0.2, 1).then(() => { reconciled = true; });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(reconciled, false, "reconcile is blocked while a decision holds the lock");
  release();
  const d = await pending;
  await rec;
  assert.equal(d.enforcedOutcome, "allow", "0.6 reserved + 0.3 fits a 1.00 ceiling");
  assert.equal((await ask(base, 0.5)).enforcedOutcome, "allow", "0.2 actual + 0.3 + 0.5 = 1.00");
  assert.equal((await ask(base, 0.000001)).enforcedOutcome, "deny");
});

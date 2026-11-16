// DEVOS-110 (docs/modules/M2.4.md "M2.4-d follow-up: the probe's grant card"), acceptance tests a–e: the probe's
// fixed grant card, raised by code, and the fixed `teardown.*` grant its approval issues. Core service against the
// in-memory approvals store and the real M1.7 engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryPolicyStore, PolicyEngine, grantProblem } from "@devos/policy";
import { KkSessionRegistry } from "../dist/auth.js";
import { Approvals, ApprovalError, MemoryApprovalStore, parseCard, PROBE_GRANT_CARD_ACTION } from "../dist/approvals.js";
import {
  cycleStartWithCard, findProbeGrant, grantAuthorizer, probeCycleStart, probeGrantCard, raiseProbeGrantCard, PROBE_CARD_REASK_MS,
} from "../dist/provision-probe-purge.js";
import { isProbeProjectRow, PROBE_SLUG } from "../dist/provision-probe.js";

const KEY = Buffer.alloc(32, 9);
const PROBE = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";
const DAY = 24 * 3600 * 1000;

const teardownRule = {
  id: "r-teardown", name: "teardown needs KK", version: 1, priority: 10, actions: ["teardown.*"], resources: [], principals: [],
  roles: [], environments: [], effect: "require_approval", constraints: {}, enabled: true,
};

function setup({ probeIds = [PROBE], isProbeProject } = {}) {
  let now = Date.parse("2026-11-16T12:00:00Z");
  const kk = new KkSessionRegistry();
  const policyStore = new MemoryPolicyStore({ mode: "enforce", rules: [teardownRule] });
  const engine = new PolicyEngine({ store: policyStore, hmacKey: KEY, now: () => now, verifyKkSession: kk.verify });
  const store = new MemoryApprovalStore();
  const probeCheck = isProbeProject ?? (async (id) => probeIds.includes(id));
  const approvals = new Approvals({ store, grants: engine, notifier: null, verifyKkSession: kk.verify, isProbeProject: probeCheck, now: () => now });
  const deps = { list: (f) => approvals.store.list(f), raise: (c) => approvals.raiseCard(c) };
  return { approvals, store, engine, policyStore, deps, session: kk.mint("kk@example.com"), now: () => now, advance: (ms) => (now += ms) };
}

/** A fake db over the engine's grants, for the probe's read-only grant check (findProbeGrant). */
function grantDb(policyStore, stage = "intake") {
  const tx = {
    approvalGrant: { findMany: async ({ where }) => [...policyStore.grants].filter((g) => g.projectId === where.projectId && !g.revokedAt && g.expiresAt > where.expiresAt.gt) },
    project: { findUnique: async () => ({ stage }), updateMany: async () => ({ count: 1 }) },
    resource: { count: async () => 0 },
    auditEvent: { create: async () => ({}) },
  };
  return { $transaction: async (fn) => fn(tx) };
}

test("a: a blocked cycle raises exactly one fixed card; a second blocked tick raises none; a rejection holds for 7 days", async () => {
  const s = setup();
  const blocked = async () => ({ blocked: "probe-purge-not-approved" });
  let raised = 0;
  const raise = async () => { const r = await raiseProbeGrantCard(PROBE, new Date(s.now()), s.deps); if (r) raised++; return r; };
  assert.deepEqual(await cycleStartWithCard(blocked, raise), { blocked: "probe-purge-not-approved" });
  assert.deepEqual(await cycleStartWithCard(blocked, raise), { blocked: "probe-purge-not-approved" });
  assert.equal(raised, 1);
  const cards = await s.store.list({ limit: 10 });
  assert.equal(cards.length, 1);
  const c = cards[0];
  assert.equal(c.status, "pending");
  assert.equal(c.action, PROBE_GRANT_CARD_ACTION);
  assert.equal(c.target, `project:${PROBE}`);
  assert.equal(c.projectId, PROBE);
  assert.equal(c.gate, "destructive_or_spend");
  assert.equal(c.reason, probeGrantCard(PROBE).reason);
  assert.equal(c.consequence, probeGrantCard(PROBE).consequence);

  await s.approvals.reject(s.session, c.id, "not now");
  s.advance(PROBE_CARD_REASK_MS - 60_000);
  assert.equal(await raise(), false, "a rejection is not re-asked within 7 days");
  s.advance(2 * 60_000);
  assert.equal(await raise(), true, "asked again after 7 days");
  assert.equal((await s.store.list({ status: "pending", limit: 10 })).length, 1);

  // Pre-review 3: an approval KK later revokes holds re-asking for 7 days, like a rejection.
  const [p2] = await s.store.list({ status: "pending", limit: 1 });
  const { grantId } = await s.approvals.approve(s.session, p2.id);
  await s.engine.revokeGrant(s.session, grantId);
  s.advance(PROBE_CARD_REASK_MS - 60_000);
  assert.equal(await raise(), false, "a revoked approval is not re-asked within 7 days");
  s.advance(2 * 60_000);
  assert.equal(await raise(), true);

  // A cycle that is not blocked for the grant raises nothing; a card that cannot be raised keeps the cycle blocked.
  let called = 0;
  assert.equal(await cycleStartWithCard(async () => "ready", async () => { called++; return true; }), "ready");
  assert.deepEqual(await cycleStartWithCard(async () => ({ blocked: "other" }), async () => { called++; return true; }), { blocked: "other" });
  assert.equal(called, 0);
  assert.deepEqual(
    await cycleStartWithCard(blocked, async () => { throw new Error("db down"); }),
    { blocked: "probe-purge-not-approved:card-failed" },
  );
});

test("b: approving the card issues the fixed teardown.* grant (90 days, 30 uses) and the next cycle is ready", async () => {
  const s = setup();
  await raiseProbeGrantCard(PROBE, new Date(s.now()), s.deps);
  const [c] = await s.store.list({ limit: 1 });
  // Options cannot change the fixed grant.
  const { grantId } = await s.approvals.approve(s.session, c.id, { expiresInHours: 1, maxUses: 1, sha: "b".repeat(40) });
  const grants = [...s.policyStore.grants];
  assert.equal(grants.length, 1);
  const g = grants[0];
  assert.equal(g.id, grantId);
  assert.equal(g.approvalId, c.id);
  assert.equal(g.scopeAction, "teardown.*");
  assert.equal(g.scopeResource, null);
  assert.equal(g.projectId, PROBE);
  assert.equal(g.sha, null);
  assert.equal(g.maxUses, 30);
  assert.equal(g.expiresAt.getTime() - s.now(), 90 * DAY);

  const db = grantDb(s.policyStore);
  const now = new Date(s.now());
  assert.equal(await findProbeGrant(db, PROBE, now, 1000, grantProblem), grantId);
  assert.equal(await probeCycleStart(db, PROBE, 1000, async () => (await findProbeGrant(db, PROBE, now, 1000, grantProblem)) !== null), "ready");
  // The engine lifts require_approval for the probe's own teardown with that grant, and only on its project.
  const authorize = grantAuthorizer(s.engine, PROBE, grantId);
  assert.equal(await authorize("teardown.purge", `project:${PROBE}`), "allow");
  assert.notEqual(await grantAuthorizer(s.engine, OTHER, grantId)("teardown.purge", `project:${OTHER}`), "allow");
});

test("c: the same action on a non-probe project, or with a mismatched target, is refused and issues no grant", async () => {
  const s = setup({ probeIds: [PROBE] });
  const other = await s.approvals.raiseCard(probeGrantCard(OTHER));
  await assert.rejects(s.approvals.approve(s.session, other.id), (e) => e instanceof ApprovalError && e.code === "invalid-input");
  const skew = await s.approvals.raiseCard({ ...probeGrantCard(PROBE), target: `project:${OTHER}` });
  await assert.rejects(s.approvals.approve(s.session, skew.id), (e) => e instanceof ApprovalError && e.code === "invalid-input");
  // Pre-review 1: a policy card for the same action (a rule's reason or gate) is not the fixed card.
  const policyCard = await s.approvals.raiseCard({ ...probeGrantCard(PROBE), reason: "Policy requires approval", consequence: null });
  await assert.rejects(s.approvals.approve(s.session, policyCard.id), (e) => e instanceof ApprovalError && e.code === "invalid-input");
  await s.approvals.reject(s.session, policyCard.id);
  const otherGate = await s.approvals.raiseCard({ ...probeGrantCard(PROBE), gate: "decision" });
  await assert.rejects(s.approvals.approve(s.session, otherGate.id), (e) => e instanceof ApprovalError && e.code === "invalid-input");
  await s.approvals.reject(s.session, otherGate.id);
  const noProject = await s.approvals.raiseCard({ ...probeGrantCard(PROBE), projectId: null });
  await assert.rejects(s.approvals.approve(s.session, noProject.id), (e) => e instanceof ApprovalError && e.code === "invalid-input");
  assert.equal([...s.policyStore.grants].length, 0);
  for (const id of [other.id, skew.id, noProject.id]) assert.equal((await s.store.get(id)).status, "pending");

  // Not wired, or the check failing: no grant either.
  const unwired = setup();
  const u = new Approvals({ store: unwired.store, grants: unwired.engine, notifier: null, verifyKkSession: () => true, now: unwired.now });
  const uc = await u.raiseCard(probeGrantCard(PROBE));
  await assert.rejects(u.approve(unwired.session, uc.id), (e) => e.code === "invalid-input");
  const failing = setup({ isProbeProject: async () => { throw new Error("db down"); } });
  const fc = await failing.approvals.raiseCard(probeGrantCard(PROBE));
  await assert.rejects(failing.approvals.approve(failing.session, fc.id), (e) => e.code === "approvals-store-error" && e.status === 500);
  assert.equal([...unwired.policyStore.grants].length + [...failing.policyStore.grants].length, 0);
});

test("d: a card with any other action still gets its card-scoped grant (regression)", async () => {
  const s = setup();
  const c = await s.approvals.raiseCard({ gate: "decision", action: "teardown.archive", target: `project:${PROBE}`, reason: "Archive", projectId: PROBE });
  await s.approvals.approve(s.session, c.id, { expiresInHours: 2, maxUses: 3 });
  const [g] = [...s.policyStore.grants];
  assert.equal(g.scopeAction, "teardown.archive");
  assert.equal(g.scopeResource, `project:${PROBE}`);
  assert.equal(g.maxUses, 3);
  assert.equal(g.expiresAt.getTime() - s.now(), 2 * 3600 * 1000);
});

test("e: the card text is fixed, holds no secret and no provider value, and is not a gate-5 purge card", () => {
  const a = probeGrantCard(PROBE);
  const b = probeGrantCard(OTHER);
  for (const k of ["gate", "action", "reason", "consequence"]) assert.equal(a[k], b[k], `${k} does not depend on the project`);
  assert.equal(a.target, `project:${PROBE}`);
  const parsed = parseCard(a);
  assert.equal(typeof parsed, "object", "parseCard accepts it (no secret shape, no wildcard)");
  assert.equal(parsed.gate, "destructive_or_spend");
  assert.ok(!a.action.includes("*") && !a.target.includes("*"));
  assert.ok(!/https?:|token|password|ghp_|sk-/i.test(`${a.reason} ${a.consequence}`));
});

test("isProbeProjectRow: only the probe's slug with its probe_started audit row", async () => {
  const db = (row, audit) => ({ $transaction: async (fn) => fn({
    project: { findUnique: async () => row },
    auditEvent: { findFirst: async ({ where }) => (audit && where.action === "provision.probe_started" ? { id: "a1" } : null) },
  }) });
  assert.equal(await isProbeProjectRow(db({ slug: PROBE_SLUG }, true), PROBE, 1000), true);
  assert.equal(await isProbeProjectRow(db({ slug: PROBE_SLUG }, false), PROBE, 1000), false);
  assert.equal(await isProbeProjectRow(db({ slug: "real-app" }, true), PROBE, 1000), false);
  assert.equal(await isProbeProjectRow(db(null, true), PROBE, 1000), false);
});

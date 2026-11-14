// ADR-0012 CR-a2 (DEVOS-198): the pre-flight on Postgres — migration defaults (AT3 backfill), the stored list,
// the decision log written with the approval (AT4), rejection and re-open (AT6). Runs in CI `api-db`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDb } from "@devos/db";
import { RequirementsPipeline } from "@devos/analyst";
import { PrismaRequirementsStore } from "../dist/requirements-store.js";
import { preflightOpen, preflightSecretName } from "../dist/preflight.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

const SPEC = `## Requirements

### FR-1: Login

- Login succeeds

## Open questions

- Which payment provider should we pay for?
`;

async function project(data = {}) {
  const slug = `cra2-${randomBytes(6).toString("hex")}`;
  return db.project.create({ data: { slug, name: slug, stage: "intake", ...data } });
}

function pipeline(store, decisionCards) {
  const card = (gate) => async (c) => {
    const row = await db.approval.create({ data: { gate, action: c.action ?? c.card.action, target: c.target ?? c.card.target, reason: c.reason ?? "test", projectId: c.projectId ?? c.card.projectId } });
    if (gate === "decision") decisionCards.push(row.id);
    return { id: row.id };
  };
  return new RequirementsPipeline({ store, raiseRequirementsCard: card("requirements"), raiseQuestionCard: (d) => card("decision")(d), secretNames: async () => ["PAYMENTS_KEY"] });
}

test("AT3/AT4/AT6 (CR-a2, db): new projects default to the mode; approval writes the decision log in its transaction; rejection closes; a new version re-opens", async () => {
  const p = await project();
  assert.equal(p.continuousRun, true, "rows inserted after the migration default to continuous-run");
  assert.equal(p.preflightState, "pending");
  const store = new PrismaRequirementsStore(db, 5000);
  const decisionCards = [];
  const r = await pipeline(store, decisionCards).submitSpec(p.id, { kind: "paste", text: SPEC });
  assert.equal(decisionCards.length, 0, "no separate decision card in the mode");
  const card = await db.approval.findUnique({ where: { id: r.approvalId } });
  assert.match(card.reason, /Pre-flight: \d+ questions, 1 secrets/);
  assert.deepEqual(await store.latestPreflight(p.id), r.preflight);
  assert.equal(await store.preflightState(p.id), "pending");
  const vault = (has) => ({ hasProject: async (_pid, n) => has && n === preflightSecretName("PAYMENTS_KEY") });
  assert.equal(await preflightOpen(p.id, store, vault(true)), false, "pending");

  // Rejection closes; a new version re-opens.
  await db.approval.update({ where: { id: r.approvalId }, data: { status: "rejected", decidedAt: new Date(), decidedBy: "kk:test" } });
  assert.equal(await pipeline(store, []).applyDecision({ id: r.approvalId, gate: "requirements", status: "rejected" }), "rejected");
  assert.equal(await store.preflightState(p.id), "rejected");
  const r2 = await pipeline(store, []).submitSpec(p.id, { kind: "paste", text: SPEC });
  assert.equal(await store.preflightState(p.id), "pending");

  // Approval with `PF-1: yes`: one row per decision item, in the approval's transaction; a retry adds nothing.
  const pl = pipeline(store, []);
  assert.equal(await pl.applyDecision({ id: r2.approvalId, gate: "requirements", status: "approved" }, ["PF-1: yes"]), "approved");
  const rows = await db.projectDecision.findMany({ where: { projectId: p.id }, orderBy: { itemId: "asc" } });
  const decisions = r2.preflight.filter((i) => i.kind === "decision");
  assert.equal(rows.length, decisions.length);
  assert.deepEqual(rows.find((x) => x.itemId === "PF-1").source, "kk");
  assert.ok(rows.filter((x) => x.itemId !== "PF-1").every((x) => x.source === "default" && x.approvalId === r2.approvalId));
  assert.equal(await store.preflightState(p.id), "approved");
  assert.equal(await preflightOpen(p.id, store, vault(false)), false, "approved, secret missing");
  assert.equal(await preflightOpen(p.id, store, vault(true)), true);
  await assert.rejects(
    db.projectDecision.create({ data: { projectId: p.id, approvalId: r2.approvalId, itemId: "PF-1", text: "t", answer: "a", source: "kk" } }),
    "unique on (approval, item)",
  );
  await assert.rejects(db.projectDecision.create({ data: { projectId: p.id, itemId: "PF-9", text: "t", answer: "a", source: "other" } }), "source CHECK");
  await assert.rejects(db.project.update({ where: { id: p.id }, data: { preflightState: "open" } }), "state CHECK");
});

test("AT3 (CR-a2, db): a project with the mode off and state approved (the backfill) is open with no pre-flight list", async () => {
  const p = await project({ continuousRun: false, preflightState: "approved" });
  const store = new PrismaRequirementsStore(db, 5000);
  const decisionCards = [];
  const r = await pipeline(store, decisionCards).submitSpec(p.id, { kind: "paste", text: SPEC });
  assert.equal(r.preflight, null);
  assert.ok(decisionCards.length > 0, "mode off raises the decision cards as before");
  assert.equal(await store.latestPreflight(p.id), null);
  assert.equal(await preflightOpen(p.id, store, { hasProject: async () => false }), true);
});

test("CR-a2 pre-review 2 (db): the sync lister picks up a rejected intake card until preflight_state is rejected", async () => {
  const store = new PrismaRequirementsStore(db, 5000);
  const rejected = await project();
  const modeOff = await project({ continuousRun: false, preflightState: "approved" });
  const r = await pipeline(store, []).submitSpec(rejected.id, { kind: "paste", text: SPEC });
  const r0 = await pipeline(store, []).submitSpec(modeOff.id, { kind: "paste", text: SPEC });
  await db.approval.updateMany({ where: { id: { in: [r.approvalId, r0.approvalId] } }, data: { status: "rejected", decidedAt: new Date(), decidedBy: "kk:test" } });
  const ours = (ids) => ids.filter((id) => id === rejected.id || id === modeOff.id);
  assert.deepEqual(ours(await store.draftsAwaitingDecision(1000)), [rejected.id], "rejected with a pre-flight is listed; mode off is not");
  assert.equal(await pipeline(store, []).applyDecision({ id: r.approvalId, gate: "requirements", status: "rejected" }), "rejected");
  assert.equal(await store.preflightState(rejected.id), "rejected");
  assert.deepEqual(ours(await store.draftsAwaitingDecision(1000)), [], "once rejected it drops out of the batch");
});

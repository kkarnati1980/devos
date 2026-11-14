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
  assert.deepEqual(await store.preflightSnapshot(p.id), { state: "pending", items: r.preflight, approvalId: r.approvalId }, "one-statement snapshot");
  assert.equal(await store.preflightSnapshot("00000000-0000-4000-8000-000000000000"), null);
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
  // CR-a3 (Codex PR127-r1): the page's answers are scoped to the newest doc's card, from the same snapshot.
  assert.equal((await store.preflightSnapshot(p.id)).approvalId, r2.approvalId);
  assert.equal((await store.decisions(p.id, r2.approvalId)).length, decisions.length);
  assert.deepEqual(await store.decisions(p.id, r.approvalId), [], "the rejected version's card has no rows");
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

test("DEVOS-205 (db): approving a doc without a pre-flight on a pending project opens the state; rejected stays", async () => {
  const store = new PrismaRequirementsStore(db, 5000);
  const mk = async (state) => {
    const p = await project({ preflightState: state });
    const doc = await db.requirementsDoc.create({ data: { projectId: p.id, version: 1, repoPath: "docs/requirements.md", status: "draft" } });
    return { p, doc };
  };
  const pending = await mk("pending");
  assert.equal(await store.approveDoc(pending.doc.id), true);
  assert.equal(await store.preflightState(pending.p.id), "approved");
  const rejected = await mk("rejected");
  assert.equal(await store.approveDoc(rejected.doc.id), true);
  assert.equal(await store.preflightState(rejected.p.id), "rejected");
});

test("DEVOS-208 (db): a new spec version with the mode off re-opens a rejected pre-flight; approval then opens it", async () => {
  const store = new PrismaRequirementsStore(db, 5000);
  const p = await project({ continuousRun: false, preflightState: "rejected" });
  const r = await pipeline(store, []).submitSpec(p.id, { kind: "paste", text: SPEC });
  assert.equal(await store.preflightState(p.id), "pending", "rule 4: a new version re-opens it");
  assert.equal(await pipeline(store, []).applyDecision({ id: r.approvalId, gate: "requirements", status: "approved" }), "approved");
  assert.equal(await store.preflightState(p.id), "approved");
  // An approved mode-off project is not moved by a new version.
  const ok = await project({ continuousRun: false, preflightState: "approved" });
  await pipeline(store, []).submitSpec(ok.id, { kind: "paste", text: SPEC });
  assert.equal(await store.preflightState(ok.id), "approved");
});

test("DEVOS-204 (db): a later KK comment adds one kk row keyed by the comment; listed until read; earlier rows stay; state unchanged", async () => {
  const p = await project();
  const store = new PrismaRequirementsStore(db, 5000);
  const pl = pipeline(store, []);
  const r = await pl.submitSpec(p.id, { kind: "paste", text: SPEC });
  const decidedAt = new Date(Date.now() - 600_000);
  await db.approval.update({ where: { id: r.approvalId }, data: { status: "approved", decidedAt, decidedBy: "kk:test" } });
  const card = { id: r.approvalId, gate: "requirements", status: "approved", decidedAt };
  await db.approvalComment.create({ data: { approvalId: r.approvalId, author: "kk:test", body: "PF-1: yes", createdAt: decidedAt } });
  assert.equal(await pl.applyDecision(card, ["PF-1: yes"]), "approved");
  const before = await db.projectDecision.findMany({ where: { projectId: p.id }, orderBy: { itemId: "asc" } });
  assert.ok(before.length >= 2 && before.every((d) => d.approvalId === r.approvalId && d.commentId === null));
  assert.equal((await store.reanswersAwaiting(1000)).includes(p.id), false, "no comment after the decision: not listed");

  const c1 = await db.approvalComment.create({ data: { approvalId: r.approvalId, author: "kk:test", body: "Thinking again.\nPF-1: no", createdAt: new Date(decidedAt.getTime() + 60_000) } });
  assert.equal((await store.reanswersAwaiting(1000)).includes(p.id), true, "a later comment lists the project");
  const comments = await db.approvalComment.findMany({ where: { approvalId: r.approvalId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  assert.equal(await pl.applyReanswers(card, comments, c1.createdAt), 1);
  // A re-run (same comments) is a no-op through the unique (comment, item) index.
  assert.equal(await pl.applyReanswers(card, comments, new Date(decidedAt.getTime() + 30_000)), 1);
  const after = await db.projectDecision.findMany({ where: { projectId: p.id }, orderBy: [{ createdAt: "asc" }, { itemId: "asc" }] });
  assert.equal(after.length, before.length + 1);
  const added = after.find((d) => d.commentId === c1.id);
  assert.deepEqual([added.itemId, added.answer, added.source, added.approvalId], ["PF-1", "no", "kk", null]);
  for (const b of before) assert.deepEqual(after.find((d) => d.id === b.id), b, "the approval rows are unchanged");
  assert.equal((await db.project.findUnique({ where: { id: p.id } })).preflightState, "approved", "running work is not paused");
  // The cursor moved to the comment and never moves back, so the project drops out of the list.
  const doc = await db.requirementsDoc.findFirst({ where: { approvalId: r.approvalId } });
  assert.equal(doc.answersSyncedAt.getTime(), c1.createdAt.getTime());
  assert.equal((await store.reanswersAwaiting(1000)).includes(p.id), false);
  // The project page's decision log for that card shows both PF-1 rows, oldest first.
  const log = (await store.decisions(p.id, r.approvalId)).filter((d) => d.itemId === "PF-1");
  assert.deepEqual(log.map((d) => [d.answer, d.source]), [["yes", "kk"], ["no", "kk"]]);
  // A draft doc is never written by recordReanswers.
  const p2 = await project();
  const r2 = await pl.submitSpec(p2.id, { kind: "paste", text: SPEC });
  const d2 = await db.requirementsDoc.findFirst({ where: { approvalId: r2.approvalId } });
  assert.equal(await store.recordReanswers(d2.id, [{ commentId: c1.id, itemId: "PF-1", text: "t", answer: "x", source: "kk" }], new Date()), false);
  assert.equal(await db.projectDecision.count({ where: { projectId: p2.id } }), 0);
});

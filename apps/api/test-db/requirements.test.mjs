// M2.2-d2 AT-D1…D4: the Postgres RequirementsStore behind the M2.2-d1 pipeline, against real Postgres with the
// M1.1 constraints (one approved requirements doc per project) applied.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDb } from "@devos/db";
import { PipelineError, RequirementsPipeline } from "@devos/analyst";
import { MAX_REQUIREMENTS, PrismaRequirementsStore } from "../dist/requirements-store.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

const SPEC = `# Shop

## Phase 1: Launch

| ID | Requirement | Priority | Acceptance |
|---|---|---|---|
| FR-1 | Owner login | Must | Login works; Logout works |
| FR-2 | Menu page | Should | Menu shows prices |

## Phase 2: Payments

- FR-3: Online payment

## Open questions

- Which payment provider should we pay for?
`;

async function project(stage = "intake") {
  const slug = `m22d-${randomBytes(6).toString("hex")}`;
  return db.project.create({ data: { slug, name: slug, stage } });
}

function pipeline(store) {
  const card = (gate) => async (c) => {
    const row = await db.approval.create({ data: { gate, action: c.action ?? c.card.action, target: c.target ?? c.card.target, reason: "test", projectId: c.projectId ?? c.card.projectId } });
    return { id: row.id };
  };
  return new RequirementsPipeline({
    store,
    raiseRequirementsCard: card("requirements"),
    raiseQuestionCard: (draft) => card("decision")(draft),
  });
}

const rejectsCode = (p, code) => assert.rejects(p, (e) => e instanceof PipelineError && e.code === code);

test("AT-D1 a submission writes spec, doc, requirement and milestone rows in one transaction, linked to its card", async () => {
  const p = await project();
  const store = new PrismaRequirementsStore(db, 5000);
  const r = await pipeline(store).submitSpec(p.id, { kind: "paste", text: SPEC });
  assert.equal(r.specVersion, 1);
  const spec = await db.spec.findFirst({ where: { projectId: p.id } });
  assert.equal(spec.sourceFormat, "paste");
  assert.equal(spec.originalName, null);
  const reqs = await db.requirement.findMany({ where: { projectId: p.id }, orderBy: { key: "asc" }, include: { milestone: true } });
  assert.deepEqual(reqs.map((x) => [x.key, x.priority, x.milestone?.ordinal ?? null]), [["FR-1", "must", 1], ["FR-2", "should", 1], ["FR-3", "must", 2]]);
  assert.equal(reqs[0].acceptance, "Login works\nLogout works");
  const ms = await db.milestone.findMany({ where: { projectId: p.id }, orderBy: { ordinal: "asc" } });
  assert.deepEqual(ms.map((m) => m.gateName), ["G1", "G2"]);
  const doc = await db.requirementsDoc.findFirst({ where: { projectId: p.id } });
  assert.deepEqual([doc.status, doc.approvalId, doc.repoPath], ["draft", r.approvalId, "docs/requirements.md"]);
  assert.equal(await db.auditEvent.count({ where: { projectId: p.id, action: "requirements.analysed" } }), 1);
  // The row view behind GET /projects/:id/requirements.
  assert.deepEqual(await store.rows(p.id), [
    { key: "FR-1", title: "Owner login", priority: "must", acceptance: "Login works\nLogout works", milestone: 1 },
    { key: "FR-2", title: "Menu page", priority: "should", acceptance: "Menu shows prices", milestone: 1 },
    { key: "FR-3", title: "Online payment", priority: "must", acceptance: "", milestone: 2 },
  ]);
  // Too many requirements: a clear refusal, nothing stored.
  const many = Array.from({ length: MAX_REQUIREMENTS + 1 }, (_, i) => ({ key: `FR-${i + 100}`, title: "x", priority: "must", acceptance: "", milestoneOrdinal: null }));
  await rejectsCode(store.saveAnalysis({ projectId: p.id, expectedStage: "intake", spec: { sourceFormat: "paste", originalName: null, fileSha256: "a".repeat(64), text: "x" }, requirements: many, milestones: [], repoPath: "docs/requirements.md" }), "too-many-requirements");
  assert.equal(await db.spec.count({ where: { projectId: p.id } }), 1);
});

test("AT-D2 a second version supersedes the draft, upserts rows and keeps dropped ones", async () => {
  const p = await project();
  const store = new PrismaRequirementsStore(db, 5000);
  const pl = pipeline(store);
  await pl.submitSpec(p.id, { kind: "paste", text: SPEC });
  const r2 = await pl.submitSpec(p.id, { kind: "paste", text: SPEC.replace("| FR-2 | Menu page | Should | Menu shows prices |\n", "").replace("Owner login", "Owner sign-in") });
  assert.deepEqual([r2.specVersion, r2.docVersion], [2, 2]);
  assert.deepEqual(r2.droppedKeys, ["FR-2"]);
  const docs = await db.requirementsDoc.findMany({ where: { projectId: p.id }, orderBy: { version: "asc" } });
  assert.deepEqual(docs.map((d) => d.status), ["superseded", "draft"]);
  assert.equal(await db.requirement.count({ where: { projectId: p.id } }), 3, "FR-2 is kept");
  assert.equal((await db.requirement.findFirst({ where: { projectId: p.id, key: "FR-1" } })).title, "Owner sign-in");
});

test("AT-D3 approval: only the newest draft, once; then the store refuses a new version and stores nothing", async () => {
  const p = await project();
  const store = new PrismaRequirementsStore(db, 5000);
  const pl = pipeline(store);
  const r1 = await pl.submitSpec(p.id, { kind: "paste", text: SPEC });
  const r2 = await pl.submitSpec(p.id, { kind: "paste", text: SPEC });
  assert.equal(await pl.applyDecision({ id: r1.approvalId, gate: "requirements", status: "approved" }), "ignored");
  assert.equal(await store.approveDoc(r1.docId), false);
  assert.equal(await pl.applyDecision({ id: r2.approvalId, gate: "requirements", status: "approved" }), "approved");
  assert.equal(await pl.applyDecision({ id: r2.approvalId, gate: "requirements", status: "approved" }), "ignored");
  assert.equal(await db.requirementsDoc.count({ where: { projectId: p.id, status: "approved" } }), 1);
  assert.equal(await db.auditEvent.count({ where: { projectId: p.id, action: "requirements.approved" } }), 1);
  const specs = await db.spec.count({ where: { projectId: p.id } });
  await rejectsCode(store.saveAnalysis({ projectId: p.id, expectedStage: "intake", spec: { sourceFormat: "paste", originalName: null, fileSha256: "a".repeat(64), text: "x" }, requirements: [], milestones: [], repoPath: "docs/requirements.md" }), "requirements-already-approved");
  assert.equal(await db.spec.count({ where: { projectId: p.id } }), specs, "the refused save rolled back");
});

test("AT-D4 concurrent submission and approval serialise on the project lock: never two approved docs", async () => {
  const p = await project();
  const store = new PrismaRequirementsStore(db, 5000);
  const pl = pipeline(store);
  const r1 = await pl.submitSpec(p.id, { kind: "paste", text: SPEC });
  // Hold the project row lock in another transaction so the approval and the save both queue on it, then release.
  let release;
  const gate = new Promise((r) => (release = r));
  let locked;
  const isLocked = new Promise((r) => (locked = r));
  const holder = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM project WHERE id = ${p.id}::uuid FOR UPDATE`;
    locked();
    await gate;
  }, { timeout: 15_000 });
  await isLocked;
  const save = store.saveAnalysis({ projectId: p.id, expectedStage: "intake", spec: { sourceFormat: "paste", originalName: null, fileSha256: "b".repeat(64), text: "v2" }, requirements: [], milestones: [], repoPath: "docs/requirements.md" });
  const approve = store.approveDoc(r1.docId);
  await new Promise((r) => setTimeout(r, 300));
  release();
  await holder;
  const results = await Promise.allSettled([approve, save]);
  const approved = await db.requirementsDoc.findMany({ where: { projectId: p.id, status: "approved" } });
  assert.ok(approved.length <= 1);
  if (results[0].status === "fulfilled" && results[0].value === true) {
    // Approval won: the save was refused and rolled back.
    assert.equal(results[1].status, "rejected");
    assert.equal(results[1].reason.code, "requirements-already-approved");
    assert.equal(await db.spec.count({ where: { projectId: p.id } }), 1);
  } else {
    // Save won: v1 was superseded before the approval re-read it, so nothing is approved.
    assert.equal(results[1].status, "fulfilled");
    assert.equal(approved.length, 0);
    assert.equal((await db.requirementsDoc.findUnique({ where: { id: r1.docId } })).status, "superseded");
  }
  // Stage re-check under the lock and unknown project.
  const late = await project("building");
  await rejectsCode(store.saveAnalysis({ projectId: late.id, expectedStage: "intake", spec: { sourceFormat: "paste", originalName: null, fileSha256: "a".repeat(64), text: "x" }, requirements: [], milestones: [], repoPath: "docs/requirements.md" }), "project-not-in-intake");
  await rejectsCode(store.saveAnalysis({ projectId: "00000000-0000-4000-8000-000000000000", expectedStage: "intake", spec: { sourceFormat: "paste", originalName: null, fileSha256: "a".repeat(64), text: "x" }, requirements: [], milestones: [], repoPath: "docs/requirements.md" }), "project-not-found");
});

test("AT-S4 draftsAwaitingDecision: only projects whose newest doc is a draft linked to an approved card, oldest first, bounded", async () => {
  const store = new PrismaRequirementsStore(db, 30_000);
  const p = pipeline(store);
  const approveCard = (id) => db.approval.update({ where: { id }, data: { status: "approved", decidedAt: new Date(), decidedBy: "kk:test" } });
  const linked1 = await project();
  const pendingCard = await project();
  const docApproved = await project();
  const linked2 = await project();
  const unlinkedNewest = await project();
  const r1 = await p.submitSpec(linked1.id, { kind: "paste", text: SPEC });
  await approveCard(r1.approvalId);
  await new Promise((r) => setTimeout(r, 5)); // distinct created_at, so the order is by age, not by random id
  await p.submitSpec(pendingCard.id, { kind: "paste", text: SPEC });
  const ra = await p.submitSpec(docApproved.id, { kind: "paste", text: SPEC });
  await approveCard(ra.approvalId);
  await store.approveDoc(ra.docId);
  await new Promise((r) => setTimeout(r, 5));
  const r2 = await p.submitSpec(linked2.id, { kind: "paste", text: SPEC });
  await approveCard(r2.approvalId);
  const ru = await p.submitSpec(unlinkedNewest.id, { kind: "paste", text: SPEC });
  await approveCard(ru.approvalId);
  // A newer version whose card could not be linked hides the older linked draft.
  await db.requirementsDoc.updateMany({ where: { projectId: unlinkedNewest.id }, data: { status: "superseded" } });
  await db.requirementsDoc.create({ data: { projectId: unlinkedNewest.id, version: 99, repoPath: "docs/requirements.md", status: "draft" } });

  const all = await store.draftsAwaitingDecision(1000);
  const ours = [linked1.id, pendingCard.id, docApproved.id, linked2.id, unlinkedNewest.id];
  assert.deepEqual(all.filter((id) => ours.includes(id)), [linked1.id, linked2.id]);
  const one = await store.draftsAwaitingDecision(1);
  assert.equal(one.length, 1);
  assert.equal(one[0], all[0], "the limit keeps the oldest");
});

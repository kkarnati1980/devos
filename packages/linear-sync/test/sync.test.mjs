// M2.6-a AT1–AT3: outbound sync against an in-memory Linear.
import { test } from "node:test";
import assert from "node:assert/strict";
import { syncProject, fencedApi } from "../dist/index.js";
import { fakeLinear, memoryStore } from "./fake-linear.mjs";

const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function throwaway() {
  return {
    project: { id: u(1), name: "Throwaway", linearProjectId: null },
    milestones: [{ id: u(11), ordinal: 1, name: "Intake", gateName: "G1", linearMilestoneId: null }, { id: u(12), ordinal: 2, name: "Build", gateName: "G2", linearMilestoneId: null }],
    modules: [
      { id: u(21), milestoneId: u(11), key: "M1.1", title: "Data", lane: 1, contractPath: "docs/modules/M1.1.md", status: "merged", linearIssue: null },
      { id: u(22), milestoneId: u(12), key: "M2.1", title: "API", lane: 2, contractPath: "docs/modules/M2.1.md", status: "ready", linearIssue: null },
      { id: u(23), milestoneId: u(12), key: "M2.2", title: "UI", lane: 3, contractPath: "docs/modules/M2.2.md", status: "planned", linearIssue: null },
    ],
    dependencies: [{ moduleId: u(22), dependsOnId: u(21) }],
    tasks: [
      { id: u(31), moduleId: u(21), title: "Schema", kind: "build", assignee: "agent", status: "done", linearIssue: null },
      { id: u(32), moduleId: u(22), title: "Routes", kind: "build", assignee: "agent", status: "running", linearIssue: null },
      { id: u(33), moduleId: u(22), title: "Create the API key", kind: "human", assignee: "kk", status: "ready", linearIssue: null },
      { id: u(34), moduleId: null, title: "Loose task", kind: "maintenance", assignee: "agent", status: "deadlocked", linearIssue: null },
    ],
  };
}

test("AT1: a throwaway project mirrors to one project, milestones, module issues, sub-issues, a human task for KK and a blocked-by link", async () => {
  const L = fakeLinear(); const plan = throwaway();
  await syncProject(plan, L.api, memoryStore(plan));
  assert.equal(L.projects.length, 1); assert.match(L.projects[0].description, /devos-ref: project\/00000000-0000-4000-8000-000000000001/);
  assert.deepEqual(L.milestones.map((m) => m.name), ["P1 Intake", "P2 Build"]);
  const mod = (k) => L.issues.find((i) => i.title.startsWith(k));
  const names = (i) => i.labelIds.map((x) => L.team.labels.find((l) => l.id === x).name).sort();
  assert.deepEqual(names(mod("M1.1")), ["Lane A", "Module"]); assert.deepEqual(names(mod("M2.2")), ["Lane C", "Module"]);
  assert.equal(mod("M1.1").stateId, "s-c"); assert.equal(mod("M2.1").stateId, "s-u"); assert.equal(mod("M2.2").stateId, "s-b");
  assert.deepEqual(mod("M2.1").blockedBy, [mod("M1.1").id]);
  const human = L.issues.find((i) => i.title === "Create the API key");
  assert.equal(human.parentId, mod("M2.1").id); assert.equal(human.assigneeId, "user-kk"); assert.deepEqual(names(human), ["Human"]);
  assert.equal(human.milestoneId, L.milestones[1].id);
  const loose = L.issues.find((i) => i.title === "Loose task");
  assert.equal(loose.parentId, null); assert.deepEqual(names(loose), ["Task", "deadlocked"]);
  assert.equal(L.issues.length, 7);
  assert.ok(plan.project.linearProjectId && plan.milestones.every((m) => m.linearMilestoneId) && plan.modules.every((m) => m.linearIssue) && plan.tasks.every((t) => t.linearIssue), "ids stored");
});

test("AT2: a second sync with no change writes nothing; one status change is one update with the mapped state type", async () => {
  const L = fakeLinear(); const plan = throwaway(); const store = memoryStore(plan);
  await syncProject(plan, L.api, store);
  L.writes.length = 0;
  const r = await syncProject(plan, L.api, store);
  assert.equal(r.writes, 0); assert.deepEqual(L.writes, []);
  plan.modules[1].status = "in_review";
  const r2 = await syncProject(plan, L.api, store);
  assert.equal(r2.writes, 1); assert.equal(L.writes[0].op, "updateIssue"); assert.equal(L.writes[0].arg.stateId, "s-s");
  // A manual edit in Linear to an agent issue is reverted on the next sync and logged.
  L.issues.find((i) => i.title.startsWith("M2.2")).stateId = "s-c";
  L.writes.length = 0;
  const r3 = await syncProject(plan, L.api, store);
  assert.equal(r3.writes, 1); assert.ok(r3.log.some((l) => /module M2.2: state completed -> backlog/.test(l)));
});

test("AT3: a crash after Linear created an issue is recovered by marker on the next sync; no duplicates anywhere", async () => {
  const L = fakeLinear({ failCreateIssueAfterWrite: 2 }); const plan = throwaway(); const store = memoryStore(plan);
  await assert.rejects(syncProject(plan, L.api, store), /connection reset/);
  assert.equal(plan.modules[1].linearIssue, null, "the id was never saved");
  // The project id was saved; drop it too, to prove the project is adopted by marker as well.
  plan.project.linearProjectId = null;
  plan.milestones.forEach((m) => { m.linearMilestoneId = null; });
  const r = await syncProject(plan, L.api, store);
  assert.ok(r.log.includes("project adopted by marker"));
  assert.equal(L.projects.length, 1); assert.equal(L.milestones.length, 2); assert.equal(L.issues.length, 7);
  assert.equal(new Set(L.issues.map((i) => i.title)).size, 7);
});

test("human tasks: Linear owns their state after creation (KK's completion is never reverted)", async () => {
  const L = fakeLinear(); const plan = throwaway(); const store = memoryStore(plan);
  await syncProject(plan, L.api, store);
  const human = L.issues.find((i) => i.title === "Create the API key");
  human.stateId = "s-c"; L.writes.length = 0;
  const r = await syncProject(plan, L.api, store);
  assert.equal(r.writes, 0); assert.equal(human.stateId, "s-c");
});
test("descriptions re-rendered by Linear (escapes, marks, whitespace) are not rewritten; stale stored ids recover", async () => {
  const L = fakeLinear(); const plan = throwaway(); const store = memoryStore(plan);
  await syncProject(plan, L.api, store);
  for (const i of L.issues) i.description = i.description.replace(/`/g, "").replace("devos-ref: module/", "devos-ref: module\\/").replace(/\n\n/g, "\n");
  L.writes.length = 0;
  assert.equal((await syncProject(plan, L.api, store)).writes, 0, JSON.stringify(L.writes));
  plan.milestones[0].linearMilestoneId = "m-gone"; plan.project.linearProjectId = "p-gone";
  const r = await syncProject(plan, L.api, store);
  assert.equal(L.projects.length, 1); assert.equal(L.milestones.length, 2); assert.ok(r.log.some((l) => /not found/.test(l)));
  assert.equal(plan.milestones[0].linearMilestoneId, L.milestones[0].id);
});

test("AT5 (sync level): a Linear failure during sync carries no key, and nothing the sync logs or stores holds it", async () => {
  const { LinearClient, graphqlApi } = await import("../dist/index.js");
  const KEY = "lin_api_" + "Seeded0000000000000000000000000000000000";
  const fetchImpl = async () => new Response(JSON.stringify({ errors: [{ message: `echo ${KEY}` }] }), { status: 200 });
  const api = graphqlApi(new LinearClient({ apiKey: () => KEY, fetchImpl, sleep: async () => {} }));
  const plan = throwaway(); const stored = [];
  const store = { setProjectId: async (...a) => stored.push(a), setMilestoneId: async (...a) => stored.push(a), setModuleIssue: async (...a) => stored.push(a), setTaskIssue: async (...a) => stored.push(a), completeHumanTask: async (...a) => stored.push(a) };
  const err = await syncProject(plan, api, store).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.ok(!JSON.stringify({ m: err.message, s: err.stack, stored, plan }).includes(KEY));
  // and a successful sync's log never holds descriptions or headers
  const L = fakeLinear(); const r = await syncProject(throwaway(), L.api, memoryStore(throwaway()));
  assert.ok(r.log.every((l) => !/devos-ref|Bearer|lin_api_/.test(l)));
});

test("Codex PR35-r1: renaming the DevOS project renames the Linear project on the next sync; unchanged makes no write", async () => {
  const L = fakeLinear(); const plan = throwaway(); const store = memoryStore(plan);
  await syncProject(plan, L.api, store);
  plan.project.name = "Throwaway renamed";
  const r = await syncProject(plan, L.api, store);
  assert.equal(L.projects[0].name, "Throwaway renamed");
  assert.deepEqual(r.updated, ["project"]);
  assert.equal((await syncProject(plan, L.api, store)).writes, 0);
  // An adopted project (found by marker) with an old name is renamed too.
  const plan2 = throwaway(); plan2.project.name = "Adopted new name";
  const r2 = await syncProject(plan2, L.api, memoryStore(plan2));
  assert.equal(L.projects.length, 1); assert.equal(L.projects[0].name, "Adopted new name"); assert.ok(r2.updated.includes("project"));
});

test("Codex PR35-r1: fencedApi checks the lock guard before every Linear write and stops the sync when it fails", async () => {
  const L = fakeLinear(); const plan = throwaway();
  let checks = 0; let allow = 3;
  const guard = async () => { checks++; if (allow-- <= 0) throw new Error("linear-sync-lock-expiring"); };
  await assert.rejects(syncProject(plan, fencedApi(L.api, guard), memoryStore(plan)), /linear-sync-lock-expiring/);
  assert.equal(checks, 4, "one check per write; the fourth refused");
  assert.equal(L.writes.length, 3);
});

test("Codex PR35-r4: every PrismaSyncStore write and the plan read run in a bounded transaction with statement and lock timeouts", async () => {
  const { PrismaSyncStore, loadPlan, STORE_OP_MS, STORE_WAIT_MS, WRITE_MARGIN_MS } = await import("../dist/index.js");
  assert.ok(STORE_OP_MS + STORE_WAIT_MS < WRITE_MARGIN_MS, "a store write ends inside the write margin");
  const seen = []; let inTx = 0;
  const delegate = (name) => new Proxy({}, { get: (_t, op) => async () => {
    assert.ok(inTx > 0, `${name}.${String(op)} ran outside a bounded transaction`);
    if (op === "findUnique") return { id: "p1", name: "P" };
    if (op === "findMany") return [];
    return null;
  } });
  const tx = { project: delegate("project"), milestone: delegate("milestone"), module: delegate("module"), moduleDependency: delegate("moduleDependency"),
    task: delegate("task"), resource: delegate("resource"), $executeRawUnsafe: async (q) => { seen.push(q); } };
  const plain = () => { throw new Error("plain client used directly"); };
  const db = { project: { findUnique: plain }, milestone: {}, module: { update: plain }, moduleDependency: {}, task: { update: plain }, resource: { findFirst: plain },
    $transaction: async (fn, opts) => { seen.push(opts); inTx++; try { return await fn(tx); } finally { inTx--; } } };
  const store = new PrismaSyncStore(db, "p1");
  await store.setProjectId("p1", "lp1"); await store.setMilestoneId("m1", "lm1"); await store.setModuleIssue("mod1", "i1"); await store.setTaskIssue("t1", "i2");
  await loadPlan(db, "p1");
  const opts = seen.filter((x) => typeof x === "object");
  assert.equal(opts.length, 5);
  for (const o of opts) assert.deepEqual(o, { timeout: STORE_OP_MS, maxWait: STORE_WAIT_MS });
  assert.equal(seen.filter((x) => x === "SET LOCAL statement_timeout = 10000").length, 5);
  assert.equal(seen.filter((x) => x === "SET LOCAL lock_timeout = 10000").length, 5);
});

test("Codex PR35-r7: when a label create fails, no other Linear write is still in flight after the sync returns", async () => {
  const L = fakeLinear(); const plan = throwaway();
  L.team.labels = []; // "Module" and "Lane A" are both missing, so the first module needs two label creates
  let inflight = 0, maxInflight = 0;
  const orig = L.api.createLabel;
  L.api.createLabel = async (t, name) => {
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    try {
      await new Promise((res) => setTimeout(res, name.startsWith("Lane") ? 5 : 30));
      if (name.startsWith("Lane")) throw new Error("label create failed");
      return await orig(t, name);
    } finally { inflight--; }
  };
  await assert.rejects(syncProject(plan, L.api, memoryStore(plan)), /label create failed/);
  assert.equal(inflight, 0, "a label write outlived the sync");
  assert.equal(maxInflight, 1, "label writes ran concurrently");
});

test("DEVOS-132: an agent issue moved to another Linear project is moved back on the next sync, never duplicated", async () => {
  const L = fakeLinear(); const plan = throwaway(); const store = memoryStore(plan);
  await syncProject(plan, L.api, store);
  const mod = L.issues.find((x) => x.id === plan.modules[0].linearIssue);
  const count = L.issues.length;
  mod.projectId = "p-somewhere-else"; mod.description = "edited by hand";
  L.writes.length = 0;
  await syncProject(plan, L.api, store);
  assert.equal(L.issues.length, count, "no issue created");
  assert.equal(L.writes.filter((w) => w.op === "createIssue").length, 0);
  assert.equal(mod.projectId, L.projects[0].id, "moved back into the project");
  assert.match(mod.description, /devos-ref: module\//, "the manual edit is overwritten");
  assert.equal(plan.modules[0].linearIssue, mod.id, "the stored id is kept");
});

test("DEVOS-132 pre-review: a move Linear refuses is logged and skipped; the rest syncs and nothing is duplicated", async () => {
  const { LinearError } = await import("../dist/index.js");
  const L = fakeLinear(); const plan = throwaway(); const store = memoryStore(plan);
  await syncProject(plan, L.api, store);
  const mod = L.issues.find((x) => x.id === plan.modules[0].linearIssue);
  const count = L.issues.length;
  mod.projectId = null;
  const update = L.api.updateIssue;
  L.api.updateIssue = async (id, patch) => { if (id === mod.id && "projectId" in patch) throw new LinearError("graphql", "Linear refused issueUpdate"); return update(id, patch); };
  plan.tasks[0].title = "renamed task";
  const r = await syncProject(plan, L.api, store);
  assert.equal(L.issues.length, count, "no issue created");
  assert.equal(mod.projectId, null, "left as it is");
  assert.ok(r.log.some((l) => l.includes(mod.id) && l.includes("refused")));
  assert.ok(L.issues.some((x) => x.title === "renamed task"), "other issues still sync");
  // A transient failure is not swallowed: the sync fails and retries later.
  L.api.updateIssue = async () => { throw new LinearError("network", "socket hang up"); };
  await assert.rejects(syncProject(plan, L.api, store), /socket hang up/);
});

test("Codex PR64-r1: a stuck module gets no relation writes either way; an unchanged plan makes no writes for it", async () => {
  const { LinearError } = await import("../dist/index.js");
  const L = fakeLinear(); const plan = throwaway(); const store = memoryStore(plan);
  assert.ok(plan.dependencies.length > 0, "the plan has a dependency");
  await syncProject(plan, L.api, store);
  const update = L.api.updateIssue;
  for (const which of ["moduleId", "dependsOnId"]) {
    const modId = plan.dependencies[0][which];
    const mod = L.issues.find((x) => x.id === plan.modules.find((m) => m.id === modId).linearIssue);
    const home = mod.projectId;
    mod.projectId = null;
    L.api.updateIssue = async (id, patch) => { if (id === mod.id && "projectId" in patch) throw new LinearError("graphql", "Linear refused issueUpdate"); return update(id, patch); };
    L.writes.length = 0;
    await syncProject(plan, L.api, store);
    await syncProject(plan, L.api, store);
    assert.equal(L.writes.filter((w) => w.op === "addBlockedBy" || w.op === "createIssue").length, 0, `${which}: no relation or create writes`);
    mod.projectId = home; L.api.updateIssue = update;
  }
});

test("DEVOS-132: the issues query stays under Linear's complexity limit", async () => {
  const { ISSUES_QUERY_COST, LINEAR_MAX_COMPLEXITY, ISSUE_PAGE } = await import("../dist/index.js");
  assert.ok(ISSUES_QUERY_COST <= LINEAR_MAX_COMPLEXITY, `${ISSUES_QUERY_COST} > ${LINEAR_MAX_COMPLEXITY}`);
  assert.ok(ISSUE_PAGE >= 10, "pages are not so small that a project needs hundreds of reads");
});

test("AT6: KK completing a human task in Linear makes the DevOS task done within one sync; a second sync changes nothing", async () => {
  const plan = throwaway(); const L = fakeLinear(); const store = memoryStore(plan);
  await syncProject(plan, L.api, store);
  const human = L.issues.find((i) => i.title === "Create the API key");
  human.stateId = "s-c"; L.writes.length = 0;
  const r = await syncProject(plan, L.api, store);
  assert.deepEqual(store.completed, [[u(33), "completed"]]);
  assert.equal(plan.tasks.find((t) => t.id === u(33)).status, "done");
  assert.equal(r.inbound.length, 1); assert.equal(r.writes, 0, "inbound sync writes nothing to Linear");
  const r2 = await syncProject(plan, L.api, store);
  assert.equal(store.completed.length, 1); assert.equal(r2.inbound.length, 0); assert.equal(r2.writes, 0);
});

test("AT6: a cancelled human task becomes done, recorded as cancelled", async () => {
  const plan = throwaway(); const L = fakeLinear(); const store = memoryStore(plan);
  await syncProject(plan, L.api, store);
  L.issues.find((i) => i.title === "Create the API key").stateId = "s-x";
  await syncProject(plan, L.api, store);
  assert.deepEqual(store.completed, [[u(33), "canceled"]]);
});

test("AT6: completing an agent issue in Linear is reverted on the next sync and logged; no inbound change", async () => {
  const plan = throwaway(); const L = fakeLinear(); const store = memoryStore(plan);
  await syncProject(plan, L.api, store);
  const agentTasks = plan.tasks.filter((t) => t.assignee !== "kk" && t.status !== "done");
  assert.ok(agentTasks.length);
  const issue = L.issues.find((i) => i.id === agentTasks[0].linearIssue);
  const before = issue.stateId; issue.stateId = "s-c"; L.writes.length = 0;
  const r = await syncProject(plan, L.api, store);
  assert.equal(issue.stateId, before, "state put back");
  assert.ok(r.log.some((l) => /: state completed -> /.test(l)), r.log.join("\n"));
  assert.deepEqual(store.completed, []); assert.equal(agentTasks[0].status === "done", false);
});

test("AT6: the fenced store checks the lock guard before completing a human task", async () => {
  const { syncProjectLocked } = await import("../dist/index.js");
  let guarded = 0;
  const tx = { $queryRawUnsafe: async (q) => (q.includes("pg_try_advisory_xact_lock") ? [{ ok: true }] : [{}]) };
  const inner = { $executeRawUnsafe: async () => {}, task: { updateMany: async () => ({ count: 0 }) }, auditEvent: { create: async () => {} },
    project: { findUnique: async () => ({ id: "p", name: "P" }) }, milestone: { findMany: async () => [] }, module: { findMany: async () => [] }, task2: {}, resource: { findMany: async () => [] }, moduleDependency: { findMany: async () => [] } };
  inner.task.findMany = async () => [];
  let depth = 0;
  const db = { $transaction: async (fn) => { depth++; try { return await fn(depth === 1 ? tx : inner); } finally { depth--; } } };
  const origQuery = tx.$queryRawUnsafe; tx.$queryRawUnsafe = async (q, ...a) => { if (q === "SELECT 1") guarded++; return origQuery(q, ...a); };
  await syncProjectLocked(db, "p", async (_plan, store) => { await store.completeHumanTask("t", "completed"); });
  assert.equal(guarded, 1);
});

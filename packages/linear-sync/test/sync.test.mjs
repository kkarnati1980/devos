// M2.6-a AT1–AT3: outbound sync against an in-memory Linear.
import { test } from "node:test";
import assert from "node:assert/strict";
import { syncProject } from "../dist/index.js";
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
  assert.equal(L.projects.length, 1); assert.match(L.projects[0].description, /devos:project:00000000-0000-4000-8000-000000000001/);
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

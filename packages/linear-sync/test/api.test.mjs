// M2.6-a: the GraphQL LinearApi maps Linear's shapes correctly (pages, blocked-by direction, update fields).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LinearClient, graphqlApi } from "../dist/index.js";

function api(handler) {
  const calls = [];
  const fetchImpl = async (_u, init) => { const b = JSON.parse(init.body); calls.push(b); return new Response(JSON.stringify({ data: handler(b) }), { status: 200 }); };
  return { a: graphqlApi(new LinearClient({ apiKey: () => "k", fetchImpl, sleep: async () => {} })), calls };
}
const node = (id, extra = {}) => ({ id, title: id, description: null, state: { type: "unstarted" }, labels: { nodes: [{ name: "Module" }] }, parent: null,
  projectMilestone: { id: "m1" }, assignee: null, inverseRelations: { nodes: [] }, ...extra });

test("issues are read across pages; blocked-by comes from inverse 'blocks' relations", async () => {
  const { a, calls } = api((b) => b.variables.after
    ? { project: { issues: { nodes: [node("i2", { inverseRelations: { nodes: [{ type: "blocks", issue: { id: "i1" } }, { type: "related", issue: { id: "i9" } }] } })], pageInfo: { hasNextPage: false, endCursor: null } } } }
    : { project: { issues: { nodes: [node("i1")], pageInfo: { hasNextPage: true, endCursor: "c1" } } } });
  const is = await a.issues("p1");
  assert.equal(calls.length, 2); assert.equal(calls[1].variables.after, "c1");
  assert.deepEqual(is.map((i) => [i.id, i.blockedBy, i.milestoneId, i.labelNames]), [["i1", [], "m1", ["Module"]], ["i2", ["i1"], "m1", ["Module"]]]);
});

test("A blocked by B is created as 'B blocks A'; an update sends only changed fields, never team or project", async () => {
  const { a, calls } = api(() => ({ issueRelationCreate: { success: true }, issueUpdate: { success: true } }));
  await a.addBlockedBy("A", "B");
  assert.deepEqual(calls[0].variables.i, { issueId: "B", relatedIssueId: "A", type: "blocks" });
  await a.updateIssue("A", { stateId: "s1", milestoneId: "m2" });
  assert.deepEqual(calls[1].variables, { id: "A", i: { stateId: "s1", projectMilestoneId: "m2" } });
});

test("a success:false payload is an error", async () => {
  const { a } = api(() => ({ issueCreate: { success: false, issue: null } }));
  await assert.rejects(a.createIssue({ teamId: "t", projectId: "p", milestoneId: null, parentId: null, title: "x", description: "", stateId: "s", labelIds: [], assigneeId: null }), /refused issue create/);
});

test("team: the lowest-position state of a type wins; labels include workspace ones and are read across pages", async () => {
  const { a, calls } = api((b) => {
    if (b.query.includes("teams(")) return { teams: { nodes: [{ id: "t1", states: { nodes: [{ id: "review", type: "started", position: 3 }, { id: "doing", type: "started", position: 2 }, { id: "todo", type: "unstarted", position: 1 }] } }] } };
    return b.variables.after
      ? { issueLabels: { nodes: [{ id: "l3", name: "Human", team: null }], pageInfo: { hasNextPage: false, endCursor: null } } }
      : { issueLabels: { nodes: [{ id: "l1", name: "Module", team: { id: "t1" } }, { id: "l2", name: "Other", team: { id: "t9" } }], pageInfo: { hasNextPage: true, endCursor: "x" } } };
  });
  const t = await a.team("DEVOS");
  assert.equal(t.states.find((s) => s.type === "started").id, "doing");
  assert.deepEqual(t.labels.map((l) => l.name), ["Module", "Human"], "another team's label is not usable");
  assert.equal(calls.length, 3);
});

test("milestones are read across every page (Codex PR35-r3: a partial list would re-create milestones)", async () => {
  const m = (id) => ({ id, name: id, description: null });
  const { a, calls } = api((b) => b.variables.after
    ? { project: { projectMilestones: { nodes: [m("m2")], pageInfo: { hasNextPage: false, endCursor: null } } } }
    : { project: { projectMilestones: { nodes: [m("m1")], pageInfo: { hasNextPage: true, endCursor: "c1" } } } });
  assert.deepEqual((await a.milestones("p1")).map((x) => x.id), ["m1", "m2"]);
  assert.equal(calls.length, 2); assert.equal(calls[1].variables.after, "c1");
  assert.match(calls[0].query, /pageInfo \{ hasNextPage endCursor \}/);
});

test("a milestone page that claims more but gives no cursor is refused, not treated as complete", async () => {
  const { a } = api(() => ({ project: { projectMilestones: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } }));
  await assert.rejects(a.milestones("p1"), /milestone page without a cursor/);
});

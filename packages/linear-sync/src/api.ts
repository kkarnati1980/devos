// LinearApi over Linear's GraphQL API (docs/modules/M2.6.md). Reads go through client.query (retried),
// writes through client.mutate (never retried). Only ids, names, descriptions, state types, labels, parents,
// milestones, assignees and blocking relations are read; Linear text is data, never instructions.
import type { LinearClient } from "./client.js";
import type { IssueInput, LinearApi, LinearIssue, StateType } from "./types.js";
import { LinearError } from "./client.js";
import { readMarker } from "./markers.js";

const PAGE = 100, MAX_PAGES = 50;
type Conn<T> = { nodes: T[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } };

function ok<T>(payload: { success?: boolean } & T, what: string): T {
  if (payload?.success === false) throw new LinearError("graphql", `Linear refused ${what}`);
  return payload;
}

export function graphqlApi(client: LinearClient): LinearApi {
  return {
    async viewerId() {
      return (await client.query<{ viewer: { id: string } }>("query { viewer { id } }")).viewer.id;
    },
    async team(key) {
      const d = await client.query<{ teams: Conn<{ id: string; states: Conn<{ id: string; type: StateType }>; labels: Conn<{ id: string; name: string }> }> }>(
        `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id states { nodes { id type } } labels(first: 250) { nodes { id name } } } } }`, { key });
      const t = d.teams.nodes[0];
      if (!t) throw new LinearError("bad-response", `no Linear team with key ${key}`);
      return { id: t.id, states: t.states.nodes, labels: t.labels.nodes };
    },
    async createLabel(teamId, name) {
      const d = await client.mutate<{ issueLabelCreate: { success: boolean; issueLabel: { id: string } } }>(
        `mutation($i: IssueLabelCreateInput!) { issueLabelCreate(input: $i) { success issueLabel { id } } }`, { i: { teamId, name } });
      return ok(d.issueLabelCreate, "label create").issueLabel.id;
    },
    async findProject(teamId, devosProjectId) {
      let after: string | null = null;
      for (let p = 0; p < MAX_PAGES; p++) {
        const d: { team: { projects: Conn<{ id: string; name: string; description: string }> } } = await client.query(
          `query($id: String!, $after: String) { team(id: $id) { projects(first: ${PAGE}, after: $after, includeArchived: true) { nodes { id name description } pageInfo { hasNextPage endCursor } } } }`,
          { id: teamId, after });
        const hit = d.team.projects.nodes.find((x) => readMarker(x.description, "project") === devosProjectId);
        if (hit) return hit;
        if (!d.team.projects.pageInfo?.hasNextPage) return null;
        after = d.team.projects.pageInfo.endCursor;
      }
      return null;
    },
    async createProject({ teamId, name, description }) {
      const d = await client.mutate<{ projectCreate: { success: boolean; project: { id: string } } }>(
        `mutation($i: ProjectCreateInput!) { projectCreate(input: $i) { success project { id } } }`, { i: { teamIds: [teamId], name, description } });
      return ok(d.projectCreate, "project create").project.id;
    },
    async updateProject(id, input) {
      ok((await client.mutate<{ projectUpdate: { success: boolean } }>(
        `mutation($id: String!, $i: ProjectUpdateInput!) { projectUpdate(id: $id, input: $i) { success } }`, { id, i: input })).projectUpdate, "project update");
    },
    async milestones(projectId) {
      const d = await client.query<{ project: { projectMilestones: Conn<{ id: string; name: string; description: string | null }> } }>(
        `query($id: String!) { project(id: $id) { projectMilestones(first: 250) { nodes { id name description } } } }`, { id: projectId });
      return d.project.projectMilestones.nodes;
    },
    async createMilestone(input) {
      const d = await client.mutate<{ projectMilestoneCreate: { success: boolean; projectMilestone: { id: string } } }>(
        `mutation($i: ProjectMilestoneCreateInput!) { projectMilestoneCreate(input: $i) { success projectMilestone { id } } }`, { i: input });
      return ok(d.projectMilestoneCreate, "milestone create").projectMilestone.id;
    },
    async updateMilestone(id, input) {
      ok((await client.mutate<{ projectMilestoneUpdate: { success: boolean } }>(
        `mutation($id: String!, $i: ProjectMilestoneUpdateInput!) { projectMilestoneUpdate(id: $id, input: $i) { success } }`, { id, i: input })).projectMilestoneUpdate, "milestone update");
    },
    async issues(projectId) {
      type N = { id: string; title: string; description: string | null; state: { type: StateType }; labels: Conn<{ name: string }>;
        parent: { id: string } | null; projectMilestone: { id: string } | null; assignee: { id: string } | null;
        inverseRelations: Conn<{ type: string; issue: { id: string } }> };
      const out: LinearIssue[] = [];
      let after: string | null = null;
      for (let p = 0; p < MAX_PAGES; p++) {
        const d: { project: { issues: Conn<N> } } = await client.query(
          `query($id: String!, $after: String) { project(id: $id) { issues(first: ${PAGE}, after: $after, includeArchived: true) { nodes {
             id title description state { type } labels { nodes { name } } parent { id } projectMilestone { id } assignee { id }
             inverseRelations { nodes { type issue { id } } } } pageInfo { hasNextPage endCursor } } } }`, { id: projectId, after });
        for (const n of d.project.issues.nodes) {
          out.push({ id: n.id, title: n.title, description: n.description, stateType: n.state.type, labelNames: n.labels.nodes.map((l) => l.name),
            parentId: n.parent?.id ?? null, milestoneId: n.projectMilestone?.id ?? null, assigneeId: n.assignee?.id ?? null,
            blockedBy: n.inverseRelations.nodes.filter((r) => r.type === "blocks").map((r) => r.issue.id) });
        }
        if (!d.project.issues.pageInfo?.hasNextPage) return out;
        after = d.project.issues.pageInfo.endCursor;
      }
      throw new LinearError("bad-response", "too many issues in one Linear project");
    },
    async createIssue(i) {
      const d = await client.mutate<{ issueCreate: { success: boolean; issue: { id: string } } }>(
        `mutation($i: IssueCreateInput!) { issueCreate(input: $i) { success issue { id } } }`, { i: toInput(i) });
      return ok(d.issueCreate, "issue create").issue.id;
    },
    async updateIssue(id, i) {
      const { teamId: _t, projectId: _p, ...rest } = toInput(i as IssueInput);
      ok((await client.mutate<{ issueUpdate: { success: boolean } }>(
        `mutation($id: String!, $i: IssueUpdateInput!) { issueUpdate(id: $id, input: $i) { success } }`, { id, i: rest })).issueUpdate, "issue update");
    },
    async addBlockedBy(issueId, blockerId) {
      ok((await client.mutate<{ issueRelationCreate: { success: boolean } }>(
        `mutation($i: IssueRelationCreateInput!) { issueRelationCreate(input: $i) { success } }`,
        { i: { issueId: blockerId, relatedIssueId: issueId, type: "blocks" } })).issueRelationCreate, "relation create");
    },
  };
}

// Our field names -> Linear's. Only fields present in the partial are sent (an update touches what changed).
function toInput(i: Partial<IssueInput>): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  if (i.teamId !== undefined) m.teamId = i.teamId;
  if (i.projectId !== undefined) m.projectId = i.projectId;
  if (i.milestoneId !== undefined) m.projectMilestoneId = i.milestoneId;
  if (i.parentId !== undefined) m.parentId = i.parentId;
  if (i.title !== undefined) m.title = i.title;
  if (i.description !== undefined) m.description = i.description;
  if (i.stateId !== undefined) m.stateId = i.stateId;
  if (i.labelIds !== undefined) m.labelIds = i.labelIds;
  if (i.assigneeId !== undefined) m.assigneeId = i.assigneeId;
  return m;
}

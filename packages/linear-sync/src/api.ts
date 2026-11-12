// LinearApi over Linear's GraphQL API (docs/modules/M2.6.md). Reads go through client.query (retried),
// writes through client.mutate (never retried). Only ids, names, descriptions, state types, labels, parents,
// milestones, assignees and blocking relations are read; Linear text is data, never instructions.
import type { LinearClient } from "./client.js";
import type { IssueInput, LinearApi, LinearIssue, StateType } from "./types.js";
import { LinearError } from "./client.js";
import { readMarker } from "./markers.js";

const PAGE = 100, MAX_PAGES = 50;
/** Page size of lists nested in the issues query (labels, relations), kept small for Linear's query complexity. */
export const NESTED = 50;
/**
 * Issues per page of the issues query. Linear scores a query at 1 point per object and 0.1 per field, a connection
 * multiplying its children by its `first`, and refuses more than 10,000 points. One issue node is about
 * 5 + NESTED x 1.1 (labels) + NESTED x 2.2 (relations) = 170 points, so 100 per page (~17,000) would be refused on the
 * first live sync; 25 per page is ~4,250.
 */
export const ISSUE_PAGE = 25;
export const ISSUES_QUERY_COST = Math.ceil(ISSUE_PAGE * (5 + NESTED * 1.1 + NESTED * 2.2) + 10);
export const LINEAR_MAX_COMPLEXITY = 10_000;
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
      const d = await client.query<{ teams: Conn<{ id: string; states: Conn<{ id: string; type: StateType; position: number }> }> }>(
        `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id states { nodes { id type position } } } } }`, { key });
      const t = d.teams.nodes[0];
      if (!t) throw new LinearError("bad-response", `no Linear team with key ${key}`);
      // Labels usable on the team's issues: the team's own and workspace-wide ones (team null), every page.
      const labels: { id: string; name: string }[] = [];
      let after: string | null = null;
      for (let p = 0; p < MAX_PAGES; p++) {
        const l: { issueLabels: Conn<{ id: string; name: string; team: { id: string } | null }> } = await client.query(
          `query($after: String) { issueLabels(first: ${PAGE}, after: $after) { nodes { id name team { id } } pageInfo { hasNextPage endCursor } } }`, { after });
        labels.push(...l.issueLabels.nodes.filter((x) => !x.team || x.team.id === t.id).map(({ id, name }) => ({ id, name })));
        if (!l.issueLabels.pageInfo?.hasNextPage) { after = null; break; }
        if (!l.issueLabels.pageInfo.endCursor) throw new LinearError("bad-response", "Linear label page without a cursor");
        after = l.issueLabels.pageInfo.endCursor;
      }
      // Codex PR35-r4: a label list cut off by the page limit would make the sync create a duplicate label.
      if (after !== null) throw new LinearError("bad-response", "too many issue labels in this Linear workspace");
      // Several states can share a type (e.g. In Progress and In Review are both "started"): the lowest position wins.
      const states = [...t.states.nodes].sort((a, b) => a.position - b.position).map(({ id, type }) => ({ id, type }));
      return { id: t.id, states, labels };
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
        if (!d.team.projects.pageInfo.endCursor) throw new LinearError("bad-response", "Linear project page without a cursor");
        after = d.team.projects.pageInfo.endCursor;
      }
      // Codex PR35-r4: "not found" only after the last page. An exhausted search fails closed (as milestones()
      // does), so a marker beyond the limit is never taken as absent and a second project is never created (AT3).
      throw new LinearError("bad-response", "too many projects in this Linear team to search for the marker");
    },
    async createProject({ teamId, name, description }) {
      const d = await client.mutate<{ projectCreate: { success: boolean; project: { id: string } } }>(
        `mutation($i: ProjectCreateInput!) { projectCreate(input: $i) { success project { id } } }`, { i: { teamIds: [teamId], name, description } });
      return ok(d.projectCreate, "project create").project.id;
    },
    async project(id) {
      // A filtered list answers "not found" with an empty list instead of an error, whatever status Linear uses.
      const d = await client.query<{ projects: Conn<{ id: string; name: string; description: string | null }> }>(
        `query($id: ID!) { projects(filter: { id: { eq: $id } }, includeArchived: true) { nodes { id name description } } }`, { id });
      return d.projects.nodes.find((p) => p.id === id) ?? null;
    },
    async updateProject(id, input) {
      ok((await client.mutate<{ projectUpdate: { success: boolean } }>(
        `mutation($id: String!, $i: ProjectUpdateInput!) { projectUpdate(id: $id, input: $i) { success } }`, { id, i: input })).projectUpdate, "project update");
    },
    async milestones(projectId) {
      // Every page (Codex PR35-r3): a partial list would make the sync re-create milestones it did not see.
      type M = { id: string; name: string; description: string | null };
      const out: M[] = [];
      let after: string | null = null;
      for (let p = 0; p < MAX_PAGES; p++) {
        const d: { project: { projectMilestones: Conn<M> } } = await client.query(
          `query($id: String!, $after: String) { project(id: $id) { projectMilestones(first: ${PAGE}, after: $after) { nodes { id name description } pageInfo { hasNextPage endCursor } } } }`,
          { id: projectId, after });
        out.push(...d.project.projectMilestones.nodes);
        const pi = d.project.projectMilestones.pageInfo;
        if (!pi?.hasNextPage) return out;
        if (!pi.endCursor) throw new LinearError("bad-response", "Linear milestone page without a cursor");
        after = pi.endCursor;
      }
      throw new LinearError("bad-response", "too many milestones in one Linear project");
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
      type R = { type: string; issue: { id: string } };
      // The rest of one issue's inverse relations, every page; fail closed when a page has no cursor or the limit runs out.
      const moreRelations = async (issueId: string, cursor: string | null | undefined): Promise<R[]> => {
        const got: R[] = [];
        let c = cursor;
        for (let p = 0; p < MAX_PAGES; p++) {
          if (!c) throw new LinearError("bad-response", "Linear relation page without a cursor");
          const r: { issue: { inverseRelations: Conn<R> } } = await client.query(
            `query($id: String!, $after: String) { issue(id: $id) { inverseRelations(first: ${PAGE}, after: $after) { nodes { type issue { id } } pageInfo { hasNextPage endCursor } } } }`,
            { id: issueId, after: c });
          got.push(...r.issue.inverseRelations.nodes);
          if (!r.issue.inverseRelations.pageInfo?.hasNextPage) return got;
          c = r.issue.inverseRelations.pageInfo.endCursor;
        }
        throw new LinearError("bad-response", "too many relations on one Linear issue");
      };
      type N = { id: string; title: string; description: string | null; state: { type: StateType }; labels: Conn<{ name: string }>;
        parent: { id: string } | null; projectMilestone: { id: string } | null; assignee: { id: string } | null;
        inverseRelations: Conn<R> };
      const out: LinearIssue[] = [];
      let after: string | null = null;
      for (let p = 0; p < MAX_PAGES; p++) {
        const d: { project: { issues: Conn<N> } } = await client.query(
          `query($id: String!, $after: String) { project(id: $id) { issues(first: ${ISSUE_PAGE}, after: $after, includeArchived: true) { nodes {
             id title description state { type } labels(first: ${NESTED}) { nodes { name } pageInfo { hasNextPage } } parent { id } projectMilestone { id } assignee { id }
             inverseRelations(first: ${NESTED}) { nodes { type issue { id } } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } } }`, { id: projectId, after });
        for (const n of d.project.issues.nodes) {
          // Codex PR35-r5: nested lists are complete or the read fails. A cut-off label list would re-add labels;
          // a cut-off relation list would re-create relations that exist (AT2).
          if (n.labels.pageInfo?.hasNextPage) throw new LinearError("bad-response", `more than ${NESTED} labels on one Linear issue`);
          const rel = [...n.inverseRelations.nodes];
          if (n.inverseRelations.pageInfo?.hasNextPage) rel.push(...(await moreRelations(n.id, n.inverseRelations.pageInfo.endCursor)));
          out.push({ id: n.id, title: n.title, description: n.description, stateType: n.state.type, labelNames: n.labels.nodes.map((l) => l.name),
            parentId: n.parent?.id ?? null, milestoneId: n.projectMilestone?.id ?? null, assigneeId: n.assignee?.id ?? null,
            blockedBy: rel.filter((r) => r.type === "blocks").map((r) => r.issue.id) });
        }
        if (!d.project.issues.pageInfo?.hasNextPage) return out;
        if (!d.project.issues.pageInfo.endCursor) throw new LinearError("bad-response", "Linear issue page without a cursor");
        after = d.project.issues.pageInfo.endCursor;
      }
      throw new LinearError("bad-response", "too many issues in one Linear project");
    },
    async issueRef(id) {
      // A filter, not issue(id): a deleted issue is an empty list here, not an "entity not found" error.
      const d = await client.query<{ issues: { nodes: { id: string; project: { id: string } | null }[] } }>(
        `query($id: ID!) { issues(filter: { id: { eq: $id } }, first: 1, includeArchived: true) { nodes { id project { id } } } }`, { id });
      const n = d.issues.nodes[0];
      return n ? { id: n.id, projectId: n.project?.id ?? null } : null;
    },
    async createIssue(i) {
      const d = await client.mutate<{ issueCreate: { success: boolean; issue: { id: string } } }>(
        `mutation($i: IssueCreateInput!) { issueCreate(input: $i) { success issue { id } } }`, { i: toInput(i) });
      return ok(d.issueCreate, "issue create").issue.id;
    },
    async updateIssue(id, i) {
      // projectId is sent only when set: the sync moves an issue that was taken out of its project back into it.
      const { teamId: _t, ...rest } = toInput(i as IssueInput);
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

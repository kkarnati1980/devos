// DevOS-side snapshot the sync reads (from M1.1 tables) and the Linear-side operations it needs.
export type ModuleStatus = "planned" | "ready" | "in_progress" | "in_review" | "merged" | "deadlocked";
export type TaskStatus = "blocked" | "ready" | "running" | "done" | "failed" | "deadlocked";
export type StateType = "backlog" | "unstarted" | "started" | "completed" | "canceled";

export interface DevosPlan {
  project: { id: string; name: string; linearProjectId: string | null };
  milestones: { id: string; ordinal: number; name: string; gateName: string; linearMilestoneId: string | null }[];
  modules: { id: string; milestoneId: string; key: string; title: string; lane: number; contractPath: string; status: ModuleStatus; linearIssue: string | null }[];
  dependencies: { moduleId: string; dependsOnId: string }[];
  tasks: { id: string; moduleId: string | null; title: string; kind: string; assignee: "agent" | "kk" | "engineer"; status: TaskStatus; linearIssue: string | null }[];
}

export interface LinearIssue { id: string; title: string; description: string | null; stateType: StateType; labelNames: string[];
  parentId: string | null; milestoneId: string | null; assigneeId: string | null; blockedBy: string[] }

/** Everything the sync does in Linear. The GraphQL implementation is in api.ts; tests use an in-memory fake. */
export interface LinearApi {
  viewerId(): Promise<string>;
  team(key: string): Promise<{ id: string; states: { id: string; type: StateType }[]; labels: { id: string; name: string }[] }>;
  createLabel(teamId: string, name: string): Promise<string>;
  findProject(teamId: string, devosProjectId: string): Promise<{ id: string; name: string; description: string } | null>;
  createProject(input: { teamId: string; name: string; description: string }): Promise<string>;
  /** The project by id, or null when it no longer exists. */
  project(id: string): Promise<{ id: string; name: string; description: string | null } | null>;
  updateProject(id: string, input: { name?: string; description?: string }): Promise<void>;
  milestones(projectId: string): Promise<{ id: string; name: string; description: string | null }[]>;
  createMilestone(input: { projectId: string; name: string; description: string; sortOrder: number }): Promise<string>;
  updateMilestone(id: string, input: { name?: string; description?: string }): Promise<void>;
  issues(projectId: string): Promise<LinearIssue[]>;
  /** One issue by id, archived included, with its project; null when it no longer exists (DEVOS-132: moved issues). */
  issueRef(id: string): Promise<{ id: string; projectId: string | null } | null>;
  createIssue(input: IssueInput): Promise<string>;
  updateIssue(id: string, input: Partial<IssueInput>): Promise<void>;
  addBlockedBy(issueId: string, blockerId: string): Promise<void>;
}

export interface IssueInput { teamId: string; projectId: string; milestoneId: string | null; parentId: string | null; title: string;
  description: string; stateId: string; labelIds: string[]; assigneeId: string | null }

/** Where the sync stores the Linear ids it learns (resource rows, module/task linear_issue). */
export interface SyncStore {
  setProjectId(projectId: string, linearProjectId: string): Promise<void>;
  setMilestoneId(milestoneId: string, linearMilestoneId: string): Promise<void>;
  setModuleIssue(moduleId: string, issueId: string): Promise<void>;
  setTaskIssue(taskId: string, issueId: string): Promise<void>;
  /** M2.6-b (AT6): KK completed or cancelled a human task in Linear; the DevOS task becomes done (audited). */
  completeHumanTask(taskId: string, how: "completed" | "canceled"): Promise<void>;
}

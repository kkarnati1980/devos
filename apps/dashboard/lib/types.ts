// M1.3 view model. Field names and enums follow the M1.1 data model
// (docs/modules/M1.1.md: project, module, run, audit_event, spec) so the mock
// source can be swapped for the API source (M1.5/M2.3 routes) without page changes.

export const PROJECT_STAGES = ["intake", "provisioning", "building", "preview", "live", "archived", "purged"] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

export const MODULE_STATUSES = ["planned", "ready", "in_progress", "in_review", "merged", "deadlocked"] as const;
export type ModuleStatus = (typeof MODULE_STATUSES)[number];

export const RUN_ROLES = ["chief", "analyst", "architect", "builder", "tester", "reviewer", "release", "maintainer"] as const;
export type RunRole = (typeof RUN_ROLES)[number];

export interface ProjectSummary {
  slug: string; // ^[a-z0-9-]{2,40}$
  name: string;
  stage: ProjectStage;
  pausedAt: string | null; // ISO
  capUsd: number;
  spentUsd: number; // current month, from cost_entry
  lanes: number; // 1–3
  modulesMerged: number;
  modulesTotal: number;
  pendingApprovals: number;
  updatedAt: string; // ISO
}

export interface ModuleCard {
  key: string; // e.g. M1.1
  title: string;
  lane: string;
  status: ModuleStatus;
  dependsOn: string[];
  mergedSha: string | null;
  linearIssue: string | null;
}

export interface AgentSummary {
  role: RunRole;
  model: string;
  occurredAt: string;
  summary: string; // agent-written: untrusted text
}

export interface LogLine {
  ts: string;
  level: "info" | "warn" | "error";
  text: string; // tool / agent output: untrusted text
}

export interface ProjectDetail extends ProjectSummary {
  repoUrl: string | null;
  previewUrl: string | null;
  liveUrl: string | null;
  specExcerpt: string; // from spec.text: untrusted text
  modules: ModuleCard[];
  agentSummaries: AgentSummary[];
  log: LogLine[];
}

/** Where the pages read from. M1.3 ships the mock; the API source arrives with the project routes. */
export interface DashboardSource {
  readonly kind: "mock" | "api";
  listProjects(): Promise<ProjectSummary[]>;
  getProject(slug: string): Promise<ProjectDetail | null>;
}

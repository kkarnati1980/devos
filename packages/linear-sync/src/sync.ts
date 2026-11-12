// M2.6-a outbound sync (DevOS -> Linear), docs/modules/M2.6.md. Idempotent: every object is found by its stored
// id or, failing that, by its marker before anything is created; an unchanged plan makes no Linear write.
import type { DevosPlan, LinearApi, LinearIssue, StateType, SyncStore, ModuleStatus, TaskStatus } from "./types.js";
import { readMarker, sameText, withMarker } from "./markers.js";

export const LANE_LABEL = (lane: number) => `Lane ${String.fromCharCode(64 + Math.min(Math.max(lane, 1), 3))}`;

export function moduleState(s: ModuleStatus): { type: StateType; deadlocked: boolean } {
  switch (s) {
    case "planned": return { type: "backlog", deadlocked: false };
    case "ready": return { type: "unstarted", deadlocked: false };
    case "in_progress": case "in_review": return { type: "started", deadlocked: false };
    case "merged": return { type: "completed", deadlocked: false };
    case "deadlocked": return { type: "started", deadlocked: true };
  }
}
export function taskState(s: TaskStatus): { type: StateType; deadlocked: boolean } {
  switch (s) {
    case "blocked": case "ready": case "failed": return { type: "unstarted", deadlocked: false };
    case "running": return { type: "started", deadlocked: false };
    case "done": return { type: "completed", deadlocked: false };
    case "deadlocked": return { type: "started", deadlocked: true };
  }
}

const viewerCache = new WeakMap<LinearApi, string>();

export interface SyncResult { writes: number; created: string[]; updated: string[]; log: string[] }
export interface SyncOptions { teamKey?: string; kkUserId?: string }

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

export async function syncProject(plan: DevosPlan, api: LinearApi, store: SyncStore, opts: SyncOptions = {}): Promise<SyncResult> {
  const r: SyncResult = { writes: 0, created: [], updated: [], log: [] };
  const team = await api.team(opts.teamKey ?? "DEVOS");
  const stateId = (type: StateType) => {
    const s = team.states.find((x) => x.type === type);
    if (!s) throw new Error(`Linear team has no workflow state of type ${type}`);
    return s.id;
  };
  const labelIds = new Map(team.labels.map((l) => [l.name, l.id]));
  const label = async (name: string) => {
    let id = labelIds.get(name);
    if (!id) { id = await api.createLabel(team.id, name); labelIds.set(name, id); r.writes++; r.created.push(`label ${name}`); }
    return id;
  };
  let kk = opts.kkUserId ?? viewerCache.get(api);
  if (!kk) { kk = await api.viewerId(); viewerCache.set(api, kk); }   // looked up once per API instance

  // Project: stored id, else marker search, else create.
  // Linear's project description is a short summary field: keep it fixed and short (no project name), ~60 chars.
  const projDesc = withMarker("Mirrored by DevOS.", "project", plan.project.id);
  let projectId = plan.project.linearProjectId;
  let curProject: { name: string; description: string | null } | null = projectId ? await api.project(projectId) : null;
  if (projectId && !curProject) { r.log.push("stored Linear project id not found; searching by marker"); projectId = null; }
  if (!projectId) {
    const found = await api.findProject(team.id, plan.project.id);
    if (found) { projectId = found.id; curProject = found; r.log.push("project adopted by marker"); }
    else { projectId = await api.createProject({ teamId: team.id, name: plan.project.name, description: projDesc }); r.writes++; r.created.push("project"); }
    await store.setProjectId(plan.project.id, projectId);
  }
  // Codex PR35-r1: DevOS owns the project's name and summary; a rename (or a hand edit in Linear) is synced back.
  if (curProject && (curProject.name !== plan.project.name || !sameText(curProject.description, projDesc))) {
    await api.updateProject(projectId, { name: plan.project.name, description: projDesc }); r.writes++; r.updated.push("project");
  }

  // Milestones.
  const existingMs = await api.milestones(projectId);
  const msId = new Map<string, string>();
  for (const m of [...plan.milestones].sort((a, b) => a.ordinal - b.ordinal)) {
    const name = `P${m.ordinal} ${m.name}`;
    const desc = withMarker(`Gate: ${m.gateName}`, "milestone", m.id);
    // A stored id that no longer exists in Linear is treated as unknown (search by marker, else create).
    const stored = m.linearMilestoneId && existingMs.some((x) => x.id === m.linearMilestoneId) ? m.linearMilestoneId : null;
    let id = stored ?? existingMs.find((x) => readMarker(x.description, "milestone") === m.id)?.id ?? null;
    const cur = id ? existingMs.find((x) => x.id === id) : undefined;
    if (!id) { id = await api.createMilestone({ projectId, name, description: desc, sortOrder: m.ordinal }); r.writes++; r.created.push(`milestone ${name}`); }
    else if (cur && (cur.name !== name || !sameText(cur.description, desc))) { await api.updateMilestone(id, { name, description: desc }); r.writes++; r.updated.push(`milestone ${name}`); }
    if (id !== m.linearMilestoneId) await store.setMilestoneId(m.id, id);
    msId.set(m.id, id);
  }

  // Issues: modules, then tasks (sub-issues need their parent's id).
  const issues = await api.issues(projectId);
  const byId = new Map(issues.map((i) => [i.id, i]));
  const find = (stored: string | null, kind: "module" | "task", id: string): LinearIssue | undefined =>
    (stored ? byId.get(stored) : undefined) ?? issues.find((i) => readMarker(i.description, kind) === id);

  const upsert = async (what: string, existing: LinearIssue | undefined, want: { title: string; description: string; state: StateType;
    labels: string[]; parentId: string | null; milestoneId: string | null; assigneeId: string | null; keepLinearState?: boolean }) => {
    const lids = await Promise.all(want.labels.map(label));
    if (!existing) {
      const id = await api.createIssue({ teamId: team.id, projectId: projectId!, milestoneId: want.milestoneId, parentId: want.parentId, title: want.title,
        description: want.description, stateId: stateId(want.state), labelIds: lids, assigneeId: want.assigneeId });
      r.writes++; r.created.push(what);
      return id;
    }
    const patch: Record<string, unknown> = {};
    if (existing.title !== want.title) patch.title = want.title;
    if (!sameText(existing.description, want.description)) patch.description = want.description;
    // Human tasks: Linear owns their state after creation (KK completes them there; M2.6-b reads it back).
    if (!want.keepLinearState && existing.stateType !== want.state) { patch.stateId = stateId(want.state); r.log.push(`${what}: state ${existing.stateType} -> ${want.state}`); }
    if (!sameSet(existing.labelNames, want.labels)) patch.labelIds = lids;
    if (existing.parentId !== want.parentId) patch.parentId = want.parentId;
    if (existing.milestoneId !== want.milestoneId) patch.milestoneId = want.milestoneId;
    if (existing.assigneeId !== want.assigneeId) patch.assigneeId = want.assigneeId;
    if (Object.keys(patch).length) { await api.updateIssue(existing.id, patch); r.writes++; r.updated.push(what); }
    return existing.id;
  };

  const modIssue = new Map<string, string>();
  for (const m of plan.modules) {
    const st = moduleState(m.status);
    const existing = find(m.linearIssue, "module", m.id);
    const id = await upsert(`module ${m.key}`, existing, {
      title: `${m.key} ${m.title}`,
      description: withMarker(`Contract: \`${m.contractPath}\``, "module", m.id),
      state: st.type, labels: ["Module", LANE_LABEL(m.lane), ...(st.deadlocked ? ["deadlocked"] : [])],
      parentId: null, milestoneId: msId.get(m.milestoneId) ?? null, assigneeId: null,
    });
    if (id !== m.linearIssue) await store.setModuleIssue(m.id, id);
    modIssue.set(m.id, id);
  }
  for (const t of plan.tasks) {
    const st = taskState(t.status);
    const human = t.assignee === "kk";
    const existing = find(t.linearIssue, "task", t.id);
    const mod = t.moduleId ? plan.modules.find((m) => m.id === t.moduleId) : undefined;
    const id = await upsert(`task ${t.title.slice(0, 40)}`, existing, {
      title: t.title,
      description: withMarker(`DevOS task (${t.kind}).`, "task", t.id),
      state: st.type, labels: [human ? "Human" : "Task", ...(st.deadlocked ? ["deadlocked"] : [])],
      parentId: t.moduleId ? modIssue.get(t.moduleId) ?? null : null,
      milestoneId: mod ? msId.get(mod.milestoneId) ?? null : null,
      assigneeId: human ? kk : null, keepLinearState: human,
    });
    if (id !== t.linearIssue) await store.setTaskIssue(t.id, id);
  }

  // Blocked-by relations between module issues (add only; DevOS never removes a relation KK added).
  for (const d of plan.dependencies) {
    const a = modIssue.get(d.moduleId), b = modIssue.get(d.dependsOnId);
    if (!a || !b) continue;
    const cur = byId.get(a);
    if (cur && cur.blockedBy.includes(b)) continue;
    await api.addBlockedBy(a, b); r.writes++; r.created.push("relation");
  }
  return r;
}

// M2.6-a outbound sync (DevOS -> Linear), docs/modules/M2.6.md. Idempotent: every object is found by its stored
// id or, failing that, by its marker before anything is created; an unchanged plan makes no Linear write.
import type { DevosPlan, LinearApi, LinearIssue, StateType, SyncStore, ModuleStatus, TaskStatus } from "./types.js";
import { readMarker, sameText, withMarker } from "./markers.js";
import { LinearError } from "./client.js";

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

/**
 * Task kinds that are internal bookkeeping, never planned work, so they are never mirrored to Linear (DEVOS-162):
 * `analysis` records one analyst model-pass run (M2.2-d3b). They are dropped before any read or write.
 */
export const INTERNAL_TASK_KINDS: readonly string[] = ["analysis"];

export interface SyncResult { writes: number; created: string[]; updated: string[]; log: string[]; inbound: string[] }
export interface SyncOptions { teamKey?: string; kkUserId?: string }

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

export async function syncProject(fullPlan: DevosPlan, api: LinearApi, store: SyncStore, opts: SyncOptions = {}): Promise<SyncResult> {
  const plan: DevosPlan = { ...fullPlan, tasks: fullPlan.tasks.filter((t) => !INTERNAL_TASK_KINDS.includes(t.kind)) };
  const r: SyncResult = { writes: 0, created: [], updated: [], log: [], inbound: [] };
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
  let issues = await api.issues(projectId);
  // An agent issue someone moved out of the project (or whose project was cleared) is not in the list, and neither is
  // its marker, so it would be created again. A stored id missing from the list is looked up by id: if the issue still
  // exists it is moved back into the project (a manual edit is overwritten, never duplicated); only a gone issue is
  // created again. The list is read once more after a move.
  const listed = new Set(issues.map((i) => i.id));
  let moved = 0;
  // Pre-review: a move Linear refuses (e.g. the issue now sits in a team this project does not include) must not stop
  // every later sync of the project. That issue is left where it is, logged, and neither updated nor created again.
  const stuck = new Set<string>();
  for (const stored of [...plan.modules.map((m) => m.linearIssue), ...plan.tasks.map((t) => t.linearIssue)]) {
    if (!stored || listed.has(stored)) continue;
    const ref = await api.issueRef(stored);
    if (ref && ref.projectId !== projectId) {
      try {
        await api.updateIssue(ref.id, { projectId });
      } catch (e) {
        const refused = e instanceof LinearError && (e.code === "graphql" || (e.code === "http" && (e.status ?? 0) >= 400 && (e.status ?? 0) < 500 && e.status !== 429));
        if (!refused) throw e;
        stuck.add(ref.id);
        r.log.push(`issue ${ref.id} is outside the project and Linear refused to move it back; left as it is`);
        continue;
      }
      r.writes++; r.updated.push(`issue ${ref.id} moved back into the project`); moved++;
    }
  }
  if (moved) issues = await api.issues(projectId);
  const byId = new Map(issues.map((i) => [i.id, i]));
  const find = (stored: string | null, kind: "module" | "task", id: string): LinearIssue | undefined =>
    (stored ? byId.get(stored) : undefined) ?? issues.find((i) => readMarker(i.description, kind) === id);

  const upsert = async (what: string, existing: LinearIssue | undefined, want: { title: string; description: string; state: StateType;
    labels: string[]; parentId: string | null; milestoneId: string | null; assigneeId: string | null; keepLinearState?: boolean }) => {
    // Sequential on purpose (Codex PR35-r7): a parallel Promise.all rejects on the first failure while other label
    // writes are still in flight, and those could outlive the per-project lock. One at a time, nothing is left running.
    const lids: string[] = [];
    for (const name of want.labels) lids.push(await label(name));
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
    // An agent-owned issue moved by hand in Linear is put back (DevOS owns its state) and the revert is logged (AT6).
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
    if (m.linearIssue && stuck.has(m.linearIssue)) { modIssue.set(m.id, m.linearIssue); continue; }
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
    if (t.linearIssue && stuck.has(t.linearIssue)) continue;
    const st = taskState(t.status);
    const human = t.assignee === "kk";
    const existing = find(t.linearIssue, "task", t.id);
    // M2.6-b inbound (AT6): Linear owns a human task's state after creation. Completed or cancelled there → the
    // DevOS task becomes done (cancel is recorded as such), which the scheduler sees as an unblocked dependency.
    if (human && existing && t.status !== "done" && (existing.stateType === "completed" || existing.stateType === "canceled")) {
      if (await store.completeHumanTask(t.id, existing.stateType)) r.inbound.push(`task ${t.title.slice(0, 40)}: ${existing.stateType} in Linear -> done`);
    }
    // M2.6-b decision 3: a human task reopened in Linear after DevOS took it as done stays done (dependent work may
    // have started); the divergence is logged on every sync so it is visible, and nothing is written.
    if (human && existing && t.status === "done" && existing.stateType !== "completed" && existing.stateType !== "canceled") {
      r.log.push(`task ${t.title.slice(0, 40)}: reopened in Linear (${existing.stateType}) but done in DevOS; left as is`);
    }
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
    // A stuck issue (a refused move) is left alone entirely: no relation writes to or from it (Codex PR64-r1).
    if (stuck.has(a) || stuck.has(b)) continue;
    const cur = byId.get(a);
    if (cur && cur.blockedBy.includes(b)) continue;
    await api.addBlockedBy(a, b); r.writes++; r.created.push("relation");
  }
  return r;
}

// In-memory Linear for the sync tests: records every write so "no change = no write" can be asserted.
export function fakeLinear({ failCreateIssueAfterWrite = null } = {}) {
  // Ids are unique across fake instances, like real Linear ids (resource rows are unique on provider+kind+id).
  const run = Math.random().toString(36).slice(2, 10);
  let n = 0; const id = (p) => `${p}-${run}-${++n}`;
  const L = {
    writes: [], viewer: "user-kk",
    team: { id: "team-1", states: [["s-b", "backlog"], ["s-u", "unstarted"], ["s-s", "started"], ["s-c", "completed"], ["s-x", "canceled"]].map(([id, type]) => ({ id, type })), labels: [{ id: "l-mod", name: "Module" }] },
    projects: [], milestones: [], issues: [],
  };
  const w = (op, arg) => L.writes.push({ op, arg });
  const typeOf = (sid) => L.team.states.find((s) => s.id === sid).type;
  const labelNames = (ids) => ids.map((i) => L.team.labels.find((l) => l.id === i).name);
  L.api = {
    viewerId: async () => L.viewer,
    team: async () => ({ ...L.team, labels: [...L.team.labels] }),
    createLabel: async (_t, name) => { const l = { id: id("l"), name }; L.team.labels.push(l); w("createLabel", name); return l.id; },
    findProject: async (_t, pid) => L.projects.find((p) => p.description.includes(`devos-ref: project/${pid}`)) || null,
    projectExists: async (pid) => L.projects.some((p) => p.id === pid),
    createProject: async (i) => { const p = { id: id("p"), ...i }; L.projects.push(p); w("createProject", i); return p.id; },
    updateProject: async (pid, i) => { Object.assign(L.projects.find((p) => p.id === pid), i); w("updateProject", i); },
    milestones: async (pid) => L.milestones.filter((m) => m.projectId === pid).map(({ id, name, description }) => ({ id, name, description })),
    createMilestone: async (i) => { const m = { id: id("m"), ...i }; L.milestones.push(m); w("createMilestone", i); return m.id; },
    updateMilestone: async (mid, i) => { Object.assign(L.milestones.find((m) => m.id === mid), i); w("updateMilestone", i); },
    issues: async (pid) => L.issues.filter((x) => x.projectId === pid).map((x) => ({ id: x.id, title: x.title, description: x.description, stateType: typeOf(x.stateId),
      labelNames: labelNames(x.labelIds), parentId: x.parentId, milestoneId: x.milestoneId, assigneeId: x.assigneeId, blockedBy: [...x.blockedBy] })),
    createIssue: async (i) => {
      const x = { id: id("i"), blockedBy: [], ...i }; L.issues.push(x); w("createIssue", i);
      if (failCreateIssueAfterWrite !== null && L.issues.length === failCreateIssueAfterWrite) throw new Error("connection reset after create");
      return x.id;
    },
    updateIssue: async (iid, i) => { Object.assign(L.issues.find((x) => x.id === iid), i); w("updateIssue", { iid, ...i }); },
    addBlockedBy: async (a, b) => { L.issues.find((x) => x.id === a).blockedBy.push(b); w("addBlockedBy", { a, b }); },
  };
  return L;
}

export function memoryStore(plan) {
  return {
    setProjectId: async (_p, v) => { plan.project.linearProjectId = v; },
    setMilestoneId: async (m, v) => { plan.milestones.find((x) => x.id === m).linearMilestoneId = v; },
    setModuleIssue: async (m, v) => { plan.modules.find((x) => x.id === m).linearIssue = v; },
    setTaskIssue: async (t, v) => { plan.tasks.find((x) => x.id === t).linearIssue = v; },
  };
}

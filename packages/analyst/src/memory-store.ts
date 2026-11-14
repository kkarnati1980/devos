// In-memory RequirementsStore (M2.2-d1): the reference behaviour of the port for tests; M2.2-d2's Prisma store
// does the same in one transaction under a project row lock.
import { randomUUID } from "node:crypto";
import { PipelineError, type ApprovalDecisions, type DocRow, type DocStatus, type ProjectRow, type RequirementsStore, type SaveAnalysisInput, type SaveAnalysisResult } from "./pipeline.js";

export interface MemorySpec {
  id: string;
  projectId: string;
  version: number;
  sourceFormat: string;
  originalName: string | null;
  fileSha256: string;
  text: string;
}

export interface MemoryRequirement {
  key: string;
  title: string;
  priority: string;
  acceptance: string;
  milestoneOrdinal: number | null;
}

export class MemoryRequirementsStore implements RequirementsStore {
  readonly projects = new Map<string, ProjectRow>();
  readonly specs: MemorySpec[] = [];
  readonly docs: (DocRow & { repoPath: string; preflight?: unknown })[] = [];
  /** ADR-0012 CR-a2: `project.preflight_state` per project (absent = never set, i.e. backfilled `approved`). */
  readonly preflightState = new Map<string, "pending" | "approved" | "rejected">();
  /** projectId → key → row */
  readonly requirements = new Map<string, Map<string, MemoryRequirement>>();
  /** projectId → ordinal → milestone */
  readonly milestones = new Map<string, Map<number, { ordinal: number; name: string; gateName: string }>>();

  addProject(p: ProjectRow): void {
    this.projects.set(p.id, { ...p });
  }

  async project(projectId: string): Promise<ProjectRow | null> {
    const p = this.projects.get(projectId);
    return p ? { ...p } : null;
  }

  async saveAnalysis(input: SaveAnalysisInput): Promise<SaveAnalysisResult> {
    // Synchronous body = one atomic step in a single-threaded runtime (the Prisma store uses a transaction + lock).
    const pid = input.projectId;
    const project = this.projects.get(pid);
    if (!project || project.stage !== input.expectedStage) throw new PipelineError("project-not-in-intake", 409);
    const docs = this.docs.filter((d) => d.projectId === pid);
    if (docs.some((d) => d.status === "approved")) throw new PipelineError("requirements-already-approved", 409);
    const specVersion = this.specs.filter((s) => s.projectId === pid).reduce((m, s) => Math.max(m, s.version), 0) + 1;
    const docVersion = docs.reduce((m, d) => Math.max(m, d.version), 0) + 1;
    const spec: MemorySpec = { id: randomUUID(), projectId: pid, version: specVersion, ...input.spec };
    this.specs.push(spec);
    for (const d of docs) if (d.status === "draft") d.status = "superseded";
    const doc = {
      id: randomUUID(),
      projectId: pid,
      version: docVersion,
      status: "draft" as DocStatus,
      approvalId: null,
      repoPath: input.repoPath,
      ...(input.preflight ? { preflight: structuredClone(input.preflight) } : {}),
    };
    this.docs.push(doc);
    if (input.preflight) this.preflightState.set(pid, "pending");
    else if (this.preflightState.get(pid) === "rejected") this.preflightState.set(pid, "pending"); // DEVOS-208

    const ms = this.milestones.get(pid) ?? new Map();
    this.milestones.set(pid, ms);
    const newOrdinals = new Set(input.milestones.map((m) => m.ordinal));
    const droppedMilestones = [...ms.keys()].filter((o) => !newOrdinals.has(o)).sort((a, b) => a - b);
    for (const m of input.milestones) ms.set(m.ordinal, { ...m });

    const rs = this.requirements.get(pid) ?? new Map();
    this.requirements.set(pid, rs);
    const newKeys = new Set(input.requirements.map((r) => r.key));
    const droppedKeys = [...rs.keys()].filter((k) => !newKeys.has(k)).sort();
    for (const r of input.requirements) rs.set(r.key, { ...r });

    return { specId: spec.id, specVersion, docId: doc.id, docVersion, droppedKeys, droppedMilestones };
  }

  async latestDoc(projectId: string): Promise<DocRow | null> {
    let best: DocRow | null = null;
    for (const d of this.docs) if (d.projectId === projectId && (!best || d.version > best.version)) best = d;
    return best ? { id: best.id, projectId: best.projectId, version: best.version, status: best.status, approvalId: best.approvalId } : null;
  }

  async docForApproval(approvalId: string): Promise<DocRow | null> {
    const d = this.docs.find((x) => x.approvalId === approvalId);
    return d
      ? { id: d.id, projectId: d.projectId, version: d.version, status: d.status, approvalId: d.approvalId, ...(d.preflight ? { preflight: structuredClone(d.preflight) as DocRow["preflight"] } : {}) }
      : null;
  }

  async linkApproval(docId: string, approvalId: string): Promise<boolean> {
    const d = this.docs.find((x) => x.id === docId);
    if (!d || d.status !== "draft" || d.approvalId !== null) return false;
    d.approvalId = approvalId;
    return true;
  }

  /** ADR-0012 rule 3: the project decision log (`project_decision`), unique on approval and item. */
  readonly decisions: { projectId: string; approvalId: string; itemId: string; text: string; answer: string; source: string }[] = [];

  private newestDraft(docId: string) {
    const d = this.docs.find((x) => x.id === docId);
    if (!d || d.status !== "draft") return null;
    const newest = this.docs.filter((x) => x.projectId === d.projectId).reduce((m, x) => Math.max(m, x.version), 0);
    return d.version === newest ? d : null;
  }

  async approveDoc(docId: string, decisions?: ApprovalDecisions): Promise<boolean> {
    const d = this.newestDraft(docId);
    if (!d) return false;
    d.status = "approved";
    if (decisions) {
      for (const row of decisions.rows) {
        if (this.decisions.some((x) => x.approvalId === decisions.approvalId && x.itemId === row.itemId)) continue;
        this.decisions.push({ projectId: d.projectId, approvalId: decisions.approvalId, ...row });
      }
      this.preflightState.set(d.projectId, "approved");
    } else if (this.preflightState.get(d.projectId) === "pending") {
      // DEVOS-205: a doc without a pre-flight on a `pending` project: its approval opens the state (as Prisma).
      this.preflightState.set(d.projectId, "approved");
    }
    return true;
  }

  async rejectPreflight(docId: string): Promise<boolean> {
    const d = this.newestDraft(docId);
    if (!d) return false;
    this.preflightState.set(d.projectId, "rejected");
    return true;
  }

}

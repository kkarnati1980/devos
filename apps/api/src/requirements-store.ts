// M2.2-d2 (docs/modules/M2.2.md): the Postgres RequirementsStore behind the M2.2-d1 pipeline. Every write runs in
// one transaction bounded by `timeout`, `maxWait` and a transaction-local `statement_timeout` (ADR-0011 timeouts).
// `saveAnalysis` and `approveDoc` both lock the project row (`SELECT … FOR UPDATE`) first, so a submission and an
// approval for the same project serialise and a project never ends with two approved requirements docs.
import {
  PipelineError,
  type DocRow,
  type DocStatus,
  type ProjectRow,
  type RequirementsStore,
  type SaveAnalysisInput,
  type SaveAnalysisResult,
} from "@devos/analyst";

type Tx = any;

/** Most requirements one spec version may store: keeps `saveAnalysis` well inside its transaction timeout. */
export const MAX_REQUIREMENTS = 2000;

function toDoc(r: { id: string; projectId: string; version: number; status: DocStatus; approvalId: string | null }): DocRow {
  return { id: r.id, projectId: r.projectId, version: r.version, status: r.status, approvalId: r.approvalId ?? null };
}

const DOC_SELECT = { id: true, projectId: true, version: true, status: true, approvalId: true } as const;

export class PrismaRequirementsStore implements RequirementsStore {
  constructor(
    private readonly db: { $transaction<T>(fn: (tx: Tx) => Promise<T>, o?: { timeout?: number; maxWait?: number }): Promise<T> },
    private readonly timeoutMs = 10_000,
  ) {}

  private tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.$transaction(
      async (t: Tx) => {
        await t.$queryRaw`SELECT set_config('statement_timeout', ${String(this.timeoutMs)}, true) AS statement_timeout`;
        return fn(t);
      },
      { timeout: this.timeoutMs, maxWait: this.timeoutMs },
    );
  }

  /** Locks the project row; returns its stage, or null when it does not exist. */
  private async lockProject(tx: Tx, projectId: string): Promise<string | null> {
    const rows: { stage: string }[] = await tx.$queryRaw`SELECT stage::text AS stage FROM project WHERE id = ${projectId}::uuid FOR UPDATE`;
    return rows.length ? rows[0]!.stage : null;
  }

  project(projectId: string): Promise<ProjectRow | null> {
    return this.tx(async (tx) => {
      const p = await tx.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, stage: true } });
      return p ? { id: p.id, name: p.name, stage: String(p.stage) } : null;
    });
  }

  saveAnalysis(input: SaveAnalysisInput): Promise<SaveAnalysisResult> {
    // Checked before the transaction: a refusal with a clear code instead of a timeout (pre-review d2 finding 3).
    if (input.requirements.length > MAX_REQUIREMENTS) return Promise.reject(new PipelineError("too-many-requirements", 413));
    return this.tx(async (tx) => {
      const pid = input.projectId;
      const stage = await this.lockProject(tx, pid);
      if (stage === null) throw new PipelineError("project-not-found", 404);
      if (stage !== input.expectedStage) throw new PipelineError("project-not-in-intake", 409);
      if (await tx.requirementsDoc.findFirst({ where: { projectId: pid, status: "approved" }, select: { id: true } })) {
        throw new PipelineError("requirements-already-approved", 409);
      }
      const specMax = await tx.spec.aggregate({ where: { projectId: pid }, _max: { version: true } });
      const docMax = await tx.requirementsDoc.aggregate({ where: { projectId: pid }, _max: { version: true } });
      const specVersion = (specMax._max.version ?? 0) + 1;
      const docVersion = (docMax._max.version ?? 0) + 1;
      const spec = await tx.spec.create({
        data: {
          projectId: pid,
          version: specVersion,
          sourceFormat: input.spec.sourceFormat,
          originalName: input.spec.originalName,
          fileSha256: input.spec.fileSha256,
          text: input.spec.text,
        },
        select: { id: true },
      });
      await tx.requirementsDoc.updateMany({ where: { projectId: pid, status: "draft" }, data: { status: "superseded" } });
      const doc = await tx.requirementsDoc.create({
        data: { projectId: pid, version: docVersion, repoPath: input.repoPath, status: "draft" },
        select: { id: true },
      });

      // Milestones by ordinal; earlier ones absent now are kept (no deletion) and reported.
      const oldMs: { id: string; ordinal: number }[] = await tx.milestone.findMany({ where: { projectId: pid }, select: { id: true, ordinal: true } });
      const newOrdinals = new Set(input.milestones.map((m) => m.ordinal));
      const droppedMilestones = oldMs.map((m) => m.ordinal).filter((o) => !newOrdinals.has(o)).sort((a, b) => a - b);
      const msId = new Map<number, string>();
      for (const m of input.milestones) {
        const row = await tx.milestone.upsert({
          where: { projectId_ordinal: { projectId: pid, ordinal: m.ordinal } },
          create: { projectId: pid, ordinal: m.ordinal, name: m.name, gateName: m.gateName },
          update: { name: m.name, gateName: m.gateName },
          select: { id: true },
        });
        msId.set(m.ordinal, row.id);
      }

      // Requirements by key; earlier keys absent now are kept and reported.
      const oldReqs: { key: string }[] = await tx.requirement.findMany({ where: { projectId: pid }, select: { key: true } });
      const newKeys = new Set(input.requirements.map((r) => r.key));
      const droppedKeys = oldReqs.map((r) => r.key).filter((k) => !newKeys.has(k)).sort();
      for (const r of input.requirements) {
        const data = {
          title: r.title,
          priority: r.priority,
          acceptance: r.acceptance,
          milestoneId: r.milestoneOrdinal === null ? null : (msId.get(r.milestoneOrdinal) ?? null),
        };
        await tx.requirement.upsert({
          where: { projectId_key: { projectId: pid, key: r.key } },
          create: { projectId: pid, key: r.key, ...data },
          update: data,
          select: { id: true },
        });
      }

      await tx.auditEvent.create({
        data: {
          actor: "system",
          action: "requirements.analysed",
          summary: `Spec v${specVersion} analysed: requirements doc v${docVersion} drafted`,
          details: { specVersion, docVersion, requirements: input.requirements.length, milestones: input.milestones.length, droppedKeys: droppedKeys.length },
          projectId: pid,
        },
      });
      return { specId: spec.id, specVersion, docId: doc.id, docVersion, droppedKeys, droppedMilestones };
    });
  }

  latestDoc(projectId: string): Promise<DocRow | null> {
    return this.tx(async (tx) => {
      const r = await tx.requirementsDoc.findFirst({ where: { projectId }, orderBy: { version: "desc" }, select: DOC_SELECT });
      return r ? toDoc(r) : null;
    });
  }

  docForApproval(approvalId: string): Promise<DocRow | null> {
    return this.tx(async (tx) => {
      const r = await tx.requirementsDoc.findFirst({ where: { approvalId }, orderBy: { version: "desc" }, select: DOC_SELECT });
      return r ? toDoc(r) : null;
    });
  }

  /** Stored requirement rows in key order (for the requirements view). */
  rows(projectId: string): Promise<{ key: string; title: string; priority: string; acceptance: string; milestone: number | null }[]> {
    return this.tx(async (tx) => {
      const rs = await tx.requirement.findMany({
        where: { projectId },
        orderBy: { key: "asc" },
        take: 5000,
        select: { key: true, title: true, priority: true, acceptance: true, milestone: { select: { ordinal: true } } },
      });
      return rs.map((r: any) => ({ key: r.key, title: r.title, priority: String(r.priority), acceptance: r.acceptance, milestone: r.milestone?.ordinal ?? null }));
    });
  }

  linkApproval(docId: string, approvalId: string): Promise<boolean> {
    return this.tx(async (tx) => {
      const n = await tx.requirementsDoc.updateMany({ where: { id: docId, status: "draft", approvalId: null }, data: { approvalId } });
      return n.count === 1;
    });
  }

  approveDoc(docId: string): Promise<boolean> {
    return this.tx(async (tx) => {
      const d = await tx.requirementsDoc.findUnique({ where: { id: docId }, select: { projectId: true } });
      if (!d) return false;
      await this.lockProject(tx, d.projectId);
      // Re-read under the project lock: only the newest doc, still a draft, is approved.
      const newest = await tx.requirementsDoc.findFirst({ where: { projectId: d.projectId }, orderBy: { version: "desc" }, select: DOC_SELECT });
      if (!newest || newest.id !== docId || newest.status !== "draft") return false;
      await tx.requirementsDoc.update({ where: { id: docId }, data: { status: "approved" } });
      await tx.auditEvent.create({
        data: {
          actor: "system",
          action: "requirements.approved",
          summary: `Requirements doc v${newest.version} approved`,
          details: { docVersion: newest.version, approvalId: newest.approvalId },
          projectId: d.projectId,
        },
      });
      return true;
    });
  }
}

// M2.2-d2 (docs/modules/M2.2.md): the Postgres RequirementsStore behind the M2.2-d1 pipeline. Every write runs in
// one transaction bounded by `timeout`, `maxWait` and a transaction-local `statement_timeout` (ADR-0011 timeouts).
// `saveAnalysis` and `approveDoc` both lock the project row (`SELECT … FOR UPDATE`) first, so a submission and an
// approval for the same project serialise and a project never ends with two approved requirements docs.
import {
  PipelineError,
  type ApprovalDecisions,
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

  /**
   * M2.2-d3c2 (Codex PR88-r1): runs `fn` while holding the project row, so no submission can save a new version
   * (`saveAnalysis` takes `FOR UPDATE` on the same row) until it returns. `FOR NO KEY UPDATE` still conflicts with
   * that, but not with the `FOR KEY SHARE` a foreign-key insert takes, so `fn` may write rows that reference the
   * project (the approvals core's audit rows) from its own transactions without waiting on this one.
   *
   * Codex PR88-r4: `fn`'s writes run in their own transactions, so a hold that times out would release the row while
   * `fn` carries on. The hold therefore lasts the store's timeout plus `stepMs` (the longest one write of `fn` can
   * take: its own transaction bound), and `fn` gets `assertHeld()`, which throws `project-hold-lapsed` unless a whole
   * step still fits before the hold's deadline. Calling it before each write means every write `fn` starts also ends
   * (commits or rolls back on its own bound) while the row is still held.
   */
  withProjectHeld<T>(projectId: string, fn: (assertHeld: () => void) => Promise<T>, stepMs = 0): Promise<T> {
    const holdMs = this.timeoutMs + stepMs;
    const started = performance.now();
    const assertHeld = () => {
      if (performance.now() + stepMs >= started + holdMs) throw new HoldLapsedError();
    };
    return this.db.$transaction(
      async (tx: Tx) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(holdMs)}, true) AS statement_timeout`;
        await tx.$queryRaw`SELECT 1 AS held FROM project WHERE id = ${projectId}::uuid FOR NO KEY UPDATE`;
        return fn(assertHeld);
      },
      { timeout: holdMs, maxWait: this.timeoutMs },
    );
  }

  project(projectId: string): Promise<ProjectRow | null> {
    return this.tx(async (tx) => {
      const p = await tx.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true, stage: true, continuousRun: true, capUsd: true },
      });
      // ADR-0012 CR-a2: the mode and the budget cap for the pre-flight. `cap_usd` is a Decimal; Number() is exact
      // enough for a display value (12,6 fits a double's integer range).
      return p ? { id: p.id, name: p.name, stage: String(p.stage), continuousRun: p.continuousRun === true, capUsd: Number(p.capUsd) } : null;
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
        data: { projectId: pid, version: docVersion, repoPath: input.repoPath, status: "draft", ...(input.preflight ? { preflight: input.preflight } : {}) },
        select: { id: true },
      });
      // ADR-0012 rule 4: a new version in continuous-run mode re-opens the pre-flight, under the same project lock.
      if (input.preflight) await tx.project.update({ where: { id: pid }, data: { preflightState: "pending" }, select: { id: true } });

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

  /**
   * M2.2-d3c1: projects whose newest doc is a draft linked to an **approved** card, oldest draft first, at most
   * `limit` (the sync job's batch). Only approved cards are read, so drafts whose card is pending, rejected or expired
   * never fill the batch and starve newer projects (pre-review finding 2). Read-only; the job applies each decision
   * through `syncApproval`.
   * ADR-0012 CR-a2 (pre-review finding 2): a draft whose intake card (with a pre-flight) was **rejected** is listed
   * too while the project's `preflight_state` is not yet `rejected`, so the job closes the pre-flight unattended;
   * once it is `rejected` the draft drops out again and never fills the batch.
   */
  draftsAwaitingDecision(limit: number): Promise<string[]> {
    const n = Math.max(1, Math.min(1000, Math.trunc(limit)));
    return this.tx(async (tx) => {
      const rows: { project_id: string }[] = await tx.$queryRaw`
        SELECT d.project_id::text AS project_id FROM (
          SELECT DISTINCT ON (project_id) project_id, status, approval_id, created_at, preflight
          FROM requirements_doc ORDER BY project_id, version DESC
        ) d
        JOIN approval a ON a.id = d.approval_id AND a.gate = 'requirements'
        JOIN project p ON p.id = d.project_id
        WHERE d.status = 'draft'
          AND (a.status = 'approved' OR (a.status = 'rejected' AND d.preflight IS NOT NULL AND p.preflight_state <> 'rejected'))
        ORDER BY d.created_at, d.project_id
        LIMIT ${n}`;
      return rows.map((r) => r.project_id);
    });
  }

  docForApproval(approvalId: string): Promise<DocRow | null> {
    return this.tx(async (tx) => {
      const r = await tx.requirementsDoc.findFirst({ where: { approvalId }, orderBy: { version: "desc" }, select: { ...DOC_SELECT, preflight: true } });
      // ADR-0012 CR-a2: the stored pre-flight list rides along, so the approval records against what KK saw.
      return r ? { ...toDoc(r), ...(Array.isArray(r.preflight) ? { preflight: r.preflight } : {}) } : null;
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

  approveDoc(docId: string, decisions?: ApprovalDecisions): Promise<boolean> {
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
      if (decisions) {
        // ADR-0012 rule 3, in the approval's transaction: one row per decision item. The unique (approval, item)
        // index makes a retried sync a no-op.
        await tx.projectDecision.createMany({
          data: decisions.rows.map((row) => ({ projectId: d.projectId, approvalId: decisions.approvalId, itemId: row.itemId, text: row.text, answer: row.answer, source: row.source })),
          skipDuplicates: true,
        });
        await tx.project.update({ where: { id: d.projectId }, data: { preflightState: "approved" }, select: { id: true } });
      }
      return true;
    });
  }

  /** ADR-0012 rule 4: a rejected intake card closes the build, only for the newest draft (under the project lock). */
  rejectPreflight(docId: string): Promise<boolean> {
    return this.tx(async (tx) => {
      const d = await tx.requirementsDoc.findUnique({ where: { id: docId }, select: { projectId: true } });
      if (!d) return false;
      await this.lockProject(tx, d.projectId);
      const newest = await tx.requirementsDoc.findFirst({ where: { projectId: d.projectId }, orderBy: { version: "desc" }, select: DOC_SELECT });
      if (!newest || newest.id !== docId || newest.status !== "draft") return false;
      await tx.project.update({ where: { id: d.projectId }, data: { preflightState: "rejected" }, select: { id: true } });
      return true;
    });
  }

  /** CR-a3 (DEVOS-199): the project row by slug, for the project page's pre-flight view. */
  projectBySlug(slug: string): Promise<{ id: string; continuousRun: boolean } | null> {
    return this.tx(async (tx) => {
      const p = await tx.project.findUnique({ where: { slug }, select: { id: true, continuousRun: true } });
      return p ? { id: p.id, continuousRun: p.continuousRun === true } : null;
    });
  }

  /** CR-a3 (DEVOS-199): the decision log rows of one intake card (approval), oldest first, at most 500 rows. */
  decisions(projectId: string, approvalId: string): Promise<{ itemId: string; answer: string; source: string; createdAt: string }[]> {
    return this.tx(async (tx) => {
      const rows = await tx.projectDecision.findMany({
        where: { projectId, approvalId },
        orderBy: [{ createdAt: "asc" }, { itemId: "asc" }],
        take: 500,
        select: { itemId: true, answer: true, source: true, createdAt: true },
      });
      return rows.map((r: { itemId: string; answer: string; source: string; createdAt: Date }) => ({ itemId: r.itemId, answer: r.answer, source: r.source, createdAt: r.createdAt.toISOString() }));
    });
  }

  /**
   * `PreflightReader` for `preflightOpen` (apps/api/src/preflight.ts): the state and the newest doc's list in one
   * SQL statement, so both come from the same snapshot even under READ COMMITTED (Codex PR122-r2).
   */
  preflightSnapshot(projectId: string): Promise<import("./preflight.js").PreflightSnapshot | null> {
    return this.tx(async (tx) => {
      const rows: { state: string; preflight: unknown; approval_id: string | null }[] = await tx.$queryRaw`
        SELECT p.preflight_state AS state, d.preflight AS preflight, d.approval_id::text AS approval_id
        FROM project p
        LEFT JOIN LATERAL (
          SELECT r.preflight, r.approval_id FROM requirements_doc r WHERE r.project_id = p.id ORDER BY r.version DESC LIMIT 1
        ) d ON true
        WHERE p.id = ${projectId}::uuid`;
      const r = rows[0];
      if (!r) return null;
      const s = r.state;
      return {
        state: s === "pending" || s === "approved" || s === "rejected" ? s : null,
        items: Array.isArray(r.preflight) ? (r.preflight as import("@devos/analyst").PreflightItem[]) : null,
        approvalId: r.approval_id ?? null,
      };
    });
  }

  /** The project's pre-flight state (decision log and project page reads; `preflightOpen` uses `preflightSnapshot`). */
  preflightState(projectId: string): Promise<"pending" | "approved" | "rejected" | null> {
    return this.tx(async (tx) => {
      const p = await tx.project.findUnique({ where: { id: projectId }, select: { preflightState: true } });
      const s = p?.preflightState;
      return s === "pending" || s === "approved" || s === "rejected" ? s : null;
    });
  }

  latestPreflight(projectId: string): Promise<import("@devos/analyst").PreflightItem[] | null> {
    return this.tx(async (tx) => {
      const d = await tx.requirementsDoc.findFirst({ where: { projectId }, orderBy: { version: "desc" }, select: { preflight: true } });
      return Array.isArray(d?.preflight) ? d.preflight : null;
    });
  }
}

/** The project hold's deadline is too near for another write (Codex PR88-r4): the pass stops, nothing more is expired. */
export class HoldLapsedError extends Error {
  constructor() {
    super("project-hold-lapsed");
    this.name = "HoldLapsedError";
  }
}

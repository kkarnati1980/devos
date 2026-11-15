// M2.2-d1 (docs/modules/M2.2.md): the Analyst pipeline service. Spec upload or paste → `ingest` → new `spec`
// version → analysis (+ optional model pass) → `requirement`, `milestone` and `requirements_doc` rows → one
// `requirements` card for KK, plus the open-question cards. Persistence and card raising are ports, so this file
// stays free of the DB and the API (M2.2-d2 binds them to Prisma and to M2.3 `Approvals`).
import { ingest as defaultIngest, IngestError, type IngestResult, type SpecFileFormat } from "@devos/intake";
import { analyzeSpec, type Analysis, type Priority } from "./analyze.js";
import { assistAnalysis, type ModelRunner } from "./assist.js";
import { renderRequirementsMd } from "./render.js";
import { BUDGET_TEXT, PUBLIC_URL_TEXT, buildPreflight, preflightDecisions, preflightLine, preflightReanswers, type PreflightDecisionRow, type PreflightItem, type PreflightReanswerRow } from "./preflight.js";
import { CARD_REASON_MAX, planQuestions, raiseQuestionCards, renderArchitectLog, type RaiseCard, type RouteResult } from "./route.js";

export type SpecSourceFormat = SpecFileFormat | "paste";
export type DocStatus = "draft" | "approved" | "superseded";

export class PipelineError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}

export type SpecInput =
  | { kind: "file"; bytes: Uint8Array; originalName: string }
  | { kind: "paste"; text: string };

export interface ProjectRow {
  id: string;
  name: string;
  stage: string;
  /** ADR-0012 CR-a2: `project.continuous_run`. Absent = off (today's behaviour). */
  continuousRun?: boolean;
  /** The project's M1.7 budget envelope cap (`project.cap_usd`), for the pre-flight budget item. */
  capUsd?: number;
}

export interface RequirementRowInput {
  key: string;
  title: string;
  priority: Priority;
  /** Criteria joined by "\n" (the `requirement.acceptance` column is one text). */
  acceptance: string;
  /** Milestone ordinal in this analysis, or null. */
  milestoneOrdinal: number | null;
}

export interface SaveAnalysisInput {
  projectId: string;
  /** Re-checked under the project lock: `project-not-in-intake` (409) when the stage has changed. */
  expectedStage: string;
  spec: { sourceFormat: SpecSourceFormat; originalName: string | null; fileSha256: string; text: string };
  requirements: RequirementRowInput[];
  milestones: { ordinal: number; name: string; gateName: string }[];
  repoPath: string;
  /**
   * ADR-0012 CR-a2: in continuous-run mode, this version's pre-flight list. The store writes it to the new doc and
   * sets `project.preflight_state` to `pending` in the same transaction (rule 4: a new version re-opens the
   * pre-flight). Absent or null outside the mode: nothing changes.
   */
  preflight?: PreflightItem[] | null;
}

export interface SaveAnalysisResult {
  specId: string;
  specVersion: number;
  docId: string;
  docVersion: number;
  /** Keys / ordinals stored by an earlier version and absent now. They are kept (no deletion: that is KK's call). */
  droppedKeys: string[];
  droppedMilestones: number[];
}

export interface DocRow {
  id: string;
  projectId: string;
  version: number;
  status: DocStatus;
  approvalId: string | null;
  /** ADR-0012 CR-a2: this version's pre-flight list (absent or null outside continuous-run mode). */
  preflight?: PreflightItem[] | null;
}

/** ADR-0012 rule 3: the decision log rows written with an approval, in the same transaction. */
export interface ApprovalDecisions {
  approvalId: string;
  rows: PreflightDecisionRow[];
}

/**
 * Persistence port. `saveAnalysis` is ONE transaction that locks the project row, so two submissions for the same
 * project serialise: it refuses with `requirements-already-approved` when an approved doc exists, assigns the next
 * spec and doc versions, supersedes earlier draft docs, upserts requirements by key and milestones by ordinal.
 */
export interface RequirementsStore {
  project(projectId: string): Promise<ProjectRow | null>;
  saveAnalysis(input: SaveAnalysisInput): Promise<SaveAnalysisResult>;
  /** The newest doc of the project, or null. */
  latestDoc(projectId: string): Promise<DocRow | null>;
  docForApproval(approvalId: string): Promise<DocRow | null>;
  /** Sets `approval_id` only while it is null and the doc is a draft; false otherwise. */
  linkApproval(docId: string, approvalId: string): Promise<boolean>;
  /**
   * Approves a doc under the SAME project-row lock as `saveAnalysis`, so an approval and a new submission
   * serialise: true only when the doc is a draft AND the project's newest doc (pre-review r2: a bare
   * compare-and-set outside the lock could leave two approved docs).
   */
  approveDoc(docId: string, decisions?: ApprovalDecisions): Promise<boolean>;
  /**
   * ADR-0012 rule 4: a rejected intake card. Sets `preflight_state` to `rejected` under the project lock, only while
   * `docId` is the newest doc and a draft (a newer version has already re-opened the pre-flight). Optional: a store
   * without it leaves the state as it is.
   */
  rejectPreflight?(docId: string): Promise<boolean>;
  /** DEVOS-204: the rows written with this approval (`approval_id`), any order. Optional with `recordReanswers`. */
  approvalDecisions?(approvalId: string): Promise<{ itemId: string; answer: string }[]>;
  /**
   * DEVOS-204: writes re-answer rows (`comment_id` set, `approval_id` null) for the approved `docId`, skipping any
   * (comment, item) already written, and moves the doc's re-answer cursor forward to `seenUpTo` (never back).
   * Never changes `preflight_state` or any task (rule 3: running work does not stop). False when the doc is not
   * approved (nothing is written).
   */
  recordReanswers?(docId: string, rows: readonly PreflightReanswerRow[], seenUpTo: Date | null): Promise<boolean>;
}

/** An M2.3 `CardInput` for the requirements gate; the port is `Approvals.raiseCard(card, [])`. */
export interface RequirementsCard {
  gate: "requirements";
  action: string;
  target: string;
  reason: string;
  projectId: string;
}

export interface PipelinePorts {
  store: RequirementsStore;
  raiseRequirementsCard: (card: RequirementsCard) => Promise<{ id: string }>;
  raiseQuestionCard: RaiseCard;
  /** M1.5 run-engine binding (role Analyst); null/absent = deterministic only. */
  runner?: ModelRunner | null;
  /**
   * DEVOS-176: the `analyst.model_pass` setting, read before each pass so a change takes effect without a restart.
   * Absent = on whenever a runner is bound (the API always binds it, default off). A read that fails counts as off
   * (fail-safe: no model spend, deterministic only) and is reported as `assist-failed`.
   */
  modelPassOn?: () => Promise<boolean>;
  /** ADR-0012 CR-a2: the secret names the app needs (from the S5 selection); absent = none yet. */
  secretNames?: (projectId: string) => Promise<string[]>;
  ingest?: (bytes: Uint8Array, originalName: string) => Promise<IngestResult>;
  now?: () => Date;
}

export type PipelineWarningCode = "assist-failed" | "card-failed" | "card-link-failed";

export interface SubmitResult {
  specId: string;
  specVersion: number;
  docId: string;
  docVersion: number;
  approvalId: string | null;
  /** docs/requirements.md content (inert); M2.2-d2 commits it to the app repo. */
  markdown: string;
  /** docs/decisions/analyst-questions.md content: technical questions for the Architect. */
  architectLog: string;
  counts: { requirements: number; milestones: number; openQuestions: number; proposed: number };
  questionCards: RouteResult;
  /** ADR-0012 CR-a2: the pre-flight list on the intake card, or null outside continuous-run mode. */
  preflight: PreflightItem[] | null;
  droppedKeys: string[];
  droppedMilestones: number[];
  analysisWarnings: Analysis["warnings"];
  warnings: PipelineWarningCode[];
}

export const REPO_PATH = "docs/requirements.md";
/** UTF-16 code units, as `String.length` counts them. */
export const PASTE_MAX_CHARS = 500_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPEN_STAGES = new Set(["intake"]);

/** Size limits → 413, conversion faults (timeout, memory, crash) → 422, anything else the file's fault → 400. */
export function ingestStatus(code: string): number {
  if (code === "too-large" || code === "text-too-long" || code === "too-many-blocks") return 413;
  if (code === "parse-timeout" || code === "parse-memory" || code === "parse-failed") return 422;
  return 400;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Stands in for an open question's text when the approvals core refused the card (it may look like a secret). */
export const PREFLIGHT_WITHHELD_TEXT = "question text withheld (the inbox could not accept it; it may look like a secret), see the project page";

/**
 * The pre-flight with every spec-derived question text replaced by {@link PREFLIGHT_WITHHELD_TEXT}. The fixed
 * budget and public-URL texts, the defaults and the secret NAMES (`[A-Z][A-Z0-9_]*`, never a value) stay.
 */
export function withholdPreflightText(items: readonly PreflightItem[]): PreflightItem[] {
  return items.map((i) => (i.kind === "decision" && i.text !== BUDGET_TEXT && i.text !== PUBLIC_URL_TEXT ? { ...i, text: PREFLIGHT_WITHHELD_TEXT } : { ...i }));
}

/**
 * The requirements card. Off continuous-run mode it has no spec text: only counts and the version. In continuous-run
 * mode (ADR-0012 CR-a) it also carries the pre-flight line, whose question texts come from the spec and can trip
 * M2.3's secret check; `ensureCardFor` then retries once with `withhold` (question texts replaced).
 */
export function requirementsCard(
  projectId: string,
  docVersion: number,
  a: Analysis,
  preflight?: readonly PreflightItem[] | null,
  opts: { withhold?: boolean } = {},
): RequirementsCard {
  const by = { must: 0, should: 0, could: 0 };
  for (const r of a.requirements) by[r.priority] += 1;
  const proposed = a.requirements.filter((r) => r.proposed).length;
  const lines = [
    `${a.requirements.length} requirements (${by.must} must, ${by.should} should, ${by.could} could), ${a.milestones.length} milestones, ${a.openQuestions.length} open questions.`,
    proposed > 0 ? `${proposed} requirements were proposed by the model from spec text; check them before approving.` : null,
    `Approving accepts ${REPO_PATH} version ${docVersion} as the plan the build follows. Rejecting keeps it as a draft for a revised spec.`,
  ].filter((l): l is string => l !== null);
  if (preflight) {
    // ADR-0012 CR-a: the one intake card carries the pre-flight; action and target stay as they are.
    const room = CARD_REASON_MAX - lines.join("\n").length - 1;
    const line = preflightLine(opts.withhold ? withholdPreflightText(preflight) : preflight, room);
    if (line) lines.push(line);
  }
  return {
    gate: "requirements",
    action: "requirements.approve",
    target: `project ${projectId} ${REPO_PATH} v${docVersion}`,
    reason: lines.join("\n"),
    projectId,
  };
}

export class RequirementsPipeline {
  private readonly now: () => Date;
  private readonly ingest: (bytes: Uint8Array, name: string) => Promise<IngestResult>;
  constructor(private readonly ports: PipelinePorts) {
    this.now = ports.now ?? (() => new Date());
    this.ingest = ports.ingest ?? ((b, n) => defaultIngest(b, n));
  }

  /** DEVOS-176: the setting at call time; absent → on, a failed read → "unreadable" (off). Only `true` turns it on. */
  private async modelPassOn(): Promise<boolean | "unreadable"> {
    if (!this.ports.modelPassOn) return true;
    try {
      return (await this.ports.modelPassOn()) === true;
    } catch {
      return "unreadable";
    }
  }

  async submitSpec(projectId: string, input: SpecInput): Promise<SubmitResult> {
    if (typeof projectId !== "string" || !UUID.test(projectId)) throw new PipelineError("invalid-input");
    const project = await this.ports.store.project(projectId);
    if (!project) throw new PipelineError("project-not-found", 404);
    if (!OPEN_STAGES.has(project.stage)) throw new PipelineError("project-not-in-intake", 409);
    // Cheap pre-check; saveAnalysis re-checks under the project lock.
    const prior = await this.ports.store.latestDoc(projectId);
    if (prior?.status === "approved") throw new PipelineError("requirements-already-approved", 409);

    let bytes: Uint8Array;
    let name: string;
    let sourceFormat: SpecSourceFormat;
    if (input?.kind === "file" && input.bytes instanceof Uint8Array && typeof input.originalName === "string") {
      bytes = input.bytes;
      name = input.originalName;
      sourceFormat = "md"; // replaced by the sniffed format below
    } else if (input?.kind === "paste" && typeof input.text === "string") {
      if (input.text.trim().length === 0) throw new PipelineError("empty-spec");
      if (input.text.length > PASTE_MAX_CHARS) throw new PipelineError("spec-too-large", 413);
      bytes = new TextEncoder().encode(input.text);
      name = "pasted-spec.md";
      sourceFormat = "paste";
    } else {
      throw new PipelineError("invalid-input");
    }

    let ingested: IngestResult;
    try {
      ingested = await this.ingest(bytes, name);
    } catch (e) {
      if (e instanceof IngestError) throw new PipelineError(e.code, ingestStatus(e.code));
      throw e;
    }
    if (sourceFormat !== "paste") sourceFormat = ingested.format;

    const warnings: PipelineWarningCode[] = [];
    let analysis = analyzeSpec(ingested.blocks);
    const passOn = this.ports.runner ? await this.modelPassOn() : false;
    // Pre-review (DEVOS-176) finding 4: a setting that could not be read skips the pass visibly, never silently.
    if (passOn === "unreadable") warnings.push("assist-failed");
    if (this.ports.runner && passOn === true) {
      try {
        const runner = this.ports.runner;
        const assisted = await assistAnalysis(ingested.blocks, analysis, (req) => runner({ ...req, projectId }));
        analysis = assisted.analysis;
        // assistAnalysis reports a failed or unusable model call as a warning instead of throwing (pre-review 1).
        if (assisted.warnings.some((w) => w.code === "model-failed" || w.code === "model-output-invalid")) warnings.push("assist-failed");
      } catch {
        // assistAnalysis reports model failures itself; anything thrown here is a bug or a cap stop. The
        // deterministic analysis still stands (it never invents a requirement).
        warnings.push("assist-failed");
      }
    }

    // ADR-0012 CR-a2: in continuous-run mode the requirements card is the one intake card. Its pre-flight list
    // replaces the separate non-technical question cards; technical questions still go to the Architect log.
    const continuous = project.continuousRun === true;
    const preflight = continuous
      ? buildPreflight(analysis, this.ports.secretNames ? await this.ports.secretNames(projectId) : [], { maxCostUsd: project.capUsd ?? 0 })
      : null;

    const ordinals = new Map(analysis.milestones.map((m) => [m.name, m.ordinal]));
    const saved = await this.ports.store.saveAnalysis({
      projectId,
      expectedStage: project.stage,
      spec: {
        sourceFormat,
        originalName: sourceFormat === "paste" ? null : ingested.specRow.originalName,
        fileSha256: ingested.sha256,
        text: ingested.text,
      },
      requirements: analysis.requirements.map((r) => ({
        key: r.key,
        title: r.title,
        priority: r.priority,
        acceptance: r.acceptance.join("\n"),
        milestoneOrdinal: r.milestone === null ? null : (ordinals.get(r.milestone) ?? null),
      })),
      milestones: analysis.milestones.map((m) => ({ ordinal: m.ordinal, name: m.name, gateName: `G${m.ordinal}` })),
      repoPath: REPO_PATH,
      ...(preflight ? { preflight } : {}),
    });

    const at = this.now();
    const markdown = renderRequirementsMd(analysis, {
      projectName: project.name,
      specVersion: saved.specVersion,
      specSha256: ingested.sha256,
      date: isoDate(at),
    });
    const meta = { projectId, specVersion: saved.specVersion };
    const plan = planQuestions(analysis, meta);
    const architectLog = renderArchitectLog(plan, { ...meta, generatedAt: isoDate(at) });

    const approvalId = await this.ensureCardFor(saved.docId, projectId, saved.docVersion, analysis, warnings, preflight);
    // Question cards never wait on the requirements card, and one failure never stops the others (DV-FR-012).
    // In continuous-run mode every card-routed question is a pre-flight item, so none is raised on its own.
    const questionCards = await raiseQuestionCards(continuous ? { ...plan, cards: [] } : plan, this.ports.raiseQuestionCard);

    return {
      specId: saved.specId,
      specVersion: saved.specVersion,
      docId: saved.docId,
      docVersion: saved.docVersion,
      approvalId,
      markdown,
      architectLog,
      counts: {
        requirements: analysis.requirements.length,
        milestones: analysis.milestones.length,
        openQuestions: analysis.openQuestions.length,
        proposed: analysis.requirements.filter((r) => r.proposed).length,
      },
      questionCards,
      preflight,
      droppedKeys: saved.droppedKeys,
      droppedMilestones: saved.droppedMilestones,
      analysisWarnings: analysis.warnings,
      warnings,
    };
  }

  private async ensureCardFor(
    docId: string,
    projectId: string,
    docVersion: number,
    analysis: Analysis,
    warnings: PipelineWarningCode[],
    preflight: readonly PreflightItem[] | null,
  ): Promise<string | null> {
    let id: string;
    try {
      ({ id } = await this.ports.raiseRequirementsCard(requirementsCard(projectId, docVersion, analysis, preflight)));
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      // Pre-review CR-a2 #1: pre-flight question text the approvals core refuses (secret-shaped, or a shape it
      // rejects) is retried once without it, as M2.2-c does for question cards. Without a pre-flight the card has
      // no spec text, so a retry would be refused the same way.
      const retry = preflight !== null && (code === "card-contains-secret" || code === "invalid-input");
      if (!retry) {
        // The doc stays a draft with no card and the result says so; submitting the spec again raises a fresh one.
        warnings.push("card-failed");
        return null;
      }
      try {
        ({ id } = await this.ports.raiseRequirementsCard(requirementsCard(projectId, docVersion, analysis, preflight, { withhold: true })));
      } catch {
        warnings.push("card-failed");
        return null;
      }
    }
    let linked = false;
    try {
      linked = await this.ports.store.linkApproval(docId, id);
    } catch {
      // The spec is already stored; a link failure must not stop the question cards (pre-review 2).
      linked = false;
    }
    if (!linked) {
      warnings.push("card-link-failed");
      return null;
    }
    return id;
  }

  /**
   * Called after M2.3 decides a card. Only a `requirements` card linked to the project's NEWEST doc changes
   * anything: approved → the doc is approved (KK approves once). A rejected or expired card, or a card for a
   * superseded version, leaves the docs as they are.
   */
  async applyDecision(
    card: { id: string; gate: string; status: string },
    /** KK's comments on the card, oldest first (ADR-0012 CR-a2: `PF-<n>: <answer>` lines). */
    comments: readonly string[] = [],
  ): Promise<"approved" | "rejected" | "ignored"> {
    if (card.gate !== "requirements") return "ignored";
    if (card.status === "rejected") {
      // ADR-0012 rule 4: a rejected intake card closes the build until a new spec version re-opens it.
      const doc = await this.ports.store.docForApproval(card.id);
      if (!doc || doc.status !== "draft" || !doc.preflight || !this.ports.store.rejectPreflight) return "ignored";
      return (await this.ports.store.rejectPreflight(doc.id)) ? "rejected" : "ignored";
    }
    if (card.status !== "approved") return "ignored";
    const doc = await this.ports.store.docForApproval(card.id);
    if (!doc || doc.status !== "draft") return "ignored";
    // ADR-0012 rule 3: every decision item gets KK's answer or its default, written with the approval.
    const decisions = doc.preflight ? { approvalId: card.id, rows: preflightDecisions(doc.preflight, comments) } : undefined;
    return (await this.ports.store.approveDoc(doc.id, decisions)) ? "approved" : "ignored";
  }

  /**
   * DEVOS-204 (ADR-0012 rule 3, last sentence): KK's comments on an approved intake card made after it was decided
   * re-answer pre-flight items. `comments` are all of the card's comments, oldest first; only those created after
   * `decidedAt` count (the approval counted the rest), so the result does not depend on when the sync ran. Returns
   * the number of rows computed (the store skips any already written), or null when nothing applies.
   */
  async applyReanswers(
    card: { id: string; gate: string; status: string; decidedAt: Date | null },
    comments: readonly { id: string; body: string; createdAt: Date }[],
    seenUpTo: Date | null,
  ): Promise<number | null> {
    const store = this.ports.store;
    if (card.gate !== "requirements" || card.status !== "approved" || !card.decidedAt) return null;
    if (!store.approvalDecisions || !store.recordReanswers) return null;
    const doc = await store.docForApproval(card.id);
    if (!doc || doc.status !== "approved" || !doc.preflight) return null;
    const decidedAt = card.decidedAt.getTime();
    const later = comments.filter((c) => c.createdAt.getTime() > decidedAt);
    const rows = preflightReanswers(doc.preflight, await store.approvalDecisions(card.id), later);
    return (await store.recordReanswers(doc.id, rows, seenUpTo)) ? rows.length : null;
  }
}

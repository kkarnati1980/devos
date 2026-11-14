// M2.2-d3c2 (docs/modules/M2.2.md, "M2.2-d3c — Behaviour" item 4): after a new spec version, the superseded
// version's pending requirements card and its pending question cards are expired through the M2.3 core
// (`Approvals.expireCardsById`, DEVOS-164), and a requirements card the store could not link is expired at once.
// Tasks those cards block stay blocked, as for age expiry. Expiry is best-effort: it never fails a submission.
import { REPO_PATH, RequirementsPipeline, type PipelinePorts, type SpecInput, type SubmitResult } from "@devos/analyst";
import { EXPIRE_IDS_MAX } from "./approvals.js";

/** Pending cards read per project for one expiry pass (bounded read, ADR-0011 §9). */
export const PENDING_SCAN_MAX = 1000;

/**
 * The longest one approvals-store write can take, from the call to its commit or rollback, for a store built with
 * `timeoutMs` (Codex PR88-r5): `PrismaApprovalStore` hands every transaction `{ maxWait: timeoutMs, timeout: timeoutMs }`,
 * so a write may wait up to `maxWait` for a connection and then run up to `timeout`. The project hold reserves this
 * whole bound. Given the store, this reads `PrismaApprovalStore.stepBoundMs` (DEVOS-185), which is built from the
 * options its transactions really get. The number form is kept for AT-E10, and the DEVOS-185 test checks that it agrees
 * with the store.
 */
export function approvalStepBoundMs(timeoutMsOrStore: number | { readonly stepBoundMs: number }): number {
  // DEVOS-185: given the store, its own `stepBoundMs` (built from the options its transactions really get) is used.
  if (typeof timeoutMsOrStore === "object" && timeoutMsOrStore !== null) return timeoutMsOrStore.stepBoundMs;
  return timeoutMsOrStore + timeoutMsOrStore;
}
const PAGE = 100;
/** The analyst's question-card targets (packages/analyst route.ts); other `decision` cards are never touched. */
const QUESTION_TARGET = /^spec-(?:acceptance|question):/;
const REQUIREMENTS_ACTION = "requirements.approve";

export interface PendingCard {
  id: string;
  gate: string;
  action: string;
  target: string;
  projectId: string | null;
  createdAt: Date;
}

/** The slice of the M2.3 approval store this pass reads (ApprovalStore satisfies it). */
export interface PendingCardLister {
  list(filter: { status: "pending"; projectId: string; cursor?: string; limit: number }): Promise<PendingCard[]>;
}

export interface ExpiryDeps {
  latestDoc(projectId: string): Promise<{ id: string; version: number; approvalId: string | null } | null>;
  cards: PendingCardLister;
  /** `Approvals.expireCardsById`: returns the ids it expired. */
  expire(ids: readonly string[], reason: string): Promise<string[]>;
  /**
   * Runs the pass so that no newer version can be saved meanwhile (`PrismaRequirementsStore.withProjectHeld`;
   * Codex PR88-r1). `assertHeld` is called before every expiry write and throws once the hold could lapse during
   * that write (Codex PR88-r4). Without it (in-memory tests) the pass runs as is.
   */
  serialize?<T>(projectId: string, fn: (assertHeld: () => void) => Promise<T>): Promise<T>;
}

export interface ExpiryResult {
  /** Requirements cards of this or an earlier version that are not the newest doc's card. */
  requirements: string[];
  /** Pending analyst question cards that the new version did not raise or reuse. */
  questions: string[];
  /** Why a part was skipped, as a fixed code (never a message). */
  skipped: ("newer-version" | "question-raise-failed")[];
}

/** `project <id> docs/requirements.md v<N>` (packages/analyst pipeline.ts `requirementsCard`) → N, else null. */
export function requirementsCardVersion(target: string, projectId: string): number | null {
  const prefix = `project ${projectId} ${REPO_PATH} v`;
  if (!target.startsWith(prefix)) return null;
  const v = target.slice(prefix.length);
  return /^[1-9]\d{0,8}$/.test(v) ? Number(v) : null;
}

async function pendingCards(cards: PendingCardLister, projectId: string): Promise<PendingCard[]> {
  const out: PendingCard[] = [];
  let cursor: string | undefined;
  while (out.length < PENDING_SCAN_MAX) {
    const page = await cards.list({ status: "pending", projectId, cursor, limit: Math.min(PAGE, PENDING_SCAN_MAX - out.length) });
    out.push(...page);
    if (page.length === 0 || page.length < PAGE) break;
    cursor = page[page.length - 1]!.id;
  }
  return out;
}

async function expireAll(deps: ExpiryDeps, ids: string[], reason: string, assertHeld: () => void): Promise<string[]> {
  const done: string[] = [];
  for (let i = 0; i < ids.length; i += EXPIRE_IDS_MAX) {
    assertHeld();
    done.push(...(await deps.expire(ids.slice(i, i + EXPIRE_IDS_MAX), reason)));
  }
  return done;
}

/**
 * One expiry pass for the submission `r` of `projectId`, which started at `startedAt`.
 * - Requirements cards: every pending `requirements.approve` card of the project for a version below the newest doc's
 *   version (superseded), and, when this submission's doc is the newest, every other card for that version (this
 *   version's card when it could not be linked). The newest doc's linked card, and any card for the newest version
 *   while that version belongs to another (concurrent) submission, are never touched. So an older submission that
 *   raises its card after a newer one has run still expires its own card (pre-review 1).
 * - Question cards: only when this submission's doc is the newest (else `newer-version`). Pending analyst question
 *   cards of the project created up to `startedAt` that this submission did not raise or reuse. Skipped when any of
 *   this submission's question cards failed to raise, because the older pending card may then still be the only card
 *   for that open question. Cards created during the submission belong to this or a concurrent submission and are
 *   left alone; any a concurrent older submission leaves pending are expired by the next submission's pass.
 */
export function expireSuperseded(deps: ExpiryDeps, projectId: string, r: SubmitResult, startedAt: Date): Promise<ExpiryResult> {
  // The newest-version check and the expiry are one step: while the project row is held no newer submission can
  // save, so a card a newer version would reuse is never expired after the check (Codex PR88-r1). A newer version
  // saved after the pass raises its questions afresh, because the core reuses only pending twins.
  const pass = (assertHeld: () => void) => expirePass(deps, projectId, r, startedAt, assertHeld);
  return deps.serialize ? deps.serialize(projectId, pass) : pass(() => undefined);
}

async function expirePass(deps: ExpiryDeps, projectId: string, r: SubmitResult, startedAt: Date, assertHeld: () => void): Promise<ExpiryResult> {
  const result: ExpiryResult = { requirements: [], questions: [], skipped: [] };
  const latest = await deps.latestDoc(projectId);
  if (!latest) return result;
  const newest = latest.id === r.docId;
  const pending = (await pendingCards(deps.cards, projectId)).filter((c) => c.projectId === projectId);
  const superseded: string[] = [];
  const unlinked: string[] = [];
  for (const c of pending) {
    if (c.gate !== "requirements" || c.action !== REQUIREMENTS_ACTION || c.id === latest.approvalId) continue;
    const v = requirementsCardVersion(c.target, projectId);
    if (v === null) continue;
    if (v < latest.version) superseded.push(c.id);
    else if (newest && v === latest.version) unlinked.push(c.id);
  }
  if (superseded.length) result.requirements.push(...(await expireAll(deps, superseded, `Superseded: requirements v${latest.version} is the newest version`, assertHeld)));
  if (unlinked.length) result.requirements.push(...(await expireAll(deps, unlinked, `Not linked: this card could not be linked to requirements v${latest.version}`, assertHeld)));

  if (!newest) {
    result.skipped.push("newer-version");
    return result;
  }
  if (r.questionCards.failed.length) {
    result.skipped.push("question-raise-failed");
    return result;
  }
  const keep = new Set(r.questionCards.raised.map((q) => q.cardId));
  const qIds = pending
    .filter((c) => c.gate === "decision" && QUESTION_TARGET.test(c.target) && !keep.has(c.id) && c.createdAt.getTime() <= startedAt.getTime())
    .map((c) => c.id);
  if (qIds.length) result.questions = await expireAll(deps, qIds, `Superseded: the question is not in requirements v${r.docVersion}`, assertHeld);
  return result;
}

export type ExpiryLog = (entry: { level: "warn"; msg: "requirements-expiry-failed"; projectId: string }) => void;

export type ExpiringSubmitResult = SubmitResult & { expired: ExpiryResult | null };

/**
 * The M2.2-d1 pipeline with an expiry pass after each submission. A failed pass is logged with a fixed code (never
 * the message) and the submission still succeeds with `expired: null`; the next submission's pass retries it.
 */
export class ExpiringRequirementsPipeline extends RequirementsPipeline {
  constructor(
    ports: PipelinePorts,
    private readonly expiry: ExpiryDeps,
    private readonly log: ExpiryLog = () => {},
    private readonly clock: () => Date = () => new Date(),
  ) {
    super(ports);
  }

  override async submitSpec(projectId: string, input: SpecInput): Promise<ExpiringSubmitResult> {
    const startedAt = this.clock();
    const r = await super.submitSpec(projectId, input);
    let expired: ExpiryResult | null = null;
    try {
      expired = await expireSuperseded(this.expiry, projectId, r, startedAt);
    } catch {
      this.log({ level: "warn", msg: "requirements-expiry-failed", projectId });
    }
    return { ...r, expired };
  }
}

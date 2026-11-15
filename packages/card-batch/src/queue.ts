// CR-b2a (DEVOS-214, docs/modules/ADR-0012.md "CR-b split", Behaviour 7–10, Interface): queueQuestion, flushBatch and
// applyBatch over store and card ports, with an in-memory store. The Postgres store, its migration, the advisory
// lock and the API wiring are CR-b2b; they implement these same ports.
import { batchAnswers, batchCard, batchReason, batchable, istDay } from "./index.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Same control set as index.ts / M2.3 ONE_LINE: a queued question is one line (Interface: `text` one line).
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]");
export const QUESTION_TEXT_MAX = 1000;
export const QUESTION_DEFAULT_MAX = 200;
export const QUESTION_SOURCE_MAX = 100;
/** Most task ids one question may block (M2.3 refuses nothing here, but one card should not block a whole build). */
export const QUESTION_BLOCKS_MAX = 50;

export interface QueuedQuestion {
  id: string;
  projectId: string;
  text: string;
  source: string;
  default: string;
  blocks: string[];
  queuedAt: Date;
  batchId: string | null;
}

export interface CardBatch {
  id: string;
  projectId: string;
  istDay: string;
  /** `refused`: M2.3 refused the card for a reason a retry cannot change (pre-review finding 1); never retried. */
  state: "raising" | "raised" | "refused";
  cardId: string | null;
  /** Runner decision (CR-b2a): when `applyBatch` handled the decided card, so the sync job applies each batch once. */
  appliedAt: Date | null;
  /** Pre-review r2 finding 1: when the caller confirmed it raised a `refused` batch's members as their own cards. */
  handedOffAt: Date | null;
  /**
   * Codex PR135-r1 finding 1: when the caller confirmed (`settle`) that it filed every follow-up of the applied
   * batch. The sync job lists raised batches with `settledAt` null, so a crash after `apply` but before the
   * follow-ups are filed leaves the batch listed, and the next tick returns the same `followUps` again.
   */
  settledAt: Date | null;
}

export interface DecisionRow {
  projectId: string;
  /** `Q-<question id>`: the provisional row and the final row of one question share it (runner decision, CR-b2a). */
  itemId: string;
  text: string;
  answer: string;
  source: "kk" | "default" | "default-provisional";
  approvalId: string | null;
}

/** The queue's store. Each method is one transaction in the Postgres store (CR-b2b). */
export interface QueueStore {
  /**
   * Inserts the question with `batchId` null and its `default-provisional` decision row (rule 7), together, unless a
   * question with that id exists; returns the stored question (a retried call is safe, pre-review r2 finding 4).
   * The stored question may belong to another project; `queueQuestion` refuses that (Codex PR135-r1 finding 2).
   */
  queue(q: QueuedQuestion, provisional: DecisionRow): Promise<QueuedQuestion>;
  /**
   * Rule 8 step 1, one transaction: the project's `raising` batch, or else its `refused` batch not yet handed off, if
   * one exists (nothing new is claimed); otherwise,
   * when questions with `batchId` null exist and the project has no batch for `day`, a new `raising` batch with id
   * `newId` whose members are exactly those questions; otherwise null.
   */
  claim(projectId: string, day: string, newId: string): Promise<CardBatch | null>;
  batch(id: string): Promise<CardBatch | null>;
  /** The batch's members in queue order (`queuedAt`, then id). */
  members(batchId: string): Promise<QueuedQuestion[]>;
  markRaised(batchId: string, cardId: string): Promise<void>;
  /** `raising` → `refused` (only from `raising`). Its members keep their `batchId`, so they never join another batch. */
  markRefused(batchId: string): Promise<void>;
  /** Sets `handedOffAt` on a `refused` batch (once). */
  markHandedOff(batchId: string, now: Date): Promise<void>;
  /**
   * Final decision rows (idempotent on approval and item) and `appliedAt`, together. True only for the call that
   * set `appliedAt` (a conditional update in Postgres), so two concurrent applies cannot both win.
   */
  apply(batchId: string, rows: readonly DecisionRow[], now: Date): Promise<boolean>;
  /** Sets `settledAt` on an applied batch (once); the batch then leaves the sync job's list. */
  markSettled(batchId: string, now: Date): Promise<void>;
  /**
   * Rule 8 step 2: runs `fn` holding the batch's lock (`pg_try_advisory_lock` on one dedicated connection in
   * Postgres), or returns `{ locked: false }` at once when another flush holds it. The lock is released after `fn`.
   */
  withBatchLock<T>(batchId: string, fn: () => Promise<T>): Promise<{ locked: true; value: T } | { locked: false }>;
  projectName(projectId: string): Promise<string | null>;
}

/** The M2.3 core and store calls the queue needs. */
export interface BatchCards {
  raiseCard(input: { gate: "decision"; action: string; target: string; reason: string; projectId: string }, blocks: readonly string[]): Promise<{ id: string }>;
  /** Newest card with this target, any status (M2.3 store listing with the DEVOS-190 target filter). */
  findByTarget(projectId: string, target: string): Promise<{ id: string } | null>;
  get(id: string): Promise<{ id: string; status: string; decidedAt?: Date | null } | null>;
  /** The card's comments, oldest first (`batchAnswers` takes the last `BQ-<n>:` line; pre-review finding 3). */
  comments(id: string): Promise<{ body: string; createdAt?: Date }[]>;
  /**
   * Pre-review finding 1: the checks M2.3's `raiseCard` would refuse for good (a secret-shaped reason, a blocked
   * task that does not exist or belongs to another project), run at queue time; returns the refusal code or null.
   */
  check?(input: { projectId: string; reason: string; blocks: readonly string[] }): Promise<string | null>;
}

/** M2.3 `ApprovalError` codes a retry of the same card cannot change (apps/api/src/approvals.ts). */
export const DETERMINISTIC_REFUSALS: readonly string[] = Object.freeze(["card-contains-secret", "invalid-input", "task-not-found", "task-other-project"]);

export class QueueError extends Error {
  constructor(public readonly code: "not-batchable" | "invalid-input" | "project-not-found" | "id-conflict", public readonly hit?: string) {
    super(code);
  }
}

function line(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length >= 1 && s.length <= max && !CONTROL.test(s) ? s : null;
}

export interface QueueInput {
  gate: unknown;
  text: unknown;
  default: unknown;
  /** Optional caller-chosen question id (UUID): a retry with the same id returns the stored question. */
  id?: unknown;
  source?: unknown;
  blocks?: unknown;
}

export class CardBatchQueue {
  constructor(
    private readonly store: QueueStore,
    private readonly cards: BatchCards,
    private readonly newId: () => string,
  ) {}

  /**
   * Rule 6 and 7: stores a non-urgent `decision` question with its default and the tasks it blocks, and records the
   * default as `default-provisional` (those tasks keep running on it until the flush). Anything rule 6 refuses
   * throws `not-batchable`, and the caller raises its card at once.
   */
  async queueQuestion(projectId: string, input: QueueInput, now: Date): Promise<QueuedQuestion> {
    if (!UUID.test(String(projectId))) throw new QueueError("invalid-input");
    const verdict = batchable({ gate: input?.gate, text: input?.text, default: input?.default });
    if (!verdict.ok) throw new QueueError("not-batchable", verdict.hit);
    const text = line(input.text, QUESTION_TEXT_MAX);
    const dflt = line(input.default, QUESTION_DEFAULT_MAX);
    const source = input.source === undefined ? "runner" : line(input.source, QUESTION_SOURCE_MAX);
    const blocks = input.blocks === undefined ? [] : input.blocks;
    if (!text || !dflt || !source || !Array.isArray(blocks) || blocks.length > QUESTION_BLOCKS_MAX) throw new QueueError("invalid-input");
    if (blocks.some((t) => typeof t !== "string" || !UUID.test(t))) throw new QueueError("invalid-input");
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new QueueError("invalid-input");
    if (input.id !== undefined && (typeof input.id !== "string" || !UUID.test(input.id))) throw new QueueError("invalid-input");
    if ((await this.store.projectName(projectId)) === null) throw new QueueError("project-not-found");
    const q: QueuedQuestion = { id: (input.id as string | undefined) ?? this.newId(), projectId, text, source, default: dflt, blocks: [...new Set(blocks as string[])], queuedAt: now, batchId: null };
    // Pre-review finding 1: a question M2.3 would refuse in any card is refused here, so the caller raises it at once
    // (and sees the refusal) instead of it stalling a batch.
    if (this.cards.check && (await this.cards.check({ projectId, reason: batchReason([q]), blocks: q.blocks }))) throw new QueueError("not-batchable", "card");
    const stored = await this.store.queue(q, { projectId, itemId: `Q-${q.id}`, text, answer: dflt, source: "default-provisional", approvalId: null });
    // Codex PR135-r1 finding 2: idempotency is scoped to the project. An id already used by another project is
    // refused, and nothing of that project's question is returned.
    if (stored.projectId !== projectId) throw new QueueError("id-conflict");
    return stored;
  }

  /**
   * Rule 8: claims at most one batch per project per IST day, then raises its card under the batch lock. Returns
   * what happened: `none` (nothing to claim), `busy` (another flush holds the lock), `raised` or `recorded` (a card
   * an earlier attempt created was found by target), or `already` (the row was already raised). A `raiseCard`
   * failure is rethrown with the batch left `raising` (rule 10); the next flush retries exactly that card. A refusal
   * no retry can change (DETERMINISTIC_REFUSALS) returns `refused` with the members instead, for the caller to raise.
   */
  async flushBatch(
    projectId: string,
    now: Date,
  ): Promise<{ outcome: "none" | "busy" | "already" | "raised" | "recorded" | "refused"; batchId?: string; cardId?: string; code?: string; members?: QueuedQuestion[] }> {
    const claimed = await this.store.claim(projectId, istDay(now), this.newId());
    if (!claimed) return { outcome: "none" };
    const batchId = claimed.id;
    const held = await this.store.withBatchLock(batchId, async () => {
      const row = await this.store.batch(batchId);
      if (!row) return { outcome: "none" as const };
      // Pre-review r2 finding 1: a refused batch is returned on every flush until the caller confirms the hand-off
      // (`handOff`), so a crash between the refusal and the individual cards never loses its questions.
      if (row.state === "refused" && !row.handedOffAt) return { outcome: "refused" as const, batchId, code: "refused", members: await this.store.members(batchId) };
      if (row.state !== "raising") return { outcome: "already" as const, batchId, cardId: row.cardId ?? undefined };
      // M2.3 refuses `*` in an action (pre-review finding 1); the name is only a label here.
      const name = ((await this.store.projectName(projectId)) ?? "").replace(/\*/g, "").trim() || "this project";
      const card = batchCard(name, batchId);
      const found = await this.cards.findByTarget(projectId, card.target);
      if (found) {
        await this.store.markRaised(batchId, found.id);
        return { outcome: "recorded" as const, batchId, cardId: found.id };
      }
      const members = await this.store.members(batchId);
      const blocks = [...new Set(members.flatMap((m) => m.blocks))];
      let raised: { id: string };
      try {
        raised = await this.cards.raiseCard({ ...card, reason: batchReason(members), projectId }, blocks);
      } catch (e) {
        // Pre-review finding 1: a refusal a retry cannot change parks the batch as `refused` (so the project's next
        // day can batch again) and hands its members back; the caller raises each as its own card at once.
        const code = (e as { code?: unknown })?.code;
        if (typeof code === "string" && DETERMINISTIC_REFUSALS.includes(code)) {
          await this.store.markRefused(batchId);
          return { outcome: "refused" as const, batchId, code, members };
        }
        throw e;
      }
      await this.store.markRaised(batchId, raised.id);
      return { outcome: "raised" as const, batchId, cardId: raised.id };
    });
    return held.locked ? held.value : { outcome: "busy", batchId };
  }

  /**
   * Rule 9, for a `raised` batch whose card is decided: on approval, one final `project_decision` row per member
   * (`kk` from a `BQ-<n>:` line of KK's comments, else `default`); on rejection, no rows (M2.3 keeps the card's
   * blockers, so the tasks stay blocked). Either way the batch is marked applied; `first` is true only for the call
   * that did (pre-review finding 2). `followUps` lists the questions whose answer differs from their default, with
   * their tasks, and is the same on every call: the caller files one follow-up task per question id, idempotently,
   * then calls `settle`, so neither a concurrent apply nor a crash after `apply` can duplicate or lose one (rule 7).
   * A settled batch returns `settled`.
   */
  async applyBatch(
    batchId: string,
    now: Date,
  ): Promise<{ outcome: "not-ready" | "settled" | "approved" | "rejected"; first: boolean; followUps: { questionId: string; answer: string; blocks: string[] }[]; stopped: string[] }> {
    const none = { first: false, followUps: [], stopped: [] };
    const row = await this.store.batch(batchId);
    if (!row || row.state !== "raised" || !row.cardId) return { outcome: "not-ready", ...none };
    if (row.settledAt) return { outcome: "settled", ...none };
    const card = await this.cards.get(row.cardId);
    // Pre-review r2 finding 2: an expired card is handled like a rejected one (M2.3 keeps its blockers too).
    if (!card || (card.status !== "approved" && card.status !== "rejected" && card.status !== "expired")) return { outcome: "not-ready", ...none };
    const members = await this.store.members(batchId);
    if (card.status !== "approved") {
      const first = await this.store.apply(batchId, [], now);
      return { outcome: "rejected", first, followUps: [], stopped: [...new Set(members.flatMap((m) => m.blocks))] };
    }
    // Pre-review finding 4: only comments made up to the decision count (as CR-a's intake card), so the answers, and
    // the follow-ups below, are the same on every call.
    const decidedAt = card.decidedAt ? card.decidedAt.getTime() : null;
    const comments = (await this.cards.comments(card.id)).filter((c) => decidedAt === null || !c.createdAt || c.createdAt.getTime() <= decidedAt).map((c) => c.body);
    const answers = batchAnswers(members, comments);
    const rows: DecisionRow[] = members.map((m, i) => ({ projectId: row.projectId, itemId: `Q-${m.id}`, text: m.text, answer: answers[i]!.answer, source: answers[i]!.source, approvalId: card.id }));
    const first = await this.store.apply(batchId, rows, now);
    const followUps = members.flatMap((m, i) => (answers[i]!.source === "kk" && answers[i]!.answer !== m.default ? [{ questionId: m.id, answer: answers[i]!.answer, blocks: [...m.blocks] }] : []));
    return { outcome: "approved", first, followUps, stopped: [] };
  }

  /**
   * Codex PR135-r1 finding 1: the caller filed every follow-up `applyBatch` returned (or there were none). Only an
   * applied batch can be settled; until then the sync job keeps listing it.
   */
  async settle(batchId: string, now: Date): Promise<void> {
    await this.store.markSettled(batchId, now);
  }

  /** The caller raised every member of a `refused` batch as its own card (M2.3 dedupes a pending twin on retry). */
  async handOff(batchId: string, now: Date): Promise<void> {
    await this.store.markHandedOff(batchId, now);
  }

}

/** In-memory QueueStore for tests and the API without a database. The lock is a per-batch flag (one process). */
export class MemoryQueueStore implements QueueStore {
  readonly questions: QueuedQuestion[] = [];
  readonly batches = new Map<string, CardBatch>();
  readonly decisions: DecisionRow[] = [];
  readonly projects = new Map<string, string>();
  private readonly locks = new Set<string>();

  addProject(id: string, name: string): void {
    this.projects.set(id, name);
  }
  async projectName(projectId: string) {
    return this.projects.get(projectId) ?? null;
  }
  async queue(q: QueuedQuestion, provisional: DecisionRow) {
    const had = this.questions.find((x) => x.id === q.id);
    if (had) return { ...had, blocks: [...had.blocks] };
    this.questions.push({ ...q, blocks: [...q.blocks] });
    this.decisions.push({ ...provisional });
    return { ...q, blocks: [...q.blocks] };
  }
  async claim(projectId: string, day: string, newId: string) {
    const raising = [...this.batches.values()].find((b) => b.projectId === projectId && (b.state === "raising" || (b.state === "refused" && !b.handedOffAt)));
    if (raising) return { ...raising };
    const open = this.questions.filter((q) => q.projectId === projectId && q.batchId === null);
    if (open.length === 0) return null;
    if ([...this.batches.values()].some((b) => b.projectId === projectId && b.istDay === day)) return null;
    const b: CardBatch = { id: newId, projectId, istDay: day, state: "raising", cardId: null, appliedAt: null, handedOffAt: null, settledAt: null };
    this.batches.set(newId, b);
    for (const q of open) q.batchId = newId;
    return { ...b };
  }
  async batch(id: string) {
    const b = this.batches.get(id);
    return b ? { ...b } : null;
  }
  async members(batchId: string) {
    return this.questions
      .filter((q) => q.batchId === batchId)
      .sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((q) => ({ ...q, blocks: [...q.blocks] }));
  }
  async markRaised(batchId: string, cardId: string) {
    const b = this.batches.get(batchId);
    if (b && b.state === "raising") Object.assign(b, { state: "raised", cardId });
  }
  async markRefused(batchId: string) {
    const b = this.batches.get(batchId);
    if (b && b.state === "raising") b.state = "refused";
  }
  async markHandedOff(batchId: string, now: Date) {
    const b = this.batches.get(batchId);
    if (b && b.state === "refused" && !b.handedOffAt) b.handedOffAt = now;
  }
  async apply(batchId: string, rows: readonly DecisionRow[], now: Date) {
    const b = this.batches.get(batchId);
    if (!b || b.appliedAt) return false;
    for (const r of rows) if (!this.decisions.some((d) => d.approvalId === r.approvalId && d.itemId === r.itemId)) this.decisions.push({ ...r });
    b.appliedAt = now;
    return true;
  }
  async markSettled(batchId: string, now: Date) {
    const b = this.batches.get(batchId);
    if (b && b.appliedAt && !b.settledAt) b.settledAt = now;
  }
  async withBatchLock<T>(batchId: string, fn: () => Promise<T>): Promise<{ locked: true; value: T } | { locked: false }> {
    if (this.locks.has(batchId)) return { locked: false };
    this.locks.add(batchId);
    try {
      return { locked: true, value: await fn() };
    } finally {
      this.locks.delete(batchId);
    }
  }
}

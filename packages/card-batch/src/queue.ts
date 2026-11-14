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
  state: "raising" | "raised";
  cardId: string | null;
  /** Runner decision (CR-b2a): when `applyBatch` handled the decided card, so the sync job applies each batch once. */
  appliedAt: Date | null;
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
  /** Inserts the question with `batchId` null and its `default-provisional` decision row (rule 7), together. */
  queue(q: QueuedQuestion, provisional: DecisionRow): Promise<void>;
  /**
   * Rule 8 step 1, one transaction: the project's `raising` batch if one exists (nothing new is claimed); otherwise,
   * when questions with `batchId` null exist and the project has no batch for `day`, a new `raising` batch with id
   * `newId` whose members are exactly those questions; otherwise null.
   */
  claim(projectId: string, day: string, newId: string): Promise<CardBatch | null>;
  batch(id: string): Promise<CardBatch | null>;
  /** The batch's members in queue order (`queuedAt`, then id). */
  members(batchId: string): Promise<QueuedQuestion[]>;
  markRaised(batchId: string, cardId: string): Promise<void>;
  /** Final decision rows (idempotent on approval and item) and `appliedAt`, together. */
  apply(batchId: string, rows: readonly DecisionRow[], now: Date): Promise<void>;
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
  get(id: string): Promise<{ id: string; status: string } | null>;
  comments(id: string): Promise<{ body: string }[]>;
}

export class QueueError extends Error {
  constructor(public readonly code: "not-batchable" | "invalid-input" | "project-not-found", public readonly hit?: string) {
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
    if ((await this.store.projectName(projectId)) === null) throw new QueueError("project-not-found");
    const q: QueuedQuestion = { id: this.newId(), projectId, text, source, default: dflt, blocks: [...new Set(blocks as string[])], queuedAt: now, batchId: null };
    await this.store.queue(q, { projectId, itemId: `Q-${q.id}`, text, answer: dflt, source: "default-provisional", approvalId: null });
    return q;
  }

  /**
   * Rule 8: claims at most one batch per project per IST day, then raises its card under the batch lock. Returns
   * what happened: `none` (nothing to claim), `busy` (another flush holds the lock), `raised` or `recorded` (a card
   * an earlier attempt created was found by target), or `already` (the row was already raised). A `raiseCard`
   * failure is rethrown with the batch left `raising` (rule 10); the next flush retries exactly that card.
   */
  async flushBatch(projectId: string, now: Date): Promise<{ outcome: "none" | "busy" | "already" | "raised" | "recorded"; batchId?: string; cardId?: string }> {
    const claimed = await this.store.claim(projectId, istDay(now), this.newId());
    if (!claimed) return { outcome: "none" };
    const batchId = claimed.id;
    const held = await this.store.withBatchLock(batchId, async () => {
      const row = await this.store.batch(batchId);
      if (!row) return { outcome: "none" as const };
      if (row.state === "raised") return { outcome: "already" as const, batchId, cardId: row.cardId ?? undefined };
      const name = (await this.store.projectName(projectId)) ?? "this project";
      const card = batchCard(name, batchId);
      const found = await this.cards.findByTarget(projectId, card.target);
      if (found) {
        await this.store.markRaised(batchId, found.id);
        return { outcome: "recorded" as const, batchId, cardId: found.id };
      }
      const members = await this.store.members(batchId);
      const blocks = [...new Set(members.flatMap((m) => m.blocks))];
      const raised = await this.cards.raiseCard({ ...card, reason: batchReason(members), projectId }, blocks);
      await this.store.markRaised(batchId, raised.id);
      return { outcome: "raised" as const, batchId, cardId: raised.id };
    });
    return held.locked ? held.value : { outcome: "busy", batchId };
  }

  /**
   * Rule 9, for a `raised` batch whose card is decided: on approval, one final `project_decision` row per member
   * (`kk` from a `BQ-<n>:` line of KK's comments, else `default`); on rejection, no rows (M2.3 keeps the card's
   * blockers, so the tasks stay blocked). Either way the batch is marked applied, once. `followUps` lists the
   * questions whose answer differs from their default, with their tasks (rule 7: the caller files a follow-up task).
   */
  async applyBatch(batchId: string, now: Date): Promise<{ outcome: "not-ready" | "already" | "approved" | "rejected"; followUps: { questionId: string; answer: string; blocks: string[] }[]; stopped: string[] }> {
    const none = { followUps: [], stopped: [] };
    const row = await this.store.batch(batchId);
    if (!row || row.state !== "raised" || !row.cardId) return { outcome: "not-ready", ...none };
    if (row.appliedAt) return { outcome: "already", ...none };
    const card = await this.cards.get(row.cardId);
    if (!card || (card.status !== "approved" && card.status !== "rejected")) return { outcome: "not-ready", ...none };
    const members = await this.store.members(batchId);
    if (card.status === "rejected") {
      await this.store.apply(batchId, [], now);
      return { outcome: "rejected", followUps: [], stopped: [...new Set(members.flatMap((m) => m.blocks))] };
    }
    const answers = batchAnswers(members, (await this.cards.comments(card.id)).map((c) => c.body));
    const rows: DecisionRow[] = members.map((m, i) => ({ projectId: row.projectId, itemId: `Q-${m.id}`, text: m.text, answer: answers[i]!.answer, source: answers[i]!.source, approvalId: card.id }));
    await this.store.apply(batchId, rows, now);
    const followUps = members.flatMap((m, i) => (answers[i]!.source === "kk" && answers[i]!.answer !== m.default ? [{ questionId: m.id, answer: answers[i]!.answer, blocks: [...m.blocks] }] : []));
    return { outcome: "approved", followUps, stopped: [] };
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
    this.questions.push({ ...q, blocks: [...q.blocks] });
    this.decisions.push({ ...provisional });
  }
  async claim(projectId: string, day: string, newId: string) {
    const raising = [...this.batches.values()].find((b) => b.projectId === projectId && b.state === "raising");
    if (raising) return { ...raising };
    const open = this.questions.filter((q) => q.projectId === projectId && q.batchId === null);
    if (open.length === 0) return null;
    if ([...this.batches.values()].some((b) => b.projectId === projectId && b.istDay === day)) return null;
    const b: CardBatch = { id: newId, projectId, istDay: day, state: "raising", cardId: null, appliedAt: null };
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
  async apply(batchId: string, rows: readonly DecisionRow[], now: Date) {
    const b = this.batches.get(batchId);
    if (!b || b.appliedAt) return;
    for (const r of rows) if (!this.decisions.some((d) => d.approvalId === r.approvalId && d.itemId === r.itemId)) this.decisions.push({ ...r });
    b.appliedAt = now;
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

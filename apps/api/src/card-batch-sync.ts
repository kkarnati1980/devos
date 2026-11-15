// CR-b2d (DEVOS-218, docs/modules/ADR-0012.md rules 6–10): the job that flushes and applies batches. The queue core is
// `@devos/card-batch` (CR-b2a); the Postgres store and the M2.3 binding are `card-batch-store.ts` (CR-b2b).
// Adapted from the CR-b2b WIP branch `kishore/devos-215-cr-b2b-postgres` (runner A, 14 Nov), with the CR-b2a
// review fixes: `settle` after the follow-ups, and a day-aware flush list.
import { batchAnswers, istDay, type CardBatchQueue, type DecisionRow, type QueuedQuestion } from "@devos/card-batch";
import { ApprovalError, type Approvals } from "./approvals.js";

/** Which projects have work for the job. One bounded read each (the Postgres store implements it). */
export interface BatchLister {
  /** Projects a flush on IST day `day` can act on (PrismaQueueStore.projectsToFlush). */
  projectsToFlush(day: string, limit: number): Promise<string[]>;
  /** Projects with a batch still `raising`, or refused and not handed off (retries; PrismaQueueStore). */
  projectsWithOpenBatch(limit: number): Promise<string[]>;
  /** `raised` batches not yet settled whose card is decided (PrismaQueueStore.batchesToApply). */
  batchesToApply(limit: number): Promise<string[]>;
}

/**
 * CR-b2e (DEVOS-222): the handed-off member cards KK approved whose answer is not recorded yet, and the write of that
 * answer (PrismaQueueStore). A member whose `Q-<id>` row exists for its card is never listed again.
 */
export interface MemberAnswerStore {
  memberCardsToApply(limit: number): Promise<{ question: QueuedQuestion; cardId: string }[]>;
  /** Inserts the final row once (`ON CONFLICT (approval_id, item_id) DO NOTHING`); true when this call wrote it. */
  recordMemberAnswer(row: DecisionRow): Promise<boolean>;
}

/** The instruction on a handed-off member's card: answer as on a batch card, with its one `BQ-1` line. */
export const MEMBER_CARD_HOWTO = 'To answer, comment "BQ-1: <your answer>", then approve. Approving without that line keeps the default; rejecting keeps the tasks stopped.';

/** A member card's reason: the question and its default, clipped so the instruction always fits in M2.3's 2,000. */
export function memberCardReason(text: string, dflt: string): string {
  const head = `${text} (default: ${dflt})`;
  const room = 2000 - MEMBER_CARD_HOWTO.length - 1;
  const cut = Array.from(head);
  return `${cut.length > room ? cut.slice(0, room - 1).join("") + "…" : head}\n${MEMBER_CARD_HOWTO}`;
}

export type BatchLog = (e: { level: "info" | "warn"; msg: string; projectId?: string; batchId?: string; questionId?: string; tasks?: number }) => void;

/** Runner decision (CR-b2d): the day's batches are claimed on the first tick at or after 08:00 IST, until CR-e moves it into the M4.6 report. */
export const FLUSH_HOUR_IST = 8;
const BATCH = 100;

function istHour(now: Date): number {
  return new Date(now.getTime() + 330 * 60_000).getUTCHours();
}

/** How often the job runs (runner decision: 5 min, like the analyst sweep; the daily flush fires at the first tick from 08:00 IST). */
export const CARD_BATCH_TICK_MS = 5 * 60_000;

export class CardBatchJob {
  private running = false;
  /** The IST day whose daily flush pass completed (pre-review CR-b2d r2 finding 1). */
  private flushedDay: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly queue: CardBatchQueue,
    private readonly approvals: Pick<Approvals, "raiseCard" | "store">,
    private readonly projectName: (projectId: string) => Promise<string | null>,
    private readonly lister: BatchLister & Partial<MemberAnswerStore>,
    private readonly log: BatchLog,
    readonly intervalMs: number = CARD_BATCH_TICK_MS,
  ) {}

  start(): this {
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
      this.timer.unref?.();
    }
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass: apply decided batches (any time), then flush (from 08:00 IST). Ticks never overlap; errors are logged with fixed codes. */
  async tick(now = new Date()): Promise<{ applied: number; flushed: number } | null> {
    if (this.running) return null;
    this.running = true;
    try {
      let applied = 0;
      let flushed = 0;
      for (const batchId of await this.safe(() => this.lister.batchesToApply(BATCH), "card-batch-list-failed")) {
        try {
          const r = await this.queue.applyBatch(batchId, now);
          if (r.outcome !== "approved" && r.outcome !== "rejected") continue;
          applied++;
          // Rule 7: an answer that differs from the default needs follow-up work on those tasks. M3 has no task
          // filing yet (runner decision, CR-b2d): each follow-up is logged for the Architect, keyed by question id,
          // and CR-c files it as a task. The batch is settled only after every follow-up is out, so a crash before
          // `settle` repeats the log lines on the next tick (at least once, never lost; Codex PR135-r1).
          for (const f of r.followUps) this.log({ level: "info", msg: "card-batch-follow-up", batchId, questionId: f.questionId, tasks: f.blocks.length });
          await this.queue.settle(batchId, now);
        } catch {
          this.log({ level: "warn", msg: "card-batch-apply-failed", batchId });
        }
      }
      applied += await this.applyMemberCards();
      if (istHour(now) >= FLUSH_HOUR_IST) {
        // Pre-review CR-b2d r2 finding 1: the day's batches are claimed by ONE pass, the first tick at or after
        // 08:00 IST whose list read succeeds; a question queued later waits for the next day's pass. Later ticks
        // only retry batches still `raising` or refused and not handed off (rule 10). A restart repeats the pass,
        // which claims nothing for a project that already has the day's batch (one per project per IST day).
        const day = istDay(now);
        const daily = this.flushedDay !== day;
        const ids = await this.safe(() => (daily ? this.lister.projectsToFlush(day, BATCH) : this.lister.projectsWithOpenBatch(BATCH)), "card-batch-list-failed");
        if (daily && !this.lastListFailed) this.flushedDay = day;
        for (const projectId of ids) {
          try {
            const r = await this.queue.flushBatch(projectId, now);
            if (r.outcome === "raised" || r.outcome === "recorded") flushed++;
            if (r.outcome === "refused" && r.batchId && r.members) await this.handOff(projectId, r.batchId, r.members, now);
          } catch {
            this.log({ level: "warn", msg: "card-batch-flush-failed", projectId });
          }
        }
      }
      return { applied, flushed };
    } finally {
      this.running = false;
    }
  }

  /**
   * A refused batch's members, each as its own `decision` card at once (the caller side of pre-review CR-b2a
   * finding 1). A stable target per question, looked up in any status before each raise, makes a retry raise each
   * member at most once (even after KK decided its card); the hand-off is
   * confirmed only when every member was raised, so a failure retries on the next tick.
   */
  private async handOff(projectId: string, batchId: string, members: QueuedQuestion[], now: Date): Promise<void> {
    const name = ((await this.projectName(projectId)) ?? "").replace(/\*/g, "").trim() || "this project";
    for (const m of members) {
      const card = { gate: "decision" as const, action: `Answer a build question for ${name}`.slice(0, 200), target: `question:${m.id}`, reason: memberCardReason(m.text, m.default), projectId };
      // Pre-review CR-b2d finding 1: M2.3 dedupes only a pending twin. A member raised on an earlier tick whose card KK
      // has since decided is found by target (any status) and skipped, so a retry never raises it again or
      // re-blocks tasks KK released (as rule 8's lookup for the batch card).
      const [existing] = await this.approvals.store.list({ projectId, gate: "decision", target: card.target, limit: 1 });
      if (existing) continue;
      try {
        await this.approvals.raiseCard(card, m.blocks);
      } catch (e) {
        // A transient failure (not an M2.3 refusal) stops here without the hand-off: the next tick retries, and
        // M2.3's pending-twin dedupe absorbs the members already raised.
        if (!(e instanceof ApprovalError)) throw e;
        // A blocked task that no longer exists or is in another project: the card is still raised, without blocks.
        if (e.code === "task-not-found" || e.code === "task-other-project") {
          try {
            await this.approvals.raiseCard(card, []);
            continue;
          } catch (e2) {
            if (!(e2 instanceof ApprovalError)) throw e2;
          }
        }
        // The member's own card is refused (e.g. its text): logged for the Architect, never retried forever.
        this.log({ level: "warn", msg: "card-batch-question-refused", projectId, questionId: m.id });
      }
    }
    await this.queue.handOff(batchId, now);
  }

  /**
   * CR-b2e (DEVOS-222): a handed-off member's approved card is applied like a one-question batch (rule 9): only
   * comments made up to `decidedAt` count, a `BQ-1:` line is KK's answer, else the default. The follow-up (an answer
   * that differs from the default) is logged BEFORE the row is written, so a crash in between logs it again on the
   * next tick (at least once, never lost; rule 7); once the row exists the member is not listed, so a replay writes
   * and logs nothing. A rejected or expired member card writes nothing: M2.3 keeps its tasks blocked.
   */
  private async applyMemberCards(): Promise<number> {
    const store = this.lister;
    if (typeof store.memberCardsToApply !== "function" || typeof store.recordMemberAnswer !== "function") return 0;
    let n = 0;
    let due: { question: QueuedQuestion; cardId: string }[];
    try {
      due = await store.memberCardsToApply(BATCH);
    } catch {
      this.log({ level: "warn", msg: "card-batch-list-failed" });
      return 0;
    }
    for (const { question: m, cardId } of due) {
      try {
        const card = await this.approvals.store.get(cardId);
        const decidedAt = card?.decidedAt instanceof Date ? card.decidedAt.getTime() : NaN;
        // Fail closed (as applyBatch, Codex PR135-r2): only an approved card with a valid decision time is applied.
        if (!card || card.status !== "approved" || card.target !== `question:${m.id}` || card.projectId !== m.projectId || !Number.isFinite(decidedAt)) continue;
        const comments = (await this.approvals.store.comments(cardId))
          .filter((c) => c.createdAt instanceof Date && Number.isFinite(c.createdAt.getTime()) && c.createdAt.getTime() <= decidedAt)
          .map((c) => c.body);
        const [a] = batchAnswers([m], comments);
        if (!a) continue;
        if (a.source === "kk" && a.answer !== m.default) this.log({ level: "info", msg: "card-batch-follow-up", questionId: m.id, projectId: m.projectId, tasks: m.blocks.length });
        if (await store.recordMemberAnswer({ projectId: m.projectId, itemId: `Q-${m.id}`, text: m.text, answer: a.answer, source: a.source, approvalId: cardId })) n++;
      } catch {
        this.log({ level: "warn", msg: "card-batch-apply-failed", questionId: m.id });
      }
    }
    return n;
  }

  private lastListFailed = false;

  private async safe(fn: () => Promise<string[]>, msg: string): Promise<string[]> {
    try {
      const out = await fn();
      this.lastListFailed = false;
      return out;
    } catch {
      this.lastListFailed = true;
      this.log({ level: "warn", msg });
      return [];
    }
  }
}

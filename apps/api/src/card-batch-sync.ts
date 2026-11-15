// CR-b2d (DEVOS-218, docs/modules/ADR-0012.md rules 6–10): the job that flushes and applies batches. The queue core is
// `@devos/card-batch` (CR-b2a); the Postgres store and the M2.3 binding are `card-batch-store.ts` (CR-b2b).
// Adapted from the CR-b2b WIP branch `kishore/devos-215-cr-b2b-postgres` (runner A, 14 Nov), with the CR-b2a
// review fixes: `settle` after the follow-ups, and a day-aware flush list.
import { istDay, type CardBatchQueue, type QueuedQuestion } from "@devos/card-batch";
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
    private readonly lister: BatchLister,
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
      const card = { gate: "decision" as const, action: `Answer a build question for ${name}`.slice(0, 200), target: `question:${m.id}`, reason: `${m.text} (default: ${m.default})\nApproving keeps the default.`.slice(0, 2000), projectId };
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

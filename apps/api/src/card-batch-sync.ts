// CR-b2d (DEVOS-218, docs/modules/ADR-0012.md rules 6–10): the job that flushes and applies batches. The queue core is
// `@devos/card-batch` (CR-b2a); the Postgres store and the M2.3 binding are `card-batch-store.ts` (CR-b2b).
// Adapted from the CR-b2b WIP branch `kishore/devos-215-cr-b2b-postgres` (runner A, 14 Nov), with the CR-b2a
// review fixes: `settle` after the follow-ups, and a day-aware flush list.
import { istDay, type CardBatchQueue, type QueuedQuestion } from "@devos/card-batch";
import { ApprovalError, type Approvals } from "./approvals.js";

/** One project a daily flush can act on, with the sort key the keyset cursor uses (Codex PR143-r2). */
export interface FlushRow {
  projectId: string;
  /** The project's oldest waiting item, as the store's own timestamp text (round-trips at full precision). */
  since: string;
}
/** The last row of the previous page: the next page lists only projects after it in (`since`, `projectId`) order. */
export type FlushCursor = FlushRow;

/** Which projects have work for the job. One bounded read each (the Postgres store implements it). */
export interface BatchLister {
  /** Projects a flush on IST day `day` can act on, oldest first, after `after` (PrismaQueueStore.projectsToFlush). */
  projectsToFlush(day: string, limit: number, after?: FlushCursor | null): Promise<FlushRow[]>;
  /** Projects with a batch still `raising`, or refused and not handed off (retries; PrismaQueueStore). */
  projectsWithOpenBatch(limit: number, after?: FlushCursor | null): Promise<FlushRow[]>;
  /** `raised` batches not yet settled whose card is decided (PrismaQueueStore.batchesToApply). */
  batchesToApply(limit: number): Promise<string[]>;
}

export type BatchLog = (e: { level: "info" | "warn"; msg: string; projectId?: string; batchId?: string; questionId?: string; tasks?: number }) => void;

/** Runner decision (CR-b2d): the day's batches are claimed on the first tick at or after 08:00 IST, until CR-e moves it into the M4.6 report. */
export const FLUSH_HOUR_IST = 8;
const BATCH = 100;
// Codex PR143-r1: at most this many pages of 100 in one daily pass (5,000 projects); a longer pass resumes next tick.
const FLUSH_PAGES_MAX = 50;

function istHour(now: Date): number {
  return new Date(now.getTime() + 330 * 60_000).getUTCHours();
}

/** How often the job runs (runner decision: 5 min, like the analyst sweep; the daily flush fires at the first tick from 08:00 IST). */
export const CARD_BATCH_TICK_MS = 5 * 60_000;

export class CardBatchJob {
  private running = false;
  /** The IST day whose daily flush pass completed (pre-review CR-b2d r2 finding 1). */
  private flushedDay: string | null = null;
  /**
   * Codex PR143-r3: where an unfinished daily pass stopped (its IST day and the last row read). The next tick resumes
   * after it, so a pass cut by FLUSH_PAGES_MAX moves on through the list instead of re-reading the same first pages.
   */
  private flushResume: { day: string; after: FlushCursor } | null = null;
  /**
   * Codex PR143-r4: where the last retry page ended. Each later tick reads the next page of open batches after it and
   * wraps to the start after a short page, so open batches that keep failing cannot hold the retry window forever.
   */
  private retryAfter: FlushCursor | null = null;
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
        // Codex PR143-r1/r2/r3: the daily pass drains every page of eligible projects before the day counts as flushed.
        // Pages are keyset-paginated on (`since`, `projectId`): each page starts after the previous page's last row,
        // so open batches still `raising` (which stay eligible) cannot fill every page and hide a later project. The
        // pass ends at a short page. FLUSH_PAGES_MAX bounds one tick; a pass cut by that bound keeps its cursor
        // (`flushResume`, for this IST day) and the next tick resumes after it, so every eligible project is reached
        // within ceil(n / 5,000) ticks. A failed read keeps the cursor too, and the next tick retries that page.
        // `seen` still skips a project listed twice in one tick (its key moved between reads).
        const seen = new Set<string>();
        let drained = !daily;
        let shortPage = false;
        if (this.flushResume && this.flushResume.day !== day) this.flushResume = null;
        let after: FlushCursor | null = daily ? (this.flushResume?.after ?? null) : this.retryAfter;
        for (let page = 0; page < (daily ? FLUSH_PAGES_MAX : 1); page++) {
          const cursor: FlushCursor | null = after;
          const rows: FlushRow[] = await this.safe(
            async () => (daily ? this.lister.projectsToFlush(day, BATCH, cursor) : this.lister.projectsWithOpenBatch(BATCH, cursor)),
            "card-batch-list-failed",
          );
          if (this.lastListFailed) break;
          for (const { projectId } of rows) {
            if (seen.has(projectId)) continue;
            seen.add(projectId);
            try {
              const r = await this.queue.flushBatch(projectId, now);
              if (r.outcome === "raised" || r.outcome === "recorded") flushed++;
              if (r.outcome === "refused" && r.batchId && r.members) await this.handOff(projectId, r.batchId, r.members, now);
            } catch {
              this.log({ level: "warn", msg: "card-batch-flush-failed", projectId });
            }
          }
          if (rows.length < BATCH) { drained = true; shortPage = true; break; }
          after = rows[rows.length - 1]!;
        }
        if (daily) this.flushResume = drained ? null : after ? { day, after } : this.flushResume;
        // A retry tick reads one page: a full page moves the window on, a short page wraps it to the start (r4).
        else if (!this.lastListFailed) this.retryAfter = shortPage ? null : after;
        if (daily && drained) this.flushedDay = day;
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

  private async safe<T>(fn: () => Promise<T[]>, msg: string): Promise<T[]> {
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

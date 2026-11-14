// CR-b2b (DEVOS-215, docs/modules/ADR-0012.md rules 6–10): the M2.3 binding of the batched-question core and the
// job that flushes and applies batches. The queue core is `@devos/card-batch` (CR-b2a); the store is
// `card-batch-store.ts`.
import { CardBatchQueue, type BatchCards, type QueuedQuestion } from "@devos/card-batch";
import { ApprovalError, parseCard, type Approvals, type ApprovalStore } from "./approvals.js";

/** The batch card port over the M2.3 core (raise, with its pending-twin dedupe) and store (lookup, comments). */
export function batchCardsFrom(approvals: Pick<Approvals, "raiseCard">, store: Pick<ApprovalStore, "list" | "get" | "comments">): BatchCards {
  return {
    raiseCard: async (input, blocks) => ({ id: (await approvals.raiseCard(input, blocks)).id }),
    // DEVOS-190's exact target filter; newest first, any status, so a decided card is found too (rule 8).
    findByTarget: async (projectId, target) => {
      const [c] = await store.list({ projectId, gate: "decision", target, limit: 1 });
      return c ? { id: c.id } : null;
    },
    get: async (id) => {
      const c = await store.get(id);
      return c ? { id: c.id, status: c.status, decidedAt: c.decidedAt } : null;
    },
    // M2.3 lists comments oldest first (createdAt, then id).
    comments: async (id) => (await store.comments(id)).map((c) => ({ body: c.body, createdAt: c.createdAt })),
    // Pre-review CR-b2a finding 1: M2.3's own card check (secret-shaped text, lengths, control characters) at queue
    // time. Task existence is checked by M2.3 at raise; a refusal there parks the batch (`refused`).
    check: async ({ projectId, reason }) => {
      const r = parseCard({ gate: "decision", action: "Answer the build questions", target: "batch:check", reason, projectId });
      return typeof r === "string" ? r : null;
    },
  };
}

/** Which projects have work for the job. One bounded read each (the Postgres store implements it). */
export interface BatchLister {
  /** Projects with a question waiting for a batch, a `raising` batch, or a `refused` batch not yet handed off. */
  projectsToFlush(limit: number): Promise<string[]>;
  /** `raised` batches with `applied_at` null whose card is decided or expired. */
  batchesToApply(limit: number): Promise<string[]>;
}

export type BatchLog = (e: { level: "info" | "warn"; msg: string; projectId?: string; batchId?: string; questionId?: string; tasks?: number }) => void;

/** Runner decision (CR-b2b): the daily flush runs at the first tick at or after 08:00 IST, until CR-e moves it into the M4.6 report. */
export const FLUSH_HOUR_IST = 8;
const BATCH = 100;

function istHour(now: Date): number {
  return new Date(now.getTime() + 330 * 60_000).getUTCHours();
}

/** How often the job runs (runner decision: 5 min, like the analyst sweep; the daily flush fires at the first tick from 08:00 IST). */
export const CARD_BATCH_TICK_MS = 5 * 60_000;

export class CardBatchJob {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly queue: CardBatchQueue,
    private readonly approvals: Pick<Approvals, "raiseCard">,
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
          if (r.outcome !== "not-ready") applied++;
          // Rule 7: an answer that differs from the default needs follow-up work on those tasks. M3 has no task
          // filing yet, so it is logged once (by the winning apply) for the Architect; CR-c files it as a task.
          if (r.first) for (const f of r.followUps) this.log({ level: "info", msg: "card-batch-follow-up", batchId, questionId: f.questionId, tasks: f.blocks.length });
        } catch {
          this.log({ level: "warn", msg: "card-batch-apply-failed", batchId });
        }
      }
      if (istHour(now) >= FLUSH_HOUR_IST) {
        for (const projectId of await this.safe(() => this.lister.projectsToFlush(BATCH), "card-batch-list-failed")) {
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
   * finding 1). A stable target per question lets M2.3's pending-twin dedupe absorb a retry; the hand-off is
   * confirmed only when every member was raised, so a failure retries on the next tick.
   */
  private async handOff(projectId: string, batchId: string, members: QueuedQuestion[], now: Date): Promise<void> {
    const name = ((await this.projectName(projectId)) ?? "").replace(/\*/g, "").trim() || "this project";
    for (const m of members) {
      const card = { gate: "decision" as const, action: `Answer a build question for ${name}`.slice(0, 200), target: `question:${m.id}`, reason: `${m.text} (default: ${m.default})`.slice(0, 2000), projectId };
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

  private async safe(fn: () => Promise<string[]>, msg: string): Promise<string[]> {
    try {
      return await fn();
    } catch {
      this.log({ level: "warn", msg });
      return [];
    }
  }
}

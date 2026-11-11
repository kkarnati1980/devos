// DEVOS-77: the dead-letter view (ADR-0011 §9, M1.5 behaviour 12). Lists run jobs that failed for good
// and retries one. Both routes are `session` (deny by default); the retry passes M1.2's CSRF checks.
// A queue or store message is never returned or logged; only fixed codes leave this file.
import { Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { httpError } from "./auth.js";
import type { AuditEntry } from "./settings.js";

export const DEAD_LETTERS = Symbol("devos:dead-letters");

/** What the API needs from M1.5's `RunQueue` (structural, so the API does not compile against it). */
export interface DeadLetterQueue {
  deadLetters(limit?: number): Promise<Array<{ jobId: string; runId: string; reason: string; attemptsMade: number; failedAt: number | null }>>;
  retryDead(jobId: string): Promise<boolean>;
}

export interface DeadLetterServices {
  /** null → both routes answer 503 `dead-letters-not-configured` (no REDIS_URL or no database). */
  queue: DeadLetterQueue | null;
  /** Writes one audit event (actor kk); null → 503 `dead-letters-not-configured`. */
  audit: ((entry: AuditEntry) => Promise<void>) | null;
}

export interface DeadLetterView {
  jobId: string;
  runId: string;
  reason: string;
  attemptsMade: number;
  failedAt: string | null;
}

export const DEAD_LETTER_LIMIT = 100;
const REASON_MAX = 200;
/** Job ids are run ids (M1.5: job id = run id). Anything else is rejected before the queue sees it. */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isJobId(v: string): boolean {
  return JOB_ID.test(v);
}

/** Bounded, control-character-free text; the page escapes it again on output. */
function clean(s: string, max: number): string {
  return String(s).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

export function toView(d: { jobId: string; runId: string; reason: string; attemptsMade: number; failedAt: number | null }): DeadLetterView {
  return {
    jobId: clean(d.jobId, 128),
    runId: clean(d.runId, 128),
    reason: clean(d.reason, REASON_MAX),
    attemptsMade: Number.isInteger(d.attemptsMade) && d.attemptsMade >= 0 ? d.attemptsMade : 0,
    failedAt: typeof d.failedAt === "number" && Number.isFinite(d.failedAt) ? new Date(d.failedAt).toISOString() : null,
  };
}

async function guarded<T>(fn: () => Promise<T>, code: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Error && "getStatus" in e) throw e;
    throw httpError(503, code);
  }
}

@Controller("runs/dead-letters")
export class DeadLettersController {
  constructor(@Inject(DEAD_LETTERS) private readonly svc: DeadLetterServices) {}

  private ready(): { queue: DeadLetterQueue; audit: (entry: AuditEntry) => Promise<void> } {
    if (!this.svc.queue || !this.svc.audit) throw httpError(503, "dead-letters-not-configured");
    return { queue: this.svc.queue, audit: this.svc.audit };
  }

  /** The newest 100 jobs that failed for good: run, reason, attempts, time. */
  @Get()
  async list() {
    const { queue } = this.ready();
    const rows = await guarded(() => queue.deadLetters(DEAD_LETTER_LIMIT), "dead-letters-unavailable");
    return { deadLetters: rows.slice(0, DEAD_LETTER_LIMIT).map(toView) };
  }

  /**
   * KK's retry. The audit event is written first: if it cannot be written, nothing is retried (503).
   * Redis and Postgres cannot commit together, so a retry that then fails leaves an audit row that
   * records the request, never a retry without a record.
   */
  @Post(":jobId/retry")
  @HttpCode(200)
  async retry(@Param("jobId") jobId: string) {
    if (!isJobId(jobId)) throw httpError(400, "invalid:job-id");
    const { queue, audit } = this.ready();
    await guarded(
      () => audit({ action: "run.dead_letter.retried", summary: `Dead-lettered run job ${jobId} retried`, details: { jobId } }),
      "dead-letters-audit-error",
    );
    const ok = await guarded(() => queue.retryDead(jobId), "dead-letters-unavailable");
    if (!ok) throw httpError(404, "dead-letter-not-found");
    return { retried: jobId };
  }
}

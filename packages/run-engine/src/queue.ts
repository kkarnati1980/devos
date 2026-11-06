// The run queue (BullMQ on the server's Redis). Retryable errors back off exponentially with full
// jitter; non-retryable errors are never retried (UnrecoverableError). A job that fails for good lands
// in the dead-letter list (BullMQ's failed set), which can be listed and retried (ADR-0011 §9).
import { Queue, Worker, UnrecoverableError, type Job } from "bullmq";
import { Redis } from "ioredis";
import type { RunEngine, RunInput, RunOutcome } from "./engine.js";
import { RunFailure } from "./types.js";

export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 2_000, maxMs: 5 * 60_000 };

/** Exponential backoff with full jitter: uniform in [0, min(max, base·2^(attempt-1))]. */
export function backoffDelay(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const cap = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * cap);
}

export interface DeadLetter {
  jobId: string;
  runId: string;
  reason: string;
  attemptsMade: number;
  failedAt: number | null;
}

export interface RunQueueOptions {
  /** redis://host:port of the server's Redis (from the environment, never hard-coded). */
  redisUrl: string;
  name?: string;
  /** Total tries for a retryable failure (default 3). */
  attempts?: number;
  backoff?: BackoffPolicy;
  concurrency?: number;
  /** Deadline for each public queue operation (ms, default 10 s; ADR-0011). */
  opTimeoutMs?: number;
}

/** Reject after `ms` (the Redis call itself is abandoned; ioredis keeps the socket). */
function deadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => {
      t = setTimeout(() => reject(new Error(`queue-${label}-timeout`)), ms);
    }),
  ]);
}

/** Turn an outcome into what BullMQ should do: return, retry (throw) or fail for good. */
export function settleOutcome(outcome: RunOutcome): RunOutcome {
  if (outcome.status === "failed" && outcome.retryable) throw new RunFailure(outcome.errorType ?? "provider_error", `run-${outcome.errorType}`, true);
  if (outcome.status === "failed") throw new UnrecoverableError(`run-${outcome.errorType ?? "failed"}`);
  return outcome;
}

export class RunQueue {
  readonly queue: Queue;
  private worker: Worker | null = null;
  private readonly clients: Redis[] = [];
  private readonly attempts: number;
  private readonly backoff: BackoffPolicy;
  private readonly ms: number;

  constructor(private readonly opts: RunQueueOptions) {
    this.queue = new Queue(opts.name ?? "devos-runs", { connection: this.client() });
    this.attempts = opts.attempts ?? 3;
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.ms = opts.opTimeoutMs ?? 10_000;
  }

  /** A Redis client with bounded connect/command timeouts (ADR-0011). BullMQ needs maxRetriesPerRequest=null. */
  private client(): Redis {
    // maxRetriesPerRequest=null is required by BullMQ workers (blocking commands); every public
    // operation below has its own deadline instead.
    const c = new Redis(this.opts.redisUrl, { maxRetriesPerRequest: null, connectTimeout: 10_000 });
    this.clients.push(c);
    return c;
  }

  /** One job per run; the job id is the run id, so a run is never queued twice. */
  async enqueue(input: RunInput): Promise<string> {
    const job = await deadline(this.queue.add("run", input, {
      jobId: input.runId,
      attempts: this.attempts,
      backoff: { type: "devos-jitter" },
      removeOnComplete: 1000,
      removeOnFail: false,
    }), this.ms, "enqueue");
    return job.id!;
  }

  /** Start processing with the engine. A thrown error from the store is retried; a crash resumes. */
  start(engine: RunEngine): Worker {
    if (this.worker) return this.worker;
    const backoff = this.backoff;
    this.worker = new Worker(
      this.queue.name,
      async (job: Job<RunInput>) => {
        try {
          return settleOutcome(await engine.execute(job.data));
        } catch (e) {
          if (e instanceof RunFailure && !e.retryable) throw new UnrecoverableError(`run-${e.type}`);
          throw e;
        }
      },
      {
        connection: this.client(),
        concurrency: this.opts.concurrency ?? 1,
        settings: { backoffStrategy: (attemptsMade: number) => backoffDelay(attemptsMade, backoff) },
      },
    );
    return this.worker;
  }

  /** Dead-letter view: jobs that failed for good (attempts exhausted or non-retryable). */
  async deadLetters(limit = 100): Promise<DeadLetter[]> {
    const jobs = await deadline(this.queue.getFailed(0, Math.max(0, limit - 1)), this.ms, "dead-letters");
    return jobs.map((j) => ({
      jobId: String(j.id),
      runId: String((j.data as RunInput).runId),
      reason: String(j.failedReason ?? "").slice(0, 200),
      attemptsMade: j.attemptsMade,
      failedAt: j.finishedOn ?? null,
    }));
  }

  /** Retry one dead-lettered job (KK's dashboard action). */
  async retryDead(jobId: string): Promise<boolean> {
    return deadline(
      (async () => {
        const job = await this.queue.getJob(jobId);
        if (!job || !(await job.isFailed())) return false;
        await job.retry("failed");
        return true;
      })(),
      this.ms,
      "retry",
    );
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    for (const c of this.clients) c.disconnect();
  }
}

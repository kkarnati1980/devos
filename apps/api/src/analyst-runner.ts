// M2.2-d3b1 (docs/modules/M2.2.md, "M2.2-d3b — Behaviour"): the analyst's model pass as one M1.5 run per call.
// The run engine reserves the budget, meters each turn and records the cost; this module only creates the
// intake task and run rows, executes the run and reads its text back. Any outcome other than `succeeded` throws,
// so the pipeline keeps the deterministic analysis with `assist-failed`.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityEnvelope } from "@devos/policy";
import type { ModelRunner } from "@devos/analyst";

export const ANALYST_MODEL = "claude-sonnet-5-5";
/** One answer turn; the engine cancels a run on reaching max_turns (M1.5 §6), so the cap is one above it. */
export const ANALYST_MAX_TURNS = 2;
export const ANALYST_MAX_SECONDS = 90;
/** Per-run ceiling (runner decision); the M1.7 envelope and the project budget still bound it. */
export const ANALYST_MAX_COST_USD = 0.5;
/** Longest output read back (UTF-8 bytes); longer is refused before the M2.2-b validator sees it. */
export const ANALYST_MAX_OUTPUT_BYTES = 256 * 1024;
/** Token cap of the run's envelope (one prompt of at most ~60 000 characters plus one answer). */
export const ANALYST_MAX_TOKENS = 200_000;

/**
 * The run's M1.7 capability envelope: deny-all (no tools, no paths, no network). The prompt carries untrusted spec
 * text, so the model may only answer in text (F2/F3; pre-review finding 1). Expires with the run's own deadline.
 */
export function analystEnvelope(now: number): CapabilityEnvelope {
  return {
    tools: [], readPaths: [], writePaths: [], network: false, networkAllowList: null,
    maxCostUsd: ANALYST_MAX_COST_USD, maxTokens: ANALYST_MAX_TOKENS, maxConcurrency: 1,
    expiresAt: now + 10 * 60_000, depth: 0,
  };
}

export interface AnalystRunRows {
  /** Creates one `analysis` task and one queued `analyst` run for it; returns the run id. */
  createRun(input: {
    projectId: string;
    title: string;
    model: string;
    maxTurns: number;
    maxSeconds: number;
    maxCostUsd: number;
    envelope: CapabilityEnvelope;
  }): Promise<string>;
  /** The run's `text` event payloads, in seq order. */
  textEvents(runId: string): Promise<string[]>;
  /**
   * Closes the intake task once the call has ended, and marks the run `failed` (`analyst-run-<why>`: `abandoned`, or
   * `paused` for a paused project) if the engine left it queued or running: this run is in-process and is never
   * re-queued (pre-review finding 2). A run closed that way has its still-open budget reservation settled
   * fail-closed: charged the whole reserved amount (DEVOS-161).
   */
  finishTask(runId: string, ok: boolean, why?: string): Promise<void>;
}

/** The part of M1.5's RunEngine this module uses. */
export interface RunExecutor {
  execute(input: { runId: string; provider: "anthropic"; prompt: string; cwd: string; tag?: string }): Promise<{ status: string }>;
}

export class AnalystRunError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AnalystRunError";
  }
}

/**
 * DEVOS-171 (Codex PR102-r2): ids of analyst runs this API process is executing right now. The stale-run sweep
 * never closes one of these, whatever the timestamps say, so clock skew cannot close a live run.
 */
export const liveAnalystRuns = new Set<string>();

export function runEngineModelRunner(rows: AnalystRunRows, engine: RunExecutor, now: () => number = Date.now): ModelRunner {
  return async ({ prompt, tag, projectId }) => {
    if (!projectId) throw new AnalystRunError("analyst-run-no-project");
    const runId = await rows.createRun({
      projectId,
      title: "Analyst assist",
      model: ANALYST_MODEL,
      maxTurns: ANALYST_MAX_TURNS,
      maxSeconds: ANALYST_MAX_SECONDS,
      maxCostUsd: ANALYST_MAX_COST_USD,
      envelope: analystEnvelope(now()),
    });
    liveAnalystRuns.add(runId);
    let ok = false;
    let ended: string = "abandoned";
    let cwd: string | null = null;
    try {
      // A private, empty working directory per run, removed afterwards; never the shared temp dir. Created inside
      // the try, so a failure here still closes the task and run (pre-review round 2, finding 3).
      cwd = await mkdtemp(join(tmpdir(), "devos-analyst-"));
      // The engine's own deadlines (max_seconds, idle and result timeouts) bound this call; no retry here:
      // a paid model call is not a safe operation (ADR-0011 §9).
      const outcome = await engine.execute({ runId, provider: "anthropic", prompt, cwd, tag });
      // A paused project makes the engine return without starting or finishing the run (M1.5); record that.
      if (outcome.status === "paused") ended = "paused";
      if (outcome.status !== "succeeded") throw new AnalystRunError(`analyst-run-${outcome.status}`);
      const parts = await rows.textEvents(runId);
      let bytes = 0;
      for (const p of parts) {
        bytes += Buffer.byteLength(p, "utf8");
        if (bytes > ANALYST_MAX_OUTPUT_BYTES) throw new AnalystRunError("analyst-output-too-long");
      }
      ok = true;
      return { output: parts.join("") };
    } finally {
      // Best effort: a task left open does not change the analysis, and its run row already holds the outcome.
      await rows.finishTask(runId, ok, ended).catch(() => undefined);
      liveAnalystRuns.delete(runId);
      if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

type Tx = {
  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  task: { create(args: unknown): Promise<{ id: string }>; update(args: unknown): Promise<unknown> };
  run: { create(args: unknown): Promise<{ id: string }>; findUnique(args: unknown): Promise<{ taskId: string } | null>; updateMany(args: unknown): Promise<unknown> };
  capabilityEnvelope: { create(args: unknown): Promise<unknown> };
  costEntry: { create(args: unknown): Promise<unknown> };
  runEvent: { findMany(args: unknown): Promise<{ payload: unknown }[]> };
};
export interface AnalystRowsDb {
  $transaction<T>(fn: (tx: Tx) => Promise<T>, opts?: { timeout?: number; maxWait?: number }): Promise<T>;
}

/** The rows over Postgres. Each call is one bounded transaction (ADR-0011 §9). */
export class PrismaAnalystRunRows implements AnalystRunRows {
  constructor(private readonly db: AnalystRowsDb, private readonly timeoutMs: number) {}

  private tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(Math.floor(this.timeoutMs))}, true) AS statement_timeout`;
      return fn(tx);
    }, { timeout: this.timeoutMs, maxWait: this.timeoutMs });
  }

  createRun(input: Parameters<AnalystRunRows["createRun"]>[0]): Promise<string> {
    return this.tx(async (tx) => {
      const task = await tx.task.create({ data: { projectId: input.projectId, kind: "analysis", assignee: "agent", title: input.title, status: "running" } });
      const run = await tx.run.create({
        data: {
          taskId: task.id, projectId: input.projectId, role: "analyst", model: input.model,
          maxTurns: input.maxTurns, maxSeconds: input.maxSeconds, maxCostUsd: input.maxCostUsd.toFixed(6),
        },
      });
      const e = input.envelope;
      await tx.capabilityEnvelope.create({
        data: {
          runId: run.id, tools: e.tools, readPaths: e.readPaths, writePaths: e.writePaths, network: e.network,
          networkAllowList: e.networkAllowList, maxCostUsd: e.maxCostUsd.toFixed(6), maxTokens: e.maxTokens,
          maxConcurrency: e.maxConcurrency, expiresAt: new Date(e.expiresAt), depth: e.depth,
        },
      });
      return run.id;
    });
  }

  textEvents(runId: string): Promise<string[]> {
    return this.tx(async (tx) => {
      const rows = await tx.runEvent.findMany({ where: { runId, type: "text" }, orderBy: { seq: "asc" }, select: { payload: true } });
      return rows.map((r) => {
        const t = (r.payload as { text?: unknown } | null)?.text;
        return typeof t === "string" ? t : "";
      });
    });
  }

  finishTask(runId: string, ok: boolean, why = "abandoned"): Promise<void> {
    return this.tx(async (tx) => {
      const run = await tx.run.findUnique({ where: { id: runId }, select: { taskId: true } });
      if (!run) return;
      await tx.task.update({ where: { id: run.taskId }, data: { status: ok ? "done" : "failed" } });
      if (ok) return;
      // DEVOS-161: M1.7 moves reservation rows only under its global lock, so a decision never sees a row move
      // between its usage reads (PR13-r3). Taken before the run row, as every policy transaction takes it first.
      await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${POLICY_LOCK_KEY}))) AS l`;
      const closed = (await tx.run.updateMany({
        where: { id: runId, status: { in: ["queued", "running"] } },
        data: { status: "failed", error: `analyst-run-${why === "paused" ? "paused" : "abandoned"}`, endedAt: new Date() },
      })) as { count?: number };
      // The engine left this run open, so it threw before settling, and a reservation it made may still be
      // `reserved`. The spend is unknown, so it is settled fail-closed as M1.5 settles an orphaned attempt: the cost
      // ledger is charged the whole reservation first (less any cost the engine recorded but did not settle), then
      // the reservation is reconciled at its full amount. Only this run's still-open rows change.
      if ((closed.count ?? 0) > 0) await settleOpenReservations(tx, runId);
    });
  }
}

/** DEVOS-171: an open analyst run is stale once `max_seconds` plus this grace has passed since it started. */
export const ANALYST_STALE_GRACE_MS = 5 * 60_000;
/** Stale runs closed per sweep; the rest are reached on later sweeps (bounded work, ADR-0011 §9). */
export const ANALYST_SWEEP_BATCH = 50;
/** How often the sweep runs after its start-up pass. */
export const ANALYST_SWEEP_MS = 5 * 60_000;

/**
 * DEVOS-171: closes analyst runs that the runner could not close (the database was down when it tried), so their
 * budget reservations do not stay held. The bound is measured on the API clock (`now`), the clock M1.5 writes
 * `started_at` with (Codex PR102-r2); runs live in this process are skipped by the job (`liveAnalystRuns`).
 */
export class PrismaAnalystRunSweeper {
  constructor(private readonly db: AnalystRowsDb, private readonly timeoutMs: number, private readonly graceMs = ANALYST_STALE_GRACE_MS) {}

  private tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(Math.floor(this.timeoutMs))}, true) AS statement_timeout`;
      return fn(tx);
    }, { timeout: this.timeoutMs, maxWait: this.timeoutMs });
  }

  /** Ids of open (queued/running) analyst runs past `max_seconds` + grace, oldest first. */
  staleRunIds(limit: number = ANALYST_SWEEP_BATCH, now: number = Date.now()): Promise<string[]> {
    const graceSecs = this.graceMs / 1000;
    return this.tx(async (tx) => {
      const rows = (await tx.$queryRaw`
        SELECT id::text AS id FROM run
        WHERE role = 'analyst'::role AND status IN ('queued'::run_status, 'running'::run_status)
          AND COALESCE(started_at, created_at) + make_interval(secs => max_seconds + ${graceSecs}::float8) < ${new Date(now)}::timestamptz
        ORDER BY COALESCE(started_at, created_at), id
        LIMIT ${Math.max(1, Math.floor(limit))}::int`) as { id: string }[];
      return rows.map((r) => r.id);
    });
  }

  /**
   * Closes one stale run as `failed` (`analyst-run-stale`), fails its task and settles its open reservations
   * fail-closed (DEVOS-161's settlement), all in one transaction under M1.7's lock. The run is re-checked inside
   * that transaction, so a run that closed or is no longer stale in the meantime is left alone. Returns whether it
   * closed the run.
   */
  closeStale(runId: string, now: number = Date.now()): Promise<boolean> {
    const graceSecs = this.graceMs / 1000;
    return this.tx(async (tx) => {
      // M1.7's global lock first, as every policy transaction takes it (DEVOS-161, PR13-r3).
      await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${POLICY_LOCK_KEY}))) AS l`;
      const closed = (await tx.$queryRaw`
        UPDATE run SET status = 'failed'::run_status, error = 'analyst-run-stale', ended_at = now(), updated_at = now()
        WHERE id = ${runId}::uuid AND role = 'analyst'::role AND status IN ('queued'::run_status, 'running'::run_status)
          AND COALESCE(started_at, created_at) + make_interval(secs => max_seconds + ${graceSecs}::float8) < ${new Date(now)}::timestamptz
        RETURNING task_id::text AS task_id`) as { task_id: string }[];
      if (!closed.length) return false;
      await tx.task.update({ where: { id: closed[0]!.task_id }, data: { status: "failed" } });
      await settleOpenReservations(tx, runId);
      return true;
    });
  }
}

export type SweepLog = (entry: { level: "warn"; msg: "analyst-sweep-failed"; runId: string } | { level: "warn"; msg: "analyst-sweep-list-failed" }) => void;

/** DEVOS-171: the start-up and periodic sweep over `PrismaAnalystRunSweeper` (ticks never overlap). */
export class AnalystRunSweepJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly sweeper: Pick<PrismaAnalystRunSweeper, "staleRunIds" | "closeStale">,
    private readonly log: SweepLog,
    readonly intervalMs: number = ANALYST_SWEEP_MS,
    private readonly live: ReadonlySet<string> = liveAnalystRuns,
    private readonly now: () => number = Date.now,
  ) {}

  /** One pass; null when a pass is already running. One run's failure is logged by id (fixed code) and skipped. */
  async tick(): Promise<number | null> {
    if (this.running) return null;
    this.running = true;
    try {
      let ids: string[];
      try {
        ids = await this.sweeper.staleRunIds(ANALYST_SWEEP_BATCH, this.now());
      } catch {
        this.log({ level: "warn", msg: "analyst-sweep-list-failed" });
        return 0;
      }
      let n = 0;
      for (const id of ids) {
        // A run this process is still executing is never closed (Codex PR102-r2).
        if (this.live.has(id)) continue;
        try {
          if (await this.sweeper.closeStale(id, this.now())) n++;
        } catch {
          this.log({ level: "warn", msg: "analyst-sweep-failed", runId: id });
        }
      }
      return n;
    } finally {
      this.running = false;
    }
  }

  /** Runs one pass now (the start-up sweep), then every `intervalMs`. */
  start(): this {
    if (!this.timer) {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
      this.timer.unref?.();
    }
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Postgres advisory-lock key of M1.7's PrismaPolicyStore (packages/policy/src/prisma-store.ts). */
export const POLICY_LOCK_KEY = "devos:policy-engine";

type Sums = { open_usd: unknown; provider: string | null; cost_usd: unknown; settled_usd: unknown; project_id: string; model: string; role: string }[];

/** DEVOS-161: fail-closed settlement of a run's still-open reservations, inside the caller's transaction. */
async function settleOpenReservations(tx: Tx, runId: string): Promise<void> {
  const rows = (await tx.$queryRaw`
    SELECT
      (SELECT COALESCE(SUM(reserved_usd), 0) FROM budget_reservation WHERE run_id = ${runId}::uuid AND status = 'reserved'::budget_status) AS open_usd,
      (SELECT MIN(provider::text) FROM budget_reservation WHERE run_id = ${runId}::uuid AND status = 'reserved'::budget_status) AS provider,
      (SELECT COALESCE(SUM(usd), 0) FROM cost_entry WHERE run_id = ${runId}::uuid) AS cost_usd,
      (SELECT COALESCE(SUM(actual_usd), 0) FROM budget_reservation WHERE run_id = ${runId}::uuid AND status = 'reconciled'::budget_status) AS settled_usd,
      r.project_id::text AS project_id, r.model, r.role::text AS role
    FROM run r WHERE r.id = ${runId}::uuid`) as Sums;
  const s = rows[0];
  // One ledger entry under the reservations' provider: analyst runs reserve for `anthropic` only.
  if (!s || !s.provider) return; // nothing open
  // Work in micro-dollars (the columns are numeric(12,6)), so no float drift.
  const micro = (v: unknown) => Math.round(Number(String(v)) * 1e6);
  // Cost the engine recorded for this run that no reconciled reservation accounts for yet (it recorded, then failed
  // to settle): already in the ledger, so it is not charged twice.
  const unmatched = Math.max(0, micro(s.cost_usd) - micro(s.settled_usd));
  const charge = Math.max(0, micro(s.open_usd) - unmatched);
  if (charge > 0) {
    await tx.costEntry.create({
      data: { projectId: s.project_id, runId, provider: s.provider, model: s.model, role: s.role, usd: (charge / 1e6).toFixed(6) },
    });
  }
  await tx.$executeRaw`UPDATE budget_reservation SET status = 'reconciled'::budget_status, actual_usd = reserved_usd, actual_tokens = reserved_tokens, updated_at = now() WHERE run_id = ${runId}::uuid AND status = 'reserved'::budget_status`;
}

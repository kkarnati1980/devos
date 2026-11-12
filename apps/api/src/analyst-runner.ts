// M2.2-d3b1 (docs/modules/M2.2.md, "M2.2-d3b — Behaviour"): the analyst's model pass as one M1.5 run per call.
// The run engine reserves the budget, meters each turn and records the cost; this module only creates the
// intake task and run rows, executes the run and reads its text back. Any outcome other than `succeeded` throws,
// so the pipeline keeps the deterministic analysis with `assist-failed`.
import { tmpdir } from "node:os";
import type { ModelRunner } from "@devos/analyst";

export const ANALYST_MODEL = "claude-sonnet-5-5";
/** One answer turn; the engine cancels a run on reaching max_turns (M1.5 §6), so the cap is one above it. */
export const ANALYST_MAX_TURNS = 2;
export const ANALYST_MAX_SECONDS = 90;
/** Per-run ceiling (runner decision); the M1.7 envelope and the project budget still bound it. */
export const ANALYST_MAX_COST_USD = 0.5;
/** Longest output read back (UTF-8 bytes); longer is refused before the M2.2-b validator sees it. */
export const ANALYST_MAX_OUTPUT_BYTES = 256 * 1024;

export interface AnalystRunRows {
  /** Creates one `analysis` task and one queued `analyst` run for it; returns the run id. */
  createRun(input: {
    projectId: string;
    title: string;
    model: string;
    maxTurns: number;
    maxSeconds: number;
    maxCostUsd: number;
  }): Promise<string>;
  /** The run's `text` event payloads, in seq order. */
  textEvents(runId: string): Promise<string[]>;
  /** Closes the intake task once its run has ended. */
  finishTask(runId: string, ok: boolean): Promise<void>;
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

export function runEngineModelRunner(rows: AnalystRunRows, engine: RunExecutor): ModelRunner {
  return async ({ prompt, tag, projectId }) => {
    if (!projectId) throw new AnalystRunError("analyst-run-no-project");
    const runId = await rows.createRun({
      projectId,
      title: "Analyst assist",
      model: ANALYST_MODEL,
      maxTurns: ANALYST_MAX_TURNS,
      maxSeconds: ANALYST_MAX_SECONDS,
      maxCostUsd: ANALYST_MAX_COST_USD,
    });
    let ok = false;
    try {
      // The engine's own deadlines (max_seconds, idle and result timeouts) bound this call; no retry here:
      // a paid model call is not a safe operation (ADR-0011 §9).
      const outcome = await engine.execute({ runId, provider: "anthropic", prompt, cwd: tmpdir(), tag });
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
      await rows.finishTask(runId, ok).catch(() => undefined);
    }
  };
}

type Tx = {
  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  task: { create(args: unknown): Promise<{ id: string }>; update(args: unknown): Promise<unknown> };
  run: { create(args: unknown): Promise<{ id: string }>; findUnique(args: unknown): Promise<{ taskId: string } | null> };
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

  finishTask(runId: string, ok: boolean): Promise<void> {
    return this.tx(async (tx) => {
      const run = await tx.run.findUnique({ where: { id: runId }, select: { taskId: true } });
      if (run) await tx.task.update({ where: { id: run.taskId }, data: { status: ok ? "done" : "failed" } });
    });
  }
}

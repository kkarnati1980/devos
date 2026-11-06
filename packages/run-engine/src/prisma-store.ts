// RunStore over the M1.1 Prisma client (@devos/db `createDb`). Typed structurally so the package has
// no runtime dependency on the generated client. Every call runs in a transaction bounded by a 10 s
// timeout/maxWait and a transaction-local statement_timeout (ADR-0011: timeouts on every call).
// The M1.1 triggers still enforce a gapless, append-only run_event and run_error_not_an_attempt.
import type { CapabilityEnvelope } from "@devos/policy";
import type { CardRow, CostRow, RunRow, RunStore } from "./store.js";
import type { CheckpointData, RunErrorType, RunEvent, RunStatus, TurnUsage } from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaLike {
  $transaction<T>(fn: (tx: any) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T>;
}

const TX = { timeout: 10_000, maxWait: 10_000 };
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(String(v)));

function usd6(v: number): string {
  if (!Number.isFinite(v) || v < 0) throw new Error("cost-not-a-non-negative-number");
  // Round UP to the micro-dollar so recorded spend is never below the provider's figure.
  return (Math.ceil(v * 1_000_000 - 1e-6) / 1_000_000).toFixed(6);
}

export class PrismaRunStore implements RunStore {
  constructor(private readonly db: PrismaLike, private readonly statementTimeoutMs = 5_000) {}

  private tx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(Math.floor(this.statementTimeoutMs))}, true) AS statement_timeout`;
      return fn(tx);
    }, TX);
  }

  loadRun(runId: string): Promise<RunRow | null> {
    return this.tx(async (tx) => {
      const r = await tx.run.findUnique({ where: { id: runId } });
      if (!r) return null;
      return { id: r.id, taskId: r.taskId, projectId: r.projectId, role: r.role, model: r.model, attempt: r.attempt, status: r.status, maxTurns: r.maxTurns, maxSeconds: r.maxSeconds, maxCostUsd: num(r.maxCostUsd), turns: r.turns };
    });
  }

  loadEnvelope(runId: string): Promise<CapabilityEnvelope | null> {
    return this.tx(async (tx) => {
      const e = await tx.capabilityEnvelope.findFirst({ where: { runId }, orderBy: { createdAt: "desc" } });
      if (!e) return null;
      return { tools: e.tools, readPaths: e.readPaths, writePaths: e.writePaths, network: e.network, networkAllowList: e.networkAllowList, maxCostUsd: num(e.maxCostUsd), maxTokens: e.maxTokens, maxConcurrency: e.maxConcurrency, expiresAt: new Date(e.expiresAt).getTime(), depth: e.depth };
    });
  }

  latestCheckpoint(runId: string) {
    return this.tx(async (tx) => {
      const c = await tx.checkpoint.findFirst({ where: { runId }, orderBy: { seq: "desc" } });
      return c ? { seq: c.seq as number, data: c.data as CheckpointData } : null;
    });
  }

  lastEventSeq(runId: string): Promise<number> {
    return this.tx(async (tx) => {
      const agg = await tx.runEvent.aggregate({ where: { runId }, _max: { seq: true } });
      return agg._max.seq ?? 0;
    });
  }

  lastEvent(runId: string): Promise<RunEvent | null> {
    return this.tx(async (tx) => {
      const e = await tx.runEvent.findFirst({ where: { runId }, orderBy: { seq: "desc" } });
      return e ? { runId: e.runId, seq: e.seq, ts: new Date(e.ts).getTime(), type: e.type, payload: e.payload } : null;
    });
  }

  runCostUsd(runId: string): Promise<number> {
    return this.tx(async (tx) => {
      const agg = await tx.costEntry.aggregate({ where: { runId }, _sum: { usd: true } });
      return num(agg._sum.usd);
    });
  }

  appendEvent(e: RunEvent): Promise<void> {
    return this.tx(async (tx) => {
      await tx.runEvent.create({ data: { runId: e.runId, seq: e.seq, ts: new Date(e.ts), type: e.type, payload: e.payload } });
    });
  }

  saveCheckpoint(runId: string, seq: number, data: CheckpointData): Promise<void> {
    return this.tx(async (tx) => {
      await tx.checkpoint.create({ data: { runId, seq, data } });
      await tx.run.update({ where: { id: runId }, data: { turns: data.turn } });
    });
  }

  addTelemetry(runId: string, u: TurnUsage): Promise<void> {
    return this.tx(async (tx) => {
      await tx.runTelemetry.create({
        data: { runId, turn: u.turn, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens, contextTokens: u.contextTokens, toolName: u.toolName ?? null, toolResultBytes: u.toolResultBytes ?? null, tag: u.tag ?? null },
      });
    });
  }

  addCost(c: CostRow): Promise<void> {
    return this.tx(async (tx) => {
      await tx.costEntry.create({
        data: { projectId: c.projectId, runId: c.runId, provider: c.provider, model: c.model, role: c.role, inputTokens: c.inputTokens, outputTokens: c.outputTokens, cacheReadTokens: c.cacheReadTokens, cacheWriteTokens: c.cacheWriteTokens, usd: usd6(c.usd) },
      });
    });
  }

  recordError(runId: string, type: RunErrorType, message: string, retryable: boolean, countsAsAttempt: boolean): Promise<void> {
    return this.tx(async (tx) => {
      await tx.runError.create({ data: { runId, type, message: message.slice(0, 500), retryable, countsAsAttempt } });
    });
  }

  markRunning(runId: string): Promise<void> {
    return this.tx(async (tx) => {
      const r = await tx.run.findUnique({ where: { id: runId }, select: { startedAt: true } });
      await tx.run.update({ where: { id: runId }, data: { status: "running", ...(r?.startedAt ? {} : { startedAt: new Date() }) } });
    });
  }

  finishRun(runId: string, status: RunStatus, turns: number, error?: string): Promise<void> {
    return this.tx(async (tx) => {
      await tx.run.update({ where: { id: runId }, data: { status, turns, endedAt: new Date(), error: error ?? null } });
    });
  }

  isProjectPaused(projectId: string): Promise<boolean> {
    return this.tx(async (tx) => {
      const p = await tx.project.findUnique({ where: { id: projectId }, select: { pausedAt: true } });
      return Boolean(p?.pausedAt);
    });
  }

  pauseProject(projectId: string): Promise<void> {
    return this.tx(async (tx) => {
      await tx.project.updateMany({ where: { id: projectId, pausedAt: null }, data: { pausedAt: new Date() } });
    });
  }

  /** A budget/policy card is a pending `destructive_or_spend` approval on the project (KK decides). */
  raiseCard(card: CardRow): Promise<string> {
    return this.tx(async (tx) => {
      const a = await tx.approval.create({
        data: { projectId: card.projectId, gate: "destructive_or_spend", action: card.action, target: card.target, reason: card.reason.slice(0, 500), ...(card.costUsd !== undefined ? { costUsd: usd6(card.costUsd) } : {}) },
      });
      return a.id as string;
    });
  }
}

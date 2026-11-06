// RunStore: what the run engine reads and writes. PrismaRunStore (prisma-store.ts) is the DevOS store;
// MemoryRunStore is for tests and local tools and mirrors the M1.1 integrity rules the engine relies on
// (gapless run_event seq, run_error_not_an_attempt).
import type { CapabilityEnvelope, Provider } from "@devos/policy";
import type { CheckpointData, RunErrorType, RunEvent, RunStatus, TurnUsage } from "./types.js";

export interface RunRow {
  id: string;
  taskId: string;
  projectId: string;
  role: string;
  model: string;
  attempt: number;
  status: RunStatus;
  maxTurns: number;
  maxSeconds: number;
  maxCostUsd: number;
  turns: number;
}

export interface CostRow {
  projectId: string;
  runId: string;
  provider: Provider;
  model: string;
  role: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usd: number;
}

export interface CardRow {
  projectId: string;
  action: string;
  target: string;
  reason: string;
  costUsd?: number;
}

export interface RunStore {
  loadRun(runId: string): Promise<RunRow | null>;
  loadEnvelope(runId: string): Promise<CapabilityEnvelope | null>;
  latestCheckpoint(runId: string): Promise<{ seq: number; data: CheckpointData } | null>;
  lastEventSeq(runId: string): Promise<number>;
  appendEvent(event: RunEvent): Promise<void>;
  saveCheckpoint(runId: string, seq: number, data: CheckpointData): Promise<void>;
  addTelemetry(runId: string, usage: TurnUsage): Promise<void>;
  addCost(row: CostRow): Promise<void>;
  recordError(runId: string, type: RunErrorType, message: string, retryable: boolean, countsAsAttempt: boolean): Promise<void>;
  markRunning(runId: string): Promise<void>;
  finishRun(runId: string, status: RunStatus, turns: number, error?: string): Promise<void>;
  isProjectPaused(projectId: string): Promise<boolean>;
  pauseProject(projectId: string): Promise<void>;
  raiseCard(card: CardRow): Promise<string>;
}

export class MemoryRunStore implements RunStore {
  runs = new Map<string, RunRow>();
  envelopes = new Map<string, CapabilityEnvelope>();
  events: RunEvent[] = [];
  checkpoints: { runId: string; seq: number; data: CheckpointData }[] = [];
  telemetry: (TurnUsage & { runId: string })[] = [];
  costs: CostRow[] = [];
  errors: { runId: string; type: RunErrorType; message: string; retryable: boolean; countsAsAttempt: boolean }[] = [];
  paused = new Set<string>();
  cards: CardRow[] = [];
  finished = new Map<string, { status: RunStatus; turns: number; error?: string }>();
  /** Test hook: throw on the nth appendEvent call (simulates the worker dying mid-run). */
  failAppendAt: number | null = null;
  private appendCalls = 0;

  async loadRun(runId: string) {
    return this.runs.get(runId) ?? null;
  }
  async loadEnvelope(runId: string) {
    return this.envelopes.get(runId) ?? null;
  }
  async latestCheckpoint(runId: string) {
    const rows = this.checkpoints.filter((c) => c.runId === runId);
    return rows.length ? rows[rows.length - 1]! : null;
  }
  async lastEventSeq(runId: string) {
    return this.events.filter((e) => e.runId === runId).reduce((m, e) => Math.max(m, e.seq), 0);
  }
  async appendEvent(event: RunEvent) {
    this.appendCalls += 1;
    if (this.failAppendAt !== null && this.appendCalls >= this.failAppendAt) throw new Error("store-down");
    const last = await this.lastEventSeq(event.runId);
    if (event.seq !== last + 1) throw new Error(`run_event gap: got ${event.seq}, expected ${last + 1}`);
    this.events.push(structuredClone(event));
  }
  async saveCheckpoint(runId: string, seq: number, data: CheckpointData) {
    if (this.checkpoints.some((c) => c.runId === runId && c.seq === seq)) throw new Error("checkpoint seq taken");
    this.checkpoints.push({ runId, seq, data: structuredClone(data) });
  }
  async addTelemetry(runId: string, usage: TurnUsage) {
    this.telemetry.push({ runId, ...usage });
  }
  async addCost(row: CostRow) {
    this.costs.push({ ...row });
  }
  async recordError(runId: string, type: RunErrorType, message: string, retryable: boolean, countsAsAttempt: boolean) {
    if ((type === "policy_denied" || type === "budget_exceeded") && countsAsAttempt) throw new Error("run_error_not_an_attempt");
    this.errors.push({ runId, type, message, retryable, countsAsAttempt });
  }
  async markRunning(runId: string) {
    const r = this.runs.get(runId);
    if (r) r.status = "running";
  }
  async finishRun(runId: string, status: RunStatus, turns: number, error?: string) {
    const r = this.runs.get(runId);
    if (r) Object.assign(r, { status, turns });
    this.finished.set(runId, { status, turns, error });
  }
  async isProjectPaused(projectId: string) {
    return this.paused.has(projectId);
  }
  async pauseProject(projectId: string) {
    this.paused.add(projectId);
  }
  async raiseCard(card: CardRow) {
    this.cards.push(card);
    return `card-${this.cards.length}`;
  }
}

// DevOS M1.5 run contract (ADR-0009, docs/modules/M1.5.md). Vocabulary matches the M1.1 enums
// run_event_type, run_error_type and run_status in packages/db/prisma/schema.prisma.
import type { CapabilityEnvelope, Provider } from "@devos/policy";

export type RunEventType = "status" | "text" | "tool_call" | "tool_result" | "artifact" | "usage" | "error" | "done";

export type RunErrorType =
  | "provider_error"
  | "rate_limited"
  | "policy_denied"
  | "budget_exceeded"
  | "timeout"
  | "cancelled"
  | "missing_input"
  | "sandbox_error"
  | "internal";

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "limit_hit" | "cancelled";

/** Error types that never count as a failed attempt (ADR-0006, run_error_not_an_attempt CHECK). */
export const NOT_AN_ATTEMPT: ReadonlySet<RunErrorType> = new Set(["policy_denied", "budget_exceeded", "cancelled"]);

/** Error types worth retrying with backoff. Everything else is final (M1.5 PS amendment). */
export const RETRYABLE: ReadonlySet<RunErrorType> = new Set(["provider_error", "rate_limited", "timeout"]);

/** One numbered event. `seq` is gapless from 1 per run. */
export interface RunEvent {
  runId: string;
  seq: number;
  ts: number;
  type: RunEventType;
  payload: Record<string, unknown>;
}

/** Event body an adapter yields; the sequencer numbers and timestamps it. */
export interface AdapterEvent {
  type: Exclude<RunEventType, "done" | "error">;
  payload: Record<string, unknown>;
}

/** Usage of one model turn (ADR-0008 §1 telemetry, cost meter). */
export interface TurnUsage {
  turn: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextTokens: number;
  toolName?: string;
  toolResultBytes?: number;
  /** Telemetry tag, e.g. `standard_selection` for selection-loop tokens (ADR-0011 S5). */
  tag?: string;
}

export interface RunTask {
  runId: string;
  taskId: string;
  projectId: string;
  role: string;
  model: string;
  provider: Provider;
  prompt: string;
  cwd: string;
  /** Telemetry tag for every turn of this run (e.g. `standard_selection`). */
  tag?: string;
  /** Checkpoint to resume from (handoff data the adapter turns into its prompt; never another runtime's session). */
  resume?: CheckpointData | null;
}

export interface CheckpointData {
  turn: number;
  lastSeq: number;
  costUsd: number;
  tokens: number;
  /** Adapter-owned resume state (Claude: session id; Codex: nothing, it restarts from the handoff). */
  state: Record<string, unknown>;
}

export interface RunError {
  type: RunErrorType;
  message: string;
  retryable: boolean;
}

export interface RunResult {
  status: "succeeded" | "failed" | "cancelled";
  costUsd: number;
  /** True when the cost is a fixed estimate, not the provider's figure (Codex without usage). */
  costEstimated: boolean;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  error?: RunError;
  output?: string;
}

/**
 * The one run contract (ADR-0009 §1). `events()` yields adapter events until the runtime ends;
 * `result()` resolves once the runtime has ended. `cancel()` stops the runtime within 10 s.
 */
export interface RunAdapter {
  readonly name: "claude-agent-sdk" | "codex-exec";
  start(task: RunTask, envelope: CapabilityEnvelope | null): Promise<void>;
  events(): AsyncIterable<AdapterEvent>;
  cancel(runId: string): Promise<void>;
  result(): Promise<RunResult>;
}

export class RunFailure extends Error {
  constructor(readonly type: RunErrorType, message: string, readonly retryable = RETRYABLE.has(type)) {
    super(message);
    this.name = "RunFailure";
  }
}

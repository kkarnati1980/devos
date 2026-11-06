// DevOS G1 probe adapter (R2-b, docs/modules/R2.md). A deterministic, in-image runtime for the
// `run-resume` server check: it calls no provider, spends nothing real and only ever runs for the
// reserved model name PROBE_MODEL. Every other run keeps the worker's normal adapter (R1-c).
import type { CapabilityEnvelope, Provider } from "@devos/policy";
import type { AdapterEvent, RunAdapter, RunResult, RunTask } from "./types.js";

/** The only model the probe answers to. No provider has a model with this name. */
export const PROBE_MODEL = "devos-g1-probe";
/** Turns per probe run and the pause between them (long enough to kill the worker mid-run). */
export const PROBE_TURNS = 4;
export const PROBE_TURN_MS = 3_000;
/** Ledger-only cost per turn (USD). Recorded so reconcile and cost_entry are exercised; nothing is billed. */
export const PROBE_TURN_USD = 0.000001;

export interface ProbeOptions {
  turns?: number;
  turnMs?: number;
}

/** Runs `turns` usage turns, resuming after the checkpoint's turn. Cancel ends it at the next tick. */
export class ProbeAdapter implements RunAdapter {
  readonly name = "claude-agent-sdk" as const;
  private task: RunTask | null = null;
  private cancelled = false;
  private done!: Promise<RunResult>;
  private finish!: (r: RunResult) => void;
  private ran = 0;
  private readonly turns: number;
  private readonly turnMs: number;

  constructor(opts: ProbeOptions = {}) {
    this.turns = opts.turns ?? PROBE_TURNS;
    this.turnMs = opts.turnMs ?? PROBE_TURN_MS;
    this.done = new Promise((resolve) => (this.finish = resolve));
  }

  async start(task: RunTask, _envelope: CapabilityEnvelope | null): Promise<void> {
    if (task.model !== PROBE_MODEL) throw new Error("probe-model-mismatch");
    this.task = task;
  }

  async *events(): AsyncIterable<AdapterEvent> {
    const task = this.task;
    if (!task) return;
    const from = task.resume?.turn ?? 0;
    let completed = false;
    try {
      yield { type: "text", payload: { probe: true, fromTurn: from } };
      for (let turn = from + 1; turn <= this.turns; turn++) {
        await new Promise((r) => setTimeout(r, this.turnMs));
        if (this.cancelled) break;
        this.ran++;
        yield {
          type: "usage",
          payload: { turn, model: PROBE_MODEL, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 2, toolName: "probe", toolResultBytes: 0 },
        };
      }
      completed = !this.cancelled;
    } finally {
      // Also reached when the engine stops reading (limit, cancel): result() always settles.
      const usage = { inputTokens: this.ran, outputTokens: this.ran, cacheReadTokens: 0, cacheWriteTokens: 0 };
      this.finish({
        status: completed ? "succeeded" : "cancelled",
        costUsd: Math.round(this.ran * PROBE_TURN_USD * 1e6) / 1e6,
        costEstimated: false,
        usage,
        output: completed ? "g1-probe-ok" : undefined,
      });
    }
  }

  async cancel(_runId: string): Promise<void> {
    this.cancelled = true;
  }

  result(): Promise<RunResult> {
    return this.done;
  }
}

/**
 * Chooses per run: the probe for PROBE_MODEL, otherwise the provider's normal adapter. The choice is made
 * from the run's own model (set by the database row), never from anything an outside party writes.
 */
export class ProbeGateAdapter implements RunAdapter {
  private inner: RunAdapter | null = null;
  constructor(private readonly provider: Provider, private readonly normal: () => RunAdapter, private readonly probe: () => RunAdapter = () => new ProbeAdapter()) {}

  get name(): RunAdapter["name"] {
    return this.inner?.name ?? (this.provider === "openai" ? "codex-exec" : "claude-agent-sdk");
  }

  async start(task: RunTask, envelope: CapabilityEnvelope | null): Promise<void> {
    this.inner = task.model === PROBE_MODEL ? this.probe() : this.normal();
    return this.inner.start(task, envelope);
  }

  async *events(): AsyncIterable<AdapterEvent> {
    if (this.inner) yield* this.inner.events();
  }

  async cancel(runId: string): Promise<void> {
    await this.inner?.cancel(runId);
  }

  result(): Promise<RunResult> {
    if (!this.inner) return Promise.reject(new Error("probe-gate-not-started"));
    return this.inner.result();
  }
}

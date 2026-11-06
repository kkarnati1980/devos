// CodexExecAdapter (ADR-0009 §1, §4): runs `codex exec --json -` in its own process group, reads the
// JSONL event stream, and cancels by killing the whole group (SIGTERM, then SIGKILL after a grace).
// Token usage comes from `turn.completed.usage` when present; cost is tokens × the configured price,
// otherwise the fixed per-review estimate, flagged `costEstimated` (reconciled weekly, M1.5-c).
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { CapabilityEnvelope } from "@devos/policy";
import { AsyncQueue, deferred } from "../async-queue.js";
import type { AdapterEvent, RunAdapter, RunResult, RunTask } from "../types.js";
import { RunFailure } from "../types.js";

export interface CodexPrice {
  /** USD per million tokens. */
  input: number;
  cachedInput: number;
  output: number;
}

export interface CodexAdapterOptions {
  /** Codex binary; defaults to `codex`. Tests point it at a fake. */
  bin?: string;
  /** Arguments before `exec` (tests: the fake script path when `bin` is node). */
  scriptArgs?: string[];
  /** Extra `codex exec` arguments before the model and the stdin prompt marker. */
  args?: string[];
  /** Price per model; without one the run is charged `estimateUsd` and flagged estimated. */
  prices?: Record<string, CodexPrice>;
  /** Fixed per-run estimate used for the reservation and when usage is missing. */
  estimateUsd: number;
  /** SIGTERM → SIGKILL grace, ms (default 5000; cancel must finish within 10 s). */
  killGraceMs?: number;
  /** Environment for the child. Only these variables are passed (never the whole server env). */
  env?: Record<string, string>;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export class CodexExecAdapter implements RunAdapter {
  readonly name = "codex-exec" as const;
  private queue = new AsyncQueue<AdapterEvent>();
  private done = deferred<RunResult>();
  private child: ChildProcess | null = null;
  private cancelled = false;
  private killTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: CodexAdapterOptions) {}

  async start(task: RunTask, _envelope: CapabilityEnvelope | null): Promise<void> {
    if (this.child) throw new RunFailure("internal", "adapter already started", false);
    const args = [...(this.opts.scriptArgs ?? []), "exec", "--json", ...(this.opts.args ?? []), "--model", task.model, "-"];
    const child = spawn(this.opts.bin ?? "codex", args, {
      cwd: task.cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(this.opts.env ?? {}) },
    });
    this.child = child;
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (e) => reject(new RunFailure("sandbox_error", `spawn-failed:${(e as NodeJS.ErrnoException).code ?? "error"}`, false)));
    });
    await spawned;
    child.stdin?.end(task.prompt);
    child.stderr?.resume(); // stderr is not parsed (may hold provider text); drained so the child never blocks.
    void this.pump(child, task);
  }

  private async pump(child: ChildProcess, task: RunTask): Promise<void> {
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let turn = task.resume?.turn ?? 0;
    let sawUsage = false;
    let pendingToolBytes = 0;
    let lastTool: string | undefined;
    let failure: RunResult["error"] | undefined;
    let output: string | undefined;
    const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    const rl = createInterface({ input: child.stdout! });
    for await (const line of rl) {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // non-JSON lines are ignored
      }
      const type = String(ev.type ?? "");
      const item = (ev.item ?? {}) as Record<string, unknown>;
      if (type === "thread.started") this.queue.push({ type: "status", payload: { state: "started", threadId: ev.thread_id ?? null } });
      else if (type === "item.completed" && item.type === "agent_message") {
        output = String(item.text ?? "");
        this.queue.push({ type: "text", payload: { text: output } });
      } else if (type === "item.started" && item.type === "command_execution") {
        this.queue.push({ type: "tool_call", payload: { id: item.id ?? null, tool: "shell", input: { command: item.command ?? null } } });
      } else if (type === "item.completed" && item.type === "command_execution") {
        const bytes = Buffer.byteLength(String(item.aggregated_output ?? ""));
        pendingToolBytes += bytes;
        lastTool = "shell";
        this.queue.push({ type: "tool_result", payload: { id: item.id ?? null, bytes, exitCode: item.exit_code ?? null } });
      } else if (type === "turn.completed") {
        const u = (ev.usage ?? {}) as Record<string, unknown>;
        sawUsage = sawUsage || typeof ev.usage === "object";
        turn += 1;
        const cached = n(u.cached_input_tokens);
        const input = Math.max(0, n(u.input_tokens) - cached);
        const usage = { turn, model: task.model, inputTokens: input, outputTokens: n(u.output_tokens), cacheReadTokens: cached, cacheWriteTokens: 0, contextTokens: n(u.input_tokens), toolName: lastTool, toolResultBytes: pendingToolBytes };
        pendingToolBytes = 0;
        totals.inputTokens += usage.inputTokens;
        totals.outputTokens += usage.outputTokens;
        totals.cacheReadTokens += usage.cacheReadTokens;
        this.queue.push({ type: "usage", payload: usage });
      } else if (type === "turn.failed" || type === "error") {
        failure = { type: "provider_error", message: "codex-turn-failed", retryable: true };
      }
    }
    const code = await closed;
    if (this.cancelled) {
      // The direct child is gone, but a group member that ignores SIGTERM may live on (and need not
      // hold our stdio): kill the whole group now rather than waiting for the grace timer.
      if (this.killTimer) clearTimeout(this.killTimer);
      this.killGroup("SIGKILL");
    }
    const price = this.opts.prices?.[task.model];
    const metered = sawUsage && price !== undefined;
    const costUsd = metered
      ? (totals.inputTokens * price.input + totals.cacheReadTokens * price.cachedInput + totals.outputTokens * price.output) / 1_000_000
      : this.opts.estimateUsd;
    let result: RunResult;
    if (this.cancelled) {
      result = { status: "cancelled", costUsd, costEstimated: !metered, usage: totals, error: { type: "cancelled", message: "cancelled", retryable: false } };
    } else if (failure || code !== 0) {
      result = { status: "failed", costUsd, costEstimated: !metered, usage: totals, error: failure ?? { type: "provider_error", message: `codex-exit-${code ?? "signal"}`, retryable: true } };
    } else {
      result = { status: "succeeded", costUsd, costEstimated: !metered, usage: totals, output };
    }
    this.queue.end();
    this.done.resolve(result);
  }

  events(): AsyncIterable<AdapterEvent> {
    return this.queue;
  }

  /** Kill the whole process group: SIGTERM now, SIGKILL after the grace period. */
  async cancel(): Promise<void> {
    this.cancelled = true;
    if (!this.child?.pid) return;
    this.killGroup("SIGTERM");
    this.killTimer = setTimeout(() => this.killGroup("SIGKILL"), this.opts.killGraceMs ?? 5000);
    this.killTimer.unref();
  }

  private killGroup(sig: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, sig);
    } catch {
      /* group already gone */
    }
  }

  result(): Promise<RunResult> {
    return this.done.promise;
  }
}

// ClaudeAgentSdkAdapter (ADR-0009 §1, §4). The Agent SDK's `query` is injected so the engine has no
// hard dependency on it and tests run against a fake; production passes `query` from
// `@anthropic-ai/claude-agent-sdk`. Cancellation is the SDK abort controller.
import type { CapabilityEnvelope } from "@devos/policy";
import { AsyncQueue, deferred } from "../async-queue.js";
import type { AdapterEvent, RunAdapter, RunResult, RunTask } from "../types.js";
import { RunFailure } from "../types.js";

/** The subset of the SDK message stream the adapter reads (SDKMessage). */
export type SdkMessage = { type: string; [k: string]: unknown };

export type SdkQuery = (args: {
  prompt: string;
  options: {
    abortController: AbortController;
    cwd: string;
    model: string;
    resume?: string;
    allowedTools?: string[];
    canUseTool?: (toolName: string, input: Record<string, unknown>) => Promise<
      { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }
    >;
  };
}) => AsyncIterable<SdkMessage>;

export interface ClaudeAdapterOptions {
  query: SdkQuery;
  /** Called before every tool use (the M1.7 policy check). false = deny the tool call. */
  toolGate?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
}

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export class ClaudeAgentSdkAdapter implements RunAdapter {
  readonly name = "claude-agent-sdk" as const;
  private queue = new AsyncQueue<AdapterEvent>();
  private done = deferred<RunResult>();
  private abort = new AbortController();
  private cancelled = false;
  private started = false;

  constructor(private readonly opts: ClaudeAdapterOptions) {}

  async start(task: RunTask, envelope: CapabilityEnvelope | null): Promise<void> {
    if (this.started) throw new RunFailure("internal", "adapter already started", false);
    this.started = true;
    if (this.cancelled) {
      // cancel() arrived before the runtime started: never start it.
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      this.queue.end();
      this.done.resolve(this.cancelledResult(usage, 0));
      throw new RunFailure("cancelled", "cancelled-before-start", false);
    }
    const sessionId = typeof task.resume?.state?.sessionId === "string" ? task.resume.state.sessionId : undefined;
    const gate = this.opts.toolGate;
    const stream = this.opts.query({
      prompt: task.prompt,
      options: {
        abortController: this.abort,
        cwd: task.cwd,
        model: task.model,
        ...(sessionId ? { resume: sessionId } : {}),
        ...(envelope ? { allowedTools: envelope.tools } : {}),
        ...(gate
          ? {
              canUseTool: async (toolName: string, input: Record<string, unknown>) =>
                (await gate(toolName, input).catch(() => false))
                  ? { behavior: "allow" as const, updatedInput: input }
                  : { behavior: "deny" as const, message: "policy-denied" },
            }
          : {}),
      },
    });
    void this.pump(stream, task.resume?.turn ?? 0);
  }

  private async pump(stream: AsyncIterable<SdkMessage>, firstTurn: number): Promise<void> {
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let turn = firstTurn;
    let pendingToolBytes = 0;
    let lastTool: string | undefined;
    let result: RunResult | null = null;
    try {
      for await (const m of stream) {
        if (m.type === "system" && typeof m.session_id === "string") {
          this.queue.push({ type: "status", payload: { state: "started", sessionId: m.session_id } });
        } else if (m.type === "assistant") {
          const msg = (m.message ?? {}) as { content?: unknown[]; usage?: Usage; model?: string };
          for (const block of msg.content ?? []) {
            const b = block as { type?: string; text?: string; name?: string; input?: unknown; id?: string };
            if (b.type === "text") this.queue.push({ type: "text", payload: { text: b.text ?? "" } });
            if (b.type === "tool_use") {
              lastTool = b.name;
              this.queue.push({ type: "tool_call", payload: { id: b.id, tool: b.name, input: b.input ?? null } });
            }
          }
          const u = msg.usage ?? {};
          turn += 1;
          const usage = {
            turn,
            model: msg.model ?? "",
            inputTokens: n(u.input_tokens),
            outputTokens: n(u.output_tokens),
            cacheReadTokens: n(u.cache_read_input_tokens),
            cacheWriteTokens: n(u.cache_creation_input_tokens),
            contextTokens: n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens),
            toolName: lastTool,
            toolResultBytes: pendingToolBytes,
          };
          pendingToolBytes = 0;
          totals.inputTokens += usage.inputTokens;
          totals.outputTokens += usage.outputTokens;
          totals.cacheReadTokens += usage.cacheReadTokens;
          totals.cacheWriteTokens += usage.cacheWriteTokens;
          this.queue.push({ type: "usage", payload: usage });
        } else if (m.type === "user") {
          const msg = (m.message ?? {}) as { content?: unknown };
          for (const block of Array.isArray(msg.content) ? msg.content : []) {
            const b = block as { type?: string; content?: unknown; tool_use_id?: string };
            if (b.type !== "tool_result") continue;
            const bytes = Buffer.byteLength(typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""));
            pendingToolBytes += bytes;
            this.queue.push({ type: "tool_result", payload: { id: b.tool_use_id, bytes } });
          }
        } else if (m.type === "result") {
          const ok = m.subtype === "success" && m.is_error !== true;
          result = {
            status: ok ? "succeeded" : "failed",
            costUsd: n(m.total_cost_usd),
            costEstimated: typeof m.total_cost_usd !== "number",
            usage: totals,
            output: typeof m.result === "string" ? m.result : undefined,
            ...(ok ? {} : { error: { type: "provider_error" as const, message: `sdk-result:${String(m.subtype)}`, retryable: true } }),
          };
        }
      }
      if (this.cancelled) result = this.cancelledResult(totals, result?.costUsd ?? 0);
      if (!result) result = { status: "failed", costUsd: 0, costEstimated: true, usage: totals, error: { type: "provider_error", message: "sdk-ended-without-result", retryable: true } };
    } catch (e) {
      result = this.cancelled ? this.cancelledResult(totals, 0) : { status: "failed", costUsd: 0, costEstimated: true, usage: totals, error: classify(e) };
    }
    this.queue.end();
    this.done.resolve(result);
  }

  private cancelledResult(usage: RunResult["usage"], costUsd: number): RunResult {
    return { status: "cancelled", costUsd, costEstimated: costUsd === 0, usage, error: { type: "cancelled", message: "cancelled", retryable: false } };
  }

  events(): AsyncIterable<AdapterEvent> {
    return this.queue;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.abort.abort();
  }

  result(): Promise<RunResult> {
    return this.done.promise;
  }
}

/** Map an SDK/HTTP error to a typed run error. Only the error code is kept, never its text. */
export function classify(e: unknown): { type: "rate_limited" | "provider_error" | "timeout" | "internal"; message: string; retryable: boolean } {
  const err = e as { status?: number; name?: string; code?: string };
  if (err?.status === 429) return { type: "rate_limited", message: "http-429", retryable: true };
  if (typeof err?.status === "number" && err.status >= 500) return { type: "provider_error", message: `http-${err.status}`, retryable: true };
  if (err?.name === "TimeoutError" || err?.code === "ETIMEDOUT") return { type: "timeout", message: "timeout", retryable: true };
  if (typeof err?.status === "number") return { type: "provider_error", message: `http-${err.status}`, retryable: false };
  return { type: "internal", message: err?.name ?? "error", retryable: false };
}

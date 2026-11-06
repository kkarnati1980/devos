// DevOS M1.5 run engine (docs/modules/M1.5.md). One run = reserve budget (M1.7) → run the adapter
// with limits → number every event gaplessly → telemetry + checkpoint per turn → reconcile the
// reservation and record cost → final `done` or typed `error`. A budget stop checkpoints, pauses the
// project and raises a card; neither a budget nor a policy stop counts as a failed attempt.
import type { PolicyDecision, PolicyRequest, Provider } from "@devos/policy";
import type { RunStore } from "./store.js";
import type { AdapterEvent, CheckpointData, RunAdapter, RunErrorType, RunEvent, RunStatus, RunTask, TurnUsage } from "./types.js";
import { NOT_AN_ATTEMPT, RETRYABLE, RunFailure } from "./types.js";

/** The part of @devos/policy's PolicyEngine the run engine uses. */
export interface PolicyLike {
  decide(request: PolicyRequest): Promise<PolicyDecision>;
  reconcile(reservationId: string, actualUsd: number, actualTokens: number): Promise<void>;
  release(reservationId: string): Promise<void>;
}

export interface RunInput {
  runId: string;
  provider: Provider;
  prompt: string;
  cwd: string;
  tag?: string;
  /** Tokens to reserve for this run (default: the envelope's maxTokens, else 1,000,000). */
  reserveTokens?: number;
  /** USD to reserve (default: the run's remaining max_cost_usd). Codex passes its per-review estimate. */
  reserveUsd?: number;
}

export interface RunEngineOptions {
  store: RunStore;
  policy: PolicyLike;
  adapterFor: (provider: Provider) => RunAdapter;
  now?: () => number;
  /** Timeout for adapter.start (ms, default 30 s). */
  startTimeoutMs?: number;
  /** Longest silence between two adapter events before the run times out (ms, default 10 min). */
  idleTimeoutMs?: number;
  /** Wait for adapter.result after the event stream ends or a cancel (ms, default 15 s). */
  resultTimeoutMs?: number;
}

export interface RunOutcome {
  runId: string;
  status: RunStatus | "paused";
  errorType?: RunErrorType;
  retryable: boolean;
  countsAsAttempt: boolean;
  costUsd: number;
  costEstimated: boolean;
  turns: number;
  lastSeq: number;
  cardId?: string;
}

class Timeout extends Error {}

function within<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => {
      t = setTimeout(() => reject(new Timeout(label)), ms);
    }),
  ]);
}

export class RunEngine {
  private readonly now: () => number;
  private readonly active = new Map<string, { adapter: RunAdapter; reason: "cancelled" | "limit" | null }>();

  constructor(private readonly opts: RunEngineOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Cancel a running run. The adapter stops its runtime within 10 s; the run ends `cancelled`. */
  async cancel(runId: string): Promise<boolean> {
    const a = this.active.get(runId);
    if (!a) return false;
    a.reason = "cancelled";
    await a.adapter.cancel(runId);
    return true;
  }

  async execute(input: RunInput): Promise<RunOutcome> {
    const { store, policy } = this.opts;
    const run = await store.loadRun(input.runId);
    if (!run) throw new RunFailure("missing_input", "run-not-found", false);
    const base = { runId: run.id, retryable: false, countsAsAttempt: false, costEstimated: false };

    const cp = await store.latestCheckpoint(run.id);
    let seq = await store.lastEventSeq(run.id);
    const emit = async (type: RunEvent["type"], payload: Record<string, unknown>) => {
      seq += 1;
      await store.appendEvent({ runId: run.id, seq, ts: this.now(), type, payload });
    };
    let state: CheckpointData = cp?.data ? structuredClone(cp.data) : { turn: 0, lastSeq: 0, costUsd: 0, tokens: 0, state: {} };
    let cpSeq = cp?.seq ?? -1;
    const checkpoint = async () => {
      state.lastSeq = seq;
      cpSeq += 1;
      await store.saveCheckpoint(run.id, cpSeq, state);
    };

    if (await store.isProjectPaused(run.projectId)) {
      return { ...base, status: "paused", errorType: "budget_exceeded", costUsd: 0, turns: state.turn, lastSeq: seq };
    }

    // ---- reserve (M1.7, fail-closed) ----
    const envelope = await store.loadEnvelope(run.id);
    const remainingUsd = Math.max(0, run.maxCostUsd - state.costUsd);
    const reserveUsd = input.reserveUsd ?? remainingUsd;
    const reserveTokens = input.reserveTokens ?? envelope?.maxTokens ?? 1_000_000;
    let decision: PolicyDecision | null = null;
    try {
      decision = await policy.decide({
        identity: { id: `agent:${run.role}:${run.id}`, type: "agent", roles: [run.role] },
        action: { type: "model.run", resource: `run:${run.id}`, budgeted: true, provider: input.provider, costUsd: reserveUsd, tokens: Math.ceil(reserveTokens), projectId: run.projectId, runId: run.id },
        ...(envelope ? { envelope } : {}),
      });
    } catch {
      decision = null; // decide rejected → deny (M1.7 interface)
    }
    if (!decision || decision.enforcedOutcome !== "allow") {
      const type: RunErrorType = decision?.stop === "budget_exceeded" ? "budget_exceeded" : "policy_denied";
      const reason = decision?.reason ?? "policy-unavailable";
      await emit("status", { state: "stopped", reason });
      await checkpoint();
      await store.recordError(run.id, type, reason, false, false);
      if (type === "budget_exceeded") await store.pauseProject(run.projectId);
      const cardId = await store.raiseCard({
        projectId: run.projectId,
        action: type === "budget_exceeded" ? "raise-budget" : "review-policy-denial",
        target: `run:${run.id}`,
        reason,
        costUsd: reserveUsd,
      });
      await emit("error", { type, message: reason, retryable: false, countsAsAttempt: false, cardId });
      await store.finishRun(run.id, type === "budget_exceeded" ? "limit_hit" : "failed", state.turn, type);
      return { ...base, status: type === "budget_exceeded" ? "limit_hit" : "failed", errorType: type, costUsd: 0, turns: state.turn, lastSeq: seq, cardId };
    }
    const reservationId = decision.reservationId;

    // ---- run ----
    const adapter = this.opts.adapterFor(input.provider);
    const slot = { adapter, reason: null as "cancelled" | "limit" | null };
    this.active.set(run.id, slot);
    const started = this.now();
    const deadline = started + run.maxSeconds * 1000;
    let limit: RunErrorType | null = null;
    let streamError: { type: RunErrorType; message: string } | null = null;
    let runTokens = 0;
    const task: RunTask = {
      runId: run.id, taskId: run.taskId, projectId: run.projectId, role: run.role, model: run.model,
      provider: input.provider, prompt: input.prompt, cwd: input.cwd, tag: input.tag, resume: cp ? state : null,
    };
    let result;
    try {
      await store.markRunning(run.id);
      await emit("status", { state: cp ? "resumed" : "started", fromTurn: state.turn, adapter: adapter.name });
      await within(adapter.start(task, envelope), this.opts.startTimeoutMs ?? 30_000, "start");

      const it = adapter.events()[Symbol.asyncIterator]();
      for (;;) {
        const wait = Math.min(this.opts.idleTimeoutMs ?? 600_000, Math.max(1, deadline - this.now()));
        let step: IteratorResult<AdapterEvent>;
        try {
          step = await within(it.next(), wait, "idle");
        } catch (e) {
          if (!(e instanceof Timeout)) throw e;
          limit = "timeout";
          slot.reason = "limit";
          await adapter.cancel(run.id);
          break;
        }
        if (step.done) break;
        const ev = step.value;
        await emit(ev.type, ev.payload);
        if (ev.type === "status" && typeof ev.payload.sessionId === "string") state.state.sessionId = ev.payload.sessionId;
        if (ev.type === "usage") {
          const u = ev.payload as unknown as TurnUsage;
          await store.addTelemetry(run.id, { ...u, ...(input.tag ? { tag: input.tag } : {}) });
          state.turn = u.turn;
          const tokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
          state.tokens += tokens;
          runTokens += tokens;
          await checkpoint();
          if (state.turn >= run.maxTurns && !limit) {
            limit = "internal"; // turn limit → limit_hit (recorded below as max-turns)
            slot.reason = "limit";
            await adapter.cancel(run.id);
          }
        }
        if (this.now() > deadline && !limit) {
          limit = "timeout";
          slot.reason = "limit";
          await adapter.cancel(run.id);
        }
      }
      result = await within(adapter.result(), this.opts.resultTimeoutMs ?? 15_000, "result");
    } catch (e) {
      streamError = e instanceof RunFailure ? { type: e.type, message: e.message } : e instanceof Timeout ? { type: "timeout", message: `adapter-${e.message}-timeout` } : { type: "internal", message: "engine-error" };
      if (!(e instanceof RunFailure && e.type === "sandbox_error")) await adapter.cancel(run.id).catch(() => undefined);
      result = await within(adapter.result(), this.opts.resultTimeoutMs ?? 15_000, "result").catch(() => null);
      if (streamError.type === "internal" && !(e instanceof RunFailure)) {
        // The store failed mid-run (the worker is as good as dead): settle the money, then rethrow so
        // the queue retries and the next execute resumes from the last checkpoint.
        await this.settle(reservationId, result?.costUsd ?? 0, runTokens).catch(() => undefined);
        if (result) {
          await store
            .addCost({ projectId: run.projectId, runId: run.id, provider: input.provider, model: run.model, role: run.role, ...result.usage, usd: result.costUsd })
            .catch(() => undefined);
        }
        this.active.delete(run.id);
        throw e;
      }
    } finally {
      this.active.delete(run.id);
    }

    // ---- settle money ----
    const costUsd = result?.costUsd ?? 0;
    const costEstimated = result ? result.costEstimated : true;
    const usage = result?.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const tokensUsed = Math.max(runTokens, usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens);
    await this.settle(reservationId, costUsd, tokensUsed);
    await store.addCost({ projectId: run.projectId, runId: run.id, provider: input.provider, model: run.model, role: run.role, ...usage, usd: costUsd });
    state.costUsd += costUsd;
    if (!limit && state.costUsd > run.maxCostUsd) limit = "budget_exceeded";

    // ---- final event ----
    let status: RunStatus;
    let errorType: RunErrorType | undefined;
    let message = "";
    if (slot.reason === "cancelled") {
      status = "cancelled";
      errorType = "cancelled";
      message = "cancelled";
    } else if (limit) {
      status = "limit_hit";
      errorType = limit;
      message = limit === "internal" ? "max-turns" : limit === "timeout" ? "max-seconds" : "max-cost";
    } else if (streamError) {
      status = "failed";
      errorType = streamError.type;
      message = streamError.message;
    } else if (!result || result.status !== "succeeded") {
      status = "failed";
      errorType = result?.error?.type ?? "internal";
      message = result?.error?.message ?? "no-result";
    } else {
      status = "succeeded";
    }
    await checkpoint();
    let cardId: string | undefined;
    const retryable = status === "failed" && errorType !== undefined && RETRYABLE.has(errorType) && (result?.error?.retryable ?? true);
    const countsAsAttempt = errorType !== undefined && !NOT_AN_ATTEMPT.has(errorType) && status !== "limit_hit";
    if (status === "succeeded") {
      await emit("done", { status, costUsd, costEstimated, turns: state.turn });
    } else {
      await store.recordError(run.id, errorType!, message, retryable, countsAsAttempt);
      if (errorType === "budget_exceeded") {
        await store.pauseProject(run.projectId);
        cardId = await store.raiseCard({ projectId: run.projectId, action: "raise-budget", target: `run:${run.id}`, reason: message, costUsd: state.costUsd });
      }
      await emit("error", { type: errorType, message, retryable, countsAsAttempt, ...(cardId ? { cardId } : {}) });
    }
    await store.finishRun(run.id, status, state.turn, status === "succeeded" ? undefined : `${errorType}:${message}`);
    return { runId: run.id, status, errorType, retryable, countsAsAttempt, costUsd, costEstimated, turns: state.turn, lastSeq: seq, cardId };
  }

  private async settle(reservationId: string | null, usd: number, tokens: number): Promise<void> {
    if (!reservationId) return;
    if (usd <= 0 && tokens <= 0) await this.opts.policy.release(reservationId);
    else await this.opts.policy.reconcile(reservationId, usd, Math.ceil(tokens));
  }
}

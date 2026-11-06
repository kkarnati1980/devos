// DevOS M1.5 run engine (docs/modules/M1.5.md). One run = reserve budget (M1.7) → run the adapter
// with limits → number every event gaplessly → telemetry + checkpoint per turn → reconcile the
// reservation and record cost → final `done` or typed `error`. A budget stop checkpoints, pauses the
// project and raises a card; neither a budget nor a policy stop counts as a failed attempt.
import type { PolicyDecision, PolicyRequest, Provider } from "@devos/policy";
import type { RunRow, RunStore } from "./store.js";
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
  /** Set by the dead-letter retry: rerun a run whose last attempt failed for good. */
  rerun?: boolean;
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

/** The recorded outcome of an attempt and how far its bookkeeping got (checkpointed per step). */
interface Ending {
  step: "settle" | "cost" | "record" | "event" | "finish";
  status: RunStatus;
  errorType?: RunErrorType;
  message: string;
  retryable: boolean;
  countsAsAttempt: boolean;
  reservationId: string | null;
  usd: number;
  tokens: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  costEstimated: boolean;
  provider: Provider;
  totalUsd: number;
  /** Last event seq before this ending; a terminal event after it is this ending's. */
  seqBefore: number;
  reserveUsd?: number;
  cardId?: string;
}

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * The USD to charge. A runtime that used tokens but reported no cost (an SDK error or abort after
 * billable turns) is charged the whole reservation: fail-closed (ADR-0006), flagged as an estimate.
 */
function failClosedUsd(result: { costUsd: number; costEstimated: boolean } | null | undefined, tokens: number, reservedUsd: number): number {
  const usd = result?.costUsd ?? 0;
  if (usd === 0 && tokens > 0 && (!result || result.costEstimated)) return reservedUsd;
  return usd;
}

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
      const next = seq + 1;
      await store.appendEvent({ runId: run.id, seq: next, ts: this.now(), type, payload });
      seq = next;
    };
    let state: CheckpointData = cp?.data ? structuredClone(cp.data) : { turn: 0, lastSeq: 0, costUsd: 0, tokens: 0, state: {} };
    let cpSeq = cp?.seq ?? -1;
    const checkpoint = async () => {
      state.lastSeq = seq;
      cpSeq += 1;
      await store.saveCheckpoint(run.id, cpSeq, state);
    };

    // ---- an earlier attempt's ending (ADR-0011 safe retry) ----
    // An unfinished ending is completed from its last step, never by rerunning the runtime. A
    // finished ending returns its outcome, unless it is a failure the queue retries (retryable) or
    // KK re-queued from the dead-letter view (`rerun`): then this execute is a new attempt.
    const prior = state.state.ending as Ending | undefined;
    if (prior) {
      const done = prior.step === "finish";
      const again = done && prior.status === "failed" && (prior.retryable || input.rerun === true);
      if (!again) return this.finalize(run, state, prior, emit, checkpoint, () => seq);
      delete state.state.ending;
      await emit("status", { state: "retrying", after: prior.errorType ?? "failed" });
    }

    // Spend so far: the larger of the checkpoint and the recorded cost entries (a crash may have
    // recorded cost after the last checkpoint).
    state.costUsd = Math.max(state.costUsd, await store.runCostUsd(run.id));

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
      const ending: Ending = {
        step: "record", status: type === "budget_exceeded" ? "limit_hit" : "failed", errorType: type, message: reason, retryable: false, countsAsAttempt: false,
        reservationId: null, usd: 0, tokens: 0, usage: ZERO_USAGE, costEstimated: false, provider: input.provider, totalUsd: state.costUsd, seqBefore: seq, reserveUsd,
      };
      state.state.ending = ending;
      await checkpoint();
      return this.finalize(run, state, ending, emit, checkpoint, () => seq);
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
        const crashUsd = failClosedUsd(result, runTokens, reserveUsd);
        await this.settle(reservationId, crashUsd, runTokens).catch(() => undefined);
        await store
          .addCost({ projectId: run.projectId, runId: run.id, provider: input.provider, model: run.model, role: run.role, ...(result?.usage ?? ZERO_USAGE), usd: crashUsd })
          .catch(() => undefined);
        // Best effort: carry the spend into a checkpoint too (the next execute also reads cost_entry).
        state.costUsd += crashUsd;
        await checkpoint().catch(() => undefined);
        this.active.delete(run.id);
        throw e;
      }
    } finally {
      this.active.delete(run.id);
    }

    // ---- ending: outcome first, then settle → cost → record → event → finish ----
    const usage = result?.usage ?? ZERO_USAGE;
    const tokensUsed = Math.max(runTokens, usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens);
    const costUsd = failClosedUsd(result, tokensUsed, reserveUsd);
    const costEstimated = !result || result.costEstimated || costUsd !== result.costUsd;
    // Over max_cost_usd wins over every other ending: pause and card even after a cancel or a limit.
    if (state.costUsd + costUsd > run.maxCostUsd) {
      limit = "budget_exceeded";
      slot.reason = "limit";
    }
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
    const retryable = status === "failed" && errorType !== undefined && RETRYABLE.has(errorType) && (result?.error?.retryable ?? true);
    const countsAsAttempt = errorType !== undefined && !NOT_AN_ATTEMPT.has(errorType) && status !== "limit_hit";
    state.costUsd += costUsd;
    const ending: Ending = {
      step: "settle", status, errorType, message, retryable, countsAsAttempt, reservationId, usd: costUsd, tokens: Math.ceil(tokensUsed),
      usage, costEstimated, provider: input.provider, totalUsd: state.costUsd, seqBefore: seq,
    };
    state.state.ending = ending;
    await checkpoint();
    return this.finalize(run, state, ending, emit, checkpoint, () => seq);
  }

  /**
   * Finish an ending step by step, checkpointing after each, so a retry after any failure resumes at
   * the step that did not complete. Steps are at-least-once: a repeated settle is tolerated
   * (reservation already closed); a repeated cost entry or card can only over-count (fail-closed).
   */
  private async finalize(
    run: RunRow,
    state: CheckpointData,
    e: Ending,
    emit: (type: RunEvent["type"], payload: Record<string, unknown>) => Promise<void>,
    checkpoint: () => Promise<void>,
    seqNow: () => number,
  ): Promise<RunOutcome> {
    const { store } = this.opts;
    const advance = async (step: Ending["step"]) => {
      e.step = step;
      state.state.ending = e;
      await checkpoint();
    };
    if (e.step === "settle") {
      await this.settle(e.reservationId, e.usd, e.tokens);
      await advance("cost");
    }
    if (e.step === "cost") {
      if (e.reservationId || e.usd > 0 || e.tokens > 0) await store.addCost({ projectId: run.projectId, runId: run.id, provider: e.provider, model: run.model, role: run.role, ...e.usage, usd: e.usd });
      await advance("record");
    }
    if (e.step === "record") {
      if (e.status !== "succeeded") {
        await store.recordError(run.id, e.errorType!, e.message, e.retryable, e.countsAsAttempt);
        if (e.errorType === "budget_exceeded" || e.errorType === "policy_denied") {
          if (e.errorType === "budget_exceeded") await store.pauseProject(run.projectId);
          e.cardId = await store.raiseCard({
            projectId: run.projectId,
            action: e.errorType === "budget_exceeded" ? "raise-budget" : "review-policy-denial",
            target: `run:${run.id}`,
            reason: e.message,
            costUsd: e.reservationId ? e.totalUsd : e.reserveUsd ?? 0,
          });
        }
      }
      await advance("event");
    }
    if (e.step === "event") {
      const last = await store.lastEvent(run.id);
      const emitted = last !== null && last.seq > e.seqBefore && (last.type === "done" || last.type === "error");
      if (!emitted) {
        if (e.status === "succeeded") await emit("done", { status: e.status, costUsd: e.usd, costEstimated: e.costEstimated, turns: state.turn, countsAsAttempt: false });
        else await emit("error", { status: e.status, type: e.errorType, message: e.message, retryable: e.retryable, countsAsAttempt: e.countsAsAttempt, costUsd: e.usd, costEstimated: e.costEstimated, ...(e.cardId ? { cardId: e.cardId } : {}) });
      }
      await advance("finish");
    }
    await store.finishRun(run.id, e.status, state.turn, e.status === "succeeded" ? undefined : `${e.errorType}:${e.message}`);
    return {
      runId: run.id, status: e.status, errorType: e.errorType, retryable: e.retryable, countsAsAttempt: e.countsAsAttempt, costUsd: e.usd,
      costEstimated: e.costEstimated, turns: state.turn, lastSeq: seqNow(), ...(e.cardId ? { cardId: e.cardId } : {}),
    };
  }

  private async settle(reservationId: string | null, usd: number, tokens: number): Promise<void> {
    if (!reservationId) return;
    try {
      if (usd <= 0 && tokens <= 0) await this.opts.policy.release(reservationId);
      else await this.opts.policy.reconcile(reservationId, usd, Math.ceil(tokens));
    } catch (e) {
      // A repeated settle after a crash: the reservation is already closed. Anything else is real.
      if (!/reservation-not-open/.test((e as Error)?.message ?? "")) throw e;
    }
  }
}

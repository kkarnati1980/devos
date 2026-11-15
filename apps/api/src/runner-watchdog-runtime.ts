// Runner watchdog runtime (DEVOS-220, contract docs/modules/runner-watchdog.md). Wires the pure core (runner-watchdog.ts)
// to the world: a read-only Linear query for the newest comment on the two runner logs, the stored state, the M1.6
// notifier and a 30-minute timer. It never writes to Linear. Logs carry fixed codes and times only: no comment body,
// key or driver message (AT6).
import type { NoticeInput } from "./notify.js";
import { EMPTY_STATE, TICK_MS, step, type Observation, type WatchdogState } from "./runner-watchdog.js";

/** The runner logs: DEVOS-75 (runner A) and DEVOS-89 (runner B). */
export const RUNNER_LOGS = ["DEVOS-75", "DEVOS-89"] as const;
/** How many recent comments are read per log; the newest is taken by time, whatever order Linear returns. */
export const COMMENTS_PER_LOG = 50;

/** The read side of @devos/linear-sync's LinearClient (timeout and read-only retries live there). */
export interface LinearReader {
  query<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

const QUERY = `query RunnerLog($id: String!, $n: Int!) { issue(id: $id) { comments(first: $n, orderBy: createdAt) { nodes { createdAt body } } } }`;
type LogReply = { issue?: { comments?: { nodes?: unknown } } | null } | null;

/**
 * The newest comment across both runner logs. Any failure (network, timeout, GraphQL error, a missing issue or an
 * unexpected reply) is `{ ok: false }`: the core then judges no silence and starts the Linear-unreachable clock.
 * A comment dated in the future (clock skew) counts as now.
 */
export async function observe(linear: LinearReader, nowMs: number): Promise<Observation> {
  let newest: { at: number; body: string } | null = null;
  try {
    for (const id of RUNNER_LOGS) {
      const reply = await linear.query<LogReply>(QUERY, { id, n: COMMENTS_PER_LOG });
      const nodes = reply?.issue?.comments?.nodes;
      if (!Array.isArray(nodes)) return { ok: false };
      for (const n of nodes as { createdAt?: unknown; body?: unknown }[]) {
        if (!n || typeof n.createdAt !== "string") continue;
        const t = Date.parse(n.createdAt);
        if (!Number.isFinite(t)) continue;
        const at = Math.min(t, nowMs);
        if (!newest || at > newest.at) newest = { at, body: typeof n.body === "string" ? n.body : "" };
      }
    }
  } catch {
    return { ok: false };
  }
  return { ok: true, newest: newest ? { at: new Date(newest.at).toISOString(), body: newest.body } : null };
}

/** Where the watchdog keeps its state between ticks and redeploys. */
export interface WatchdogStore {
  load(): Promise<WatchdogState>;
  save(state: WatchdogState): Promise<void>;
}

const KEYS = Object.keys(EMPTY_STATE) as (keyof WatchdogState)[];
/** A stored value read back as a state: unknown keys dropped, anything not an ISO string read as null. */
export function parseState(v: unknown): WatchdogState {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const out = { ...EMPTY_STATE } as WatchdogState;
  for (const k of KEYS) {
    const x = o[k];
    out[k] = typeof x === "string" && Number.isFinite(Date.parse(x)) ? new Date(Date.parse(x)).toISOString() : null;
  }
  return out;
}

export class MemoryWatchdogStore implements WatchdogStore {
  state: WatchdogState = { ...EMPTY_STATE };
  async load() { return { ...this.state }; }
  async save(s: WatchdogState) { this.state = { ...s }; }
}

/** The one row's name in `runner_watchdog_state`. */
export const WATCHDOG_ROW = "runner-watchdog";

/** One row (name `runner-watchdog`) of `runner_watchdog_state`, read and written in bounded transactions (ADR-0011 §9). */
export class PrismaWatchdogStore implements WatchdogStore {
  constructor(private readonly db: any, private readonly timeoutMs: number) {}

  private tx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return this.db.$transaction(fn, { timeout: this.timeoutMs, maxWait: this.timeoutMs });
  }

  async load(): Promise<WatchdogState> {
    const row: { state: unknown } | null = await this.tx((tx: any) => tx.runnerWatchdogState.findUnique({ where: { name: WATCHDOG_ROW }, select: { state: true } }));
    return parseState(row?.state);
  }

  async save(state: WatchdogState): Promise<void> {
    const data = { state: parseState(state) };
    await this.tx((tx: any) => tx.runnerWatchdogState.upsert({ where: { name: WATCHDOG_ROW }, update: data, create: { name: WATCHDOG_ROW, ...data }, select: { id: true } }));
  }
}

/** The watchdog's last completed tick, read by GET /health (the heartbeat DEVOS-221's server check reads). */
export const watchdogHeartbeat: { lastRunAt: string | null } = { lastRunAt: null };

/** The fixed codes Notifier.notify throws (`parseNotice` codes and the store error); any other text is not logged. */
const NOTIFY_CODES = /^(notifications-store-error|notice-contains-secret|body-must-be-object|(invalid|missing|unknown-field):[a-zA-Z]{1,20})$/;

export type WatchdogLog = (e: { level: "info" | "warn"; msg: string; code?: string; notices?: number }) => void;

export interface RunnerWatchdogDeps {
  linear: LinearReader;
  store: WatchdogStore;
  notify: (n: NoticeInput) => Promise<unknown>;
  log: WatchdogLog;
  now?: () => number;
  intervalMs?: number;
}

/**
 * The 30-minute job. A tick reads Linear, loads the state, runs the core, sends its notices, then saves the state.
 * The state is saved before any notice is sent, so a notice goes out at most once (Codex PR139-r1); a send that fails
 * is logged and not retried. A state that cannot be loaded or saved skips the tick and sends nothing (logged).
 * Ticks never overlap. `lastRunAt` is the time of the last tick that saved its state (the /health heartbeat).
 */
export class RunnerWatchdogJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  lastRunAt: string | null = null;

  constructor(private readonly d: RunnerWatchdogDeps) {}

  private now() { return this.d.now ? this.d.now() : Date.now(); }

  async tick(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const nowMs = this.now();
      const obs = await observe(this.d.linear, nowMs);
      if (!obs.ok) this.d.log({ level: "warn", msg: "runner-watchdog-linear-read-failed" });
      let state: WatchdogState;
      try {
        state = await this.d.store.load();
      } catch {
        this.d.log({ level: "warn", msg: "runner-watchdog-state-load-failed" });
        return false;
      }
      const r = step(obs, state, nowMs);
      // At most once (Codex PR139-r1, ADR-0011 §9, M1.6): a delivery is not idempotent, and Notifier.notify can
      // deliver and then throw while recording the outcome. So the state that records the alert is saved first, and
      // a notice is sent only after that save succeeds. A failed send is logged and never retried; the core's own
      // repeat window (6 hours) brings the alert back if the silence lasts.
      try {
        await this.d.store.save(r.state);
      } catch {
        this.d.log({ level: "warn", msg: "runner-watchdog-state-save-failed" });
        return false;
      }
      for (const n of r.notices) {
        try {
          await this.d.notify(n);
        } catch (e) {
          // NoticeError and the store error carry fixed codes; anything else is reported as one code, never its text.
          const code = e instanceof Error && NOTIFY_CODES.test(e.message) ? e.message : "notify-failed";
          this.d.log({ level: "warn", msg: "runner-watchdog-notify-failed", code });
        }
      }
      this.lastRunAt = r.state.lastRunAt;
      watchdogHeartbeat.lastRunAt = r.state.lastRunAt;
      this.d.log({ level: "info", msg: "runner-watchdog-tick", notices: r.notices.length });
      return true;
    } finally {
      this.running = false;
    }
  }

  /** Runs one tick now, then every `intervalMs` (default 30 minutes). */
  start(): this {
    if (!this.timer) {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), this.d.intervalMs ?? TICK_MS);
      this.timer.unref?.();
    }
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

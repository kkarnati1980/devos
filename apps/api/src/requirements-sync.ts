// M2.2-d3c1 (docs/modules/M2.2.md, "M2.2-d3c — Behaviour"): the periodic `syncApproval` job, and the question-card
// port that does not ask KK again a question he already decided in an earlier spec version.
import { AsyncLocalStorage } from "node:async_hooks";
import type { RaiseCard } from "@devos/analyst";
import { syncApproval, type RequirementsServices } from "./requirements.js";

export const SYNC_DEFAULT_MS = 60_000;
export const SYNC_MIN_MS = 10_000;
export const SYNC_MAX_MS = 3_600_000;
/** Projects synced per tick (oldest draft first); the rest are reached on later ticks. */
export const SYNC_BATCH = 100;
/** Decided cards read per project before raising a question (bounded read, ADR-0011 §9). */
export const DECIDED_SCAN_MAX = 1000;
const PAGE = 100;

/** `DEVOS_REQUIREMENTS_SYNC_MS`: an integer clamped to [10 s, 1 h]; absent or not an integer → 60 s. */
export function syncIntervalMs(v: string | undefined): number {
  const s = (v ?? "").trim();
  if (!/^\d{1,10}$/.test(s)) return SYNC_DEFAULT_MS;
  return Math.min(SYNC_MAX_MS, Math.max(SYNC_MIN_MS, Number(s)));
}

/** The store read the job needs: projects whose newest doc is a draft linked to an approved card, oldest first. */
export interface DraftLister {
  draftsAwaitingDecision(limit: number): Promise<string[]>;
}

export type SyncLog = (entry: { level: "warn"; msg: "requirements-sync-failed"; projectId: string }) => void;

export class RequirementsSyncJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly svc: RequirementsServices,
    private readonly lister: DraftLister,
    private readonly log: SyncLog,
    readonly intervalMs: number = SYNC_DEFAULT_MS,
  ) {}

  /**
   * One pass. A tick that starts while another is still running does nothing (returns null), so ticks never
   * overlap. One project's failure is logged with a fixed code (never the message, which may quote spec text) and
   * the pass moves on. Returns the number of projects synced without error.
   */
  async tick(): Promise<number | null> {
    if (this.running) return null;
    this.running = true;
    try {
      let ids: string[];
      try {
        ids = await this.lister.draftsAwaitingDecision(SYNC_BATCH);
      } catch {
        this.log({ level: "warn", msg: "requirements-sync-failed", projectId: "*" });
        return 0;
      }
      let ok = 0;
      for (const id of ids) {
        try {
          await syncApproval(this.svc, id);
          ok++;
        } catch {
          this.log({ level: "warn", msg: "requirements-sync-failed", projectId: id });
        }
      }
      return ok;
    } finally {
      this.running = false;
    }
  }

  start(): this {
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
      this.timer.unref?.();
    }
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** The slice of the M2.3 approval store the no-repeat rule reads (ApprovalStore satisfies it). */
export interface DecidedCardLister {
  list(filter: { status?: "approved" | "rejected"; projectId?: string; cursor?: string; limit: number }): Promise<
    { id: string; gate: string; action: string; target: string; projectId: string | null }[]
  >;
}

/**
 * Wraps a question-card port: when the project already has an approved or rejected `decision` card with the same
 * action and target (the M2.3 dedupe key), that card's id is returned and nothing is raised. Pending twins are
 * still reused by the core; an expired card does not count as answered.
 */
export function skipDecidedQuestions(raise: RaiseCard, cards: DecidedCardLister): RaiseCard {
  return async (draft, reason) => {
    const c = draft.card as { gate: string; action: string; target: string; projectId?: string | null };
    if (c.projectId) {
      // A failed lookup must not drop the question (pre-review finding 4): a possible repeat card is the lesser harm.
      const prior = await scanFor(cards, c.projectId).then((m) => m.get(key(c.action, c.target)) ?? null, () => null);
      if (prior) return { id: prior };
    }
    return raise(draft, reason);
  };
}

/**
 * DEVOS-166: one decided-card scan per submission. Inside `withDecidedScan`, every question card of that submission
 * shares one scan per (lister, project); a failed scan is shared too, so all of them are raised (the lesser harm).
 * The scope ends with the submission, so a card KK decides between two submissions is seen by the second. Outside a
 * scope (no submission hook), each question scans on its own, as before.
 */
type ScanScope = Map<DecidedCardLister, Map<string, Promise<Map<string, string>>>>;
const scanScope = new AsyncLocalStorage<ScanScope>();

export function withDecidedScan<T>(fn: () => Promise<T>): Promise<T> {
  return scanScope.run(new Map(), fn);
}

function scanFor(cards: DecidedCardLister, projectId: string): Promise<Map<string, string>> {
  const scope = scanScope.getStore();
  if (!scope) return decidedKeys(cards, projectId);
  let byProject = scope.get(cards);
  if (!byProject) scope.set(cards, (byProject = new Map()));
  let scan = byProject.get(projectId);
  if (!scan) byProject.set(projectId, (scan = decidedKeys(cards, projectId)));
  return scan;
}

const key = (action: string, target: string) => `${action}\u0000${target}`;

/** The project's decided `decision` cards as action/target → card id (approved first), at most DECIDED_SCAN_MAX read. */
async function decidedKeys(cards: DecidedCardLister, projectId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let read = 0; // shared by both statuses: at most DECIDED_SCAN_MAX cards in all
  for (const status of ["approved", "rejected"] as const) {
    let cursor: string | undefined;
    while (read < DECIDED_SCAN_MAX) {
      const page = await cards.list({ status, projectId, cursor, limit: Math.min(PAGE, DECIDED_SCAN_MAX - read) });
      for (const k of page) {
        const kk = key(k.action, k.target);
        if (k.gate === "decision" && k.projectId === projectId && !out.has(kk)) out.set(kk, k.id);
      }
      read += page.length;
      if (page.length === 0 || page.length < PAGE) break;
      cursor = page[page.length - 1]!.id;
    }
  }
  return out;
}

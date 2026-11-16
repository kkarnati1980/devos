// DEVOS-245 (M2.5-b2, docs/modules/M2.5.md "M2.5-b2 decisions"): the purge card and the teardown jobs.
// One non-overlapping job, ticking every 5 minutes, does four things:
//   1. a pending purge card whose project is no longer archived (KK pressed Restore) is expired;
//   2. a rejected purge card ("Keep archived") raised after `purge_after` moves `purge_after` by 30 days;
//   3. an approved purge card with a usable grant runs Purge under that grant (the M1.7 engine, never `allowAll`),
//      within a 10-minute limit; a retryable stop waits for the next daily run, a non-retryable stop or leftovers
//      raise one plain-language card to KK naming what is left (fixed wording, never a provider message);
//   4. once a day from 03:10 IST, every archived project past `purge_after` gets its purge card, re-raised once
//      after an unanswered (expired) one.
// Purge is reachable only through an approved card: this job never deletes without a grant from one.
// Pure: every dependency is injected; runtime.ts wires Prisma, the approvals core and @devos/teardown.

export const PURGE_ACTION = "teardown.purge";
/** Not a purge action (isPurgeAction would make it gate 5): a report card only. */
export const PURGE_STOPPED_ACTION = "teardown.stop-report";
export const TEARDOWN_TICK_MS = 5 * 60_000;
/** Decision 1 (M2.5-a3b pre-review 1: about 5 minutes for two applications, doubled). */
export const PURGE_TIME_LIMIT_MS = 10 * 60_000;
export const KEEP_ARCHIVED_MS = 30 * 86_400_000;
/** The daily purge-due run: 03:10 IST (UTC+5:30, no daylight saving) = 21:40 UTC the day before. */
export const PURGE_DUE_MINUTE_IST = 3 * 60 + 10;
/** Cards read per pass and projects per daily run (bounded reads, ADR-0011 §9). */
export const CARD_PAGE = 50;
export const DUE_PAGE = 100;
/** Decision 1: the card is raised once, then re-raised once after an unanswered one; then nothing happens. */
export const MAX_UNANSWERED = 2;

const IST_OFFSET_MS = 330 * 60_000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PROVIDER = /^[a-z0-9_]{1,40}$/;

export interface PurgeCardLike {
  id: string;
  status: string;
  action: string;
  target: string;
  projectId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface TeardownProject {
  id: string;
  slug: string;
  stage: string;
  purgeAfter: Date | null;
}

export interface PurgeResultLike {
  purged: boolean;
  report: { hits: readonly { provider: string; kind: string }[]; errors: readonly unknown[] };
}

export interface TeardownSweepDeps {
  /** Archived projects whose `purge_after` is at or before `now`, oldest `purge_after` first, at most `limit`. */
  listDue(now: Date, limit: number): Promise<TeardownProject[]>;
  project(id: string): Promise<TeardownProject | null>;
  /** Active inventory rows per provider (`resource`), for the card text. */
  activeCounts(projectId: string): Promise<Record<string, number>>;
  /** The M2.3 store's list, newest first; every given field matches exactly. */
  cards(f: { status?: string; action: string; target?: string; limit: number }): Promise<PurgeCardLike[]>;
  /** `Approvals.raiseCard` (dedupes against a pending twin with the same gate, action and target). */
  raise(card: ReturnType<typeof purgeCard> | ReturnType<typeof purgeStoppedCard>): Promise<unknown>;
  /** `Approvals.expireCardsById`. */
  expire(ids: readonly string[], reason: string): Promise<string[]>;
  /** The card's own grant when it is unrevoked, unexpired and has a use left; read-only (nothing is consumed). */
  usableGrant(approvalId: string, now: Date): Promise<string | null>;
  /** Purge under the card's grant (teardownWiring + purgeProject); throws `TeardownError` on a stop. */
  purge(projectId: string, grantId: string): Promise<PurgeResultLike>;
  /** `purge_after` from `from` to `to`, only while the project is archived and `purge_after` is still `from`. */
  keepArchived(projectId: string, from: Date, to: Date, approvalId: string): Promise<boolean>;
  log(e: { level: "info" | "warn"; msg: string; projectId?: string; code?: string; approvalId?: string }): void;
  now?: () => number;
  intervalMs?: number;
  purgeTimeoutMs?: number;
}

const target = (projectId: string): string => `project:${projectId}`;

const PROVIDER_NAMES: Record<string, string> = { github: "GitHub", coolify: "Coolify", vault: "Vault", backup: "Backups", r2: "R2", cloudflare: "Cloudflare" };

/** "GitHub: 2, Coolify: 5" from the active inventory; providers sorted, names fixed or the validated provider id. */
export function countsText(counts: Record<string, number>): string {
  const parts = Object.keys(counts)
    .filter((p) => PROVIDER.test(p) && Number.isInteger(counts[p]) && (counts[p] ?? 0) > 0)
    .sort()
    .map((p) => `${PROVIDER_NAMES[p] ?? p}: ${counts[p]}`);
  return parts.length ? parts.join(", ") : "nothing recorded";
}

const safeSlug = (slug: string): string => (SLUG.test(slug) ? slug : "(unnamed)");

/**
 * Decision (a): the purge card. Gate 5 (typed confirmation), action `teardown.purge`, target `project:<id>`, fixed
 * wording with the per-provider counts from the inventory (decision 2), so KK knows what will be deleted.
 */
export function purgeCard(p: { id: string; slug: string }, counts: Record<string, number>) {
  const slug = safeSlug(p.slug);
  return {
    gate: "purge" as const,
    action: PURGE_ACTION,
    target: target(p.id),
    reason:
      `Purge project ${slug}? This deletes its code, stacks, data and backups for good. ` +
      `What will be deleted (by provider): ${countsText(counts)}.`,
    consequence:
      `Approve (type the confirmation shown) to delete everything now; this cannot be undone. ` +
      `Reject to keep ${slug} archived for another 30 days. ` +
      `To bring the project back instead, press Restore on its project page; this card then closes.`,
    projectId: p.id,
  };
}

const STOP_WORDS: Record<string, string> = {
  ownership_mismatch: "DevOS could not prove that it owns one of the project's resources, so it did not delete it",
  provider_forbidden: "a provider refused the delete: the access key DevOS uses is missing a permission",
  scan_incomplete: "DevOS could not check every provider for leftovers, so it did not start deleting",
  unsupported_resource: "the project has a kind of resource DevOS does not know how to delete yet",
  approval_required: "the approval for this purge was no longer valid",
  policy_denied: "a DevOS rule does not allow this purge",
  leftover: "after deleting, the leftover check still found resources of this project",
  "scan-error": "after deleting, the leftover check could not reach every provider",
};

/**
 * Decision (c): the plain-language card for a non-retryable stop or a scan with hits. Every word is fixed here: only
 * the slug, a fixed reason for the code and the per-provider counts go in, never a provider message.
 */
export function purgeStoppedCard(p: { id: string; slug: string }, code: string, counts: Record<string, number>) {
  const slug = safeSlug(p.slug);
  const why = STOP_WORDS[code] ?? "it stopped with an error it cannot retry";
  return {
    gate: "decision" as const,
    action: PURGE_STOPPED_ACTION,
    target: target(p.id),
    reason:
      `Deleting project ${slug} stopped: ${why}. The project stays archived. ` +
      `Still recorded (by provider): ${countsText(counts)}.`,
    consequence:
      `Nothing more is deleted until you approve a new purge card for ${slug}. ` +
      `Ask Claude to look at the project's teardown report and fix the cause first. Approving or rejecting this card changes nothing.`,
    projectId: p.id,
  };
}

/** The fields of `@devos/teardown`'s TeardownError the job reads. */
const teardownStop = (e: unknown): { code: string; retryable: boolean } | null => {
  const x = e as { name?: unknown; code?: unknown; retryable?: unknown } | null;
  return x && x.name === "TeardownError" && typeof x.code === "string" ? { code: x.code, retryable: x.retryable === true } : null;
};

export class PurgeTimeout extends Error {
  constructor() {
    super("teardown-purge-timeout");
    this.name = "PurgeTimeout";
  }
}

/** The IST calendar day of `ms`, as "YYYY-MM-DD", and the minute of that day. */
export function istClock(ms: number): { day: string; minute: number } {
  const d = new Date(ms + IST_OFFSET_MS);
  return { day: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

export class TeardownSweepJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastDailyDay: string | null = null;
  /** Approved cards whose purge stopped retryably: tried again only by the next daily run (decision c). */
  private readonly waitForDaily = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly d: TeardownSweepDeps) {
    this.now = d.now ?? Date.now;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { day, minute } = istClock(this.now());
      const daily = minute >= PURGE_DUE_MINUTE_IST && this.lastDailyDay !== day;
      if (daily) this.waitForDaily.clear();
      await this.step("teardown-restored-pass-failed", () => this.closeRestored());
      await this.step("teardown-keep-pass-failed", () => this.keepArchivedPass());
      await this.step("teardown-approved-pass-failed", () => this.approvedPass());
      if (daily) {
        await this.step("teardown-due-pass-failed", () => this.duePass());
        this.lastDailyDay = day;
      }
    } finally {
      this.running = false;
    }
  }

  private async step(code: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch {
      this.d.log({ level: "warn", msg: "teardown-sweep-failed", code });
    }
  }

  /** 1. Restore closes the project's pending purge card, so at most one card is open and only for an archived project. */
  private async closeRestored(): Promise<void> {
    const pending = await this.d.cards({ status: "pending", action: PURGE_ACTION, limit: CARD_PAGE });
    const stale: string[] = [];
    for (const c of pending) {
      if (!c.projectId || c.target !== target(c.projectId)) continue;
      const p = await this.d.project(c.projectId);
      if (p && p.stage !== "archived") stale.push(c.id);
    }
    if (stale.length) await this.d.expire(stale, "project-not-archived");
  }

  /** 2. Decision (d): "Keep archived" on a card raised after `purge_after` moves `purge_after` by 30 days, once. */
  private async keepArchivedPass(): Promise<void> {
    const rejected = await this.d.cards({ status: "rejected", action: PURGE_ACTION, limit: CARD_PAGE });
    for (const c of rejected) {
      if (!c.projectId || c.target !== target(c.projectId)) continue;
      const p = await this.d.project(c.projectId);
      // A card raised before purge_after (an early ask) leaves purge_after as it is; a moved purge_after is later than
      // the card, so each rejection moves it once.
      if (!p || p.stage !== "archived" || !p.purgeAfter || c.createdAt.getTime() < p.purgeAfter.getTime()) continue;
      const from = p.purgeAfter;
      const base = Math.max(from.getTime(), (c.decidedAt ?? c.createdAt).getTime());
      if (await this.d.keepArchived(p.id, from, new Date(base + KEEP_ARCHIVED_MS), c.id)) {
        this.d.log({ level: "info", msg: "teardown-keep-archived", projectId: p.id, approvalId: c.id });
      }
    }
  }

  /** 3. Decision (c): an approved card with a usable grant runs the purge under that grant. */
  private async approvedPass(): Promise<void> {
    const approved = await this.d.cards({ status: "approved", action: PURGE_ACTION, limit: CARD_PAGE });
    const seen = new Set<string>();
    for (const c of approved) {
      const pid = c.projectId;
      if (!pid || c.target !== target(pid) || seen.has(pid) || this.waitForDaily.has(c.id)) continue;
      const grant = await this.d.usableGrant(c.id, new Date(this.now()));
      if (!grant) continue;
      seen.add(pid);
      const p = await this.d.project(pid);
      // The card is raised only from Archive's state; a project restored after the approval is KK's newer word.
      if (!p || p.stage !== "archived") {
        this.d.log({ level: "info", msg: "teardown-purge-skipped", projectId: pid, approvalId: c.id, code: p ? `stage-${p.stage}` : "project-missing" });
        continue;
      }
      await this.runPurge(p, c.id, grant);
    }
  }

  private async runPurge(p: TeardownProject, approvalId: string, grantId: string): Promise<void> {
    let result: PurgeResultLike;
    try {
      result = await withLimit(this.d.purge(p.id, grantId), this.d.purgeTimeoutMs ?? PURGE_TIME_LIMIT_MS);
    } catch (e) {
      const stop = teardownStop(e);
      if (e instanceof PurgeTimeout || !stop || stop.retryable) {
        // Retryable (or unknown, or over the limit; the run goes on under the project lock): the next daily run tries
        // again while the grant has a use left. Only a fixed code is logged, never an error's text.
        this.waitForDaily.add(approvalId);
        const code = e instanceof PurgeTimeout ? "teardown-purge-timeout" : stop ? stop.code : "teardown-purge-failed";
        this.d.log({ level: "warn", msg: "teardown-purge-retry", projectId: p.id, approvalId, code });
        return;
      }
      // A grant with uses left is not run again before the next daily run (whose stop card is then deduped).
      this.waitForDaily.add(approvalId);
      this.d.log({ level: "warn", msg: "teardown-purge-stopped", projectId: p.id, approvalId, code: stop.code });
      await this.raiseStopped(p, stop.code);
      return;
    }
    if (result.purged) {
      this.d.log({ level: "info", msg: "teardown-purged", projectId: p.id, approvalId });
      return;
    }
    const code = result.report.errors.length ? "scan-error" : "leftover";
    this.d.log({ level: "warn", msg: "teardown-purge-stopped", projectId: p.id, approvalId, code });
    await this.raiseStopped(p, code);
  }

  private async raiseStopped(p: TeardownProject, code: string): Promise<void> {
    try {
      await this.d.raise(purgeStoppedCard(p, code, await this.d.activeCounts(p.id)));
    } catch {
      this.d.log({ level: "warn", msg: "teardown-card-failed", projectId: p.id, code });
    }
  }

  /** 4. Decision (b): the daily purge-due run raises a card; it never deletes. */
  private async duePass(): Promise<void> {
    const due = await this.d.listDue(new Date(this.now()), DUE_PAGE);
    for (const p of due) {
      try {
        if (await this.shouldRaise(p)) {
          await this.d.raise(purgeCard(p, await this.d.activeCounts(p.id)));
          this.d.log({ level: "info", msg: "teardown-purge-card", projectId: p.id });
        }
      } catch {
        this.d.log({ level: "warn", msg: "teardown-card-failed", projectId: p.id, code: "purge-due" });
      }
    }
  }

  /**
   * One card per `purge_after` period: none while one is pending, an approved one still has a grant, KK has rejected
   * one (Keep archived), or a stop card is open; re-raised once after an unanswered (expired) one, then nothing.
   */
  private async shouldRaise(p: TeardownProject): Promise<boolean> {
    if (p.stage !== "archived" || !p.purgeAfter) return false;
    const since = p.purgeAfter.getTime();
    const cards = (await this.d.cards({ action: PURGE_ACTION, target: target(p.id), limit: CARD_PAGE })).filter((c) => c.projectId === p.id);
    if (cards.some((c) => c.status === "pending")) return false;
    const period = cards.filter((c) => c.createdAt.getTime() >= since);
    if (period.some((c) => c.status === "rejected")) return false;
    for (const c of cards.filter((x) => x.status === "approved")) {
      if (await this.d.usableGrant(c.id, new Date(this.now()))) return false;
    }
    const stops = await this.d.cards({ status: "pending", action: PURGE_STOPPED_ACTION, target: target(p.id), limit: 1 });
    if (stops.length) return false;
    return period.filter((c) => c.status === "expired").length < MAX_UNANSWERED;
  }

  start(): this {
    if (!this.timer) {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), this.d.intervalMs ?? TEARDOWN_TICK_MS);
      this.timer.unref?.();
    }
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** The purge's time limit: the promise, or PurgeTimeout after `ms` (the run itself goes on under the project lock). */
export function withLimit<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new PurgeTimeout()), ms);
  });
  p.catch(() => undefined);
  return Promise.race([p, limit]).finally(() => clearTimeout(t));
}

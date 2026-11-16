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
/** Decision 1: a purge card unanswered for 7 days expires (then it is re-raised once). */
export const PURGE_CARD_WINDOW_MS = 7 * 86_400_000;

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
  archivedAt: Date | null;
}

/** A card belongs to the project's current archive only if it was raised at or after `archived_at`. */
const raisedThisArchive = (c: { createdAt: Date }, p: TeardownProject): boolean =>
  p.stage === "archived" && p.archivedAt !== null && c.createdAt.getTime() >= p.archivedAt.getTime();

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
  /**
   * The card's own grant when it is unrevoked, unexpired and still unspent (`uses = 0`); read-only. One purge attempt
   * per approval: the purge's single policy check, before any provider call, spends a use.
   */
  unspentGrant(approvalId: string, now: Date): Promise<string | null>;
  /**
   * Purge under the card's grant (teardownWiring + purgeProject); throws `TeardownError` on a stop. Its authorizer
   * allows only when M1.7 actually used this grant (so the attempt spends it, whatever the policy mode or rules) and,
   * re-read under the project lock, the card is not older than the project's `archived_at`.
   */
  purge(projectId: string, grantId: string, cardCreatedAt: Date): Promise<PurgeResultLike>;
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
  incomplete: "the purge did not finish",
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
  /**
   * Approved cards whose purge failed before its policy check (the grant is still unspent, so nothing was written at a
   * provider): tried again by the next daily run, not every tick. In memory only; after a restart one more early try
   * is harmless for the same reason.
   */
  private readonly waitForDaily = new Set<string>();
  /**
   * Approvals whose purge stopped for good (pre-review r2 3): never run again by this process. A stop that spent the
   * grant is already final through rule 4; one that did not (refused at the policy check, or `not_archived`) wrote
   * nothing at a provider, so a single repeat after a restart is harmless.
   */
  private readonly stopped = new Set<string>();
  /**
   * Stop-report cards not yet delivered (Codex PR181-r1): retried at the start of every tick until raised (raiseCard
   * dedupes a pending twin). In memory: after a restart the daily run raises a fresh purge card instead, which still
   * needs KK's approval before anything more is deleted.
   */
  private readonly stopsOwed = new Map<string, { p: TeardownProject; code: string }>();
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
      await this.deliverStops();
      await this.step("teardown-restored-pass-failed", () => this.closeRestored());
      await this.step("teardown-keep-pass-failed", () => this.keepArchivedPass());
      await this.step("teardown-approved-pass-failed", () => this.approvedPass());
      // Pre-review 5: a failed (or partly failed) daily run is tried again on the next tick, not a day later.
      if (daily && (await this.step("teardown-due-pass-failed", () => this.duePass()))) this.lastDailyDay = day;
    } finally {
      this.running = false;
    }
  }

  private async step(code: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch {
      this.d.log({ level: "warn", msg: "teardown-sweep-failed", code });
      return false;
    }
  }

  /**
   * 1. Restore closes the project's pending purge card, so at most one card is open and only for an archived project;
   * and a purge card unanswered for 7 days expires (Codex PR181-r2: nothing else in the API ages cards out), so the
   * daily run can re-raise it once. Only this job's own purge cards are expired here.
   */
  private async closeRestored(): Promise<void> {
    const pending = await this.d.cards({ status: "pending", action: PURGE_ACTION, limit: CARD_PAGE });
    const restored: string[] = [];
    const unanswered: string[] = [];
    const cutoff = this.now() - PURGE_CARD_WINDOW_MS;
    for (const c of pending) {
      if (!c.projectId || c.target !== target(c.projectId)) continue;
      const p = await this.d.project(c.projectId);
      if (p && p.stage !== "archived") restored.push(c.id);
      else if (c.createdAt.getTime() <= cutoff) unanswered.push(c.id);
    }
    if (restored.length) await this.d.expire(restored, "project-not-archived");
    if (unanswered.length) await this.d.expire(unanswered, "purge-card-unanswered-7-days");
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

  /**
   * 3. Decision (c): an approved card runs one purge under its grant, only while that grant is unspent (one attempt
   * per approval: the policy check before any provider call spends a use, so this survives a restart) and only for the
   * archive period the card was raised in (pre-review 1: a Restore, then a new Archive, never purges on an old card).
   */
  private async approvedPass(): Promise<void> {
    const approved = await this.d.cards({ status: "approved", action: PURGE_ACTION, limit: CARD_PAGE });
    const seen = new Set<string>();
    for (const c of approved) {
      const pid = c.projectId;
      if (!pid || c.target !== target(pid) || seen.has(pid) || this.waitForDaily.has(c.id) || this.stopped.has(c.id)) continue;
      const grant = await this.d.unspentGrant(c.id, new Date(this.now()));
      if (!grant) continue;
      const p = await this.d.project(pid);
      if (!p || !raisedThisArchive(c, p)) {
        // The card is raised only from Archive's state; a Restore after it is KK's newer word.
        this.d.log({ level: "info", msg: "teardown-purge-skipped", projectId: pid, approvalId: c.id, code: !p ? "project-missing" : p.stage === "archived" ? "card-before-archive" : `stage-${p.stage}` });
        continue;
      }
      seen.add(pid);
      await this.runPurge(p, c.id, grant, c.createdAt);
    }
  }

  private async runPurge(p: TeardownProject, approvalId: string, grantId: string, cardCreatedAt: Date): Promise<void> {
    const run = this.d.purge(p.id, grantId, cardCreatedAt);
    let result: PurgeResultLike;
    try {
      result = await withLimit(run, this.d.purgeTimeoutMs ?? PURGE_TIME_LIMIT_MS);
    } catch (e) {
      if (e instanceof PurgeTimeout) {
        // The run goes on under the project lock; its outcome is still reported when it ends (pre-review 4).
        this.d.log({ level: "warn", msg: "teardown-purge-timeout", projectId: p.id, approvalId, code: "teardown-purge-timeout" });
        run.then((r) => this.afterResult(p, approvalId, r), (x) => this.afterError(p, approvalId, grantId, x)).catch(() => undefined);
        return;
      }
      await this.afterError(p, approvalId, grantId, e);
      return;
    }
    await this.afterResult(p, approvalId, result);
  }

  private async afterError(p: TeardownProject, approvalId: string, grantId: string, e: unknown): Promise<void> {
    const stop = teardownStop(e);
    const code = stop ? stop.code : "teardown-purge-failed";
    // Only a fixed code is logged, never an error's text (it may quote a provider body).
    if (stop && stop.code === "not_archived") {
      // Restored while the purge waited for the project lock: KK's newer word, not a stop (pre-review r2 3).
      this.stopped.add(approvalId);
      this.d.log({ level: "info", msg: "teardown-purge-skipped", projectId: p.id, approvalId, code: "not-archived" });
      return;
    }
    if (stop && !stop.retryable) {
      this.stopped.add(approvalId);
      this.d.log({ level: "warn", msg: "teardown-purge-stopped", projectId: p.id, approvalId, code });
      await this.raiseStopped(p, code);
      return;
    }
    // Retryable or unknown. With the grant spent, more deleting needs a new card (the daily run raises it); with the
    // grant unspent, nothing was written and the next daily run tries again.
    this.waitForDaily.add(approvalId);
    const spent = !(await this.d.unspentGrant(approvalId, new Date(this.now())).catch(() => grantId));
    this.d.log({ level: "warn", msg: spent ? "teardown-purge-unfinished" : "teardown-purge-retry", projectId: p.id, approvalId, code });
  }

  private async afterResult(p: TeardownProject, approvalId: string, r: PurgeResultLike): Promise<void> {
    if (r.purged) {
      this.d.log({ level: "info", msg: "teardown-purged", projectId: p.id, approvalId });
      return;
    }
    this.stopped.add(approvalId);
    const code = r.report.errors.length ? "scan-error" : r.report.hits.length ? "leftover" : "incomplete";
    this.d.log({ level: "warn", msg: "teardown-purge-stopped", projectId: p.id, approvalId, code });
    await this.raiseStopped(p, code);
  }

  private async raiseStopped(p: TeardownProject, code: string): Promise<void> {
    this.stopsOwed.set(p.id, { p, code });
    await this.deliverStops();
  }

  private async deliverStops(): Promise<void> {
    for (const [id, o] of this.stopsOwed) {
      try {
        await this.d.raise(purgeStoppedCard(o.p, o.code, await this.d.activeCounts(o.p.id)));
        this.stopsOwed.delete(id);
      } catch {
        this.d.log({ level: "warn", msg: "teardown-card-failed", projectId: o.p.id, code: o.code });
      }
    }
  }

  /** 4. Decision (b): the daily purge-due run raises a card; it never deletes. */
  private async duePass(): Promise<void> {
    const due = await this.d.listDue(new Date(this.now()), DUE_PAGE);
    let failed = false;
    for (const p of due) {
      try {
        if (await this.shouldRaise(p)) {
          await this.d.raise(purgeCard(p, await this.d.activeCounts(p.id)));
          this.d.log({ level: "info", msg: "teardown-purge-card", projectId: p.id });
        }
      } catch {
        failed = true;
        this.d.log({ level: "warn", msg: "teardown-card-failed", projectId: p.id, code: "purge-due" });
      }
    }
    // Codex PR181-r1: any project whose card could not be raised keeps the daily run open, so the next tick tries again
    // (projects already served are not raised twice: a pending card blocks a second one).
    if (failed) throw new Error("teardown-due-partial");
  }

  /**
   * One card per `purge_after` period: none while one is pending, an approved one of this archive still has an unspent
   * grant, KK has rejected one (Keep archived), or a stop card is open; re-raised once after an unanswered (expired)
   * one, then nothing.
   */
  private async shouldRaise(p: TeardownProject): Promise<boolean> {
    if (p.stage !== "archived" || !p.purgeAfter || this.stopsOwed.has(p.id)) return false;
    const since = p.purgeAfter.getTime();
    const cards = (await this.d.cards({ action: PURGE_ACTION, target: target(p.id), limit: CARD_PAGE })).filter((c) => c.projectId === p.id);
    if (cards.some((c) => c.status === "pending")) return false;
    const period = cards.filter((c) => c.createdAt.getTime() >= since);
    if (period.some((c) => c.status === "rejected")) return false;
    for (const c of cards.filter((x) => x.status === "approved" && raisedThisArchive(x, p))) {
      if (await this.d.unspentGrant(c.id, new Date(this.now()))) return false;
    }
    const stops = await this.d.cards({ status: "pending", action: PURGE_STOPPED_ACTION, target: target(p.id), limit: 1 });
    if (stops.length) return false;
    return period.filter((c) => c.status === "expired").length < MAX_UNANSWERED;
  }

  /**
   * M2.5-b3 (DEVOS-246): the pending purge card of the project's current archive, for the panel's link to the inbox.
   * A card from an earlier archive is not shown (approving it would never purge, pre-review 1 of M2.5-b2).
   */
  async pendingCard(p: TeardownProject): Promise<string | null> {
    if (p.stage !== "archived") return null;
    const pending = await this.d.cards({ status: "pending", action: PURGE_ACTION, target: target(p.id), limit: CARD_PAGE });
    return pending.find((c) => c.projectId === p.id && raisedThisArchive(c, p))?.id ?? null;
  }

  /**
   * M2.5-b3 decision 2 (DEVOS-246): KK's early ask ("Ask to delete now"). It only raises the same purge card as the
   * daily run; nothing is deleted until KK approves that card with its typed confirmation. A pending card of this
   * archive is returned as is; one from an earlier archive is closed first; an approved card whose grant is still
   * unspent means a purge is already queued. Raised before `purge_after`, a rejected card leaves `purge_after` alone
   * (keepArchivedPass), and the daily run counts only cards raised in its own period, so an early ask never uses up
   * the daily run's raises.
   */
  async askPurge(projectId: string): Promise<{ ok: true; approvalId: string; raised: boolean } | { ok: false; code: string }> {
    const p = await this.d.project(projectId);
    if (!p) return { ok: false, code: "project-not-found" };
    if (p.stage !== "archived" || !p.archivedAt) return { ok: false, code: "not_archived" };
    const cards = (await this.d.cards({ action: PURGE_ACTION, target: target(p.id), limit: CARD_PAGE })).filter((c) => c.projectId === p.id);
    const pending = cards.filter((c) => c.status === "pending");
    const current = pending.find((c) => raisedThisArchive(c, p));
    if (current) return { ok: true, approvalId: current.id, raised: false };
    for (const c of cards.filter((x) => x.status === "approved" && raisedThisArchive(x, p))) {
      if (await this.d.unspentGrant(c.id, new Date(this.now()))) return { ok: false, code: "purge-already-approved" };
    }
    if (pending.length) await this.d.expire(pending.map((c) => c.id), "purge-card-older-archive");
    const card = (await this.d.raise(purgeCard(p, await this.d.activeCounts(p.id)))) as { id?: unknown } | null;
    if (!card || typeof card.id !== "string") throw new Error("purge-card-not-raised");
    this.d.log({ level: "info", msg: "teardown-purge-asked", projectId: p.id, approvalId: card.id });
    return { ok: true, approvalId: card.id, raised: true };
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

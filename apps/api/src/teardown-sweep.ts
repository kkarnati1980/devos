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
/** Decision 25: the tick's cleanup pages through pending cards (newest first) up to this many per action. */
export const CLEANUP_SCAN_MAX = 1000;
/** Decision 36: the resume-point key of Keep archived's scan of rejected purge cards (cleanup keys are action names). */
const KEEP_SCAN_KEY = "keep:rejected";
/**
 * Decision 28 (Codex PR240-r24): the most card ids sent in one expiry call. Equal to the approvals API's
 * EXPIRE_IDS_MAX (a test pins the two together); kept here so this job stays free of the approvals module's imports.
 */
export const EXPIRE_BATCH = 500;
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
  /** M2.5-b5 decision 8: the card text, whose last sentence names the archive the card was built for. */
  reason?: string | null;
}

export interface TeardownProject {
  id: string;
  slug: string;
  stage: string;
  purgeAfter: Date | null;
  archivedAt: Date | null;
}

/**
 * M2.5-b5 decision 8 (Codex PR240-r4): the archive a purge card was built for, from its own text (`Archive <iso>.`, the
 * last sentence `purgeCard` writes). A card is bound to that archive for good, wherever it is read, after a restart too.
 */
const ARCHIVE_STAMP = / Archive (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\.$/;
export const cardArchive = (c: { reason?: string | null }): string | null =>
  (typeof c.reason === "string" ? ARCHIVE_STAMP.exec(c.reason)?.[1] : undefined) ?? null;

/**
 * M2.5-b5 decision 30 (Codex PR240-r26): a scheduled (daily) card also names the purge date it was raised for
 * (`Due <iso>.`, just before the archive stamp). An early ask has no due stamp. Keep archived moves `purge_after`, so a
 * scheduled card whose due date is no longer the project's is stale: it is expired while pending and never purges.
 */
const DUE_STAMP = / Due (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\. Archive [^ ]+\.$/;
export const cardDue = (c: { reason?: string | null }): string | null =>
  (typeof c.reason === "string" ? DUE_STAMP.exec(c.reason)?.[1] : undefined) ?? null;
/** Decision 30: a scheduled card whose due date is not the project's current `purge_after`. */
const dueMoved = (c: { reason?: string | null }, p: { purgeAfter: Date | null }): boolean => {
  const due = cardDue(c);
  return due !== null && due !== (p.purgeAfter?.toISOString() ?? null);
};

/**
 * A card belongs to the project's current archive only if it was raised at or after `archived_at` and (decision 8) it
 * names that same archive, so a card built from an earlier archive's state but written after a new Archive never counts.
 */
const raisedThisArchive = (c: { createdAt: Date; reason?: string | null }, p: TeardownProject): boolean =>
  p.stage === "archived" && p.archivedAt !== null && c.createdAt.getTime() >= p.archivedAt.getTime() && cardArchive(c) === p.archivedAt.toISOString();

/**
 * Decision 31 (Codex PR240-r27): a card that can still purge: it names the current archive and, if scheduled, the
 * current purge date. Every check that hands a card to KK or lets an approval hold back a new card uses this.
 */
const liveCard = (c: { createdAt: Date; reason?: string | null }, p: TeardownProject): boolean => raisedThisArchive(c, p) && !dueMoved(c, p);

/**
 * Keep archived applies to a rejected card only while the project is archived, the card was raised at or after
 * `purge_after` (a card raised before it, an early ask, leaves `purge_after` as it is; a moved `purge_after` is later
 * than the card, so each rejection moves it once) and (decision 9, Codex PR240-r5) the card names the current archive.
 */
const keepApplies = (c: { createdAt: Date; reason?: string | null }, p: TeardownProject | null): boolean =>
  !!p && p.stage === "archived" && !!p.purgeAfter && !!p.archivedAt && c.createdAt.getTime() >= p.purgeAfter.getTime() && raisedThisArchive(c, p);

/**
 * Decision 13: a card of an archive older than the project's `archivedAt` in this read (its stamp names an earlier
 * archive), or an unstamped card from before decision 8, which never purges.
 */
const olderArchive = (c: { reason?: string | null }, p: TeardownProject): boolean => {
  if (!p.archivedAt) return false;
  const named = cardArchive(c);
  return named === null || Date.parse(named) < p.archivedAt.getTime();
};

/** Decision 19: the id of a stored card, or a throw (a stop stays owed). */
const stopId = (raised: unknown): string => {
  const id = (raised as { id?: unknown } | null)?.id;
  if (typeof id !== "string") throw new Error("stop-card-not-raised");
  return id;
};

/** Decision 20: the stored twin names an archive older than `p`'s (or none, from before decision 18). */
const twinOlder = (raised: unknown, p: TeardownProject): boolean => {
  const reason = (raised as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && olderArchive({ reason }, p);
};

/** Decision 37: the stored twin was written after `at` (a stop owed later than the one being delivered). */
const twinAfter = (raised: unknown, at: number): boolean => {
  const created = (raised as { createdAt?: unknown } | null)?.createdAt;
  return created instanceof Date && created.getTime() > at;
};

/** Decision 18: `b` (a fresh read) is still the archive `a` was read in. */
const sameArchive = (a: TeardownProject, b: TeardownProject | null): boolean =>
  b !== null && b.stage === "archived" && a.archivedAt !== null && b.archivedAt?.getTime() === a.archivedAt.getTime();

/** Decision 7: expired only after its whole 7-day window (closeRestored's cutoff), so KK had the chance to answer it. */
const unanswered = (c: { createdAt: Date; decidedAt: Date | null }): boolean =>
  c.decidedAt !== null && c.decidedAt.getTime() - c.createdAt.getTime() >= PURGE_CARD_WINDOW_MS;

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
  cards(f: { status?: string; action: string; target?: string; cursor?: string; limit: number }): Promise<PurgeCardLike[]>;
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
  purge(projectId: string, grantId: string, card: { createdAt: Date; archive: string | null; due?: string | null }): Promise<PurgeResultLike>;
  /** `purge_after` from `from` to `to`, only while the project is archived and `purge_after` is still `from`. */
  /** Decision 26 (Codex PR240-r22): moves `purge_after` only while the row is still the archive `archivedAt` names. */
  keepArchived(projectId: string, from: Date, to: Date, approvalId: string, archivedAt: Date): Promise<boolean>;
  log(e: { level: "info" | "warn"; msg: string; projectId?: string; code?: string; approvalId?: string }): void;
  /**
   * M2.5-b5 decision 1 (DEVOS-255, from Codex PR239-r21): runs `fn` under the project lifecycle lock (the teardown store's
   * `withProjectLock`, which Archive, Restore and Purge take), so KK's early ask reads `archived` and raises its card
   * with no Purge or Restore in between. Production always passes it.
   */
  locked?<T>(projectId: string, fn: () => Promise<T>): Promise<T>;
  /**
   * M2.5-b5 decision 4 (Codex PR240-r1): throws unless the lock `locked` took is still held (the store's
   * `assertLockHeld`, a ping on the lock session), checked just before a purge card is written. Passed with `locked`.
   */
  lockHeld?(projectId: string): Promise<void>;
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
export function purgeCard(
  p: { id: string; slug: string; archivedAt: Date | null },
  counts: Record<string, number>,
  opts: { due?: Date | null } = {},
) {
  const slug = safeSlug(p.slug);
  // Decision 8: the archive this card is for, as its last sentence; read back by `cardArchive`.
  // Decision 30: a scheduled card also names its purge date, just before; read back by `cardDue`.
  const due = opts.due && p.archivedAt ? ` Due ${opts.due.toISOString()}.` : "";
  const stamp = p.archivedAt ? `${due} Archive ${p.archivedAt.toISOString()}.` : "";
  return {
    gate: "purge" as const,
    action: PURGE_ACTION,
    target: target(p.id),
    reason:
      `Purge project ${slug}? This deletes its code, stacks, data and backups for good. ` +
      `What will be deleted (by provider): ${countsText(counts)}.${stamp}`,
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
export function purgeStoppedCard(p: { id: string; slug: string; archivedAt: Date | null }, code: string, counts: Record<string, number>) {
  const slug = safeSlug(p.slug);
  const why = STOP_WORDS[code] ?? "it stopped with an error it cannot retry";
  // M2.5-b5 decision 18 (Codex PR240-r14): a stop card names its archive too (decision 8's stamp), so it counts only for it.
  const stamp = p.archivedAt ? ` Archive ${p.archivedAt.toISOString()}.` : "";
  return {
    gate: "decision" as const,
    action: PURGE_STOPPED_ACTION,
    target: target(p.id),
    reason:
      `Deleting project ${slug} stopped: ${why}. The project stays archived. ` +
      `Still recorded (by provider): ${countsText(counts)}.${stamp}`,
    consequence:
      `Nothing more is deleted until you approve a new purge card for ${slug}. ` +
      `Ask Claude to look at the project's teardown report and fix the cause first. Approving or rejecting this card changes nothing.`,
    projectId: p.id,
  };
}

/**
 * M2.5-b5 decision 36 (Codex PR240-r32): the failure a stop card reports, from its own fixed text (`stopped: <why>.
 * The project stays archived.`), so a stored twin can be told apart from a stop for another failure of the same archive.
 */
const STOP_WHY = /^Deleting project \S+ stopped: (.+?)\. The project stays archived\. /;
export const stopWhy = (reason: string): string | null => STOP_WHY.exec(reason)?.[1] ?? null;

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
   * M2.5-b5 decision 14 (Codex PR240-r10): the IST day whose daily run last released `waitForDaily`. The daily run can
   * stay open for many ticks (a purge still running, a card not yet raised), so the release happens once per day, not on
   * every tick that finds the run open; an approval that fails again before its policy check waits for the next day.
   */
  private waitReleasedDay: string | null = null;
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
  /** M2.5-b3 pre-review 2: projects whose purge is still running (also past the 10-minute limit), for KK's early ask. */
  private readonly purging = new Set<string>();
  /**
   * Stop-report cards not yet delivered (Codex PR181-r1): retried at the start of every tick until raised (raiseCard
   * dedupes a pending twin). In memory: after a restart the daily run raises a fresh purge card instead, which still
   * needs KK's approval before anything more is deleted.
   */
  private readonly stopsOwed = new Map<string, { p: TeardownProject; code: string; due: string | null; at: number }>();
  /** Decision 26: where each action's cleanup scan resumes on the next tick (the last card id read at the bound). */
  private readonly scanFrom = new Map<string, string>();
  /**
   * M2.5-b5 decision 6 (Codex PR240-r3): purge cards written but not proven to belong to the archive they were built
   * for (the fence's re-read failed or found a new archive) whose expiry also failed, by card id → project id. Retried
   * at the start of every tick; while one is owed, its project gets no card from either path and is never handed one.
   * In memory: after a restart such a card ages out through the 7-day expiry (closeRestored).
   */
  private readonly unfenced = new Map<string, string>();
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
      if (daily && this.waitReleasedDay !== day) {
        this.waitForDaily.clear();
        this.waitReleasedDay = day;
      }
      await this.deliverStops();
      await this.expireUnfenced();
      await this.step("teardown-restored-pass-failed", () => this.closeRestored());
      // Decision 28 (Codex PR240-r24): the stop-card cleanup runs even when the purge-card cleanup failed.
      await this.step("teardown-stop-cleanup-failed", () => this.closeEndedStops());
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
    // Decision 25 (Codex PR240-r20/r21): every pending card is read, page by page, not only the newest page.
    const scan = await this.allPending(PURGE_ACTION);
    const pending = scan.cards;
    const restored: string[] = [];
    const unanswered: string[] = [];
    const notDue: string[] = [];
    const cutoff = this.now() - PURGE_CARD_WINDOW_MS;
    for (const c of pending) {
      if (!c.projectId || c.target !== target(c.projectId)) continue;
      const p = await this.d.project(c.projectId);
      if (p && p.stage !== "archived") restored.push(c.id);
      // Decision 9 (Codex PR240-r5): a pending card that does not name the current archive (a stale card whose fence
      // expiry failed, also after a restart) is expired here, so it never blocks the current archive's card.
      else if (p && !raisedThisArchive(c, p)) restored.push(c.id);
      // Decision 30 (Codex PR240-r26): a scheduled card whose purge date Keep archived has moved is no longer due.
      else if (p && dueMoved(c, p)) notDue.push(c.id);
      else if (c.createdAt.getTime() <= cutoff) unanswered.push(c.id);
    }
    await this.expireBatched(restored, "project-not-archived");
    await this.expireBatched(notDue, "purge-card-not-due");
    await this.expireBatched(unanswered, "purge-card-unanswered-7-days");
    // Decision 27 (Codex PR240-r23): the resume point moves only after this batch's cleanup has succeeded.
    this.commitScan(PURGE_ACTION, scan.next);
  }

  /** 1b. Decision 28: the stop-card cleanup is its own step, so a failed purge-card cleanup never holds it back. */
  private async closeEndedStops(): Promise<void> {
    // Decision 18 (Codex PR240-r14): a pending stop card that does not name the current archive (raised after a Restore,
    // or a Restore and a new Archive, slipped in before its write; or unstamped, from before decision 18) is closed
    // here, so KK is not left a stop prompt for an archive that has ended, and it never blocks the current one's card.
    const stopScan = await this.allPending(PURGE_STOPPED_ACTION);
    const stops = stopScan.cards;
    const ended: string[] = [];
    for (const c of stops) {
      if (!c.projectId || c.target !== target(c.projectId)) continue;
      const p = await this.d.project(c.projectId);
      if (p && !raisedThisArchive(c, p)) ended.push(c.id);
    }
    await this.expireBatched(ended, "stop-card-archive-ended");
    this.commitScan(PURGE_STOPPED_ACTION, stopScan.next);
  }

  /**
   * Decision 28 (Codex PR240-r24): a cleanup batch can hold up to CLEANUP_SCAN_MAX ids, more than the approvals API
   * takes in one call, so it is sent in chunks of EXPIRE_BATCH. A failed chunk throws, so the resume point stays put
   * (decision 27); the chunks already expired are not pending on the re-read, so the retry sends only what is left.
   */
  private async expireBatched(ids: string[], reason: string): Promise<void> {
    for (let i = 0; i < ids.length; i += EXPIRE_BATCH) await this.d.expire(ids.slice(i, i + EXPIRE_BATCH), reason);
  }

  /**
   * Decision 25 (Codex PR240-r21): the pending cards of one action across all projects, paged by the last card's id
   * (newest first), so a full first page of current cards never hides an older stale one. Bounded by CLEANUP_SCAN_MAX.
   */
  private async allPending(action: string): Promise<{ cards: PurgeCardLike[]; next: string | undefined }> {
    return this.scanCards("pending", action, action);
  }

  /**
   * Decisions 25–26, for any status: the cards of one action across all projects, newest first, paged by cursor from
   * the resume point `key` names, at most CLEANUP_SCAN_MAX. Decision 36 (Codex PR240-r32) uses it for rejected cards.
   */
  private async scanCards(status: string, action: string, key: string): Promise<{ cards: PurgeCardLike[]; next: string | undefined }> {
    const out: PurgeCardLike[] = [];
    // Decision 26 (Codex PR240-r22): a scan that stops at the bound resumes on the next tick after the last card it
    // read, and starts again from the newest only once it reaches the end, so every pending card is reached in turn.
    let cursor = this.scanFrom.get(key);
    while (out.length < CLEANUP_SCAN_MAX) {
      const page = await this.d.cards({ status, action, cursor, limit: Math.min(CARD_PAGE, CLEANUP_SCAN_MAX - out.length) });
      out.push(...page);
      if (page.length < CARD_PAGE) return { cards: out, next: undefined };
      cursor = page[page.length - 1]!.id;
    }
    return { cards: out, next: cursor };
  }

  /** Decision 27: set the action's resume point (undefined = start from the newest) once its batch is cleaned up. */
  private commitScan(action: string, next: string | undefined): void {
    if (next === undefined) this.scanFrom.delete(action);
    else this.scanFrom.set(action, next);
  }

  /** 2. Decision (d): "Keep archived" on a card raised after `purge_after` moves `purge_after` by 30 days, once. */
  private async keepArchivedPass(): Promise<void> {
    // Decision 36 (Codex PR240-r32): every rejected card is reached, not only the newest page: the scan pages by cursor
    // and resumes where the last tick stopped at its bound (decisions 25–26). Rejections stay rejected after they are
    // applied, so a page of applied ones would otherwise hide an older one that still applies. Each project is read
    // once per pass (the move itself re-reads under the lock), and the resume point moves once the batch is done; a
    // card skipped by a failure is reached again when the scan wraps round to the newest.
    const scan = await this.scanCards("rejected", PURGE_ACTION, KEEP_SCAN_KEY);
    const reads = new Map<string, Promise<TeardownProject | null>>();
    for (const c of scan.cards) {
      if (!c.projectId || c.target !== target(c.projectId)) continue;
      const projectId = c.projectId;
      // Decision 33 (Codex PR240-r29): the move takes the project lifecycle lock, the one a purge holds from its
      // authorizer's `purge_after` read until its deletes end. So a scheduled card's authorizer never reads a date that
      // Keep archived is about to move: the move waits for a running purge (then finds the row purged and writes
      // nothing), and a purge waits for the move (then reads the new date and denies the old card, decision 30). The
      // row is read under the lock and the lock is checked just before the write. A lock that times out or is lost
      // skips this card only; it stays rejected, so the next tick tries again.
      // Decision 34 (Codex PR240-r30): the lock is taken only for a rejection that still applies on an unlocked read, and
      // never while this process is running a purge for the project (that purge holds the lock, maybe past the sweep's
      // limit, and the store queues waiters in process before its own lock timeout starts). The card is left for the
      // next tick, so one long purge never stalls the sweep for other projects.
      // Decision 35 (Codex PR240-r31): the unlocked read is inside the per-card try, so a failed read skips this card
      // only, never the rest of the batch.
      try {
        let read = reads.get(projectId);
        if (!read) {
          read = this.d.project(projectId);
          reads.set(projectId, read);
          // A failed read is not cached, so the next card of the project reads again.
          read.catch(() => reads.delete(projectId));
        }
        if (!keepApplies(c, await read)) continue;
        if (this.purging.has(projectId)) {
          this.d.log({ level: "info", msg: "teardown-keep-deferred", projectId, approvalId: c.id, code: "purge-running" });
          continue;
        }
        const keep = () => this.keepLocked(c, projectId);
        const locked = this.d.locked;
        if (await (locked ? locked(projectId, keep) : keep())) {
          reads.delete(projectId);
          this.d.log({ level: "info", msg: "teardown-keep-archived", projectId, approvalId: c.id });
        }
      } catch {
        this.d.log({ level: "warn", msg: "teardown-keep-failed", projectId, approvalId: c.id, code: "teardown-keep-failed" });
      }
    }
    this.commitScan(KEEP_SCAN_KEY, scan.next);
  }

  private async keepLocked(c: PurgeCardLike, projectId: string): Promise<boolean> {
    const p = await this.d.project(projectId);
    if (!p || !keepApplies(c, p) || !p.purgeAfter || !p.archivedAt) return false;
    const from = p.purgeAfter;
    const base = Math.max(from.getTime(), (c.decidedAt ?? c.createdAt).getTime());
    await this.d.lockHeld?.(projectId);
    // Decision 26 (Codex PR240-r22): the write also matches this read's archive, so a Restore and a new Archive with
    // the same purge date in between never lets this rejection postpone the new archive.
    return this.d.keepArchived(p.id, from, new Date(base + KEEP_ARCHIVED_MS), c.id, p.archivedAt);
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
      // Decision 30 (Codex PR240-r26): an approved scheduled card whose purge date has since moved never purges.
      if (dueMoved(c, p)) {
        this.d.log({ level: "info", msg: "teardown-purge-skipped", projectId: pid, approvalId: c.id, code: "purge-card-not-due" });
        continue;
      }
      seen.add(pid);
      await this.runPurge(p, c.id, grant, { createdAt: c.createdAt, archive: cardArchive(c), due: cardDue(c) });
    }
  }

  private async runPurge(p: TeardownProject, approvalId: string, grantId: string, card: { createdAt: Date; archive: string | null; due?: string | null }): Promise<void> {
    const run = this.d.purge(p.id, grantId, card);
    this.purging.add(p.id);
    run.then(() => this.purging.delete(p.id), () => this.purging.delete(p.id));
    let result: PurgeResultLike;
    try {
      result = await withLimit(run, this.d.purgeTimeoutMs ?? PURGE_TIME_LIMIT_MS);
    } catch (e) {
      if (e instanceof PurgeTimeout) {
        // The run goes on under the project lock; its outcome is still reported when it ends (pre-review 4).
        this.d.log({ level: "warn", msg: "teardown-purge-timeout", projectId: p.id, approvalId, code: "teardown-purge-timeout" });
        run.then((r) => this.afterResult(p, approvalId, r), (x) => this.afterError(p, approvalId, grantId, x, card.due ?? null)).catch(() => undefined);
        return;
      }
      await this.afterError(p, approvalId, grantId, e, card.due ?? null);
      return;
    }
    await this.afterResult(p, approvalId, result);
  }

  private async afterError(p: TeardownProject, approvalId: string, grantId: string, e: unknown, due: string | null = null): Promise<void> {
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
      // Decision 17 (Codex PR240-r13): a Restore and a new Archive after this card's read make the authorizer deny the
      // superseded card before any provider call. That is KK's newer word, not a stop: no stop card is raised, so none
      // blocks the new archive's card. A re-read that fails raises the stop card as before.
      const now = await this.d.project(p.id).catch(() => p);
      if (!now || now.stage !== "archived" || now.archivedAt?.getTime() !== p.archivedAt?.getTime()) {
        this.d.log({ level: "info", msg: "teardown-purge-skipped", projectId: p.id, approvalId, code: "archive-superseded" });
        return;
      }
      // Decision 32 (Codex PR240-r28): likewise, a scheduled card whose purge date Keep archived moved after the
      // approved-card pass is denied by the authorizer (decision 30). That is KK's newer word, not a stop: no stop card
      // is raised, so none blocks the card for the new date. A re-read that fails raises the stop card as before.
      // Decision 35 (Codex PR240-r31): only the purge's authorizer check (`policy_denied` or `approval_required`, thrown
      // by purgeProject's `check` before any resource is read or deleted) proves no deletion ran. Any other stop (e.g.
      // `ownership_mismatch` after a resource was deleted) is always reported, even if Keep archived moved the date.
      const denied = stop.code === "policy_denied" || stop.code === "approval_required";
      if (denied && due !== null && due !== (now.purgeAfter?.toISOString() ?? null)) {
        this.d.log({ level: "info", msg: "teardown-purge-skipped", projectId: p.id, approvalId, code: "purge-card-not-due" });
        return;
      }
      this.d.log({ level: "warn", msg: "teardown-purge-stopped", projectId: p.id, approvalId, code });
      // Decision 34 (Codex PR240-r30): the stop carries the card's due date, so if the re-read above failed, delivery's
      // own re-read still drops a stop for a scheduled card whose date Keep archived moved.
      await this.raiseStopped(p, code, denied ? due : null);
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

  private async raiseStopped(p: TeardownProject, code: string, due: string | null = null): Promise<void> {
    // Decision 22 (Codex PR240-r18): a stop for an older archive never replaces one owed for a newer archive (a slow
    // older purge's handler can arrive after the newer one's stop was owed); it is dropped, as in decision 18.
    const owed = this.stopsOwed.get(p.id);
    if (owed?.p.archivedAt && (!p.archivedAt || p.archivedAt.getTime() < owed.p.archivedAt.getTime())) {
      this.d.log({ level: "info", msg: "teardown-purge-skipped", projectId: p.id, code: "archive-superseded" });
    } else {
      this.stopsOwed.set(p.id, { p, code, due, at: this.now() });
    }
    await this.deliverStops();
  }

  private async deliverStops(): Promise<void> {
    for (const [id, o] of this.stopsOwed) {
      try {
        // Decision 18 (Codex PR240-r14): re-read before each try; a stop owed for an archive that has ended is dropped
        // (KK's newer word), never raised. A failed re-read keeps it owed. One that slips in after this read names its
        // archive, so it blocks nothing, and the tick's first pass closes it.
        const fresh = await this.d.project(o.p.id);
        if (!sameArchive(o.p, fresh)) {
          this.dropOwed(id, o);
          this.d.log({ level: "info", msg: "teardown-purge-skipped", projectId: o.p.id, code: "archive-superseded" });
          continue;
        }
        // Decision 34: a stop owed for a scheduled card whose purge date has since moved is KK's newer word (the
        // authorizer's denial followed the move), so it is dropped, never raised.
        if (o.due !== null && o.due !== (fresh?.purgeAfter?.toISOString() ?? null)) {
          this.dropOwed(id, o);
          this.d.log({ level: "info", msg: "teardown-purge-skipped", projectId: o.p.id, code: "purge-card-not-due" });
          continue;
        }
        const card = purgeStoppedCard(o.p, o.code, await this.d.activeCounts(o.p.id));
        // Decision 19 (Codex PR240-r15): the store dedupes on action and target, so it can hand back a pending twin from
        // an earlier archive (decision 18's slipped-in card). That twin does not serve this stop: it is expired (this
        // read proved the archive has moved on from it) and the stop is raised again; if a twin of another archive still
        // comes back, or the expiry fails, the stop stays owed and is retried next tick.
        // Decision 20 (Codex PR240-r16): only a twin of an archive OLDER than this stop's is expired. A twin naming a
        // newer archive means a Restore and a new Archive landed after the re-read and that archive has its own stop: it
        // is never touched, and this stop (for an archive that has ended) is dropped, as in decision 18.
        // Decision 36 (Codex PR240-r32): a twin for this same archive that reports another failure (an earlier stop KK
        // has not answered) does not serve this stop either: it is superseded (expired) and this stop raised, so KK
        // always sees the newest failure. Only a twin with this archive and this failure serves it.
        let raised = await this.d.raise(card);
        if (!this.stopServes(raised, card)) {
          if (typeof (raised as { reason?: unknown } | null)?.reason !== "string") throw new Error("stop-card-not-raised");
          const sameArchiveTwin = this.stopSameArchive(raised, card);
          // Decision 37 (Codex PR240-r33): a same-archive twin is superseded only by the newest stop. A later stop (a
          // timed-out purge finishing meanwhile) replaces this entry in `stopsOwed` before its own delivery writes its
          // card, so a delivery whose entry was replaced, or whose twin was written after this stop was owed, is the
          // older failure: it drops itself and never expires the newer card. Nothing is awaited between this check
          // and the expiry below.
          if (sameArchiveTwin && (this.stopsOwed.get(id) !== o || twinAfter(raised, o.at))) {
            this.dropOwed(id, o);
            this.d.log({ level: "info", msg: "teardown-purge-skipped", projectId: o.p.id, code: "stop-superseded" });
            continue;
          }
          if (!sameArchiveTwin && !twinOlder(raised, o.p)) {
            this.dropOwed(id, o);
            this.d.log({ level: "info", msg: "teardown-purge-skipped", projectId: o.p.id, code: "archive-superseded" });
            continue;
          }
          await this.d.expire([stopId(raised)], sameArchiveTwin ? "stop-card-superseded" : "stop-card-archive-ended");
          raised = await this.d.raise(card);
          if (!this.stopServes(raised, card)) throw new Error("stop-card-other-archive");
        }
        this.dropOwed(id, o);
      } catch {
        this.d.log({ level: "warn", msg: "teardown-card-failed", projectId: o.p.id, code: o.code });
      }
    }
  }

  /**
   * Decision 21 (Codex PR240-r17): a delivery clears only the stop it read. A purge that ends past its limit can owe a
   * stop for a newer archive while an older delivery is still awaiting its read; that newer entry stays owed.
   */
  private dropOwed(id: string, o: { p: TeardownProject; code: string }): void {
    if (this.stopsOwed.get(id) === o) this.stopsOwed.delete(id);
  }

  /**
   * Decision 19: the stored stop card names the same archive as the one built (a twin of another archive does not).
   * Decision 36 (Codex PR240-r32): and the same failure (`stopWhy`), so a pending stop for an earlier failure of this
   * archive never stands in for a new one.
   */
  private stopServes(raised: unknown, card: { reason: string }): boolean {
    const named = (raised as { reason?: unknown } | null)?.reason;
    return this.stopSameArchive(raised, card) && typeof named === "string" && stopWhy(named) === stopWhy(card.reason);
  }

  /** Decision 36: the stored stop card names the same archive as the one built, whatever failure it reports. */
  private stopSameArchive(raised: unknown, card: { reason: string }): boolean {
    const named = (raised as { reason?: unknown } | null)?.reason;
    return typeof named === "string" && cardArchive({ reason: named }) === cardArchive(card);
  }

  /** 4. Decision (b): the daily purge-due run raises a card; it never deletes. */
  private async duePass(): Promise<void> {
    const due = await this.d.listDue(new Date(this.now()), DUE_PAGE);
    let failed = false;
    for (const listed of due) {
      try {
        // M2.5-b5 decision 2 (DEVOS-255, from Codex PR239-r22): the due check and the raise hold the lifecycle lock and use a fresh
        // read of the row, so no card is raised after a Purge (or a Restore and a new Archive) changed it since listDue.
        const id = listed.id;
        // Pre-review 1: a purge of this process still running (maybe past its limit) holds the lock; skip, never queue.
        // Codex PR240-r2: the row is not served yet, so the daily run stays open and a later tick checks it again.
        if (this.purging.has(id)) { failed = true; continue; }
        // Decision 23 (Codex PR240-r19): the locked read must still be the archive listDue saw.
        const raise = () => this.raiseDueLocked(id, listed.archivedAt);
        const locked = this.d.locked;
        if (await (locked ? locked(id, raise) : raise())) this.d.log({ level: "info", msg: "teardown-purge-card", projectId: id });
      } catch {
        failed = true;
        this.d.log({ level: "warn", msg: "teardown-card-failed", projectId: listed.id, code: "purge-due" });
      }
    }
    // Codex PR181-r1: any project whose card could not be raised keeps the daily run open, so the next tick tries again
    // (projects already served are not raised twice: a pending card blocks a second one).
    if (failed) throw new Error("teardown-due-partial");
  }

  /**
   * M2.5-b5 decision 2: re-read under the lock; raise only for a row that is still archived and due now.
   * Decision 23 (Codex PR240-r19): and only for the same archive listDue returned (same `archivedAt`). A row restored
   * and archived again after listDue gets no card from this pass, even if the new archive is already due; the next
   * daily run lists it afresh.
   */
  private async raiseDueLocked(projectId: string, listedArchivedAt: Date | null | undefined): Promise<boolean> {
    const p = await this.d.project(projectId);
    if (!p || p.stage !== "archived" || !p.purgeAfter || p.purgeAfter.getTime() > this.now()) return false;
    if (!listedArchivedAt || p.archivedAt?.getTime() !== listedArchivedAt.getTime()) {
      this.d.log({ level: "info", msg: "teardown-card-skipped", projectId, code: "archive-changed" });
      return false;
    }
    // Decision 6: a card still owed its expiry keeps this row unserved (the daily run stays open).
    this.assertNoUnfenced(p.id);
    if (!(await this.shouldRaise(p))) return false;
    const card = purgeCard(p, await this.d.activeCounts(p.id), { due: p.purgeAfter });
    await this.d.lockHeld?.(p.id);
    await this.raiseFenced(p, card, { due: true });
    return true;
  }

  /**
   * M2.5-b5 decision 5 (Codex PR240-r2): the card is written on another connection than the lock, so after the write
   * the row is read again. If it is no longer this archive (`archived` with the same `archivedAt`), the card just
   * written is expired and nothing is raised. A change after this read gives a newer `archivedAt` than the card's own
   * creation time, so `raisedThisArchive` already refuses the card for that archive.
   */
  private async raiseFenced(p: TeardownProject, card: Parameters<TeardownSweepDeps["raise"]>[0], opts: { due?: boolean } = {}): Promise<{ id: string }> {
    const raised = (await this.d.raise(card)) as { id?: unknown } | null;
    if (!raised || typeof raised.id !== "string") throw new Error("purge-card-not-raised");
    const id = raised.id;
    // Decision 11 (Codex PR240-r7): a deduplicated raise returns the pending twin already stored. If that card names
    // another archive than this raise's, this raise wrote nothing: it is never expired here (it may be the current
    // archive's valid card; a stale one is cleared by the tick's first pass, decision 9), and nothing is raised.
    const named = (raised as { reason?: unknown }).reason;
    if (typeof named === "string" && cardArchive({ reason: named }) !== cardArchive(card)) throw new Error("purge-card-other-archive");
    // Decision 12 (Codex PR240-r8, replaces decision 6's expiry): a re-read that fails proves nothing either way, and
    // the returned card may be another caller's valid twin for this same archive, so it is never expired here. It is
    // safe to leave: it names its archive (decision 8), so it purges only while the row is still in that archive, and
    // if the archive has moved on, the tick's first pass expires it (decision 9). The call still fails.
    const now = await this.d.project(p.id);
    if (!now || now.stage !== "archived" || now.archivedAt?.getTime() !== p.archivedAt?.getTime()) {
      await this.expireCard(id, p.id, "purge-card-stale-archive");
      throw new Error("purge-card-stale-archive");
    }
    // Decision 29 (Codex PR240-r25), as amended by decision 30 (Codex PR240-r26): Keep archived moves `purge_after` but
    // not `archived_at`, so the archive check above cannot see it. A daily card is due only while the fresh read still has
    // the purge date it was raised for. If it moved, a returned card that names this due date (the one this raise wrote,
    // or an identical scheduled twin) is expired; an early ask's card names no due date and is never expired here. If
    // this re-read or the expiry fails, decision 30's cleanup expires the pending card and the approved-card pass and
    // the purge authorizer refuse it, so it never purges. The call fails, so the daily run stays open.
    // Decision 32 (Codex PR240-r28): this holds on every path, the early ask's included. A deduplicated raise can return
    // a same-archive scheduled twin written before Keep archived moved the date; the returned card (the stored twin's
    // text, or this raise's own) is checked against the fresh read, and one whose due date moved is expired and never
    // returned. A returned card with no due stamp, or with the fresh due date, is never expired here.
    const returned = { reason: typeof named === "string" ? named : card.reason };
    if (dueMoved(returned, now)) {
      await this.expireCard(id, p.id, "purge-card-not-due");
      throw new Error("purge-card-not-due");
    }
    if (opts.due && now.purgeAfter?.getTime() !== p.purgeAfter?.getTime()) throw new Error("purge-card-not-due");
    return { id };
  }

  /** Decision 6: expire a card the fence could not prove; one whose expiry fails is owed and retried every tick. */
  private async expireCard(id: string, projectId: string, reason: string): Promise<void> {
    this.unfenced.set(id, projectId);
    try {
      await this.d.expire([id], reason);
      this.unfenced.delete(id);
    } catch {
      this.d.log({ level: "warn", msg: "teardown-card-expiry-failed", projectId, approvalId: id, code: reason });
    }
  }

  private async expireUnfenced(): Promise<void> {
    for (const [id, projectId] of [...this.unfenced]) await this.expireCard(id, projectId, "purge-card-unverified");
  }

  private assertNoUnfenced(projectId: string): void {
    for (const pid of this.unfenced.values()) if (pid === projectId) throw new Error("purge-card-unverified");
  }

  /**
   * One card per `purge_after` period: none while one is pending, an approved one of this archive still has an unspent
   * grant, KK has rejected one (Keep archived), or a stop card is open; re-raised once after an unanswered (expired)
   * one, then nothing.
   */
  private async shouldRaise(p: TeardownProject): Promise<boolean> {
    if (p.stage !== "archived" || !p.purgeAfter) return false;
    // Decision 18: only a stop owed for this same archive holds the card back (deliverStops drops one that has ended).
    const owed = this.stopsOwed.get(p.id);
    if (owed && sameArchive(owed.p, p)) return false;
    const since = p.purgeAfter.getTime();
    const cards = (await this.d.cards({ action: PURGE_ACTION, target: target(p.id), limit: CARD_PAGE })).filter((c) => c.projectId === p.id);
    // Decision 15 (Codex PR240-r11): a pending card that does not name this archive (a stale writer's card whose fence
    // re-read failed, decision 12) does not serve this row: the daily run stays open, the next tick's first pass
    // expires it (decision 9), and the row then gets its card the same day.
    // Decision 24 (Codex PR240-r20): decision 9's cleanup reads one page of pending cards across all projects, so with
    // a page of newer valid cards it may never reach this row's stale one. A pending card of an older archive than
    // this locked, fresh read is therefore expired right here (as the early ask does, decision 13: the lock is checked
    // first), and the current archive's card is raised in the same pass. Only a pending card naming another archive
    // that is not older (another process's, after a lost lock) still keeps the row unserved (decision 15).
    let pending = cards.filter((c) => c.status === "pending");
    const older = pending.filter((c) => !raisedThisArchive(c, p) && olderArchive(c, p));
    // Decision 31 (Codex PR240-r27): a pending scheduled card of this archive whose purge date has moved is expired
    // here too (under the lock), so it never serves the row.
    const notDue = pending.filter((c) => raisedThisArchive(c, p) && dueMoved(c, p));
    if (older.length || notDue.length) {
      await this.d.lockHeld?.(p.id);
      if (older.length) await this.d.expire(older.map((c) => c.id), "purge-card-older-archive");
      if (notDue.length) await this.d.expire(notDue.map((c) => c.id), "purge-card-not-due");
      pending = pending.filter((c) => !older.includes(c) && !notDue.includes(c));
    }
    if (pending.some((c) => !raisedThisArchive(c, p))) throw new Error("purge-card-stale-pending");
    if (pending.length) return false;
    // Decision 10 (Codex PR240-r6): the period counts only this archive's cards (decision 8's stamp), so a stale
    // card's rejection or 7-day expiry never suppresses or uses up the current archive's raises.
    const period = cards.filter((c) => c.createdAt.getTime() >= since && raisedThisArchive(c, p));
    if (period.some((c) => c.status === "rejected")) return false;
    // Decision 31: an approval that can no longer purge (its purge date moved) never holds back a new card.
    for (const c of cards.filter((x) => x.status === "approved" && liveCard(x, p))) {
      if (await this.d.unspentGrant(c.id, new Date(this.now()))) return false;
    }
    // Decision 18 (Codex PR240-r14): only a pending stop card naming this archive blocks it; another archive's is closed
    // by the tick's first pass.
    const stops = await this.d.cards({ status: "pending", action: PURGE_STOPPED_ACTION, target: target(p.id), limit: CARD_PAGE });
    if (stops.some((c) => c.projectId === p.id && raisedThisArchive(c, p))) return false;
    // Decision 7 (Codex PR240-r3): only a card KK left unanswered for its whole 7-day window counts against the
    // re-raise; a card expired early (a stale or unproven card, a Restore) was never his to answer.
    return period.filter((c) => c.status === "expired" && unanswered(c)).length < MAX_UNANSWERED;
  }

  /**
   * M2.5-b3 (DEVOS-246): the pending purge card of the project's current archive, for the panel's link to the inbox.
   * A card from an earlier archive is not shown (approving it would never purge, pre-review 1 of M2.5-b2).
   */
  async pendingCard(p: TeardownProject): Promise<string | null> {
    if (p.stage !== "archived") return null;
    const pending = await this.d.cards({ status: "pending", action: PURGE_ACTION, target: target(p.id), limit: CARD_PAGE });
    // Decision 31: nor one whose purge date has moved (the authorizer would refuse it).
    return pending.find((c) => c.projectId === p.id && liveCard(c, p) && !this.unfenced.has(c.id))?.id ?? null;
  }

  /**
   * M2.5-b3 decision 2 (DEVOS-246): KK's early ask ("Ask to delete now"). It only raises the same purge card as the
   * daily run; nothing is deleted until KK approves that card with its typed confirmation. A pending card of this
   * archive is returned as is; one from an earlier archive is closed first; an approved card whose grant is still
   * unspent (and whose purge has not stopped for good), or a purge still running, means a purge is already queued. Raised before `purge_after`, a rejected card leaves `purge_after` alone
   * (keepArchivedPass), and the daily run counts only cards raised in its own period, so an early ask never uses up
   * the daily run's raises.
   */
  async askPurge(projectId: string): Promise<{ ok: true; approvalId: string; raised: boolean } | { ok: false; code: string }> {
    // M2.5-b5 decision 1 (DEVOS-255, from Codex PR239-r21): the stage check and the raise hold the lifecycle lock, so a card is never
    // persisted after a Purge (or Restore) has moved the project out of `archived`.
    // Pre-review 1: answered before the lock, so the request never waits on this process's own running purge.
    if (this.purging.has(projectId)) return { ok: false, code: "purge-already-approved" };
    const locked = this.d.locked;
    return locked ? locked(projectId, () => this.askPurgeLocked(projectId)) : this.askPurgeLocked(projectId);
  }

  private async askPurgeLocked(projectId: string): Promise<{ ok: true; approvalId: string; raised: boolean } | { ok: false; code: string }> {
    const p = await this.d.project(projectId);
    if (!p) return { ok: false, code: "project-not-found" };
    if (p.stage !== "archived" || !p.archivedAt) return { ok: false, code: "not_archived" };
    // Decision 6: a card still owed its expiry is never handed to KK, and no new one is raised beside it.
    this.assertNoUnfenced(p.id);
    const cards = (await this.d.cards({ action: PURGE_ACTION, target: target(p.id), limit: CARD_PAGE })).filter((c) => c.projectId === p.id);
    const pending = cards.filter((c) => c.status === "pending");
    // Decision 31 (Codex PR240-r27): only a card that can still purge is handed out.
    const current = pending.find((c) => liveCard(c, p));
    if (current) {
      // Decision 16 (Codex PR240-r12): an existing card is handed out only behind the same fence as a new one: the lock
      // is still ours and a fresh read still shows this archive. Otherwise nothing is returned and nothing is expired
      // (the card is not this call's; if the archive moved on, the tick's first pass expires it, decision 9).
      await this.d.lockHeld?.(p.id);
      const again = await this.d.project(p.id);
      if (!again || again.stage !== "archived" || again.archivedAt?.getTime() !== p.archivedAt.getTime()) throw new Error("purge-card-stale-archive");
      if (dueMoved(current, again)) throw new Error("purge-card-not-due");
      return { ok: true, approvalId: current.id, raised: false };
    }
    if (this.purging.has(p.id)) return { ok: false, code: "purge-already-approved" };
    for (const c of cards.filter((x) => x.status === "approved" && liveCard(x, p))) {
      // Pre-review 1: an approval whose purge stopped for good never runs again, so it does not block a new card.
      if (this.stopped.has(c.id)) continue;
      if (await this.d.unspentGrant(c.id, new Date(this.now()))) {
        return { ok: false, code: this.waitForDaily.has(c.id) ? "purge-waits-for-daily-run" : "purge-already-approved" };
      }
    }
    // Decision 13 (Codex PR240-r9): the lock is checked before anything is written, the expiry included, and only a card
    // of an archive older than this read's is expired. A card naming a later archive (raised by another process after
    // a lost lock) is left alone; the raise below then dedupes onto it and fails without expiring it (decision 11).
    await this.d.lockHeld?.(p.id);
    const older = pending.filter((c) => olderArchive(c, p));
    if (older.length) await this.d.expire(older.map((c) => c.id), "purge-card-older-archive");
    // Decision 31: a pending scheduled card of this archive whose purge date moved is expired first, so the raise below
    // never dedupes onto it and hands KK a card the authorizer would refuse.
    const notDue = pending.filter((c) => raisedThisArchive(c, p) && dueMoved(c, p));
    if (notDue.length) await this.d.expire(notDue.map((c) => c.id), "purge-card-not-due");
    const next = purgeCard(p, await this.d.activeCounts(p.id));
    // Decision 4: the lock is still ours right before the write, or nothing is raised.
    await this.d.lockHeld?.(p.id);
    const card = await this.raiseFenced(p, next);
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

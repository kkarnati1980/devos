// DEVOS-228 (M2.4-d3b, docs/modules/M2.4.md "Part 2"): the AT13 live probe's phase machine.
// One call to `probeStep` advances at most one phase, so each server-agent tick fits its 120 s check limit.
// Every effect is injected (provisioning, inventory, live asserts, purge, the phase log), so the order and
// the outcomes are tested without GitHub or Coolify. Output is fixed codes only: never a provider message.

export const PROBE_SLUG = "devos-probe-m24";
export const PROBE_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
/** A run or purge still "in progress" after this long ends the cycle (`<phase>-timeout`), so a stuck provider never hides. */
export const PROBE_PHASE_MAX_MS = 2 * 60 * 60 * 1000;
/** DEVOS-254 decision 5: how long a card cycle waits for KK's answer (the card itself expires after 7 days). */
export const PROBE_CARD_MAX_MS = 8 * 24 * 60 * 60 * 1000;
/**
 * Codex PR239-r7 (DEVOS-254 decision 11): a card cycle starts only while a probe grant stays valid this long, and its
 * card is raised only while one stays valid `PROBE_CARD_RAISE_GRANT_MS` from then, so the probe can still purge after
 * the longest card wait. The extra day covers the tick after the bound (the check runs at least every 6 h) and the
 * purge itself (`PROBE_PHASE_MAX_MS`); the start adds one more day for the phases before `card`.
 */
export const PROBE_CARD_RAISE_GRANT_MS = PROBE_CARD_MAX_MS + 24 * 60 * 60 * 1000;
/** Codex PR239-r13 (decision 13): the room a waiting tick needs left on the probe grant: the next tick and the purge. */
export const PROBE_CARD_PURGE_ROOM_MS = PROBE_CARD_RAISE_GRANT_MS - PROBE_CARD_MAX_MS;
export const PROBE_CARD_START_GRANT_MS = PROBE_CARD_RAISE_GRANT_MS + 24 * 60 * 60 * 1000;
/** DEVOS-254 decision 1: the result code of a cycle whose purge went through KK's approved purge card. */
export const PASS_CARD = "pass-card";

// DEVOS-254 (M2.5-b4): `card` and `cardwait` run only in a card cycle (`viaCard`), between `assert` and `purge`.
export const PHASES = ["run1", "inventory1", "run2", "inventory2", "assert", "card", "cardwait", "purge", "done"] as const;
export type Phase = (typeof PHASES)[number];

/** One inventory row, as AT13 compares it (key, provider, external id, name). */
export interface InventoryRow { key: string; provider: string; externalId: string; name: string }

/** The newest phase record of the current cycle (stored as an audit row `provision.probe_phase`). */
export interface PhaseRecord {
  cycle: number;
  phase: Phase;
  at: string; // ISO time the phase was entered
  fingerprint: string; // hash of the provisioning code in the image when the cycle started
  inventory1?: InventoryRow[];
  /** DEVOS-21 part 13: the provider refusal (`purge-permission:<provider>/<kind>…`) the cycle before this one ended with, if any. */
  refusalRetry?: string;
  /** DEVOS-254: this cycle purges through KK's purge card (AT10), set when the cycle starts. */
  viaCard?: boolean;
  /** DEVOS-254: the purge card the `card` phase raised. */
  cardId?: string;
  /**
   * Codex PR239-r15: set when a card cycle leaves `card` or `cardwait` for the probe's own purge. The purge phase then
   * first expires the probe's pending purge cards (`expirePurgeCards`), so KK never sees a pending request for a purge
   * the probe already did, and no stale card is left for the next cycle's dedupe.
   */
  expireCards?: boolean;
  /** Codex PR239-r15: the purge went ahead without that expiry, because the probe grant would not outlast more retries. */
  cardExpireGaveUp?: boolean;
  /** Codex PR239-r25: `cardwait` saw the sweep's purge under KK's approved card (AT10's proof); only the expiry is left. */
  cardProven?: boolean;
  /**
   * Codex PR239-r26: recorded with `cardProven`, the start the 8-day wait was measured from (the earlier of the card's
   * raise and the `cardwait` record), so the expiry retries keep the deadline the original raise set.
   */
  cardWaitFrom?: string;
  result?: { ok: boolean; code: string; detail?: string; cause?: string; causeDetail?: string };
}

export type RunOutcome = "done" | "in_progress" | { error: string };
export type PurgeOutcome = "done" | "in_progress" | { error: string };
/** DEVOS-254 decision 4: the probe row's stage and the purge card's status (`missing` when the card is gone). */
export interface CardOutcome {
  stage: string;
  card: "pending" | "approved" | "rejected" | "expired" | "missing";
  decidedAt?: string | null;
  /** Codex PR239-r12: the tracked card's `created_at` (ISO), or null when it reads as missing. */
  raisedAt?: string | null;
  /** Codex PR239-r1: every allowed purge decision since the card was raised ran under this card's grant (and one did). */
  byCard?: boolean;
}

export interface ProbeDeps {
  /** null when the sweep is off (provisionConfig / vault): the probe is skipped. */
  offReason(): Promise<string | null>;
  last(): Promise<PhaseRecord | null>;
  record(r: PhaseRecord): Promise<void>;
  /** Ensure the probe project exists (cap 0) and run provisioning once for it, resumably. */
  provisionOnce(): Promise<RunOutcome>;
  inventory(): Promise<InventoryRow[]>;
  /** AT13's live asserts; each failure is a fixed code. */
  liveAsserts(): Promise<string[]>;
  /**
   * d3c-2a decisions 4 and 5: checked only when a new cycle would start. `{ blocked }` skips (exit 3, nothing created);
   * `purge-pending` starts the cycle with the purge (an earlier purge did not finish). Absent means "ready".
   */
  cycleStart?(): Promise<"ready" | "purge-pending" | { blocked: string }>;
  /** M2.5 purge over the recorded ids only. */
  purge(): Promise<PurgeOutcome>;
  /**
   * DEVOS-21 (decision "re-run on a new key"): the newest `updatedAt` (ISO) of the provider tokens the probe uses, or
   * null when none is set or it cannot be read. Checked only when the newest cycle is done and failed: a token saved
   * after that cycle ended starts the next cycle at once. Absent means the 7-day rule alone.
   */
  credentialsUpdatedAt?(): Promise<string | null>;
  /** DEVOS-254 decision 1: true while no cycle has ended `pass-card`, so the next cycle purges through KK's card. */
  cardCycle?(): Promise<boolean>;
  /**
   * DEVOS-254 decision 3: archive the probe project (unless archived) and raise the M2.5-b2 purge card; its id (the card
   * this archive already has, on a retried tick). `{ grantShort }` when no card was raised for decision 11.
   */
  raisePurgeCard?(): Promise<string | { grantShort: true }>;
  /** DEVOS-254 decision 4: one read of the probe row's stage and the card's status. */
  cardOutcome?(cardId: string): Promise<CardOutcome>;
  /** Codex PR239-r7: true when a probe grant with every use the cycle may still spend is valid at `until` (decision 11). */
  cardGrantOutlasts?(until: Date): Promise<boolean>;
  /**
   * Codex PR239-r15: expire every pending `teardown.purge` card of the probe project (any archive). Resolves only once
   * none is left pending; throws otherwise.
   */
  expirePurgeCards?(): Promise<void>;
  fingerprint: string;
  now(): Date;
}

/** exit 0 pass, 1 fail, 3 skipped / in progress (the server agent's codes). */
/** `cause`/`causeDetail` (DEVOS-21 diagnostics): the earlier failure a failed purge ended, so one check line names both. */
export interface ProbeTick { exit: 0 | 1 | 3; phase: Phase | "idle"; cycle: number; code: string; detail?: string; cause?: string; causeDetail?: string }

const full = (r: InventoryRow) => `${r.provider}\u0000${r.externalId}\u0000${r.name}`;

/**
 * The first difference between two inventories (by step key, in key order), or null when they are equal row
 * for row. A key that appears twice in one run is itself a difference (`duplicate:`).
 */
export function inventoryDiff(a: InventoryRow[], b: InventoryRow[]): string | null {
  const index = (rows: InventoryRow[], run: string): Map<string, string> | string => {
    const m = new Map<string, string>();
    for (const r of rows) {
      if (m.has(r.key)) return `duplicate-in-${run}:${r.key}`;
      m.set(r.key, full(r));
    }
    return m;
  };
  const x = index(a, "run1"), y = index(b, "run2");
  if (typeof x === "string") return x;
  if (typeof y === "string") return y;
  for (const k of [...new Set([...x.keys(), ...y.keys()])].sort()) {
    if (!y.has(k)) return `missing-in-run2:${k}`;
    if (!x.has(k)) return `extra-in-run2:${k}`;
    if (x.get(k) !== y.get(k)) return `differs:${k}`;
  }
  return null;
}

/**
 * Codex PR164-r2: the first incomplete row of one read, or null. A done step without an external id, or without an
 * active resource row behind it (an empty name), is a gap; the same gap in both reads would compare equal, so each
 * read is checked on its own before the compare. Checked in key order, so the row named is stable.
 */
export function inventoryIncomplete(rows: InventoryRow[]): string | null {
  for (const r of [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    if (r.externalId === "") return `no-external-id:${r.key}`;
    if (r.name === "") return `no-active-resource:${r.key}`;
  }
  return null;
}

function nextPhase(p: Phase): Phase {
  return PHASES[Math.min(PHASES.indexOf(p) + 1, PHASES.length - 1)] ?? "done";
}

/** A teardown call a provider refused, as `purgeStop` names it (part 12): `purge-permission:coolify/application:delete:http-403`. */
const PROVIDER_REFUSAL = /^purge-permission:(?:github|coolify)\/[a-z0-9_]{1,40}(?::|$)/;

/** The provider refusal a done cycle ended with, or undefined. */
function refusalOf(last: PhaseRecord): string | undefined {
  const r = last.result;
  return r?.ok === false && r.code === "purge-failed" && PROVIDER_REFUSAL.test(r.detail ?? "") ? r.detail : undefined;
}

async function due(last: PhaseRecord, d: ProbeDeps): Promise<boolean> {
  if (last.fingerprint !== d.fingerprint) return true;
  if (d.now().getTime() - Date.parse(last.at) >= PROBE_EVERY_MS) return true;
  // DEVOS-254 decision 1: the first card cycle is due on the next check run after a passed non-card cycle. A failed
  // cycle, card or not, waits the rules below (pre-review 1: a failing cleanup purge must not repeat on every check
  // run, spending KK's probe grant), so a card is raised at most once per cycle.
  if (last.result?.ok === true && !last.viaCard && (await isCardCycle(d))) return true;
  // DEVOS-21: a cycle that only purged an earlier cycle's leftovers (its purge passed) tested nothing, so the real
  // cycle is due on the next check run. If that purge had failed, the code would be `purge-failed`, which waits
  // (except a provider refusal, part 13, below).
  if (last.result?.ok === false && last.result.code === "previous-purge-pending") return true;
  // DEVOS-21 part 13: a purge that a provider refused (`purge-permission:<provider>/<kind>:...`) is fixed on the
  // provider side, often by editing the existing token's permissions, which no vault save records. Such a cycle is
  // due on the next check run (a new SHA, the 6-hour timer or a `/recheck`), so the fix is tested at once. It
  // starts with the purge again and creates nothing; if the refusal repeats it ends the same way, bounded by that
  // cadence. Once per refusal (Codex pre-review 1): each purge spends uses of KK's probe grant, so a cycle that already
  // followed the same refusal waits for the earlier rules. A preflight refusal, a lapsed grant or a bare code also waits.
  const refusal = refusalOf(last);
  if (refusal !== undefined && last.refusalRetry !== refusal) return true;
  // DEVOS-21: a failed cycle is re-run as soon as KK saves a new provider token after it ended (a passed cycle waits
  // the 7 days). A read that throws, or a time that is not a valid ISO date, keeps the 7-day rule.
  if (last.result?.ok !== false || !d.credentialsUpdatedAt) return false;
  let u: string | null;
  try { u = await d.credentialsUpdatedAt(); } catch { return false; }
  const t = u === null ? NaN : Date.parse(u);
  return Number.isFinite(t) && t > Date.parse(last.at);
}

/**
 * DEVOS-254 decision 1: a read that throws, or a probe without the card wiring, is a normal cycle. Decision 11 (Codex
 * PR239-r7): so is one whose probe grant would lapse before a card left unanswered could still be purged.
 */
async function isCardCycle(d: ProbeDeps): Promise<boolean> {
  if (!d.cardCycle || !d.raisePurgeCard || !d.cardOutcome || !d.cardGrantOutlasts || !d.expirePurgeCards) return false;
  try {
    if ((await d.cardCycle()) !== true) return false;
    return (await d.cardGrantOutlasts(new Date(d.now().getTime() + PROBE_CARD_START_GRANT_MS))) === true;
  } catch { return false; }
}

const CARD_WORD = /^[a-z_]{1,20}$/;

/** Runs one effect; a throw becomes `{ thrown: true }` (its message is never kept: it may quote a provider body). */
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try { return { ok: true, value: await fn() }; } catch { return { ok: false }; }
}

/**
 * Advances the probe by at most one phase and writes at most one phase row per call (so two rows of one call
 * can never tie on `occurredAt`, pre-review L2). Any failure it can see before `purge` goes to `purge` with its
 * fixed code, so the probe never leaves resources behind; a run or purge still in progress, or throwing, for
 * PROBE_PHASE_MAX_MS ends the cycle (pre-review M1).
 */
export async function probeStep(d: ProbeDeps): Promise<ProbeTick> {
  const off = await d.offReason();
  if (off) return { exit: 3, phase: "idle", cycle: 0, code: "skipped", detail: off };
  const last = await d.last();
  const at = () => d.now().toISOString();

  if (!last || (last.phase === "done" && (await due(last, d)))) {
    const start = d.cycleStart ? await d.cycleStart() : "ready";
    if (typeof start === "object") return { exit: 3, phase: "idle", cycle: last?.cycle ?? 0, code: "skipped", detail: start.blocked };
    const cycle = (last?.cycle ?? 0) + 1;
    const refusal = last ? refusalOf(last) : undefined;
    const mark = refusal !== undefined ? { refusalRetry: refusal } : {};
    if (start === "purge-pending") {
      // d3c-2a decision 4: the earlier cycle's resources are purged first; the cycle reports that, never a pass.
      await d.record({ cycle, phase: "purge", at: at(), fingerprint: d.fingerprint, ...mark, result: { ok: false, code: "previous-purge-pending" } });
      return { exit: 3, phase: "purge", cycle, code: "in_progress" };
    }
    const card = (await isCardCycle(d)) ? { viaCard: true } : {};
    await d.record({ cycle, phase: "run1", at: at(), fingerprint: d.fingerprint, ...mark, ...card });
    return { exit: 3, phase: "run1", cycle, code: "in_progress" };
  }
  if (last.phase === "done") {
    // Reported once when it finished; later ticks are skipped until the next cycle is due.
    return { exit: 3, phase: "done", cycle: last.cycle, code: "probed", detail: last.result?.code };
  }

  const { cycle, phase } = last;
  const timedOut = () => d.now().getTime() - Date.parse(last.at) >= PROBE_PHASE_MAX_MS;
  const failed = (code: string, detail?: string) => ({ ok: false, code, detail });
  const toPurge = async (result: { ok: boolean; code: string; detail?: string }): Promise<ProbeTick> => {
    await d.record({ ...last, phase: "purge", at: at(), result });
    return { exit: 3, phase: "purge", cycle, code: "in_progress" };
  };
  // Codex PR239-r15 (medium): every way out of `card` and `cardwait` to the probe's own purge first expires the probe's
  // pending purge cards (in the purge phase, `expireCards`), so a card persisted by a throwing tick is never left
  // pending behind the fallback purge, however far apart the server checks run.
  const leaveCard = async (result: { ok: boolean; code: string; detail?: string }): Promise<ProbeTick> => {
    await d.record({ ...last, phase: "purge", at: at(), result, expireCards: true });
    return { exit: 3, phase: "purge", cycle, code: "in_progress" };
  };
  const advance = async (extra: Partial<PhaseRecord> = {}): Promise<ProbeTick> => {
    const to = nextPhase(phase);
    await d.record({ ...last, ...extra, phase: to, at: at() });
    return { exit: 3, phase: to, cycle, code: "in_progress" };
  };
  const finish = async (ok: boolean, code: string, detail?: string, cause?: { code: string; detail?: string }, extra: Partial<PhaseRecord> = {}): Promise<ProbeTick> => {
    const why = cause ? { cause: cause.code, ...(cause.detail !== undefined ? { causeDetail: cause.detail } : {}) } : {};
    const result = { ok, code, ...(detail !== undefined ? { detail } : {}), ...why };
    await d.record({ ...last, ...extra, phase: "done", at: at(), result });
    return { exit: ok ? 0 : 1, phase: "done", cycle, code, detail, ...why };
  };

  // Pre-review L3: a deploy that changed the provisioning code mid-cycle makes the compare meaningless. DEVOS-254
  // decision 6: the card phases come after the compare, so a deploy while KK's card waits does not end the cycle.
  if (last.fingerprint !== d.fingerprint && phase !== "purge" && phase !== "card" && phase !== "cardwait") return toPurge(failed("fingerprint-changed"));

  switch (phase) {
    case "run1":
    case "run2": {
      const r = await attempt(() => d.provisionOnce());
      const v = r.ok ? r.value : "in_progress";
      if (v === "done") return advance();
      if (v === "in_progress" && !timedOut()) return { exit: 3, phase, cycle, code: "in_progress" };
      // Purge whatever the failed run created, then report the run's failure (kept in the record).
      return toPurge(failed(`${phase}-failed`, v === "in_progress" ? "timeout" : v.error));
    }
    case "inventory1": {
      const r = await attempt(() => d.inventory());
      if (!r.ok) return toPurge(failed("inventory1-failed", "error"));
      const gap = inventoryIncomplete(r.value);
      return gap ? toPurge(failed("inventory-incomplete", `run1:${gap}`)) : advance({ inventory1: r.value });
    }
    case "inventory2": {
      const r = await attempt(() => d.inventory());
      if (!r.ok) return toPurge(failed("inventory2-failed", "error"));
      const gap = inventoryIncomplete(r.value);
      if (gap) return toPurge(failed("inventory-incomplete", `run2:${gap}`));
      const diff = inventoryDiff(last.inventory1 ?? [], r.value);
      // A failed compare still purges the probe's resources: the failure is kept in the record.
      return diff ? toPurge(failed("inventory-differs", diff)) : advance();
    }
    case "assert": {
      const r = await attempt(() => d.liveAsserts());
      if (!r.ok) return toPurge(failed("live-assert-failed", "error"));
      if (r.value.length) return toPurge(failed("live-assert-failed", r.value.join(",")));
      // DEVOS-254 decision 2: only a card cycle goes through `card`; any other cycle purges at once, as before.
      if (last.viaCard) return advance();
      await d.record({ ...last, phase: "purge", at: at() });
      return { exit: 3, phase: "purge", cycle, code: "in_progress" };
    }
    case "card": {
      // Decision 3: archive, then raise KK's purge card; a failure is purged by the probe itself.
      if (!d.raisePurgeCard) return leaveCard(failed("card-not-wired"));
      const r = await attempt(() => d.raisePurgeCard!());
      // Decision 11 (Codex PR239-r7/r8): no new card unless the probe's grant outlasts the wait and the purge after it.
      if (r.ok && typeof r.value === "object" && r.value !== null && r.value.grantShort === true) return leaveCard(failed("card-grant-short"));
      // Codex PR239-r14 (medium): a throw may come after the card was persisted (the reads that bind and track it), so
      // the tick is retried in `card`, whose lookup then finds that card (r1), rather than leaving for a fallback purge
      // while it is pending. Only after `PROBE_PHASE_MAX_MS` in `card` (the bound every phase has) is it purged.
      if (!r.ok) return timedOut() ? leaveCard(failed("card-raise-failed", "timeout")) : { exit: 3, phase, cycle, code: "in_progress", detail: "card-raise-retry" };
      if (typeof r.value !== "string" || r.value === "") return leaveCard(failed("card-raise-failed"));
      await d.record({ ...last, phase: "cardwait", at: at(), cardId: r.value });
      return { exit: 3, phase: "cardwait", cycle, code: "in_progress" };
    }
    case "cardwait": {
      // Decisions 4 and 5: wait for KK's answer and the sweep's purge; every other end is purged by the probe.
      if (!d.cardOutcome || !last.cardId) return leaveCard(failed("card-not-wired"));
      const cardId = last.cardId;
      // Codex PR239-r13 (medium): every tick that would keep waiting first checks that the probe grant still outlasts
      // the next tick and the purge after it (`PROBE_CARD_PURGE_ROOM_MS`). A wait whose deadline moved (a card reused
      // after a failed record, then an unreadable raise time) can therefore never outrun the grant the fallback purge
      // needs; a short grant, or a check that fails, ends the wait with the probe's own purge (`card-grant-short`).
      const wait = async (detail: string): Promise<ProbeTick> => {
        const g = await attempt(async () => (d.cardGrantOutlasts ? (await d.cardGrantOutlasts(new Date(d.now().getTime() + PROBE_CARD_PURGE_ROOM_MS))) === true : false));
        if (!g.ok || g.value !== true) return leaveCard(failed("card-grant-short", detail));
        return { exit: 3, phase, cycle, code: "in_progress", detail };
      };
      // Codex PR239-r25 (medium): once the proof was seen and recorded, later ticks only retry the expiry; the proof
      // is never read again, so a failing read or a short grant cannot lose it.
      if (last.cardProven) {
        const post = await attempt(async () => { if (d.expirePurgeCards) await d.expirePurgeCards(); });
        // Codex PR239-r26 (medium): measured from the wait's recorded start, never from a later record time alone.
        const from = typeof last.cardWaitFrom === "string" ? Date.parse(last.cardWaitFrom) : NaN;
        const lateProof = d.now().getTime() - (Number.isFinite(from) && from < Date.parse(last.at) ? from : Date.parse(last.at)) >= PROBE_CARD_MAX_MS;
        if (!post.ok && !lateProof) return { exit: 3, phase, cycle, code: "in_progress", detail: "card-expire-after-purge" };
        return finish(true, PASS_CARD);
      }
      const r = await attempt(() => d.cardOutcome!(cardId));
      // Codex PR239-r12 (medium): the 8-day wait runs from the earlier of the card's raise and the tick that recorded
      // it. A card raised by a tick that failed to record `cardwait` and reused later keeps its own deadline, so the
      // wait never outruns the grant checked when it was raised (decision 11).
      const raised = r.ok && typeof r.value.raisedAt === "string" ? Date.parse(r.value.raisedAt) : NaN;
      const recorded = Date.parse(last.at);
      const start = Number.isFinite(raised) && raised < recorded ? raised : recorded;
      const late = d.now().getTime() - start >= PROBE_CARD_MAX_MS;
      if (!r.ok) return late ? leaveCard(failed("card-timeout", "error")) : wait("card-unreadable");
      const o = r.value;
      // AT10: purged by the sweep under KK's approved card. A purge with no approved card is not that proof.
      if (o.stage === "purged") {
        if (o.card !== "approved") return finish(false, "card-ended", `${CARD_WORD.test(o.card) ? o.card : "unknown"}:purged`);
        // Codex PR239-r1 (high): purged, but not provably under this card's grant, is not AT10's proof.
        if (o.byCard !== true) return finish(false, "card-unproven");
        // Codex PR239-r23 (medium, DEVOS-254 decision 22): KK could ask again between his approval and the sweep's
        // purge, so a pass first expires the probe's pending purge cards (decision 20's rule, on this path too). Once
        // purged no card can follow (M2.5-b5, DEVOS-255). A failed expiry waits within the 8-day bound; past it the
        // cycle passes and the sweep's `project-not-archived` pass expires the card.
        if (d.expirePurgeCards) {
          const post = await attempt(() => d.expirePurgeCards!());
          // Codex PR239-r24: the row is already purged, so no fallback purge can follow and the grant is not checked;
          // a plain wait keeps the proof already seen.
          if (!post.ok && !late) {
            // Codex PR239-r25: the proof is recorded first, so the retries never read the card again.
            // Codex PR239-r26: with the wait's effective start, so the retries keep the original raise's deadline.
            await d.record({ ...last, cardProven: true, cardWaitFrom: new Date(start).toISOString() });
            return { exit: 3, phase, cycle, code: "in_progress", detail: "card-expire-after-purge" };
          }
        }
        return finish(true, PASS_CARD);
      }
      if (o.stage === "archived" && o.card === "pending") return late ? leaveCard(failed("card-timeout")) : wait("awaiting-card");
      if (o.stage === "archived" && o.card === "approved") {
        const t = typeof o.decidedAt === "string" ? Date.parse(o.decidedAt) : NaN;
        const purging = Number.isFinite(t) && d.now().getTime() - t < PROBE_PHASE_MAX_MS;
        return purging && !late ? wait("card-approved") : leaveCard(failed("card-purge-unfinished"));
      }
      if (o.card === "rejected" || o.card === "expired") return leaveCard(failed(`card-${o.card}`));
      const words = [o.card, o.stage].map((w) => (typeof w === "string" && CARD_WORD.test(w) ? w : "unknown"));
      return leaveCard(failed("card-ended", words.join(":")));
    }
    case "purge": {
      // Codex PR239-r15/r16: a purge that follows a card first expires the probe's pending purge cards (`expireCards`).
      let restart: Partial<PhaseRecord> | undefined;
      if (last.expireCards) {
        const e = await attempt(async () => { if (!d.expirePurgeCards) throw new Error("not-wired"); await d.expirePurgeCards(); });
        if (!e.ok) {
          // Held on later ticks while the probe grant still outlasts the next tick and the purge after it
          // (`PROBE_CARD_PURGE_ROOM_MS`, decision 13); then the purge goes ahead, so the resources are still removed.
          const g = await attempt(async () => (d.cardGrantOutlasts ? (await d.cardGrantOutlasts(new Date(d.now().getTime() + PROBE_CARD_PURGE_ROOM_MS))) === true : false));
          if (g.ok && g.value === true) return { exit: 3, phase, cycle, code: "in_progress", detail: "card-expire-retry" };
        }
        // Codex PR239-r16 (2 medium): expired or given up, the purge starts in this same tick, while the grant that
        // was just checked is still valid, and its `PROBE_PHASE_MAX_MS` bound runs from this tick, never from the row
        // written before the expiry and its retries. The one row this call writes (pre-review L2) carries the restart.
        restart = { at: at(), expireCards: false, ...(e.ok ? {} : { cardExpireGaveUp: true }) };
      }
      const r = await attempt(() => d.purge());
      const v = r.ok ? r.value : "in_progress";
      const earlier = last.result && !last.result.ok ? last.result : undefined;
      if (v === "in_progress" && (restart || !timedOut())) {
        if (restart) await d.record({ ...last, ...restart });
        return { exit: 3, phase, cycle, code: "in_progress", ...(restart?.cardExpireGaveUp ? { detail: "card-expire-gave-up" } : {}) };
      }
      // Pre-review L1: the earlier failure stays in the done row as `cause`.
      if (v !== "done") return finish(false, "purge-failed", v === "in_progress" ? (r.ok ? "timeout" : "error-timeout") : v.error, earlier, restart);
      // Codex PR239-r20 (medium, DEVOS-254 decision 20): KK's "Ask to delete now" could raise a fresh purge card after the
      // expiry above and before the purge moved the row out of `archived`. Once purged (no new card can be asked for),
      // a card cycle expires the probe's pending purge cards once more. A failed expiry is retried on later ticks
      // within the phase bound (the purge itself is then a no-op `done`), unless the expiry before the purge was already
      // given up (decision 15); past it the cycle ends as it would have, and
      // the sweep, which is on whenever "Ask to delete now" is offered, expires the card (`project-not-archived`).
      if (last.viaCard && d.expirePurgeCards) {
        const post = await attempt(() => d.expirePurgeCards!());
        const gaveUp = restart?.cardExpireGaveUp === true || last.cardExpireGaveUp === true;
        if (!post.ok && !gaveUp && (restart || !timedOut())) {
          if (restart) await d.record({ ...last, ...restart });
          return { exit: 3, phase, cycle, code: "in_progress", detail: "card-expire-after-purge" };
        }
      }
      // Codex PR239-r17 (medium): a card cycle whose sweep purge under KK's approved card finished after `cardwait` gave
      // up on it (`card-purge-unfinished`, then the sweep completed before this tick) is AT10's proof after all. The
      // tracked card is read once more; only a purged row whose every allowed purge decision ran under an approved
      // card's grant (`byCard`, r1) passes. A purge by the probe itself is under its own grant, so it never does.
      if (last.viaCard && last.cardId && d.cardOutcome) {
        const id = last.cardId;
        const o = await attempt(() => d.cardOutcome!(id));
        if (o.ok && o.value.stage === "purged" && o.value.card === "approved" && o.value.byCard === true) return finish(true, PASS_CARD, undefined, undefined, restart);
      }
      if (earlier) return finish(false, earlier.code, earlier.detail, undefined, restart);
      return finish(true, "pass", undefined, undefined, restart);
    }
    default:
      return { exit: 1, phase, cycle, code: "unknown-phase" };
  }
}

/**
 * The probe project's row: paused from creation, so the provisioning sweep (which lists only unpaused
 * `provisioning` projects) never picks it; only the probe runs provisioning for it. It makes no model call, so its cap
 * is the smallest one the `project_cap_positive` CHECK (`cap_usd > 0`) allows: $0.000001, the least Decimal(12,6)
 * holds. The first server run (aace3de, 22 Nov 2026) showed a cap of 0 is refused by that CHECK (`probe-error`).
 */
export const PROBE_PROJECT_DATA = {
  slug: PROBE_SLUG,
  name: "DevOS provisioning probe (AT13)",
  capUsd: "0.000001",
  continuousRun: false,
  preflightState: "approved",
} as const;

/** Find or create the probe project; only that row is written. Bounded like every DevOS DB call (ADR-0011 §9). */
export async function ensureProbeProject(db: any, now: Date, timeoutMs: number): Promise<{ id: string; slug: string; name: string }> {
  return db.$transaction(async (tx: any) => {
    const found = await tx.project.findUnique({ where: { slug: PROBE_SLUG }, select: { id: true, slug: true, name: true, pausedAt: true } });
    if (found) {
      // Pre-review M2: only a row the probe created (its `provision.probe_started` audit row) is adopted. A real
      // project that took the slug is never paused, provisioned or purged; the probe stops with a fixed code.
      const mine = await tx.auditEvent.findFirst({ where: { projectId: found.id, action: "provision.probe_started" }, select: { id: true } });
      if (!mine) throw new Error("probe-slug-taken");
      if (!found.pausedAt) await tx.project.updateMany({ where: { id: found.id, pausedAt: null }, data: { pausedAt: now } });
      return { id: found.id, slug: found.slug, name: found.name };
    }
    const p = await tx.project.create({ data: { ...PROBE_PROJECT_DATA, pausedAt: now }, select: { id: true, slug: true, name: true } });
    await tx.auditEvent.create({ data: { actor: "system", action: "provision.probe_started", summary: "AT13 provisioning probe project created", projectId: p.id } });
    return p;
  }, { timeout: timeoutMs, maxWait: timeoutMs });
}

/**
 * DEVOS-110 decision 3: true only for the probe's own row (slug PROBE_SLUG and its `provision.probe_started` audit
 * row, as ensureProbeProject adopts it). One bounded read.
 */
export async function isProbeProjectRow(db: any, projectId: string, timeoutMs: number): Promise<boolean> {
  return db.$transaction(async (tx: any) => {
    const p = await tx.project.findUnique({ where: { id: projectId }, select: { slug: true } });
    if (!p || p.slug !== PROBE_SLUG) return false;
    const mine = await tx.auditEvent.findFirst({ where: { projectId, action: "provision.probe_started" }, select: { id: true } });
    return mine !== null;
  }, { timeout: timeoutMs, maxWait: timeoutMs });
}

const PHASE_ACTION = "provision.probe_phase";

function asRecord(details: unknown): PhaseRecord | null {
  const d = details as Partial<PhaseRecord> | null;
  if (!d || typeof d !== "object") return null;
  if (!Number.isInteger(d.cycle) || !PHASES.includes(d.phase as Phase) || typeof d.at !== "string" || typeof d.fingerprint !== "string") return null;
  return d as PhaseRecord;
}

/** The phase log as append-only audit rows on the probe project (no migration). An unreadable newest row is an error, never a fresh start. */
export class PrismaProbeLog {
  constructor(private readonly db: any, private readonly projectId: string, private readonly timeoutMs: number) {}

  async last(): Promise<PhaseRecord | null> {
    const t = this.timeoutMs;
    const row: { details: unknown } | null = await this.db.$transaction((tx: any) => tx.auditEvent.findFirst({
      where: { projectId: this.projectId, action: PHASE_ACTION },
      orderBy: { occurredAt: "desc" },
      select: { details: true },
    }), { timeout: t, maxWait: t });
    if (!row) return null;
    const r = asRecord(row.details);
    if (!r) throw new Error("probe-phase-unreadable");
    return r;
  }

  async record(r: PhaseRecord): Promise<void> {
    const t = this.timeoutMs;
    await this.db.$transaction((tx: any) => tx.auditEvent.create({
      data: { actor: "system", action: PHASE_ACTION, summary: `AT13 probe cycle ${r.cycle}: ${r.phase}${r.result ? ` (${r.result.code})` : ""}`, details: r, projectId: this.projectId },
    }), { timeout: t, maxWait: t });
  }
}

/** A step key of our own shape (`github/repo`, `coolify/application/production`); anything else is not printed. */
const STEP_RE = /^[a-z0-9_]{1,40}(?:\/[a-z0-9_]{1,40}){1,3}$/;
/** A fixed error code (a ProviderError's `network`, `http`, `bad-response`, ...; an S4 refusal's `compose_unsafe`). */
const CAUSE_CODE_RE = /^[a-z][a-z0-9_-]{0,39}$/;
/** A validation field name, as `ProviderError.fields` keeps it (packages/provision/src/http.ts). */
const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** The runner's own fixed messages (packages/provision/src/runner.ts), anchored on our text, never a provider body. */
const STAGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^lookup failed for /, "lookup"],
  [/^create failed for /, "create"],
  [/^create rejected for /, "rejected"],
  [/^created .+ lacks the ownership marker$/, "marker"],
];

/**
 * DEVOS-21 diagnostics, part 4: the cause of a final stop as fixed codes only. A ProviderError reads
 * `<code>` plus `-<status>` for a valid HTTP status; any other error with a fixed `code` reads that code; nothing
 * else (and never a message) is printed.
 */
function causeCode(c: unknown): string | undefined {
  const x = c as { name?: unknown; code?: unknown; status?: unknown; fields?: unknown } | null | undefined;
  if (!x || typeof x !== "object" || typeof x.code !== "string" || !CAUSE_CODE_RE.test(x.code)) return undefined;
  const st = x.status;
  const isPe = x.name === "ProviderError";
  const status = isPe && typeof st === "number" && Number.isInteger(st) && st >= 100 && st <= 599 ? `-${st}` : "";
  // Part 5: a 422's field names (already filtered by the transport; checked again here), joined by commas.
  const f = isPe && Array.isArray(x.fields) ? x.fields.filter((n): n is string => typeof n === "string" && FIELD_NAME_RE.test(n)).slice(0, 3) : [];
  return `${x.code}${status}${f.length ? `:${f.join(",")}` : ""}`;
}

/**
 * The runner's stop, read structurally (StepError lives in @devos/provision, loaded at run time). Part 4: a final
 * stop's detail also names the step, the stage (from the runner's own message) and the cause's fixed code, e.g.
 * `provider_error:github/repo:create:http-403`, so the server check says which provider call failed and how.
 */
function stepStop(e: unknown): { code: string; retryable: boolean } {
  const x = e as { name?: unknown; code?: unknown; retryable?: unknown; step?: unknown; message?: unknown; cause?: unknown } | null;
  if (!(x && x.name === "StepError" && typeof x.code === "string")) return { code: "provision-failed", retryable: true };
  const step = typeof x.step === "string" && STEP_RE.test(x.step) ? `:${x.step}` : "";
  const msg = typeof x.message === "string" ? x.message : "";
  const stage = step ? STAGES.find(([re]) => re.test(msg))?.[1] : undefined;
  const cause = step ? causeCode(x.cause) : undefined;
  const base = `${x.code}${step}${stage ? `:${stage}` : ""}`;
  // Part 5 pre-review: the CLI hides a detail over 120 characters whole, so a cause that would overflow is cut
  // back to its code and status (the field names go first), and dropped if even that does not fit.
  const fit = [cause, cause?.split(":")[0]].find((c) => c && base.length + 1 + c.length <= 120);
  return { code: `${base}${fit ? `:${fit}` : ""}`, retryable: x.retryable === true };
}

/**
 * One provisioning run for the probe project through the same provisioner as the sweep. A retryable stop is
 * "in progress" (the next tick runs again; PROBE_PHASE_MAX_MS bounds it); any other stop is its fixed code.
 */
export async function probeProvisionOnce(
  pv: { ready(): Promise<string | null>; run(p: { id: string; slug: string; name: string }): Promise<unknown> },
  project: { id: string; slug: string; name: string },
): Promise<RunOutcome> {
  const notReady = await pv.ready();
  if (notReady) return { error: notReady };
  try {
    await pv.run(project);
    return "done";
  } catch (e) {
    const s = stepStop(e);
    return s.retryable ? "in_progress" : { error: s.code };
  }
}

// Runner watchdog core (DEVOS-219, contract docs/modules/runner-watchdog.md). A pure decision step: given the newest
// comment on the two runner logs (DEVOS-75 runner A, DEVOS-89 runner B), the stored state and the time, it returns
// the M1.6 notices to send and the next state. No I/O here: the Linear read, the notifier and the stored state are
// wired in DEVOS-220. A comment body is read only to test the weekly-cap prefix; it never reaches a notice.
import type { NoticeInput } from "./notify.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
/** No comment on either runner log for this long → the runners are silent. */
export const SILENT_MS = 2 * HOUR;
/** At most one silent alert (and one Linear-unreachable alert) per this window. */
export const REPEAT_MS = 6 * HOUR;
/** At most one "paused by the weekly cap" note per this window. */
export const CAP_NOTE_MS = 24 * HOUR;
/** Linear reads failing for this long → the Linear-unreachable alert. */
export const LINEAR_DOWN_MS = 2 * HOUR;
/** The weekly usage cap resets every Saturday at 13:30 IST = 08:00 UTC. */
const RESET_DAY = 6, RESET_HOUR_UTC = 8;
/** The timer period (DEVOS-220). */
export const TICK_MS = 30 * MIN;

export type Observation =
  | { ok: true; newest: { at: string; body: string } | null }
  | { ok: false };

export interface WatchdogState {
  silentAlertAt: string | null;
  silentSince: string | null;
  capNoteAt: string | null;
  linearFailingSince: string | null;
  linearAlertAt: string | null;
  lastRunAt: string | null;
}

export const EMPTY_STATE: WatchdogState = Object.freeze({
  silentAlertAt: null, silentSince: null, capNoteAt: null, linearFailingSince: null, linearAlertAt: null, lastRunAt: null,
});

export const TITLE_SILENT = "[DevOS] Build runners silent since";
export const TITLE_CAP = "[DevOS] Build runners paused by the weekly cap";
export const TITLE_ACTIVE = "[DevOS] Build runners active again";
export const TITLE_LINEAR = "[DevOS] Linear API unreachable from the server";

const CHECK_STEPS =
  "Check claude.ai: Settings → Billing (payment and plan active) and Settings → Connectors (Linear connected). " +
  "Then reply to Claude in the AI Development Team chat.";

// A runner's weekly-cap idle line: `[runner] RUN END <iso> idle: weekly cap reached (…)` or `[runner-b] …`.
const CAP_IDLE = /^\s*\[runner(?:-b)?\]\s+RUN END\b[^\n]*\bidle:\s*weekly cap reached\b/;

/** Whether a runner-log comment is a weekly-cap idle RUN END. */
export function isCapIdle(body: string): boolean {
  return CAP_IDLE.test(body);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IST_OFFSET_MS = 330 * MIN; // India has no daylight saving time

/** "20:45 IST, 15 Nov 2026" for an ISO UTC time. */
export function formatIst(iso: string): string {
  const d = new Date(Date.parse(iso) + IST_OFFSET_MS);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} IST, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The first weekly cap reset strictly after `atMs`. */
export function nextWeeklyReset(atMs: number): number {
  const d = new Date(atMs);
  const r = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + ((RESET_DAY - d.getUTCDay() + 7) % 7), RESET_HOUR_UTC);
  return r > atMs ? r : r + 7 * 24 * HOUR;
}

const ms = (iso: string | null): number | null => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
/** True when `since` is unset (or unreadable) or at least `window` before `now`. */
const due = (since: string | null, window: number, now: number): boolean => {
  const t = ms(since);
  return t === null || now - t >= window;
};

const notice = (title: string, body: string): NoticeInput => ({ kind: "info", title, body, reasons: [], projectId: null, approvalId: null });

/**
 * One watchdog step. Rules (contract, Behaviour 1–5):
 * - a failed read judges no silence; failures for 2 h give one Linear-unreachable alert per 6 h;
 * - a good read clears the failure clock; no comment at all judges nothing;
 * - an open silent alert followed by a newer comment under 2 h old gives one "active again" notice;
 * - newest comment ≥ 2 h old: a cap idle (until the next weekly reset + 2 h) gives one cap note per 24 h,
 *   anything else one silent alert per 6 h.
 */
export function step(obs: Observation, state: WatchdogState, nowMs: number): { notices: NoticeInput[]; state: WatchdogState } {
  const now = new Date(nowMs).toISOString();
  const next: WatchdogState = { ...state, lastRunAt: now };
  const notices: NoticeInput[] = [];

  if (!obs.ok) {
    if (next.linearFailingSince === null || ms(next.linearFailingSince) === null) next.linearFailingSince = now;
    const failingFor = nowMs - (ms(next.linearFailingSince) ?? nowMs);
    if (failingFor >= LINEAR_DOWN_MS && due(next.linearAlertAt, REPEAT_MS, nowMs)) {
      notices.push(notice(TITLE_LINEAR,
        `The DevOS server has not been able to read Linear since ${formatIst(next.linearFailingSince)}, so the build ` +
        "runners' status cannot be read. Nothing is needed from you unless this lasts; if it does, check Linear's status " +
        "page and that the Linear key in the DevOS setup wizard is still valid."));
      next.linearAlertAt = now;
    }
    return { notices, state: next };
  }

  // The failure clock restarts, but the last alert time stays, so flapping reads never beat the 6-hour limit (PR136-r1).
  next.linearFailingSince = null;
  const newest = obs.newest;
  const at = newest ? ms(newest.at) : null;
  if (!newest || at === null) return { notices, state: next };

  // Recovery only while the newer comment is itself recent: a newer comment seen late (after a Linear outage) that is
  // already 2 h old moves the silence forward instead, so "active again" and "silent" never go out together.
  const openSince = ms(next.silentSince);
  if (openSince !== null && at > openSince && nowMs - at < SILENT_MS) {
    notices.push(notice(TITLE_ACTIVE, `The build runners logged work again at ${formatIst(newest.at)}. Nothing is needed from you.`));
    next.silentSince = null;
    next.silentAlertAt = null;
  } else if (openSince !== null && at > openSince) next.silentSince = newest.at; // the alert stays open, newer time

  if (nowMs - at < SILENT_MS) return { notices, state: next };

  // A cap idle explains the silence only until the next weekly reset (plus the silence window): runners that stay
  // silent after the reset have stopped for another reason (pre-review finding 1), so the silent alert applies.
  if (isCapIdle(newest.body) && nowMs < nextWeeklyReset(at) + SILENT_MS) {
    if (due(next.capNoteAt, CAP_NOTE_MS, nowMs)) {
      notices.push(notice(TITLE_CAP,
        `The build runners have been idle since ${formatIst(newest.at)} because this week's usage cap is reached. ` +
        "This is expected; they resume when the week resets (Saturday 13:30 IST). Nothing is needed from you."));
      next.capNoteAt = now;
    }
    return { notices, state: next };
  }

  if (due(next.silentAlertAt, REPEAT_MS, nowMs)) {
    const since = formatIst(newest.at);
    notices.push(notice(`${TITLE_SILENT} ${since}`,
      `Neither build runner has logged any work since ${since}. ${CHECK_STEPS}`));
    next.silentAlertAt = now;
    next.silentSince = newest.at;
  }
  return { notices, state: next };
}

// CR-b1 (DEVOS-210, docs/modules/ADR-0012.md "CR-b split", Behaviour 6 and 9, Interface): the pure core of
// batched mid-build questions. No I/O and no model call: the allow-list, the batch card's reason, KK's `BQ-<n>`
// answers and the IST day. The queue, flush and apply steps (CR-b2) call these.
import { CARD_LINE_MAX, CARD_REASON_MAX, DELETION_WORDS, LEGAL_WORDS, MONEY_WORDS } from "@devos/analyst";

/** The D11/D13 words (rule 6): licences, copy protection, reverse engineering, malware. */
export const BOUNDARY_WORDS: readonly string[] = Object.freeze(["copyright", "copyleft", "gpl", "drm", "circumvent", "crack", "reverse", "malware", "exploit"]);

/** Every stop-and-ask word the queue refuses: M2.2-c's money, legal and deletion groups plus the D11/D13 words. */
export const STOP_WORDS: readonly string[] = Object.freeze([...MONEY_WORDS, ...LEGAL_WORDS, ...DELETION_WORDS, ...BOUNDARY_WORDS]);

/** Each word and the word without a final `e` (`truncate` → `truncat`), lower case, longest first, no repeats. */
export const STOP_STEMS: readonly string[] = Object.freeze(
  [...new Set(STOP_WORDS.flatMap((w) => {
    const l = w.toLowerCase();
    return l.length > 1 && l.endsWith("e") ? [l, l.slice(0, -1)] : [l];
  }))].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)),
);

// Runner decision (pre-review finding 6): € and £ interrupt too, beyond the contract's ₹ and $ (fails toward interrupting).
const CURRENCY = /[₹$€£]/u;
const WORD = /[\p{L}\p{N}]+/gu;
/** Common prefixes stripped before the stem check (pre-review finding 1: `unlicensed`, `relicense`, `undelete`). */
const PREFIXES = ["under", "over", "non", "pre", "sub", "un", "re"];

/**
 * The stop-and-ask stem a text hits, `"currency"` for `₹`, `$`, `€` or `£`, or null. Case-insensitive; camelCase is
 * split (`hardDelete`); a word hits when it, or the word without one common prefix, starts with a stem.
 */
export function stopHit(text: string): string | null {
  const s = String(text ?? "");
  if (CURRENCY.test(s)) return "currency";
  const split = s.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").toLowerCase();
  for (const m of split.matchAll(WORD)) {
    const forms = [m[0], ...PREFIXES.filter((p) => m[0].length > p.length && m[0].startsWith(p)).map((p) => m[0].slice(p.length))];
    for (const w of forms) for (const stem of STOP_STEMS) if (w.startsWith(stem)) return stem;
  }
  return null;
}

/**
 * Rule 6: a question may wait for the daily batch only when its gate is `decision` and neither its text nor its
 * default hits a stop-and-ask stem. Anything else is `not-batchable` and the caller raises its card at once. The
 * rule fails toward interrupting: an unknown gate or a non-string text is refused.
 */
export function batchable(input: { gate: unknown; text: unknown; default?: unknown }): { ok: true } | { ok: false; code: "not-batchable"; hit: string } {
  if (input?.gate !== "decision") return { ok: false, code: "not-batchable", hit: "gate" };
  if (typeof input.text !== "string") return { ok: false, code: "not-batchable", hit: "text" };
  const hit = stopHit(input.text) ?? (typeof input.default === "string" ? stopHit(input.default) : null);
  return hit ? { ok: false, code: "not-batchable", hit } : { ok: true };
}

// Same control set as M2.3 ONE_LINE (apps/api/src/approvals.ts), so each line is one line parseCard accepts.
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]+", "g");
const oneLine = (s: string): string => String(s ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max - 1;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return `${s.slice(0, end)}…`;
}

export interface BatchQuestion {
  text: string;
  default: string;
}

/** `BQ-<n>: <text> (default: <default>)` per question, in order, each one line of at most 200 characters. */
export function batchLines(questions: readonly BatchQuestion[]): string[] {
  return questions.map((q, i) => clip(oneLine(`BQ-${i + 1}: ${q.text} (default: ${q.default})`), CARD_LINE_MAX));
}

/**
 * The batch card's reason: `<n> questions`, then one line per question. Never longer than M2.3's 2,000 characters:
 * lines that do not fit are replaced by a last line `+<k> more on the project page`.
 */
export function batchReason(questions: readonly BatchQuestion[]): string {
  const head = `${questions.length} ${questions.length === 1 ? "question" : "questions"}`;
  const lines = batchLines(questions);
  for (let n = lines.length; n >= 0; n--) {
    const rest = lines.length - n;
    const parts = [head, ...lines.slice(0, n), ...(rest > 0 ? [`+${rest} more on the project page`] : [])];
    const s = parts.join("\n");
    if (s.length <= CARD_REASON_MAX) return s;
  }
  return head;
}

export interface BatchAnswerRow {
  /** `BQ-<n>`, the question's place in the batch. */
  itemId: string;
  text: string;
  answer: string;
  source: "kk" | "default";
}

/** Longest stored answer (characters); a longer answer is cut, never refused (the card is already decided). */
export const BATCH_ANSWER_MAX = 1000;
// Case-insensitive `BQ`; each line is made one line first, so U+2028 or a tab never drops an answer (finding 3).
const ANSWER_LINE = /^\s*BQ-(\d{1,4})\s*:\s*(\S.*?)\s*$/i;

/**
 * Rule 9: one row per question, in batch order: KK's answer from a `BQ-<n>: <answer>` line of his comments, or the
 * question's default. The last line for a number wins; unknown numbers and other text are ignored.
 */
export function batchAnswers(questions: readonly BatchQuestion[], comments: readonly string[]): BatchAnswerRow[] {
  const answers = new Map<number, string>();
  for (const body of comments) {
    for (const line of String(body ?? "").split(/\r?\n/)) {
      const m = ANSWER_LINE.exec(oneLine(line));
      if (m) answers.set(Number(m[1]), clip(m[2]!, BATCH_ANSWER_MAX));
    }
  }
  return questions.map((q, i) => {
    const a = answers.get(i + 1);
    return a === undefined ? { itemId: `BQ-${i + 1}`, text: q.text, answer: q.default, source: "default" } : { itemId: `BQ-${i + 1}`, text: q.text, answer: a, source: "kk" };
  });
}

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

/** The IST calendar day of `now` as `YYYY-MM-DD` (IST has no daylight saving: always UTC+05:30). */
export function istDay(now: Date): string {
  const t = now.getTime();
  if (!Number.isFinite(t)) throw new RangeError("invalid-date");
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The batch card's fixed action and target (no count, so every retry sends the same card). */
export function batchCard(projectName: string, batchId: string): { gate: "decision"; action: string; target: string } {
  return { gate: "decision", action: clip(oneLine(`Answer the build questions for ${projectName}`), CARD_LINE_MAX), target: `batch:${batchId}` };
}

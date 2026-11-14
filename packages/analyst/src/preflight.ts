// CR-a1 (DEVOS-193, docs/modules/ADR-0012.md "Interface"): the pre-flight list carried by the one intake card.
// Pure and deterministic: no model call, no I/O. The API side (CR-a2) stores answers and gates the build.
import type { Analysis } from "./analyze.js";
import { CARD_LINE_MAX, CARD_REASON_MAX, planQuestions } from "./route.js";

export interface PreflightItem {
  /** `PF-<n>`, numbered in order. */
  id: string;
  kind: "decision" | "secret";
  /** One line. For a `secret` item: the secret's name only, never a value. */
  text: string;
  options?: string[];
  default: string;
  /** Requirement keys whose tasks this item blocks (an owned question's requirement key). */
  blocks?: string[];
}

/** The part of the project's M1.7 budget envelope the pre-flight needs. */
export interface PreflightEnvelope {
  maxCostUsd: number;
}

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
export const SECRET_DEFAULT = "enter in setup wizard";
export const ACCEPTANCE_DEFAULT = "build as written; the Architect proposes the criteria";
export const QUESTION_DEFAULT = "Architect decides";
export const BUDGET_TEXT = "Monthly spend cap for this project";
export const PUBLIC_URL_TEXT = "Should the preview be reachable on a public URL?";
export const PUBLIC_URL_DEFAULT = "no — tailnet only";

// Same control set as route.ts / M2.3 ONE_LINE, so every summary entry is one line parseCard accepts.
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]+", "g");
const oneLine = (s: string): string => s.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max - 1;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return `${s.slice(0, end)}…`;
}

export class PreflightError extends Error {
  constructor(readonly code: "invalid-secret-name" | "invalid-envelope") {
    super(code);
  }
}

/**
 * One `decision` item per open question M2.2-c routes non-technical (repeats merged, as for its cards), then the
 * budget item, the public-URL item, and one `secret` item per name. Deterministic for the same input.
 */
export function buildPreflight(analysis: Analysis, secretNames: readonly string[], envelope: PreflightEnvelope): PreflightItem[] {
  if (!envelope || !Number.isFinite(envelope.maxCostUsd) || envelope.maxCostUsd < 0) throw new PreflightError("invalid-envelope");
  for (const n of secretNames) if (typeof n !== "string" || !SECRET_NAME.test(n)) throw new PreflightError("invalid-secret-name");
  const byId = new Map(analysis.openQuestions.map((q) => [q.id, q] as const));
  const items: Omit<PreflightItem, "id">[] = [];
  // planQuestions is M2.2-c's own routing: its cards are exactly the non-technical questions, deduplicated.
  for (const d of planQuestions(analysis, { specVersion: 0 }).cards) {
    const q = byId.get(d.questionId)!;
    const acceptance = q.kind === "missing-acceptance";
    const text = acceptance ? `${d.card.action}: ${q.text}` : q.text;
    items.push({ kind: "decision", text: clip(oneLine(text), 1000), default: acceptance ? ACCEPTANCE_DEFAULT : QUESTION_DEFAULT, ...(d.blocks.length ? { blocks: [...d.blocks] } : {}) });
  }
  items.push({ kind: "decision", text: BUDGET_TEXT, default: `USD ${envelope.maxCostUsd} (the project's budget envelope)` });
  items.push({ kind: "decision", text: PUBLIC_URL_TEXT, options: ["no", "yes"], default: PUBLIC_URL_DEFAULT });
  for (const n of [...new Set(secretNames)]) items.push({ kind: "secret", text: n, default: SECRET_DEFAULT });
  return items.map((it, i) => ({ id: `PF-${i + 1}`, ...it }));
}

/**
 * The one line the intake card's reason gains: `Pre-flight: <n> questions, <m> secrets — PF-1: … (default: …); …`.
 * At most `max` characters (the room left in M2.3's 2,000-character reason); entries that do not fit are replaced
 * by `+<k> more on the project page`. Each entry is one line of at most 200 characters.
 */
export function preflightLine(items: readonly PreflightItem[], max: number = CARD_REASON_MAX): string {
  const questions = items.filter((i) => i.kind === "decision").length;
  const secrets = items.length - questions;
  const head = `Pre-flight: ${questions} questions, ${secrets} secrets`;
  const entries = items.map((i) =>
    clip(oneLine(i.kind === "secret" ? `${i.id}: secret ${i.text} (${i.default})` : `${i.id}: ${i.text} (default: ${i.default})`), CARD_LINE_MAX),
  );
  const build = (n: number) => {
    const shown = entries.slice(0, n);
    const rest = entries.length - n;
    let s = shown.length ? `${head} — ${shown.join("; ")}` : head;
    if (rest > 0) s += `${shown.length ? ";" : " —"} +${rest} more on the project page`;
    return s;
  };
  for (let n = entries.length; n >= 0; n--) {
    const s = build(n);
    if (s.length <= max) return s;
  }
  // Not even the head fits: the caller gave too little room; never exceed it.
  return clip(build(0), max);
}

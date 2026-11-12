import { createHash } from "node:crypto";
import { escapeInert } from "@devos/intake";
import type { Analysis, OpenQuestion, Requirement } from "./analyze.js";

/**
 * M2.2-c question router (DEVOS-123). Each open question is either `non-technical` (a decision card for KK
 * through the M2.3 approvals core) or `technical` (decided by the Architect and logged, ADR-0013). Cards
 * block only the requirements that depend on them (DV-FR-012). Pure planning plus one executor with an
 * injected port: no DB, no model, no network.
 */

export type QuestionClass = "technical" | "non-technical";
export type ClassReason = "missing-acceptance" | "non-technical-topic" | "technical-topic" | "default-non-technical";

export interface Classification {
  class: QuestionClass;
  reason: ClassReason;
}

// Money, users, legal, content, scope, accounts and dates are KK's (ADR-0013). Checked first, so a question
// that mixes both ("which database fits the budget?") still goes to KK.
const NON_TECHNICAL = new RegExp(
  "\\b(" +
    [
      "price", "prices", "pricing", "budget", "budgets", "cost", "costs", "costing", "pay", "pays", "paid", "payment",
      "payments", "billing", "invoice", "invoices", "subscription", "subscriptions", "spend", "money", "fee", "fees",
      "user", "users", "customer", "customers", "audience", "persona", "personas", "role", "roles", "who",
      "legal", "law", "laws", "lawyer", "licence", "licences", "license", "licenses", "licensing", "terms", "privacy",
      "gdpr", "dpdp", "consent", "compliance", "regulation", "regulatory", "contract", "contracts", "vendor", "vendors",
      "content", "copy", "wording", "text", "tone", "brand", "branding", "logo", "name", "naming", "colour", "colours",
      "color", "colors", "scope", "priority", "priorities", "mvp", "deadline", "deadlines", "launch", "date", "dates",
      "account", "accounts", "pilot", "market", "markets", "region", "regions", "country", "countries",
      "charge", "charges", "charging", "free", "plan", "plans", "tier", "tiers", "revenue", "refund", "refunds",
      "discount", "discounts", "include", "includes", "exclude", "excludes", "phase", "phases", "feature", "features",
      "client", "clients", "staff", "shift", "shifts", "period", "live",
    ].join("|") +
    ")\\b",
  "i",
);

const TECHNICAL = new RegExp(
  "\\b(" +
    [
      "database", "databases", "db", "postgres", "postgresql", "mysql", "sqlite", "redis", "mongodb", "orm", "schema",
      "schemas", "migration", "migrations", "framework", "frameworks", "library", "libraries",
      "sdk", "api", "apis", "endpoint", "endpoints", "graphql", "grpc", "websocket",
      "websockets", "protocol", "architecture", "cache", "caching", "queue", "queues",
      "cron", "hosting", "container", "containers", "docker", "kubernetes", "cdn", "deploy",
      "deployment", "ci", "typescript", "javascript", "python", "react", "vue",
      "nextjs", "css", "html", "oauth", "jwt", "encryption", "hashing", "latency",
      "throughput", "pagination", "polling", "webhook", "webhooks",
    ].join("|") +
    ")\\b",
  "i",
);

/** Classify one open question. An unclear question goes to KK rather than being decided for him. */
export function classifyQuestion(q: Pick<OpenQuestion, "kind" | "text">): Classification {
  // What "done" means for a requirement is a product decision (DV-FR-011: KK approves criteria).
  if (q.kind === "missing-acceptance") return { class: "non-technical", reason: "missing-acceptance" };
  // The whole text: both patterns are linear, and a cut could hide a non-technical word (pre-review).
  const text = q.text;
  if (NON_TECHNICAL.test(text)) return { class: "non-technical", reason: "non-technical-topic" };
  if (TECHNICAL.test(text)) return { class: "technical", reason: "technical-topic" };
  return { class: "non-technical", reason: "default-non-technical" };
}

/** A decision card ready for M2.3 `raiseCard` (gate `decision`), plus the requirement keys it blocks. */
export interface QuestionCardDraft {
  questionId: string;
  /** Every open question this card answers (repeats of the same question merge into one card). */
  questionIds: string[];
  card: { gate: "decision"; action: string; target: string; reason: string; projectId: string | null };
  /** Used instead of `card.reason` when the approvals core refuses spec text (`card-contains-secret`). */
  fallbackReason: string;
  /** Requirement keys whose tasks wait on this card; empty = blocks nothing. */
  blocks: string[];
  reason: ClassReason;
}

export interface TechnicalEntry {
  questionId: string;
  questionIds: string[];
  text: string;
  source: number;
  blocks: string[];
  reason: ClassReason;
}

export interface QuestionPlan {
  cards: QuestionCardDraft[];
  technical: TechnicalEntry[];
}

export interface PlanMeta {
  projectId?: string | null;
  specVersion: number;
}

export const CARD_LINE_MAX = 200;
export const CARD_REASON_MAX = 2000;
const QUOTE_MAX = 1500;
// C0/C1 controls and Unicode line/paragraph separators: a card line is one line.
// Same set as M2.3 `ONE_LINE` (approvals.ts), including bidi overrides and isolates, so parseCard accepts it.
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]+", "g");

function oneLine(s: string): string {
  return s.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

/** Clip to `max` UTF-16 units (what M2.3 `parseCard` counts) without splitting a surrogate pair. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max - 1;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return `${s.slice(0, end)}…`;
}

/** Stable across spec versions (Q-numbers are not), so M2.3 dedupe returns the pending card for a repeat. */
export function questionFingerprint(text: string): string {
  return createHash("sha256").update(oneLine(text).toLowerCase(), "utf8").digest("hex").slice(0, 16);
}

/**
 * Requirement keys a question depends on: the requirement it is about (missing acceptance) or was raised
 * from (a TBD title or criterion, `owner`). Never by block index: all rows of one table share a block, so
 * one TBD cell would block every row (pre-review). Keys not in the requirements (out of scope) block nothing.
 */
function dependents(q: OpenQuestion, reqByKey: ReadonlyMap<string, Requirement>): string[] {
  const key = q.kind === "missing-acceptance" ? q.requirement : q.owner;
  return key && reqByKey.has(key) ? [key] : [];
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Split the analysis's open questions into decision cards and Architect-log entries. Deterministic. */
export function planQuestions(analysis: Analysis, meta: PlanMeta): QuestionPlan {
  const cards: QuestionCardDraft[] = [];
  const technical: TechnicalEntry[] = [];
  // Maps keep the plan linear in the number of questions (F3).
  const cardByTarget = new Map<string, QuestionCardDraft>();
  const techByFp = new Map<string, TechnicalEntry>();
  const reqByKey = new Map(analysis.requirements.map((r) => [r.key, r] as const));
  for (const q of analysis.openQuestions) {
    const c = classifyQuestion(q);
    const blocks = dependents(q, reqByKey);
    if (c.class === "technical") {
      const fp = questionFingerprint(q.text);
      const prev = techByFp.get(fp);
      if (prev) {
        prev.questionIds.push(q.id);
        prev.blocks = [...new Set([...prev.blocks, ...blocks])];
      } else {
        const entry: TechnicalEntry = { questionId: q.id, questionIds: [q.id], text: q.text, source: q.source, blocks, reason: c.reason };
        technical.push(entry);
        techByFp.set(fp, entry);
      }
      continue;
    }
    const key = q.kind === "missing-acceptance" && q.requirement && SAFE_KEY.test(q.requirement) ? q.requirement : null;
    const target = key ? `spec-acceptance:${key}` : `spec-question:${questionFingerprint(q.text)}`;
    // The same question twice in one spec is one card; its blockers are merged.
    const prev = cardByTarget.get(target);
    if (prev) {
      prev.questionIds.push(q.id);
      prev.blocks = [...new Set([...prev.blocks, ...blocks])];
      continue;
    }
    const action = key ? `Confirm acceptance criteria for ${key}` : "Answer an open question in the spec";
    const head = `${q.id}, spec version ${meta.specVersion}, block ${q.source}.`;
    const req = q.requirement ? reqByKey.get(q.requirement) : undefined;
    const reason =
      q.kind === "missing-acceptance"
        ? `${head} The spec gives no acceptance criteria for this requirement. Its title in the spec: "${clip(oneLine(req?.title ?? ""), QUOTE_MAX)}"`
        : `${head} The spec leaves this open: "${clip(oneLine(q.text), QUOTE_MAX)}"`;
    const draft: QuestionCardDraft = {
      questionId: q.id,
      questionIds: [q.id],
      card: {
        gate: "decision",
        action: clip(action, CARD_LINE_MAX),
        target: clip(target, CARD_LINE_MAX),
        reason: clip(reason, CARD_REASON_MAX),
        projectId: meta.projectId ?? null,
      },
      fallbackReason: `${head} The question text is withheld because the approvals inbox could not accept it (it may look like a secret); open the spec to read it.`,
      blocks,
      reason: c.reason,
    };
    cards.push(draft);
    cardByTarget.set(target, draft);
  }
  return { cards, technical };
}

/** `docs/decisions/analyst-questions.md` for the app repo: technical questions the Architect decides. Inert. */
export function renderArchitectLog(plan: QuestionPlan, meta: PlanMeta & { generatedAt: string }): string {
  const out: string[] = [
    "# Technical questions from the spec (Architect log)",
    "",
    `_Generated by the DevOS Analyst from spec version ${meta.specVersion} on ${escapeInert(meta.generatedAt)}. ` +
      "The Architect decides each one and records the decision and its reasons here (ADR-0013); none goes to KK._",
    "",
  ];
  if (plan.technical.length === 0) {
    out.push("_No technical questions._", "");
    return out.join("\n");
  }
  for (const t of plan.technical) {
    out.push(`## ${t.questionIds.map(escapeInert).join(", ")}`, "");
    out.push(`- **Question:** ${escapeInert(oneLine(t.text))}`);
    out.push(`- **Source block:** ${t.source}`);
    out.push(`- **Affects:** ${t.blocks.length ? t.blocks.map(escapeInert).join(", ") : "no single requirement"}`);
    out.push("- **Decision:** _to be decided by the Architect_", "");
  }
  return out.join("\n");
}

/** What M2.2-d's port does with one card: raise it (M2.3 `raiseCard`) blocking those requirements' tasks. */
export type RaiseCard = (draft: QuestionCardDraft, reason: string) => Promise<{ id: string }>;

export interface RouteResult {
  raised: { questionId: string; cardId: string; withheld: boolean }[];
  failed: { questionId: string; code: string }[];
}

const CODE = /^[a-z][a-z0-9-]{0,63}$/;

function errorCode(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" && CODE.test(c) ? c : "raise-failed";
}

/**
 * Raise every card, one at a time. One failure never stops the others (independent work continues,
 * DV-FR-012); a `card-contains-secret` or `invalid-input` refusal is retried once with the fallback reason. Failure codes
 * are fixed strings, never spec text or error messages.
 */
export async function raiseQuestionCards(plan: QuestionPlan, raise: RaiseCard): Promise<RouteResult> {
  const result: RouteResult = { raised: [], failed: [] };
  for (const d of plan.cards) {
    try {
      const { id } = await raise(d, d.card.reason);
      result.raised.push({ questionId: d.questionId, cardId: id, withheld: false });
    } catch (e) {
      const code = errorCode(e);
      // Spec text the approvals core refuses (secret-shaped, or a shape it rejects) is retried without it.
      if (code !== "card-contains-secret" && code !== "invalid-input") {
        result.failed.push({ questionId: d.questionId, code });
        continue;
      }
      try {
        const { id } = await raise(d, d.fallbackReason);
        result.raised.push({ questionId: d.questionId, cardId: id, withheld: true });
      } catch (e2) {
        result.failed.push({ questionId: d.questionId, code: errorCode(e2) });
      }
    }
  }
  return result;
}

import { createHash } from "node:crypto";
import { escapeInert } from "@devos/intake";
import type { Analysis, OpenQuestion } from "./analyze.js";

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
    ].join("|") +
    ")\\b",
  "i",
);

const TECHNICAL = new RegExp(
  "\\b(" +
    [
      "database", "databases", "db", "postgres", "postgresql", "mysql", "sqlite", "redis", "mongodb", "orm", "schema",
      "schemas", "migration", "migrations", "index", "indexes", "framework", "frameworks", "library", "libraries",
      "package", "packages", "sdk", "api", "apis", "endpoint", "endpoints", "rest", "graphql", "grpc", "websocket",
      "websockets", "protocol", "stack", "architecture", "cache", "caching", "queue", "queues", "worker", "workers",
      "cron", "hosting", "server", "servers", "container", "containers", "docker", "kubernetes", "cdn", "deploy",
      "deployment", "ci", "test", "tests", "testing", "typescript", "javascript", "node", "python", "react", "vue",
      "nextjs", "css", "html", "oauth", "jwt", "session", "sessions", "encryption", "hashing", "latency",
      "performance", "throughput", "pagination", "polling", "webhook", "webhooks", "retry", "retries", "timeout",
      "timeouts", "logging", "monitoring",
    ].join("|") +
    ")\\b",
  "i",
);

/** Classify one open question. An unclear question goes to KK rather than being decided for him. */
export function classifyQuestion(q: Pick<OpenQuestion, "kind" | "text">): Classification {
  // What "done" means for a requirement is a product decision (DV-FR-011: KK approves criteria).
  if (q.kind === "missing-acceptance") return { class: "non-technical", reason: "missing-acceptance" };
  const text = q.text.slice(0, 4000);
  if (NON_TECHNICAL.test(text)) return { class: "non-technical", reason: "non-technical-topic" };
  if (TECHNICAL.test(text)) return { class: "technical", reason: "technical-topic" };
  return { class: "non-technical", reason: "default-non-technical" };
}

/** A decision card ready for M2.3 `raiseCard` (gate `decision`), plus the requirement keys it blocks. */
export interface QuestionCardDraft {
  questionId: string;
  card: { gate: "decision"; action: string; target: string; reason: string; projectId: string | null };
  /** Used instead of `card.reason` when the approvals core refuses spec text (`card-contains-secret`). */
  fallbackReason: string;
  /** Requirement keys whose tasks wait on this card; empty = blocks nothing. */
  blocks: string[];
  reason: ClassReason;
}

export interface TechnicalEntry {
  questionId: string;
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
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+", "g");

function oneLine(s: string): string {
  return s.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

/** Stable across spec versions (Q-numbers are not), so M2.3 dedupe returns the pending card for a repeat. */
export function questionFingerprint(text: string): string {
  return createHash("sha256").update(oneLine(text).toLowerCase(), "utf8").digest("hex").slice(0, 16);
}

/** Requirement keys a question depends on: its own requirement, or requirements defined in its block. */
function dependents(q: OpenQuestion, analysis: Analysis): string[] {
  if (q.kind === "missing-acceptance") return q.requirement ? [q.requirement] : [];
  const keys = analysis.requirements.filter((r) => r.source === q.source).map((r) => r.key);
  return [...new Set(keys)];
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Split the analysis's open questions into decision cards and Architect-log entries. Deterministic. */
export function planQuestions(analysis: Analysis, meta: PlanMeta): QuestionPlan {
  const cards: QuestionCardDraft[] = [];
  const technical: TechnicalEntry[] = [];
  const seen = new Set<string>();
  for (const q of analysis.openQuestions) {
    const c = classifyQuestion(q);
    const blocks = dependents(q, analysis);
    if (c.class === "technical") {
      technical.push({ questionId: q.id, text: q.text, source: q.source, blocks, reason: c.reason });
      continue;
    }
    const key = q.kind === "missing-acceptance" && q.requirement && SAFE_KEY.test(q.requirement) ? q.requirement : null;
    const target = key ? `spec-acceptance:${key}` : `spec-question:${questionFingerprint(q.text)}`;
    // The same question twice in one spec is one card; its blockers are merged.
    if (seen.has(target)) {
      const prev = cards.find((d) => d.card.target === target);
      if (prev) prev.blocks = [...new Set([...prev.blocks, ...blocks])];
      continue;
    }
    seen.add(target);
    const action = key ? `Confirm acceptance criteria for ${key}` : "Answer an open question in the spec";
    const head = `${q.id}, spec version ${meta.specVersion}, block ${q.source}.`;
    const quoted = clip(oneLine(q.text), QUOTE_MAX);
    const reason =
      q.kind === "missing-acceptance"
        ? `${head} The spec gives no acceptance criteria for this requirement. Its text: "${quoted}"`
        : `${head} The spec leaves this open: "${quoted}"`;
    cards.push({
      questionId: q.id,
      card: {
        gate: "decision",
        action: clip(action, CARD_LINE_MAX),
        target: clip(target, CARD_LINE_MAX),
        reason: clip(reason, CARD_REASON_MAX),
        projectId: meta.projectId ?? null,
      },
      fallbackReason: `${head} The question text is withheld because it looks like it holds a secret; open the spec to read it.`,
      blocks,
      reason: c.reason,
    });
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
    out.push(`## ${escapeInert(t.questionId)}`, "");
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
 * DV-FR-012); a `card-contains-secret` refusal is retried once with the fallback reason. Failure codes
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
      if (code !== "card-contains-secret") {
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

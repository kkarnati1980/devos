import { DEFAULT_ID_PREFIXES, extractRequirementIds, type Block } from "@devos/intake";

export type Priority = "must" | "should" | "could";

export interface Requirement {
  key: string;
  title: string;
  priority: Priority;
  acceptance: string[];
  milestone: string | null;
  assigned: boolean;
  /** Index of the source block (no invented requirements). */
  source: number;
}

export interface Milestone {
  ordinal: number;
  name: string;
  source: number;
}

export interface StackItem {
  text: string;
  source: number;
}

export interface OpenQuestion {
  id: string;
  text: string;
  source: number;
  kind: "stated" | "missing-acceptance";
  /** For missing-acceptance: the requirement key. */
  requirement?: string;
}

export interface OutOfScopeItem {
  key: string;
  title: string;
  source: number;
}

export type AnalysisWarningCode = "duplicate-id" | "priority-defaulted" | "no-requirements";

export interface AnalysisWarning {
  code: AnalysisWarningCode;
  key?: string;
  source?: number;
}

export interface Analysis {
  requirements: Requirement[];
  milestones: Milestone[];
  stack: StackItem[];
  openQuestions: OpenQuestion[];
  outOfScope: OutOfScopeItem[];
  warnings: AnalysisWarning[];
}

export interface AnalyzeOptions {
  idPrefixes?: readonly string[];
  /** Prefix for IDs the Analyst assigns (default FR). */
  assignPrefix?: string;
}

type Section = "requirements" | "stack" | "questions" | "other";

const ID_HEADERS = new Set(["id", "req id", "requirement id", "key", "#", "ref", "req"]);
const TITLE_HEADERS = new Set(["title", "requirement", "description", "name", "summary", "feature"]);
const PRIORITY_HEADERS = new Set(["priority", "moscow"]);
const ACCEPTANCE_HEADERS = new Set(["acceptance", "acceptance criteria", "done when", "ac"]);
const MILESTONE_HEADERS = new Set(["milestone", "phase", "release"]);

const MILESTONE_HEADING = /^(phase|milestone|stage|release|sprint|iteration)\b\s*[\w.]*/i;
const ACCEPTANCE_PARA = /^(acceptance( criteria)?\s*:|ac\s*:|done when\s*:|given\b|when\b|then\b)/i;
const SEPARATOR = /^\s*(?:[:\-–—.)]|\*\*\s*[:\-–—.)]?)\s*/;

function norm(s: string): string {
  return s.toLowerCase().replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
}

function sectionOf(heading: string): Section {
  const h = norm(heading);
  if (/open questions?|^questions\b|\btbd\b|unresolved|assumptions to confirm/.test(h)) return "questions";
  if (/\bstack\b|\btechnolog(y|ies)\b|\btech\b/.test(h)) return "stack";
  if (/^(functional )?requirements\b|^features\b|^user stories\b/.test(h)) return "requirements";
  return "other";
}

/** Priority from free text; null when unknown; "wont" for Won't. */
function parsePriority(raw: string): Priority | "wont" | null {
  const p = norm(raw).replace(/[’']/g, "");
  if (!p) return null;
  if (/^(wont|w|wont have|will not)\b/.test(p)) return "wont";
  if (/^(must|m|p0|p1|high|critical)\b/.test(p)) return "must";
  if (/^(should|s|p2|medium)\b/.test(p)) return "should";
  if (/^(could|c|p3|low|nice to have)\b/.test(p)) return "could";
  return null;
}

function isQuestionText(t: string): boolean {
  return /\b(TBD|TBC)\b/.test(t) || /\?\s*$/.test(t);
}

/** The requirement ID that starts `text` (after emphasis/heading marks), and the rest after a separator. */
function leadingId(text: string, prefixes: readonly string[]): { key: string; rest: string } | null {
  const stripped = text.replace(/^[\s*_[`]+/, "");
  const first = extractRequirementIds(stripped.slice(0, 80), prefixes)[0];
  if (!first || !stripped.startsWith(first.id)) return null;
  let rest = stripped.slice(first.id.length).replace(/^[*_\]`]+/, "");
  const sep = SEPARATOR.exec(rest);
  if (!sep || (sep[0].trim() === "" && rest.trim() !== "")) {
    // An ID followed directly by words with no separator is a reference, not a definition.
    if (rest.trim() !== "") return null;
  }
  rest = rest.slice(sep ? sep[0].length : 0).replace(/^[*_]+\s*/, "").trim();
  return { key: first.id, rest };
}

function splitCriteria(cell: string): string[] {
  return cell.split(/;|\n|<br\s*\/?>/i).map((s) => s.trim()).filter((s) => s.length > 0);
}

interface TableColumns {
  id: number;
  title: number;
  priority: number;
  acceptance: number;
  milestone: number;
  hasHeader: boolean;
}

function tableColumns(rows: string[][], prefixes: readonly string[]): TableColumns | null {
  const header = rows[0];
  if (!header) return null;
  const h = header.map(norm);
  const find = (set: Set<string>) => h.findIndex((c) => set.has(c));
  let id = find(ID_HEADERS);
  let hasHeader = id >= 0;
  if (id < 0) {
    // No ID header: the first column holds IDs in every data row.
    const body = rows.slice(1);
    const allIds = (rs: string[][]) => rs.length > 0 && rs.every((r) => leadingId(r[0] ?? "", prefixes)?.rest === "");
    if (allIds(body) && leadingId(header[0] ?? "", prefixes) === null) {
      id = 0;
      hasHeader = true;
    } else if (allIds(rows)) {
      id = 0;
      hasHeader = false;
    } else return null;
  }
  const cols = {
    id,
    title: hasHeader ? find(TITLE_HEADERS) : -1,
    priority: hasHeader ? find(PRIORITY_HEADERS) : -1,
    acceptance: hasHeader ? find(ACCEPTANCE_HEADERS) : -1,
    milestone: hasHeader ? find(MILESTONE_HEADERS) : -1,
    hasHeader,
  };
  if (cols.title < 0) {
    const used = new Set([cols.id, cols.priority, cols.acceptance, cols.milestone]);
    cols.title = header.findIndex((_, i) => !used.has(i));
  }
  return cols;
}

function blockText(b: Block): string {
  if (b.type === "table") return b.rows.map((r) => r.join(" | ")).join("\n");
  return b.text;
}

/**
 * Deterministic Analyst pass (M2.2-a): spec blocks → requirements, milestones, stack and open questions.
 * Every item points at the block it came from; nothing is produced from outside the blocks.
 */
export function analyzeSpec(blocks: readonly Block[], options: AnalyzeOptions = {}): Analysis {
  const prefixes = options.idPrefixes ?? DEFAULT_ID_PREFIXES;
  const assignPrefix = options.assignPrefix ?? "FR";
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(assignPrefix)) throw new TypeError("assignPrefix must be 1-10 upper-case letters/digits");

  const requirements: Requirement[] = [];
  const byKey = new Map<string, Requirement>();
  const milestones: Milestone[] = [];
  const milestoneNames = new Set<string>();
  const stack: StackItem[] = [];
  const stated: { text: string; source: number }[] = [];
  const outOfScope: OutOfScopeItem[] = [];
  const warnings: AnalysisWarning[] = [];
  const unassigned: { title: string; source: number; milestone: string | null; priority: Priority | "wont" | null }[] = [];

  // Every ID that appears anywhere, so assigned IDs never collide with one.
  const allText = blocks.map(blockText).join("\n");
  const specIds = new Set(extractRequirementIds(allText, prefixes).map((r) => r.id));

  const addMilestone = (name: string, source: number) => {
    const n = name.trim();
    if (!n || milestoneNames.has(n)) return;
    milestoneNames.add(n);
    milestones.push({ ordinal: milestones.length + 1, name: n, source });
  };

  const addRequirement = (
    key: string,
    title: string,
    rawPriority: string,
    acceptance: string[],
    milestone: string | null,
    source: number,
    assigned = false,
  ): Requirement | null => {
    const pr = parsePriority(rawPriority);
    if (pr === "wont") {
      outOfScope.push({ key, title, source });
      return null;
    }
    if (byKey.has(key) || outOfScope.some((o) => o.key === key)) {
      warnings.push({ code: "duplicate-id", key, source });
      return null;
    }
    let priority: Priority = "must";
    if (pr === null) warnings.push({ code: "priority-defaulted", key, source });
    else priority = pr;
    const r: Requirement = { key, title, priority, acceptance, milestone, assigned, source };
    requirements.push(r);
    byKey.set(key, r);
    return r;
  };

  let section: Section = "other";
  let currentMilestone: string | null = null;
  // The requirement that following criteria attach to, and how they attach.
  let open: { req: Requirement; kind: "heading" } | { req: Requirement; kind: "list"; depth: number } | null = null;

  blocks.forEach((b, i) => {
    if (b.type === "heading") {
      const ms = MILESTONE_HEADING.exec(b.text.trim());
      const id = leadingId(b.text, prefixes);
      if (ms && !id) {
        addMilestone(b.text.trim(), i);
        currentMilestone = b.text.trim();
        open = null;
        return;
      }
      if (id) {
        const prMatch = /\((must|should|could|won['’]?t)\)\s*$/i.exec(id.rest);
        const title = prMatch ? id.rest.slice(0, prMatch.index).trim() : id.rest;
        const r = addRequirement(id.key, title, prMatch?.[1] ?? "", [], currentMilestone, i);
        open = r ? { req: r, kind: "heading" } : null;
        return;
      }
      section = sectionOf(b.text);
      open = null;
      return;
    }

    if (b.type === "table") {
      open = null;
      const cols = tableColumns(b.rows, prefixes);
      if (!cols) {
        if (section === "stack") for (const row of b.rows.slice(1)) stack.push({ text: row.filter(Boolean).join(" — "), source: i });
        return;
      }
      for (const row of b.rows.slice(cols.hasHeader ? 1 : 0)) {
        const id = leadingId(row[cols.id] ?? "", prefixes);
        if (!id) continue;
        const title = (cols.title >= 0 ? row[cols.title] : "")?.trim() ?? "";
        const ms = cols.milestone >= 0 ? (row[cols.milestone] ?? "").trim() : "";
        if (ms) addMilestone(ms, i);
        const acceptance = cols.acceptance >= 0 ? splitCriteria(row[cols.acceptance] ?? "") : [];
        addRequirement(id.key, title, cols.priority >= 0 ? row[cols.priority] ?? "" : "", acceptance, ms || currentMilestone, i);
      }
      return;
    }

    if (b.type === "code") return;

    const text = b.text.trim();
    const depth = b.type === "list-item" ? b.depth : -1;

    // Criteria under an open requirement.
    const cur = open as typeof open;
    if (cur) {
      if (cur.kind === "list" && b.type === "list-item" && b.depth > cur.depth) {
        cur.req.acceptance.push(text);
        return;
      }
      if (cur.kind === "heading" && b.type === "list-item" && !leadingId(text, prefixes)) {
        cur.req.acceptance.push(text);
        return;
      }
      if (b.type === "paragraph" && ACCEPTANCE_PARA.test(text)) {
        cur.req.acceptance.push(text.replace(/^(acceptance( criteria)?|ac|done when)\s*:\s*/i, "").trim() || text);
        return;
      }
      if (cur.kind === "list" && !(b.type === "list-item" && b.depth > cur.depth)) open = null;
    }

    const id = leadingId(text, prefixes);
    if (id && (b.type === "list-item" || b.type === "paragraph")) {
      const prMatch = /\((must|should|could|won['’]?t)\)\s*$/i.exec(id.rest);
      const title = prMatch ? id.rest.slice(0, prMatch.index).trim() : id.rest;
      const r = addRequirement(id.key, title, prMatch?.[1] ?? "", [], currentMilestone, i);
      open = r ? (b.type === "list-item" ? { req: r, kind: "list", depth } : { req: r, kind: "heading" }) : null;
      return;
    }

    if (section === "stack") {
      stack.push({ text, source: i });
      return;
    }
    if (section === "questions") {
      stated.push({ text, source: i });
      return;
    }
    if (isQuestionText(text)) {
      stated.push({ text, source: i });
      return;
    }
    if (section === "requirements" && b.type === "list-item" && b.depth === 0) {
      const prMatch = /\((must|should|could|won['’]?t)\)\s*$/i.exec(text);
      unassigned.push({
        title: prMatch ? text.slice(0, prMatch.index).trim() : text,
        source: i,
        milestone: currentMilestone,
        priority: prMatch ? parsePriority(prMatch[1] ?? "") : null,
      });
    }
  });

  // Assign IDs to ID-less requirement items, never colliding with a spec ID.
  let n = 0;
  for (const u of unassigned) {
    let key: string;
    do {
      n += 1;
      key = `${assignPrefix}-A${String(n).padStart(3, "0")}`;
    } while (specIds.has(key) || byKey.has(key) || new RegExp(`(?<![A-Za-z0-9_-])${key}(?![A-Za-z0-9_])`).test(allText));
    const pr = u.priority === null ? "" : u.priority;
    addRequirement(key, u.title, pr, [], u.milestone, u.source, true);
  }
  requirements.sort((a, b) => a.source - b.source);

  const openQuestions: OpenQuestion[] = [];
  for (const q of stated) openQuestions.push({ id: `Q-${openQuestions.length + 1}`, text: q.text, source: q.source, kind: "stated" });
  for (const r of requirements) {
    if (r.acceptance.length === 0) {
      openQuestions.push({
        id: `Q-${openQuestions.length + 1}`,
        text: `${r.key} has no acceptance criteria. What must be true for it to be done?`,
        source: r.source,
        kind: "missing-acceptance",
        requirement: r.key,
      });
    }
  }
  if (requirements.length === 0) warnings.push({ code: "no-requirements" });

  return { requirements, milestones, stack, openQuestions, outOfScope, warnings };
}

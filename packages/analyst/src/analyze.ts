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
  /** M2.2-b: proposed by the model pass from the cited source block (validated, never invented). */
  proposed?: boolean;
  /** M2.2-b: the acceptance criteria were proposed by the model pass from the source block. */
  modelCriteria?: boolean;
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
  /** M2.2-b: indices of blocks taken as acceptance criteria (also of rejected duplicate/`Won't` items), sorted. */
  criteriaBlocks?: number[];
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

// A milestone heading names a number or a name: "Phase 1", "Release 2.0", "Milestone: MVP", "Stage IV", "Phase one".
const MILESTONE_HEADING =
  /^(phase|milestone|stage|release|sprint|iteration)\s*(?:\d|[ivx]+\b|(?:one|two|three|four|five|six|seven|eight|nine|ten)\b|(?:[:–—]|\s-)\s*\S)/i;
const ACCEPTANCE_PARA = /^(acceptance( criteria)?\s*:|ac\s*:|done when\s*:|given\b|when\b|then\b)/i;
// A hyphen separates only when followed by a space, so FR-1-2 is not FR-1 titled "2".
const SEPARATOR = /^\s*(?:[:–—.)]|-(?=\s))\s*/;
// A trailing "(Must)", "(W)", "(P2)", "(Low)" … on a line or heading requirement; aliases as in parsePriority.
const PRIORITY_SUFFIX = /\((must|should|could|won['’]?t|wont have|will not|m|s|c|w|p[0-3]|high|critical|medium|low|nice to have)\)\s*$/i;
const ASSIGNED_TOKEN = /(?<![A-Za-z0-9_-])[A-Z][A-Z0-9]{0,9}-A\d+(?![A-Za-z0-9_])/g;

function norm(s: string): string {
  return s.toLowerCase().replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
}

function sectionOf(heading: string): Section {
  // Numbered headings ("3. Functional requirements", "4.2 Open questions") are matched without the number.
  const h = norm(heading).replace(/^\d+(?:\.\d+)*\.?\s*/, "");
  if (/\bquestions?\b|\btbd\b|unresolved|assumptions to confirm/.test(h)) return "questions";
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
function leadingId(text: string, prefixes: readonly string[], allowBare = false): { key: string; rest: string } | null {
  const stripped = text.replace(/^[\s*_[`]+/, "");
  const first = extractRequirementIds(stripped.slice(0, 80), prefixes)[0];
  if (!first || !stripped.startsWith(first.id)) return null;
  let rest = stripped.slice(first.id.length).replace(/^[*_\]`]+/, "");
  const sep = SEPARATOR.exec(rest);
  // An ID followed directly by words with no separator is a reference, not a definition.
  if (!sep && rest.trim() !== "") return null;
  rest = rest.slice(sep ? sep[0].length : 0).replace(/^[*_]+\s*/, "").trim();
  // A line definition needs a title (PR53-r1); only a table ID cell may hold the bare ID.
  if (rest === "" && !allowBare) return null;
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
    const allIds = (rs: string[][]) => rs.length > 0 && rs.every((r) => leadingId(r[0] ?? "", prefixes, true)?.rest === "");
    if (allIds(body) && leadingId(header[0] ?? "", prefixes, true) === null) {
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

/** Strips leading/trailing dots and hyphens by index (no regex, so no backtracking on long runs). */
function trimEdgePunct(s: string): string {
  let i = 0;
  let j = s.length;
  while (i < j && (s[i] === "." || s[i] === "-")) i++;
  while (j > i && (s[j - 1] === "." || s[j - 1] === "-")) j--;
  return s.slice(i, j);
}

const CONNECTOR_WORDS: ReadonlySet<string> = new Set(["and", "or", "see"]);

/** True when the text is only requirement IDs plus punctuation/emphasis (a reference list item). */
function isBareIdReference(text: string, prefixes: readonly string[]): boolean {
  const ids = new Set(extractRequirementIds(text, prefixes).map((r) => r.id));
  if (ids.size === 0) return false;
  // One linear pass over the item's tokens (PR53-r4: no per-ID rescans). A token is a run of letters, digits,
  // dots and hyphens; edge dots/hyphens are punctuation. Each token must be an extracted ID or a connector word,
  // or carry no letter/digit at all. Whole-token matching also keeps FR-1 from eating FR-10 or FR-1.2 (PR53-r3).
  for (const raw of text.split(/[^\p{L}\p{N}.\-]+/u)) {
    const tok = trimEdgePunct(raw);
    if (tok === "" || ids.has(tok) || CONNECTOR_WORDS.has(tok.toLowerCase())) continue;
    if (/[\p{L}\p{N}]/u.test(tok)) return false;
  }
  return true;
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
  const outOfScopeKeys = new Set<string>();
  const warnings: AnalysisWarning[] = [];

  // Every ID that appears anywhere, so assigned IDs never collide with one.
  const allText = blocks.map(blockText).join("\n");
  const specIds = new Set(extractRequirementIds(allText, prefixes).map((r) => r.id));
  // Tokens already shaped like an assigned ID (one linear pass; PR pre-review finding 4).
  for (const m of allText.matchAll(ASSIGNED_TOKEN)) specIds.add(m[0]);
  let assignedN = 0;
  const nextAssignedKey = (): string => {
    let key: string;
    do {
      assignedN += 1;
      key = `${assignPrefix}-A${String(assignedN).padStart(3, "0")}`;
    } while (specIds.has(key) || byKey.has(key));
    return key;
  };

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
    if (byKey.has(key) || outOfScopeKeys.has(key)) {
      warnings.push({ code: "duplicate-id", key, source });
      return null;
    }
    if (pr === "wont") {
      outOfScope.push({ key, title, source });
      outOfScopeKeys.add(key);
      return null;
    }
    let priority: Priority = "must";
    if (pr === null) warnings.push({ code: "priority-defaulted", key, source });
    else priority = pr;
    const kept: string[] = [];
    for (const c of acceptance) (isQuestionText(c) ? stated.push({ text: c, source }) : kept.push(c));
    const r: Requirement = { key, title, priority, acceptance: kept, milestone, assigned, source };
    if (isQuestionText(title)) stated.push({ text: `${key}: ${title}`, source });
    requirements.push(r);
    byKey.set(key, r);
    return r;
  };

  let section: Section = "other";
  let currentMilestone: string | null = null;
  // The requirement that following criteria attach to, and how they attach.
  // A rejected requirement (duplicate or Won't) still owns its criteria: they go to a sink, never becoming
  // requirements of their own (pre-review finding 1).
  let open: { req: Requirement; kind: "heading" } | { req: Requirement; kind: "list"; depth: number } | null = null;
  const sink = (key: string, source: number): Requirement => ({
    key, title: "", priority: "must", acceptance: [], milestone: null, assigned: false, source,
  });
  // An unresolved criterion (TBD/TBC or a trailing "?") is an open question, not a criterion (PR53-r1).
  const criteriaBlocks = new Set<number>();
  const addCriterion = (req: Requirement, text: string, source: number) => {
    criteriaBlocks.add(source);
    if (isQuestionText(text)) stated.push({ text, source });
    else req.acceptance.push(text);
  };
  const isCriterionId = (key: string) => /^AC(?![A-Z])/.test(key);

  blocks.forEach((b, i) => {
    if (b.type === "heading") {
      const ms = MILESTONE_HEADING.exec(b.text.trim());
      const id = leadingId(b.text, prefixes);
      if (ms && !id) {
        addMilestone(b.text.trim(), i);
        currentMilestone = b.text.trim();
        // A milestone heading ends a stack or questions section; a requirements section split by phase continues.
        if (section === "stack" || section === "questions") section = "other";
        open = null;
        return;
      }
      if (id && isBareIdReference(b.text, prefixes)) {
        open = null; // an IDs-only heading is a reference: no requirement, section unchanged (PR53-r5)
        return;
      }
      if (id) {
        const prMatch = PRIORITY_SUFFIX.exec(id.rest);
        const title = prMatch ? id.rest.slice(0, prMatch.index).trim() : id.rest;
        const r = addRequirement(id.key, title, prMatch?.[1] ?? "", [], currentMilestone, i);
        open = { req: r ?? sink(id.key, i), kind: "heading" };
        return;
      }
      section = sectionOf(b.text);
      open = null;
      return;
    }

    if (b.type === "table") {
      const cols = tableColumns(b.rows, prefixes);
      // A requirement table ends any open scope. A non-requirement table does not end a heading requirement's
      // criteria (they run to the next heading, behaviour 2); it does end a list item's nested scope (PR53-r8).
      if (cols || (open as typeof open)?.kind !== "heading") open = null;
      if (!cols) {
        // A non-requirement table's rows follow the list-item rules (PR53-r5, r6): under a stack heading each row
        // is a stack item; under a questions heading each row is a stated question; anywhere, a row with
        // TBD/TBC or a trailing "?" is a stated question.
        for (const row of b.rows.slice(1)) {
          const text = row.filter(Boolean).join(" — ");
          if (!text) continue;
          if (section === "stack") stack.push({ text, source: i });
          if (section === "questions" || isQuestionText(text)) stated.push({ text, source: i });
        }
        return;
      }
      for (const row of b.rows.slice(cols.hasHeader ? 1 : 0)) {
        const id = leadingId(row[cols.id] ?? "", prefixes, true);
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
      // An IDs-only item (`- FR-2`, `- FR-2, FR-3`) is a reference, never a criterion, under either kind of
      // requirement; it keeps a heading requirement's scope open (PR53-r10, r11).
      if (b.type === "list-item" && (cur.kind === "heading" || b.depth > cur.depth) && isBareIdReference(text, prefixes)) {
        return;
      }
      if (cur.kind === "list" && b.type === "list-item" && b.depth > cur.depth) {
        addCriterion(cur.req, text, i);
        return;
      }
      const lid = leadingId(text, prefixes);
      if (cur.kind === "heading" && b.type === "list-item" && (!lid || isCriterionId(lid.key))) {
        addCriterion(cur.req, text, i);
        return;
      }
      if (b.type === "paragraph" && ACCEPTANCE_PARA.test(text)) {
        addCriterion(cur.req, text.replace(/^(acceptance( criteria)?|ac|done when)\s*:\s*/i, "").trim() || text, i);
        return;
      }
      if (cur.kind === "list" && !(b.type === "list-item" && b.depth > cur.depth)) open = null;
    }

    const id = leadingId(text, prefixes);
    // `FR-1 — FR-2` or `FR-1. FR-2` holds only IDs: a reference, never a definition of FR-1 (PR53-r5).
    if (id && (b.type === "list-item" || b.type === "paragraph") && isBareIdReference(text, prefixes)) {
      // A heading requirement's criteria run until the next heading, so a reference inside them keeps
      // that scope open (PR53-r10); a list requirement's scope already ended above.
      if (open?.kind !== "heading") open = null;
      return;
    }
    if (id && (b.type === "list-item" || b.type === "paragraph")) {
      const prMatch = PRIORITY_SUFFIX.exec(id.rest);
      const title = prMatch ? id.rest.slice(0, prMatch.index).trim() : id.rest;
      const req = addRequirement(id.key, title, prMatch?.[1] ?? "", [], currentMilestone, i) ?? sink(id.key, i);
      open = b.type === "list-item" ? { req, kind: "list", depth } : { req, kind: "heading" };
      return;
    }

    if (section === "stack") {
      stack.push({ text, source: i });
      if (isQuestionText(text)) stated.push({ text, source: i });
      return;
    }
    if (section === "questions") {
      stated.push({ text, source: i });
      return;
    }
    if (section === "requirements" && b.type === "list-item" && b.depth === 0) {
      // A bare ID reference (`- FR-1`, `- **FR-1**, FR-2`) is not a definition: no requirement (PR53-r2).
      if (isBareIdReference(text, prefixes)) return;
      // ID-less requirement item: assign an ID that never collides with a spec ID or token. An item with
      // an unresolved detail (`format TBD`) is both a requirement and (via addRequirement) a stated
      // question (behaviours 5, 7).
      const prMatch = PRIORITY_SUFFIX.exec(text);
      const key = nextAssignedKey();
      const title = prMatch ? text.slice(0, prMatch.index).trim() : text;
      const req = addRequirement(key, title, prMatch?.[1] ?? "", [], currentMilestone, i, true) ?? sink(key, i);
      open = { req, kind: "list", depth };
      return;
    }
    if (isQuestionText(text)) {
      stated.push({ text, source: i });
    }
  });

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

  return { requirements, milestones, stack, openQuestions, outOfScope, warnings, criteriaBlocks: [...criteriaBlocks].sort((x, y) => x - y) };
}

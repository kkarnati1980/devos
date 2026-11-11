export const DEFAULT_ID_PREFIXES: readonly string[] = Object.freeze([
  "FR", "NFR", "BR", "UR", "SR", "REQ", "AC", "US", "UC", "TR", "DR", "IR", "QR", "CR",
]);

export interface RequirementId {
  id: string;
  count: number;
}

function buildPattern(prefixes: readonly string[]): RegExp {
  for (const p of prefixes) if (!/^[A-Z][A-Z0-9]{0,9}$/.test(p)) throw new TypeError("requirement ID prefixes must be 1-10 upper-case letters/digits");
  // Longest first so NFR wins over FR; word boundary on both sides; no letter/digit/hyphen/dot before.
  const alt = [...prefixes].sort((a, b) => b.length - a.length).join("|");
  return new RegExp(`(?<![A-Za-z0-9_.\\-])(?:${alt})(?:-(?=\\d))?\\d{1,5}(?:\\.\\d{1,4})*(?![A-Za-z0-9_]|\\.\\d)`, "g");
}

/** Unique requirement IDs in first-seen order, with how often each occurs. */
export function extractRequirementIds(text: string, prefixes: readonly string[] = DEFAULT_ID_PREFIXES): RequirementId[] {
  const re = buildPattern(prefixes);
  const seen = new Map<string, number>();
  for (const m of text.matchAll(re)) seen.set(m[0], (seen.get(m[0]) ?? 0) + 1);
  return [...seen].map(([id, count]) => ({ id, count }));
}

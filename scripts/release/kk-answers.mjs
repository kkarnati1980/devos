// KK's recorded answers to escalated floor-guard hits v1.0.0 (DEVOS-239, contract docs/modules/GI-1e.md).
// One record shape for every reader: the gate evaluator's `kkResolutions` (GI-4) and the Release merge path and
// ci-gate (GI-1b/GI-1d): { hit, file, line, sha, decision, link }. A record is bound to one hit occurrence (id and
// file:line, since GI-1 ids repeat for identical lines) and one full head SHA, so a new commit voids it (spec §4.4).
// This module only parses and matches; reading the source (KK's Linear comment) is GI-1e part b. Zero dependencies.

/** The marker KK's answer carries, one per line: `FLOOR-GUARD KK KEEP|RESTORE <id> <file>:<line> <full head sha>`. */
const ANSWER_LINE = /^[ \t]*FLOOR-GUARD KK (KEEP|RESTORE) (fg-[0-9a-f]{10}) (.+):(0|[1-9][0-9]*) ([0-9a-f]{40})[ \t]*$/;
const ANY_ANSWER = /^[ \t]*FLOOR-GUARD KK\b/;

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
/** Only an https link counts, as the gate evaluator requires for every stored result. */
export const linkOk = (l) => typeof l === "string" && /^https:\/\/\S+$/.test(l);

/** True when a comment body is a runner's: its first non-blank text starts with `[runner` (rules: KK never does). */
export const isRunnerText = (body) => String(body ?? "").trimStart().startsWith("[runner");

/**
 * Parses KK's answers out of comments ({ body, link }). A comment whose body starts with `[runner` is never KK's and
 * is skipped whole, as is one without an https link. A line that starts `FLOOR-GUARD KK` but does not parse is
 * returned in `unreadable` and yields no record, so a typo never reads as a keep (the hit stays refused).
 * @returns {{ records: {hit: string, file: string, line: number, sha: string, decision: "keep"|"restore", link: string}[], unreadable: string[] }}
 */
export function parseKkAnswers(comments) {
  const records = [];
  const unreadable = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    if (!isObj(c) || isRunnerText(c.body) || !linkOk(c.link)) continue;
    for (const raw of String(c.body ?? "").split("\n")) {
      if (!ANY_ANSWER.test(raw)) continue;
      const m = raw.replace(/\r$/, "").match(ANSWER_LINE);
      if (!m) { unreadable.push(raw.trim().slice(0, 200)); continue; }
      records.push({ hit: m[2], file: m[3], line: Number(m[4]), sha: m[5], decision: m[1].toLowerCase(), link: c.link });
    }
  }
  return { records, unreadable };
}

/** KK's records for one hit occurrence on this exact SHA (ids repeat across identical lines, so file and line count). */
export function answersFor(records, hit, sha) {
  return (Array.isArray(records) ? records : []).filter((r) => isObj(r) && r.hit === hit?.id && r.file === hit?.file && r.line === hit?.line && r.sha === sha);
}

/**
 * Null when KK's answer clears this hit on this SHA: exactly one record, decision "keep", with an https link.
 * Otherwise the reason it does not: none, more than one (even two keeps: one answer per occurrence), restore, or no link.
 */
export function kkKeepProblem(records, hit, sha) {
  const a = answersFor(records, hit, sha);
  if (a.length === 0) return `there is no KK answer for it on ${String(sha).slice(0, 7)}`;
  if (a.length > 1) return `KK has ${a.length} answers for it on ${String(sha).slice(0, 7)} (${a.map((r) => r.decision ?? "?").join(", ")}); exactly one keep is needed`;
  if (a[0].decision !== "keep") return `KK's answer is ${a[0].decision ?? "?"}, not keep`;
  if (!linkOk(a[0].link)) return "KK's answer has no link";
  return null;
}

#!/usr/bin/env node
// Gate evaluator v1.0.0 (DEVOS-144, gate integrity Part 4; contract docs/modules/GI-4.md).
// Decides, from STORED results only, whether runner A may approve G2, G3 or G4 under KK's delegation
// (ADR-0013 §2, final form of 12 Nov 2026). It never judges: every condition is a stored result with a link.
//
//   node scripts/gates/evaluate-gate.mjs <evidence.json> [--comment <out.md>]
//
// Exit codes: 0 approve · 1 paused (one or more results missing or failed; the missing items are printed) ·
// 2 could not run (bad arguments, unreadable or malformed evidence, a gate that is never delegated).
// Exit 2 is never an approval. Zero dependencies.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyDispositions } from "../floor-guard/floor-guard.mjs";

export const DELEGATED_GATES = new Set(["G2", "G3", "G4"]);
const SHA = /^[0-9a-f]{40}$/;
// No whitespace or Markdown/HTML delimiters, so a link cannot break out of the approval comment (GC7).
const LINK = /^https:\/\/[^\s()[\]<>]+$/;
// Secret-scanning and security-linter suppressions. Written with a one-character class so the floor guard does not
// flag this pattern itself as a new suppression; it matches the same text and suppresses nothing (GI-4 contract).
const SECURITY_SUPPRESSION = /gitleaks[:]allow|\bnose[c]\b/;
// Removals in CI files that run security scanning or the D13 licence check.
const SECURITY_CI = /secur|gitleaks|secret|scan|licen[cs]e|audit|codeql|trivy|semgrep/i;
// GI-1 cuts hit text to 200 characters; a token past the cut cannot be ruled out, so a full-length text fails closed.
const CUT = 200;
// Hits spec §4.4 sends to KK (security scanning, policy, D13): a Codex Keep never clears them, only KK's recorded answer.
export const KK_ONLY = (h) => {
  const text = String(h.text ?? "");
  if (h.rule === "gitleaksignore-added" || h.rule === "policy-weakened") return true;
  if (h.rule === "suppression-added") return SECURITY_SUPPRESSION.test(text) || /\bsecurity\//.test(text) || text.length >= CUT;
  if (/^ci-/.test(h.rule ?? "")) return SECURITY_CI.test(`${h.file ?? ""} ${text}`) || text.length >= CUT;
  return false;
};

export class CannotRun extends Error {}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const shaOk = (s) => typeof s === "string" && SHA.test(s);
// Full 40-character SHAs only, compared exactly (as GI-1's dispositions are).
const sameSha = (a, b) => shaOk(a) && shaOk(b) && a === b;
const linkOk = (l) => typeof l === "string" && LINK.test(l);
// Labels go into Markdown link text; escape what could open or close a link.
const md = (s) => String(s).replace(/[\\`*_[\]()<>!|]/g, (c) => `\\${c}`).replace(/\s+/g, " ");

/** Throws CannotRun when the evidence is not even shaped like evidence (distinct from a missing result). */
function assertShape(ev) {
  if (!isObj(ev)) throw new CannotRun("evidence is not a JSON object");
  if (typeof ev.gate !== "string") throw new CannotRun("evidence.gate is missing");
  if (!DELEGATED_GATES.has(ev.gate)) throw new CannotRun(`${ev.gate} is never delegated (G5, launches, money, data deletion, legal, D11 and D13 stay with KK)`);
  for (const k of ["modules", "blockers", "criteria", "openKkItems", "mergedPrs"]) {
    if (!Array.isArray(ev[k])) throw new CannotRun(`evidence.${k} must be an array`);
  }
  if (!isObj(ev.serverChecks)) throw new CannotRun("evidence.serverChecks must be an object");
}

/**
 * Floor guard for one merged PR (spec §4.4, GI-1). `fg` is { report, link, verdict?, kkResolutions? }:
 * report is floor-guard.mjs's JSON report; verdict is the Codex verdict for that SHA ({ sha, source, text, link });
 * kkResolutions are KK's recorded answers to escalated hits ({ hit, sha, decision: "keep", link }).
 * kkResolutions are matched by hit id and file:line. Returns the list of problems (empty when clean or validly
 * disposed) and pushes the link of every disposition used onto dispLinks, for the approval comment (GC7).
 */
export function floorGuardProblems(fg, headSha, dispLinks = []) {
  if (!isObj(fg) || !isObj(fg.report)) return ["no stored floor-guard result"];
  const rep = fg.report;
  if (!sameSha(rep.sha, headSha)) return [`floor-guard result is not for head ${headSha}`];
  if (!linkOk(fg.link)) return ["floor-guard result has no link"];
  if (rep.exit === 2) return ["floor guard exit 2 (could not run is never clean)"];
  if (!Array.isArray(rep.hits) || (rep.exit !== 0 && rep.exit !== 1)) return [`floor guard exit ${rep.exit ?? "?"} with no readable hits`];
  if (rep.exit === 0 && rep.hits.length) return ["floor guard exit 0 but hits stored (inconsistent result)"];
  if (rep.exit === 1 && !rep.hits.length) return ["floor guard exit 1 with no hits stored"];
  if (rep.hits.some((h) => !isObj(h) || typeof h.id !== "string")) return ["floor-guard hits without ids"];
  if (!rep.hits.length) return [];
  const v = fg.verdict;
  const verdictOk = isObj(v) && linkOk(v.link);
  const { exit, open } = applyDispositions(rep, verdictOk ? v : null);
  if (exit === 2) return ["floor guard exit 2 (could not run is never clean)"];
  const kk = Array.isArray(fg.kkResolutions) ? fg.kkResolutions : [];
  // KK's answers for one hit occurrence (id and file:line, since GI-1 ids repeat for identical lines) on this SHA.
  const answers = (h) => kk.filter((r) => isObj(r) && r.hit === h.id && r.file === h.file && r.line === h.line && sameSha(r.sha, headSha));
  const problems = [];
  for (const h of rep.hits) {
    const where = `${h.id} (${h.rule ?? "?"} ${h.file ?? "?"}:${h.line ?? "?"})`;
    const a = answers(h);
    // Any KK record other than a single linked "keep" — restore, pending, conflicting — overrides a Codex Keep.
    if (a.length && !(a.every((r) => r.decision === "keep") && a.every((r) => linkOk(r.link)))) {
      problems.push(`hit ${where}: KK's recorded answer is not keep (${a.map((r) => r.decision ?? "?").join(", ")})`);
    } else if (KK_ONLY(h)) {
      if (!a.length) problems.push(`hit ${where} needs KK's recorded answer (escalated or pending)`);
      else dispLinks.push(...a.map((r) => ({ label: `KK keep ${h.id} ${h.file}:${h.line}`, link: r.link })));
    } else if (open.includes(h)) problems.push(`hit ${where} without a valid disposition`);
    else dispLinks.push({ label: `Codex Keep ${h.id} ${h.file}:${h.line}`, link: v.link });
  }
  return problems;
}

/**
 * Evaluates one gate's evidence. Returns { decision: "approve" | "paused", missing: string[], conditions: [...] }.
 * Each condition is { id, title, ok, results: [{ label, link }] }; a condition passes only when every result in it does.
 */
export function evaluateGate(ev) {
  assertShape(ev);
  const conditions = [];
  const add = (id, title) => { const c = { id, title, ok: true, results: [], missing: [] }; conditions.push(c); return c; };
  const fail = (c, msg) => { c.ok = false; c.missing.push(msg); };

  // 1. Every module and blocker of the phase is Done.
  const c1 = add(1, "Every module and blocker of the phase is Done");
  if (!ev.modules.length) fail(c1, "no modules listed for the phase");
  for (const m of [...ev.modules, ...ev.blockers]) {
    const name = m?.id ?? m?.issue ?? "?";
    if (!isObj(m) || m.status !== "Done") fail(c1, `${name} is not Done`);
    else if (!linkOk(m.link)) fail(c1, `${name}: no link to its issue`);
    else c1.results.push({ label: `${name} Done`, link: m.link });
  }

  // 2. Every server check on the deployed main SHA passes, with 0 skipped.
  const c2 = add(2, "Every server check on the deployed main SHA passes, 0 skipped");
  const sc = ev.serverChecks;
  const checks = Array.isArray(sc.checks) ? sc.checks : [];
  if (!shaOk(sc.sha)) fail(c2, "server checks: no deployed main SHA");
  if (!checks.length) fail(c2, "server checks: no stored results");
  for (const ch of checks) {
    const name = ch?.name ?? "?";
    if (!isObj(ch) || ch.state !== "success") fail(c2, `server check ${name}: ${ch?.state ?? "missing"}`);
    else if (!sameSha(ch.sha, sc.sha)) fail(c2, `server check ${name}: not on the deployed SHA ${sc.sha}`);
    else if (!linkOk(ch.link)) fail(c2, `server check ${name}: no link to the stored result`);
    else c2.results.push({ label: `${name} success on ${sc.sha}`, link: ch.link });
  }

  // 3. The gate's own criteria (its issue description) are met — each with a stored result.
  const c3 = add(3, "The gate's own criteria are met");
  if (!ev.criteria.length) fail(c3, "no gate criteria listed");
  for (const cr of ev.criteria) {
    const name = cr?.text ?? "?";
    if (!isObj(cr) || cr.met !== true) fail(c3, `criterion not met: ${name}`);
    else if (!linkOk(cr.link)) fail(c3, `criterion "${name}": no link to a stored result`);
    else c3.results.push({ label: name, link: cr.link });
  }

  // 4. No open KK card, deadlocked label or stop-and-ask item.
  const c4 = add(4, "No open KK card, deadlocked label or stop-and-ask item");
  for (const item of ev.openKkItems) fail(c4, `open KK item: ${item?.issue ?? item?.title ?? JSON.stringify(item)}`);
  if (!linkOk(ev.openKkQuery)) fail(c4, "no link to the stored open-KK-items query");
  else if (!ev.openKkItems.length) c4.results.push({ label: "open KK items: 0", link: ev.openKkQuery });

  // 5–7 are per merged PR. A phase with no merged PR has nothing to prove and cannot pass them.
  const c5 = add(5, "Floor guard clean (exit 0) or every hit validly disposed, for every PR merged in the phase");
  const c6 = add(6, "Every module has a pass rule whose stored result passes on its merged SHA");
  const c7 = add(7, "Every merged PR had green CI and a Codex PASS on the same head SHA (merge-gate record)");
  if (!ev.mergedPrs.length) { fail(c5, "no merged PRs listed for the phase"); fail(c7, "no merged PRs listed for the phase"); }

  for (const pr of ev.mergedPrs) {
    const n = `PR #${pr?.number ?? "?"}`;
    if (!isObj(pr) || !shaOk(pr.headSha)) { fail(c5, `${n}: no head SHA`); fail(c7, `${n}: no head SHA`); continue; }
    const disp = [];
    const fgp = floorGuardProblems(pr.floorGuard, pr.headSha, disp);
    if (fgp.length) for (const m of fgp) fail(c5, `${n}: ${m}`);
    else {
      c5.results.push({ label: `${n} floor guard ${pr.floorGuard.report.hits.length ? "hits all disposed" : "exit 0"} on ${pr.headSha}`, link: pr.floorGuard.link });
      for (const d of disp) c5.results.push({ label: `${n} ${d.label}`, link: d.link });
    }

    const ci = pr.ci, cx = pr.codex;
    if (!isObj(ci) || ci.conclusion !== "success") fail(c7, `${n}: CI ${ci?.conclusion ?? "missing"}`);
    else if (!sameSha(ci.sha, pr.headSha)) fail(c7, `${n}: CI result is not for head ${pr.headSha}`);
    else if (!linkOk(ci.link)) fail(c7, `${n}: CI result has no link`);
    if (!isObj(cx) || cx.state !== "success") fail(c7, `${n}: codex-review ${cx?.state ?? "missing"}`);
    else if (!sameSha(cx.sha, pr.headSha)) fail(c7, `${n}: codex-review is not for head ${pr.headSha}`);
    else if (!linkOk(cx.link)) fail(c7, `${n}: codex-review result has no link`);
    if (isObj(ci) && ci.conclusion === "success" && sameSha(ci.sha, pr.headSha) && linkOk(ci.link)
      && isObj(cx) && cx.state === "success" && sameSha(cx.sha, pr.headSha) && linkOk(cx.link)) {
      c7.results.push({ label: `${n} CI success on ${pr.headSha}`, link: ci.link });
      c7.results.push({ label: `${n} codex-review success on ${pr.headSha}`, link: cx.link });
    }
    // The merge went through the single merge path (GI-3), pinned to the evaluated head.
    const mg = pr.mergeGate;
    if (!isObj(mg) || mg.exit !== 0) fail(c7, `${n}: no merge-gate record (scripts/release/merge.mjs exit 0)`);
    else if (!sameSha(mg.headSha, pr.headSha)) fail(c7, `${n}: merge-gate record is not for head ${pr.headSha}`);
    else if (!shaOk(mg.mergeSha)) fail(c7, `${n}: merge-gate record has no merge SHA`);
    else if (!linkOk(mg.link)) fail(c7, `${n}: merge-gate record has no link`);
    else c7.results.push({ label: `${n} merged by the Release path at ${pr.headSha}`, link: mg.link });
  }

  // Structural checks: no duplicates, and every module's PRs are among the merged PRs (so none is left out).
  const prNums = ev.mergedPrs.map((p) => p?.number);
  const dupPr = prNums.filter((x, i) => prNums.indexOf(x) !== i);
  if (dupPr.length) fail(c7, `merged PR listed twice: ${[...new Set(dupPr)].join(", ")}`);
  const modIds = ev.modules.map((m) => m?.id);
  const dupMod = modIds.filter((x, i) => modIds.indexOf(x) !== i);
  if (dupMod.length) fail(c1, `module listed twice: ${[...new Set(dupMod)].join(", ")}`);
  for (const m of ev.modules) {
    if (!isObj(m)) continue;
    if (!Array.isArray(m.prs) || !m.prs.length) fail(c7, `${m.id ?? "?"}: no merged PR numbers listed`);
    else {
      for (const num of m.prs) if (!prNums.includes(num)) fail(c7, `${m.id ?? "?"}: PR #${num} is not among the merged PRs`);
      // The module's merged SHA must be the merge commit of one of its own PRs, so the pass rule ran on real code.
      const merges = ev.mergedPrs.filter((p) => isObj(p) && m.prs.includes(p.number)).map((p) => p.mergeGate?.mergeSha);
      if (shaOk(m.mergedSha) && !merges.includes(m.mergedSha)) fail(c6, `${m.id ?? "?"}: merged SHA ${m.mergedSha} is not the merge commit of any of its PRs`);
    }
  }

  for (const m of ev.modules) {
    if (!isObj(m)) continue;
    const name = m.id ?? "?";
    const pr = m.passRule;
    if (!isObj(pr)) fail(c6, `${name}: no stored pass-rule result`);
    else if (!shaOk(m.mergedSha)) fail(c6, `${name}: no merged SHA`);
    else if (pr.result !== "pass") fail(c6, `${name}: pass rule ${pr.result ?? "missing"}`);
    else if (!sameSha(pr.sha, m.mergedSha)) fail(c6, `${name}: pass-rule result is not for merged SHA ${m.mergedSha}`);
    else if (!linkOk(pr.link)) fail(c6, `${name}: pass-rule result has no link`);
    else c6.results.push({ label: `${name} pass rule passes on ${m.mergedSha}`, link: pr.link });
  }

  const missing = conditions.flatMap((c) => c.missing.map((m) => `(${c.id}) ${m}`));
  return { gate: ev.gate, decision: missing.length ? "paused" : "approve", missing, conditions };
}

/** The gate-issue comment: the approval lists every condition with its links (GC7); a pause names what is missing. */
export function renderComment(result, iso) {
  if (result.decision === "paused") {
    return [`[runner] ${result.gate} PAUSED ${iso}: missing`, "", ...result.missing.map((m) => `- ${md(m)}`), "",
      "Other lanes continue. This is a technical gap, so no KK card."].join("\n");
  }
  const out = [`[runner] ${result.gate} APPROVED under KK's delegation (ADR-0013 §2, final form; gate evaluator exit 0) ${iso}`, ""];
  for (const c of result.conditions) {
    out.push(`${c.id}. ${md(c.title)}`);
    for (const r of c.results) out.push(`   - [${md(r.label)}](${r.link})`);
  }
  return out.join("\n");
}

export function main(argv, { now = () => new Date().toISOString(), log = console.log, err = console.error } = {}) {
  try {
    const file = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--comment");
    if (!file) throw new CannotRun("usage: evaluate-gate.mjs <evidence.json> [--comment <out.md>]");
    let ev;
    try { ev = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new CannotRun(`cannot read evidence: ${e.message}`); }
    const result = evaluateGate(ev);
    const ci = argv.indexOf("--comment");
    if (ci !== -1) {
      if (!argv[ci + 1]) throw new CannotRun("--comment needs a path");
      writeFileSync(argv[ci + 1], renderComment(result, now()) + "\n");
    }
    log(`gate-evaluator: ${result.gate} ${result.decision}${result.missing.length ? ` (${result.missing.length} missing)` : ""}`);
    for (const m of result.missing) log(`  missing ${m}`);
    return result.decision === "approve" ? 0 : 1;
  } catch (e) {
    err(`gate-evaluator: could not run: ${e instanceof CannotRun ? e.message : `internal error: ${e?.message ?? e}`}`);
    return 2;
  }
}

// Resolve symlinks on both sides, so a symlinked path still runs the evaluator and never exits 0 silently.
const isMain = () => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? ""); } catch { return false; } };
if (isMain()) process.exit(main(process.argv.slice(2)));

// KK-only floor-guard hit classifier v1.0.0 (DEVOS-181; contracts docs/modules/GI-4.md and GI-1b.md).
// One classifier for both readers of a floor-guard report: the gate evaluator (scripts/gates/evaluate-gate.mjs, GI-4)
// and the Release merge path (scripts/release/merge.mjs, GI-1b). KK_ONLY(h) is true for a hit that a Codex Keep never
// clears (spec §4.4 security scanning, policy, D13; §4.5 a guard change must stand alone): only KK's recorded answer
// does. Anything this module cannot read with certainty fails closed (true). Zero dependencies.

// Secret-scanning and security-linter suppressions. Written with a one-character class so the floor guard does not
// flag this pattern itself as a new suppression; it matches the same text and suppresses nothing (GI-4 contract).
const SECURITY_SUPPRESSION = /gitleaks[:]allow|\bnose[c]\b/;
const SECURITY_WORDS = /secur|secret|gitleaks|\bnose[c]\b|audit|licen[cs]e|codeql|semgrep|trivy|snyk|xss|no-eval|detect-/i;
// GI-1 cuts hit text to 200 characters, and a step body (ci-step-removed/-changed) to 1000 (DEVOS-209); a token past
// the cut cannot be ruled out, so a full-length text fails closed. Same numbers as the floor guard (test K4).
export const CUT = 200;
export const STEP_BODY_CUT = 1000;
// Hits spec §4.4 sends to KK (security scanning, policy, D13): a Codex Keep never clears them, only KK's recorded answer.
export const KK_ONLY = (h) => {
  const text = String(h?.text ?? "");
  // Checked first, for every rule: a hit whose file or text names security scanning, secrets or licence checks
  // (a lint-rule-off of a "security/…" rule, a suppression in src/security/ or of no-eval) goes to KK (PR84-r2, r3).
  if (SECURITY_WORDS.test(`${h?.file ?? ""} ${text}`)) return true;
  // A full-length (cut) text may hide a security token past the cut, for every rule, so it fails closed (PR84-r4).
  if (text.length >= (CI_BODY_RULES.has(h?.rule) ? STEP_BODY_CUT : CUT)) return true;
  // A guard change mixed with other changes must stand alone (spec §4.5); only KK can accept it (merge path GI-1b).
  if (h?.rule === "gitleaksignore-added" || h?.rule === "policy-weakened" || h?.rule === "guard-change-not-isolated") return true;
  if (h?.rule === "suppression-added") return SECURITY_SUPPRESSION.test(text) || /\bsecurity\//.test(text);
  // CI hits (Codex PR84-r1, GI-4c). Since DEVOS-167 a removed or changed step or job carries its body, so a hit
  // whose stored body is read in full and shows only known non-security work may be cleared by a Codex Keep
  // (DEVOS-186). Every other ci-* hit — a body-less one (ci-disabled, ci-continue-on-error, ci-trigger-*,
  // ci-workflow-deleted, or a report from the guard before GI-4c), or one whose body runs a script, a local action, a
  // reusable workflow or anything not on the allow-list below — fails closed to KK-only.
  if (/^ci-/.test(h?.rule ?? "")) return !ciBodyIsPlain(h);
  // Lint ignores can drop files from security linting.
  if (h?.rule === "lint-rule-off") return /\bignores?\b/.test(text);
  return false;
};

// DEVOS-186: the CI rules whose hit text carries the step body (floor guard GI-4c, note 0021).
// `ci-job-removed` is not among them: job-level keys (`uses:` of a reusable workflow, `services:`, `container:`,
// `env:`) never reach the hit text, so a removed job always stays KK-only (pre-review finding 2).
const CI_BODY_RULES = new Set(["ci-step-removed", "ci-step-changed"]);
// Package-manager scripts accepted as non-security by name. `test` and `lint` are left out on purpose: either can run
// security checks (a security self-test, a security lint plugin), and the stored text cannot show which.
const PM_SCRIPTS = new Set(["install", "ci", "build", "typecheck", "format", "pack", "e2e"]);
// Setup and artifact actions that never scan; anything else (a scanner action, a local action, a reusable workflow) is unknown.
const PLAIN_ACTIONS = new Set(["actions/checkout", "actions/setup-node", "pnpm/action-setup", "actions/cache", "actions/upload-artifact", "actions/download-artifact"]);
// Step keys that only shape how a step runs; their values are still covered by SECURITY_WORDS, checked first.
// `with:` and `env:` count only as a bare key (a flow mapping on the same line could set NODE_OPTIONS and the like;
// their nested lines pass only when they are keys on this list). `shell:` only names a standard shell, because a
// custom shell template runs any program (pre-review findings 3 and 4).
// DEVOS-209: plus the setup-action keys `node-version-file`, `package-manager-cache`, `sparse-checkout`; and
// `persist-credentials` only as `false` and checkout's `ref` only as the PR's head or base SHA (PLAIN_FIXED).
const PLAIN_KEYS = /^(if|timeout-minutes|working-directory|id|name|node-version|node-version-file|version|cache|package-manager-cache|path|key|retention-days|fetch-depth|sparse-checkout)\s*:/;
const PLAIN_FIXED = /^persist-credentials\s*:\s*false$|^ref\s*:\s*\$\{\{\s*github\.event\.pull_request\.(head|base)\.sha\s*\}\}$/;
const BARE_KEYS = /^(with|env)\s*:$|^run_install\s*:\s*(true|false)$/;
const PLAIN_SHELL = /^shell\s*:\s*(bash|sh|pwsh|powershell|cmd|python)$/;
// The markers the floor guard writes around a body. Any further occurrence (a step name or a command carrying one)
// makes the text ambiguous, so it is read as unknown (pre-review finding 1).
const MARKERS = /; ran: |; was: |; now: /g;

// Package-manager options that take the next word as their value; any other option must be a bare flag or --x=value.
// Only options that take a value in pnpm, npm and yarn alike. `-w`/`--workspace` are left out: npm reads a value
// after them, pnpm does not (`-w` is --workspace-root), so `pnpm -w test build` would hide `test` (pre-review round 2).
const PM_VALUE_FLAGS = new Set(["--filter", "-F", "-C", "--dir"]);
// Bare options known not to start another program. Any other option (`--script-shell=…`, `--node-options=…`,
// `--userconfig=…`, `--config.*=…`) is unknown (pre-review finding 5).
const PM_PLAIN_FLAGS = new Set(["--frozen-lockfile", "--prefer-offline", "--if-present", "-r", "--recursive", "--silent", "-s", "--no-audit", "--no-fund", "--ignore-scripts"]);
const PM_VALUE_EQ = /^(--filter|--dir)=[\w@./*-]+$/;
const WORD = /^[\w@./:=-]+$/;

/**
 * `pnpm|npm|yarn [options] [run] <script> [options]` with a script from PM_SCRIPTS and nothing else: no second
 * positional word (which could be `exec`'s binary or an argument the script interprets), no unknown spaced option.
 */
function plainPmCommand(cmd) {
  const t = cmd.split(/\s+/);
  if (!["pnpm", "npm", "yarn"].includes(t[0]) || !t.slice(1).every((w) => WORD.test(w))) return false;
  let script = null, sawRun = false;
  for (let i = 1; i < t.length; i++) {
    const w = t[i];
    if (w.startsWith("-")) {
      if (PM_VALUE_FLAGS.has(w)) { if (i + 1 >= t.length || t[i + 1].startsWith("-")) return false; i++; continue; }
      if (PM_PLAIN_FLAGS.has(w) || PM_VALUE_EQ.test(w)) continue;
      return false;
    }
    if (script !== null) return false;
    if (w === "run" && !sawRun) { sawRun = true; continue; }
    script = w;
  }
  return script !== null && PM_SCRIPTS.has(script);
}

/** One body line (GI-4c joins a step's lines with " ⏎ "), read on its own. */
function plainLine(line) {
  const l = line.trim();
  // An empty line or body shows nothing that was run, so it cannot be read as plain.
  if (!l || l === "(empty)") return false;
  const run = /^run\s*:\s*(.*)$/.exec(l);
  if (run) {
    const cmd = run[1].trim();
    // A block scalar's commands are on the following lines, joined into this text; read it as unknown.
    if (/^[|>]/.test(cmd) || !cmd) return false;
    // One command only: no chaining, pipes, substitutions or redirections that could start another program.
    if (/[;&|`$<>()\\]/.test(cmd)) return false;
    return plainPmCommand(cmd);
  }
  const uses = /^uses\s*:\s*([^@\s]+)@[\w.-]+$/.exec(l);
  if (uses) return PLAIN_ACTIONS.has(uses[1]);
  return PLAIN_KEYS.test(l) || BARE_KEYS.test(l) || PLAIN_SHELL.test(l);
}

/**
 * DEVOS-186: true only when a ci-* hit's stored body is complete and every line of it is known non-security work.
 * The body follows "; ran: " (a removal) or "; was: …; now: …" (an edit); steps of a removed job are joined by " ;; ".
 * A missing body, a cut text (handled before this is called) or any unknown line returns false (KK-only).
 */
export function ciBodyIsPlain(h) {
  if (!CI_BODY_RULES.has(h?.rule)) return false;
  const text = String(h.text ?? "");
  // Exactly one `; ran: ` for a removal, or exactly one `; was: ` and one `; now: ` (in that order) for an edit.
  const markers = text.match(MARKERS) ?? [];
  const expected = h.rule === "ci-step-removed" ? ["; ran: "] : ["; was: ", "; now: "];
  if (markers.length !== expected.length || markers.some((x, i) => x !== expected[i])) return false;
  const m = /; (ran|was): (.*)$/.exec(text);
  if (!m || (m[1] === "ran") !== (h.rule === "ci-step-removed")) return false;
  const parts = m[1] === "was" ? m[2].split("; now: ") : [m[2]];
  if (m[1] === "was" && parts.length !== 2) return false;
  return parts.every(plainBody);
}

// A value on a shaping key: plain words only, so it cannot carry a command or a second separator.
const SAFE_VALUE = /^[A-Za-z_][\w-]*\s*:\s*[\w@./=:-]*$/;

/**
 * One step body. The guard joins lines with " ⏎ ", and a YAML value may itself contain " ⏎ ", so a `run:` value could
 * hide a second command behind what reads as a new line (Codex PR106-r1). So: at most one `run:` line and it must be
 * the last line (anything after it could be part of its value), and every other line is a `uses:` ref or a shaping
 * key with a plain-word value.
 */
function plainBody(body) {
  const lines = body.split(" ⏎ ");
  const runs = lines.filter((l) => /^run\s*:/.test(l.trim()));
  if (runs.length > 1 || (runs.length === 1 && !/^run\s*:/.test(lines.at(-1).trim()))) return false;
  return lines.every((l, i) => {
    const t = l.trim();
    if (/^(run|uses)\s*:/.test(t)) return plainLine(t);
    if (PLAIN_FIXED.test(t)) return true;
    return plainLine(t) && SAFE_VALUE.test(t);
  });
}

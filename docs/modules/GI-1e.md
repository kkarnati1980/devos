# GI-1e — KK's recorded answer for a KK-only floor-guard hit in the merge path (contract)

- **Linear:** DEVOS-239 (gate integrity, Lane A) · this PR is part a; part b is its follow-up sub-issue.
- **Source:** KK's spec `claude/devos-gate-integrity-spec-v1.0.0.md` §4.4 ("Escalate to KK"; "a disposition is attached to a SHA") (claude.ai Project); gap found by runner B on PR #157 (hit `fg-9a5389ff38`).
- **Builds on:** GI-1b (`judgeFloorGuard` in `scripts/release/merge.mjs`), GI-1d (`floorGuardDisposition` in `scripts/ci/ci-gate.mjs`), GI-4 (`kkResolutions` in `scripts/gates/evaluate-gate.mjs`), DEVOS-181 (`KK_ONLY`).
- **Applies:** D1, ADR-0011 (no new egress in part a: it reads nothing new), ADR-0013 (runner decides technical design).
- **Owned files:** `scripts/release/kk-answers.mjs` (new), `scripts/release/merge.mjs` (the hit loop of `judgeFloorGuard` and the `kkAnswers` parameter only), `scripts/ci/ci-gate.mjs` (the `kkAnswers` parameter of `floorGuardDisposition` only), `scripts/test/kk-answers.test.mjs` (new), `scripts/test/merge-gate-floor-guard.test.mjs` (B13–B15), this contract. No guard path changes (`scripts/release/**` and `scripts/ci/**` are not guard paths, note 0023), so no CHANGE marker or decision note is needed.

## Goal
Today "escalate to KK" ends in a permanent refusal: the Release path and ci-gate refuse every KK-only hit and never read an answer. This makes both accept a KK-only hit when, and only when, KK's recorded answer says "keep" for that exact hit occurrence and head SHA, using the record shape the gate evaluator already reads.

## Behaviour
1. **Record.** `{ hit, file, line, sha, decision, link }`: hit id, file and line of one occurrence (GI-1 ids repeat for identical lines), the full 40-character head SHA, `decision` `keep` or `restore`, and an https link to where KK wrote it. This is exactly the evaluator's `kkResolutions` entry (K4 proves a parsed record clears the same hit there).
2. **Text form.** KK's answer is one line per hit: `FLOOR-GUARD KK KEEP|RESTORE <id> <file>:<line> <full head sha>`. `parseKkAnswers(comments)` reads `{ body, link }` comments and:
   - skips a comment whose body starts with `[runner` (a runner's, never KK's) or that has no https link;
   - yields a record only for a line that parses exactly (upper-case decision, `fg-` + 10 hex id, a line of 0 or more (CI step hits carry line 0), a full SHA, nothing after it); any other `FLOOR-GUARD KK` line is returned as `unreadable` and yields nothing, so a typo never reads as a keep.
3. **Acceptance rule** (`kkKeepProblem`). A KK-only hit is cleared only by exactly one record matching its id, file, line and the head SHA, with decision `keep` and an https link. None, a record for another SHA or occurrence, two records (even two keeps), `restore`, any other decision, or no link refuses, with the reason and "escalate to KK".
4. **Release path.** `judgeFloorGuard`, `evaluate` and `release` take `kkAnswers` (default `[]`). Per hit of the re-run:
   - KK-only → step 3;
   - ordinary hit with a KK record that is not one keep (restore, conflicting) → refused, "KK's answer overrides a Codex Keep" (as the evaluator);
   - ordinary hit otherwise → a Codex Keep as before (a KK keep does not clear an ordinary hit, as in the evaluator).
   The floor guard is disposed of only when no hit leaves a reason. Everything else (the Codex PASS on the SHA, guard-path CHANGE lines, other red checks, main in the head) is unchanged, so a KK answer never stands in for D1.
5. **ci-gate.** `floorGuardDisposition` takes `kkAnswers` and passes it to the same `judgeFloorGuard`, so both apply one rule.
6. **No source yet (part a).** Nothing reads KK's answers yet: the CLI and ci-gate's `main` pass `[]`, so behaviour on GitHub is unchanged until part b. This keeps part a free of new egress, secrets and workflow edits.

## Runner decisions (16 Nov 2026, ADR-0013)
- **Split.** The issue has two reviewable concerns: the rule (pure, testable here) and the source (where KK's answer is read from, which needs a credential and, in CI, a workflow change). Part b is a follow-up sub-issue under DEVOS-239.
- **Exactly one record.** The issue says "exactly one keep". The evaluator accepts several keeps for one occurrence; it is left unchanged here (shape is shared, the stricter merge-side count is safe: a duplicate answer only refuses).
- **Module location.** `scripts/release/kk-answers.mjs`, because ci-gate's workflow copies `scripts/release/` whole from the base commit; a new file under `scripts/gates/` would not be copied and would break ci-gate's module load.
- **Part b constraints, recorded for its contract.** The source must be one a runner does not write: KK's own Linear comment on the PR's issue (not starting `[runner`). Reading it needs a read-only Linear key (KK creates it; an account action) and, in CI, a new step: editing an existing ci-gate step is a `ci-step-changed` hit that is KK-only, and adding `secrets.*` names a secret, so part b must add a new step, not change one, and its disposition may itself need KK's answer. Both are part b's to decide.

## Acceptance tests
| # | Pass when |
|---|---|
| K1 | (`kk-answers.test.mjs`) A comment with KEEP and RESTORE lines yields one record each, with id, file (spaces allowed), line (0 included), full SHA, decision and the comment's link |
| K2 | A `[runner`-prefixed comment, one without an https link, a non-object, and each malformed line (short SHA, no line, text after the SHA, lower-case or unknown decision, bad id) yield no record; malformed lines are listed as unreadable |
| K3 | `kkKeepProblem`: one keep → null; none, another SHA, another line, a string line, two records, restore, no link → a reason |
| K4 | A parsed keep record clears the KK-only hit in the gate evaluator's `floorGuardProblems`; none pauses; a parsed restore pauses |
| B13 | (`merge-gate-floor-guard.test.mjs`) The PR #157 hit shape (line 0) with one KK keep, also as parsed from KK's comment text, merges (one merge call); no answer, another SHA, line, file or id, restore, escalated, keep+restore, two keeps, an http or missing link each refuse with "escalate to KK" and no merge; a Codex Keep for it still refuses |
| B14 | A mixed report needs a Codex Keep for the ordinary hit and a KK keep for the KK-only one; a KK keep never clears an ordinary hit; a KK restore overrides a Codex Keep; with no PASS comment, a KK keep alone refuses |
| B15 | ci-gate's `floorGuardDisposition` disposes with one KK keep for this SHA, and not with another SHA's, none or `undefined` |

## Pre-review (16 Nov 2026)
Round 1: CHANGES_REQUESTED, 4 findings (1 medium, 3 low), all fixed: the parser refused line 0, which every `ci-step-*` hit carries, including PR #157's (K1 and B13 now parse a line-0 answer); open hits are matched by id, file and line, not object identity, and an exit other than 0/1 refuses; the pass-rule count; B14 checks the merge call.

## Pass rule
`node --test scripts/test/kk-answers.test.mjs` exits 0 with 4 tests passing; `node --test scripts/test/merge-gate-floor-guard.test.mjs` exits 0 with 16 tests passing (B1–B15 and B7b); `node --test scripts/test/merge-gate.test.mjs scripts/test/ci-gate-dispositions.test.mjs scripts/test/gate-evaluator.test.mjs` exits 0.

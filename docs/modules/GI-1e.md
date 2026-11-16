# GI-1e — KK's recorded answer for a KK-only floor-guard hit in the merge path (contract)

- **Linear:** DEVOS-239 (gate integrity, Lane A) · part a: PR #159 (merged `7305d93`); part b: the source (below). Part b is tracked in DEVOS-239 itself: Linear refused a sub-issue (workspace issue limit).
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

## Part b — the source: KK's Linear comment (16 Nov 2026)
- **Owned files:** `scripts/release/kk-source.mjs` (new), `scripts/ci/ci-gate.mjs` (`loadKkAnswers`, `KK_ANSWERS_FILE` and the `kkAnswers` argument in `main` only), `scripts/release/merge.mjs` (the CLI `main` only), `.github/workflows/ci-gate.yml` (the new `kk-answers` job, `needs: kk-answers` and one new step in the ci-gate job; no existing step changes), `scripts/test/kk-source.test.mjs` (new, K5–K10, K12), `scripts/test/merge-gate.test.mjs` (K11), `docs/decisions/0028-kk-answer-source-linear.md`, this contract. No guard path changes.
- **Decision note:** `docs/decisions/0028-kk-answer-source-linear.md` (source, egress, trust and residual risk).

### Behaviour
7. **Issues.** `issueIdsFor({ branch, body })`: the branch `kishore/devos-<n>-…` and body lines `Fixes|Closes|Resolves DEVOS-<n>`; unique, at most 3. None → no answers.
8. **Read.** `readKkComments` posts one GraphQL query per page (100 comments, at most 5 pages per issue) to `https://api.linear.app/graphql` only, with the key from `LINEAR_READ_KEY` in the `authorization` header and `redirect: "manual"` (a 3xx, or an opaque redirect, is refused at once, never followed or retried); 15 s per call and 60 s for the whole read; retried only on network errors, timeouts (also while the body is read), 429 and 5xx (3 attempts); a whole body that is not JSON is refused at once. A comment with a `botActor`, an author other than KK's Linear user (`KK_LINEAR_USER_ID`), a `[runner` start or a link that is not `https://linear.app/…` is dropped. Any other failure (401, GraphQL errors, no issue, no cursor, too many pages, deadline) throws; no message contains the key.
9. **Answers.** `kkAnswersForPr` parses the comments with part a's `parseKkAnswers` and never throws: every failure gives `records: []` and an `error`, so a KK-only hit stays refused.
10. **CI.** A separate `kk-answers` job checks out only the base commit (`scripts/release`, no credentials), installs nothing, and runs its `kk-source.mjs` with `secrets.LINEAR_READ_KEY`; it is the only step with the key, and no code from the head runs in that job. It exits 0 whatever Linear says (exit 2 only for bad arguments or an unwritable file). If the base has no reader yet it outputs no answers. Its `answers` output (records, a count of unreadable lines, the issues and any error; more than 200 records gives none) is written to `$RUNNER_TEMP/kk-answers.json` by a new ci-gate step right before the swap, so AT13's "nothing runs between the swap and the gate" holds. The ci-gate job has `if: ${{ !cancelled() }}`, so a failed `kk-answers` job never skips the required gate (a skipped required check counts as passing); the hand-over step then writes no answers.
12. **Re-run after KK answers.** `needs` outputs are fixed per run attempt and "re-run failed jobs" does not re-run a successful `kk-answers` job, so after KK writes his answer the runner re-runs the WHOLE ci-gate run (`POST /repos/<repo>/actions/runs/<id>/rerun`, "Re-run all jobs"), never only the failed jobs. The review watcher's `rerun-failed-jobs` (after a Codex PASS with Keeps) does not pick up a KK answer; switching it to a full re-run is a follow-up (watcher, DEVOS-195 line). ci-gate's `main` reads the file with `loadKkAnswers`: a missing, unreadable or malformed file, or any malformed record, gives no records. The records go to `floorGuardDisposition` (part a), which needs exactly one keep for the hit occurrence and this head SHA.
11. **CLI.** `merge.mjs <pr>` reads the PR's branch and body and, with `LINEAR_READ_KEY` set, KK's answers, logs `KK answers: <n> from <issues>` (and why none were read), and passes them to `release`.

### Runner decisions (part b)
- **Read in a base-only job, handed over as a job output.** Putting the key on the existing wait step is a `ci-step-changed` hit that is KK-only (its text names a secret). A step in the ci-gate job was rejected in pre-review (finding 1, high): the head's `pnpm install` can run a head `.pnpmfile.cjs` (even with `--ignore-scripts`) that sets `BASH_ENV`, `LD_PRELOAD` or `PATH` for later steps, which would hand the key to head code. The `kk-answers` job runs no head code at all. Local floor guard on this branch: 0 hits.
- **Fail closed everywhere:** the reader can only add records KK wrote; no key, Linear down or a malformed file all leave the gate exactly as in part a.
- **Author pinned to KK's Linear user** (pre-review finding 2) plus no `botActor`: every other member, guest or integration is ignored. Runners post as KK too, so `[runner` still separates them.
- **Trust boundary unchanged:** the workflow file still comes from the PR (note 0017); a forged answers file needs a changed workflow or head code in the ci-gate job, which can already subvert the base gate code. Recorded in note 0028; DEVOS-145 closes it.
- **KK action needed:** the read-only key as the GitHub secret `LINEAR_READ_KEY` (card on DEVOS-239). Until then reads report "no Linear key".

### Acceptance tests (part b)
| # | Pass when |
|---|---|
| K5 | (`kk-source.test.mjs`) Issue ids come from the branch and Fixes/Closes/Resolves lines, unique, capped at 3; none from a plain mention, a leading zero or DEVOS-0 |
| K6 | Calls go only to the Linear endpoint, with the key, a timeout signal and page cursors; runner, bot, user-less, other users' and non-`https://linear.app` comments are dropped |
| K7 | 5xx, 429, network errors and timeouts, before the headers or while the body is read, are retried; a whole non-JSON body is not; a redirect is refused without a second request; 401, GraphQL errors, no issue, 3×5xx, network ×3, too many pages, no cursor and the overall deadline throw without the key; no key throws naming `LINEAR_READ_KEY` |
| K8 | KK's keep becomes a record that clears the hit on its SHA only; no key, no issue, Linear down and runner-only comments give no records, and nothing returned holds the key |
| K9 | The CLI writes the file from the event (records and a count of unreadable lines; more than 200 records gives none), exits 0 when Linear fails or the event is missing, 2 without `--out`, and never logs the key; ci-gate reads what it writes |
| K10 | `loadKkAnswers` uses only a well-formed file; no path, a missing file, bad JSON, no records list or any malformed record give none |
| K12 | `kk-answers` is a base-only job (one sparse base checkout, no credentials, no install, `contents: read`) whose read step alone gets `LINEAR_READ_KEY`; ci-gate `needs` it with `if: !cancelled()` and hands its output over right before the swap, and gives no answers unless the job succeeded; run as written, a base without the reader and a run without a key both give no answers, and the gate reads what the job found |
| K11 | (`merge-gate.test.mjs`) The CLI with `LINEAR_READ_KEY` reads the PR's issue and logs the count without the key; without a key it reads none and still judges |

### Pass rule (part b)
`node --test scripts/test/kk-source.test.mjs` exits 0 with 7 tests passing (K5–K10, K12); `node --test scripts/test/merge-gate.test.mjs` exits 0 with 16 tests passing; part a's pass rule still holds; the local floor guard on origin/main...head exits 0.

### Pre-review (part b, 16 Nov 2026)
Round 1: CHANGES_REQUESTED, 5 findings (1 high, 1 low–medium, 3 low), all fixed: (high) the key step ran in the ci-gate job after the head's `pnpm install`, which can run a head `.pnpmfile.cjs` that controls later steps' environment, so the read moved to a base-only `kk-answers` job; the author is pinned to KK's Linear user; exit 2 is documented as failing the job (fail closed); the CLI entry check resolves symlinks; K7 covers the timeout retry.
Round 2: CHANGES_REQUESTED, 4 findings (2 medium, 2 low), 3 fixed: (medium) a failed `kk-answers` would have skipped the required ci-gate, which counts as passing: the gate now always runs (`!cancelled()`) and gets no answers; (medium) a KK answer is read only by a full re-run of the ci-gate run, now Behaviour 12 (watcher follow-up recorded); (low) the job output holds records and a count only, capped at 200 records; (low, recorded, not changed) the CLI reads the PR twice: answers are bound to the head SHA that `evaluate` judges, so a different read cannot clear anything.

### Codex (part b)
PR162-r1: CHANGES_REQUESTED, 1 medium, accepted and fixed: a timeout or dropped connection while the response body was read threw at once instead of being retried. The body is now read inside the attempt; K7 covers it.
PR162-r3: CHANGES_REQUESTED, 1 medium, accepted and fixed: fetch followed redirects by default, so a 307/308 could forward the request (and key) off `api.linear.app`. Now `redirect: "manual"` and any 3xx is refused; K7 covers 301/307/308/opaque.

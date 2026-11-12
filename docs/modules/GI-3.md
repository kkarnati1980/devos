# GI-3 — Gate integrity Part 3: the Release merge path (contract)

- **Linear:** DEVOS-143 (High) · Lane C · parent DEVOS-140
- **Spec:** KK, `claude/devos-gate-integrity-spec-v1.0.0.md` §6 (claude.ai Project), with the 12 Nov correction in DEVOS-143 (the cloud runners have no PreToolUse hook).
- **Depends on:** the review watcher's `codex-review` commit status (docs/modules/review-watch.md, step 6). Coordinates with DEVOS-139 (CI aggregator) and DEVOS-141 (floor guard).
- **Owned files:** `scripts/release/merge.mjs`, `scripts/release/required-checks.json`, `scripts/test/merge-gate.test.mjs`, this contract, `docs/decisions/0015-release-merge-path.md`.
- **Decision record:** `docs/decisions/0015-release-merge-path.md`.

## Goal
Every merge into `main` goes through one function that refuses unless the stored results are green for the PR's **current head SHA**, and that merges pinned to that SHA. Any commit after the review voids the PASS. A GitHub ruleset on `main` is the backstop (task GI-3b, below).

## Split (size check)
- **GI-3a (this PR):** the Release script, its config and tests, and the decision note. About 400 lines, one concern.
- **GI-3b (follow-up):** apply the `main` ruleset (block direct and force pushes; required checks). Applying it needs a token with repository Administration: write (the H3 token on the server), which the cloud runners do not hold. Required checks are added one at a time, each only after it reports on every PR: `codex-review` first, then the DEVOS-139 aggregator, then the DEVOS-141 floor guard. Each addition also goes into `required-checks.json` so the script and the ruleset agree.

## Behaviour — `node scripts/release/merge.mjs <pr> [--repo owner/name] [--dry-run]`
1. Read the PR. Refuse if it is not open, is a draft, does not target `main`, or its head is not in this repository.
2. **Green CI on the head SHA:** read every check run (latest per name, all pages). Refuse if there are none, if any is not completed, if any concluded other than success/skipped/neutral, or if none succeeded. The latest GitHub Actions run of every workflow on the SHA (highest run number, then attempt) must be completed with success/skipped/neutral, as the review watcher judges CI: a workflow whose later jobs (`needs:`) do not exist yet still refuses, and an older run superseded by a newer one (e.g. cancelled by concurrency after a reopen) is ignored. Every name in `requiredCheckRuns` must be present and `success` (a skipped required check is refused).
3. **Codex PASS on the head SHA:** the latest `codex-review` status must be `success`, must have been posted by the review watcher's account (`codexCreator` in `required-checks.json`, so a workflow's `GITHUB_TOKEN` cannot forge it), its description must start `Codex PASS`, and its `PR<n>-r<k>` label must name this PR. Any other status context on the SHA that is not `success` refuses.
4. **Main in the head (ADR-0013):** read the current `main` SHA; `compare main...head` must be `ahead` or `identical`.
5. **Floor guard:** once DEVOS-141 lands, its check name is added to `requiredCheckRuns` (step 2). Dispositions (spec §4.4) are handled with Part 1.
6. Merge with `PUT …/pulls/<n>/merge`, `sha=<evaluated head>`, `merge_method=merge`. GitHub refuses with 409 if the head moved; the script reports the refusal and **never retries the merge**. If the PUT fails in flight (timeout, network), the PR is read back: merged on the same head → exit 0; not merged → exit 2; unreadable → exit 2 with "merge outcome unknown". Lists longer than 20 pages refuse to be judged (exit 2).
7. Exit codes: `0` merged (or would merge, `--dry-run`) · `1` refused · `2` could not run. Exit 2 never merges.
8. Token from `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`; never printed. Every call has a 30 s timeout (ADR-0011); GETs are retried twice on 5xx or network errors, the merge PUT never.

## Acceptance tests (`scripts/test/merge-gate.test.mjs`)
| # | Pass when |
|---|---|
| AT1 | All green: exactly one merge call, pinned to the evaluated head SHA, method `merge` |
| AT2 | A missing, failed, pending, non-PASS or other-PR `codex-review` status, or a PASS posted by any account other than `codexCreator` (e.g. `github-actions[bot]`) or with no creator, refuses, with no merge call |
| AT3 | Failed, cancelled, timed-out, in-progress, absent or all-skipped CI refuses, with no merge call |
| AT3b | A workflow whose latest run is queued, in progress, failed or cancelled refuses; an older cancelled run superseded by a successful one, or a failed attempt superseded by a successful re-run, does not block |
| AT4 | `main` behind or diverged from the head refuses, with no merge call |
| AT5 | GC5: a head that moved between check and merge (GitHub 409) is refused and the merge is not retried; statuses are read for the head SHA only |
| AT5b | A merge PUT that fails in flight is read back: merged → exit 0, not merged → exit 2; the PUT is sent once. A PASS on an older SHA is never read for the new head |
| AT6 | A check named in `requiredCheckRuns` that is missing or skipped refuses; present and `success` passes |
| AT7 | A closed, draft, wrong-base or fork-headed PR, or another status that is failure, error or pending, refuses |
| AT8 | `--dry-run` never merges; a failure among check runs on page 2 is seen |
| AT9 | Bad arguments (including a `--repo` segment of dots), a network failure or persistent 5xx exit 2 with no merge; two 5xx on GET are retried; every call carries a timeout; the token never appears in output |

## Pass rule
`node --test scripts/test/merge-gate.test.mjs` exits 0 with 11 tests passing, and the diff touches only the owned files above.

## Green (DEVOS-143)
- **GC5** is AT5 (script side).
- **GC4** (direct merge refused, direct push rejected) is completed by GI-3b's ruleset; evidence goes on DEVOS-140.

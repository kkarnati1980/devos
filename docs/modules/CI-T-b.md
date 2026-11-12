# CI-T-b — ci-gate aggregator (DEVOS-152, task of DEVOS-139)

- **Lane:** C (runner B). **Spec:** KK, `claude/devos-ci-minutes-reduction-spec-v1.0.1.md`, constraint C2 and G4. **Decision:** `docs/decisions/0017-ci-gate.md`. **Used by:** DEVOS-143 / DEVOS-145 (the `main` ruleset requires this check).
- **Owned files:** `.github/workflows/ci-gate.yml`, `scripts/ci/ci-gate.mjs`, `scripts/test/ci-gate.test.mjs`, this contract, the decision note.

## Purpose
One check, `ci-gate`, that always reports on every PR into `main` and is green only when every other PR check on the head SHA is green. Path filters (a later DEVOS-139 step) can then skip jobs without leaving a required check unreported or a PR silently mergeable.

## Behaviour
1. **Expected set.** The PR head's `.github/workflows/*.yml` (the gate's own file excluded). The base commit's workflows are read too: if the PR removes or narrows a check `main` runs, the gate fails at once (exit 2), because removing a check needs its own approved change (G5). The head files stand in for the merge commit GitHub runs; a workflow changed on both sides can differ, and the base check covers the removal case. In each: every job of every workflow whose `pull_request` trigger applies to the PR's base branch (`branches` / `branches-ignore` with exact names or `*`). A check is named by the job's `name`, else its id. Push-only workflows are not expected.
2. **Fails closed** (exit 2) on anything it cannot reason about yet: `paths` / `paths-ignore` / `types` on `pull_request`, a job `if:`, a matrix, a reusable-workflow job, a computed job name, a branch glob, two jobs with one check name, an empty expected set, missing inputs, or an API read error. Path-filter support lands with the path-filter step, behind this gate.
3. **Wait.** Reads the head SHA's check runs (GitHub REST with `filter=all` so no older same-named run is hidden, 15 s timeout per call, paginated, up to 3 attempts per page for a 5xx, 429 or network error; a 4xx or a third failure is exit 2) every 20 s. Only runs by the `github-actions` app count, so another app posting a same-named success is ignored. A name reported from more than one check suite (another workflow run with a job of the same name, e.g. push-triggered) fails as `reported-by-more-than-one-workflow-run`; a re-run stays in its suite. (Closing and reopening a PR on the same SHA starts new suites, so the gate fails; push a new commit instead.) The newest run of each name counts (re-runs). Any completed conclusion other than `success` (failure, cancelled, timed_out, skipped, neutral, action_required, stale) fails at once. Not every check finished after 27 minutes → fail (the job's timeout is 30).
4. **Trust.** `pull_request` runs the PR's own copy of `ci-gate.yml`, so a PR can edit the gate (workflow or script). This job does not protect itself: changes to `.github/workflows/ci-gate.yml` and `scripts/ci/**` are guarded by the floor guard (DEVOS-141, which must list these paths before DEVOS-145 makes `ci-gate` required) and by Codex review. A ruleset "required workflow" from the base branch would close this; it is recorded for DEVOS-145.
4a. **Deadline.** 27 minutes from the gate's start, inside its 30-minute job timeout (the 0016 ceiling). A watched job still running then is close to its own 30-minute timeout; the gate fails closed and is re-run. **Re-runs:** the gate fails at the first failed check; after re-running that job, re-run `ci-gate` too (it is not re-triggered by other workflows).
4b. **Entry.** The CLI runs `main()` whenever it is the script node was asked to run, resolved through symlinks, spaces and `%`, so it can never exit 0 without checking.
5. **Exit codes:** 0 pass · 1 a check failed or did not finish in time · 2 error. Only 0 is a pass.

## Acceptance tests (`scripts/test/ci-gate.test.mjs`)
| ID | Test |
|---|---|
| AT1 | All expected checks succeeded → pass; any other conclusion of any expected check → fail at once, naming it |
| AT2 | A missing or unfinished check → pending; past the deadline → fail `not-finished-in-time`; finishes as soon as the last check passes |
| AT3 | `paths`, `paths-ignore`, `types`, job `if:`, matrix, reusable workflow, computed name, branch glob → `GateError` (exit 2) |
| AT4 | The newest run of a re-run check decides |
| AT5 | The gate's own workflow, push-only and other-branch workflows are not expected; job `name` or id is the check name; an empty set or a duplicate name is an error |
| AT6 | The repo's real workflows parse to exactly the 14 current PR checks; the CLI exits 2 on missing inputs or an unsupported workflow |
| AT7 | A check main runs that the PR deletes or narrows → exit 2 at once; added checks are expected; a missing base directory, or an absent/empty `GATE_BASE_WORKFLOWS_DIR` input, is an error (exit 2, Codex PR73-r3) |
| AT10 | A same-named run from another check suite fails the name; a re-run in the same suite counts |
| AT8 | Every read uses `filter=all`; pagination over 100 runs; another app's same-named run ignored; 5xx retried to success; 3 network failures or one 4xx → `GateError` |
| AT9 | Run through a symlinked path with a space and `%`, the CLI still exits 2 on missing inputs (fails on the old `file://` comparison) |

## Pass rule
`node --test scripts/test/ci-gate.test.mjs` exits 0, and on this PR's head the `ci-gate` check run is `success` only after the 14 other checks succeeded.

## Pre-review (runner B, 12 Nov 2026)
9 findings (1 high, 3 medium, 5 low); 7 fixed, 2 recorded:
- fixed: base ∪ head expected set (high); the trust claim corrected, and the base-script and bootstrap path dropped because the workflow itself comes from the PR (medium + low); entry guard via realpath (medium); Actions-app filter (low); bounded retries (low); exact check list and `listRuns` tests (low).
- recorded: the 27-minute deadline stays inside the 30-minute job ceiling from 0016 (a longer gate would need that ceiling raised for this one job; the gate fails closed if a job runs that long); re-running a failed job also needs a manual `ci-gate` re-run (documented above).
Re-review (CHANGES_REQUESTED, 7 findings): fixed — a same-named run from another workflow run can no longer stand in for a check (medium); a removed check fails at once instead of after the deadline (low); a suite test added. Recorded:
- **Stale green (medium), for DEVOS-145:** once `ci-gate` passes it does not look again, so a later failing re-run of a watched job leaves it green. DEVOS-145 must keep each job that has no path filter as its own required check alongside `ci-gate`, or add a re-trigger, before `ci-gate` is the only required CI check.
- **Merge order (medium):** this PR merges after #68 (DEVOS-139 step 1, `0016-ci-throughput.md`), which gives every watched job a timeout of 30 minutes or less; the 27-minute deadline assumes those.
- Tag-pinned Actions match every other workflow (repo-wide C3 follow-up); `main()` end to end with a stubbed `fetch` is left to the throwaway-PR proof in DEVOS-139.
- **Codex PR73-r1 (1 medium, fixed):** the check-runs read now passes `filter=all`; GitHub's default `latest` could hide an older failed run of the same name from another suite before the suite rule saw it. AT8 asserts the parameter.

## Codex PR73-r3 (13 Nov 2026; 1 medium, accepted)
- `expectedUnion` returned the head-only set when `GATE_BASE_WORKFLOWS_DIR` was absent or empty, so a misconfigured run skipped the base comparison. It now refuses that with a `GateError` (exit 2) before reading any workflow; the workflow always sets the input. Test: `undefined`, `""` and blanks are refused.

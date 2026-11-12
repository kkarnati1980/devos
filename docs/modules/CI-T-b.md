# CI-T-b — ci-gate aggregator (DEVOS-152, task of DEVOS-139)

- **Lane:** C (runner B). **Spec:** KK, `claude/devos-ci-minutes-reduction-spec-v1.0.1.md`, constraint C2 and G4. **Decision:** `docs/decisions/0017-ci-gate.md`. **Used by:** DEVOS-143 / DEVOS-145 (the `main` ruleset requires this check).
- **Owned files:** `.github/workflows/ci-gate.yml`, `scripts/ci/ci-gate.mjs`, `scripts/test/ci-gate.test.mjs`, this contract, the decision note.

## Purpose
One check, `ci-gate`, that always reports on every PR into `main` and is green only when every other PR check on the head SHA is green. Path filters (a later DEVOS-139 step) can then skip jobs without leaving a required check unreported or a PR silently mergeable.

## Behaviour
1. **Expected set.** From the PR head's `.github/workflows/*.yml` (the gate's own file excluded): every job of every workflow whose `pull_request` trigger applies to the PR's base branch (`branches` / `branches-ignore` with exact names or `*`). A check is named by the job's `name`, else its id. Push-only workflows are not expected.
2. **Fails closed** (exit 2) on anything it cannot reason about yet: `paths` / `paths-ignore` / `types` on `pull_request`, a job `if:`, a matrix, a reusable-workflow job, a computed job name, a branch glob, two jobs with one check name, an empty expected set, missing inputs, or an API read error. Path-filter support lands with the path-filter step, behind this gate.
3. **Wait.** Reads the head SHA's check runs (GitHub REST, 15 s timeout per call, paginated) every 20 s. The newest run of each name counts (re-runs). Any completed conclusion other than `success` (failure, cancelled, timed_out, skipped, neutral, action_required, stale) fails at once. Not every check finished after 27 minutes → fail (the job's timeout is 30).
4. **Trust.** The gate's code comes from the **base** commit; the PR head supplies only the workflow files. A PR cannot change the rule that judges it. Bootstrap: the PR that adds the gate has no base copy, so it runs the head copy once.
5. **Exit codes:** 0 pass · 1 a check failed or did not finish in time · 2 error. Only 0 is a pass.

## Acceptance tests (`scripts/test/ci-gate.test.mjs`)
| ID | Test |
|---|---|
| AT1 | All expected checks succeeded → pass; any other conclusion of any expected check → fail at once, naming it |
| AT2 | A missing or unfinished check → pending; past the deadline → fail `not-finished-in-time`; finishes as soon as the last check passes |
| AT3 | `paths`, `paths-ignore`, `types`, job `if:`, matrix, reusable workflow, computed name, branch glob → `GateError` (exit 2) |
| AT4 | The newest run of a re-run check decides |
| AT5 | The gate's own workflow, push-only and other-branch workflows are not expected; job `name` or id is the check name; an empty set or a duplicate name is an error |
| AT6 | The repo's real workflows parse to the 14 current PR checks; the CLI exits 2 on missing inputs or an unsupported workflow |

## Pass rule
`node --test scripts/test/ci-gate.test.mjs` exits 0, and on this PR's head the `ci-gate` check run is `success` only after the 14 other checks succeeded.

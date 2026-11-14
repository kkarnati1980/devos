# GI-1d — ci-gate honours valid floor-guard dispositions (contract)

- **Linear:** DEVOS-179 (parent DEVOS-140) · P2 · Lane A
- **Source:** follow-up named in `docs/modules/GI-1b.md` (Runner decisions → Aggregator); KK's spec `claude/devos-gate-integrity-spec-v1.0.0.md` §4.4.
- **Builds on:** GI-1b (`scripts/release/merge.mjs` step 2b), CI-T-b (`scripts/ci/ci-gate.mjs`, `.github/workflows/ci-gate.yml`), GI-1 (`applyDispositions`), DEVOS-181 (`KK_ONLY`). Needed before DEVOS-145 makes `ci-gate` a required check on `main`.
- **Applies:** D1, ADR-0011 (timeouts on every call, retries for safe reads only, no new egress: GitHub API only), ADR-0013 (runner decides technical design).
- **Owned files:** `scripts/ci/ci-gate.mjs` (the disposition step only), `.github/workflows/ci-gate.yml` (two read-only permissions only; no step changes), `scripts/release/merge.mjs` (step 2b moved into the exported `judgeFloorGuard` and `codexPass`, behaviour unchanged; `localGuardReport` gains `fetch`), `scripts/test/ci-gate-dispositions.test.mjs`, this contract.

## Goal
Today `ci-gate` fails whenever any check fails, so a floor guard that the Release path accepts (every hit has a valid Codex Keep, GI-1b) still leaves `ci-gate` red. Once the `main` ruleset requires `ci-gate`, GitHub would refuse that merge. `ci-gate` must pass in exactly the cases where the Release path sets the floor guard aside, using the same code.

## Behaviour
1. **Unchanged path.** `ci-gate` first waits for and judges every expected check as before (CI-T-b). Success → exit 0.
2. **Only when the floor guard is the one failure.** If the result is a failure whose only failed check is `floor-guard=failure` (no other failed check, nothing pending; a cancelled, timed-out, unreported or doubly reported floor guard does not qualify), `ci-gate` calls `floorGuardDisposition`. In every other case it fails as before.
3. **Same rules as the Release path, same code.** `floorGuardDisposition` reads the head's statuses and applies `codexPass` (the watcher's `codex-review` PASS for this PR, posted by `codexCreator`), checks that the PR's head is still this SHA, then calls `judgeFloorGuard`, the function the Release path's step 2b now is: guard-path changes need a `FLOOR-GUARD CHANGE <path>` line per path and a decision note; the floor guard is re-run with the base commit's copy on `base...head`; a report for another SHA, exit 2 or no hit refuses; a KK-only hit refuses ("escalate to KK"); every other hit needs a valid `FLOOR-GUARD KEEP` on the PASS comment's Summary line. Disposed → exit 0 with a log line saying so; otherwise each reason is logged and the gate fails (exit 1).
4. **Never waits for the PASS.** The review watcher reviews only heads whose CI is green, so `ci-gate` waiting for Codex would deadlock. `ci-gate` judges the PASS that exists when it runs; the job is re-run after the PASS lands (manually today; by the watcher after the follow-up below).
5. **Base, not main.** The re-run uses the PR's base SHA (`GATE_BASE_SHA`), as the `floor-guard` job does. The Release path still re-runs against current main before it merges, so a newer main is judged there.
6. **Inputs and history.** The PR number and base SHA are read from the workflow's event file (`GITHUB_EVENT_PATH`). The checkout is shallow, so before the re-run `fetchHistory` fetches base and head (`--unshallow` when shallow) with the job token passed only through git's environment config (`GIT_CONFIG_*`), never in arguments or `.git/config`.
7. **Fails closed.** A missing PR number or a malformed base SHA, a failed history fetch, a failed API read, or a release module that cannot be loaded is exit 2, never a pass.

## Runner decisions (14 Nov 2026, ADR-0013)
- **Share, not copy (issue MUST).** Step 2b of `merge.mjs` is moved verbatim into `judgeFloorGuard`, and the Codex status check into `codexPass`; `evaluate` calls both. The GI-1b tests (`merge-gate-floor-guard.test.mjs`, `merge-gate.test.mjs`) are unchanged and still pass, which shows the Release behaviour did not change.
- **Lazy import.** `ci-gate.mjs` loads `merge.mjs` only when it judges a disposition, so the CLI's existing input checks (CI-T-b AT9: the script copied alone still exits 2 on missing inputs) are untouched.
- **Guard-path rule only in the disposition branch.** When the floor guard passes, `ci-gate` does not apply the guard-path CHANGE rule; that stays with the Release path, as today. Applying it there would red every guard-path PR before review, and the watcher never reviews a red head.
- **Re-run, not wait.** See Behaviour 4. Option B of the issue (re-run `ci-gate` after the PASS) is the trigger; this change is what the re-run evaluates.
- **No step changes in `ci-gate.yml`.** Every change to a workflow step is a `ci-step-changed` floor-guard hit, and the watcher never reviews a red head, so a Keep could not be written for this very PR. The inputs therefore come from the event file and the history is fetched by the script; only two read-only token scopes are added (`statuses: read`, `pull-requests: read`). The checkout keeps `persist-credentials: false`; the token reaches git only for the one fetch, through its environment.

## Follow-ups (filed, Lane C)
- Review watcher: review a head whose only red results are the `floor-guard` failure and the `ci-gate` failure (today `ci_green` requires every workflow green, so a Keep can never be written), and after publishing a PASS with `FLOOR-GUARD KEEP` lines on such a head, re-run its failed `ci-gate` job.

## Acceptance tests (`scripts/test/ci-gate-dispositions.test.mjs`)
| # | Pass when |
|---|---|
| D1 | Only `floor-guard` failed and every hit has a valid Keep in the watcher's PASS → disposed; the re-run is against the PR base |
| D2 | Another failed check, a pending check, or a cancelled, timed-out or doubly reported floor guard → not judged, the guard is not re-run |
| D3 | No PASS, a PASS from another account or for another PR, or CHANGES_REQUESTED → not disposed (no waiting) |
| D4 | A missing Keep, a Keep for another SHA, a KK-only hit ("escalate to KK"), a clean or exit-2 re-run, or a report for another SHA → not disposed |
| D5 | A guard-path change without a CHANGE line and decision note → not disposed; with both → disposed |
| D6 | The PR head moved → not disposed; a missing PR number or malformed base SHA → error |
| D7 | The release module failing to load → error, never a pass |
| D8 | The PR number and base SHA are read from the event file; an unreadable file gives nulls (then D6's error) |
| D9 | The history fetch unshallows a shallow clone, passes the token only through git's environment (not in its arguments), and a failed fetch is an error |

## Pass rule
`node --test scripts/test/ci-gate-dispositions.test.mjs` exits 0 with 9 tests passing (D1–D9); `node --test scripts/test/ci-gate.test.mjs` exits 0 with 13 tests passing; `node --test scripts/test/merge-gate-floor-guard.test.mjs scripts/test/merge-gate.test.mjs` exits 0 with 26 tests passing.

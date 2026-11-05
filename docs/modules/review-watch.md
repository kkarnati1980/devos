# Review watcher (contract)

- **Linear:** DEVOS-60 · P1 · Lane C (ops tooling; bootstrap until M3.4 Codex reviewer replaces it)
- **Depends on:** M0.3 (review runner `scripts/review/review-commit.sh` v1.0.2, Codex CLI, read-only deploy key, verdict schema on the server)
- **Owned files:** `scripts/review/review-watch.sh` (v1.0.2), `scripts/review/install-review-watch.sh` (v1.0.2), this contract.
- **Approved by KK:** 4 Nov 2026 (build plan v1.0.0, section 7).

## Goal
Run the existing Codex review automatically on every new PR head, so a review no longer waits for KK at a terminal. D1 does not change: Codex reviews the exact SHA in its read-only sandbox, and merging still needs green CI **and** a PASS on that same SHA.

## Behaviour (each timer tick, every 3 minutes)
1. List open PRs on `kkarnati1980/devos`. Skip drafts.
2. Skip a head SHA that already has a stored verdict (`/root/.devos/verdicts/<sha>.json`) or a done-marker. A new commit gets a new review; an old verdict never carries over.
3. Read the contract from the PR body line `Review-Contract: docs/modules/<id>.md`. The path must start with `docs/`, end with `.md`, and contain no `..`. If the line is missing, post one comment for that SHA and do not review.
4. Review only when the latest GitHub Actions run of **every** workflow on that SHA has completed with success, skipped or neutral (all DevOS CI is Actions). Codex never sees failing code (PRD build loop, step 4).
5. Run the unchanged runner: `review-commit.sh main <sha> <contract> PR<n>-r<k>`, where k counts this PR's reviewed SHAs.
6. On a verdict: post a PR comment (verdict, SHA, contract, summary, findings table) and set the commit status `codex-review` to `success` (PASS) or `failure` (CHANGES_REQUESTED).
7. **Runner busy** (a manual review holds the lock): set status `pending`, post no comment, retry next tick.
8. **Runner failure:** post one comment with the last 15 log lines, secrets redacted, and set status `error`. Do not retry that SHA.
9. Ticks never overlap (own lock). `--dry-run` reports decisions and changes nothing.

## Secrets
- **Token:** a fine-grained GitHub token for `kkarnati1980/devos` only, with Pull requests RW, Commit statuses RW, Actions R, Contents R and Metadata R.
- **Storage:** entered at a hidden prompt into `/root/.devos/github-review.env` (mode 600). It is read with `sed`, never sourced, and reaches `curl` through a mode-600 header file in a mode-700 temp dir that is deleted on exit.
- **Never exposed:** the token is never printed, committed or passed on a command line. Runner output is redacted before posting: `sk-` keys and GitHub token prefixes.

## Acceptance tests
| # | Pass when |
|---|---|
| AT1 | Draft PRs and SHAs with a stored verdict are skipped |
| AT2 | A PR without a valid `Review-Contract:` line gets exactly one comment per SHA and no review |
| AT3 | A SHA whose CI is not all green is not reviewed |
| AT4 | A green SHA is reviewed once. The runner gets the exact SHA, contract and label `PR<n>-r<k>`. The verdict comment and the `codex-review` status (success for PASS, failure for CHANGES_REQUESTED) are posted once |
| AT5 | A busy runner leaves the SHA for the next tick (status pending, no comment); a failing runner yields one error comment with redacted log lines and no retry loop |
| AT6 | The token never appears in output, comments or files other than the 600 env file. The installer refuses anything that does not look like a GitHub token, and verifies every read the watcher needs (PRs, commits, workflow runs, statuses), naming the missing permission if one fails. An unreadable workflow-runs API is logged as a token problem, never as "CI not green" |
| AT7 | Installer: copies both scripts to `/root/.devos/bin`, runs a dry run, enables `devos-review-watch.timer`; uninstall is one command |
| AT8 | **Live (merge gate):** after install on the server, one real PR receives an automatic verdict comment and status on its head SHA. Recorded on DEVOS-60 |

**Builder verification:** AT1–AT5 were exercised locally against a mock GitHub API and a stub runner. The posted comments contained no leaked token pattern. `shellcheck -S warning` and `bash -n` pass.

**v1.0.1 (5 Nov 2026, first server run):** the dry run reported all three green PRs as "CI not green". The fine-grained token lacked **Checks: Read**, which the check-runs API needs, and `log()` wrote to stdout, so the HTTP 403 was captured into a variable instead of being shown. Both are fixed, and the installer now probes each read permission.

**v1.0.2 (5 Nov 2026):** fine-grained personal tokens cannot be given Checks permission (GitHub offers it only to GitHub Apps), so CI state now comes from the Actions API. It uses the latest workflow run per workflow for the head SHA, with **Actions: Read**.

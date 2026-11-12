# Review watcher (contract)

- **Linear:** DEVOS-60 · P1 · Lane C (ops tooling; bootstrap until M3.4 Codex reviewer replaces it)
- **Depends on:** M0.3 (review runner `scripts/review/review-commit.sh` v1.0.2, Codex CLI, read-only deploy key, verdict schema on the server)
- **Owned files:** `scripts/review/review-watch.sh` (v1.2.0), `scripts/review/install-review-watch.sh` (v1.1.0), `scripts/test/review-watch.test.mjs` (AT14–AT17), this contract.
- **Approved by KK:** 4 Nov 2026 (build plan v1.0.0, section 7).

## Goal
Run the existing Codex review automatically on every new PR head, so a review no longer waits for KK at a terminal. D1 does not change: Codex reviews the exact SHA in its read-only sandbox, and merging still needs green CI **and** a PASS on that same SHA.

## Behaviour (each timer tick, every 3 minutes)
1. List all open PRs on `kkarnati1980/devos`, across every page. Skip drafts.
2. Skip a head SHA whose result is already published. A SHA that was reviewed (or could not run) but whose comment or status did not post is **published again, never re-reviewed**. A stored verdict with no publication (e.g. a manual run) is published. A new commit gets a new review; an old verdict never carries over.
3. Read the contract from the PR body line `Review-Contract: docs/modules/<id>.md`. The path must start with `docs/`, end with `.md`, and contain no `..`. If the line is missing, post one comment for that SHA and do not review.
4. Review only when the latest GitHub Actions run (all pages read) of **every** workflow on that SHA has completed with success, skipped or neutral (all DevOS CI is Actions). Codex never sees failing code (PRD build loop, step 4).
5. Run at most **one review per tick** (the runner's 900 s limit then fits inside the service's 1200 s limit; other PRs wait for the next tick). Run the unchanged runner: `review-commit.sh main <sha> <contract> PR<n>-r<k>`, where k counts this PR's reviewed SHAs.
6. On a verdict: post a PR comment (verdict, SHA, contract, summary, findings table) and set the commit status `codex-review` to `success` (PASS) or `failure` (CHANGES_REQUESTED). The comment and the status are tracked separately per SHA; each is posted exactly once, and a failed post is retried on later ticks until both succeed.
7. **Runner busy** (a manual review holds the lock): set status `pending`, post no comment, retry next tick.
8. **Runner failure:** post one comment with the last 15 log lines, secrets redacted, and set status `error` (publication retried as in 6). Do not re-run the review for that SHA.
9. **Drain:** after the PR loop, any stored SHA whose comment or status has not posted is published to the PR recorded for it, even if that PR has moved to a newer head or closed.
10. Ticks never overlap (own lock). `--dry-run` reports decisions and changes nothing.
11. **Heartbeat (v1.2.0, DEVOS-105):** at the end of a tick, if the last heartbeat is at least `HEARTBEAT_SECONDS` old (default 3600), set the commit status `codex-review-watch` = `success` on the head of `main`, with the description `alive at <UTC>, <n> open PRs, <k> waiting for green CI`. A failed read or post is logged and retried on the next tick; it never fails the tick. A tick that stops earlier (for example, the PR list cannot be read) posts no heartbeat, which is the point: the heartbeat goes stale. `--dry-run` posts nothing and writes no state. **Reading it:** a newest `codex-review-watch` on main older than 2 hours means the watcher is down; a runner raises it at once (DEVOS-101 lost about 6 hours because nothing showed). A description with `CI unreadable (token)` means the token lost Actions: Read. GitHub keeps at most 1,000 statuses per SHA and context, so on a main that has not moved for about 41 days the heartbeat stops updating; a merge clears it. Every GitHub call has a timeout (connect 10 s, total `GH_TIMEOUT`, default 30 s, ADR-0011).

## Secrets
- **Token:** a fine-grained GitHub token for `kkarnati1980/devos` only, with Pull requests RW, Commit statuses RW, Actions R, Contents R and Metadata R.
- **Storage:** entered at a hidden prompt into `/root/.devos/github-review.env` (mode 600). It is read with `sed`, never sourced, and reaches `curl` through a mode-600 header file in a mode-700 temp dir that is deleted on exit.
- **Never exposed:** the token is never printed, committed or passed on a command line. Everything posted is redacted first, including verdict summaries and findings (`sk-` keys and GitHub token prefixes).

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
| AT9 | A failed comment or status post (HTTP 5xx) is retried on the next tick without re-running the review; each comment and status is posted exactly once; nothing is re-posted after both succeed |
| AT10 | Open PRs and workflow runs beyond the first page are read: a PR on page 2 is reviewed, and a workflow whose latest run is on page 2 is judged by that run |
| AT11 | A SHA whose publication failed is published on a later tick even after its PR moved to a new head |
| AT12 | With two green SHAs waiting, one tick runs one review and logs the other as queued; the next tick runs it |
| AT13 | A token or `sk-` key inside a verdict summary or finding never appears in the posted comment |
| AT14 | `gh_all` lists a page larger than the 128 KiB per-argument limit in full (105 PRs with 3 KB bodies; 103 workflow runs), and never passes page data as a jq argument (`scripts/test/review-watch.test.mjs`) |
| AT15 | Heartbeat: a tick posts one `codex-review-watch` status on main with the counts; another tick inside the interval posts none; after the interval a new one is posted |
| AT16 | A failed heartbeat read or post never fails the tick and is retried on the next tick |
| AT17 | `--dry-run` posts no heartbeat and writes no heartbeat state; the token never appears in output |
| AT8 | **Live (merge gate):** after install on the server, one real PR receives an automatic verdict comment and status on its head SHA. Recorded on DEVOS-60 |

**Builder verification:** AT1–AT5 were exercised locally against a mock GitHub API and a stub runner. The posted comments contained no leaked token pattern. `shellcheck -S warning` and `bash -n` pass.

**v1.0.1 (5 Nov 2026, first server run):** the dry run reported all three green PRs as "CI not green". The fine-grained token lacked **Checks: Read**, which the check-runs API needs, and `log()` wrote to stdout, so the HTTP 403 was captured into a variable instead of being shown. Both are fixed, and the installer now probes each read permission.

**v1.0.2 (5 Nov 2026):** fine-grained personal tokens cannot be given Checks permission (GitHub offers it only to GitHub Apps), so CI state now comes from the Actions API. It uses the latest workflow run per workflow for the head SHA, with **Actions: Read**.

**v1.0.3 (5 Nov 2026, first live tick):**
- **What happened:** the watcher found all three PRs, ran the runner, and posted the error comments and statuses, which proves the write permissions (part of AT8). Each runner failed at the deploy-key fetch (`Permission denied (publickey)`) under systemd's bare environment.
- **Fix:** the unit now sets `User=root`, `HOME=/root` and a normal `PATH`. The installer checks the deploy-key fetch under systemd.
- **Retry:** `RETRY_FAILED=1` clears the done-markers of SHAs whose review could not run.

**v1.1.0 (5 Nov 2026, Codex PR9-r2 findings, all medium):**
- **Lost results:** a verdict was marked done before its comment and status had posted, so one failed API call lost it for good. Publication state is now per SHA (`.msg`, `.state`, `.commented`, `.statused`, `.published`) and retried each tick until both succeed. v1.0.x `.done` markers still count as published.
- **Paging:** open PRs and workflow runs are read 100 per page, up to 30 pages.
- **Retry:** `RETRY_FAILED=1` also clears the new per-SHA state of SHAs without a verdict.
- **Builder verification:** against a mock serving 155 PRs and 122 runs per SHA (deciding run on page 2), with comment and then status posts failing on the first tick. Results: each review ran once; each comment and status posted exactly once after recovery; the third tick was idle; no token pattern in posts. `bash -n` and `shellcheck -S warning` pass.

**v1.1.1 (5 Nov 2026, Codex PR9-r3 findings, all medium):**
- **Superseded SHAs:** publication retries only covered current PR heads. A drain pass now publishes every pending SHA, using the PR number stored when its review ran.
- **Service timeout:** two reviews in one tick could exceed `TimeoutStartSec=1200` (900 s each). Now one review runs per tick.
- **Redaction:** verdict comments are now redacted like runner logs.
- **Builder verification (mock):** comment posts fail on ticks 1 and 2, and PR #3 moves to a new head between them. On tick 3, PR #3's old SHA is published ("no longer the PR head"). Tick 1 reviewed one SHA and queued the other; tick 2 reviewed the queued one. A GitHub token and an `sk-` key placed in a verdict appear only as `[redacted]`; 0 leaks. `bash -n` and `shellcheck -S warning` pass.

**v1.1.2 (5 Nov 2026, Codex PR9-r4, medium):** a stored manual verdict was published without recording its PR number, so the drain could not finish it after the PR moved on. The number is now written before publishing. **Mock test:** a manual PASS has its status post fail; the PR then moves to a new head; the next tick completes the publication ("no longer the PR head"). No review was run for that SHA.

**v1.1.3 (12 Nov 2026, DEVOS-113, outage fix):** from 15:34 IST on 11 Nov, no PR was reviewed. Every tick logged `jq: Argument list too long` at the page merge in `gh_all`, saw an empty PR list and exited 0. With 15 open PRs whose bodies are long, one page of `GET /pulls` exceeded Linux's 128 KiB limit for a single argument, and the page was passed to `jq --argjson`. Pages are now merged through temp files (`jq -s '.[0] + .[1]' acc page`), so page size is unbounded.
- **Test:** AT14. The old code reproduces the error on the same 330 KB page.
- **Emergency install (KK, 12 Nov):** the watcher reviews its own fix, so v1.1.3 was installed on the server from this PR's branch before its Codex review. The review then runs as normal; if it requests changes, the corrected version replaces it through the same path.
- **Same pattern, still to fix:** `server-agent.sh` `gh_all_runs` has the same jq-argument page merge (DEVOS-114).

**v1.2.0 (11 Nov 2026, DEVOS-105, runner-b):** the watcher stopped for about 6 hours on 11 Nov (DEVOS-101), and nothing on GitHub showed it. It now posts an hourly heartbeat status on main (behaviour 11). The state file is `watch/heartbeat.last` (epoch seconds) and the interval is `HEARTBEAT_SECONDS`. Design choices: a status on main rather than a comment, so nothing notifies people and the latest value is easy to read; at most hourly, well under GitHub's 1,000-statuses-per-SHA limit, and main moves on with each merge; the local state file instead of a status read, so one fewer API call per tick. **Tests:** `scripts/test/review-watch.test.mjs` (AT15–AT17; renumbered after AT14 went to the DEVOS-113 outage fix) against a mock GitHub API, 3/3, including an aged and a future state file, a GitHub call that never answers (cut off by the timeout), and no token in output. Pre-review: round 1 found 1 medium (no timeouts on GitHub calls) and 3 low, all fixed; round 2 PASS with 2 low (value checks, fixed) and 1 low deferred to DEVOS-106 (a comment POST that GitHub completes after the timeout can be posted twice on retry). `bash -n` and `shellcheck -S warning` pass. Deployment: the server agent installs the merged script into `/root/.devos/bin/` (allow-list); KK does nothing.

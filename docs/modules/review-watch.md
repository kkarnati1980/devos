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
| AT18 | (DEVOS-115) Only a PR whose `head.repo.full_name` is `kkarnati1980/devos` and whose author login is on `REVIEW_AUTHORS` (default `kkarnati1980`) is reviewed or published on (the drain only finishes publications stored for PRs that passed this check); a fork, a deleted head repo, a missing author, another login or a near-match login is logged once per head as "external PR, not reviewed" and nothing is posted. The trust check runs before every other step (`scripts/test/review-watch.test.mjs`). AT15–AT17 are left to DEVOS-105 (PR #42) |
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

**v1.2.0 (12 Nov 2026, DEVOS-115, public repo):** KK made the repo public on 12 Nov (ADR-0014) so Actions minutes are free. A stranger's fork PR must never reach the server's Codex runner (their code and text in the prompt, Codex usage spent, a `codex-review` status on code we never wrote). The watcher now trusts a PR only when its head is in `kkarnati1980/devos` **and** its author is on `REVIEW_AUTHORS` (space-separated logins, default `kkarnati1980`, set in the unit's environment if ever needed). Every other PR is logged once per head SHA (marker `watch/<sha>.external`) and skipped before the draft, publication, stored-verdict and review steps, so nothing is posted on it. **Decisions (runner B, technical):** (1) the check is on the PR object the watcher already lists, so it costs no extra API call; (2) both conditions are required: a collaborator's branch in our repo is still not reviewed unless the login is listed, and our own login on a fork is not reviewed; (3) a login must match `^[A-Za-z0-9-]+$` before the list lookup, so a crafted value cannot match through spaces; this also means a `[bot]` account can never be listed, and logins are compared case-sensitively (list them exactly as GitHub shows them). Both fail closed. **Pre-review (5 low, 3 fixed):** header and AT18 wording, bot/case note. Not changed: the drain has no trust check of its own, because a stored publication exists only for a PR that passed it (state from before v1.2.0 came from private-repo PRs); the ordering test reads the loop source rather than running a tick, the same harness style as AT14. **Server agent:** on `main` it reads PR data only through `merged_pr` (a PR already merged into `main`, which only KK's account can do), so it needs no change. The DEVOS-90 re-check tracking PR (PR #31, not merged yet) is found with `head=kkarnati1980:devos-recheck`, which GitHub limits to branches in KK's own account, and its author must be on the re-check list; a fork PR cannot match. **Install:** `review-watch.sh` is on the server agent's allow-list, so it self-updates when this merges; KK runs nothing. Defence in depth: KK's Actions setting "Require approval for all external contributors" means a fork PR has no workflow runs, so it would not be green either.

**v1.3.0 (11 Nov 2026, merged 12 Nov after v1.2.0, DEVOS-105, runner-b):** the watcher stopped for about 6 hours on 11 Nov (DEVOS-101), and nothing on GitHub showed it. It now posts an hourly heartbeat status on main (behaviour 11). The state file is `watch/heartbeat.last` (epoch seconds) and the interval is `HEARTBEAT_SECONDS`. Design choices: a status on main rather than a comment, so nothing notifies people and the latest value is easy to read; at most hourly, well under GitHub's 1,000-statuses-per-SHA limit, and main moves on with each merge; the local state file instead of a status read, so one fewer API call per tick. **Tests:** `scripts/test/review-watch.test.mjs` (AT15–AT17; renumbered after AT14 went to the DEVOS-113 outage fix) against a mock GitHub API, 3/3, including an aged and a future state file, a GitHub call that never answers (cut off by the timeout), and no token in output. Pre-review: round 1 found 1 medium (no timeouts on GitHub calls) and 3 low, all fixed; round 2 PASS with 2 low (value checks, fixed) and 1 low deferred to DEVOS-106 (a comment POST that GitHub completes after the timeout can be posted twice on retry). `bash -n` and `shellcheck -S warning` pass. Deployment: the server agent installs the merged script into `/root/.devos/bin/` (allow-list); KK does nothing. **Merge with v1.2.0 (12 Nov, runner B):** renumbered to v1.3.0; the heartbeat counts only trusted PRs (an external PR is skipped before the CI step), and the HB1 mock PR now carries an owner author and head repo.

**v1.4.0 (12 Nov 2026, DEVOS-116, runner-b): the longest-waiting head goes first.**
- **Problem.** The watcher reviewed the first green, unreviewed head in GitHub's newest-first PR list. Each new push to a newer PR jumped the queue, and older PRs waited an hour or more (#30, #36 and #37 on 12 Nov).
- **Change.** The loop now only collects candidates.
  - The first time a head is seen green, that time is stored in `watch/<sha>.green` (epoch seconds; never written in `--dry-run`).
  - After the loop, the candidate with the oldest first-green time is reviewed; a tie goes to the lower PR number.
  - Every other candidate is logged as queued for the next tick.
- **Unchanged.** It is still one review per tick (runner limit 900 s < service limit 1200 s). The trust check still comes before everything else, and the runner has a single call site, which runs only on a queued candidate.
- **Design choice.** The first-green time is used rather than the PR's `updated_at` (a push bumps that) or the PR number alone (a PR re-pushed after a review should not jump ahead of heads that have waited longer).
- **Tests:** `scripts/test/review-watch.test.mjs`, 9/9.
  - AT19: three green heads listed newest first are reviewed oldest-green first, one per tick; a tie goes to the lower PR number; `--dry-run` stores nothing.
  - AT18's structural check now follows the new shape: trust comes before `cands+=`, and there is exactly one runner call site.
- **Deployment:** the server agent installs the merged script (allow-list); KK does nothing.
- **Pre-review (1 medium, 3 low; 3 fixed):**
  - The clock is read once per tick, so heads first seen green in the same tick tie, and the lower PR number wins (medium). Test: a slow mock, with each CI read taking more than 1 s.
  - A future first-green time (the clock stepped back) is reset to now.
  - The runner and `publish` get `</dev/null`, so they can never read the candidate list.
  - Not changed: per-SHA state files, `.green` among them, are not pruned (as before).

**v1.4.1 (12 Nov 2026, DEVOS-106, runner-b): no duplicate verdict comment.**
- **Problem.** A comment POST that GitHub completes after our 30 s timeout used to be posted again on the next tick.
- **Fix.** Before each comment POST, the watcher writes `watch/<sha>.comment-tried`. On a retry, when that marker exists, it first reads the PR's comments (all pages, bounded like every GitHub call). A comment that starts with the same first line (`### Codex review <label> — **<verdict>**`) and carries `- **Commit:** \`<sha>\`` counts as posted. The watcher then only sets the status. Normal ticks make no extra call.
- **Tests:** AT20.
  - A POST that GitHub stores but never answers leaves exactly one comment after the retry tick, and the PR is published.
  - A tried comment with no copy on GitHub is posted once.
  - `review-watch.test.mjs`: 10/10.
- **Pre-review (2 medium, 2 low; all fixed):**
  - **A failed comment read posts nothing.** It is now its own outcome (return code 2): the watcher logs it, skips the comment POST for that tick and still sets the status. So a slow GitHub can no longer cause a duplicate.
  - **Only the watcher's own comment counts.** The comment must be authored by `REVIEW_BOT_LOGIN` (default `kkarnati1980`, the account whose token posts), so another user's forged copy cannot suppress the real verdict.
  - **The query string is now `?per_page=100`**, replacing the no-op `sort=created`.
  - **AT20 covers more cases:** a failed comment read, a forged comment by another login, and an own comment that belongs to a different SHA.
- **Codex PR52-r2 (1 medium, accepted):** runner-failure reports ("could not run") had no commit line, so a retry could not recognise one that GitHub had stored. They now carry `- **Commit:** \`<sha>\`` like verdicts do, and the same duplicate check covers them. Test: a failure report whose POST timed out is not posted again (review-watch 11/11).
- **Codex PR52-r5 (1 medium, accepted):** `gh_all` stops after 30 pages. A comment list that reaches 3,000 entries may be truncated, so it now counts as indeterminate (return 2): the POST waits instead of risking a duplicate. Test: every page full → no POST, nothing marked posted (review-watch 12/12).

**v1.5.0 (13 Nov 2026, DEVOS-172, runner B): a review that could not run is retried.**
- **Problem.** From 13:11 IST on 13 Nov, the OpenAI credit ran out. Every review ended "could not run (exit 1)" after about 10 s: PR83-r2, PR85-r5, PR88-r2 and PR89-r1. The watcher treated that `error` as final for the SHA. So once Codex worked again, each of those PRs needed a new head, and each new head cost one more paid review. (The quota itself is KK's to top up. Runner A emailed him at 13:29 IST, and reviews ran again by 13:38 IST.)
- **Change.**
  - When the runner exits without a stored verdict, attempt *k* (with *k* below `REVIEW_RETRY_MAX`, default 3) is no longer final.
  - The watcher stores `watch/<sha>.fails` = *k* and `watch/<sha>.retry_at` = now + `REVIEW_RETRY_BASE`·2^(k−1) seconds (default 600 s, then 1200 s, capped at `REVIEW_RETRY_CAP`, default 3600 s).
  - It sets `codex-review` = pending, with "could not run (attempt k of N); retry in m min".
  - It posts no comment. It writes no `.pr` or `.label`, so the retry keeps the same round label (`PR<n>-r<k>`).
  - Until `retry_at` passes, the head is logged and skipped. After that, it is a normal candidate again, still one review per tick and oldest first-green first.
  - Only the last attempt posts the "could not run" report, which now carries `- **Attempts:** N of N`, and the final `error` status, as before.
  - The installer's `RETRY_FAILED=1` also clears `.fails` and `.retry_at` (installer v1.1.1).
- **Decisions (runner B, technical).**
  - **3 attempts over about 30 minutes.** That covers a short outage. A longer one (such as the credit running out) still ends in the visible `error` and the STUCK alert, instead of retrying forever.
  - **A failed attempt costs no Codex usage.** The runner fails before Codex answers, so retrying does not spend credit.
  - **A `retry_at` further ahead than the cap counts as due.** That covers a clock stepped back or a bad file, so a head is never blocked for longer than the cap.
  - **The status stays `pending` between attempts,** so runners see the head is still in progress and do not push a new head to refresh it (review cost rule, 12 Nov).
- **Tests:** `scripts/test/review-watch.test.mjs`, 14/14.
  - AT21: attempt 1 posts pending with a 600 s back-off, no comment, and no round used up. A tick before `retry_at` does not run the runner. Attempt 2 doubles the back-off and keeps the label. Attempt 3 posts the report ("Attempts: 3 of 3") and `error`. No run happens after that.
  - AT21: a retry that succeeds publishes the PASS as `PR<n>-r1`. `REVIEW_RETRY_BASE` sets the back-off. A `retry_at` beyond the cap counts as due.
  - The existing AT20 (PR52-r2) test now pins `REVIEW_RETRY_MAX=1`, so it still checks that a final failure report is not posted twice. Its assertions are unchanged.
- **Deployment:** the server agent installs the merged script (allow-list). KK does nothing.

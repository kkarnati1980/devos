# Server agent (contract)

- **Linear:** DEVOS-74 · P1 · Lane C · critical path (blocks DEVOS-47, the G1 gate)
- **Depends on:** M0.3 (read-only deploy key `/root/.ssh/devos_ro`), the review watcher (DEVOS-60: `codex-review` commit status and the GitHub token in `/root/.devos/github-review.env`), M0.4 (local Coolify API on `http://localhost:8000/api/v1`).
- **Owned files:** `scripts/server/server-agent.sh` (v1.1.0), `scripts/server/install-server-agent.sh` (v1.1.0), `scripts/server/checks/*.sh`, `scripts/test/server-agent.test.mjs`, this contract.
- **Approved by KK:** 6 Nov 2026 (DEVOS-74). It removes the need for KK at the server terminal after one install.
- **Applies:** ADR-0011 (timeouts on every outbound call, retries only for safe operations), D1 (merge and deploy only on green CI + Codex PASS for the exact SHA), the continuous-build runbook (no runner access to the server; one installer that KK runs once).

## Goal
A root systemd timer on the DevOS server that, for each new `main` commit that has passed D1, (1) installs the merged server scripts, (2) redeploys DevOS through Coolify, and (3) runs named server checks and posts their result to GitHub. Gate evidence that can only be seen on the server comes from these checks.

## The D1 gate for a `main` SHA (`gate_ok`)
A `main` SHA passes only when **both** hold:
1. **Green CI:** the latest GitHub Actions run of every workflow for that SHA is `completed` with `success`, `skipped` or `neutral`, and there is at least one run (same rule as the review watcher).
2. **Codex PASS**, one of:
   - the SHA itself has commit status `codex-review` = `success`; or
   - the SHA is the merge commit of a merged PR whose head SHA has `codex-review` = `success`, **and** the merge commit's tree equals that head's tree. So the deployed code is exactly the code Codex passed. A merge that brought in other changes (main had moved on) is refused until the SHA has its own PASS.

Any GitHub read error (runs, statuses, PRs, trees) means **wait** for the next tick, never accept. Anything else is **refused**: nothing is installed or deployed for it, and the refusal is posted once as status `devos-deploy` = `failure` ("refused: no green CI + Codex PASS for this exact SHA (D1)").

## Behaviour (each tick, every 3 minutes)
1. One tick at a time (`flock`); every `curl` has `--connect-timeout 10 --max-time 30`; each check script runs under `timeout 120`; the service has `TimeoutStartSec=1500`.
2. Read `main`'s head SHA. If this SHA was already fully handled, end the tick.
3. Evaluate the gate. If it fails because CI is still running, wait for a later tick (no status). If it fails for good (CI red, no PASS, tree mismatch), post the refusal once.
4. **Self-update:** fetch the SHA with the read-only deploy key into `/root/devos-agent` (its own work tree, never the review runner's), check it out detached and verify `HEAD` equals the SHA. Then install the **allow-list** only:
   - `scripts/review/review-watch.sh`, `scripts/review/review-commit.sh`, `scripts/server/server-agent.sh` → `/root/.devos/bin/`;
   - `scripts/server/checks/*.sh` → `/root/.devos/bin/checks/` (checks no longer on `main` are removed).
   Every file must pass `bash -n` first, or nothing is installed. Each file is written to a temp name and renamed, so a running script is never rewritten in place. The installed SHA is recorded.
5. **Deploy-on-PASS:** only when deploy is enabled (below) and the SHA differs from the last deployed SHA. It sets the Coolify app's `git_commit_sha` to the exact SHA, starts a deploy, and polls the deployment every 10 s for at most 15 minutes of wall-clock time per tick; a deployment still running then is resumed by the next tick. A deploy is **never submitted twice** for a SHA: a start marker is written before the first Coolify call and the deployment id as soon as Coolify returns it; a tick that finds a start marker without an id (interrupted mid-submit) records the outcome as unknown and a failure. It posts status `devos-deploy` = `success` or `failure` on the SHA. A failed deploy is retried only by KK: `RETRY_DEPLOY=1 bash /root/.devos/bin/install-server-agent.sh --deploy-on` (or a new commit).
6. **Server checks:** after a successful deploy (or after the self-update when deploy is not enabled yet), run each `/root/.devos/bin/checks/*.sh` with `DEVOS_SHA` set. Exit 0 = pass, 3 = skipped (not applicable yet), anything else or a timeout = fail. Post status `server-check` = `success` (no failures and at least one check) or `failure`, with "n/m passed, k skipped". Post a comment with each check's name, result and its last 20 output lines, redacted, on the merged PR (found through `commits/<sha>/pulls`), or as a commit comment when there is no PR.
7. Publication is tracked per SHA with marker files named `<name>.<sha>` (`refused`, `installed`, `deployed`, `deploy-statused`, `check-statused`, `check-commented`, `done`). A failed post is retried on later ticks; the actions it reports (install, deploy, checks) are never repeated for that SHA. A **drain** at the start of each tick publishes stored results of earlier SHAs, so a failed post survives `main` moving on.
8. `--dry-run` reports the decisions and changes nothing: no GitHub or Coolify writes, no state files.
9. Every install step (copy, rename, compare, recording the SHA) propagates failure; a failed step records the SHA as refused and nothing later runs for it.

## First launch and the deploy switch
- Deploy is **off** until KK turns it on in the installer (rules.md: first launch needs KK's approval). The installer asks "Approve deploy-on-PASS now? (yes/no)"; only `yes` writes `/root/.devos/agent/deploy.enabled`. Until then each tick does the self-update and the checks, and logs "deploy disabled".
- Approving later: `bash /root/.devos/bin/install-server-agent.sh --deploy-on` (asks yes/no). The current `main` SHA, if it was handled while deploy was off, is deployed on the next tick.
- Turning it off again: `bash /root/.devos/bin/install-server-agent.sh --deploy-off`.

## Safety
- **Allow-listed actions only.** The agent runs no command, path or argument taken from GitHub content (PR bodies, comments, verdicts). The only code it runs is files from the allow-list, at a SHA that passed D1, i.e. reviewed code.
- **Secrets:** the Coolify API token and the app UUID are entered once at hidden prompts by the installer into `/root/.devos/coolify-deploy.env` (mode 600). The GitHub token is the review watcher's `/root/.devos/github-review.env`. Both are read with `sed`, never sourced, never printed, never on a command line: they reach `curl` through mode-600 header files in a mode-700 temp dir deleted on exit. Everything posted or logged from command output is redacted (`sk-` keys, GitHub token prefixes, `Bearer` values, and the literal Coolify token value).
- **Uninstall:** `bash /root/.devos/bin/install-server-agent.sh --uninstall` stops the timer, stops a running tick (waiting for it to end), and removes both units. It leaves the env files and the review watcher alone.

## Acceptance tests
| # | Pass when |
|---|---|
| AT1 | A `main` SHA with green CI and its own `codex-review` success is installed: the allow-listed files land in `bin/`, the installed SHA is recorded, and a file outside the allow-list (e.g. `scripts/server/install-server-agent.sh`) is not installed |
| AT2 | A merge commit whose PR head has a PASS and the same tree is accepted; a merge commit whose tree differs from the PASSed head is refused |
| AT3 | A SHA without a PASS (or with red CI) is refused: nothing installed, nothing deployed, one `devos-deploy` failure status, no repeat on the next tick |
| AT4 | With deploy enabled, a passing SHA is deployed through Coolify with `git_commit_sha` set to that exact SHA, and `devos-deploy` = `success` is posted; with deploy disabled, Coolify is never called |
| AT5 | Server checks run after the deploy; `server-check` is posted with the right state and "n/m passed", and a redacted comment goes to the merged PR |
| AT6 | A failed status post is retried on the next tick without re-running the deploy or the checks |
| AT7 | The Coolify token, the GitHub token and an `sk-` key printed by a check never appear in any post or the agent's log |
| AT8 | A file failing `bash -n` blocks the whole install for that SHA |
| AT9 | A second tick on an already-handled SHA makes no API writes |
| AT10 | **Live (G1 evidence):** after KK's install, a merged watcher change is live on the server without KK; a PASSed `main` SHA is deployed; a server check posts a status. Recorded on DEVOS-74 |

AT1–AT9 run in CI (9 tests, including the PR11-r1 regressions: unreadable tree, paged runs, drain after main moves, dry run with a stored refusal, deploy resume and no resubmit) (`scripts/test/server-agent.test.mjs`) against a mock GitHub API, a mock Coolify API and a local git repo standing in for the deploy-key remote.

## Example check
`scripts/server/checks/dashboard-tailnet-only.sh`: the dashboard answers HTTP on the tailnet IP (`tailscale ip -4`) and does **not** answer on any public IPv4 address of the host. Port from `DASHBOARD_PORT` in `/root/.devos/server-agent.conf` (default 3000). It reports skipped (exit 3) while nothing answers on the tailnet port, i.e. before the dashboard is deployed (M1.3). A skipped check is never counted as passed. **Limit:** probing the host's own public IP from the host tests the listener binding, not the cloud firewall; the firewall half of the G1 check still needs an outside probe.

**v1.1.0 (6 Nov 2026, Codex PR11-r1, 3 high + 6 medium, all accepted):** tree reads are validated and a read error is a wait (high); `self_update` propagates every failure and compares installed files (high); deploy uses a wall-clock budget with resume and is never resubmitted (high); a drain publishes earlier SHAs; marker names are consistent (`<name>.<sha>`), so `done` is reached and the installer's cleanup matches; `--dry-run` never posts; workflow runs are paged; `RETRY_DEPLOY=1` is implemented; `--uninstall` stops a running tick.

# Server re-check requests (DEVOS-90)

This file exists only so that the **draft tracking PR** for server re-checks has a head branch
(`devos-recheck`). The PR is never merged and never marked ready for review, so the Codex review
watcher skips it and no review is spent on it.

## How to use it
1. Open the draft pull request whose head branch is `devos-recheck`.
2. Add a comment whose whole text is `/recheck` (nothing else on the line).
3. Within about 3 minutes the server agent runs the installed server checks again on the live SHA.
   It posts a `server-check` status on that SHA (description `re-check: n/m passed[, k skipped]`)
   and a comment on this PR headed `### Server re-check (request) at <sha>`.

Only logins in `RECHECK_AUTHORS` (default `kkarnati1980`) can request a re-check. Any other text,
or a comment from another login, does nothing. The comment selects nothing: no SHA, check name or
argument is read from it. The agent also re-checks on its own every 6 hours.

Contract: `docs/modules/server-agent.md`, step 10.

# 0029 — Delete a PR's branch automatically when it is closed without merging

- **Status:** Accepted (runner B, 16 Nov 2026). Branch deletion is data deletion: KK approved exactly this scope on 16 Nov 2026, 14:42 IST (DEVOS-197, "Reopened 16 Nov 2026: part 2"). The technical choices below are runner B's under ADR-0013.
- **Linear:** DEVOS-197 part 2 · Contract: `docs/modules/S2.md` ("DEVOS-197 part 2 build notes")

## Context
`secret-scan` scans every branch of this public repo. On 13, 14 and 16 Nov a leftover branch of a closed PR held a fake, key-shaped test value, and that one branch turned `secret-scan` and `ci-gate` red on every open PR until KK deleted it by hand. The runners' tools refuse to delete branches.

## Decision
1. **Trigger.** `.github/workflows/cleanup-closed-pr-branch.yml` on `pull_request_target: [closed]`. A job-level `if` already skips merged PRs and forks; the script checks both again.
2. **No PR code runs.** The only checkout takes no `ref`, so it checks out `GITHUB_SHA`, which for `pull_request_target` is a commit of this repo's own branch (the default branch on current GitHub; on older behaviour the PR's base branch, which is still this repo's code because forks are excluded), is sparse to `scripts/ci` and keeps no credentials. Nothing from the PR head is interpolated with `${{ }}`; the branch name reaches the script only through the event file. AT6 is a test over the workflow file.
3. **Scope** (`scripts/ci/cleanup-closed-pr-branch.mjs`): only `kishore/devos-*` names (plain characters, no `..`, no `.lock`), only this repo's branches. Skipped, with the reason logged: `main` or the default branch; a branch whose `protected` flag is not `false`; a branch any ruleset rule covers (`GET /rules/branches/{branch}` non-empty; an unreadable rule list fails the run without deleting); a branch that is the head of any open PR (the closed PR included, in case it was reopened before the job ran) or the base of one (deleting a base would close the PRs that target it); a PR that no longer re-reads as closed and unmerged just before the delete; a branch already gone (a 404, or a 422 saying the reference does not exist; any other 422 fails the run).
4. **Token.** `permissions: {}` at the top, and the one job gets `contents: write` (the delete) and `pull-requests: write` (the comment KK asked for in item 3 needs it; `contents: write` alone cannot comment). No other secret.
5. **ADR-0011 / D7.** `actions/checkout` pinned to the same full SHA as the other workflows (v5.1.0); job timeout 3 minutes; a 10-second timeout on every REST call; no retries (a delete is not safe to repeat blindly, and a failed read only stops the run).
6. **Comment.** After a delete: "Branch deleted automatically because this PR was closed without merging. Use 'Restore branch' above to bring it back."
7. **Backlog, list only.** `node scripts/ci/cleanup-closed-pr-branch.mjs --list-backlog` (with `GITHUB_REPOSITORY` and `GITHUB_TOKEN`) lists the existing `kishore/devos-*` branches of closed, unmerged PRs that no open PR uses. It deletes nothing. The list goes on DEVOS-197; deleting it needs KK's separate "go" after he has seen it.

## Consequences
- A time-of-check window of milliseconds remains between the reads and the delete (a new PR or protection added in between is not seen); a protection added in that window makes GitHub refuse the delete, which fails the run.
- A closed-unmerged PR's branch is gone within about a minute; GitHub's "Restore branch" button on the PR brings it back.
- Merged PRs keep their current behaviour (unchanged by this workflow).
- Rollback: delete the workflow file (a floor-guard `ci-workflow-deleted` hit, so it needs a Codex Keep or KK) or disable the workflow in the Actions tab.

# ADR-0014: the DevOS repository is public

- **Status:** accepted (KK, 12 Nov 2026, 11:58 IST)
- **Issue:** DEVOS-115 (watcher hardening); recorded by runner B

## Context
On 12 Nov 2026 GitHub stopped starting Actions jobs on `kkarnati1980/devos`: the account's Actions budget is $0 and the private-repo minutes were used up (about 860 run-minutes and 530 runs in the previous 24 hours). Every PR was blocked on CI. KK was offered three options: set a budget, trim CI, or make the repo public (standard runners are free for public repos).

## Decision
KK chose to make the repository public. Visibility changed at 06:39:59Z (12:09 IST) on 12 Nov 2026.

## Checks done before the switch
- gitleaks over all 201 commits on all branches: no leaks.
- The docs name the server's public IP and the tailnet name. Public SSH is closed (M0.2 AT5), so this is low risk.
- Secrets stay in the server vault and Coolify env (rules.md "Never"); this does not change.

## Consequences
- Anyone can open a PR from a fork. Two controls keep that away from the server:
  1. KK's Actions setting "Require approval for all external contributors": a fork PR runs no workflows until KK approves them.
  2. review-watch v1.2.0 (DEVOS-115): only PRs whose head is in this repo and whose author is on the allow-list are reviewed or posted on.
- CI minutes cost nothing, so the CI workflow is not trimmed for cost.
- Everything committed from now on is world-readable. The existing rules already forbid secrets in the repo; agents keep server addresses and account details out of new docs where they are not needed.

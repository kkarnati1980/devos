# 0024 — Local secret scan before every push, and the test-fixture rule

- **Status:** Accepted (runner B, 14 Nov 2026, under ADR-0013's technical delegation)
- **Linear:** DEVOS-197 · Contract: `docs/modules/S2.md` ("DEVOS-197 build notes")

## Context
CI's `secret-scan` runs gitleaks over the history of every fetched branch. A key-like test fixture pushed to any branch therefore fails `secret-scan` and `ci-gate` on main and on every open PR until that commit leaves all branches. This happened on 13 Nov (`kishore/devos-177-…`, about 3.5 hours red; KK deleted the branch) and on 14 Nov (`kishore/devos-178-…`, commit `a81a8e3`, `generic-api-key`; about 15 failure emails). The scan was right both times: the runners pushed before scanning.

## Decision
1. `pnpm secret-scan:local` scans the commits about to be pushed (`origin/main..HEAD`, or `--base <ref>`) with the CI-pinned gitleaks, its default rules and `.gitleaksignore`. It refuses (exit 2) a gitleaks that is not the pinned version, and drops `GITLEAKS_CONFIG` from the environment, so its rules are CI's. Exit 1 means: do not push.
2. The scan covers the checked-out branch (`<base>..HEAD`), so a runner pushes only that branch (`git push origin HEAD`); before pushing any other branch, check it out and scan it. Both runners run it before **every** push, including review fix rounds and up-to-date merges, and the pre-PR checklist includes it. (Coordinator: this line goes into both runner prompts once this merges.)
3. **Fixture rule.** A test value that looks like a secret is obviously fake and low-entropy (for example `test-key-not-real`), or built at run time (as `scripts/security/selftest.mjs` does). Never add to `.gitleaksignore` to silence a hit; the floor guard (DEVOS-141) already blocks that, and an ignore entry is a security-scanning change only KK can approve.
4. If the scan finds a value in an unpushed commit, rewrite your own unpushed commits so the value never reaches GitHub. A commit already pushed is handled as on 14 Nov: rewrite your own unreviewed branch, never another runner's.

## Consequences
- The CI scan is unchanged; the local scan is an extra, earlier check, so nothing is weakened.
- The local scan needs gitleaks: `node scripts/security/install-gitleaks.mjs` installs the pinned, checksum-verified copy (linux x64).
- Rollback: revert the PR; CI behaviour does not change either way.

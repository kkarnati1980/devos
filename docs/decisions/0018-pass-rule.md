# 0018 — Pass rule in every module contract (gate integrity Part 2)

- **Status:** Accepted (runner A, 12 Nov 2026, under ADR-0013's technical delegation)
- **Linear:** DEVOS-142 · Contract: `docs/modules/GI-2.md`

## Context
KK's gate-integrity spec (12 Nov 2026) §5 requires that each module contract states a pass rule a program can evaluate. Delegated gate approval (Part 4) then rests on stored results rather than on judgement.

## Decision
1. Every contract has a `## Pass rule` section (or one per sub-part). Each bullet names at least one of these anchors: a command, a test file or acceptance-test id, an exit code, an HTTP status, a threshold, or, for UI, a screenshot diff or a checklist script. Judgement words alone are rejected.
2. The check is `scripts/contracts/check-pass-rule.mjs`, run by the `contract-check` workflow on the contracts a PR adds or changes. It has no dependencies and its exit codes are 0/1/2, with 2 never valid.
3. The validator is the schema for this Markdown field. `build-standard.schema.json` describes the standard catalogue, whose checks already carry `how`/`check`/`evidence`, so it stays unchanged.
4. Backfill follows lane ownership. Runner A backfills M2.1 and M2.2 now. Runner B backfills the Lane B and C contracts of P2 (GI-2b), so its open PRs are not forced into new reviews.

## Consequences
- A PR that edits a contract without a valid pass rule fails `contract-check`.
- Part 4 (DEVOS-144) can require, per module, the suites named in its pass rule to pass on the merged SHA.

# 0022 — Floor guard: the shared KK-only classifier is a guard path (guard change, spec §4.5)

- **Status:** Accepted (runner A, 14 Nov 2026, under ADR-0013's technical delegation)
- **Linear:** DEVOS-189 · Contract: `docs/modules/GI-1.md` · Follows notes 0021 and DEVOS-181 (PR #109).

## Context
Since DEVOS-181, `scripts/gates/kk-only.mjs` is the one function that decides which floor-guard hits only KK can clear, for both the gate evaluator (GI-4) and the Release merge path (GI-1b). It was not a guard path, so a later PR could narrow it, letting Codex clear a security-scanning hit, together with other changes and without any marker (DEVOS-181 pre-review, advisory).

## Decision
1. `scripts/gates/kk-only.mjs` and `scripts/test/kk-only.test.mjs` are added to `GUARD_PATHS`. A change to either must now come alone (only guard paths, `docs/decisions/*.md` and GI-1.md), and the Release path refuses it unless the Codex PASS names each changed path with `FLOOR-GUARD CHANGE <path>`.
2. The two files are **not** exempt from the content rules. Exemption stays with the guard's own three paths (`CONTENT_EXEMPT` in `floor-guard.mjs`), whose tests hold the very patterns they match. `kk-only.mjs` is written so it does not match those patterns itself (it uses one-character classes), so a suppression, a skipped or `.only` test, or a deleted test in the classifier or its table is still a hit (DEVOS-189 pre-review, high finding: exempting them would have hidden exactly those changes).
3. This PR changes only guard paths, GI-1.md and this note. rules.md's Review guidelines still list the first three guard paths only; updating that text (and the generated CLAUDE.md / AGENTS.md) is a separate PR, because rules.md is not a guard companion. Until then, a kk-only change fails closed: Codex has no instruction to write the marker, so the Release path refuses it.

## Consequences
- Fails closed on companions: GI-4.md (the classifier's own contract) is not a guard companion, so a classifier change that also edits GI-4.md, or a rename of either file, raises `guard-change-not-isolated`, which is KK-only. Such a contract change goes in its own, non-guard PR. GI-4's owned-files line will say this in a later non-guard PR.
- No pattern is narrowed; the guard only covers two more files.
- `merge.mjs` imports `GUARD_PATHS`, so the Release refusal covers the new paths with no change there.
- Rollback: revert this PR (it is itself a guard change, so the revert must also come alone).

# 0023 — `scripts/ci/**` and `scripts/release/**` are not floor-guard guard paths

- **Status:** Accepted (runner A, 14 Nov 2026, under ADR-0013's technical delegation)
- **Linear:** DEVOS-196 · Contract: `docs/modules/GI-1.md` · Follows note 0022 and the DEVOS-179 (GI-1d) pre-review advisory.

## Context
`ci-gate` runs the PR head's own `scripts/ci/ci-gate.mjs`, which since GI-1d imports the disposition rules from `scripts/release/merge.mjs`. So a PR can change the rules its own `ci-gate` result is judged by. DEVOS-196 asked whether these paths should become guard paths (a `FLOOR-GUARD CHANGE` marker per changed path, as for the KK-only classifier in note 0022).

## Decision
No. The two directories stay ordinary paths: every content rule applies to them, and no marker is needed.

Reasons:
1. **The head's copy cannot merge anything.** The only merge path is the Release script (DEVOS-143), and it runs `main`'s `merge.mjs`, with `main`'s `GUARD_PATHS`, `required-checks.json` and floor-guard dispositions. A head that rewrote `ci-gate.mjs` to report green still has to pass `main`'s checks on the exact SHA, plus a Codex PASS that has read the change.
2. **Guard paths must come alone.** A guard-path change may touch only guard paths, `docs/decisions/*.md` and GI-1.md; anything else is `guard-change-not-isolated`, which is KK-only. `merge.mjs` and `ci-gate.mjs` change with their tests (`scripts/test/merge-gate*.test.mjs`, `ci-gate*.test.mjs`, `release.test.mjs`) and contracts (GI-1b, GI-3, CI-T). Making them guard paths would split every such change into several PRs, each a paid review (review cost rule, 12 Nov), or send them to KK, for no gain over reason 1.
3. **The content rules still cover them.** A skipped or `.only` test, a removed assertion, a lowered threshold or a removed CI step in these files or their tests is a hit, as anywhere else.

## The real fix (filed for Lane C)
The gap DEVOS-179's pre-review saw is that `ci-gate` judges a head with the head's code. The fix is the one `floor-guard.yml` already uses: `ci-gate.yml` runs the **base** copy of `scripts/ci/`, `scripts/release/` and their imports (`scripts/floor-guard/`, `scripts/gates/`), checked out from `pull_request.base.sha`. `ci-gate.yml` is runner B's (Lane C, CI-T-b), so it is filed there as a follow-up and should land before DEVOS-145 makes `ci-gate` a required check.

## Consequences
- No code changes; `GUARD_PATHS` is unchanged, so rules.md's Review guidelines stay as they are.
- Rollback: none needed. If the base-copy fix is not built, revisit this note before DEVOS-145 requires `ci-gate`.

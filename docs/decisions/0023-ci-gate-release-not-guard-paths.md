# 0023 — `scripts/ci/**` and `scripts/release/**` are not floor-guard guard paths

- **Status:** Accepted (runner A, 14 Nov 2026, under ADR-0013's technical delegation)
- **Linear:** DEVOS-196 · Contract: `docs/modules/GI-1.md` · Follows notes 0017 and 0022 and the DEVOS-179 (GI-1d) pre-review advisory. Fix filed: DEVOS-202 (Lane C).

## Context
`ci-gate` runs the PR head's own `scripts/ci/ci-gate.mjs`, which, once DEVOS-179 (GI-1d) merges, imports the disposition rules from `scripts/release/merge.mjs`. So a PR can change the rules its own `ci-gate` result is judged by. DEVOS-196 asked whether these paths should become guard paths (a `FLOOR-GUARD CHANGE` marker per changed path, as for the KK-only classifier in note 0022).

## Decision
No. The two directories stay ordinary paths: every content rule applies to them, and no marker is needed.

Reasons:
1. **A green `ci-gate` alone merges nothing.** The only merge path is the Release script (DEVOS-143). It judges every check run and workflow run on the SHA itself, not `ci-gate`'s summary (`merge.mjs`, the per-check evaluation); it runs `main`'s copy of the floor guard (`git show <mainSha>:scripts/floor-guard/floor-guard.mjs`); and it requires the watcher's Codex PASS on that SHA, which has read any change to `ci-gate.mjs`. So a head that rewrote `ci-gate.mjs` to report green still fails on the real checks.
   - **Rule recorded here:** the rest of `merge.mjs` (its `GUARD_PATHS` and `KK_ONLY` imports, `required-checks.json`) comes from the checkout it runs in. The Release path therefore runs `scripts/release/merge.mjs` from an up-to-date `origin/main` checkout, never from a PR worktree. The runner prompt and GI-3 adopt this when they switch to the Release script.
2. **Guard paths must come alone.** A guard-path change may touch only guard paths, `docs/decisions/*.md` and GI-1.md; anything else is `guard-change-not-isolated`, which is KK-only. `merge.mjs` and `ci-gate.mjs` change with their tests (`scripts/test/merge-gate*.test.mjs`, `ci-gate*.test.mjs`, `release.test.mjs`) and contracts (GI-1b, GI-3, CI-T). Making them guard paths would split every such change into several PRs, each a paid review (review cost rule, 12 Nov), or send them to KK, for no gain over reason 1.
3. **The content rules still cover them.** A skipped or `.only` test, a removed assertion, a lowered threshold or a removed CI step in these files or their tests is a hit, as anywhere else.

## The real fix (DEVOS-202, Lane C)
The gap DEVOS-179's pre-review saw is that `ci-gate` judges a head with the head's code. The fix is the one `floor-guard.yml` already uses: `ci-gate.yml` runs the **base** copy of `scripts/ci/`, `scripts/release/` and their imports (`scripts/floor-guard/`, `scripts/gates/`), checked out from `pull_request.base.sha`, including `scripts/release/required-checks.json`, `scripts/gates/kk-only.mjs` and the `yaml` install those copies need. `ci-gate.yml` is runner B's (Lane C, CI-T-b), so it is filed there as DEVOS-202 and should land before DEVOS-145 makes `ci-gate` a required check.

## Consequences
- **Narrows note 0017.** Note 0017 expected the floor guard to cover `ci-gate.yml` and `scripts/ci/**`. It covers them through the content rules (and `ci-gate.yml` as a workflow), not as guard paths: no `FLOOR-GUARD CHANGE` marker is needed for them. Until DEVOS-202 lands, a head's change to `scripts/ci/**` is caught by the content rules, Codex review and the Release script's own evaluation (reason 1). The comment in `ci-gate.yml` saying such changes "are guarded by the floor guard" is read in that sense; DEVOS-202 updates it.
- No code changes; `GUARD_PATHS` is unchanged, so rules.md's Review guidelines stay as they are.
- Rollback: none needed. If the base-copy fix is not built, revisit this note before DEVOS-145 requires `ci-gate`.

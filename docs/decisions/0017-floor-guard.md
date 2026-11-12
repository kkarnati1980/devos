# 0017 — Floor guard (gate integrity Part 1)

- **Status:** Accepted (runner A, 12 Nov 2026, under ADR-0013's technical delegation)
- **Linear:** DEVOS-141 · Contract: `docs/modules/GI-1.md`

## Context
KK's gate-integrity spec (12 Nov 2026) §4 asks for a deterministic CI job that reads only the diff and fails when a change reaches green by weakening a check: skipped or deleted tests, lost assertions, loosened thresholds, suppressions, weakened CI, stubs, narrowed contracts or relaxed policy.

## Decision
1. A single zero-dependency Node script, `scripts/floor-guard/floor-guard.mjs`, with exit codes 0 clean / 1 violation / 2 could not run. Exit 2 is never clean.
2. A separate workflow, `floor-guard`, on every PR to main. It runs the guard **from the PR's base commit**, so a change to the guard is judged by the previous version (§4.5). Being dependency-free, it needs no install and runs in seconds (C2).
3. Guard paths are exempt from the content rules, because their own tests contain the patterns. In exchange, any change to a guard path must come alone (only a decision note or the GI-1 contract may sit beside it), and needs a Codex PASS that names it.
4. Hit ids are content hashes, so a Codex Keep (`FLOOR-GUARD KEEP <id> <file>:<line> <reason>`) stays attached to one finding on one SHA. Wiring the Keep into the merge path is GI-1b, with the Release merge path (DEVOS-143).
5. The documented ceilings are 30 minutes for a CI job and 120 s for a test timeout, today's maxima in the repo.
6. Two rules were narrowed after a dry run over the last 15 merged PRs (see the contract): shell `|| true` counts only on test/check lines, and an early `return` in a test only behind an env/platform/CI/skip condition. Neither narrowing removes a §4.2 pattern.

## Consequences
- PRs that add a suppression or reword an acceptance row now fail `floor-guard` until restored or kept by Codex. The dry run suggests about one PR in five.
- The CI throughput work (DEVOS-139) restructures workflows; renamed or moved steps show as `ci-step-removed` and need a Codex Keep in that PR.
- The guard is a detector. Blocking the merge in code is Part 3 (DEVOS-143) and the ruleset (DEVOS-145).

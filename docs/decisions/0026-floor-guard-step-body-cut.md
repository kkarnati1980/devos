# 0026 — Floor guard: whole step bodies, and setup-action keys read as plain (DEVOS-209)

- **Status:** accepted (runner B, 14 Nov 2026) · **Linear:** DEVOS-209 (step a of DEVOS-203, note 0025) · ADR-0013
- **Guard paths changed:** `scripts/floor-guard/floor-guard.mjs`, `scripts/floor-guard/test/guard.test.mjs`, `scripts/gates/kk-only.mjs`, `scripts/test/kk-only.test.mjs`. Nothing else but this note and `docs/modules/GI-1.md` (both guard companions).

## Context
DEVOS-203 pins the setup actions to full SHAs. Every such step became a KK-only `ci-step-changed` hit in workflows that run no security scanning, so KK would have had to answer dozens of purely technical hits:
1. The 40-character SHA pushed the step's `was:`/`now:` text past the 200-character cut, and a cut text is read as unknown (fails closed).
2. `ciBodyIsPlain` did not know `node-version-file`, `package-manager-cache`, `sparse-checkout`, `persist-credentials` or `ref`.

## Decision
1. `ci-step-removed` and `ci-step-changed` keep up to **1000** characters (`STEP_BODY_CUT`); every other rule keeps 200. A text at its cut still fails closed. `kk-only.mjs` holds the same numbers; test K4 checks they match the guard's exports.
2. `ciBodyIsPlain` accepts `node-version-file`, `package-manager-cache` and `sparse-checkout` with plain-word values; `persist-credentials` only as `false`; `ref` only as `${{ github.event.pull_request.head.sha }}` or `…base.sha` (any other `ref`, including a branch name, stays KK-only).
3. Unchanged: security words in the file or text are still checked first (a `security.yml` hit stays KK-only); `ci-job-removed` stays KK-only; the marker and body-shape checks of DEVOS-186 are as they were.

Why not raise the cut for every rule: other rules carry a single diff line, which rarely nears 200, and a longer stored text only matters where the classifier reads a body.

## Consequences
- On the DEVOS-203 branch (11 non-guard, non-security workflows) the guard gives 35 hits, none KK-only, so Codex Keeps can clear them.
- An older base copy of the guard (before this merges) still cuts at 200; that only makes more hits KK-only, never fewer.
- `docs/modules/GI-4.md` still says "200-character checks"; it is not a guard companion, so it is updated in the DEVOS-203 PR.

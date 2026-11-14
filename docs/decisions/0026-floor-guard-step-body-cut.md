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
   - A base-SHA `ref` or a `sparse-checkout` changes what the job's later steps (a scan, lint, tests) see. So they are plain only in a side checkout: the same body has a `path:` below the workspace root (not `.`, `./`, `..` or absolute), as in ci-gate.yml's `.gate-base`/`.gate-src`. On the main checkout they stay KK-only (pre-review finding 2).
   - Removing `persist-credentials: false` reads as plain. That is hardening, not scanning (outside spec §4.4), so it is left to Codex's judgement (pre-review finding 3).
3. A step text of exactly 200 characters is read as cut. CI runs the base copy of the guard, so until this has merged, stored reports cut step bodies at 200; without this rule a cut prefix would read as a whole plain body (pre-review finding 1). A real 200-character step body just goes to KK.
4. Unchanged: security words in the file or text are still checked first (a `security.yml` hit stays KK-only); `ci-job-removed` stays KK-only; the marker and body-shape checks of DEVOS-186 are as they were.

Residual, left to Codex's Keep judgement (pre-review round 2, low): a narrowing key with a `path:` reads as a side checkout even when it is the job's only checkout moved into a subfolder (telling them apart needs job context the guard does not store); and a head-SHA `ref` is plain on any checkout, so in a `pull_request_target` workflow Codex should check that PR code does not run with the workflow's secrets.

Why not raise the cut for every rule: other rules carry a single diff line, which rarely nears 200, and a longer stored text only matters where the classifier reads a body.

## Consequences
- On the DEVOS-203 branch (11 non-guard, non-security workflows) the guard gives 35 hits, none KK-only, so Codex Keeps can clear them.
- An older base copy of the guard (before this merges) still cuts step texts at 200; rule 3 keeps those KK-only. So the DEVOS-203 PR waits until this has merged, and its CI then runs the new guard as the base copy.
- `docs/modules/GI-4.md` still says "200-character checks"; it is not a guard companion, so it is updated in the DEVOS-203 PR.

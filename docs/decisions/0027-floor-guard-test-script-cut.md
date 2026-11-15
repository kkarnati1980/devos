# 0027 — Floor guard: whole test-script text (DEVOS-227)

- **Status:** accepted (runner A, 15 Nov 2026) · **Linear:** DEVOS-227 · ADR-0013 · follows note 0026
- **Guard paths changed:** `scripts/floor-guard/floor-guard.mjs`, `scripts/floor-guard/test/guard.test.mjs`, `scripts/gates/kk-only.mjs`, `scripts/test/kk-only.test.mjs`. Nothing else but this note and `docs/modules/GI-1.md` (both guard companions).

## Context
PR #140 (DEVOS-215) adds `@devos/card-batch` to the build list in `apps/api`'s `typecheck`, `test` and `test:db` scripts. Each is a `test-script-changed` hit, which a Codex Keep may clear. But the hit text holds the old and the new command, which together pass the 200-character cut. A cut text may hide a security token, so `kk-only.mjs` reads it as KK-only (fails closed). KK would have had to answer three purely technical hits (a package added to a build list).

## Decision
1. `test-script-changed` keeps up to **1000** characters, like the step-body rules (note 0026). The guard exports `LONG_TEXT_RULES` (the two step-body rules plus `test-script-changed`); `cutFor` uses it. `kk-only.mjs` holds the same set; test K5 checks they match.
2. A text at its cut still fails closed. A `test-script-changed` text of exactly 200 characters is read as cut too: CI runs the base copy of the guard, so until this merges, stored reports cut it at 200.
3. Unchanged: security words in the file or text are checked first (a script naming `audit`, `secret`, `licence` and the like stays KK-only); hit ids are computed from the full text, as before, so they do not change; every other rule keeps 200.

Why this is not a loosening: no hit becomes keepable that was keepable before only by being short. The classifier's rule for `test-script-changed` is the same; it now sees the whole command instead of a prefix, which is what the fail-closed cut was standing in for.

## Consequences
- With this guard, #140's three hits are 243, 344 and 341 characters, whole, and none is KK-only, so Codex Keeps can clear them.
- #140 waits until this has merged, then takes main in (one new head, one review), so its CI runs this guard as the base copy.

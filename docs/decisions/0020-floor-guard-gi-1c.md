# 0020 — Floor guard widenings GI-1c (guard change, spec §4.5)

- **Status:** Accepted (runner A, 13 Nov 2026, under ADR-0013's technical delegation)
- **Linear:** DEVOS-150 · Contract: `docs/modules/GI-1.md` (Follow-ups) · Follows note 0017.

## Context
The DEVOS-141 pre-review (round 2) found five gaps in the floor guard. Spec §4.2 lets the Architect add patterns, never remove them; §4.5 requires a guard change to go in a PR that changes nothing else, with a Codex PASS naming the change and this note.

## Decision
1. **Hooks:** `pre`/`post` hooks of the `test`, `lint`, `typecheck` and `check` scripts run with those scripts, so a changed, removed or newly added hook is `test-script-changed`.
2. **Uncalled skips:** `it.skip`, `it.concurrent.skip`, `test.todo`, `test.fixme`, `describe.only`, `xit`, `fit` and the other skip forms already caught when called, referenced without a call (a ternary branch, a variable), are `test-skipped`.
3. **TypeScript strictness:** in `tsconfig*.json`, `strict` or one of its sub-flags (plus `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) set to `false`, a `true` removed without being re-added (comments are stripped, so commenting a flag out counts as removing it), or an `extends` removed or retargeted (strictness is inherited from `tsconfig.base.json`), is the new rule `ts-strict-relaxed`. A `false` already present on a re-touched line is not new.
4. **Paths with ` b/`:** `run()` reads `git diff -z --name-status` and matches each `diff --git` header exactly against those pairs; the old regex stays as the fallback.
5. **`binary-code-change`:** kept as defence in depth and documented; nothing is removed.

## Consequences
- More hits in the categories above; each needs a restore or a Codex Keep, as before.
- No pattern is narrowed or removed. The workflow still runs the base copy of the guard on this PR, so the change is checked by the previous version of itself.

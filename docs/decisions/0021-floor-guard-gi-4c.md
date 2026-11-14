# 0021 — Floor guard GI-4c: CI hits carry the step body (guard change, spec §4.5)

- **Status:** Accepted (runner A, 14 Nov 2026, under ADR-0013's technical delegation)
- **Linear:** DEVOS-167 · Contract: `docs/modules/GI-1.md` (Follow-up GI-4c) · Follows notes 0017, 0019 and 0020.

## Context
Codex PR84-r1 found that a `ci-*` hit names only the step or job (`job build: step name:Checks removed`), not the command it ran. The gate evaluator (GI-4) therefore cannot tell from the stored result whether a removed or disabled step ran security scanning, so it treats every `ci-*` hit as KK-only. That fails closed, but it sends KK hits that are plainly not his (a removed `pnpm build`).

## Decision
1. `ci-step-removed`, `ci-step-changed` and `ci-job-removed` hits append the step body the guard already parses: `; ran: …` for a removal, `; was: …; now: …` for an edit, every step's body for a removed job. The body is the step's lines other than its `name:`, trimmed and joined with ` ⏎ ` (not ` | `, which a YAML block scalar `run: |` uses); indentation is dropped, so an indent-only edit reads the same in `was:` and `now:`, although the hit still fires.
2. The 200-character cut stays. The evaluator already treats a full-length text as unknown and fails closed, so a long body never clears a hit.
3. This PR changes only the guard (and its test, this note and GI-1.md). Narrowing `KK_ONLY` in `scripts/gates/evaluate-gate.mjs` to CI hits whose stored body names security scanning, secrets, audit or licence checks is DEVOS-186, a separate PR after this one merges, because §4.5 requires a guard change to come alone.

## Consequences
- No pattern is narrowed or removed; the same hits fire on the same files and lines. Only their text, and so their ids, change. A Keep written against an old id is void, as a Keep on any other SHA already is.
- Hit text may now quote workflow lines in the CI log, the job summary and the stored report. That is no new exposure beyond the PR diff itself: the same lines are already in the repo and the diff. The guard does not check workflows for literal secrets; secret-scan does.
- The workflow still runs the base copy of the guard on this PR, so the change is checked by the previous version of itself.

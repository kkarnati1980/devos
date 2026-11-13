# GI-4 — Gate integrity Part 4: delegated gate rule, final form (contract)

- **Linear:** DEVOS-144 (High) · Lane A · parent DEVOS-140
- **Spec:** KK, `claude/devos-gate-integrity-spec-v1.0.0.md` §3 and §10 (claude.ai Project). **The rule is KK's; it is not redesigned here.**
- **Depends on:** GI-1 floor guard (DEVOS-141), GI-2 pass rule (DEVOS-142), GI-3 Release merge path (DEVOS-143). All three are merged.
- **Owned files:** `scripts/gates/evaluate-gate.mjs`, `scripts/test/gate-evaluator.test.mjs`, this contract, `docs/decisions/0019-gate-rule-final-form.md`, the §2 amendment in `docs/decisions/0013-speed-ups.md`, the gate lines in `rules.md` and the generated `CLAUDE.md` / `AGENTS.md`.
- **Decision record:** `docs/decisions/0019-gate-rule-final-form.md` (includes the D14 draft for KK).

## Goal
Runner A approves G2, G3 or G4 only when a program, reading stored results, says so. The program never judges: it checks that each condition has a stored result, on the right SHA, with a link. Missing or failed results pause only that gate.

## Behaviour — `node scripts/gates/evaluate-gate.mjs <evidence.json> [--comment <out.md>]`
1. The evidence file is a JSON manifest the runner compiles from stored results only: Linear issue states, `server-check` statuses on the deployed main SHA, the gate criteria with links, the open-KK-items query, and per merged PR its head SHA, CI conclusion, `codex-review` status and floor-guard report (with any dispositions); per module its merged SHA and pass-rule result. The manifest shape is the `complete()` fixture in the test file.
2. Conditions (ADR-0013 §2, final form):
   1. every module and blocker of the phase is Done;
   2. every server check on the deployed main SHA is `success` (a skipped check fails), with at least one stored;
   3. every gate criterion is met, each with a link;
   4. no open KK card, `deadlocked` label or stop-and-ask item, with a link to the query;
   5. for every merged PR, the floor guard is exit 0 on its head SHA, or exit 1 with every hit disposed on that SHA by a Codex `keep` or a KK `escalate` (spec §4.4). Exit 2 is never clean. A Builder cannot dispose of its own hit;
   6. every module has a pass-rule result `pass` on its merged SHA;
   7. every merged PR has CI `success` and `codex-review` `success` on the same head SHA (the merge-gate record of GI-3).
3. Every result must carry an `https://` link, or it counts as missing.
4. `decision` is `approve` only with nothing missing. Otherwise `paused`, with each missing item named and tagged with its condition number.
5. `--comment` writes the gate-issue comment: `[runner] G<n> APPROVED …` listing each condition with the links of its results (GC7), or `[runner] G<n> PAUSED <iso>: missing …` (GC6).
6. Exit codes: `0` approve · `1` paused · `2` could not run (bad arguments, unreadable or malformed evidence, or a gate other than G2–G4). Exit 2 is never an approval.

## Runner procedure (ADR-0013 §2 amended)
- Runner A compiles the manifest, runs the evaluator, and posts the `--comment` output on the gate issue.
- Exit 0 → move the gate issue to Done and send KK one short line.
- Exit 1 → the gate stays open; every other lane continues; no KK card.
- Exit 2 → fix the manifest and re-run; no approval.

## Not in scope
- Compiling the manifest automatically from GitHub and Linear (follow-up GI-4b). Today runner A compiles it from the stored results it links.
- Floor-guard disposition recording on PRs (GI-1b, DEVOS-149).

## Acceptance tests (`scripts/test/gate-evaluator.test.mjs`)
| # | Pass when |
|---|---|
| AT1 | Complete evidence returns `approve`; the CLI exits 0 |
| AT2 | GC6: evidence lacking one PR's floor-guard result returns `paused` naming that PR; the CLI exits 1 and the comment is a `PAUSED` line saying no KK card |
| AT3 | Floor guard exit 2, exit 1 with an open hit, a disposition on another SHA, a Builder-sourced Keep, a report on another SHA, or one without a link, all pause |
| AT4 | Hits disposed by a Codex Keep or a KK escalation on the same SHA (short SHA allowed) count as clean |
| AT5 | A module with no pass-rule result, a failing one, or one on another SHA pauses |
| AT6 | CI or `codex-review` missing, not success, or on another SHA pauses |
| AT7 | ADR-0013's four conditions: a blocker not Done, a skipped server check, no server checks, an unmet criterion, an open KK item, or no merged PRs, each pause |
| AT8 | GC7: the approval comment has a section for every condition and contains every stored result's link |
| AT9 | G5, malformed evidence, an unreadable or invalid file and missing arguments exit 2 |

## Pass rule
- `node --test scripts/test/gate-evaluator.test.mjs` exits 0 with 9 tests passing (AT1–AT9); it runs under `pnpm test`.
- `pnpm check:rules` exits 0 (the generated `CLAUDE.md` and `AGENTS.md` match `rules.md`).

## Merge gate
CI green and Codex PASS on the exact head SHA, merged through `scripts/release/merge.mjs` (GI-3).

## Rollback
Reverting this PR returns the gate rule to the interim form of 12 Nov 2026 (ADR-0013 §2 interim text), never to the form before 12 Nov.

## Build record
- See the PR body and the merge evidence comment on DEVOS-144; GC6 and GC7 evidence goes on DEVOS-140.

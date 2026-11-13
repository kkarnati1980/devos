# GI-4 — Gate integrity Part 4: delegated gate rule, final form (contract)

- **Linear:** DEVOS-144 (High) · Lane A · parent DEVOS-140
- **Spec:** KK, `claude/devos-gate-integrity-spec-v1.0.0.md` §3 and §10 (claude.ai Project). **The rule is KK's; it is not redesigned here.**
- **Depends on:** GI-1 floor guard (DEVOS-141), GI-2 pass rule (DEVOS-142), GI-3 Release merge path (DEVOS-143). All three are merged.
- **Owned files:** `scripts/gates/evaluate-gate.mjs`, `scripts/test/gate-evaluator.test.mjs`, this contract, `docs/decisions/0019-gate-rule-final-form.md`, the §2 amendment in `docs/decisions/0013-speed-ups.md`, the gate lines in `rules.md` and the generated `CLAUDE.md` / `AGENTS.md`.
- **Decision record:** `docs/decisions/0019-gate-rule-final-form.md` (includes the D14 draft for KK).

## Goal
Runner A approves G2, G3 or G4 only when a program, reading stored results, says so. The program never judges: it checks that each condition has a stored result, on the right SHA, with a link. Missing or failed results pause only that gate.

## Behaviour — `node scripts/gates/evaluate-gate.mjs <evidence.json> [--comment <out.md>]`
1. The evidence file is a JSON manifest the runner compiles from stored results only: Linear issue states, `server-check` statuses on the deployed main SHA, the gate criteria with links, the open-KK-items query, and per merged PR its head SHA, CI conclusion, `codex-review` status, merge-gate record (`scripts/release/merge.mjs` exit 0 on that head) and floor-guard record (`report` as written by `floor-guard.mjs --report`, the Codex `verdict` for that SHA, and KK's recorded answers `kkResolutions`); per module its merged SHA, its merged PR numbers and its pass-rule result. All SHAs are full 40-character SHAs, compared exactly. The manifest shape is the `complete()` fixture in the test file.
2. Conditions (ADR-0013 §2, final form):
   1. every module and blocker of the phase is Done;
   2. every server check on the deployed main SHA is `success` (a skipped check fails), with at least one stored;
   3. every gate criterion is met, each with a link;
   4. no open KK card, `deadlocked` label or stop-and-ask item, with a link to the query;
   5. for every merged PR, the floor guard is exit 0 with no hits on its head SHA, or exit 1 with every hit disposed on that SHA (spec §4.4). A Keep is GI-1's `applyDispositions`: a Codex verdict for the same SHA naming the hit's id and `file:line`. Hits spec §4.4 sends to KK (`gitleaksignore-added`, `policy-weakened`, and `suppression-added` of `gitleaks:allow` or `nosec`) are never cleared by Codex: they need KK's recorded answer (`decision: "keep"` with a link). A pending escalation pauses the gate. Exit 2 is never clean; a Builder cannot dispose of its own hit; an exit 0 report with hits, or exit 1 without, pauses as inconsistent;
   6. every module has a pass-rule result `pass` on its merged SHA;
   7. every merged PR has CI `success` and `codex-review` `success` on the same head SHA, and a merge-gate record showing the Release path merged that head (GI-3). Every PR a module lists must be among the merged PRs, and no PR or module is listed twice, so a PR cannot be left out of the manifest unnoticed.
3. Every result must carry an `https://` link without whitespace or `()[]<>`, or it counts as missing. Labels are escaped in the comment, so evidence text cannot forge a link.
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
| AT3 | Floor guard exit 2, exit 1 with an open hit, a Keep on another SHA, a Builder-sourced Keep, a Codex Keep on a KK-only hit, a pending escalation, an inconsistent report, a report on another SHA, or one without a link, all pause |
| AT4 | A Codex Keep naming id and `file:line` on the same SHA, and KK's recorded keep on a KK-only hit, count as clean |
| AT5 | A module with no pass-rule result, a failing one, or one on another SHA pauses |
| AT6 | CI or `codex-review` missing, not success, on another SHA or without a link; a missing or other-SHA merge-gate record; or a short head SHA, pauses |
| AT7 | ADR-0013's four conditions: a blocker not Done, a skipped server check, no server checks, an unmet criterion, an open KK item, no merged PRs, a server check off the deployed SHA, no deployed SHA, a module PR left out of `mergedPrs`, a duplicate PR or module, or a module with no PR numbers, each pause |
| AT8 | GC7: the approval comment has a section for every condition and contains every stored result's link; a link with `)[` is rejected and labels are escaped |
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

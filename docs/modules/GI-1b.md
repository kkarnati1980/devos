# GI-1b — Floor-guard dispositions and guard-path refusal in the Release merge path (contract)

- **Linear:** DEVOS-149 (parent DEVOS-140) · P2 · Lane A
- **Source:** KK's spec `claude/devos-gate-integrity-spec-v1.0.0.md` §4.4, §4.5 and §6 (claude.ai Project); follow-up named in `docs/modules/GI-1.md` (Dispositions, Known gap).
- **Builds on:** GI-1 (`applyDispositions`, `GUARD_PATHS`, `run` in `scripts/floor-guard/floor-guard.mjs`) and GI-3 (`scripts/release/merge.mjs`, DEVOS-143/148). Coordinates with DEVOS-145 (the `main` ruleset).
- **Applies:** D1, ADR-0011 (timeouts on every call, retries for safe reads only, no new egress: GitHub and `git fetch origin` only), ADR-0013 (runner decides technical design).
- **Owned files:** `scripts/release/merge.mjs` (the floor-guard step only), `scripts/release/required-checks.json`, `scripts/test/merge-gate-floor-guard.test.mjs`, `scripts/test/merge-gate.test.mjs` (fake GitHub updated for the new required check and endpoints), `rules.md` + generated `CLAUDE.md`/`AGENTS.md` (one Review-guidelines bullet), this contract.

## Goal
The Release path (`node scripts/release/merge.mjs <pr>`) refuses a PR unless the floor guard is clean on its head SHA, or every hit has a valid Codex Keep for that SHA; and it refuses a PR that changes a guard path unless the Codex PASS for that SHA names the change. This closes GI-1's known gap (GitHub runs the PR's own `floor-guard.yml`).

## Behaviour (added as step 2b of GI-3's evaluate)
1. **Required check.** `required-checks.json` lists `floor-guard` in `requiredCheckRuns`; missing or not `success` refuses unless step 3 disposes of it.
2. **Verdict text.** The markers are read from the review watcher's PR comment for this exact PASS: posted by `codexCreator`, first line exactly `### Codex review <label> — **PASS**` where `<label>` is the `PR<n>-r<k>` of the head's `codex-review` PASS status, and containing ``**Commit:** `<head sha>` ``. The earliest such comment that was never edited wins. Only its `- **Summary:** ` line counts (the findings table quotes PR text); each `FLOOR-GUARD KEEP` / `FLOOR-GUARD CHANGE` marker in it is moved onto its own line first, because the watcher renders the summary on one line. No PASS status or no such comment = no markers.
3. **Dispositions (spec §4.4).** Only when the `floor-guard` check run concluded `failure` (not cancelled, timed out or pending) and no other floor-guard run or workflow is unfinished:
   - The guard is re-run locally: `git fetch origin <main> <head>`, main's copy of `scripts/floor-guard/floor-guard.mjs` (as CI runs the base copy) on `main...head`. Fetch, load or run failure = exit 2 (could not run).
   - Refuse when the report is for another SHA, is exit 2 (never clean), or has no hit (CI red with no hit: re-run the check; a red check is never set aside without a hit).
   - A hit Codex may not keep refuses, named "escalate to KK": the KK-only set of `scripts/gates/evaluate-gate.mjs` (DEVOS-144: security-named file or text, a text at the 200-character cut, `gitleaksignore-added`, `policy-weakened`, a security `suppression-added`, every `ci-*` rule, a `lint-rule-off` of ignores) plus `guard-change-not-isolated` (§4.5).
   - Otherwise `applyDispositions(report, { sha: head, source: "codex", text })`. Exit 0 → the failures of the `floor-guard` check and workflow, and the `failure` of the aggregator (`ci-gate` check and workflow), are set aside. Workflow runs are matched by file (`workflowPath`, `aggregatorWorkflowPath`), never by name. Every other red result still refuses. Any open hit refuses, named with its id, rule and `file:line`.
4. **Guard paths (spec §4.5).** The PR's changed files are read (`GET /pulls/<n>/files`, all pages; old and new names of renames). If any is a `GUARD_PATHS` path, refuse unless the PASS text has a line `FLOOR-GUARD CHANGE <path>` naming each such path exactly (the whole rest of the line, trailing whitespace aside, equals the path; anything after it fails closed; Codex PR96-r1), and the PR adds or changes a `docs/decisions/*.md` note. A file list GitHub cannot give in full (over 3,000 files, or fewer listed than `changed_files`) is exit 2.
5. **Codex markers.** rules.md's Review guidelines tell Codex the two marker formats, and that a Keep is never written for money, data deletion, security scanning, legal, D11 or D13 hits.

## Runner decisions (13 Nov 2026, ADR-0013)
- **Re-run, not a stored artifact.** The CI job writes its JSON report to the step summary only, which the API does not serve. The guard is deterministic over `main...head`, so the Release path recomputes it with main's copy. The local result never turns a red check green on its own: it can only identify the hits that Keeps must cover.
- **Aggregator.** `ci-gate` fails whenever any check fails, so a disposed floor guard also reds `ci-gate`. Its `failure` is set aside only together with a disposed floor guard; the Release path still judges every other check run and workflow run itself. Residual: `ci-gate` also refuses a PR whose base expects a check the head no longer produces; removing a workflow or job is itself a floor-guard hit (`ci-step-removed`) that would need its own Keep. Follow-up: once the DEVOS-145 ruleset requires `ci-gate`, GitHub will refuse such a merge anyway, so `ci-gate` must learn to read dispositions (filed).
- **CI exit 2 with hits.** If CI's guard could not run but the deterministic local re-run on the same SHA finds hits and every hit has a valid Keep, the check is set aside: the stored result is the re-run. A re-run that itself exits 2 or finds nothing always refuses (GC2).
- **KK-only set shared (DEVOS-181, 14 Nov 2026).** `notKeepable` is now the gate evaluator's `KK_ONLY` from `scripts/gates/kk-only.mjs`; see GI-4.md "Shared KK-only classifier" for the three rules that changed and why. B10's cases are unchanged.
- **Same account.** Runners and the watcher share `kkarnati1980`, so a comment's author alone does not prove the watcher wrote it (as for the GI-3 status). The comment must match the watcher-posted PASS status's label and SHA; the server-side verdict file (`verdicts/<sha>.json`) stays the record. Recorded, not solved here.

- 13 Nov 2026, build runner A: Codex PR96-r1 (1 medium, accepted): `namesChange` accepted a marker whose path continued past a space, so `FLOOR-GUARD CHANGE scripts/floor-guard/a b.mjs` also covered `scripts/floor-guard/a`. It now requires the whole rest of the line to equal the path; B7 covers the case.

## Known gap
Codex cannot run scripts, so it does not see floor-guard hit ids unless they reach its prompt. Until the review watcher passes the head's floor-guard hits into the Codex prompt (follow-up, Lane C, `scripts/review/review-commit.sh`), a hit is in practice cleared by Restore. The Release path is already strict either way: without a valid Keep, a red floor guard refuses.

## Acceptance tests (`scripts/test/merge-gate-floor-guard.test.mjs`)
| # | Pass when |
|---|---|
| B1 | `floor-guard` missing refuses; failed with hits and no Keeps refuses, naming each open hit; no merge call |
| B2 | Keeps for every hit in the watcher's PASS comment for this SHA set aside the floor guard and `ci-gate` failures; one merge call |
| B3 | A Keep missing for one hit, or from another account, SHA, label, a non-PASS comment, or with the wrong line, refuses |
| B4 | A guard exit 2, a clean re-run, a report for another SHA, another failing check, or a cancelled floor guard is never set aside (GC2) |
| B5 | A guard-path change (also as a rename's old name, or the workflow) refuses without a `FLOOR-GUARD CHANGE <path>` line per path and a decision note; with both, it merges |
| B6 | Over 3,000 changed files, or a short file list, is exit 2 (never judged) |
| B7 | Inline markers in the one-line summary are matched exactly (no prefix match; file names with spaces) |
| B8 | GC1 (local): a real `.skip` added to a test yields `test-skipped`, and the Release path refuses it without a Keep |
| B9 | Markers only in a findings-table row, only in an edited comment, or only in a later comment than the watcher's refuse |
| B10 | A Keep for a KK-only or §4.5 hit (gitleaksignore, guard change mixed, `ci-*`, security suppression, security-named file, policy) refuses with "escalate to KK"; ordinary hits stay keepable |
| B11 | A red workflow named `floor-guard` from another file is never set aside |

## Pre-review (13 Nov 2026)
Round 1: 7 findings, 6 fixed: markers from the Summary line only (B9), KK-only hits never kept (B10), earliest unedited comment (B9), workflows by file (B11), the CI-exit-2 decision recorded above, plain-marker wording in rules.md. Not changed: `localGuardReport`'s fetch path is not unit-tested against a remote (it needs `origin`); its argument check is (B8), and any failure in it is exit 2.
Round 2: 5 low findings, 1 fixed (main is read once, so the guard re-run and the compare judge the same main); the rest fail safe and are left as is.

## Pass rule
`node --test scripts/test/merge-gate-floor-guard.test.mjs` exits 0 with 11 tests passing, `node --test scripts/test/merge-gate.test.mjs` exits 0 with 14 tests passing, and `pnpm check:rules` exits 0.

## Green
- **GC1 end to end** (stored on DEVOS-140): a throwaway PR adding `.skip` to an existing test gets `floor-guard` exit 1, and `node scripts/release/merge.mjs <pr> --dry-run` exits 1 naming the `test-skipped` hit.

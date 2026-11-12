# GI-2 — Gate integrity Part 2: pass rule in every contract (contract)

- **Linear:** DEVOS-142 (parent DEVOS-140) · P2 · Lane A · High
- **Source:** KK's spec `claude/devos-gate-integrity-spec-v1.0.0.md` §5 (12 Nov 2026).
- **Applies:** ADR-0013 (the runner decides the technical design; one task = one PR), C1 (no new third-party Action), D1.
- **Owned files:** `scripts/contracts/check-pass-rule.mjs`, `scripts/test/pass-rule.test.mjs`, `.github/workflows/contract-check.yml`, `docs/modules/_template.md`, this contract, `docs/decisions/0018-pass-rule.md`, and the `## Pass rule` sections added to `docs/modules/M2.1.md` and `docs/modules/M2.2.md`.

## Interface
- `node scripts/contracts/check-pass-rule.mjs --base <rev> --head <rev>` validates every `docs/modules/*.md` added, modified or renamed between merge-base and head (the head copy). `_template.md` is skipped. `--all` validates every contract on disk; plain file arguments validate those files.
- Exit codes: `0` valid · `1` invalid · `2` could not run (bad ref, missing arguments). Exit 2 is never valid.
- CI: workflow `contract-check`, job `pass-rule`, on every PR to main. It uses no install and no new Action, with `timeout-minutes: 5`.

## Behaviour (runner decisions, 12 Nov 2026, ADR-0013)
1. **The field.** A contract carries a `## Pass rule` section, or one `### Pass rule (<part>)` per sub-part. The template `docs/modules/_template.md` has it as a required section.
2. **Program-checkable.** Every bullet must carry at least one anchor:
   - a command in a code span, starting with the tool and its arguments (`pnpm`, `node`, `npx`, `curl`, `git`, `gh`, `psql`, `docker`, `vitest`, `jest`, `tsc`, `eslint`, `pytest`, `axe` …);
   - a named test file;
   - an acceptance-test or green-condition id (`AT3`, `AB8e`, `GC1`, `AT-D1`);
   - an exit code;
   - an HTTP status (`HTTP 200`, `returns 200`);
   - a threshold with a comparator and a unit (`≤ 120 s`, `at most 300 ms`, `at most 0 violations`);
   - for UI, a `screenshot diff` or a `checklist script`.

   An item is a bullet plus its indented continuation lines. A blank line ends it, and any other line is an item of its own, so a paragraph of judgement text never borrows a neighbour's anchor. A fenced code block belongs to the item above it: every non-blank, non-comment line in it must start with a tool (a command), and such a fence anchors its item. Prose inside a fence is rejected, and fence delimiters never count as inline code spans (PR71-r1). HTML comments are ignored, and headings inside code fences are not sections. `Pass rules` (plural) is accepted.

   An item without an anchor is rejected. The error names any judgement words it found (`works`, `looks good`, `no errors`, `as expected`, `model is confident` …).
3. **Missing or empty sections are rejected:** `no "## Pass rule" section`, or `… is empty`.
4. **Scope of the check.** CI checks only the contracts a PR adds or changes, as spec §5 says. Untouched contracts of closed phases are not checked.
5. **Schema.** Contracts are Markdown, not entries in the build-standard catalogue. The validator above is therefore the schema for the contract field. `docs/standards/build-standard.schema.json` already requires every catalogue check to have `how`, `check` and `evidence`, which is the catalogue's own program-checkable form, so it is left unchanged. This deviates from the spec's suggestion to add the field to that file; it is recorded here and in `docs/decisions/0018-pass-rule.md`.
6. **Backfill.**
   - This PR backfills the current phase's Lane A contracts: M2.1 and M2.2.
   - The Lane B and C contracts of P2 (M2.3, M2.4, M2.5, M2.6, S3, S4) are runner B's files, and runner B has open PRs on them. Editing them here would conflict with those PRs and cost extra reviews. They are filed as **GI-2b** for runner B: one small commit per contract.
   - P3 contracts are written with the template, so they carry a pass rule from the start.
   - Until GI-2b lands, any PR that touches one of those contracts must add its pass rule, because CI checks every changed contract.
7. **Storing the result per merged SHA** (spec §5, last line) is part of Part 4 (DEVOS-144). That part reads the pass rule's named suites from the merge evidence comment or the CI run on the merged SHA.

## Not in scope
- Backfilling Lane B and C contracts (GI-2b), and the gate rule switch (DEVOS-144).

## Acceptance tests
| # | Pass when |
|---|---|
| AT1 | GC3: a contract whose pass rule is "works as expected" fails, and so does a contract with no pass rule |
| AT2 | Judgement-only bullets, an empty section, and one bad bullet among good ones are all rejected |
| AT3 | Each anchor kind is accepted (command, test file, AT id, exit code, HTTP status, threshold, screenshot diff) |
| AT4 | Diff mode checks only added or changed contracts and reads the head copy |
| AT5 | Exit 2 on a bad ref or missing arguments (library and CLI) |
| AT6 | The template, M2.1, M2.2 and this contract pass |
| AT7 | Pre-review cases: no false accepts (trailing paragraphs, template comments, unit-less thresholds, `->`, a tool word in prose code, `GCP2`, fenced headings) and no false rejects (fenced commands, plural heading, `pytest`/`axe`, `returns 200`); `--all` outside the repository exits 2 |

## Pass rule
- `node --test scripts/test/pass-rule.test.mjs` exits 0 (AT1–AT7); it runs under `pnpm test`.
- CI job `pass-rule` exits 0 on this PR's head SHA.

## Merge gate
CI green and Codex PASS on the exact head SHA (D1).

## Build record
- See the PR body and the merge evidence comment on DEVOS-142.

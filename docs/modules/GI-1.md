# GI-1 — Gate integrity Part 1: floor guard (contract)

- **Linear:** DEVOS-141 (parent DEVOS-140) · P2 · Lane A · High
- **Source:** KK's spec `claude/devos-gate-integrity-spec-v1.0.0.md` §4 (12 Nov 2026). The patterns of §4.2 are a minimum: the Architect may add patterns, never remove one.
- **Applies:** D1 (Codex PASS on the same SHA), ADR-0013 (runner decides technical design; one task = one PR), ADR-0011 (no new network egress), C1 (no new third-party Action), C2 (under 2 minutes).
- **Owned files (the guard paths):** `scripts/floor-guard/**`, `scripts/test/floor-guard.test.mjs`, `.github/workflows/floor-guard.yml`; plus this contract and `docs/decisions/0017-floor-guard.md`.
- **Guard paths from DEVOS-189 (note 0022):** also `scripts/gates/kk-only.mjs` and `scripts/test/kk-only.test.mjs`, the KK-only classifier the gate evaluator and the Release merge path share (DEVOS-181). They stay owned by GI-4; they are guard paths so that a change to them must come alone and be named by a `FLOOR-GUARD CHANGE` marker. They are not exempt from the content rules.

## Interface
- `node scripts/floor-guard/floor-guard.mjs --base <rev> --head <rev> [--report <file.json>]` diffs `merge-base(base, head)..head` with `git diff --unified=0 --find-renames`, and matches each file header against the `git diff -z --name-status` pairs so paths containing ` b/` split right (GI-1c). It reads the diff and the base/head copies of changed files only; never a PR description.
- Git runs with `--text --no-textconv -c core.quotePath=false` and fixed `a/`/`b/` prefixes, so a `.gitattributes` in the PR head cannot turn a code change into an unread "binary" one, and non-ASCII paths parse.
- Output: one `HIT <id> <rule> <file>:<line> <text>` line per hit, a summary line, and (with `--report`) JSON `{ sha, base, exit, hits: [{ id, rule, file, line, text }], error? }`.
- **Exit codes:** `0` clean · `1` violation · `2` could not run (bad ref, not a repo, unreadable diff or diff header, unreadable base contract or workflow, missing arguments, report not writable). Exit 2 is never clean. The entry point compares real paths, so a symlinked or space-containing path still runs the guard.
- Hit ids are `fg-` + 10 hex of SHA-256(rule, file, trimmed text): stable when lines shift, distinct per finding.
- Module exports for tests and Part 3: `run`, `analyse`, `parseDiff`, `workflowShape`, `applyDispositions`, `CEILINGS`, `GUARD_PATHS`.
- Zero dependencies (node built-ins and `git` only), so CI can run the base copy without an install.

## Rules (each a hit)
| Rule | Fires on |
|---|---|
| `test-file-deleted` | a test file (`*.test.*`, `*.spec.*`, or a JS/TS file under `test/`, `tests/`, `__tests__/`, `test-db/`, `e2e/`) deleted, or renamed to a non-test path |
| `test-skipped` | an added line in a test file with `.skip(`, `.only(`, `.todo(`, `.fixme(`, `xit(`, `xdescribe(`, `xtest(`, `fit(`, `fdescribe(`, `skipIf(`, `runIf(`, a `skip:`/`todo:`/`only:` option (inline or on its own line), or an early `return` guarded by an env/platform/CI/skip condition (one line, or an `if (…) {` line followed by `return`, where either the condition or the `return` is the added line — PR70-r6, PR70-r18); also a skip referenced without a call (`it.skip`, `it.concurrent.skip`, `test.fixme` anywhere; bare `xit`/`fit`/… after an operator such as `?`, `:`, `=` — GI-1c) |
| `trivial-assertion` | a net-new (not merely moved) `expect(true|false|1|0|null|undefined|"")`, `assert(true)`/`assert.ok(true)`, or `assert.equal`/`strictEqual`/`deepEqual` of two equal literals in a test file (an assertion swapped for one that cannot fail) |
| `assertions-lost` | net loss of `expect(`/`assert…(` calls across a changed test file's removed vs added lines |
| `coverage-lowered` | (compared occurrence by occurrence per key, so per-path thresholds on one line count) a coverage key (`lines`, `branches`, `functions`, `statements`, `threshold`, `perFile`) lowered, or removed without replacement, or a boolean switch (`perFile`, `all`, `enabled`, `reportOnFailure`) turned from `true` to `false` or removed, in a test config, test file or workflow |
| `tests-excluded` | an added `exclude`, `testPathIgnorePatterns`, `testIgnore`, `modulePathIgnorePatterns` or `coveragePathIgnorePatterns` in a test config or test file |
| `test-script-changed` | a `test`, `lint`, `typecheck` or `check` script (or `test:…` etc.) in a `package.json` changed or removed, wherever it sits on the line; a `pre`/`post` hook of these changed, removed or added, also in a new `package.json` (GI-1c) |
| `ts-strict-relaxed` | in a `tsconfig*.json`, comparing the base and head files parsed as JSONC (comments and trailing commas removed outside strings): `strict` or a strictness sub-flag `true` → anything else, a flag newly `false` (the `strict` family including `strictBuiltinIteratorReturn`, plus `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`), `noCheck` newly `true`, or `extends` removed or changed; an unreadable tsconfig is a hit (fails closed) (GI-1c) |
| `lint-rule-off` | an added rule set to `"off"`/`0` or downgraded to `"warn"`/`1` (quoted or unquoted key), or an added `ignores`, in an ESLint config |
| `max-warnings-raised` | `--max-warnings N` raised, set negative (unlimited), or removed, in a test config or workflow |
| `timeout-past-ceiling` | an added `timeout-minutes` above **30** in a workflow, or a `testTimeout`/`hookTimeout`/`timeout` (quoted key or not) above **120 000 ms** in a test file or test config (the documented ceilings, `CEILINGS`) |
| `retries-raised` | `retries`/`retry`/`maxRetries` raised in a test config, test file or workflow, or a new non-zero one in a test config/test file (`--health-retries` is excluded). Numeric thresholds are read as the literal's real value: `1_000`, `0x10`, `1e3` (PR70-r13) |
| `suppression-added` | an added `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `istanbul ignore`, `c8 ignore`, `nosec`, `gitleaks:allow` in a code/config file |
| `gitleaksignore-added` | any added non-comment line in `.gitleaksignore` |
| `ci-workflow-deleted`, `ci-job-removed`, `ci-step-removed`, `ci-step-changed`, `ci-trigger-removed`, `ci-trigger-narrowed` | a workflow file deleted or moved away; a job, or a step (identified by `name`, else `uses`, else `run`) missing from the head; a kept step whose other lines (`run`, `uses`, `with`, `env`, `if` …) changed; an `on:` trigger dropped; an `on:` line changed or removed, or a `types`/`branches`/`tags`/`paths`/`paths-ignore`/`branches-ignore`/`tags-ignore` filter line added (a required check that stops reporting). Any edit to a trigger line, widening included, therefore needs a Keep. Unnamed steps are keyed by `uses` without its `@version`, so an action bump shows as `ci-step-changed`. Duplicate identities in a job are numbered (`name:Check#2`), so deleting one of two same-named steps is a removal. A step list at the same indentation as `steps:` (valid YAML) is read too. YAML flow-style values are not parsed: an inline step list (`steps: [...]`), a job given as an inline mapping (`build: {...}`) and a flow `jobs: {...}` each fail closed as one opaque step holding the whole value with its continuation lines, so any edit to one is `ci-step-changed` and its removal or conversion `ci-step-removed` (PR70-r16, r17) |
| `ci-continue-on-error`, `ci-disabled` | an added `continue-on-error: true` (or an expression); an added constant-false `if:` (`false`, `0`, `null`, `!true`, or an expression that is false under GitHub precedence: an `&&` chain with a false term, an `||` chain whose every operand is false — bare, quoted or in `${{ }}`). A quoted value (`'${{ true }}'`) counts the same. In workflows every rule (these, `timeout-past-ceiling`, coverage, triggers) reads the changed lines with YAML key quotes removed, so `"timeout-minutes":` is `timeout-minutes:` (PR70-r18, PR70-r19). A block scalar (`if: >-` or `if: |` with the value below) is read from the head copy as one logical line, whether its key line or a value line changed (PR70-r20) |
| `failure-swallowed` | an added `|| true`, `|| :`, `set +e` or `|| exit 0` in a workflow or `package.json`, or in a shell script on a line that runs a test/check tool |
| `stub-marker` | an added `TODO`, `FIXME` or `not implemented` in non-test source (every DevOS PR is one module or task, so every PR claims a task done) |
| `stub-body` | a hunk in non-test source that removes ≥ 3 logic lines and adds exactly one line that only throws or returns a constant |
| `contract-weakened` | a removed or reworded line in an `Acceptance…`, `Pass rule` or `Green…` section of a `docs/modules/*.md` that already exists on the base (its first PR has opened); such a contract deleted or moved |
| `gitattributes-changed` | any `.gitattributes` added, changed or deleted |
| `binary-code-change` | a code, test or policy file the diff still reports as binary (defence in depth; `--text` normally prevents it) |
| `policy-weakened` | a net loss of deny / require_approval / gate / default-deny / wouldBlock / budget-exceeded references in `packages/policy/src` (non-test), the file deleted, or any removed line under `packages/policy/rules/` |
| `guard-change-not-isolated` | a change to a guard path together with any file other than guard paths, `docs/decisions/*.md` and this contract |

Guard paths are exempt from the content rules (their tests hold the very patterns), which is safe only because a guard change must come alone and needs a Codex PASS naming it (§4.5). From DEVOS-189 the exemption covers only the first three guard paths (`scripts/floor-guard/**`, `scripts/test/floor-guard.test.mjs`, `.github/workflows/floor-guard.yml`); the KK-only classifier and its table are guard paths but still get every content rule (note 0022).

**Known gap (pre-review finding, recorded 12 Nov 2026):** GitHub runs a `pull_request` workflow from the PR's own copy of `floor-guard.yml`. A PR that edits that file could stop the base guard from running at all, so its isolation hit is never computed. Until the Release path closes it, the defence is Codex review: the review watcher sees every head, and §4.5 requires the PASS to name any guard change. **GI-1b** adds to the Release merge path (DEVOS-143) a refusal for any PR whose diff touches a guard path unless the Codex verdict for that SHA names the change.

## CI job (`.github/workflows/floor-guard.yml`)
- On every `pull_request` to `main`; check name `floor-guard`; `timeout-minutes: 5`; `contents: read`.
- Runs the guard file **from the PR's base commit** (`git show $BASE:scripts/floor-guard/floor-guard.mjs`), so a PR that edits the guard is judged by the previous version. Only when the base has no guard (this bootstrap PR) does it run the head copy.
- Prints the wall time and writes the hits and the JSON report to the job summary. No new Action (checkout and setup-node only).

## Dispositions (spec §4.4) — runner decisions, 12 Nov 2026 (ADR-0013)
- **Restore:** revert the weakening; the next push re-runs the guard.
- **Keep:** `applyDispositions(report, verdict)` accepts a hit only when the verdict is from Codex (`source: "codex"`), is for the same SHA as the report, and has a line `FLOOR-GUARD KEEP <id> <file>:<line> <reason>` naming that hit. A Builder's note never counts; a new commit (new SHA) voids every Keep; an exit-2 report cannot be disposed of.
- **Escalate to KK:** only for money, data deletion, security scanning, legal, D11 or D13 hits; the card goes out under the normal HARD RULE.
- **Split (size check):** reading the Codex verdict for a SHA and letting the merge path accept a failing `floor-guard` check with valid Keeps is wiring, not detection, and belongs with the Release merge path (DEVOS-143). It is filed as **GI-1b** (follow-up), together with the guard-path refusal above. Until it lands, a hit blocks the runner's merge outright: the runner restores the weakening or obtains a Codex Keep and records it in the PR's merge evidence.

## Follow-ups (pre-review round 2, filed as GI-1c) — done in DEVOS-150 (note 0020)
- `pre`/`post` hooks of the test, lint, typecheck and check scripts in `package.json`: a changed, removed or new hook is `test-script-changed`.
- A skip referenced without being called (a ternary `(cond ? it : it.skip)`, or `const t = it.skip`) is `test-skipped`.
- `tsconfig*.json` strictness relaxed (`strict` or a sub-flag set to `false`, a `true` removed or commented out, or `extends` removed or retargeted) is `ts-strict-relaxed`.
- New files are read like any other: a hook or an explicit `false` flag in a new `package.json` or `tsconfig` is a hit and needs a restore or a Codex Keep, because a new package can relax as much as an edited one.
- Paths containing ` b/` are split with the `git diff -z --name-status` pairs, so hits name the real file.
- `binary-code-change` stays as defence in depth: `run()` diffs with `--text`, so git never reports a binary file, but a caller of `analyse()` might.

## Follow-up GI-4c (DEVOS-167, note 0021) — what a removed or changed CI step ran
- `ci-step-removed` text ends `; ran: <the step's body on one line>`, `ci-step-changed` ends `; was: <base body>; now: <head body>`, and `ci-job-removed` ends `; ran: <each step body, joined with " ;; ">`. A body is the step's lines other than its own `name:` (so `run:`, `uses:`, `with:`, `env:`, `if:` …), trimmed and joined with ` ⏎ ` (not ` | `, which a YAML block scalar `run: |` uses); indentation is dropped, so an indent-only edit reads the same in `was:` and `now:`, although the hit still fires.
- The hit text is still cut at 200 characters, and hit ids follow the new text. Nothing else changes: the same hits fire, with the same rules, files and lines.
- Why: the gate evaluator (`scripts/gates/evaluate-gate.mjs`, GI-4) can then tell from the stored result whether a removed or edited step ran security scanning. Narrowing its `KK_ONLY` on that basis was a separate PR (DEVOS-186). Since DEVOS-189 `scripts/gates/kk-only.mjs` is itself a guard path, so any later change to `KK_ONLY` must come alone and be named by a `FLOOR-GUARD CHANGE` marker (note 0022).

## Not in scope
- Making `floor-guard` a required check in the `main` ruleset (DEVOS-145, GI-3b) and adding it to `required-checks.json` (DEVOS-143).
- The pass-rule field and validator (DEVOS-142).

## Pass rule
- `node --test scripts/test/floor-guard.test.mjs` (part of `pnpm test`) exits 0. It holds one fixture diff per rule above expecting exit 1 and the rule's name, a clean diff expecting exit 0, forced errors (unknown ref, not a repository, missing arguments, unreadable diff) expecting exit 2, the isolation rule, dispositions, and the CLI.
- From DEVOS-189: `node --test scripts/test/floor-guard.test.mjs` exits 0 with 169 tests passing, including "guard isolation (DEVOS-189)" (the KK-only classifier paths are guard paths) and "content rules (DEVOS-189)" (a suppression, a skipped test or a deleted test on those paths is still a hit; the guard itself stays exempt).
- AT7: the `floor-guard` job on this PR's head SHA succeeds, and its log (`gh run view --log --job <id>`) shows `wall: <n>s` with n ≤ 120.

## Acceptance tests
| # | Pass when |
|---|---|
| AT1 | Every §4.2 pattern has a fixture diff that exits 1 with the matching rule (pass rule, first bullet) |
| AT2 | A clean diff (new code, new tests, more assertions, a contract row added, a timeout raised within the ceiling, a test renamed) exits 0 |
| AT3 | A forced error exits 2, and `applyDispositions` keeps exit 2 (exit 2 ≠ clean) — GC2 |
| AT4 | Adding `.skip` to an existing test exits 1 with `test-skipped` on the right file and line — GC1, detection half |
| AT5 | A Keep is honoured only from Codex, on the same SHA, naming id and file:line |
| AT6 | A guard change mixed with any other change is a hit; alone with a decision note it is not |
| AT7 | The CI job runs the base copy of the guard and finishes in ≤ 120 s |
| AT8 | (GI-4c) A removed `npm audit` step named "Checks", a removed `pnpm build` step, an edited step and a removed job each carry their body in the hit text (`ran:` / `was:`/`now:`), and a body past the cut stays cut at 200 characters |

## Green (stored on DEVOS-140 after merge)
- **GC1:** a throwaway PR adding `.skip` to an existing test gets `floor-guard` exit 1. "Cannot merge" is enforced by the Release path (DEVOS-143) and the ruleset (DEVOS-145) once `floor-guard` is a required check.
- **GC2:** a throwaway PR whose guard run is forced to error gets exit 2 and a failed check.

## Calibration (dry run, 12 Nov 2026)
Run over the last 15 merged PRs on main: 11 clean; 4 with hits — two `eslint-disable` lines in Prisma stores (#35, #55), two reworded acceptance rows in `server-agent.md` (#31), and a changed `Install Chromium` step in `dashboard-e2e.yml` (#39). All four are what §4.2 asks to catch; each would have needed a Codex Keep. Two noisy rules found in that run were narrowed before this PR: `|| true` in shell scripts counts only on lines that run a test/check tool, and an early `return` in a test counts only behind an env/platform/CI/skip condition.

## Build record
- Pre-review and evidence: see the PR body and the merge evidence comment on DEVOS-141.

# 0028 — KK's floor-guard answers are read from his Linear comment (GI-1e part b)

- **Status:** accepted (runner A, 16 Nov 2026, ADR-0013 technical delegation). Contract: `docs/modules/GI-1e.md` (part b).
- **Linear:** DEVOS-239. Builds on part a (PR #159): the record, parser and acceptance rule.

## Problem
Part a taught the Release path and ci-gate to accept a KK-only floor-guard hit when KK's recorded answer says "keep" for that exact hit and head SHA, but nothing read an answer, so "escalate to KK" still ended in a permanent red `ci-gate` (PR #157).

## Decision
1. **Source.** KK writes one line per hit, `FLOOR-GUARD KK KEEP <id> <file>:<line> <full head sha>`, in a comment on the PR's Linear issue. The issue comes from the branch (`kishore/devos-<n>-…`) and `Fixes|Closes|Resolves DEVOS-<n>` lines, at most 3. A comment starting `[runner`, one made by an app or bot (`botActor`), one by anyone other than KK's Linear user, or one without a `https://linear.app/…` link is never read as KK's. This is how every runner already tells KK from a runner (runner prompt; rules: "KK is identified only by Linear comments that do NOT start with `[runner`").
2. **Reader.** `scripts/release/kk-source.mjs`, zero dependencies: `POST https://api.linear.app/graphql` only, the key in the `authorization` header, read by name from `LINEAR_READ_KEY`, never logged or put in a message. A timeout on every call (15 s) and 60 s for the whole read; retries only for this read (network error, timeout, 429, 5xx; 3 attempts). Every failure gives no answers, so a KK-only hit stays refused: the reader can only make the gate pass where KK wrote a keep.
3. **ci-gate.** A separate `kk-answers` job checks out only the base commit's `scripts/release` (no credentials), installs nothing and runs its `kk-source.mjs` with `secrets.LINEAR_READ_KEY`. No code from the head runs in that job, so the key never meets it (a step in the ci-gate job would run after the head's `pnpm install`, which can execute a head `.pnpmfile.cjs` that sets `BASH_ENV`/`PATH` for later steps: pre-review finding 1). The job's `answers` output (records only) is written to `$RUNNER_TEMP/kk-answers.json` by a new ci-gate step right before the swap (so CI-T-b AT13 still holds); ci-gate `needs` the job but always runs (`if: ${{ !cancelled() }}`): a failed `kk-answers` job gives no answers, never a skipped (passing) gate. After KK answers, the runner re-runs the whole ci-gate run ("Re-run all jobs"); re-running only failed jobs reuses the first attempt's answers. The base commit's `ci-gate.mjs` reads the file (`loadKkAnswers`) and uses it only if every record is well formed. No existing step changes (local floor guard: 0 hits).
4. **CLI.** `scripts/release/merge.mjs` reads the same source when `LINEAR_READ_KEY` is set and logs how many answers it found.
5. **Egress.** `api.linear.app` is already on DevOS's allow-list (M2.6). This adds it from the ci-gate job and the Release CLI; nothing else.

## Trust and residual risk (recorded)
- The gate's code runs from the base commit (note 0017/0023), so a PR cannot change how answers are read or matched. The workflow file still comes from the PR: a PR could change the workflow (or run head code in the ci-gate job) to forge the answers file, as it can already subvert the base gate code. A PR that edits the `kk-answers` job could also expose the key during its own run, as with any Actions secret on a same-repo branch; only the runners push branches, fork PRs get no secrets, and the key is read-only, so the worst case is reading Linear. That boundary is unchanged by this note; it is covered by Codex review of `ci-gate.yml` and closed by the base-branch required workflow (DEVOS-145).
- Runners post Linear comments as KK's account; the `[runner` prefix is the only separation, as everywhere else in DevOS. A runner never writes a `FLOOR-GUARD KK` line (to be added to both runner prompts with this merge). An answer is bound to one hit and one full head SHA, so it never carries over to a new commit.
- A fork PR gets no secrets: no answers, hits stay refused.

## Needs KK (account action, not a technical decision)
A read-only Linear API key (Read permission only), stored as the GitHub Actions secret `LINEAR_READ_KEY` in `kkarnati1980/devos`. Until it exists every read reports "no Linear key" and behaviour is exactly part a's (KK-only hits refused).

## Rollback
Revert the PR: the step and reader go, and ci-gate reads no answers again.

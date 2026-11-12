# 0015 — One Release merge path; the `main` ruleset as backstop

- **Status:** accepted (runner B, 12 Nov 2026, 20:40 IST), under ADR-0013 §6 (technical decision by the runner).
- **Issue:** DEVOS-143 (gate integrity Part 3). Spec: `claude/devos-gate-integrity-spec-v1.0.0.md` §6.

## Context
Until now, D1 ("green CI and a Codex PASS on the same SHA") was applied by instruction: runners called the merge API with `sha=` by hand. No code refused a merge. The spec asked for one merge function plus a GitHub-side backstop.

## Decision
1. **`scripts/release/merge.mjs` is the only merge path** for runners. It reads the stored results for the PR's current head SHA (check runs, the `codex-review` status that the review watcher already posts, `main` in the head) and merges pinned to that SHA. No second Codex status context is added. Contract: `docs/modules/GI-3.md`.
2. **Node, not shell:** the repo's script tests already run under `node --test`, and a fake `fetch` makes every refusal path testable without GitHub.
3. **"Green CI" means:** at least one check run, all completed, none failed, at least one succeeded, and every check in `required-checks.json` present and `success`. The list starts empty and grows with the ruleset (below), so the script and the ruleset never disagree.
4. **Enforcement for the cloud runners (correction to the spec, verified 12 Nov):** the cloud build runners have **no** PreToolUse hook; the D7 hook belongs to DevOS's own agent runtime (M0.5/M1.5) and stays the control for DevOS Builder agents from P3. For the runners, enforcement is (a) the `main` ruleset, which is binding, and (b) the runner instructions, which will name this script as the only merge path once it merges (the coordinator updates both runner prompts).
5. **Ruleset on `main` (GI-3b, follow-up):** block direct pushes and force pushes; required status checks added one at a time, each only after it reports on every PR — `codex-review`, then the DEVOS-139 CI aggregator, then the DEVOS-141 floor guard. Bypass list: none for runners. The repo owner (KK) keeps GitHub's default admin bypass unless he decides otherwise. Applying it needs Administration: write, which only the server's H3 token holds; the application, with the `gh api repos/kkarnati1980/devos/rulesets` output, will be appended here.
6. **Only the watcher's PASS counts:** the `codex-review` status must have been posted by `codexCreator` (`kkarnati1980`, the account behind the watcher's token). A workflow cannot forge it with `GITHUB_TOKEN` (it posts as `github-actions[bot]`). Residual: anything holding a token of that same account could post it; moving the watcher to a dedicated GitHub App identity closes that and is a follow-up.
7. **Main moving after the check:** `sha=` pins only the head; if `main` moves between the compare and the merge, GitHub still merges. GI-3b's ruleset turns on "require branches to be up to date" (strict) so GitHub refuses that case.

## Consequences
- A commit after a PASS voids it: statuses are read per head SHA, and GitHub's 409 on a moved head is reported, never retried.
- Until GI-3b is applied, a runner that ignores its instructions could still merge directly; the ruleset closes that.
- The cloud runner sessions authenticate to GitHub through the MCP connector, not a local token. Until they hold a token the script can use, they run the same checks by hand in the script's order and merge pinned to the SHA; the coordinator's prompt update sets which.

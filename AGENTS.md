<!-- GENERATED from rules.md by `pnpm gen:rules`. Edit rules.md, not this file. -->

# DevOS project rules

These rules bind every agent working in this repo. `CLAUDE.md` (Claude) and `AGENTS.md` (Codex) are generated from this file by `pnpm gen:rules` — edit **rules.md**, never the generated files.

## Roles
- **Claude builds:** Architect (module contracts + plan), Builder (implements one module in its own worktree), Tester (acceptance tests + evidence).
- **Codex reviews** read-only; it never edits code. Auto-fix is off.
- **Release** integrates in dependency order and deploys.
- **KK** answers decision cards and approves gates.

## Before coding
1. Read the module contract in `docs/modules/<id>.md` and the requirement IDs it cites.
2. Look at existing code first; make the smallest change that satisfies the contract.
3. Work only on your assigned module's files, in your own worktree/branch.

## Every change
- One module = one PR. The branch name carries the Linear id (e.g. `kishore/devos-33-...`) or the PR body says `Fixes DEVOS-33`.
- A PR must pass CI (install, typecheck, lint, test) **and** a Codex PASS on the same commit before merge.
- Store evidence (commands, exit codes, output) for each acceptance test, per commit SHA.
- Merge in dependency order.

## Never
- Print or commit secrets. Secrets live in the server vault / Coolify env — never in the repo or in chat.
- Weaken or skip a test to make it pass.
- Touch production data.
- Deploy to production without a stored Codex PASS for the exact commit, and KK's approval for first launch.
- Circumvent copy protection, DRM, licensing or paywalls; lift proprietary code to clone it; or build malware/exploits against systems KK does not own or is not authorised to test. (D11)
- Strip or relabel a referenced repo's licence; copyleft that would bind KK's project → decision card first. (D13)

## Stop and ask (decision card to KK) when
- A non-technical question blocks (scope, priorities, budget, users, legal, content, accounts).
- A change would destroy data, spend money, or delete a project.
- A reverse-engineering request targets a third party — confirm authorisation first.
- A task fails 3 attempts (Sonnet, Sonnet, Opus) — label it `deadlocked`; the lane moves on to the next ready task.

## Model routing
- **Haiku:** summaries, release notes, classification.
- **Sonnet:** requirements, building, tests, maintenance.
- **Opus:** architecture, hard specs, the 3rd attempt after 2 Sonnet failures, review tie-breaks.
- **Codex:** code review.

## Source of truth
- **Linear** (team Devos, project "AI Development Team") is the plan: milestones = phases, module issues, task sub-issues.
- **GitHub** holds code; PRs link to Linear issues by branch name. No GitHub issue mirroring.
- Decisions: `docs/decisions/`. Module contracts: `docs/modules/`.


## Codex review
Review the diff against these rules and the module contract. Return `PASS` or `CHANGES_REQUESTED` using the JSON verdict schema in `packages/shared`. Do not edit code; auto-fix is off.

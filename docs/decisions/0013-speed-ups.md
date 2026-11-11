# ADR-0013 — Speed-ups: build ahead behind gates, delegated gate approval, two runners

- **Status:** accepted (11 Nov 2026, 19:16–19:17 IST, KK). Speed-ups 3, 4 and 6 were "do now"; 1, 2 and 5 were "yes". Linear: DEVOS-91.
- **Context:** The continuous build (6 Nov 2026) left the runner idle while a phase gate waited for KK, while a PR waited for its next review round, and whenever a technical question went to KK, who is not technical. One runner per hour also capped throughput.
- **Decision:**
  1. **Build ahead behind a gate.** While a phase gate waits only on evidence or approval, the next phase's modules may be contracted, built, opened as PRs and reviewed. Nothing from the next phase merges until the gate issue is Done. Such PRs are kept up to date with main and PASSed so they merge as soon as the gate closes. Pilot work is excluded (pilot hold).
  2. **Delegated gate approval.** The runner may approve G2, G3 and G4 itself when the evidence is complete:
     - every module and blocker of the phase is Done;
     - every server check on the deployed main SHA passes, with 0 skipped;
     - the gate's own criteria (its issue description) are met;
     - no open KK card, `deadlocked` label or stop-and-ask item is pending.

     On approval the runner posts an evidence comment, moves the gate to Done and sends KK a short informational message; KK can reverse it ("reopen G<n>"). G3's policy `enforce` switch is technical and is covered.
     **Not delegated:** G5 (the pilot is on hold); the first production launch of a real app for users (a business decision); anything involving money, data deletion, legal, D11 or D13.
  3. **Fix review rounds in the same run.** After a push the runner polls the review watcher and CI, fixes findings and re-pushes until PASS, within its time box, instead of handing off between rounds.
  4. **Pre-PR self-review.** Before opening a PR, a separate review agent reviews only the diff against the module contract and the Review guidelines in `rules.md`. Accepted findings are fixed first; the PR body records `Pre-review: <n> findings, <m> fixed`. A module too large to review in one pass (about 800 changed lines of non-generated source, or more than one concern) is split into task sub-issues, one PR each.
  5. **Two parallel runners.** Runner A (at :18) takes Lane A, unlaned issues and the phase gates; its lock and log is DEVOS-75. Runner B (at :48) takes Lanes B and C; its lock and log is DEVOS-89. Neither touches the other's branches or PRs. They share one weekly usage cap.
  6. **No idle time; KK decides only non-technical questions.** The runner makes every technical decision (design, libraries within licence policy, refactors, test strategy, splitting work, deadlock resolution, technical gate items) and records it with its reasons in the module contract or a `docs/decisions/` note. After 3 failed attempts on a task it picks a narrower scope or an alternative design that still meets the contract's acceptance tests, records why, and files follow-ups, instead of sending a card. KK is asked only about scope, priorities, budget or money, users, legal, content, accounts, data deletion, D11/D13 and the pilot, and for actions only he can take (creating accounts or keys, entering secrets, paying). Each run's time box is 50 minutes.
- **Consequences:** more work in flight at once, so main moves under each runner; every merge still needs green CI and a Codex PASS on the same SHA, with origin/main already in the head. A gate can close without KK looking at it; the evidence comment and the informational message keep it reversible. The `deadlocked` label now means a non-technical blocker only.
- **Supersedes:** the `rules.md` lines "KK approves gates", "One module = one PR" and "A task fails 3 attempts … label it `deadlocked`".

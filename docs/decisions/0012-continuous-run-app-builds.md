# ADR-0012 — Continuous-run mode for app builds

- **Status:** Accepted (KK's requirement, 6 Nov 2026; design by runner A, 14 Nov 2026, under ADR-0013's technical delegation)
- **Linear:** DEVOS-76 · Contract: `docs/modules/ADR-0012.md`
- **Touches:** M1.5 (run engine), M2.2 (Analyst), M2.3 (approvals inbox), M3.5 (preview pipeline), M3.6 (model router), M4.2 (auto-deploy), M4.6 (reports).

## Context
KK (6 Nov 2026): every app DevOS builds runs continuously, 24/7, the same way DevOS itself is now built. KK is needed only at intake, at gates and for real stop-and-ask items (money, destroying data, legal, D11/D13). Without a rule for this, every module would raise its own cards whenever it met a question, and one blocked task could hold a whole build.

## Decision
1. **Intake pre-flight (one card).** Once `requirements.md` and the S5 selection exist, the single intake card KK decides is M2.2's requirements card, which now also carries the *pre-flight*: every non-technical open question (M2.2 raises no separate cards for them in this mode) and every decision foreseeable for the build (scope options, integration modes, data sources, public URL, budgets) and every secret name the app will need (names only; values are entered in the setup wizard, never in a card). Each item has a recorded default. The build starts only when that card is approved and every listed secret is in the vault; an item KK leaves unanswered takes its default, written to the project's decision log (new table `project_decision`). Approving `requirements.md` and answering the pre-flight are one decision, so KK touches intake once.
2. **Non-blocking contracts.** Module contracts of an app build are published and built straight away. A KK comment on a contract re-opens it; it never blocks one.
3. **Always-on lanes.** The run engine starts the next ready task the moment a lane frees up, at any hour, inside the project's budget envelope (M1.7). A deadlocked task raises a card and its lane moves on to the next ready task. A budget stop pauses **only** that project and raises one card with the spend so far.
4. **Batched cards.** A non-urgent question found mid-build is queued, not sent. Queued questions go out as **one** card per project per day, with the 08:00 IST report (M4.6). Only stop-and-ask items interrupt at once: gates `destructive_or_spend`, `purge`, `first_launch`, and any question whose text touches legal, licences, D11/D13, deletion or money. The queue accepts a question only by allow-list (gate `decision` and none of those words), so it fails toward interrupting.
5. **Unattended release.** A preview deploy happens on green CI + Codex PASS on the same SHA + readiness green (M3.5). Live deploys after the first launch follow M4.2. The first launch still needs KK (rules.md).
6. **Gates are the only planned waits.** Gate evidence is compiled ahead; KK is notified the moment a gate is ready. While a gate waits, next-phase contracts are drafted but not built (app builds do not use ADR-0013's build-ahead).

## Why these choices (runner decisions)
- One intake card for requirements and pre-flight, not one per question: KK is not technical and asked to be touched as little as possible; a single sitting also matches how secrets are already collected (setup wizard, M1.4).
- Defaults on every item: an unanswered optional item must never hold the build, and a recorded default can be reversed by a later KK comment.
- Batching as a queue in front of the M2.3 core (not a change to it): the approvals core stays the only place a card is created and decided, so its validation, dedupe and KK-only rules apply unchanged.
- The queue, not the caller, decides what may wait: the gate (set by M2.3 from policy rules) plus a stop-and-ask word list, because cards carry no category field and no gate covers legal, D11 or D13. A false match only interrupts KK early; a missed one is what the list is there to prevent.
- App builds do not build ahead of a gate: ADR-0013's build-ahead is a DevOS-internal speed-up KK approved for his own build; for a client app the gate is the product decision.

## Consequences
- The work splits into task sub-issues (contract §Split). P2 builds the pre-flight card and the batch queue; the lane, release and report parts are built with M1.5/M3.5/M3.6/M4.2/M4.6 in P3–P4, as amendments to those contracts.
- The acceptance tests of DEVOS-76 are part of the G3 evidence.
- Rollback: the pre-flight requirement and the batch queue are each behind a per-project setting; switching either off restores per-question cards.

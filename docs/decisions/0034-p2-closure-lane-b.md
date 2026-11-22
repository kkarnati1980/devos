# 0034 — P2 closure for M2.6 Linear sync

- **Status:** Accepted (runner A, 22 Nov 2026, 10:55 IST). Technical decision under ADR-0013 and the IDLE PHASE REVIEW rule in the runner instructions (added 21 Nov 2026, announced on DEVOS-75 on 22 Nov 2026, 10:45 IST: after 3 idle runs while the phase is open, classify every remaining line and carry over or close). Runner A's lanes were idle on its runs of 22 Nov 2026 from 06:49 to 09:49 IST. KK can reopen it.
- **Linear:** DEVOS-22 (M2.6) · DEVOS-97 (M2.6-b) · DEVOS-46 (G2) · DEVOS-7 (M3.5)
- **Contract:** `docs/modules/M2.6.md` (section "P2 closure (decision 0034)"; no test row, pass rule or "done when" is changed). M2.3 (DEVOS-12) is decided separately in decision 0035, one module per PR.

## Context
Lane B moved to runner A on 22 Nov 2026 (decision 0033, its own PR). Every build part and follow-up of M2.6 is merged, yet DEVOS-22 and DEVOS-97 were still open, which keeps G2's condition "every module of the phase is Done" from holding. Each remaining line is classified as (a) doable now, (b) needs later-phase code (carry over), or (c) needs KK. No acceptance test is weakened, dropped or moved out of the phase.

## Decision
1. **M2.6 Linear sync (DEVOS-22) and M2.6-b (DEVOS-97) close for P2.**
   - Parts and follow-ups, all Done with merge evidence: DEVOS-96, DEVOS-132 (M2.6-a), DEVOS-155, DEVOS-156, DEVOS-163, DEVOS-247, DEVOS-248 (M2.6-b), and DEVOS-97's follow-up lines (PRs #193, #195, #196, #197). AT1–AT9 are built.
   - Pass rule on `a5da29e`: CI `build` (linear-sync unit tests), `linear-sync-db` and `db` (AT9 drift check) succeed.
   - **Remaining line 1: the G2 evidence named in the contract header and AT7** (a throwaway project appears in Linear and closes on purge). This is G2's own criterion (DEVOS-46 description), so it stays with G2 and is not carried over.
   - **Remaining line 2 (type b): move the "Open in Linear" module links onto the module board cards once the board reads the API.** The board still renders M1.3's mock source, and no project list/detail API exists for it yet. The links already work in the project page's "Linear" panel (M2.6-b2b3 decision 6), so no requirement is left unmet. Carried to **M3.5 Preview pipeline (DEVOS-7)** as a checklist line: M3.5 is the first module that has to show real per-module state on the project page (preview links per module), so it is where the board gets an API source. The checklist line on DEVOS-7 is what tracks it (DEVOS-97 is also linked as related to DEVOS-7, for traceability only; it gates nothing).
2. **Preconditions.** DEVOS-22 and DEVOS-97 move to Done only after this note merges, the G2 evidence line exists on DEVOS-46 and the carried line exists on DEVOS-7, each with an evidence comment saying where its lines went.

## Consequences
- M2.6 has no open P2 work; its live evidence runs with G2, whose criteria are unchanged.
- The board-card links line is tracked on DEVOS-7, so it is done when the board gets an API source.

# 0034 — P2 closure for Lane B: M2.3 and M2.6

- **Status:** Accepted (runner A, 22 Nov 2026, 10:55 IST). Technical decision under ADR-0013 and the IDLE PHASE REVIEW rule in the runner instructions (added 21 Nov 2026, announced on DEVOS-75 on 22 Nov 2026, 10:45 IST: after 3 idle runs while the phase is open, classify every remaining line and carry over or close). Runner A's lanes were idle on its runs of 22 Nov 2026 from 06:49 to 09:49 IST. KK can reopen it.
- **Linear:** DEVOS-12 (M2.3) · DEVOS-22 (M2.6) · DEVOS-97 (M2.6-b) · DEVOS-46 (G2) · DEVOS-7 (M3.5)
- **Contracts:** `docs/modules/M2.3.md`, `docs/modules/M2.6.md` (not edited: no test row, pass rule or "done when" changes)

## Context
Lane B moved to runner A on 22 Nov 2026 (decision 0033, its own PR). Every build part and follow-up of M2.3 and M2.6 is merged, yet DEVOS-12, DEVOS-22 and DEVOS-97 were still open, which keeps G2's condition "every module of the phase is Done" from holding. Each remaining line is classified as (a) doable now, (b) needs later-phase code (carry over), or (c) needs KK. No acceptance test is weakened, dropped or moved out of the phase.

## Decision
1. **M2.3 Approvals inbox (DEVOS-12) closes for P2.**
   - Parts and follow-ups, all Done with merge evidence: DEVOS-102 (M2.3-a), DEVOS-103 (M2.3-b1), DEVOS-135 (M2.3-b2), DEVOS-104, DEVOS-134, DEVOS-164, DEVOS-170, DEVOS-185, DEVOS-190. The contract's own close rule ("M2.3 is Done when b2 merges") is met.
   - Pass rule on the current main SHA `a5da29e`: CI `build` (api unit tests, AT1–AT11), `api-db` (AT2–AT5, AT7, AT8b, AT10, the DEVOS-164 lock, batch and race tests and "DEVOS-170 (db)" on Postgres) and `dashboard-e2e` (AT12) all succeed.
   - **Remaining line: the live "done when"** (on the server, a test card raised against a throwaway task is approved by KK in the dashboard and the task becomes `ready`; a second card is rejected and its task stays `blocked`). The contract labels it G2 evidence, so it is **not carried over**: it stays with G2 and is listed on DEVOS-46 as a G2 evidence line, run during the G2 throwaway-project run. It needs KK's click in the dashboard (type c), so KK is asked for it with the G2 run, not before.
2. **M2.6 Linear sync (DEVOS-22) and M2.6-b (DEVOS-97) close for P2.**
   - Parts and follow-ups, all Done with merge evidence: DEVOS-96, DEVOS-132 (M2.6-a), DEVOS-155, DEVOS-156, DEVOS-163, DEVOS-247, DEVOS-248 (M2.6-b), and DEVOS-97's follow-up lines (PRs #193, #195, #196, #197). AT1–AT9 are built.
   - Pass rule on `a5da29e`: CI `build` (linear-sync unit tests), `linear-sync-db` and `db` (AT9 drift check) succeed.
   - **Remaining line 1: the G2 evidence named in the contract header and AT7** (a throwaway project appears in Linear and closes on purge). This is G2's own criterion (DEVOS-46 description), so it stays with G2 and is not carried over.
   - **Remaining line 2 (type b): move the "Open in Linear" module links onto the module board cards once the board reads the API.** The board still renders M1.3's mock source, and no project list/detail API exists for it yet. The links already work in the project page's "Linear" panel (M2.6-b2b3 decision 6), so no requirement is left unmet. Carried to **M3.5 Preview pipeline (DEVOS-7)** as a checklist line: M3.5 is the first module that has to show real per-module state on the project page (preview links per module), so it is where the board gets an API source. The checklist line on DEVOS-7 is what tracks it (DEVOS-97 is also linked as related to DEVOS-7, for traceability only; it gates nothing).
3. **Preconditions.** DEVOS-12, DEVOS-22 and DEVOS-97 move to Done only after this note merges, the G2 evidence lines exist on DEVOS-46 and the carried line exists on DEVOS-7, each with an evidence comment saying where its lines went.

## Consequences
- Lane B has no open P2 work. P2's remaining modules are in Lane C (M2.4, M2.5, S4) and DEVOS-140 (gate integrity).
- G2's evidence list gains the M2.3 live approve/reject check; G2's criteria themselves are unchanged.

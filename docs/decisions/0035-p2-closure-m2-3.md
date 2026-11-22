# 0035 — P2 closure for M2.3 Approvals inbox

- **Status:** Accepted (runner A, 22 Nov 2026, 11:10 IST). Technical decision under ADR-0013 and the IDLE PHASE REVIEW rule in the runner instructions (added 21 Nov 2026, announced on DEVOS-75 on 22 Nov 2026, 10:45 IST: after 3 idle runs while the phase is open, classify every remaining line and carry over or close). Runner A's lanes were idle on its runs of 22 Nov 2026 from 06:49 to 09:49 IST. KK can reopen it. Split from decision 0034 (M2.6) so each module is reviewed in its own PR.
- **Linear:** DEVOS-12 (M2.3) · DEVOS-46 (G2)
- **Contract:** `docs/modules/M2.3.md` (section "P2 closure (decision 0035)"; no test row, pass rule or "done when" is changed)

## Context
Lane B moved to runner A on 22 Nov 2026 (decision 0033). Every build part and follow-up of M2.3 is merged, yet DEVOS-12 was still open, which keeps G2's condition "every module of the phase is Done" from holding. Each remaining line is classified as (a) doable now, (b) needs later-phase code (carry over), or (c) needs KK. No acceptance test is weakened, dropped or moved out of the phase.

## Decision
1. **M2.3 Approvals inbox (DEVOS-12) closes for P2.**
   - Parts and follow-ups, all Done with merge evidence: DEVOS-102 (M2.3-a), DEVOS-103 (M2.3-b1), DEVOS-135 (M2.3-b2), DEVOS-104, DEVOS-134, DEVOS-164, DEVOS-170, DEVOS-185, DEVOS-190. The contract's own close rule ("M2.3 (DEVOS-12) is Done when b2 merges", section "M2.3-b split and b1 build notes") is met.
   - Pass rule on the current main SHA `a5da29e`: CI `build` (api unit tests, AT1–AT11), `api-db` (AT2–AT5, AT7, AT8b, AT10, the DEVOS-164 lock, batch and race tests and "DEVOS-170 (db)" on Postgres) and `dashboard-e2e` (AT12) all succeed.
   - **Remaining line: the live "done when"** (on the server, a test card raised against a throwaway task is approved by KK in the dashboard and the task becomes `ready`; a second card is rejected and its task stays `blocked`). The contract already labels it "G2 evidence, after deploy", so it is **not carried over** and is not new to G2: it stays with G2 and is listed on DEVOS-46 as an evidence line, run during the G2 throwaway-project run. It needs KK's click in the dashboard (type c), so KK is asked for it with the G2 run, not before.
2. **Precondition.** DEVOS-12 moves to Done only after this note merges and the evidence line exists on DEVOS-46, with an evidence comment saying where it went.

## Consequences
- M2.3 has no open P2 work; its live check runs with G2, whose criteria are unchanged.

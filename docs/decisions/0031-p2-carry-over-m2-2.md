# 0031 — P2 carry-over for M2.2 (Analyst)

- **Status:** Accepted (runner A, 21 Nov 2026, 13:20 IST). Technical decision under ADR-0013 and the coordinator's idle-deadlock resolution of 21 Nov 2026, 12:35 IST (DEVOS-75, DEVOS-89). KK can reopen it. Split from decision 0030 (ADR-0012, PR #201) so each module is reviewed in its own PR.
- **Linear:** DEVOS-13 (M2.2)
- **Contract:** `docs/modules/M2.2.md` (note under its acceptance tests)

## Context
Both runners were idle for about 35 hours. P2 could not close because some open lines need code or resources that only exist in later phases, while later-phase build-ahead waits for P2's gate. The coordinator asked each runner to classify every remaining line of its open P2 items as (a) doable now, (b) needs later-phase code or resources (carry over), or (c) needs KK. No acceptance test is weakened or dropped, and no test row or pass rule is edited: a carried line stays an open item where it moves.

## Decision
1. **M2.2 (DEVOS-13).** All parts (DEVOS-121–124, with DEVOS-138, 153, 154, 160, 165) and every follow-up (DEVOS-161, 162, 166, 171, 187, and DEVOS-190 for the deferred gate/action/target filter of M2.2-d3c) are Done, each with a merge evidence comment. The one open line is **AT-G2** ("the pilot spec yields 51 FRs and 9 milestones"). It carries M2.2's PRD done-criterion ("Pilot spec yields 51 FRs"), so DEVOS-13 closes for P2 with that criterion open and tracked. It needs KK's pilot spec, so it falls under the pilot hold, and it is not one of M2.2's pass-rule commands. It is not a G2 criterion either: the PRD and the build plan define G2 as "a throwaway project goes create → purge with a zero-resource scan", and DEVOS-46 adds the M2.6 Linear project. The row's old "(At G2)" label is kept unedited (editing a test row is a floor-guard `contract-weakened` hit); the note under the table says where it runs now.
   - AT-G2 is tracked as a checklist line on DEVOS-4 (pilot, P5), to run as the first intake check after KK's go-ahead. Synthetic AT9 (60 requirements across 9 phases) stays the P2 evidence for the same shape.
   - **Precondition:** DEVOS-13 moves to Done only after that checklist line exists on DEVOS-4.

## Consequences
- M2.2's open acceptance test is tracked on the pilot issue, so it runs when the pilot starts and cannot be forgotten.
- M2.1's own AT-G2 is not changed here. It stays G2 evidence in M2.1's pass rule, and KK is asked on DEVOS-46 whether that read-only check may run before the pilot starts.

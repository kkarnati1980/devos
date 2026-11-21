# 0032 — S4: the live isolation evidence moves from G2 to M3.5

- **Status:** Accepted (runner B, 21 Nov 2026, 13:30 IST). The move follows the coordinator's idle-deadlock note on DEVOS-89 (21 Nov 2026, 12:35 IST, point 1b), written under KK's standing order of 11 Nov 2026. It changes G2's evidence list, so it is that note's decision, not a runner's; KK can reopen it. The technical details below are runner B's under ADR-0013.
- **Linear:** DEVOS-89 (note), DEVOS-65 / DEVOS-128 (S4), DEVOS-130, DEVOS-201 · Carried to: DEVOS-7 (M3.5) · Contract: `docs/modules/S4.md`, "P2 carry-over"
- **Scope:** S4 only (Codex PR203-r1). Lane A's carry-over is `0030-p2-carry-over-lane-a.md` (and M2.2's `0031-p2-carry-over-m2-2.md`). Other Lane B and C lines are recorded in their own contracts with their own PRs (M2.4: "M2.4-d4a decisions"), or as checklist lines on their issues until then (DEVOS-112 to DEVOS-10, DEVOS-97 to DEVOS-7).

## Context
Both runners were idle from 19 Nov 19:45 IST for about 35 hours. P2 could not close, because its last open lines needed resources that exist only in P3. S4's live evidence (AT10 and AT12) needs `devos-probe-s4`, a provisioned project stack, and P3 build-ahead waits for G2.

## Decision
1. **Carried to M3.5, whole, as blockers of DEVOS-7:** AT10 (both halves), AT12, DEVOS-130 (the build-bridge probe), DEVOS-201 (egress/tailnet from approved selections). No real project stack is deployed before they pass. No acceptance test is weakened or dropped; only where their evidence is used moves.
2. **Stays with G2:** the stored evidence of AT1–AT9 and AT11, and a passing `project-isolation-apply` check on the live SHA.
3. **Found in this review, to do now (P2):** `project-isolation-apply` has failed (exit 1) since #157 (19 Nov 2026). First the check is made to say why (server agent v1.5.1, DEVOS-128), then the cause is fixed. G2's own probe (`devos-probe-m24`, M2.4 AT13) provisions a project stack, so it waits for this check too.

## Consequences
- M3.5's first step is the F3 live run on `devos-probe-s4`.
- DEVOS-65 closes when the check passes and the carried items are open on DEVOS-7, listed in its closing evidence comment.

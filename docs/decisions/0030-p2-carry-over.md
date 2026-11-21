# 0030 — Carry P2 lines that need P3 code or resources over to P3 (Lanes B and C)

- **Status:** Accepted (runner B, 21 Nov 2026, 13:30 IST). A technical decision under ADR-0013 and KK's standing order of 11 Nov 2026, made on the coordinator's idle-deadlock note on DEVOS-89 (21 Nov 2026, 12:35 IST). KK can reopen it.
- **Linear:** DEVOS-89 (note), DEVOS-65 / DEVOS-128 (S4), DEVOS-112 (M2.5), DEVOS-97 (M2.6), DEVOS-21 (M2.4), DEVOS-217 · Carried to: DEVOS-7 (M3.5), DEVOS-10 (M3.1)

## Context
Both runners were idle from 19 Nov 19:45 IST for about 35 hours. P2 could not close, because its last open lines need code or resources that only exist in P3 (a deployed project stack, project runs, the board API), and P3 build-ahead waits for P2.

## Decision
Every remaining line of the open P2 items in Lanes B and C is classified (a) doable now, (b) needs P3, or (c) needs KK. No acceptance test is weakened or dropped: a carried line stays an open item in P3, and what G2 itself needs stays in P2.

| Line | Class | Where it goes / why |
|---|---|---|
| S4-c2 / AT12, live F3 run on `devos-probe-s4` (DEVOS-128) | (b) | Needs a deployed project stack. Checklist line on M3.5 (DEVOS-7); DEVOS-128 **blocks** DEVOS-7, so no real project stack runs before it. |
| Build-bridge probe (DEVOS-130) | (b) | Needs a project image build. With S4-c2 on M3.5; blocks DEVOS-7. |
| Isolation state from approved egress/tailnet selections (DEVOS-201), and AT10's declared-egress half | (b) | No M2.3 card carries a selection yet; the first project that declares egress is P3 work. Blocks DEVOS-7. Until then every stack gets the safe default (`egress:false`, `tailnet:[]`). |
| M2.5-b1 decision 7: Archive passes M1.5's cancel as `cancelRuns` (DEVOS-112) | (b) | Project runs exist only in P3. Checklist line on M3.1 (DEVOS-10). |
| "Open in Linear" links on the board cards (DEVOS-97) | (b) | The board still reads M1.3's mock source. Non-blocking line on M3.5. |
| `project-isolation-apply` failing on the server since #157 (19 Nov) (DEVOS-128) | (a) | Found in this review. Must be fixed before any project stack, G2's probe included. First make the cause visible (the server agent keeps the run's last output line), then fix it. |
| Provisioning settings never reach the API (`deploy/compose.yaml`), so the AT13 probe skips with `provision-github-owner-not-set` (DEVOS-21) | (a) | G2 needs the probe. Planned as M2.4-d4: tailnet IP from `DEVOS_BIND_IP`; the server agent discovers and upserts the Coolify URL and server UUID; the GitHub owner from the vault token. No KK step unless discovery fails. |
| listDue test paging (DEVOS-112, Codex PR199-r1 low) | (a) | Test-only fix. |
| Server-side orphaned-volume scan (DEVOS-236) | (a) | A read-only server check. |
| Runner watchdog (DEVOS-217) | done | `runner-watchdog` passes on the live SHA; closed 21 Nov. |
| DEVOS-206 (drop ci-gate's head install step) | (c), not P2 | Its changed steps are KK-only floor-guard hits; the card goes to KK with the concrete PR, so he answers on a real diff. It has no milestone and does not block P2. |
| G2 live evidence: M2.4 AT13, M2.5 AT10 (purge `devos-probe-m24`, zero-resource scan), M2.6 project created and closed, M2.3's live approve/reject | stays in P2 | What G2 itself needs (coordinator note, point 3). DEVOS-16, DEVOS-21 and DEVOS-22 stay open for it; the (a) lines above are what unblock it. |

## Consequences
- P3 modules carry the lines above; M3.5 cannot deploy a real project stack before the F3 live run.
- The parent issues close when every P2 acceptance test they own has stored evidence and only (b) lines remain.

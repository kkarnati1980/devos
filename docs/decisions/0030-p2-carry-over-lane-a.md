# 0030 — P2 carry-over for ADR-0012 (continuous-run mode)

- **Status:** Accepted (runner A, 21 Nov 2026, 12:48 IST). Technical decision under ADR-0013 and the coordinator's idle-deadlock resolution of 21 Nov 2026, 12:35 IST (DEVOS-75, DEVOS-89). KK can reopen it.
- **Linear:** DEVOS-76 (ADR-0012) · DEVOS-140 (gate integrity, reviewed, not changed). M2.1 and M2.2 (DEVOS-17, DEVOS-13) are decided separately in decision 0031, one module per PR.
- **Contract:** `docs/modules/ADR-0012.md` (section "P2 carry-over")

## Context
Both runners were idle for about 35 hours. P2 could not close because some open lines need code or resources that only exist in later phases, while later-phase build-ahead waits for P2's gate. The coordinator asked each runner to classify every remaining line of its open P2 items as (a) doable now, (b) needs later-phase code or resources (carry over), or (c) needs KK. No acceptance test is weakened or dropped, and no test row or pass rule is edited: a carried line stays an open item where it moves.

## Decision
1. **ADR-0012 (DEVOS-76).** CR-a (DEVOS-193, with DEVOS-198, 199, 204, 205) and CR-b (DEVOS-194, with DEVOS-210, 211) are Done, covering AT1–AT11 with stored evidence. The rest needs P3/P4 code (type b):
   - **CR-c / AT12** (a deadlock moves the lane on, a budget stop pauses one project, contract comments do not block, no next-phase start while a gate card is pending) → M3.6 (DEVOS-15). Its pass rule goes into the M3.6 contract, which also carries the M1.5 amendment. Blocks M3.6.
   - **CR-d / AT13** (preview on green CI + Codex PASS + readiness green on one SHA) → M3.5 (DEVOS-7). Blocks M3.5.
   - **CR-e / AT14** (a batched question in the 08:00 IST report; overnight task telemetry) → M4.6 (DEVOS-11). Blocks M4.6.
   - **AT15** (intake to preview with exactly two KK decisions) → G3 (DEVOS-45) evidence, as it already was.
   - **CR-d live / first launch** (no test in ADR-0012) → M4.2 (DEVOS-1): its contract specifies and tests that amendment. Blocks M4.2.
   - **Precondition:** DEVOS-76 moves to Done only after each of these five lines is written on its target issue.
   - M3.6 and M4.6 are Lane C, so runner B owns them. The lines are posted on DEVOS-89 too, and runner B writes AT12's and AT14's pass rules into those contracts when it builds them.
2. **DEVOS-140 (gate integrity) stays open**, unchanged. Its two open items are not P3 code: GC4 waits on the `main` ruleset (DEVOS-145, Lane C), and GC7 is produced by the first delegated gate approval itself. KK's confirmation of the D14 row (`0019-gate-rule-final-form.md`) is a KK step, so it goes to him as a card.

## Consequences
- P2's remaining open work in Lane A and unlaned work is DEVOS-140 and the M2.1/M2.2 items of decision 0031; the rest is Lanes B and C. G2 is then evaluated under the gate rule in force: ADR-0013 §2 as amended by decision 0019 (`scripts/gates/evaluate-gate.mjs` exit 0 over stored results), together with the runner instructions' conditions.
- The carried lines are tracked on the issues they depend on, so they cannot be forgotten when those modules are built.

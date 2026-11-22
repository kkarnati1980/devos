# 0033 — Lane B moves from runner B to runner A

- **Status:** Accepted. KK's decision, 22 Nov 2026, 10:34 IST (via Claude chat; recorded on DEVOS-75 and DEVOS-89 at 10:45 IST). Recorded here by runner A, as that comment asks.
- **Linear:** DEVOS-75 (runner A log) · DEVOS-89 (runner B log)
- **Amends:** ADR-0013 §5 (two parallel runners), lane split only; an amendment line is added under §5 there. `rules.md` "Runners" line updated to match; `CLAUDE.md` and `AGENTS.md` regenerated with `pnpm gen:rules`.

## Decision
1. **Runner A** (at :18, lock DEVOS-75) takes Lanes A and B, unlaned issues and the phase gates.
2. **Runner B** (at :48, lock DEVOS-89) takes Lane C.
3. **Hand-over.** A Lane B PR or branch that runner B opened before 22 Nov 2026 stays runner B's until it is merged or closed. Runner A reads runner B's recent handoffs on DEVOS-89 before starting Lane B work, so no work is done twice. At the time of this note no Lane B PR was open (open PRs: #211, the DEVOS-90 re-check draft, and #214, Lane C).
4. Everything else in ADR-0013 §5 is unchanged: neither runner touches the other's branches or PRs, and both share one weekly usage cap.

## Reason
KK's stated reason: share the Phase 2 work evenly between the two runners. Lane B's open P2 work at the time was M2.3 (DEVOS-12) and M2.6 (DEVOS-22, DEVOS-97) with their follow-ups (S3, DEVOS-64, the other P2 Lane B module, was already Done).

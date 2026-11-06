# SM-C2 — Multi-region disaster recovery

<!-- Generated from build-standard.yaml by `pnpm gen:standard`. Do not edit by hand. -->

- **Kind:** Opt-in (KK card only)
- **Applies when:** Only when KK asks on a card.
- **Catalogue:** v1.0.0 (ADR-0010)

## Checks

| Check | How | Evidence |
|---|---|---|
| **SM-C2-1** A restore into a second region meets the RTO and RPO on the card. | auto | `drill_report` |

## Code signals (mid-build detector, S5)
None: this module is never auto-added from code.

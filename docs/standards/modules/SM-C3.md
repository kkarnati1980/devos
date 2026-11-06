# SM-C3 — Public URL

<!-- Generated from build-standard.yaml by `pnpm gen:standard`. Do not edit by hand. -->

- **Kind:** Opt-in (KK card only)
- **Applies when:** Only when KK approves a public URL for the project (a per-project card under O3).
- **Catalogue:** v1.0.0 (ADR-0010)

## Checks

| Check | How | Evidence |
|---|---|---|
| **SM-C3-1** The public route exposes only what the card lists; everything else stays tailnet-only. | auto + review | `scan_report` |

## Code signals (mid-build detector, S5)
None: this module is never auto-added from code.

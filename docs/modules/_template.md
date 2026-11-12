# <ID> — <Name> (contract)

- **Linear:** DEVOS-<n> · <phase> · <lane> · <priority>
- **Source:** <requirement IDs, spec section, KK decision>
- **Applies:** <ADRs and decisions that bind this module>
- **Owned files:** <paths this module may change>

## Goal
<one paragraph>

## Interface
<types, routes, CLIs>

## Behaviour
<numbered rules, including runner decisions with their reasons (ADR-0013)>

## Not in scope
<what is deferred, with follow-up issue ids>

## Acceptance tests
| # | Pass when |
|---|---|
| AT1 | <observable condition> |

## Pass rule
<!-- Required (gate integrity Part 2, docs/modules/GI-2.md). Every bullet names a command, a test file or AT id,
     an exit code, an HTTP status or a threshold. Judgement words alone ("works", "looks good", "as expected") are rejected
     by `node scripts/contracts/check-pass-rule.mjs`. For UI, use a screenshot diff or a checklist script. -->
- `pnpm --filter <package> test` exits 0 on the merged SHA (AT1–ATn).

## Merge gate
CI green and Codex PASS on the exact head SHA (D1).

## Build record
- <date>, <who>: <what, with commands and exit codes>

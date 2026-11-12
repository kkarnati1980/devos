# CI-T — CI throughput (contract)

- **Linear:** DEVOS-139 (Medium) · Lane C · related DEVOS-143 (the aggregator becomes a required check) and DEVOS-141 (floor guard joins the every-push tier)
- **Spec:** KK, `claude/devos-ci-minutes-reduction-spec-v1.0.1.md` (claude.ai Project). Green conditions G1–G5 and constraints C1–C5 are KK's; the design is the Architect's (D10).
- **Decision log:** `docs/decisions/0016-ci-throughput.md` (every moved check is listed there, G5).
- **Split:** one PR per step in the decision log. This contract grows a section per step.

## Step 1 (CI-T-a): job timeouts — G3
- **Owned files:** the 8 workflow files that lacked a job timeout (`ci.yml`, `api-db.yml`, `db.yml`, `linear-sync-db.yml`, `policy-db.yml`, `provision-db.yml`, `run-engine-db.yml`, `teardown-db.yml`; one added line each), `scripts/test/ci-timeouts.test.mjs`, `docs/decisions/0016-ci-throughput.md`, this contract.
- **Behaviour:** every job declares `timeout-minutes` (values and their basis in the decision log); the ceiling is 30 minutes; a step may not outlast its job. Nothing else in any workflow changes.

| # | Pass when |
|---|---|
| T1 | `node --test scripts/test/ci-timeouts.test.mjs` passes, with one test per job in every workflow file (14 jobs today) |
| T2 | Removing the timeout from any job (e.g. `db.yml`) makes T1 fail |
| T3 | The diff adds exactly one `timeout-minutes` line to each of the 8 jobs and removes or changes no other workflow line (G5) |

## Pass rule
`node --test scripts/test/ci-timeouts.test.mjs` exits 0, and `git diff origin/main -- .github/workflows` shows only added `timeout-minutes` lines.

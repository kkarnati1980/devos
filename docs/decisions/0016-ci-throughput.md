# 0016 — CI throughput (DEVOS-139): decision log

- **Status:** in progress (runner B, 12 Nov 2026), under ADR-0013 §6 and D10. Spec: KK, `claude/devos-ci-minutes-reduction-spec-v1.0.1.md`.
- **Rule for every change here (G5):** no test, assertion, scan or threshold is removed or relaxed. Every check moved to a new trigger is listed in the table below with its old and new trigger.

## Step 1 — job timeouts (G3) · DEVOS-139, first PR
- Every job now declares `timeout-minutes`. The 8 jobs that had none got one:

  | Workflow | Job | p95 of successful runs (12 Nov sample) | timeout-minutes |
  |---|---|---|---|
  | ci.yml | build | 2.1 min | 15 |
  | api-db.yml | api-db | 0.8 min | 10 |
  | db.yml | db | 0.9 min | 10 |
  | linear-sync-db.yml | linear-sync-db | 0.9 min | 10 |
  | policy-db.yml | policy-db | 0.8 min | 10 |
  | provision-db.yml | provision-db | 0.8 min | 10 |
  | run-engine-db.yml | run-engine-db | 0.9 min | 10 |
  | teardown-db.yml | teardown-db | 0.8 min | 10 |

  The sample is the latest 100 completed workflow runs on 12 Nov (run start to completion, successes only). Values are at least 4× p95 with a 10-minute floor, so only a hung job is stopped; existing timeouts are unchanged.
- **Ceiling:** 30 minutes per job (the existing maximum, `dashboard-e2e` and `compose-smoke`). A step may not outlast its job.
- **Check:** `scripts/test/ci-timeouts.test.mjs` runs in the CI `Test` step and fails when any job lacks a numeric timeout, exceeds the ceiling, or has a step longer than the job. Adding a timeout only stops a stuck job earlier; it weakens nothing.

## Moved checks
None yet.

## Next steps (Architect's plan, each its own PR)
1. CI aggregator (C2): one always-running job that reports a single required status after every other check on the SHA has finished, so path filters can never silently skip a required check. It becomes a required check in the `main` ruleset (DEVOS-143 / DEVOS-145) and in `scripts/release/required-checks.json`.
2. One database job with one Postgres instance, keeping a separate result per suite.
3. Path filters behind the aggregator; buildx cache for compose-smoke.
4. Before/after minutes per merged PR (G1) and the failing-test proof, stored on DEVOS-139.

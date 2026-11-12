# Dead-letter view — API route and dashboard page (contract)

- **Linear:** DEVOS-77 · follow-up from M1.5 (DEVOS-23, PR #16) · unlaned (runner A) · Medium
- **Source:** `docs/modules/M1.5.md` behaviour 12 (the engine side: `RunQueue.deadLetters()` and `RunQueue.retryDead(jobId)`); ADR-0011 §9 ("a dead-letter view of failed jobs, with retry, sits on the dashboard").
- **Applies:** ADR-0011 §1 (CSRF on the retry), §2 (escaped output, strict CSP), §9 (every outbound call has a deadline: the queue's own `opTimeoutMs` set to the API's outbound timeout, and a bounded audit transaction), M1.2 conventions (deny by default, fixed error codes, no store message returned or logged), F1 (no secret in output or logs).
- **Depends on:** M1.5 (Done), M1.2 (Done), M1.3 (Done), M1.4/M1.1 (`audit_event`, Done).
- **Owned files:** `apps/api/src/dead-letters.ts`; the DEVOS-77 parts of `apps/api/src/{app,runtime,main}.ts`; `apps/api/openapi.yaml` (the two `/runs/dead-letters` operations); `apps/api/package.json` (the `@devos/run-engine` workspace dependency) and its `pnpm-lock.yaml` importer lines; `apps/api/test/dead-letters.test.mjs`; `apps/dashboard/app/dead-letters/**`; the DEVOS-77 parts of `apps/dashboard/lib/api.ts`, `apps/dashboard/app/layout.tsx` (nav link) and `apps/dashboard/test/e2e/{setup.e2e.mjs,stub-api.mjs}`; the api service's `REDIS_URL` line in `deploy/compose.yaml`; this contract.

## Behaviour
1. `GET /runs/dead-letters` (session) returns `{ deadLetters: [{ jobId, runId, reason, attemptsMade, failedAt }] }`: the newest 100 jobs in BullMQ's failed set. `reason` is shown only when it is one of M1.5's fixed codes (`run-<type>`); any other `failedReason` is a raw error message and is replaced by `run-failed`; `failedAt` is ISO-8601 or null.
2. `POST /runs/dead-letters/:jobId/retry` (session, CSRF) re-queues one job with `rerun: true` (M1.5) and answers `200 { retried }`. The job id must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` (M1.5: job id = run id), else `400 invalid:job-id`. A job not in the failed set → `404 dead-letter-not-found`.
3. **Audit first.** The retry writes one `audit_event` (`run.dead_letter.retry_requested`, actor kk, `{ jobId }`) before it calls the queue. If the audit write fails → `503 dead-letters-audit-error` and nothing is retried. Redis and Postgres cannot commit together; this order means a request can be recorded without a retry (an unknown job → 404, a queue error → 503), never a retry without a record. The action name says "requested" so such a row never claims a retry that did not happen (pre-review finding).
4. Queue errors → `503 dead-letters-unavailable`; a Redis connection error is logged as the fixed `dead-letters-queue-error` at most once a minute; the queue is closed on API shutdown; no `REDIS_URL` or no database → `503 dead-letters-not-configured`. No queue or store message ever leaves the API or reaches its logs.
5. **Runtime.** `REDIS_URL` absent → the view is off. Anything that does not parse as a `redis://` / `rediss://` URL with a host and a valid port (absent or 1–65535) stops start-up with `config-redis-url-invalid` (PR36-r1). The API opens M1.5's `RunQueue` on it (imported at runtime, like `@devos/db`). Compose passes `REDIS_URL: redis://redis:6379` to the api service (same Redis as the worker; the api already waits for Redis to be healthy).
6. **Dashboard.** `/dead-letters` ("Failed runs" in the nav) lists each job (run, reason, attempts, time) with a Retry button, shows the API's code with a plain message on errors, and reloads after a retry. React text only; no raw-HTML sink.

## Acceptance tests
| # | Pass when | Where |
|---|---|---|
| AT1 | The list returns run, reason, attempts and time for each failed job, at most 100 | `apps/api/test/dead-letters.test.mjs` DL AT1 |
| AT2 | A retry re-queues the job, writes exactly one audit event first, and the job leaves the list | DL AT2 |
| AT3 | Both routes need a session; a retry with a wrong CSRF token, a foreign Origin or a cross-site fetch is 403 and retries nothing | DL AT3 |
| AT4 | A malformed job id is 400 with no audit; an unknown one is 404, audited only as a request; nothing is retried | DL AT4 |
| AT5 | An audit failure retries nothing; queue errors answer fixed codes and never leak the error message to the response or logs | DL AT5 |
| AT6 | Without a queue both routes answer 503 `dead-letters-not-configured` | DL AT6 |
| AT7 | `REDIS_URL` parsing (absent → off, malformed → config code) and the runtime opens the queue only with both a database and `REDIS_URL` | DL AT7 |
| AT8 | Only fixed `run-*` codes are shown as the reason (a raw message becomes `run-failed`); a missing time is null | DL AT8 |
| AT9 | The dashboard page lists dead letters with a hostile reason shown as text (no script runs), retries one with the session's CSRF token, has no CSP violation and no horizontal scroll at 390 px | `apps/dashboard/test/e2e/setup.e2e.mjs` DL AT9 |
| AT10 | `openapi.yaml` lists both routes with their access level (M1.2 AT1 contract test) | `apps/api/test/api.test.mjs` AT1 |
| AT11 | `openapi.yaml` names only audit actions the code writes (`run.dead_letter.retry_requested`) | DL AT11 |

## Decisions (runner, ADR-0013)
- The API reaches M1.5's queue directly rather than through the worker, because `RunQueue` already bounds every call and the worker has no HTTP surface; a second service would add a hop and nothing else.
- Audit before retry (behaviour 3), because a retry without a record is worse than a record of a retry that did not happen.
- One PR: about 450 changed lines, one concern (the view), so no split.
- 12 Nov 2026, Codex PR36-r1 (2 medium; both accepted): the reason shown is checked against an explicit allow-list of M1.5's fixed codes (`REASON_CODES`), not a `run-*` pattern; `REDIS_URL` is parsed with `URL` (scheme, host, port 1–65535), so `redis://redis:bad` and `redis:///` fail with `config-redis-url-invalid`. New assertions in DL AT7/AT8.
- 12 Nov 2026, DEVOS-119 (Codex PR36-r2 low): the retry's OpenAPI description named `run.dead_letter.retried`, an action never written; it now names `run.dead_letter.retry_requested`, and DL AT11 checks that the spec names only actions the code writes.

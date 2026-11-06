# @devos/api

DevOS HTTP API (M1.2): NestJS 11, KK's Tailscale identity (LocalAPI whois), a 12-hour absolute session, CSRF checks, the security-header set, request-ID JSON logs and timeouts on every outbound call. The route contract is `openapi.yaml`; the module contracts are `docs/modules/M1.2.md` and `docs/modules/M1.4.md`.

M1.4 adds the setup wizard and settings routes and the write-only vault (AES-256-GCM under `DEVOS_VAULT_KEY`; values are never returned, only their last 4 characters and dates), plus CORS for the exact `DEVOS_ALLOWED_ORIGINS` so the dashboard can call the API from the browser.

- `pnpm --filter @devos/api test` builds and runs the acceptance tests (M1.2 AT1–AT10, M1.4 AT1–AT11).
- `pnpm --filter @devos/api run test:db` runs the M1.4 store tests against Postgres (`DATABASE_URL`; CI `api-db`).
- Configuration is by environment variable name only (see the contracts). Never commit values.

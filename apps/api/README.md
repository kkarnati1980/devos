# @devos/api

DevOS HTTP API (M1.2): NestJS 11, KK's Tailscale identity (LocalAPI whois), a 12-hour absolute session, CSRF checks, the security-header set, request-ID JSON logs and timeouts on every outbound call. The route contract is `openapi.yaml`; the module contracts are `docs/modules/M1.2.md` and `docs/modules/M1.4.md`.

M1.4 adds the setup wizard and settings routes and the write-only vault (AES-256-GCM under `DEVOS_VAULT_KEY`; values are never returned, only their last 4 characters and dates), plus CORS for the exact `DEVOS_ALLOWED_ORIGINS` so the dashboard can call the API from the browser.

- `pnpm --filter @devos/api test` builds and runs the acceptance tests (M1.2 AT1–AT10, M1.4 AT1–AT11).
- `pnpm --filter @devos/api run test:db` runs the M1.4 store tests against Postgres (`DATABASE_URL`; CI `api-db`).
- Configuration is by environment variable name only (see the contracts). Never commit values.

## Notifications (M1.6)
`docs/modules/M1.6.md`. One notice fans out to the dashboard feed, the MyBrain bell (HMAC-SHA256 over `<timestamp>.<body>`, headers `x-devos-timestamp` / `x-devos-signature: v1=…`) and email (SMTP over TLS, no dependency). Routes: `GET /notifications`, `GET /notifications/channels`, `PUT /notifications/channels/{kind}`, `POST /notifications/test`.

Configuration: the bell key and the SMTP password are vault secrets (`mybrain_bell_key`, `smtp_password`), entered in the setup wizard. Environment (not secret): `DEVOS_SMTP_HOST`, `DEVOS_SMTP_PORT`, `DEVOS_SMTP_SECURITY` (`tls` | `starttls`; `plain` only to a loopback relay), `DEVOS_SMTP_USER`, `DEVOS_SMTP_FROM`, `DEVOS_DASHBOARD_URL` (exact origin, for links).


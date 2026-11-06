# @devos/dashboard

DevOS dashboard shell (module **M1.3**, contract `docs/modules/M1.3.md`): home (projects) and project page (module board, spec, agent summaries, log, readiness placeholder). Mock data until the project routes exist.

- `pnpm --filter @devos/dashboard test` — build, then HTTP-level acceptance tests.
- `pnpm --filter @devos/dashboard test:e2e` — build, then Chromium tests (CI workflow `dashboard-e2e`).
- `pnpm --filter @devos/dashboard start` — `server.mjs`; HTTPS when `DEVOS_TLS_CERT_FILE` and `DEVOS_TLS_KEY_FILE` (from `tailscale cert`) are set.

Rules: React escapes everything; no raw-HTML sinks or inline styles (`pnpm lint`); strict per-request nonce CSP (`middleware.ts`).

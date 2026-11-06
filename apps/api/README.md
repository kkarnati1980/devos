# @devos/api

DevOS HTTP API (M1.2): NestJS 11, KK's Tailscale identity (LocalAPI whois), a 12-hour absolute session, CSRF checks, the security-header set, request-ID JSON logs and timeouts on every outbound call. The route contract is `openapi.yaml`; the module contract is `docs/modules/M1.2.md`.

- `pnpm --filter @devos/api test` builds and runs the acceptance tests (AT1–AT10).
- Configuration is by environment variable name only (see the contract). Never commit values.

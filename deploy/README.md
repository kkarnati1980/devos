# DevOS deploy (R1, docs/modules/R1.md)

One Coolify **Docker Compose** application built from this repo:

- Compose file: `deploy/compose.yaml`; base directory: the repo root (the build context is `..`).
- Branch `main`. The server agent (DEVOS-74) sets the exact commit (`git_commit_sha`) and deploys only a SHA with green CI and a Codex PASS (D1).

## Environment (names only; values live in Coolify env, never in the repo or in chat)

| Name | Required | What it is |
|---|---|---|
| `DEVOS_BIND_IP` | yes | the server's tailnet IPv4 (`tailscale ip -4`). Ports are published on this address only |
| `POSTGRES_PASSWORD` | yes | DevOS Postgres password (random, ≥ 32 characters) |
| `DEVOS_KK_LOGIN` | yes | KK's Tailscale login |
| `DEVOS_SESSION_KEY` | yes | session/CSRF HMAC key (random, ≥ 32 bytes) |
| `DEVOS_POLICY_HMAC_KEY` | yes | policy receipt HMAC key (random, ≥ 32 bytes); api and worker |
| `DEVOS_ALLOWED_ORIGINS` | yes | the dashboard's `https://<machine>.<tailnet>.ts.net:3000` origin |
| `DEVOS_VAULT_KEY`, `DEVOS_VAULT_KEY_VERSION` | for the wizard | M1.4 vault key |
| `DEVOS_DASHBOARD_URL` | optional | dashboard link used in notifications |
| `DEVOS_SMTP_HOST`, `_PORT`, `_SECURITY`, `_USER`, `_FROM` | optional | M1.6 email; the password is a vault secret |
| `DEVOS_TLS_DIR` | default `/root/.devos/tls` | host directory with the `tailscale cert` files (mounted read-only) |
| `DEVOS_TLS_CERT_FILE`, `DEVOS_TLS_KEY_FILE` | yes on the server | paths **inside** the container, e.g. `/certs/dashboard.crt`, `/certs/dashboard.key` |
| `DEVOS_COOKIE_SECURE` | default `1` | keep `1` on the server (M1.3-a) |
| `DEVOS_API_PORT`, `DASHBOARD_PORT` | default `3001`, `3000` | host ports on `DEVOS_BIND_IP` |
| `DEVOS_TAILSCALE_SOCKET_HOST` | default `/var/run/tailscale/tailscaled.sock` | mounted read-only into the api |

Provider keys and spending caps are **not** env: they are entered in the setup wizard (M1.4, H9).

## TLS certificate
The dashboard terminates HTTPS itself with the `tailscale cert` files (M1.3-a). The files must be readable by the container user (uid 1000). Automatic renewal (90-day certificates) is a follow-up (see the contract).

## Server checks
`scripts/server/checks/health-sha.sh` (this module) and `dashboard-tailnet-only.sh` (server agent) run after each deploy and post `server-check` on the SHA.

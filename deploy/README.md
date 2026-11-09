# DevOS deploy (R1, docs/modules/R1.md)

One Coolify **Docker Compose** application built from this repo:

- Coolify settings (as used at first launch, 9 Nov 2026): **Base Directory** `/deploy`, **Docker Compose Location** `/compose.yaml`. Coolify runs compose with `--project-directory` set to the Base Directory, so `context: ..` in `compose.yaml` resolves to the repo root.
- Branch `main`. The server agent (DEVOS-74) sets the exact commit (`git_commit_sha`) and deploys only a SHA with green CI and a Codex PASS (D1).
- **`GIT_SHA` is set by the server agent** (DEVOS-83), as a build-time and runtime variable, before each deploy. Coolify passes only build-time variables to the build, and `/health` reports this value. Do not set or edit `GIT_SHA` by hand.

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

### Verify the values are really set (prints lengths, never values)
Coolify once dropped the values of variables that were not marked Required (`DEVOS_POLICY_HMAC_KEY`, `DEVOS_VAULT_KEY`). After changing env, run this on the server (it prints each name and its value's length only; `0` means empty):

```
for s in api worker; do c="$(docker ps -q --filter label=com.docker.compose.service=$s | head -n1)"; echo "== $s"; docker exec "$c" sh -c 'for n in POSTGRES_PASSWORD DEVOS_POLICY_HMAC_KEY DEVOS_VAULT_KEY DEVOS_SESSION_KEY DEVOS_KK_LOGIN DEVOS_TLS_CERT_FILE DEVOS_TLS_KEY_FILE GIT_SHA; do v="$(printenv "$n")"; echo "$n ${#v}"; done'; done
```

### What `/ready` reports
The API's `GET /ready` is 503 with one of these reasons until its configuration is complete (the same codes it logs at start-up):

| Reason | Fix |
|---|---|
| `database-not-configured` | `DATABASE_URL` is empty (it is built from `POSTGRES_PASSWORD` by `with-db-url.mjs`) |
| `policy-not-configured` | `DEVOS_POLICY_HMAC_KEY` is empty |

A malformed value stops start-up instead, with a `config-*` code (for example `config-vault-key-invalid`), never the value.

Provider keys and spending caps are **not** env: they are entered in the setup wizard (M1.4, H9).

## TLS certificate
The dashboard terminates HTTPS itself with the `tailscale cert` files (M1.3-a). The files must be readable by the container user (uid 1000). Automatic renewal (90-day certificates) is a follow-up (see the contract).

## Server checks
`scripts/server/checks/health-sha.sh` (this module) and `dashboard-tailnet-only.sh` (server agent) run after each deploy and post `server-check` on the SHA.

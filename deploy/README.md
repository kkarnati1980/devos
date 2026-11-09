# DevOS deploy (R1, docs/modules/R1.md)

One Coolify **Docker Compose** application built from this repo:

- In Coolify: **Base Directory** `/deploy` and **Docker Compose Location** `/compose.yaml` (the build context `..` is then the repo root).
- Branch `main`. The server agent (DEVOS-74) sets the exact commit (`git_commit_sha`) and deploys only a SHA with green CI and a Codex PASS (D1).

## Environment (names only; values live in Coolify env, never in the repo or in chat)

| Name | Required | What it is |
|---|---|---|
| `DEVOS_BIND_IP` | yes | the server's tailnet IPv4 (`tailscale ip -4`). Ports are published on this address only |
| `POSTGRES_PASSWORD` | yes | DevOS Postgres password (random, ≥ 32 characters) |
| `DEVOS_KK_LOGIN` | yes | KK's Tailscale login |
| `DEVOS_SESSION_KEY` | yes | session/CSRF HMAC key (random, ≥ 32 bytes) |
| `DEVOS_POLICY_HMAC_KEY` | yes (compose refuses to start without it) | policy receipt HMAC key (random, ≥ 32 bytes); api and worker |
| `DEVOS_ALLOWED_ORIGINS` | yes | the dashboard's `https://<machine>.<tailnet>.ts.net:3000` origin |
| `DEVOS_VAULT_KEY` | yes (compose refuses to start without it) | M1.4 vault key: base64 of exactly 32 random bytes |
| `DEVOS_VAULT_KEY_VERSION` | optional | M1.4 vault key version (default 1) |
| `DEVOS_API_ORIGIN` | yes (compose refuses to start without it) | the API origin the dashboard pages call: `https://<machine>.<tailnet>.ts.net:3001` (R3, DEVOS-81) |
| `DEVOS_DASHBOARD_URL` | optional | dashboard link used in notifications |
| `DEVOS_SMTP_HOST`, `_PORT`, `_SECURITY`, `_USER`, `_FROM` | optional | M1.6 email; the password is a vault secret |
| `DEVOS_TLS_DIR` | default `/root/.devos/tls` | host directory with the `tailscale cert` files (mounted read-only) |
| `DEVOS_TLS_CERT_FILE`, `DEVOS_TLS_KEY_FILE` | yes (compose refuses to start without them) | paths **inside** the container, e.g. `/certs/dashboard.crt`, `/certs/dashboard.key`; the api and the dashboard use the same files |
| `DEVOS_COOKIE_SECURE` | default `1` | api and dashboard; keep `1` on the server (M1.3-a). With `1` the api and the dashboard each refuse to start (`config-tls-required`) unless both TLS files are readable |
| `DEVOS_API_PORT`, `DASHBOARD_PORT` | default `3001`, `3000` | host ports on `DEVOS_BIND_IP` |
| `DEVOS_TAILSCALE_SOCKET_HOST` | default `/var/run/tailscale/tailscaled.sock` | mounted read-only into the api |

Provider keys and spending caps are **not** env: they are entered in the setup wizard (M1.4, H9).

Required variables use `${NAME:?…}` in `compose.yaml`, so a value Coolify drops or blanks stops the deploy with `NAME is required` instead of starting a half-configured stack.

### Check the values are set (lengths only, never the values)
On the server, as root, this prints each variable's name and length from the env file Coolify generates for the DevOS app (the app UUID comes from the server agent's `coolify-deploy.env`; `missing` = not set):

```
f="/data/coolify/applications/$(sed -n 's/^COOLIFY_APP_UUID=//p' /root/.devos/coolify-deploy.env | head -n1)/.env"; for n in DEVOS_BIND_IP POSTGRES_PASSWORD DEVOS_KK_LOGIN DEVOS_SESSION_KEY DEVOS_POLICY_HMAC_KEY DEVOS_VAULT_KEY DEVOS_ALLOWED_ORIGINS DEVOS_API_ORIGIN DEVOS_TLS_CERT_FILE DEVOS_TLS_KEY_FILE; do v=$(grep -m1 "^$n=" "$f" | cut -d= -f2-); [ -n "$v" ] && echo "$n length ${#v}" || echo "$n missing"; done
```

## TLS certificate
The api and the dashboard each terminate HTTPS themselves with the same `tailscale cert` files (M1.3-a, R3-a), mounted read-only at `/certs`. An HTTPS dashboard page cannot call a plain-HTTP API (browsers block mixed content). The files must be readable by the container user (uid 1000). Automatic renewal (90-day certificates) is R3-d (DEVOS-87).

## Server checks
`scripts/server/checks/health-sha.sh` (this module; since R3 it calls `https://<MagicDNS name>:<API_PORT>/health` with the certificate verified) and `dashboard-tailnet-only.sh` (server agent) run after each deploy and post `server-check` on the SHA.

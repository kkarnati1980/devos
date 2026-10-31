#!/usr/bin/env bash
# DevOS M0.2 — Private access via Tailscale (ADR-0003, ADR-0004)
# Version: 1.0.0
# Run as root on the DevOS server:
#     bash 02-tailscale-access.sh                     # install, join tailnet, serve Coolify
#     bash 02-tailscale-access.sh --close-public-ssh  # later, after SSH over the tailnet works
#
# Idempotent. Does not change Coolify config or the M0.1 Docker filters.
set -euo pipefail

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
if [[ "${EUID}" -ne 0 ]]; then echo "Run as root (sudo bash $0)"; exit 1; fi

ts_running() { tailscale status >/dev/null 2>&1; }
ts_dnsname() {
  tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'
}

if [[ "${1:-}" == "--close-public-ssh" ]]; then
  say "Closing public SSH (ADR-0004)"
  ts_running || { echo "Tailscale is not running — refusing to close public SSH."; exit 1; }
  ufw status | grep -q 'Anywhere on tailscale0' || { echo "tailscale0 not allowed in UFW — refusing."; exit 1; }
  ufw delete allow 22/tcp || true
  ufw status verbose
  echo "Public SSH closed. Use: ssh root@devos (Tailscale on). Break-glass: hPanel browser console."
  exit 0
fi

say "1/5 Install Tailscale (official repo)"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
systemctl enable --now tailscaled

say "2/5 Join the tailnet as 'devos'"
if ts_running; then
  echo "  already connected"
else
  echo "  A login URL will appear below — open it, sign in with Google, approve 'devos'."
  tailscale up --hostname=devos
fi

say "3/5 Firewall: allow tailnet traffic to host services"
ufw allow in on tailscale0 comment 'tailnet (M0.2)'

say "4/5 fail2ban: never ban tailnet addresses"
cat > /etc/fail2ban/jail.d/devos-tailnet.local <<'JAIL'
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 100.64.0.0/10 fd7a:115c:a1e0::/48
JAIL
systemctl restart fail2ban

say "5/5 Tailscale Serve: Coolify panel + realtime over tailnet HTTPS"
tailscale serve --bg http://127.0.0.1:8000
tailscale serve --bg --https=6001 http://127.0.0.1:6001
tailscale serve --bg --https=6002 http://127.0.0.1:6002

HOST="$(ts_dnsname)"
echo "----- M0.2 evidence v1.0.0 $(date -u +%FT%TZ) -----"
echo "# tailscale";  tailscale status
echo "# dnsname";    echo "${HOST}"
echo "# serve";      tailscale serve status
echo "# ufw";        ufw status verbose
echo "# fail2ban";   fail2ban-client get sshd ignoreip
echo "# coolify";    curl -fsS -o /dev/null -w 'localhost:8000 HTTP %{http_code}\n' http://localhost:8000 || echo "no local response"
echo "----- end evidence -----"
echo
echo "Next: on the iMac (Tailscale on) open  https://${HOST}  and run  ssh root@devos"

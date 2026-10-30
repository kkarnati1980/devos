#!/usr/bin/env bash
# DevOS M0.1 — Server baseline hardening (Hostinger KVM 4, Ubuntu 24.04 + Coolify)
# Run as root on the NEW DevOS server, e.g. in Hostinger's AI web terminal:
#     sudo bash 01-server-baseline.sh
#
# Safe + idempotent. Does NOT change SSH login, SSH port, or Coolify config.
# Locks the Coolify panel so it is reachable only over an SSH tunnel.
set -euo pipefail

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [[ "${EUID}" -ne 0 ]]; then echo "Run as root (sudo bash $0)"; exit 1; fi

say "1/5 System update + automatic security updates"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get full-upgrade -y
apt-get install -y unattended-upgrades fail2ban ufw curl
dpkg-reconfigure -f noninteractive unattended-upgrades || true
systemctl enable --now unattended-upgrades

say "2/5 Firewall (UFW): default deny incoming, allow SSH only"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
# Coolify panel (8000) and app ports are intentionally NOT opened.
# Public access comes later via Cloudflare Tunnel (M0.2), which is outbound-only.
ufw --force enable

say "3/5 fail2ban (SSH brute-force protection)"
systemctl enable --now fail2ban

say "4/5 Verify Coolify is running locally"
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -i coolify || \
  echo "  (no container named coolify yet — if the template is still finishing, re-run in a few minutes)"
if curl -fsS -o /dev/null -w '  localhost:8000 -> HTTP %{http_code}\n' http://localhost:8000; then
  echo "  Coolify panel answers locally."
else
  echo "  Coolify not answering on :8000 yet (template may still be bootstrapping)."
fi

say "5/5 EVIDENCE BLOCK (copy this whole section back to Claude for DEVOS-33)"
echo "----- M0.1 evidence $(date -u +%FT%TZ) -----"
echo "# host";        uname -a
echo "# os";          . /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}"
echo "# ufw";         ufw status verbose
echo "# services";    systemctl is-enabled unattended-upgrades fail2ban 2>&1
echo "# docker";      docker ps --format '{{.Names}}\t{{.Status}}' 2>&1
echo "# coolify-http"; curl -fsS -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:8000 2>&1 || echo "no local response"
echo "----- end evidence -----"

cat <<'NEXT'

NEXT STEPS (do not open http://<server-ip>:8000 in a browser — it is firewalled on purpose):
  To reach the Coolify panel for its first-run admin setup, open a tunnel from YOUR laptop:
      ssh -L 8000:localhost:8000 root@200.234.41.176
  then browse  http://localhost:8000  in your laptop's browser.
  Finish Coolify's admin account there, then send Claude the evidence block above.
  Permanent private access (Cloudflare Access + Google login) is set up next in M0.2.
NEXT

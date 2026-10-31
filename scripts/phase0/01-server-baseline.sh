#!/usr/bin/env bash
# DevOS M0.1 — Server baseline hardening (Hostinger KVM 4, Ubuntu 24.04 + Coolify)
# Version: 1.1.0
# Run as root on the DevOS server, e.g. in Hostinger's browser terminal:
#     sudo bash 01-server-baseline.sh
#
# Safe + idempotent. Does NOT change SSH login, SSH port, or Coolify config.
# Locks the Coolify panel (and every Docker-published port) so it is reachable
# only over an SSH tunnel now, and over Tailscale after M0.2 (ADR-0003).
#
# v1.1.0: Docker publishes ports through its own iptables chains, which bypass
# UFW's INPUT rules — "ufw deny" alone leaves :8000/:80/:443/:6001/:6002 public.
# This version filters inbound traffic to containers in the DOCKER-USER chain
# (managed from /etc/ufw/after.rules so it survives reboots and ufw reloads).
set -euo pipefail

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [[ "${EUID}" -ne 0 ]]; then echo "Run as root (sudo bash $0)"; exit 1; fi

say "1/6 System update + automatic security updates"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get full-upgrade -y
apt-get install -y unattended-upgrades fail2ban ufw curl iproute2
dpkg-reconfigure -f noninteractive unattended-upgrades || true
systemctl enable --now unattended-upgrades

say "2/6 Firewall (UFW): default deny incoming, allow SSH only"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
# Coolify panel (8000), realtime (6001/6002) and proxy (80/443) are NOT opened.
# Private access arrives in M0.2 via Tailscale (ADR-0003). Nothing public.

say "3/6 Block public access to Docker-published ports (DOCKER-USER chain)"
AFTER_RULES=/etc/ufw/after.rules
if ! grep -q '^# BEGIN DEVOS UFW AND DOCKER' "${AFTER_RULES}"; then
  cat >> "${AFTER_RULES}" <<'RULES'

# BEGIN DEVOS UFW AND DOCKER (M0.1) — inbound to containers is denied unless
# it comes from a private range; container egress and replies are unaffected.
*filter
:ufw-user-forward - [0:0]
:ufw-docker-logging-deny - [0:0]
:DOCKER-USER - [0:0]
-A DOCKER-USER -j ufw-user-forward
-A DOCKER-USER -j RETURN -s 10.0.0.0/8
-A DOCKER-USER -j RETURN -s 172.16.0.0/12
-A DOCKER-USER -j RETURN -s 192.168.0.0/16
-A DOCKER-USER -p udp -m udp --sport 53 --dport 1024:65535 -j RETURN
-A DOCKER-USER -j ufw-docker-logging-deny -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -d 192.168.0.0/16
-A DOCKER-USER -j ufw-docker-logging-deny -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -d 10.0.0.0/8
-A DOCKER-USER -j ufw-docker-logging-deny -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -d 172.16.0.0/12
-A DOCKER-USER -j ufw-docker-logging-deny -p udp -m udp --dport 0:32767 -d 192.168.0.0/16
-A DOCKER-USER -j ufw-docker-logging-deny -p udp -m udp --dport 0:32767 -d 10.0.0.0/8
-A DOCKER-USER -j ufw-docker-logging-deny -p udp -m udp --dport 0:32767 -d 172.16.0.0/12
-A DOCKER-USER -j RETURN
-A ufw-docker-logging-deny -m limit --limit 3/min --limit-burst 10 -j LOG --log-prefix "[UFW DOCKER BLOCK] "
-A ufw-docker-logging-deny -j DROP
COMMIT
# END DEVOS UFW AND DOCKER
RULES
  echo "  DOCKER-USER rules added to ${AFTER_RULES}"
else
  echo "  DOCKER-USER rules already present"
fi
ufw --force enable
ufw reload

say "4/6 fail2ban (SSH brute-force protection)"
systemctl enable --now fail2ban

say "5/6 Verify Coolify is running locally"
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -i coolify || \
  echo "  (no container named coolify yet — if the template is still finishing, re-run in a few minutes)"
if curl -fsS -o /dev/null -w '  localhost:8000 -> HTTP %{http_code}\n' http://localhost:8000; then
  echo "  Coolify panel answers locally."
else
  echo "  Coolify not answering on :8000 yet (template may still be bootstrapping)."
fi

say "6/6 EVIDENCE BLOCK (copy this whole section back to Claude for DEVOS-33)"
echo "----- M0.1 evidence v1.1.0 $(date -u +%FT%TZ) -----"
echo "# host";         uname -a
echo "# os";           . /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}"
echo "# ufw";          ufw status verbose
echo "# docker-user";  iptables -S DOCKER-USER 2>&1
echo "# services";     systemctl is-enabled unattended-upgrades fail2ban 2>&1
echo "# fail2ban";     fail2ban-client status sshd 2>&1 | head -4
echo "# listening";    ss -ltnH | awk '{print $4}' | sort -u
echo "# docker";       docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' 2>&1
echo "# coolify-http"; curl -fsS -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:8000 2>&1 || echo "no local response"
echo "----- end evidence -----"

cat <<'NEXT'

NEXT STEPS
1. From YOUR LAPTOP (not the server), confirm nothing is public — each should time out:
       for p in 8000 6001 6002 80 443; do curl -sS -m 5 -o /dev/null -w "$p HTTP %{http_code}\n" http://200.234.41.176:$p || echo "$p blocked"; done
2. Reach the Coolify panel through an SSH tunnel from your laptop (6001/6002 = realtime + terminal):
       ssh -L 8000:localhost:8000 -L 6001:localhost:6001 -L 6002:localhost:6002 root@200.234.41.176
   then browse  http://localhost:8000  and create the Coolify admin account.
3. In hPanel, confirm VPS snapshots/backups are enabled for this server.
4. Send Claude: the evidence block above + the laptop curl output + "snapshots on: yes/no".
Permanent private access (Tailscale, Google login) is set up next in M0.2.
NEXT

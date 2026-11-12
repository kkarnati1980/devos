#!/usr/bin/env bash
# DevOS M0.1 — Server baseline hardening (Hostinger KVM 4, Ubuntu 24.04 + Coolify)
# Version: 1.3.2
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
#
# v1.2.0: Coolify's Docker network has IPv6 enabled, so Docker also DNATs the same
# ports over IPv6 (ip6tables). The IPv6 DOCKER-USER chain is filtered the same way
# from /etc/ufw/after6.rules (container ULA range fd00::/8).
#
# v1.3.0 (Codex review cedb0f9 + Architect):
# - DOCKER-USER is default-deny and stateful: replies (ESTABLISHED,RELATED), private
#   sources and ufw route rules (e.g. tailnet, M0.2) pass; everything else forwarded
#   to containers is dropped — any protocol, any port. Replaces the ufw-docker
#   pattern that left UDP >32767 and any packet from source port 53 unfiltered.
# - No `ufw --force reset` once UFW is active: re-running would wipe M0.2's tailnet
#   rules and re-open public SSH. Defaults are re-asserted instead.
# - Public 22/tcp is only added on first setup; after ADR-0004 (tailnet-only SSH)
#   it is not re-added.
# - The DEVOS block in after.rules/after6.rules is replaced, not appended, so
#   upgrades apply on re-run.
#
# v1.3.1 (Codex review c2a195e + server run):
# - Public 22/tcp is added only on first setup (UFW inactive at start), never on re-run.
# - ufw writes its rule files as ASCII and crashed on an em dash in the v1.1/1.2 block
#   comment; all rule text is ASCII now and non-ASCII is scrubbed from /etc/ufw/*.rules
#   before any ufw command runs.
#
# v1.3.2 (DEVOS-52): the printed laptop check covers IPv4 and IPv6 on 8000, 8080, 6001, 6002,
#   80 and 443 (contract AT3). Step 2 prints the SSH-tunnel route (AT4) until M0.2 is applied
#   (tailscale0 up), then says the server is tailnet-only (PR37-r1). Text only;
#   no firewall change, so a re-run is not needed.
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

say "2/6 Firewall (UFW): default deny incoming"
# ufw rewrites /etc/ufw/*.rules as ASCII; scrub any non-ASCII left by older versions first.
python3 - /etc/ufw/*.rules <<'PY'
import sys
for p in sys.argv[1:]:
    t = open(p, encoding="utf-8", errors="replace").read()
    a = "".join(c if ord(c) < 128 else "-" for c in t)
    if a != t:
        open(p, "w", encoding="ascii").write(a); print(f"  scrubbed non-ASCII from {p}")
PY
if ufw status | grep -q '^Status: active'; then
  FIRST_SETUP=0
  echo "  UFW already active - keeping existing rules (no reset; later modules' rules live here)"
else
  FIRST_SETUP=1
  ufw --force reset
fi
ufw default deny incoming
ufw default allow outgoing
ufw default deny routed
if [[ "$FIRST_SETUP" -eq 1 ]]; then
  ufw allow 22/tcp comment 'SSH'
else
  echo "  re-run: SSH rules left as they are (public 22/tcp is only added on first setup)"
fi
# Coolify panel (8000), realtime (6001/6002), proxy (80/443/8080) are NOT opened publicly.

say "3/6 Block public access to Docker-published ports (DOCKER-USER, IPv4 + IPv6)"
replace_block() {  # replace_block FILE  (block body on stdin)
  local f="$1" tmp
  tmp="$(mktemp)"
  sed '/^# BEGIN DEVOS UFW AND DOCKER/,/^# END DEVOS UFW AND DOCKER/d' "$f" > "$tmp"
  { cat "$tmp"; cat; } > "$f"
  rm -f "$tmp"
}
replace_block /etc/ufw/after.rules <<'RULES'
# BEGIN DEVOS UFW AND DOCKER (M0.1 v1.3.1) - default-deny for traffic forwarded to
# containers: ufw route rules (tailnet), replies and private sources pass; all else drops.
*filter
:ufw-user-forward - [0:0]
:ufw-docker-logging-deny - [0:0]
:DOCKER-USER - [0:0]
-A DOCKER-USER -j ufw-user-forward
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -s 10.0.0.0/8 -j RETURN
-A DOCKER-USER -s 172.16.0.0/12 -j RETURN
-A DOCKER-USER -s 192.168.0.0/16 -j RETURN
-A DOCKER-USER -j ufw-docker-logging-deny
-A ufw-docker-logging-deny -m limit --limit 3/min --limit-burst 10 -j LOG --log-prefix "[UFW DOCKER BLOCK] "
-A ufw-docker-logging-deny -j DROP
COMMIT
# END DEVOS UFW AND DOCKER
RULES
replace_block /etc/ufw/after6.rules <<'RULES6'
# BEGIN DEVOS UFW AND DOCKER (M0.1 v1.3.1, IPv6) - same policy; containers use ULA fd00::/8.
*filter
:ufw6-user-forward - [0:0]
:ufw6-docker-logging-deny - [0:0]
:DOCKER-USER - [0:0]
-A DOCKER-USER -j ufw6-user-forward
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -s fd00::/8 -j RETURN
-A DOCKER-USER -j ufw6-docker-logging-deny
-A ufw6-docker-logging-deny -m limit --limit 3/min --limit-burst 10 -j LOG --log-prefix "[UFW DOCKER BLOCK] "
-A ufw6-docker-logging-deny -j DROP
COMMIT
# END DEVOS UFW AND DOCKER
RULES6
ufw --force enable
ufw reload
echo "  DOCKER-USER (v4): $(iptables -S DOCKER-USER | wc -l) rules; (v6): $(ip6tables -S DOCKER-USER | wc -l) rules"

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
echo "----- M0.1 evidence v1.3.1 $(date -u +%FT%TZ) -----"
echo "# host";         uname -a
echo "# os";           . /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}"
echo "# ufw";          ufw status verbose
echo "# docker-user";  iptables -S DOCKER-USER 2>&1
echo "# docker-user6"; ip6tables -S DOCKER-USER 2>&1
echo "# services";     systemctl is-enabled unattended-upgrades fail2ban 2>&1
echo "# fail2ban";     fail2ban-client status sshd 2>&1 | head -4
echo "# listening";    ss -ltnH | awk '{print $4}' | sort -u
echo "# docker";       docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' 2>&1
echo "# coolify-http"; curl -fsS -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:8000 2>&1 || echo "no local response"
echo "----- end evidence -----"

cat <<'EOF_NEXT'

NEXT STEPS
1. From YOUR LAPTOP (not the server; a request from the server to itself proves nothing), confirm
   nothing is public over IPv4 or IPv6 — every port should end in "blocked" (after "HTTP 000"):
       for h in 200.234.41.176 '[2a02:4780:63:89c2::1]'; do for p in 8000 8080 6001 6002 80 443; do curl -sS -g -m 5 -o /dev/null -w "$h:$p HTTP %{http_code}\n" "http://$h:$p" 2>/dev/null || echo "$h:$p blocked"; done; done
   If your network has no IPv6, the IPv6 lines fail either way; then the server's
   ufw6-docker-logging-deny packet counter is the evidence (docs/modules/M0.1.md).
EOF_NEXT
if ip link show tailscale0 >/dev/null 2>&1; then
  cat <<'EOF_NEXT'
2. M0.2 is applied (tailscale0 is up), so the server is tailnet-only (ADR-0004): open Coolify and
   DevOS only over Tailscale, never through a public port or an SSH tunnel.
EOF_NEXT
else
  cat <<'EOF_NEXT'
2. M0.2 (Tailscale) is not applied yet. Reach the Coolify panel through an SSH tunnel from your
   laptop (6001/6002 = realtime + terminal; contract AT4):
       ssh -L 8000:localhost:8000 -L 6001:localhost:6001 -L 6002:localhost:6002 root@200.234.41.176
   then browse  http://localhost:8000  and create the Coolify admin account.
   Permanent private access (Tailscale) is set up next in M0.2.
EOF_NEXT
fi
cat <<'EOF_NEXT'
3. In hPanel, confirm VPS snapshots/backups are enabled for this server.
4. Send Claude: the evidence block above + the laptop output + "snapshots on: yes/no".
EOF_NEXT

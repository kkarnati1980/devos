#!/usr/bin/env bash
# DevOS server check (DEVOS-74; G1 evidence): the dashboard serves valid HTTPS on its tailnet name and refuses
# every public IPv4 address of this host. Exit 0 pass, 1 fail, 3 skipped (no dashboard deployed yet).
# v1.1.0 (DEVOS-83): a port that answers is not enough. The handshake on https://<MagicDNS name>:<port>/ must
# verify the certificate (curl's default CA check), so a dashboard serving plain HTTP fails. Port probes are
# plain TCP connects, so the result does not depend on the protocol the listener speaks.
# Port: DASHBOARD_PORT in $DEVOS_DIR/server-agent.conf (read with sed, default 3000).
# Limit: probing our own public IP from the host tests the listener binding, not the cloud firewall (traffic
# to a local address stays on the host). An outside probe is still needed for the firewall part of G1.
set -uo pipefail
CONF="${DEVOS_DIR:-/root/.devos}/server-agent.conf"
PORT="$(sed -n 's/^DASHBOARD_PORT=\([0-9]\{2,5\}\)$/\1/p' "$CONF" 2>/dev/null | head -n1)"
PORT="${PORT:-3000}"
TS_IP="$(timeout 10 tailscale ip -4 2>/dev/null | head -n1)"
[[ "$TS_IP" =~ ^100\. ]] || { echo "no tailnet IPv4 (tailscale ip -4)"; exit 1; }
open_port() { timeout 5 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$1" "$PORT" 2>/dev/null; }

if ! open_port "$TS_IP"; then echo "skipped: nothing answers on tailnet $TS_IP:$PORT (dashboard not deployed yet)"; exit 3; fi
NAME="$(timeout 10 tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' 2>/dev/null | sed 's/\.$//')"
[[ "$NAME" =~ ^[A-Za-z0-9.-]+\.ts\.net$ ]] || { echo "tailnet $TS_IP:$PORT answers, but no MagicDNS name (tailscale status --json)"; exit 1; }
# --resolve pins the name to the tailnet IP, so the probe never leaves the tailnet; the certificate is verified.
code="$(curl -sS -o /dev/null --connect-timeout 5 --max-time 10 -w '%{http_code}' \
  --resolve "$NAME:$PORT:$TS_IP" "https://$NAME:$PORT/" 2>&1)"; crc=$?
rc=0
if (( crc != 0 )); then
  echo "tailnet https://$NAME:$PORT/ -> no valid HTTPS (curl exit $crc: $(printf '%s' "$code" | tr -d '\r' | tail -n1 | cut -c1-120))"
  rc=1
else
  echo "tailnet https://$NAME:$PORT/ -> HTTPS ok (certificate verified), HTTP $code"
fi
n=0
for ip in $(hostname -I); do
  [[ "$ip" =~ ^[0-9.]+$ ]] || continue
  [[ "$ip" =~ ^(10\.|127\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.) ]] && continue
  n=$((n+1))
  if open_port "$ip"; then echo "public $ip:$PORT -> accepts connections (EXPOSED)"; rc=1; else echo "public $ip:$PORT -> refused (ok)"; fi
done
(( n > 0 )) || echo "note: no public IPv4 found on this host"
exit "$rc"

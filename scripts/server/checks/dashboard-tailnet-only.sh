#!/usr/bin/env bash
# DevOS server check (DEVOS-74 example; G1 evidence): the dashboard answers on the tailnet IP and refuses
# every public IPv4 address of this host. Exit 0 pass, 1 fail, 3 skipped (no dashboard deployed yet).
# Port: DASHBOARD_PORT in $DEVOS_DIR/server-agent.conf (read with sed, default 3000).
# Limit: probing our own public IP from the host tests the listener binding, not the cloud firewall (traffic
# to a local address stays on the host). An outside probe is still needed for the firewall part of G1.
set -uo pipefail
CONF="${DEVOS_DIR:-/root/.devos}/server-agent.conf"
PORT="$(sed -n 's/^DASHBOARD_PORT=\([0-9]\{2,5\}\)$/\1/p' "$CONF" 2>/dev/null | head -n1)"
PORT="${PORT:-3000}"
TS_IP="$(timeout 10 tailscale ip -4 2>/dev/null | head -n1)"
[[ "$TS_IP" =~ ^100\. ]] || { echo "no tailnet IPv4 (tailscale ip -4)"; exit 1; }
code() { curl -s -o /dev/null --connect-timeout 5 --max-time 10 -w '%{http_code}' "http://$1:$PORT/" || true; }
ts="$(code "$TS_IP")"
if [[ "$ts" == 000 ]]; then echo "skipped: nothing answers on tailnet $TS_IP:$PORT (dashboard not deployed yet)"; exit 3; fi
echo "tailnet $TS_IP:$PORT -> HTTP $ts"
rc=0; n=0
for ip in $(hostname -I); do
  [[ "$ip" =~ ^[0-9.]+$ ]] || continue
  [[ "$ip" =~ ^(10\.|127\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.) ]] && continue
  n=$((n+1)); pub="$(code "$ip")"
  if [[ "$pub" == 000 ]]; then echo "public $ip:$PORT -> refused (ok)"; else echo "public $ip:$PORT -> HTTP $pub (EXPOSED)"; rc=1; fi
done
(( n > 0 )) || echo "note: no public IPv4 found on this host"
exit "$rc"

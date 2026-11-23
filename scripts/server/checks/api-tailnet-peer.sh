#!/usr/bin/env bash
# DevOS server check (S4-d, DEVOS-251; M1.2 depends on it): inbound tailnet connections to the DevOS API and
# dashboard keep the client's own address, so AccessGuard's `tailscale whois` sees the real peer and never the
# bridge gateway. Read-only. Exit 0 pass, 1 fail, 3 skipped (no tailnet IPv4, or nothing could be read).
# Two independent reads:
#   1. tailscaled's masquerade rule: `iptables -t nat -S ts-postrouting` holding a MASQUERADE rule fails
#      (tailnet-snat.sh turns it off every agent tick).
#   2. conntrack: every tracked TCP connection to this host's tailnet IPv4 on the API port (API_PORT, default
#      3001) or the dashboard port (DASHBOARD_PORT, default 3000) whose client is another tailnet address must
#      have its reply addressed to that same client. A reply to any other address (the bridge gateway) means the
#      source was rewritten: fail. Connections from this host itself are not counted.
# Ports come from $DEVOS_DIR/server-agent.conf (read with sed). Only addresses and counts are printed.
set -uo pipefail
CONF="${DEVOS_DIR:-/root/.devos}/server-agent.conf"
port_of() { sed -n "s/^$1=\\([0-9]\\{2,5\\}\\)\$/\\1/p" "$CONF" 2>/dev/null | head -n1; }
API="$(port_of API_PORT)"; API="${API:-3001}"
DASH="$(port_of DASHBOARD_PORT)"; DASH="${DASH:-3000}"
TAILNET='^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}$'

TS_IP="$(timeout 10 tailscale ip -4 2>/dev/null | head -n1)"
[[ "$TS_IP" =~ $TAILNET ]] || { echo "skipped: no tailnet IPv4 (tailscale ip -4)"; exit 3; }

rc=0; read_any=0
if out="$(timeout 10 iptables -w 5 -t nat -S ts-postrouting 2>/dev/null)"; then
  read_any=1
  if grep -qE -- '^-A ts-postrouting( .*)? -j MASQUERADE( |$)' <<<"$out"; then
    echo "fail: tailscaled masquerades forwarded tailnet traffic (ts-postrouting MASQUERADE): the API sees the bridge gateway, not the client"
    rc=1
  else
    echo "ts-postrouting: no MASQUERADE (ok)"
  fi
else
  echo "note: no ts-postrouting chain to read (tailscaled in nftables mode?)"
fi

if command -v conntrack >/dev/null 2>&1; then
  for p in "$API" "$DASH"; do
    if ! lines="$(timeout 10 conntrack -L -p tcp -d "$TS_IP" --dport "$p" 2>/dev/null)"; then
      echo "note: conntrack could not be read for port $p"; continue
    fi
    read_any=1; n=0; bad=0; ex=""
    while IFS= read -r l; do
      mapfile -t s < <(grep -oE 'src=[0-9.]+' <<<"$l")
      mapfile -t d < <(grep -oE 'dst=[0-9.]+' <<<"$l")
      (( ${#s[@]} >= 2 && ${#d[@]} >= 2 )) || continue
      client="${s[0]#src=}"; back="${d[1]#dst=}"
      [[ "$client" =~ $TAILNET && "$client" != "$TS_IP" ]] || continue
      n=$((n+1))
      if [[ "$back" != "$client" ]]; then bad=$((bad+1)); [[ -n "$ex" ]] || ex=" (e.g. client $client, reply to $back)"; fi
    done <<<"$lines"
    if (( bad > 0 )); then
      echo "fail: port $p: $bad of $n inbound tailnet connection(s) have a rewritten source$ex"
      rc=1
    else
      echo "port $p: $n inbound tailnet connection(s), none with a rewritten source"
    fi
  done
else
  echo "note: conntrack not installed: only the masquerade rule is checked"
fi

(( read_any == 1 )) || { echo "skipped: neither the ts-postrouting chain nor conntrack could be read"; exit 3; }
exit "$rc"

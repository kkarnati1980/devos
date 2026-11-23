#!/usr/bin/env bash
# DevOS server check (S4-d, DEVOS-251; M1.2 depends on it): inbound tailnet connections to the DevOS API and
# dashboard keep the client's own address, so AccessGuard's `tailscale whois` sees the real peer and never the
# bridge gateway. Read-only. Exit 0 pass, 1 fail, 3 skipped (tailscale not installed).
# Two independent reads:
#   1. tailscaled's preference: `tailscale debug prefs` with NoSNAT false (subnet-route SNAT on) fails, and so do
#      unreadable prefs (tailnet-snat.sh turns it off every agent tick).
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

# Codex PR220-r13: only a host without tailscale is a skip; a lookup that fails or returns no tailnet IPv4 fails.
command -v tailscale >/dev/null 2>&1 || { echo "skipped: tailscale not installed"; exit 3; }
# Codex PR220-r14: the lookup's own exit status counts, not only its output.
ipout="$(timeout 10 tailscale ip -4 2>/dev/null)" || { echo "fail: tailscale ip -4 failed (lookup failed or tailscale is down)"; exit 1; }
TS_IP="$(head -n1 <<<"$ipout")"
[[ "$TS_IP" =~ $TAILNET ]] || { echo "fail: no tailnet IPv4 from tailscale ip -4 (lookup failed or tailscale is down)"; exit 1; }

rc=0; read_any=0; seen=0
# The preference, not a firewall rule: tailscaled runs in nftables mode on the DevOS server (DEVOS-89, 14:10 IST),
# where `iptables -S` does not show its chains; NoSNAT reads the same in both modes.
prefs="$(timeout 10 tailscale debug prefs 2>/dev/null)"; prc=$?
# Codex PR220-r4: exactly one JSON document, and jq's exit status counts.
nosnat=unknown
if (( prc == 0 )); then
  # S4-d decision 6: NoSNAT true on a host that advertises routes is a KK decision, never a pass ("router").
  # Codex PR220-r12: both fields must be present, the same rule as tailnet-snat.sh, so an unknown route state never passes.
  nosnat="$(jq -rs 'if length == 1 and (.[0] | type == "object" and has("NoSNAT") and (.NoSNAT | type) == "boolean"
      and has("AdvertiseRoutes") and (.AdvertiseRoutes == null or (.AdvertiseRoutes | type) == "array"))
    then (if .[0].NoSNAT and ((.[0].AdvertiseRoutes // []) | length) > 0 then "router" else .[0].NoSNAT end) else "unknown" end' <<<"$prefs" 2>/dev/null)" || nosnat=unknown
fi
case "$nosnat" in
  true) read_any=1; echo "tailscale prefs: NoSNAT true (ok)" ;;
  false) read_any=1; rc=1
    echo "fail: tailscaled's subnet-route SNAT is on (NoSNAT false): forwarded tailnet traffic reaches the API from the bridge gateway, not the client" ;;
  router) read_any=1; rc=1
    echo "fail: this host advertises routes with subnet-route SNAT off: a KK decision, not changed by DevOS" ;;
  *) rc=1; echo "fail: cannot read NoSNAT from tailscale prefs" ;;
esac

if command -v conntrack >/dev/null 2>&1; then
  for p in "$API" "$DASH"; do
    if ! lines="$(timeout 10 conntrack -L -p tcp -d "$TS_IP" --dport "$p" 2>/dev/null)"; then
      # Codex PR220-r3: the tool is there but did not answer: the independent read failed, so the check fails.
      echo "fail: conntrack could not be read for port $p"; rc=1; continue
    fi
    n=0; bad=0; ex=""
    while IFS= read -r l; do
      mapfile -t s < <(grep -oE 'src=[0-9.]+' <<<"$l")
      mapfile -t d < <(grep -oE 'dst=[0-9.]+' <<<"$l")
      (( ${#s[@]} >= 2 && ${#d[@]} >= 2 )) || continue
      client="${s[0]#src=}"; back="${d[1]#dst=}"
      [[ "$client" =~ $TAILNET && "$client" != "$TS_IP" ]] || continue
      n=$((n+1))
      if [[ "$back" != "$client" ]]; then bad=$((bad+1)); [[ -n "$ex" ]] || ex=" (e.g. client $client, reply to $back)"; fi
    done <<<"$lines"
    seen=$((seen+n))
    if (( bad > 0 )); then
      echo "fail: port $p: $bad of $n inbound tailnet connection(s) have a rewritten source$ex"
      rc=1
    else
      echo "port $p: $n inbound tailnet connection(s), none with a rewritten source"
    fi
  done
else
  echo "note: conntrack not installed: only the preference is checked"
fi

# Codex PR220-r1: a pass needs the preference read as NoSNAT true; conntrack alone (no tailnet client seen)
# never makes a pass.
(( seen > 0 )) && read_any=1
(( read_any == 1 || rc != 0 )) || { echo "skipped: nothing observed"; exit 3; }
exit "$rc"

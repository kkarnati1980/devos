#!/usr/bin/env bash
# DevOS — keep the tailnet client's own address on inbound traffic to the DevOS API and dashboard (S4-d, DEVOS-251)
# Version: 1.0.0
# Contract: docs/modules/S4.md "S4-d Tailnet peer kept". Run as root by the server agent every tick (allow-list,
# D1-passed SHA only). Takes no arguments and nothing from GitHub content.
#
# Why: tailscaled marks every packet that enters on tailscale0 and is forwarded (ts-forward, mark 0x40000) and,
# while its "SNAT subnet routes" setting is on (the default), masquerades marked packets in ts-postrouting.
# A connection to a port Docker publishes is DNATed to the container and so forwarded: it reaches the API with
# the bridge gateway as its source, AccessGuard's `tailscale whois` finds no user, and KK gets `not-kk`
# (DEVOS-89, 23 Nov 2026). This server advertises no subnet routes and is no exit node, so the setting does
# nothing useful here; turning it off removes only that masquerade rule.
#
# What it does: reads `iptables -t nat -S ts-postrouting`. No MASQUERADE rule there: nothing to do. One there:
# refuses if this host advertises routes (that is KK's call, not ours), else runs
# `tailscale set --snat-subnet-routes=false` (a tailscaled preference: it persists across restarts and reboots)
# and confirms the rule is gone. Idempotent. Never trusts any address or header; it only stops the rewrite.
# Exit 0 nothing to do or fixed (old connections cut), 1 failed (a cut still owed included), 3 skipped (no tailscale or iptables, or no ts-postrouting chain:
# tailscaled not running or in nftables mode; checks/api-tailnet-peer.sh still reads conntrack then).
# Prints no secret.
set -uo pipefail
command -v tailscale >/dev/null 2>&1 || { echo "skipped: tailscale not installed"; exit 3; }
command -v iptables >/dev/null 2>&1 || { echo "skipped: iptables not installed"; exit 3; }

masq() {  # 0 the SNAT rule is in ts-postrouting, 1 it is not, 2 the chain cannot be read
  local out
  out="$(timeout 10 iptables -w 5 -t nat -S ts-postrouting 2>/dev/null)" || return 2
  grep -qE -- '^-A ts-postrouting( .*)? -j MASQUERADE( |$)' <<<"$out" && return 0
  return 1
}

# Pre-review 1: a connection masqueraded before the fix keeps its NAT mapping (a long-lived stream would keep
# arriving from the gateway), so its conntrack entries on the API and dashboard ports are deleted once; the client
# reconnects with its own address. Needs conntrack-tools 1.4.6+ for the CIDR source. Codex PR220-r1: the cut is
# owed until it succeeds, so the marker $PENDING is written before `tailscale set` and removed only after every
# port's delete succeeded (no matching entry counts as success); the "ok" path retries a cut still owed.
PENDING="${DEVOS_DIR:-/root/.devos}/tailnet-snat.cut-pending"
cut_old() {  # 0 cut done (or nothing owed), 1 failed (marker kept, retried next tick)
  local conf="${DEVOS_DIR:-/root/.devos}/server-agent.conf" ts p api dash err rc bad=0
  [[ -e "$PENDING" ]] || return 0
  # No conntrack tool: nothing can cut them (M0.1 may not have installed it yet); they end when they close.
  if ! command -v conntrack >/dev/null 2>&1; then
    rm -f "$PENDING"; echo "note: conntrack not installed: old masqueraded connections end when they close"; return 0
  fi
  ts="$(timeout 10 tailscale ip -4 2>/dev/null | head -n1)"
  [[ "$ts" =~ ^100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || { echo "fail: no tailnet IPv4: old masqueraded connections not cut"; return 1; }
  api="$(sed -n 's/^API_PORT=\([0-9]\{2,5\}\)$/\1/p' "$conf" 2>/dev/null | head -n1)"
  dash="$(sed -n 's/^DASHBOARD_PORT=\([0-9]\{2,5\}\)$/\1/p' "$conf" 2>/dev/null | head -n1)"
  for p in "${api:-3001}" "${dash:-3000}"; do
    # Codex PR220-r2: --src-nat deletes only flows that were source-NATed, so a retry never touches a healthy
    # flow that reconnected with the client's own address.
    err="$(timeout 10 conntrack -D -p tcp -s 100.64.0.0/10 -d "$ts" --dport "$p" --src-nat 2>&1 >/dev/null)"; rc=$?
    (( rc == 0 )) && continue
    grep -q ' 0 flow entries have been deleted' <<<"$err" && continue   # nothing matched: nothing to cut
    echo "fail: cutting old connections on port $p failed (conntrack exit $rc); retried next tick"; bad=1
  done
  (( bad == 0 )) || return 1
  rm -f "$PENDING" || { echo "fail: cannot remove $PENDING"; return 1; }
  echo "old masqueraded connections on ports ${api:-3001} and ${dash:-3000} cut (clients reconnect)"
}

masq; rc=$?
case "$rc" in
  1) echo "ok: tailscaled does not masquerade forwarded tailnet traffic"; cut_old || exit 1; exit 0 ;;
  2) echo "skipped: no ts-postrouting chain (tailscaled not running, or in nftables mode)"; exit 3 ;;
esac

# A subnet router or exit node needs the setting; changing it there is a KK decision, so only report.
prefs="$(timeout 10 tailscale debug prefs 2>/dev/null)" || { echo "fail: cannot read tailscale prefs; not changed"; exit 1; }
# Codex PR220-r1: the field must be present and null or a list; anything else is "cannot tell", never "no routes".
routes="$(jq -r 'if type == "object" and has("AdvertiseRoutes") and (.AdvertiseRoutes == null or (.AdvertiseRoutes | type) == "array")
  then (.AdvertiseRoutes // [] | length) else "unknown" end' <<<"$prefs" 2>/dev/null)"
[[ "$routes" =~ ^[0-9]+$ ]] || { echo "fail: cannot read AdvertiseRoutes from tailscale prefs; not changed"; exit 1; }
if (( routes > 0 )); then
  echo "fail: this host advertises $routes route(s) (subnet router or exit node); subnet-route SNAT left on (KK decision)"
  exit 1
fi

: > "$PENDING" || { echo "fail: cannot write $PENDING; not changed"; exit 1; }
timeout 20 tailscale set --snat-subnet-routes=false >/dev/null 2>&1 \
  || { echo "fail: tailscale set --snat-subnet-routes=false did not succeed"; exit 1; }
for _ in 1 2 3 4 5; do
  masq; rc=$?
  if (( rc == 1 )); then
    echo "fixed: subnet-route SNAT turned off; the API now sees the tailnet client's own address"
    cut_old || exit 1; exit 0
  fi
  sleep 1
done
echo "fail: the ts-postrouting MASQUERADE rule is still there after tailscale set"
exit 1

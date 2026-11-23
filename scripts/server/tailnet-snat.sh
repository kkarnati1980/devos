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
# Exit 0 nothing to do or fixed, 1 failed, 3 skipped (no tailscale or iptables, or no ts-postrouting chain:
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

masq; rc=$?
case "$rc" in
  1) echo "ok: tailscaled does not masquerade forwarded tailnet traffic"; exit 0 ;;
  2) echo "skipped: no ts-postrouting chain (tailscaled not running, or in nftables mode)"; exit 3 ;;
esac

# A subnet router or exit node needs the setting; changing it there is a KK decision, so only report.
prefs="$(timeout 10 tailscale debug prefs 2>/dev/null)" || { echo "fail: cannot read tailscale prefs; not changed"; exit 1; }
routes="$(jq -r '(.AdvertiseRoutes // []) | length' <<<"$prefs" 2>/dev/null)"
[[ "$routes" =~ ^[0-9]+$ ]] || { echo "fail: cannot read AdvertiseRoutes from tailscale prefs; not changed"; exit 1; }
if (( routes > 0 )); then
  echo "fail: this host advertises $routes route(s) (subnet router or exit node); subnet-route SNAT left on (KK decision)"
  exit 1
fi

timeout 20 tailscale set --snat-subnet-routes=false >/dev/null 2>&1 \
  || { echo "fail: tailscale set --snat-subnet-routes=false did not succeed"; exit 1; }
for _ in 1 2 3 4 5; do
  masq; rc=$?
  (( rc == 1 )) && { echo "fixed: subnet-route SNAT turned off; the API now sees the tailnet client's own address"; exit 0; }
  sleep 1
done
echo "fail: the ts-postrouting MASQUERADE rule is still there after tailscale set"
exit 1

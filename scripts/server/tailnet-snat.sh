#!/usr/bin/env bash
# DevOS — keep the tailnet client's own address on inbound traffic to the DevOS API and dashboard (S4-d, DEVOS-251)
# Version: 1.0.0
# Contract: docs/modules/S4.md "S4-d Tailnet peer kept"; decision note docs/decisions/0036-tailnet-snat-off.md.
# Run as root by the server agent every tick (allow-list, D1-passed SHA only). Takes no arguments and nothing from
# GitHub content.
#
# Why: tailscaled marks every packet that enters on tailscale0 and is forwarded (ts-forward, mark 0x40000) and,
# while its "SNAT subnet routes" preference is on (the default), masquerades marked packets in ts-postrouting.
# A connection to a port Docker publishes is DNATed to the container and so forwarded: it reaches the API with
# the bridge gateway as its source, AccessGuard's `tailscale whois` finds no user, and KK gets `not-kk`
# (DEVOS-89, 23 Nov 2026). This server advertises no subnet routes and is no exit node, so the preference does
# nothing useful here; turning it off removes only that masquerade.
#
# What it does: reads the preference from `tailscale debug prefs` (field NoSNAT; the same in iptables and
# nftables firewall modes: the DevOS server runs tailscaled in nftables mode, DEVOS-89 14:10 IST). NoSNAT true:
# nothing to change. NoSNAT false: refuses if this host advertises routes (KK's call, not ours), else runs
# `tailscale set --snat-subnet-routes=false` (persists across restarts and reboots), confirms NoSNAT is now true,
# and cuts the flows that were source-NATed before the fix once (see cut_old). Idempotent. Never trusts any
# address or header; it only stops the rewrite.
# Exit 0 nothing to do or fixed (old flows cut), 1 failed (a cut still owed included), 3 skipped (no tailscale).
# Prints no secret.
set -uo pipefail
command -v tailscale >/dev/null 2>&1 || { echo "skipped: tailscale not installed"; exit 3; }

# Codex PR220-r1: each field must be present with its type; anything else is "cannot tell", never "fine".
read_prefs() {  # sets NOSNAT (true|false) and ROUTES (count); 1 when the prefs cannot be read
  local prefs out
  prefs="$(timeout 10 tailscale debug prefs 2>/dev/null)" || { echo "fail: cannot read tailscale prefs; not changed"; return 1; }
  # Codex PR220-r4: exactly one JSON document (slurped, so trailing text is a parse error) and jq's exit status
  # counts; output from a jq that failed is never used.
  out="$(jq -rs 'if length == 1 and (.[0] | type == "object" and has("NoSNAT") and (.NoSNAT | type) == "boolean"
      and has("AdvertiseRoutes") and (.AdvertiseRoutes == null or (.AdvertiseRoutes | type) == "array"))
    then "\(.[0].NoSNAT) \(.[0].AdvertiseRoutes // [] | length)" else "unknown" end' <<<"$prefs" 2>/dev/null)" || out=""
  [[ "$out" =~ ^(true|false)\ ([0-9]+)$ ]] || { echo "fail: cannot read NoSNAT and AdvertiseRoutes from tailscale prefs; not changed"; return 1; }
  NOSNAT="${BASH_REMATCH[1]}"; ROUTES="${BASH_REMATCH[2]}"
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
  # Codex PR220-r6: ROUTES is from the latest prefs read; a host that advertises routes by then is never cut.
  if (( ${ROUTES:-1} > 0 )); then
    echo "note: this host now advertises ${ROUTES:-?} route(s): no connection is cut (KK decision)"; return 0
  fi
  # No conntrack tool: nothing can cut them (M0.1 may not have installed it yet); they end when they close.
  if ! command -v conntrack >/dev/null 2>&1; then
    rm -f "$PENDING" || { echo "fail: cannot remove $PENDING"; return 1; }   # Codex PR220-r7 (low)
    echo "note: conntrack not installed: old masqueraded connections end when they close"; return 0
  fi
  ts="$(timeout 10 tailscale ip -4 2>/dev/null)" || { echo "fail: tailscale ip -4 failed: old masqueraded connections not cut"; return 1; }
  ts="$(head -n1 <<<"$ts")"
  [[ "$ts" =~ ^100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || { echo "fail: no tailnet IPv4: old masqueraded connections not cut"; return 1; }
  api="$(sed -n 's/^API_PORT=\([0-9]\{2,5\}\)$/\1/p' "$conf" 2>/dev/null | head -n1)"
  dash="$(sed -n 's/^DASHBOARD_PORT=\([0-9]\{2,5\}\)$/\1/p' "$conf" 2>/dev/null | head -n1)"
  for p in "${api:-3001}" "${dash:-3000}"; do
    # Codex PR220-r13: the routes are read again right before each delete; a host that advertises routes by then
    # is not cut and the run fails (decision 6). Only the sub-second gap to the delete itself remains (the same
    # race decision 6 accepts and reports).
    read_prefs >/dev/null || { echo "fail: cannot read tailscale prefs before cutting port $p; retried next tick"; return 1; }
    if (( ROUTES > 0 )); then
      echo "fail: this host started advertising $ROUTES route(s); no further connection is cut (KK decision)"; return 1
    fi
    # Codex PR220-r14: SNAT back on (NoSNAT false) means a cut now would only be redone; stop and keep it owed.
    [[ "$NOSNAT" == true ]] || { echo "fail: subnet-route SNAT is on again; no connection is cut, retried next tick"; return 1; }
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

# Deadlock narrowing (S4-d decision 6, after Codex PR220-r7..r11): tailscale has no compare-and-set, so routes that
# appear while this script changes the preference cannot be ruled out, and any automatic undo either reverses a KK
# setting or misses our own change under an uncertain outcome. So nothing is ever undone automatically. Instead a
# host that advertises routes with NoSNAT true is never touched and always FAILS (here and in api-tailnet-peer.sh),
# so the state is red and visible until KK decides; it is never reported as success.
read_prefs || exit 1
if (( ROUTES > 0 )); then
  if [[ "$NOSNAT" == true ]]; then
    echo "fail: this host advertises $ROUTES route(s) with subnet-route SNAT off; left as it is, nothing cut (KK decision)"
  else
    echo "fail: this host advertises $ROUTES route(s) (subnet router or exit node); subnet-route SNAT left on (KK decision)"
  fi
  exit 1
fi
if [[ "$NOSNAT" == true ]]; then
  echo "ok: subnet-route SNAT is off (NoSNAT true)"; cut_old || exit 1; exit 0
fi

: > "$PENDING" || { echo "fail: cannot write $PENDING; not changed"; exit 1; }
timeout 20 tailscale set --snat-subnet-routes=false >/dev/null 2>&1 \
  || { echo "fail: tailscale set --snat-subnet-routes=false did not succeed"; exit 1; }
read_prefs || exit 1
# Routes that appeared during the change: never cut, never undone; fail so the state is red until KK decides.
if (( ROUTES > 0 )); then
  echo "fail: this host started advertising $ROUTES route(s) during the change; left as it is, nothing cut (KK decision)"
  exit 1
fi
[[ "$NOSNAT" == true ]] || { echo "fail: NoSNAT is still false after tailscale set"; exit 1; }
echo "fixed: subnet-route SNAT turned off; the API now sees the tailnet client's own address"
cut_old || exit 1
exit 0

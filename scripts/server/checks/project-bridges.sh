#!/usr/bin/env bash
# DevOS server check (DEVOS-128, docs/modules/S4.md "S4-c bridge-name check"): every project network in the S4
# pool (10.208.0.0/14, one /24 per stack index) sits on a Linux bridge named devos-p<idx>, the name S4's compose
# rewrite gives it. The IPv6 drop (`-i devos-p+`, S4-b2c) and the pool rules rely on that name, so a pool network
# on any other interface would be outside the IPv6 defence in depth.
# Reads only the kernel's IPv4 routes (`ip -4 -o route show`); changes nothing. Exit 0 pass, 1 fail, 3 skipped
# (no `ip` command, or isolation not set up yet: no installed block). Prints one line; never a secret.
set -uo pipefail
DIR="${DEVOS_DIR:-/root/.devos}"
command -v ip >/dev/null 2>&1 || { echo "skipped: no ip command"; exit 3; }
[[ -f "$DIR/isolation/installed.rules" ]] || { echo "skipped: the isolation block is not installed yet"; exit 3; }
routes="$(timeout 10 ip -4 -o route show 2>/dev/null)" || { echo "fail: cannot read the IPv4 routes"; exit 1; }

n=0 bad=()
POOL=$(( (10 << 24) | (208 << 16) ))
while read -r dst rest; do
  dev=""
  [[ " $rest " =~ \ dev\ ([^ ]+)\  ]] && dev="${BASH_REMATCH[1]}"
  [[ "$dev" =~ ^[A-Za-z0-9._@-]{1,32}$ ]] || dev="?"
  # A route wider than the pool (/0-/13) whose network contains it: its hosts can hold pool addresses off devos-p+.
  if [[ "$dst" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/([0-9]{1,2})$ ]] && (( BASH_REMATCH[5] < 14 )); then
    w=$(( (BASH_REMATCH[1] << 24) | (BASH_REMATCH[2] << 16) | (BASH_REMATCH[3] << 8) | BASH_REMATCH[4] ))
    m=$(( BASH_REMATCH[5] == 0 ? 0 : (0xFFFFFFFF << (32 - BASH_REMATCH[5])) & 0xFFFFFFFF ))
    (( (w & m) == (POOL & m) )) && bad+=("$dst on $dev (contains the pool)")
    continue
  fi
  # Only the pool: 10.208.0.0 - 10.211.255.255. A /24 is one stack; any other prefix length in the pool is wrong.
  [[ "$dst" =~ ^10\.(20[89]|21[01])\.([0-9]{1,3})\.([0-9]{1,3})(/([0-9]{1,2}))?$ ]] || continue
  a="${BASH_REMATCH[1]}" b="${BASH_REMATCH[2]}" c="${BASH_REMATCH[3]}" len="${BASH_REMATCH[5]:-32}"
  if [[ "$len" != 24 || "$c" != 0 ]] || (( b > 255 )); then
    bad+=("$dst on $dev (not a stack /24)"); continue
  fi
  idx=$(( (a - 208) * 256 + b ))
  n=$(( n + 1 ))
  [[ "$dev" == "devos-p$idx" ]] || bad+=("$dst on $dev (expected devos-p$idx)")
done <<<"$routes"

if (( ${#bad[@]} )); then
  echo "fail: ${#bad[@]} pool route(s) not on their devos-p bridge: ${bad[*]:0:5}"
  exit 1
fi
echo "ok: $n project network(s), each on its devos-p<idx> bridge"
exit 0

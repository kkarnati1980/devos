#!/usr/bin/env bash
# DevOS — host firewall block for project network isolation, F3-1 (S4-b, DEVOS-65)
# Version: 1.0.0
# Contract: docs/modules/S4.md (decisions 1-5, S4-b). Run as root by the server agent (allow-list, D1-passed
# SHA only) or by KK for --remove. Never run with arguments taken from GitHub content.
#
#   isolation-apply.sh            fetch the approved state, apply the block if it changed, self-test, roll back
#   isolation-apply.sh --dry-run  fetch the state and print the generated block; changes nothing
#   isolation-apply.sh --remove   delete the S4 jumps and chains; M0.1/M0.2 rules stay as they are
#
# The block is two chains, DEVOS-ISO-FWD (jumped to first from DOCKER-USER) and DEVOS-ISO-IN (jumped to first
# from INPUT), for sources in the project pool 10.208.0.0/14 (one /24 per stack, from the stack index):
#   FWD: replies pass; same /24 passes; declared tailnet CIDRs pass; every other pool, private, tailnet,
#        link-local (cloud metadata) or multicast destination drops; internet passes only for stacks with
#        egress declared; the rest drops.
#   IN:  replies pass; DNS (53) to the stack gateway is accepted; everything else to the host drops (SSH,
#        Coolify 8000/6001/6002, the DevOS API and dashboard).
# State: GET $ISOLATION_STATE_URL (default http://127.0.0.1:$API_INTERNAL_PORT/internal/isolation-state, port
# 3002) with the token in $DEVOS_DIR/secrets/isolation_state_token (sent as a header from a file, never on argv).
# The whole document is refused on any invalid entry; then nothing changes.
# Apply: one `iptables-restore --noflush` of the generated block (atomic per table), then the two jumps are
# put first. The installed block is kept in $DEVOS_DIR/isolation/installed.rules; an unchanged block with
# both jumps in place makes no write. After a change the host self-test (SSH on the tailnet IP, Coolify,
# DevOS API) must pass, else the previous block is restored (or the block removed if there was none).
# Exit 0 applied or unchanged, 1 failed (previous block kept or restored), 3 skipped (not set up yet).
# Prints no token and no secret.
set -uo pipefail
DIR="${DEVOS_DIR:-/root/.devos}"
ISO="$DIR/isolation"
CONF="$DIR/server-agent.conf"
TOKEN_FILE="$DIR/secrets/isolation_state_token"
POOL="10.208.0.0/14"
FWD=DEVOS-ISO-FWD
IN=DEVOS-ISO-IN
conf() { sed -n "s/^$1=\\([A-Za-z0-9._:\\/ -]\\{1,300\\}\\)\$/\\1/p" "$CONF" 2>/dev/null | head -n1; }

MODE=apply
case "${1:-}" in
  "") ;;
  --dry-run) MODE=dry ;;
  --remove) MODE=remove ;;
  *) echo "usage: $0 [--dry-run|--remove]"; exit 2 ;;
esac
[[ $# -le 1 ]] || { echo "usage: $0 [--dry-run|--remove]"; exit 2; }

ipt() { timeout 20 iptables -w 10 "$@"; }

remove_block() {  # deletes every jump to the S4 chains, then the chains; 0 if nothing of S4 is left
  local c rc=0
  for c in DOCKER-USER:$FWD INPUT:$IN; do
    while ipt -C "${c%%:*}" -j "${c#*:}" 2>/dev/null; do ipt -D "${c%%:*}" -j "${c#*:}" || { rc=1; break; }; done
  done
  for c in $FWD $IN; do
    if ipt -S "$c" >/dev/null 2>&1; then ipt -F "$c" && ipt -X "$c" || rc=1; fi
  done
  return $rc
}

if [[ "$MODE" == remove ]]; then
  command -v iptables >/dev/null 2>&1 || { echo "iptables not installed: nothing to remove"; exit 0; }
  if remove_block; then rm -f "$ISO/installed.rules"; echo "removed: S4 isolation jumps and chains (M0.1/M0.2 rules untouched)"; exit 0; fi
  echo "remove failed: some S4 rules are still in place (see iptables -S DOCKER-USER / INPUT)"; exit 1
fi

for c in jq curl iptables iptables-restore; do
  command -v "$c" >/dev/null 2>&1 || { echo "skipped: $c not installed"; exit 3; }
done
[[ -s "$TOKEN_FILE" ]] || { echo "skipped: no isolation state token yet ($TOKEN_FILE)"; exit 3; }

# --- 1. fetch and validate the approved state -------------------------------------------------------------
PORT="$(conf API_INTERNAL_PORT)"; PORT="${PORT:-3002}"
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || { echo "bad API_INTERNAL_PORT in $CONF"; exit 1; }
URL="$(conf ISOLATION_STATE_URL)"; URL="${URL:-http://127.0.0.1:$PORT/internal/isolation-state}"
[[ "$URL" =~ ^http://(127\.0\.0\.1|\[::1\]|localhost):[0-9]{1,5}/[A-Za-z0-9/_-]*$ ]] \
  || { echo "refused: ISOLATION_STATE_URL must be a loopback http URL"; exit 1; }
tok="$(head -c 512 "$TOKEN_FILE" | tr -d '\r\n')"
[[ "$tok" =~ ^[A-Za-z0-9._~+/=-]{16,512}$ ]] || { echo "refused: the isolation state token file is malformed"; exit 1; }
state="$(curl -sS --fail --connect-timeout 5 --max-time 15 --max-filesize 1048576 --proto =http \
  -H @<(printf 'Authorization: Bearer %s\n' "$tok") "$URL" 2>/dev/null)"; crc=$?
unset tok
(( crc == 0 )) || { echo "state fetch failed (curl exit $crc): nothing changed"; exit 1; }

# Structure: {"stacks":[{"slug","env","idx","egress","tailnet":[...]}, ...]} and nothing else.
rows="$(jq -r '
  if (type == "object") and (keys == ["stacks"]) and (.stacks | type == "array") then
    .stacks[] | if (type == "object") and (keys == ["egress","env","idx","slug","tailnet"])
      and (.slug | type == "string") and (.env | type == "string") and (.idx | type == "number")
      and (.egress | type == "boolean") and (.tailnet | type == "array") and all(.tailnet[]; type == "string")
    then "\(.idx)\t\(.slug)\t\(.env)\t\(.egress)\t\(.tailnet | join(","))" else "BAD" end
  else "BAD" end' <<<"$state" 2>/dev/null)" || rows=BAD
[[ "$rows" != *BAD* ]] || { echo "refused: the isolation state is not valid JSON of the documented shape; nothing changed"; exit 1; }

v4_in_tailnet() {  # a.b.c.d/p -> 0 if it is a well-formed IPv4 CIDR inside 100.64.0.0/10
  [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/([0-9]{1,2})$ ]] || return 1
  local a=${BASH_REMATCH[1]} b=${BASH_REMATCH[2]} c=${BASH_REMATCH[3]} d=${BASH_REMATCH[4]} p=${BASH_REMATCH[5]} o
  for o in "$a" "$b" "$c" "$d"; do [[ "$o" =~ ^(0|[1-9][0-9]*)$ ]] && (( o <= 255 )) || return 1; done
  [[ "$p" =~ ^(0|[1-9][0-9]?)$ ]] && (( p >= 10 && p <= 32 )) || return 1
  (( a == 100 && b >= 64 && b <= 127 ))
}
v6_in_tailnet() {  # fd7a:115c:a1e0:... /p -> 0 if inside fd7a:115c:a1e0::/48 (lexical check, no ip6tables rule in v1)
  [[ "$1" =~ ^[fF][dD]7[aA]:115[cC]:[aA]1[eE]0(:[0-9a-fA-F]{0,4}){1,5}/([0-9]{2,3})$ ]] || return 1
  local p=${BASH_REMATCH[2]}; (( 10#$p >= 48 && 10#$p <= 128 ))
}

declare -A seen_idx=() seen_stack=()
STACKS=()
while IFS=$'\t' read -r idx slug env egress tailnet; do
  [[ -n "$idx$slug" ]] || continue
  [[ "$idx" =~ ^(0|[1-9][0-9]{0,2})$ ]] && (( idx <= 1023 )) || { echo "refused: stack index '$idx' outside 0-1023; nothing changed"; exit 1; }
  [[ "$slug" =~ ^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$ ]] || { echo "refused: invalid project slug in the isolation state; nothing changed"; exit 1; }
  [[ "$env" == preview || "$env" == live ]] || { echo "refused: invalid environment for $slug; nothing changed"; exit 1; }
  [[ -z "${seen_idx[$idx]:-}" ]] || { echo "refused: stack index $idx used twice; nothing changed"; exit 1; }
  [[ -z "${seen_stack[$slug/$env]:-}" ]] || { echo "refused: $slug/$env listed twice; nothing changed"; exit 1; }
  seen_idx[$idx]=1; seen_stack[$slug/$env]=1
  v4=""
  if [[ -n "$tailnet" ]]; then
    IFS=, read -r -a cidrs <<<"$tailnet"
    for c in "${cidrs[@]}"; do
      if v4_in_tailnet "$c"; then v4+="$c "
      elif ! v6_in_tailnet "$c"; then echo "refused: tailnet entry for $slug/$env is not inside 100.64.0.0/10 or fd7a:115c:a1e0::/48; nothing changed"; exit 1
      fi
    done
  fi
  STACKS+=("$idx $slug $env $egress ${v4% }")
done <<<"$rows"

# --- 2. generate the block (stable order: by index) --------------------------------------------------------
subnet() { echo "10.$(( 208 + $1 / 256 )).$(( $1 % 256 )).0/24"; }
gateway() { echo "10.$(( 208 + $1 / 256 )).$(( $1 % 256 )).1"; }
generate() {
  local line idx slug env egress rest c
  local -a sorted
  mapfile -t sorted < <(printf '%s\n' "${STACKS[@]}" | sed '/^$/d' | sort -n -k1,1)
  echo "*filter"
  echo ":$FWD - [0:0]"
  echo ":$IN - [0:0]"
  echo "-A $FWD ! -s $POOL -j RETURN"
  echo "-A $FWD -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN"
  for line in "${sorted[@]}"; do
    read -r idx slug env egress rest <<<"$line"
    echo "-A $FWD -s $(subnet "$idx") -d $(subnet "$idx") -m comment --comment \"$slug/$env\" -j RETURN"
    for c in $rest; do echo "-A $FWD -s $(subnet "$idx") -d $c -m comment --comment \"$slug/$env tailnet\" -j RETURN"; done
  done
  for c in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8 0.0.0.0/8 224.0.0.0/4 240.0.0.0/4; do
    echo "-A $FWD -d $c -j DROP"
  done
  for line in "${sorted[@]}"; do
    read -r idx slug env egress rest <<<"$line"
    [[ "$egress" == true ]] && echo "-A $FWD -s $(subnet "$idx") -m comment --comment \"$slug/$env egress\" -j RETURN"
  done
  echo "-A $FWD -j DROP"
  echo "-A $IN ! -s $POOL -j RETURN"
  echo "-A $IN -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN"
  for line in "${sorted[@]}"; do
    read -r idx slug env egress rest <<<"$line"
    echo "-A $IN -s $(subnet "$idx") -d $(gateway "$idx") -p udp --dport 53 -j ACCEPT"
    echo "-A $IN -s $(subnet "$idx") -d $(gateway "$idx") -p tcp --dport 53 -j ACCEPT"
  done
  echo "-A $IN -j DROP"
  echo "COMMIT"
}
BLOCK="$(generate)"

if [[ "$MODE" == dry ]]; then printf '%s\n' "$BLOCK"; echo "# dry run: nothing changed (${#STACKS[@]} stacks)"; exit 0; fi

# --- 3. apply when changed ---------------------------------------------------------------------------------
jumps_first() {  # 0 when both jumps are the first rule of their built-in chain
  [[ "$(ipt -S DOCKER-USER 2>/dev/null | sed -n 2p)" == "-A DOCKER-USER -j $FWD" ]] \
    && [[ "$(ipt -S INPUT 2>/dev/null | grep -v '^-P' | sed -n 1p)" == "-A INPUT -j $IN" ]]
}
put_jumps() {  # removes any extra jump, then inserts each at position 1
  local c
  ipt -S DOCKER-USER >/dev/null 2>&1 || { echo "DOCKER-USER chain missing (M0.1 not applied?)"; return 1; }
  for c in DOCKER-USER:$FWD INPUT:$IN; do
    while ipt -C "${c%%:*}" -j "${c#*:}" 2>/dev/null; do ipt -D "${c%%:*}" -j "${c#*:}" || return 1; done
    ipt -I "${c%%:*}" 1 -j "${c#*:}" || return 1
  done
}
install_block() {  # block text on stdin -> live
  timeout 20 iptables-restore -w 10 --noflush || return 1
  put_jumps
}
selftest() {  # every target host:port must accept a TCP connection within 3 s
  local t targets ts_ip api
  targets="$(conf ISOLATION_SELFTEST_TARGETS)"
  if [[ -z "$targets" ]]; then
    ts_ip="$(timeout 5 tailscale ip -4 2>/dev/null | head -n1)"
    api="$(conf API_PORT)"; api="${api:-3001}"
    targets="127.0.0.1:8000"
    [[ "$ts_ip" =~ ^100\.[0-9.]+$ ]] && targets+=" $ts_ip:22 $ts_ip:$api"
  fi
  for t in $targets; do
    [[ "$t" =~ ^([0-9.]+):([0-9]{1,5})$ ]] || { echo "self-test: bad target '$t'"; return 1; }
    timeout 3 bash -c "exec 3<>/dev/tcp/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}" 2>/dev/null \
      || { echo "self-test: $t did not answer"; return 1; }
  done
}

mkdir -p "$ISO" && chmod 700 "$ISO" || { echo "cannot create $ISO"; exit 1; }
PREV=""; [[ -s "$ISO/installed.rules" ]] && PREV="$(cat "$ISO/installed.rules")"
if [[ "$BLOCK" == "$PREV" ]] && jumps_first; then echo "unchanged: ${#STACKS[@]} stacks, block already in place"; exit 0; fi

if ! printf '%s\n' "$BLOCK" | install_block; then
  echo "apply failed: restoring the previous block"
  if [[ -n "$PREV" ]]; then printf '%s\n' "$PREV" | install_block || echo "restore failed too: run $0 --remove from the console"
  else remove_block || true; fi
  exit 1
fi
if ! selftest; then
  echo "self-test failed after apply: rolling back"
  if [[ -n "$PREV" ]]; then
    printf '%s\n' "$PREV" | install_block && echo "rolled back to the previous block" || echo "rollback failed: run $0 --remove from the console"
  else
    remove_block && echo "rolled back: S4 block removed" || echo "rollback failed: run $0 --remove from the console"
  fi
  exit 1
fi
printf '%s\n' "$BLOCK" > "$ISO/installed.rules.tmp" && mv -f "$ISO/installed.rules.tmp" "$ISO/installed.rules" \
  || { echo "applied, but could not record $ISO/installed.rules"; exit 1; }
echo "applied: ${#STACKS[@]} stacks, self-test passed"

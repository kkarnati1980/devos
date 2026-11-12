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
# The block is two chains, DEVOS-ISO-FWD (jumped to first from DOCKER-USER and from FORWARD, so tailscaled's
# own `ts-forward` jump at FORWARD 1 cannot accept tailnet-bound pool traffic before it) and DEVOS-ISO-IN (jumped to first
# from INPUT), for sources in the project pool 10.208.0.0/14 (one /24 per stack, from the stack index):
#   FWD: replies pass; same /24 passes; declared tailnet CIDRs pass; every other pool, private, tailnet,
#        link-local (cloud metadata) or multicast destination drops; internet passes only for stacks with
#        egress declared; the rest drops.
#   IN:  replies pass; DNS (53) to the stack gateway is accepted; everything else to the host drops (SSH,
#        Coolify 8000/6001/6002, the DevOS API and dashboard).
# State: GET $ISOLATION_STATE_URL (default http://127.0.0.1:$API_INTERNAL_PORT/internal/isolation-state, port
# 3002) with the token in $DEVOS_DIR/secrets/isolation_state_token (sent as a header from a file, never on argv).
# The whole document is refused on any invalid entry; then nothing changes.
# Apply: one `iptables-restore --noflush` transaction rebuilds both chains and puts each jump first, exactly
# once (atomic per table; no moment without the jump). The installed block is kept in
# $DEVOS_DIR/isolation/installed.rules; "unchanged" (no write) needs the same block, both jumps already first
# and the live chains holding the block's rule count. The host self-test (SSH on the tailnet IP, Coolify,
# DevOS API) runs before and after: if it passed before and fails after, the previous block is restored (or
# the block removed if there was none); if it already failed before, the block is kept and the failure
# reported. One run at a time ($DEVOS_DIR/isolation/.lock). Worst case stays under the agent's 60 s timeout.
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

ipt() { timeout 10 iptables -w 5 "$@"; }

remove_block() {  # deletes every jump to the S4 chains, then the chains; 0 if nothing of S4 is left
  local c rc=0
  for c in DOCKER-USER:$FWD FORWARD:$FWD INPUT:$IN; do
    while ipt -C "${c%%:*}" -j "${c#*:}" 2>/dev/null; do ipt -D "${c%%:*}" -j "${c#*:}" || { rc=1; break; }; done
  done
  for c in $FWD $IN; do
    if ipt -S "$c" >/dev/null 2>&1; then ipt -F "$c" && ipt -X "$c" || rc=1; fi
  done
  return $rc
}

if [[ "$MODE" == remove ]]; then
  command -v iptables >/dev/null 2>&1 || { echo "iptables not installed: nothing to remove"; exit 0; }
  mkdir -p "$ISO" && exec 9>"$ISO/.lock" && flock -w 60 9 || { echo "remove: could not take $ISO/.lock within 60 s"; exit 1; }
  if remove_block; then rm -f "$ISO/installed.rules" "$ISO/live.sha256"; echo "removed: S4 isolation jumps and chains (M0.1/M0.2 rules untouched)"; exit 0; fi
  echo "remove failed: some S4 rules are still in place (see iptables -S DOCKER-USER / INPUT)"; exit 1
fi

for c in jq curl flock iptables iptables-restore; do
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
state="$(curl -sS --fail --connect-timeout 3 --max-time 10 --max-filesize 1048576 --proto =http \
  -H @<(printf 'Authorization: Bearer %s\n' "$tok") "$URL" 2>/dev/null)"; crc=$?
unset tok
(( crc == 0 )) || { echo "state fetch failed (curl exit $crc): nothing changed"; exit 1; }

# Structure: exactly one JSON document {"stacks":[{"slug","env","idx","egress","tailnet":[...]}, ...]} and
# nothing else. Every string is checked against its pattern inside jq BEFORE it is turned into a line, so no
# value can carry a tab, newline or comma into the row stream (Codex pre-review: a newline in a tailnet string
# forged an extra stack). Rows are emitted with @tsv; the tailnet list is space-joined after each entry
# matched ^[0-9a-fA-F.:/]{1,49}$.
rows="$(jq -r -s '
  if length != 1 then "BAD" else .[0] |
  if (type == "object") and (keys == ["stacks"]) and (.stacks | type == "array") then
    .stacks[] | if (type == "object") and (keys == ["egress","env","idx","slug","tailnet"])
      and (.slug | type == "string" and test("^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$"))
      and (.env | type == "string" and (. == "preview" or . == "live"))
      and (.idx | type == "number" and . == floor and . >= 0 and . <= 1023)
      and (.egress | type == "boolean") and (.tailnet | type == "array" and length <= 64)
      and all(.tailnet[]; type == "string" and test("^[0-9a-fA-F.:/]{1,49}$"))
    then [(.idx | tostring), .slug, .env, (.egress | tostring), (.tailnet | join(" "))] | @tsv else "BAD" end
  else "BAD" end end' <<<"$state" 2>/dev/null)" || rows=BAD
[[ "$rows" != *BAD* ]] || { echo "refused: the isolation state is not one valid JSON document of the documented shape; nothing changed"; exit 1; }

v4_in_tailnet() {  # a.b.c.d/p -> 0 if it is a well-formed IPv4 CIDR inside 100.64.0.0/10
  [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/([0-9]{1,2})$ ]] || return 1
  local a=${BASH_REMATCH[1]} b=${BASH_REMATCH[2]} c=${BASH_REMATCH[3]} d=${BASH_REMATCH[4]} p=${BASH_REMATCH[5]} o
  for o in "$a" "$b" "$c" "$d"; do [[ "$o" =~ ^(0|[1-9][0-9]*)$ ]] && (( o <= 255 )) || return 1; done
  [[ "$p" =~ ^(0|[1-9][0-9]?)$ ]] && (( p >= 10 && p <= 32 )) || return 1
  (( a == 100 && b >= 64 && b <= 127 ))
}

declare -A seen_idx=() seen_stack=()
STACKS=()
while IFS=$'\t' read -r idx slug env egress tailnet; do
  [[ -n "$idx$slug" ]] || continue
  [[ "$idx" =~ ^(0|[1-9][0-9]{0,3})$ ]] && (( idx <= 1023 )) || { echo "refused: stack index '$idx' outside 0-1023; nothing changed"; exit 1; }
  [[ "$slug" =~ ^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$ ]] || { echo "refused: invalid project slug in the isolation state; nothing changed"; exit 1; }
  [[ "$env" == preview || "$env" == live ]] || { echo "refused: invalid environment for $slug; nothing changed"; exit 1; }
  [[ -z "${seen_idx[$idx]:-}" ]] || { echo "refused: stack index $idx used twice; nothing changed"; exit 1; }
  [[ -z "${seen_stack[$slug/$env]:-}" ]] || { echo "refused: $slug/$env listed twice; nothing changed"; exit 1; }
  seen_idx[$idx]=1; seen_stack[$slug/$env]=1
  v4=""
  if [[ -n "$tailnet" ]]; then
    read -r -a cidrs <<<"$tailnet"
    for c in "${cidrs[@]}"; do
      v4_in_tailnet "$c" || { echo "refused: tailnet entry for $slug/$env is not an IPv4 CIDR inside 100.64.0.0/10 (IPv6 entries wait for S4-b2); nothing changed"; exit 1; }
      v4+="$c "
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
# One iptables-restore transaction carries the chain rebuild AND the jump changes, so DOCKER-USER/INPUT never
# lose the S4 jump mid-apply (Codex pre-review: a separate -D then -I left a gap). A jump that is already the
# only one and first is left alone; otherwise existing copies are deleted and one is inserted at position 1,
# all inside the same COMMIT.
jump_ops() {  # -> restore lines that leave exactly one jump, first, in each built-in chain
  local c chain target n first
  for c in DOCKER-USER:$FWD FORWARD:$FWD INPUT:$IN; do
    chain="${c%%:*}" target="${c#*:}"
    n="$(ipt -S "$chain" 2>/dev/null | grep -cxF -- "-A $chain -j $target")"
    first="$(ipt -S "$chain" 2>/dev/null | grep '^-A ' | sed -n 1p)"
    [[ "$n" == 1 && "$first" == "-A $chain -j $target" ]] && continue
    while (( n-- > 0 )); do echo "-D $chain -j $target"; done
    echo "-I $chain 1 -j $target"
  done
}
live_fp() {  # fingerprint of the live S4 chains as `iptables -S` prints them (normalised by iptables itself)
  { ipt -S "$FWD" && ipt -S "$IN"; } 2>/dev/null | sha256sum | cut -d' ' -f1
}
live_matches() {  # 0 when the live S4 chains have the block's rule count AND the fingerprint recorded at apply
  local c want have
  for c in $FWD $IN; do
    want="$(grep -c -- "^-A $c " <<<"$1")"
    have="$(ipt -S "$c" 2>/dev/null | grep -c -- "^-A $c ")" || return 1
    [[ "$want" == "$have" ]] || return 1
  done
  [[ -s "$ISO/live.sha256" && "$(live_fp)" == "$(cat "$ISO/live.sha256")" ]]
}
record() {  # block -> installed.rules + live fingerprint
  printf '%s\n' "$1" > "$ISO/installed.rules.tmp" && mv -f "$ISO/installed.rules.tmp" "$ISO/installed.rules" \
    && live_fp > "$ISO/live.sha256.tmp" && mv -f "$ISO/live.sha256.tmp" "$ISO/live.sha256"
}
install_block() {  # block text in $1 -> live, in one transaction with the jump changes
  ipt -S DOCKER-USER >/dev/null 2>&1 || { echo "DOCKER-USER chain missing (M0.1 not applied?)"; return 1; }
  # The whole transaction is built BEFORE iptables-restore starts (Codex PR54-r1): on the legacy backend restore
  # holds the xtables lock from *filter to COMMIT, so jump_ops' `iptables -S` queries must not run inside it.
  local tx ops
  ops="$(jump_ops)" || return 1
  tx="$(grep -vx 'COMMIT' <<<"$1")"$'\n'"${ops:+$ops$'\n'}COMMIT"
  printf '%s\n' "$tx" | timeout 15 iptables-restore -w 5 --noflush
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
# One run at a time (the agent tick and KK's --remove must not interleave).
exec 9>"$ISO/.lock" && flock -n 9 || { echo "skipped: another isolation-apply run holds $ISO/.lock"; exit 3; }
PREV=""; [[ -s "$ISO/installed.rules" ]] && PREV="$(cat "$ISO/installed.rules")"
if [[ "$BLOCK" == "$PREV" ]] && [[ -z "$(jump_ops)" ]] && live_matches "$BLOCK"; then
  echo "unchanged: ${#STACKS[@]} stacks, block already in place"; exit 0
fi

# Probe before the change: the S4 chains match only pool sources, so they cannot break a host probe. If the
# host already fails before the change, the cause is elsewhere; the block is applied and kept (isolation is
# the floor) and the failure is reported. Roll back only when the probe passed before and fails after.
pre_ok=1; pre_msg="$(selftest)" || pre_ok=0
if ! install_block "$BLOCK"; then
  echo "apply failed (iptables-restore refused the transaction): the previous block is still in place"; exit 1
fi
if ! post_msg="$(selftest)"; then
  if (( pre_ok == 0 )); then
    record "$BLOCK"
    echo "applied: ${#STACKS[@]} stacks, block kept; the host self-test was already failing before the change ($pre_msg)"; exit 1
  fi
  echo "self-test failed after apply ($post_msg): rolling back"
  if [[ -n "$PREV" ]]; then
    install_block "$PREV" && record "$PREV" && echo "rolled back to the previous block" || echo "rollback failed: run $0 --remove from the console"
  else
    remove_block && rm -f "$ISO/live.sha256" && echo "rolled back: S4 block removed" || echo "rollback failed: run $0 --remove from the console"
  fi
  exit 1
fi
record "$BLOCK" || { echo "applied, but could not record $ISO/installed.rules"; exit 1; }
echo "applied: ${#STACKS[@]} stacks, self-test passed"

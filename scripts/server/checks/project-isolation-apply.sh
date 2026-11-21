#!/usr/bin/env bash
# DevOS server check (S4-b2a, DEVOS-127, docs/modules/S4.md): the host firewall block for project isolation
# (isolation-apply.sh, S4-b) was applied, or found unchanged, by a recent server-agent tick.
# Reads only $DEVOS_DIR/agent/isolation.state, one line written by server-agent.sh v1.6.0 (DEVOS-128):
#   "<epoch> <ok|skipped|fail (disabled)|fail (exit 1, <code>)|fail (exit n)|fail (timeout)>"
# <code> is one fixed reason code picked by isolation-apply.sh (or "unknown"); no raw output is ever stored.
# "fail (exit 1)" without a code (agent v1.5.0) is still read, so the check works across the agent update.
# "fail (disabled)" means KK ran isolation-apply.sh --remove. Exit 0 pass, 1 fail, 3 skipped (not set up yet:
# no state token or no API listener, or the agent has not run it yet). Prints one line; never a secret.
set -uo pipefail
DIR="${DEVOS_DIR:-/root/.devos}"
F="$DIR/agent/isolation.state"
MAX_AGE="${ISOLATION_MAX_AGE:-2700}"   # 45 min: ticks are minutes apart; a deploy defers it for at most 30 min
[[ -f "$F" ]] || { echo "skipped: the server agent has not run isolation-apply.sh yet"; exit 3; }
line="$(head -n1 "$F" 2>/dev/null)"
[[ "$line" =~ ^([0-9]{1,12})\ (ok|skipped|fail\ \(disabled\)|fail\ \(exit\ 1,\ (config|token|state-fetch|refused|lock|deadline|conntrack|apply|self-test|rollback|record|boot-persistence|ipv6|unknown)\)|fail\ \(exit\ [0-9]{1,3}\)|fail\ \(timeout\))$ ]] \
  || { echo "fail: unreadable isolation state"; exit 1; }
at="${BASH_REMATCH[1]}"; st="${BASH_REMATCH[2]}"
age=$(( $(date +%s) - at ))
(( age >= 0 )) || { echo "fail: isolation state is dated in the future"; exit 1; }
(( age <= MAX_AGE )) || { echo "fail: last isolation run was ${age}s ago (more than ${MAX_AGE}s): $st"; exit 1; }
case "$st" in
  ok) echo "isolation block applied or unchanged ${age}s ago"; exit 0 ;;
  skipped) echo "skipped: isolation not set up yet (no state token or listener), ${age}s ago"; exit 3 ;;
  *) echo "fail: last isolation run ${age}s ago: $st"; exit 1 ;;
esac

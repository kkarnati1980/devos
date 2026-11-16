#!/usr/bin/env bash
# DevOS server check (S4-b2a, DEVOS-127, docs/modules/S4.md): the host firewall block for project isolation
# (isolation-apply.sh, S4-b) was applied, or found unchanged, by a recent server-agent tick.
# Reads only $DEVOS_DIR/agent/isolation.state ("<epoch> <ok|skipped|fail (exit n)|fail (timeout)>"), written by
# server-agent.sh v1.5.0. Exit 0 pass, 1 fail, 3 skipped (not set up yet: no state token or no API listener,
# or the agent has not run it yet). Prints one line; never a secret.
set -uo pipefail
DIR="${DEVOS_DIR:-/root/.devos}"
F="$DIR/agent/isolation.state"
MAX_AGE="${ISOLATION_MAX_AGE:-2700}"   # 45 min: ticks every few minutes; a deploy defers it for up to ~15 min a tick
[[ -f "$F" ]] || { echo "skipped: the server agent has not run isolation-apply.sh yet"; exit 3; }
line="$(head -n1 "$F" 2>/dev/null)"
[[ "$line" =~ ^([0-9]{1,12})\ (ok|skipped|fail\ \(exit\ [0-9]{1,3}\)|fail\ \(timeout\))$ ]] \
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

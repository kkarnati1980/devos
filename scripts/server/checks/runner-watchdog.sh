#!/usr/bin/env bash
# DevOS server check (DEVOS-221, docs/modules/runner-watchdog.md AT7): the runner watchdog is alive. It reads
# `watchdog.lastRunAt` from the API's /health (the time of the watchdog's last completed 30-minute tick) and
# passes when that is under 35 minutes old; it fails when older, missing (null) or unreadable, and skips when
# nothing answers (DevOS not deployed yet).
# Exit 0 pass, 1 fail, 3 skipped. Same HTTPS call as health-sha.sh: https://<MagicDNS name>:<port>/health,
# pinned to the tailnet IP with --resolve, certificate verified (never -k); only "connection refused"
# (curl exit 7) is a skip.
# The watchdog ticks at API start-up, so a check right after a deploy can see null for a few seconds: a null
# is polled again (every WATCHDOG_POLL_SECONDS, up to WATCHDOG_WAIT_SECONDS, under the agent's 120 s limit)
# before it fails. A time more than 5 minutes in the future (clock skew or a bad value) fails.
# Port: API_PORT in $DEVOS_DIR/server-agent.conf (read with sed, default 3001). Prints no secret.
set -uo pipefail
MAX_AGE="${WATCHDOG_MAX_AGE_SECONDS:-2100}"   # 35 minutes
WAIT="${WATCHDOG_WAIT_SECONDS:-60}"
POLL="${WATCHDOG_POLL_SECONDS:-5}"
CONF="${DEVOS_DIR:-/root/.devos}/server-agent.conf"
PORT="$(sed -n 's/^API_PORT=\([0-9]\{2,5\}\)$/\1/p' "$CONF" 2>/dev/null | head -n1)"
PORT="${PORT:-3001}"
TS_IP="$(timeout 10 tailscale ip -4 2>/dev/null | head -n1)"
[[ "$TS_IP" =~ ^100\. ]] || { echo "no tailnet IPv4 (tailscale ip -4)"; exit 1; }
NAME="$(timeout 10 tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' 2>/dev/null | sed 's/\.$//')"
[[ "$NAME" =~ ^[A-Za-z0-9.-]+\.ts\.net$ ]] || { echo "no MagicDNS name (tailscale status --json)"; exit 1; }
URL="https://$NAME:$PORT/health"

while :; do
  body="$(curl -s --connect-timeout 5 --max-time 10 --resolve "$NAME:$PORT:$TS_IP" -w '\n%{http_code}' "$URL" 2>/dev/null)"; crc=$?
  code="${body##*$'\n'}"; body="${body%$'\n'*}"
  if (( crc == 7 )); then echo "skipped: nothing answers on tailnet $TS_IP:$PORT (DevOS not deployed yet)"; exit 3; fi
  (( crc == 0 )) || { echo "health $URL -> no valid HTTPS (curl exit $crc)"; exit 1; }
  [[ "$code" == 200 ]] || { echo "health $URL -> HTTP $code"; exit 1; }
  last="$(printf '%s' "$body" | jq -r 'if (.watchdog | type) == "object" then (.watchdog.lastRunAt // "null") else "absent" end' 2>/dev/null)"
  [[ -n "$last" ]] || { echo "health $URL -> body is not JSON"; exit 1; }
  [[ "$last" == absent ]] && { echo "health $URL has no watchdog field (deployed API is older than DEVOS-220)"; exit 1; }
  [[ "$last" != null ]] && break
  if (( SECONDS + POLL > WAIT )); then
    echo "watchdog has not run: watchdog.lastRunAt is null after ${SECONDS}s (no vault, no Linear client, or the watchdog is off)"; exit 1
  fi
  sleep "$POLL"
done

[[ "$last" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$ ]] \
  || { echo "watchdog.lastRunAt is not an ISO time: $(printf '%s' "$last" | cut -c1-40 | tr -cd '[:print:]')"; exit 1; }
then_s="$(date -u -d "$last" +%s 2>/dev/null)" || { echo "watchdog.lastRunAt cannot be parsed: $last"; exit 1; }
now_s="$(date -u +%s)"
age=$(( now_s - then_s ))
if (( age < -300 )); then echo "watchdog.lastRunAt $last is $(( -age ))s in the future (clock skew?)"; exit 1; fi
(( age < 0 )) && age=0
if (( age >= MAX_AGE )); then
  echo "watchdog last ran at $last, $(( age / 60 )) min ago (limit $(( MAX_AGE / 60 )) min): the watchdog has stopped"; exit 1
fi
echo "watchdog last ran at $last, $(( age / 60 )) min ago (under $(( MAX_AGE / 60 )) min)"

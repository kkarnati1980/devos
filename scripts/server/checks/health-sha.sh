#!/usr/bin/env bash
# DevOS server check (R1-e, docs/modules/R1.md; G1 evidence): the API answers /health on the tailnet IP and
# reports exactly the SHA the server agent deployed (DEVOS_SHA), so the running code is the PASSed code (D1).
# Exit 0 pass, 1 fail, 3 skipped (nothing answers yet: DevOS not deployed).
# v1.1.0 (DEVOS-81, R3-c): the API serves HTTPS (R3-a). The check calls https://<MagicDNS name>:<port>/health,
# pinned to the tailnet IP with --resolve, and verifies the certificate (curl's default CA check, never -k).
# Only "connection refused" (curl exit 7) counts as not deployed; a timeout or a TLS failure (plain HTTP,
# wrong or expired certificate) fails.
# Port: API_PORT in $DEVOS_DIR/server-agent.conf (read with sed, default 3001). Prints no secret.
set -uo pipefail
CONF="${DEVOS_DIR:-/root/.devos}/server-agent.conf"
PORT="$(sed -n 's/^API_PORT=\([0-9]\{2,5\}\)$/\1/p' "$CONF" 2>/dev/null | head -n1)"
PORT="${PORT:-3001}"
[[ "${DEVOS_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "DEVOS_SHA is not a full commit SHA"; exit 1; }
TS_IP="$(timeout 10 tailscale ip -4 2>/dev/null | head -n1)"
[[ "$TS_IP" =~ ^100\. ]] || { echo "no tailnet IPv4 (tailscale ip -4)"; exit 1; }
NAME="$(timeout 10 tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' 2>/dev/null | sed 's/\.$//')"
[[ "$NAME" =~ ^[A-Za-z0-9.-]+\.ts\.net$ ]] || { echo "no MagicDNS name (tailscale status --json)"; exit 1; }
URL="https://$NAME:$PORT/health"
body="$(curl -s --connect-timeout 5 --max-time 10 --resolve "$NAME:$PORT:$TS_IP" -w '\n%{http_code}' "$URL" 2>/dev/null)"; crc=$?
code="${body##*$'\n'}"; body="${body%$'\n'*}"
if (( crc == 7 )); then
  echo "skipped: nothing answers on tailnet $TS_IP:$PORT (DevOS not deployed yet)"; exit 3
fi
(( crc == 0 )) || { echo "health $URL -> no valid HTTPS (curl exit $crc)"; exit 1; }
[[ "$code" == 200 ]] || { echo "health $URL -> HTTP $code"; exit 1; }
sha="$(printf '%s' "$body" | sed -n 's/.*"sha":"\([0-9a-zA-Z]*\)".*/\1/p' | head -n1)"
echo "health $URL -> HTTPS ok (certificate verified), HTTP 200, sha ${sha:0:12}"
[[ "$sha" == "$DEVOS_SHA" ]] || { echo "deployed sha ${sha:0:12} != expected ${DEVOS_SHA:0:12}"; exit 1; }
echo "deployed code matches ${DEVOS_SHA:0:12}"

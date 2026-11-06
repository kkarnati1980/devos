#!/usr/bin/env bash
# DevOS server check (R1-e, docs/modules/R1.md; G1 evidence): the API answers /health on the tailnet IP and
# reports exactly the SHA the server agent deployed (DEVOS_SHA), so the running code is the PASSed code (D1).
# Exit 0 pass, 1 fail, 3 skipped (nothing answers yet: DevOS not deployed).
# Port: API_PORT in $DEVOS_DIR/server-agent.conf (read with sed, default 3001). Prints no secret.
set -uo pipefail
CONF="${DEVOS_DIR:-/root/.devos}/server-agent.conf"
PORT="$(sed -n 's/^API_PORT=\([0-9]\{2,5\}\)$/\1/p' "$CONF" 2>/dev/null | head -n1)"
PORT="${PORT:-3001}"
[[ "${DEVOS_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "DEVOS_SHA is not a full commit SHA"; exit 1; }
TS_IP="$(timeout 10 tailscale ip -4 2>/dev/null | head -n1)"
[[ "$TS_IP" =~ ^100\. ]] || { echo "no tailnet IPv4 (tailscale ip -4)"; exit 1; }
body="$(curl -s --connect-timeout 5 --max-time 10 -w '\n%{http_code}' "http://$TS_IP:$PORT/health" 2>/dev/null)"
code="${body##*$'\n'}"; body="${body%$'\n'*}"
if [[ -z "$code" || "$code" == 000 ]]; then echo "skipped: nothing answers on tailnet $TS_IP:$PORT/health (DevOS not deployed yet)"; exit 3; fi
[[ "$code" == 200 ]] || { echo "health $TS_IP:$PORT -> HTTP $code"; exit 1; }
sha="$(printf '%s' "$body" | sed -n 's/.*"sha":"\([0-9a-zA-Z]*\)".*/\1/p' | head -n1)"
echo "health $TS_IP:$PORT -> HTTP 200, sha ${sha:0:12}"
[[ "$sha" == "$DEVOS_SHA" ]] || { echo "deployed sha ${sha:0:12} != expected ${DEVOS_SHA:0:12}"; exit 1; }
echo "deployed code matches ${DEVOS_SHA:0:12}"

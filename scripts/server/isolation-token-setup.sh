#!/usr/bin/env bash
# DevOS — create the isolation state token and deliver it to the host and the API (S4-t1, DEVOS-237)
# Version: 1.0.0
# Contract: docs/modules/S4.md ("S4-t1 decisions"). Run as root, by install-server-agent.sh or by KK:
#   isolation-token-setup.sh            create the token once (kept if present), then upsert the Coolify env
#   isolation-token-setup.sh --rotate   replace the token with a new one, then upsert the Coolify env
# 1. Host copy: $DEVOS_DIR/secrets/isolation_state_token (dir 700, file 600), 64 characters of base64 from
#    48 random bytes, inside the character set both sides accept ([A-Za-z0-9._~+/=-], 32-512). Written to a
#    temp file in the same directory and renamed, so a reader never sees half a token.
# 2. API copy: the DevOS app's Coolify env DEVOS_ISOLATION_STATE_TOKEN, runtime only (not build-time, so it is
#    never a build arg; not preview), set with the stored Coolify token ($DEVOS_DIR/coolify-deploy.env) under
#    the server agent's lock, then read back: the key exists with those flags (and the value matches, where
#    Coolify returns values at all).
# The token never reaches argv, stdout, stderr or a log: it is read from files (curl --data-binary @file,
# jq --rawfile), and every request body lives in a mode-700 temp dir removed on exit.
# Exit 0 done, 1 failed (an existing host token is kept), 2 usage, 3 host token ready but no Coolify token yet.
set -uo pipefail
DIR="${DEVOS_DIR:-/root/.devos}"
SEC="$DIR/secrets"
TOKEN_FILE="$SEC/isolation_state_token"
CF_ENV="$DIR/coolify-deploy.env"
COOLIFY_API="${COOLIFY_API:-http://localhost:8000/api/v1}"
AGENT_LOCK="${AGENT_LOCK:-$DIR/agent/agent.lock}"
KEY=DEVOS_ISOLATION_STATE_TOKEN
RE='^[A-Za-z0-9._~+/=-]{32,512}$'

ROTATE=0
case "${1:-}" in
  "") ;;
  --rotate) ROTATE=1 ;;
  *) echo "usage: $0 [--rotate]"; exit 2 ;;
esac
[[ $# -le 1 ]] || { echo "usage: $0 [--rotate]"; exit 2; }
for c in jq curl flock base64 head; do
  command -v "$c" >/dev/null 2>&1 || { echo "failed: $c is not installed"; exit 1; }
done

TMP="$(mktemp -d)" || { echo "failed: no temp dir"; exit 1; }
new=
chmod 700 "$TMP"; trap 'rm -rf "$TMP"; [[ -n "$new" ]] && rm -f "$new"' EXIT

valid_file() {  # path -> 0 if it holds one valid token line
  local t
  [[ -s "$1" ]] || return 1
  t="$(head -c 600 "$1" | tr -d '\r\n')"
  [[ "$t" =~ $RE ]]
}

# --- 1. host copy -----------------------------------------------------------------------------------------
install -d -m 700 "$DIR" "$SEC" || { echo "failed: cannot create $SEC"; exit 1; }
chmod 700 "$SEC"
if (( ROTATE == 0 )) && valid_file "$TOKEN_FILE"; then
  chmod 600 "$TOKEN_FILE"
  echo "host token: kept ($TOKEN_FILE, mode $(stat -c %a "$TOKEN_FILE"))"
else
  [[ -e "$TOKEN_FILE" && $ROTATE == 0 ]] && echo "host token: the existing file is malformed; replacing it"
  new="$(mktemp "$SEC/.isolation_state_token.XXXXXX")" || { echo "failed: cannot write in $SEC"; exit 1; }
  chmod 600 "$new"
  # 48 random bytes -> 64 base64 characters, no newline inside; the file ends with one newline.
  if ! { head -c 48 /dev/urandom | base64 -w0; echo; } > "$new" || ! valid_file "$new"; then
    rm -f "$new"; echo "failed: could not generate a token (the existing host token, if any, is kept)"; exit 1
  fi
  mv -f "$new" "$TOKEN_FILE" || { rm -f "$new"; echo "failed: could not install the token file"; exit 1; }
  new=
  echo "host token: created ($TOKEN_FILE, mode $(stat -c %a "$TOKEN_FILE"))"
fi

# --- 2. API copy (Coolify env) ----------------------------------------------------------------------------
if [[ ! -s "$CF_ENV" ]]; then
  echo "skipped: no Coolify token stored yet ($CF_ENV). Run install-server-agent.sh with ROTATE_COOLIFY=1, then this again."
  exit 3
fi
U="$(sed -n 's/^COOLIFY_APP_UUID=//p' "$CF_ENV" | head -n1 | tr -d '\r\n')"
[[ "$U" =~ ^[A-Za-z0-9-]{8,64}$ ]] || { echo "failed: no valid COOLIFY_APP_UUID in $CF_ENV"; exit 1; }
( umask 077; printf 'Authorization: Bearer %s\n' "$(sed -n 's/^COOLIFY_TOKEN=//p' "$CF_ENV" | head -n1 | tr -d '\r\n')" > "$TMP/auth" )

req() {  # method path [body-file] -> HTTP code (body in $TMP/r); 000 on a connection error
  local a=(-sS --connect-timeout 10 --max-time 30 -o "$TMP/r" -w '%{http_code}' -H @"$TMP/auth" -H 'Accept: application/json' -X "$1")
  [[ -n "${3:-}" ]] && a+=(-H 'Content-Type: application/json' --data-binary @"$3")
  local c; c="$(curl "${a[@]}" "$COOLIFY_API$2" 2>/dev/null)" || true
  [[ "$c" =~ ^[1-5][0-9][0-9]$ ]] && echo "$c" || echo 000   # curl prints 000 itself on a connection error
}
why() { case "$1" in 401|403) echo "HTTP $1: the Coolify token lacks read + write";; 404) echo "HTTP 404: no app with that UUID";;
  000) echo "Coolify API not reachable at $COOLIFY_API";; *) echo "Coolify API answered HTTP $1";; esac; }

# The agent PATCHes the same app's envs (GIT_SHA) inside its tick: hold its lock so the two never interleave.
install -d -m 700 "$(dirname "$AGENT_LOCK")"
exec 9>>"$AGENT_LOCK"
if ! flock -n 9; then
  echo "waiting for the running agent tick to finish (up to $(( ${LOCK_WAIT:-1600} / 60 )) minutes)..."
  flock -w "${LOCK_WAIT:-1600}" 9 || { echo "failed: the agent tick did not finish; nothing sent to Coolify (host token kept)"; exit 1; }
fi
# Read the host token only now, under the lock: a concurrent --rotate that renamed a new token in while this
# run waited is the value sent, so the host copy and the Coolify copy cannot end up different (pre-review).
valid_file "$TOKEN_FILE" || { echo "failed: the host token changed and is no longer valid; rerun"; exit 1; }
tr -d '\r\n' < <(head -c 600 "$TOKEN_FILE") > "$TMP/tok" || { echo "failed: cannot read the token file"; exit 1; }

c="$(req GET "/applications/$U/envs")"
[[ "$c" == 200 ]] && jq -e 'type == "array"' "$TMP/r" >/dev/null 2>&1 \
  || { echo "failed: reading the app's env: $(why "$c") (host token kept)"; exit 1; }
# Same flag names as server-agent.sh's GIT_SHA upsert: newer Coolify has is_buildtime + is_runtime, older
# is_build_time only.
if jq -e 'any(.[]; has("is_buildtime") or has("is_runtime"))' "$TMP/r" >/dev/null; then
  jq -n --rawfile v "$TMP/tok" --arg k "$KEY" '{data: [{key: $k, value: $v, is_preview: false, is_buildtime: false, is_runtime: true}]}'
else
  jq -n --rawfile v "$TMP/tok" --arg k "$KEY" '{data: [{key: $k, value: $v, is_preview: false, is_build_time: false}]}'
fi > "$TMP/env.json" || { echo "failed: could not build the request (host token kept)"; exit 1; }
c="$(req PATCH "/applications/$U/envs/bulk" "$TMP/env.json")"
rm -f "$TMP/env.json"
[[ "$c" =~ ^20[01]$ ]] || { echo "failed: writing the app's env: $(why "$c") (host token kept)"; exit 1; }

c="$(req GET "/applications/$U/envs")"
[[ "$c" == 200 ]] || { echo "failed: reading the env back: $(why "$c")"; exit 1; }
# Read back with has(), not //, so an explicit false is read as false (server-agent.sh v1.2.1). A token
# without read:sensitive gets no values back; then presence and flags are what is checked.
jq -e --rawfile v "$TMP/tok" --arg k "$KEY" '[.[]? | select(.key == $k and ((.is_preview // false) == false))] as $g
  | ($g | length) > 0
    and all($g[]; (if has("is_buildtime") then .is_buildtime elif has("is_build_time") then .is_build_time else false end) == false
                  and ((has("is_runtime") | not) or .is_runtime == true)
                  and ((has("value") | not) or .value == null or .value == $v))' "$TMP/r" >/dev/null \
  || { echo "failed: $KEY did not read back as a runtime-only env with the host's value"; exit 1; }
echo "Coolify env: $KEY set on the DevOS app (runtime only); it takes effect at the next deploy"
exit 0

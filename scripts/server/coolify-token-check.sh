#!/usr/bin/env bash
# DevOS — check that a Coolify API token can do what the server agent needs (DEVOS-82).
# Contract: docs/modules/server-agent.md · Version: 1.0.1
# v1.0.1 (Codex PR26-r1): the whole read / PATCH / read-back runs under the server agent's lock, so a running tick
# cannot set a new git_commit_sha between our read and our write-back (which would deploy the older revision).
# Usage: coolify-token-check.sh <env-file with COOLIFY_TOKEN= and COOLIFY_APP_UUID=>
# The agent needs read + write + deploy (write: it PATCHes the app's git_commit_sha and GIT_SHA env before each
# deploy). Never root, never read:sensitive.
#   1. read:  GET the app (must be 200);
#   2. write: PATCH the app's git_commit_sha with the value it already has (an idempotent no-op), then read it
#      back unchanged. A read-only or read + deploy token gets 401/403 here: "missing write permission".
# Deploy cannot be tested without starting a deployment, so it is not tested; the first deploy reports it.
# The token is read with sed (never sourced), reaches curl only through a mode-600 header file in a mode-700
# temp dir deleted on exit, and is never printed. Exit 0 = pass, 1 = fail.
set -euo pipefail
COOLIFY_API="${COOLIFY_API:-http://localhost:8000/api/v1}"
ENVF="${1:?usage: coolify-token-check.sh <env-file>}"
pass() { printf '  \033[1;32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }
[[ -r "$ENVF" ]] || fail "cannot read $ENVF"
command -v jq >/dev/null || fail "jq is required"

# Hold the agent's lock (the same file the agent's tick holds) for the whole check.
AGENT_LOCK="${AGENT_LOCK:-/root/.devos/agent/agent.lock}"
install -d -m 700 "$(dirname "$AGENT_LOCK")"
exec 9>>"$AGENT_LOCK"
if ! flock -n 9; then
  echo "  waiting for the running agent tick to finish (up to $(( ${LOCK_WAIT:-1600} / 60 )) minutes)..."
  flock -w "${LOCK_WAIT:-1600}" 9 || fail "the agent tick did not finish; nothing was checked or changed - rerun the installer"
fi

TMP="$(mktemp -d)"; chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
( umask 077; printf 'Authorization: Bearer %s\n' "$(sed -n 's/^COOLIFY_TOKEN=//p' "$ENVF" | head -n1 | tr -d '\r\n')" > "$TMP/auth" )
U="$(sed -n 's/^COOLIFY_APP_UUID=//p' "$ENVF" | head -n1 | tr -d '\r\n')"
[[ "$U" =~ ^[A-Za-z0-9-]{8,64}$ ]] || fail "no valid COOLIFY_APP_UUID in $ENVF"
req() {  # method path [body-file] -> HTTP code (body in $TMP/r); 000 on a connection error
  local a=(-sS --connect-timeout 10 --max-time 30 -o "$TMP/r" -w '%{http_code}' -H @"$TMP/auth" -H 'Accept: application/json' -X "$1")
  [[ -n "${3:-}" ]] && a+=(-H 'Content-Type: application/json' --data-binary @"$3")
  curl "${a[@]}" "$COOLIFY_API$2" 2>/dev/null || echo 000
}
why() { case "$1" in 401|403) echo "HTTP $1: missing $2 permission";; 404) echo "HTTP 404: no app with that UUID";;
  000) echo "Coolify API not reachable at $COOLIFY_API";; *) echo "Coolify API answered HTTP $1";; esac; }

c="$(req GET "/applications/$U")"
[[ "$c" == 200 ]] || fail "read check: $(why "$c" read) - the token needs read + write + deploy"
name="$(jq -r '.name // "?"' "$TMP/r" 2>/dev/null || echo "?")"
cur="$(jq -r 'if (.git_commit_sha|type) == "string" and .git_commit_sha != "" then .git_commit_sha else empty end' "$TMP/r" 2>/dev/null || true)"
[[ -n "$cur" ]] || fail "write check: the app's git_commit_sha is not readable, so write access cannot be tested without changing it"
pass "token reads the app '$name'"

jq -n --arg s "$cur" '{git_commit_sha: $s}' > "$TMP/patch.json"
c="$(req PATCH "/applications/$U" "$TMP/patch.json")"
[[ "$c" =~ ^20[01]$ ]] || fail "write check: $(why "$c" write) - create a token with read + write + deploy (never root, never read:sensitive)"
c="$(req GET "/applications/$U")"
after="$(jq -r '.git_commit_sha // empty' "$TMP/r" 2>/dev/null || true)"
[[ "$c" == 200 && "$after" == "$cur" ]] || fail "write check: git_commit_sha did not read back unchanged (HTTP $c)"
pass "token can write (git_commit_sha rewritten to its current value, unchanged)"
echo "  note: deploy permission cannot be tested without starting a deployment; the first deploy-on-PASS reports it"

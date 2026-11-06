#!/usr/bin/env bash
# DevOS — server agent: self-update, deploy-on-PASS and server checks for each passing main SHA (DEVOS-74)
# Version: 1.0.0
# Contract: docs/modules/server-agent.md. Runs as root from devos-server-agent.timer (install-server-agent.sh).
# D1: nothing is installed or deployed for a main SHA unless its CI is green AND Codex passed that exact SHA
# (its own codex-review status, or the merged PR head's PASS with an identical tree).
# Safety: allow-listed actions only; nothing taken from GitHub content is ever executed. Tokens are read with
# sed, reach curl through mode-600 header files, and are never printed. Every curl call has a timeout.
# Usage: server-agent.sh [--dry-run]
set -euo pipefail

REPO="kkarnati1980/devos"
API="${GITHUB_API:-https://api.github.com}"
COOLIFY_API="${COOLIFY_API:-http://localhost:8000/api/v1}"
DIR="${DEVOS_DIR:-/root/.devos}"
BIN="$DIR/bin"
ST="$DIR/agent"
WORK="${AGENT_WORK:-/root/devos-agent}"
REMOTE="${AGENT_REPO_URL:-git@github.com:kkarnati1980/devos.git}"
POLL_SEC="${POLL_SEC:-10}"
DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-1200}"
CHECK_TIMEOUT="${CHECK_TIMEOUT:-120}"
GH_ENV="$DIR/github-review.env"
CF_ENV="$DIR/coolify-deploy.env"
# The allow-list: the only files ever installed (checks are added from scripts/server/checks/*.sh).
ALLOW=(scripts/review/review-watch.sh scripts/review/review-commit.sh scripts/server/server-agent.sh)
DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "ERROR $*"; exit 1; }
install -d -m 700 "$ST" "$BIN" "$BIN/checks"
exec 8>"$ST/agent.lock"
flock -n 8 || { log "previous tick still running; skipping"; exit 0; }

TMP="$(mktemp -d)"; chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
[[ -s "$GH_ENV" ]] || die "missing $GH_ENV (install the review watcher first)"
( umask 077; printf 'Authorization: Bearer %s\n' "$(sed -n 's/^GITHUB_REVIEW_TOKEN=//p' "$GH_ENV" | head -n1 | tr -d '\r\n')" > "$TMP/gh.auth" )
CF_TOKEN_FILE=""
if [[ -s "$CF_ENV" ]]; then
  ( umask 077
    sed -n 's/^COOLIFY_TOKEN=//p' "$CF_ENV" | head -n1 | tr -d '\r\n' > "$TMP/cf.token"
    printf 'Authorization: Bearer %s\n' "$(cat "$TMP/cf.token")" > "$TMP/cf.auth" )
  CF_TOKEN_FILE="$TMP/cf.token"
  CF_APP="$(sed -n 's/^COOLIFY_APP_UUID=//p' "$CF_ENV" | head -n1 | tr -d '\r\n')"
fi

# Redact token shapes, Bearer values and the literal Coolify token (read from its 600 file, never echoed).
redact() {
  local out
  out="$(sed -E 's/(sk-[A-Za-z0-9_*.-]{4})[A-Za-z0-9_*.-]*/\1[redacted]/g; s/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/\1[redacted]/g; s/(Bearer )[A-Za-z0-9._|=-]+/\1[redacted]/g')"
  if [[ -n "$CF_TOKEN_FILE" && -s "$CF_TOKEN_FILE" ]]; then
    awk -v tf="$CF_TOKEN_FILE" 'BEGIN{getline t < tf} { if (t != "") { while ((i = index($0, t)) > 0) $0 = substr($0, 1, i-1) "[redacted]" substr($0, i+length(t)) } print }' <<<"$out"
  else
    printf '%s\n' "$out"
  fi
}

http() {  # auth-file method url [json-body-file] -> body on stdout; non-2xx is an error
  local auth="$1" method="$2" url="$3" body="${4:-}" code
  local args=(-sS --connect-timeout 10 --max-time 30 -o "$TMP/resp" -w '%{http_code}' -X "$method" -H @"$auth"
              -H 'Accept: application/json')
  [[ -n "$body" ]] && args+=(-H 'Content-Type: application/json' --data-binary @"$body")
  code="$(curl "${args[@]}" "$url" 2>"$TMP/curl.err")" || { log "curl failed: $method ${url%%\?*}"; return 1; }
  [[ "$code" =~ ^2 ]] || { log "HTTP $code: $method ${url%%\?*}"; return 1; }
  cat "$TMP/resp"
}
gh() { http "$TMP/gh.auth" "$1" "$API$2" "${3:-}"; }
cf() { http "$TMP/cf.auth" "$1" "$COOLIFY_API$2" "${3:-}"; }

ci_state() {  # sha -> prints green | pending | red ; returns 1 if workflow runs cannot be read
  local runs
  runs="$(gh GET "/repos/$REPO/actions/runs?head_sha=$1&per_page=100")" || return 1
  jq -r '[.workflow_runs | group_by(.workflow_id)[] | max_by(.created_at)] as $l
         | if ($l | length) == 0 then "pending"
           elif any($l[]; .status != "completed") then "pending"
           elif all($l[]; .conclusion == "success" or .conclusion == "skipped" or .conclusion == "neutral") then "green"
           else "red" end' <<<"$runs"
}
codex_pass() {  # sha -> 0 when the combined status list has codex-review = success (latest wins)
  local s
  s="$(gh GET "/repos/$REPO/commits/$1/statuses?per_page=100")" || return 2
  jq -e '[.[] | select(.context == "codex-review")] | sort_by(.created_at) | last | .state == "success"' <<<"$s" >/dev/null
}
tree_of() { gh GET "/repos/$REPO/git/commits/$1" | jq -r '.tree.sha'; }
merged_pr() {  # sha -> "number headsha" of the merged PR whose merge commit is sha (empty if none)
  gh GET "/repos/$REPO/commits/$1/pulls" | jq -r --arg s "$1" '[.[] | select(.merge_commit_sha == $s and .merged_at != null)] | first // empty | "\(.number) \(.head.sha)"'
}

# gate sha -> prints ok | wait | refuse:<reason>
gate() {
  local sha="$1" ci pr head
  ci="$(ci_state "$sha")" || { echo "wait"; log "cannot read workflow runs (token needs Actions: Read)"; return; }
  [[ "$ci" == pending ]] && { echo "wait"; return; }
  [[ "$ci" == red ]] && { echo "refuse:CI is not green"; return; }
  if codex_pass "$sha"; then echo "ok"; return; fi
  read -r pr head <<<"$(merged_pr "$sha" || true)"
  if [[ "${head:-}" =~ ^[0-9a-f]{40}$ ]] && codex_pass "$head"; then
    if [[ "$(tree_of "$sha")" == "$(tree_of "$head")" ]]; then echo "ok"; return; fi
    echo "refuse:merge tree differs from the PASSed head of PR #$pr"; return
  fi
  echo "refuse:no Codex PASS for this SHA"
}

status() {  # sha context state description
  jq -n --arg s "$3" --arg c "$2" --arg d "${4:0:140}" '{state: $s, context: $c, description: $d}' > "$TMP/st.json"
  gh POST "/repos/$REPO/statuses/$1" "$TMP/st.json" >/dev/null
}
once_status() {  # marker sha context state description: post once, retried on later ticks until it succeeds
  local m="$ST/$2.$1"
  [[ -e "$m" ]] && return 0
  if status "$2" "$3" "$4" "$5"; then touch "$m"; else log "${2:0:7}: $3 status failed; will retry"; return 1; fi
}

self_update() {  # sha -> installs the allow-list at sha; 0 on success
  local sha="$1" f n stage="$TMP/stage"
  export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i /root/.ssh/devos_ro -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new}"
  if [[ ! -d "$WORK/.git" ]]; then git clone -q --no-checkout "$REMOTE" "$WORK" || return 1; fi
  timeout 120 git -C "$WORK" fetch -q --prune origin '+refs/heads/main:refs/remotes/origin/main' || return 1
  git -C "$WORK" checkout -q --force --detach "$sha" || return 1
  git -C "$WORK" clean -qfdx
  [[ "$(git -C "$WORK" rev-parse HEAD)" == "$sha" ]] || { log "checkout is not $sha"; return 1; }
  mkdir -p "$stage/checks"
  for f in "${ALLOW[@]}"; do
    [[ -f "$WORK/$f" ]] || { log "allow-listed file missing at ${sha:0:7}: $f"; return 1; }
    bash -n "$WORK/$f" 2>"$TMP/syntax" || { log "bash -n failed: $f"; return 1; }
    install -m 700 "$WORK/$f" "$stage/$(basename "$f")"
  done
  for f in "$WORK"/scripts/server/checks/*.sh; do
    [[ -e "$f" ]] || continue
    n="$(basename "$f")"
    [[ "$n" =~ ^[A-Za-z0-9._-]+\.sh$ ]] || { log "bad check name: $n"; return 1; }
    bash -n "$f" 2>"$TMP/syntax" || { log "bash -n failed: scripts/server/checks/$n"; return 1; }
    install -m 700 "$f" "$stage/checks/$n"
  done
  # All files are valid: rename into place (a running script keeps its old inode).
  for f in "$stage"/*.sh; do [[ -e "$f" ]] && install -m 700 "$f" "$BIN/.$(basename "$f").new" && mv -f "$BIN/.$(basename "$f").new" "$BIN/$(basename "$f")"; done
  for f in "$BIN"/checks/*.sh; do [[ -e "$f" && ! -e "$stage/checks/$(basename "$f")" ]] && rm -f "$f"; done
  for f in "$stage"/checks/*.sh; do [[ -e "$f" ]] && install -m 700 "$f" "$BIN/checks/.$(basename "$f").new" && mv -f "$BIN/checks/.$(basename "$f").new" "$BIN/checks/$(basename "$f")"; done
  echo "$sha" > "$ST/installed.sha"
  return 0
}

deploy() {  # sha -> 0 when Coolify finished deploying exactly this sha
  local sha="$1" dep st waited=0
  [[ -n "$CF_TOKEN_FILE" && "${CF_APP:-}" =~ ^[A-Za-z0-9-]+$ ]] || { log "Coolify token or app uuid missing"; return 1; }
  jq -n --arg s "$sha" '{git_commit_sha: $s}' > "$TMP/patch.json"
  cf PATCH "/applications/$CF_APP" "$TMP/patch.json" >/dev/null || return 1
  dep="$(cf POST "/deploy?uuid=$CF_APP&force=false" | jq -r '[.. | objects | .deployment_uuid? // empty] | first // empty')" || return 1
  [[ "$dep" =~ ^[A-Za-z0-9-]+$ ]] || { log "deploy returned no deployment uuid"; return 1; }
  while (( waited < DEPLOY_TIMEOUT )); do
    st="$(cf GET "/deployments/$dep" | jq -r '.status // empty')" || st=""
    case "$st" in
      finished|success) return 0 ;;
      failed|error|cancelled*) log "deployment ${dep:0:8}: $st"; return 1 ;;
    esac
    sleep "$POLL_SEC"; waited=$((waited + POLL_SEC))
  done
  log "deployment ${dep:0:8}: timed out"; return 1
}

run_checks() {  # sha -> writes $ST/<sha>.checks.md and $ST/<sha>.checks.state ("state description")
  local sha="$1" f n rc pass=0 fail=0 skip=0 res
  {
    printf '### Server checks at `%s`\n\n| Check | Result |\n|---|---|\n' "$sha"
  } > "$TMP/head.md"
  : > "$TMP/body.md"
  for f in "$BIN"/checks/*.sh; do
    [[ -e "$f" ]] || continue
    n="$(basename "$f" .sh)"
    set +e; DEVOS_SHA="$sha" DEVOS_DIR="$DIR" timeout "$CHECK_TIMEOUT" bash "$f" > "$TMP/check.out" 2>&1 </dev/null; rc=$?; set -e
    case "$rc" in 0) res=pass; pass=$((pass+1));; 3) res=skipped; skip=$((skip+1));; 124) res="fail (timeout)"; fail=$((fail+1));; *) res="fail (exit $rc)"; fail=$((fail+1));; esac
    printf '| `%s` | %s |\n' "$n" "$res" >> "$TMP/head.md"
    { printf '\n<details><summary>%s — %s</summary>\n\n```\n' "$n" "$res"; tail -n 20 "$TMP/check.out" | redact; printf '```\n</details>\n'; } >> "$TMP/body.md"
  done
  cat "$TMP/head.md" "$TMP/body.md" | redact > "$ST/$sha.checks.md"
  local total=$((pass + fail + skip)) desc
  desc="$pass/$total passed"; (( skip > 0 )) && desc="$desc, $skip skipped"
  if (( total == 0 )); then echo "failure no server checks installed" > "$ST/$sha.checks.state"
  elif (( fail == 0 )); then echo "success $desc" > "$ST/$sha.checks.state"
  else echo "failure $desc" > "$ST/$sha.checks.state"; fi
}

publish_checks() {  # sha -> posts server-check status and the comment (each once, retried until done)
  local sha="$1" st desc pr head
  read -r st desc < "$ST/$sha.checks.state"
  once_status check-statused "$sha" server-check "$st" "$desc" || true
  if [[ ! -e "$ST/check-commented.$sha" ]]; then
    jq -Rs '{body: .}' "$ST/$sha.checks.md" > "$TMP/c.json"
    read -r pr head <<<"$(merged_pr "$sha" || true)"
    if [[ "${pr:-}" =~ ^[0-9]+$ ]]; then
      gh POST "/repos/$REPO/issues/$pr/comments" "$TMP/c.json" >/dev/null && touch "$ST/check-commented.$sha"
    else
      gh POST "/repos/$REPO/commits/$sha/comments" "$TMP/c.json" >/dev/null && touch "$ST/check-commented.$sha"
    fi
    [[ -e "$ST/check-commented.$sha" ]] || log "${sha:0:7}: check comment failed; will retry"
  fi
}

# ---- tick ----
sha="$(gh GET "/repos/$REPO/commits/main" | jq -r '.sha')" || die "cannot read main"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "bad main sha"
if [[ -e "$ST/done.$sha" ]]; then log "main ${sha:0:7}: already handled"; exit 0; fi
deploy_on=0; [[ -e "$ST/deploy.enabled" ]] && deploy_on=1

if [[ -e "$ST/refused.$sha" ]]; then
  once_status refuse-statused "$sha" devos-deploy failure "$(cat "$ST/refused.$sha")" && touch "$ST/done.$sha"
  exit 0
fi
if [[ ! -e "$ST/installed.$sha" ]]; then
  g="$(gate "$sha")"
  case "$g" in
    wait) log "main ${sha:0:7}: CI not finished; next tick"; exit 0 ;;
    refuse:*)
      log "main ${sha:0:7}: REFUSED (${g#refuse:})"
      [[ $DRY -eq 1 ]] && exit 0
      echo "refused: ${g#refuse:} (D1)" > "$ST/refused.$sha"
      once_status refuse-statused "$sha" devos-deploy failure "$(cat "$ST/refused.$sha")" && touch "$ST/done.$sha"
      exit 0 ;;
  esac
  if [[ $DRY -eq 1 ]]; then log "main ${sha:0:7}: WOULD install, $([[ $deploy_on -eq 1 ]] && echo deploy || echo 'skip deploy (disabled)'), run checks"; exit 0; fi
  if self_update "$sha"; then
    touch "$ST/installed.$sha"; log "main ${sha:0:7}: installed $(ls "$BIN"/checks/*.sh 2>/dev/null | wc -l) checks + allow-listed scripts"
  else
    echo "refused: install failed at this SHA (allow-list or bash -n)" > "$ST/refused.$sha"
    once_status refuse-statused "$sha" devos-deploy failure "$(cat "$ST/refused.$sha")" && touch "$ST/done.$sha"
    exit 0
  fi
fi
[[ $DRY -eq 1 ]] && { log "main ${sha:0:7}: installed; WOULD continue deploy/checks/publication"; exit 0; }

if [[ $deploy_on -eq 1 ]]; then
  if [[ ! -e "$ST/deployed.$sha" ]]; then
    if deploy "$sha"; then echo "success deployed $sha" > "$ST/deployed.$sha"; echo "$sha" > "$ST/deployed.sha"
    else echo "failure deploy failed (not retried for this SHA)" > "$ST/deployed.$sha"; fi
    log "main ${sha:0:7}: $(cut -d' ' -f1 "$ST/deployed.$sha")"
  fi
  read -r dst ddesc < "$ST/deployed.$sha"
  once_status deploy-statused "$sha" devos-deploy "$dst" "$ddesc" || true
  [[ "$dst" == success ]] || { [[ -e "$ST/deploy-statused.$sha" ]] && touch "$ST/done.$sha"; exit 0; }
else
  log "main ${sha:0:7}: deploy disabled (first launch not approved by KK)"
fi

[[ -e "$ST/$sha.checks.state" ]] || run_checks "$sha"
publish_checks "$sha"
if [[ -e "$ST/check-statused.$sha" && -e "$ST/check-commented.$sha" ]] \
   && { [[ $deploy_on -eq 0 ]] || [[ -e "$ST/deploy-statused.$sha" ]]; }; then
  touch "$ST/done.$sha"; log "main ${sha:0:7}: done ($(cut -d' ' -f2- "$ST/$sha.checks.state"))"
fi

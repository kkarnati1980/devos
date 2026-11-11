#!/usr/bin/env bash
# DevOS — server agent: self-update, deploy-on-PASS and server checks for each passing main SHA (DEVOS-74)
# Version: 1.4.0
# v1.4.0 (DEVOS-90): server re-checks without a new main SHA. Every 6 hours, and within a tick (about 3 minutes)
# of a "/recheck" comment by an allowed author on the open draft tracking PR (head branch devos-recheck), the
# agent runs the installed checks again on the currently deployed SHA and posts a fresh server-check status.
# A re-check never self-updates, deploys or calls Coolify; nothing from the comment is executed.
# v1.3.0 (DEVOS-87, R3-d): the allow-list gains scripts/server/cert-renew.sh, run once a day at the start of a
# tick (never while a deployment is in flight); a failure is retried after an hour. An allow-listed file missing
# from bin/ (the list grew) is installed again from the already-installed, D1-passed SHA.
# v1.2.1 (Codex PR22-r1): the GIT_SHA read-back treats an explicit is_runtime/is_buildtime false as a failure.
# v1.2.0 (DEVOS-83): before a deploy is submitted, the app's git_commit_sha and its GIT_SHA env (build-time and
# runtime) are set to the exact SHA, so the image reports the code it was built from; either failing submits
# nothing and the next tick retries (both writes are idempotent).
# v1.1.2 (Codex PR11-r3): an earlier deployment's status must post before a newer deploy or check; a submitted
# deployment is reconciled even after --deploy-off.
# v1.1.0 (Codex PR11-r1): GitHub read errors (trees, statuses, PRs) mean "wait", never "ok"; every install step
# propagates failure; a deploy is never submitted twice (start + deployment-id markers, wall-clock budget, resume);
# a drain publishes results of earlier SHAs; markers are <name>.<sha> throughout; --dry-run never posts;
# workflow runs are read across all pages.
# v1.1.1 (Codex PR11-r2): an earlier SHA's in-flight deployment is finished (and its status posted) before a
# newer deploy starts; --dry-run creates no directories or lock file.
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
DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-900}"   # per tick; a longer deploy is resumed next tick
CHECK_TIMEOUT="${CHECK_TIMEOUT:-120}"
GH_ENV="$DIR/github-review.env"
CF_ENV="$DIR/coolify-deploy.env"
# The allow-list: the only files ever installed (checks are added from scripts/server/checks/*.sh).
ALLOW=(scripts/review/review-watch.sh scripts/review/review-commit.sh scripts/server/server-agent.sh scripts/server/cert-renew.sh)
CERT_EVERY="${CERT_EVERY:-86400}"       # R3-d: renew once a day
CERT_RETRY="${CERT_RETRY:-3600}"        # after a failed renewal, try again after an hour
RECHECK_EVERY="${RECHECK_EVERY:-21600}" # DEVOS-90: re-run the server checks every 6 hours
RECHECK_BRANCH="${RECHECK_BRANCH:-devos-recheck}"            # head branch of the draft tracking PR
RECHECK_AUTHORS="${RECHECK_AUTHORS:-${REPO%%/*}}"            # logins allowed to request; default the repo owner
DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "ERROR $*"; exit 1; }
if [[ $DRY -eq 0 ]]; then
  install -d -m 700 "$ST" "$BIN" "$BIN/checks"
  exec 8>>"$ST/agent.lock"   # append mode: never truncates; the installer takes the same lock
  flock -n 8 || { log "previous tick still running; skipping"; exit 0; }
elif [[ -e "$ST/agent.lock" ]]; then
  exec 8<"$ST/agent.lock"    # --dry-run: read-only, creates nothing
  flock -n 8 || { log "previous tick still running; skipping"; exit 0; }
fi

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


gh_all_runs() {  # sha -> all workflow runs for the SHA, every page (max 30 pages of 100)
  local page=1 chunk n acc='[]'
  while :; do
    chunk="$(gh GET "/repos/$REPO/actions/runs?head_sha=$1&per_page=100&page=$page")" || return 1
    chunk="$(jq -c '.workflow_runs' <<<"$chunk")" || return 1
    acc="$(jq -c --argjson c "$chunk" '. + $c' <<<"$acc")"
    n="$(jq 'length' <<<"$chunk")"
    if (( n < 100 )) || (( page >= 30 )); then break; fi
    page=$((page + 1))
  done
  printf '%s' "$acc"
}
ci_state() {  # sha -> prints green | pending | red ; returns 1 if workflow runs cannot be read
  local runs
  runs="$(gh_all_runs "$1")" || return 1
  jq -r '[group_by(.workflow_id)[] | max_by(.created_at)] as $l
         | if ($l | length) == 0 then "pending"
           elif any($l[]; .status != "completed") then "pending"
           elif all($l[]; .conclusion == "success" or .conclusion == "skipped" or .conclusion == "neutral") then "green"
           else "red" end' <<<"$runs"
}
codex_pass() {  # sha -> 0 PASS, 1 no PASS, 2 cannot read (combined status: latest state per context)
  local s
  s="$(gh GET "/repos/$REPO/commits/$1/status?per_page=100")" || return 2
  jq -e '[.statuses[]? | select(.context == "codex-review")] | first | .state == "success"' <<<"$s" >/dev/null && return 0
  return 1
}
tree_of() {  # sha -> tree sha; fails unless GitHub returned a valid 40-hex tree
  local t
  t="$(gh GET "/repos/$REPO/git/commits/$1" | jq -r '.tree.sha // empty')" || return 1
  [[ "$t" =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s' "$t"
}
merged_pr() {  # sha -> "number headsha" of the merged PR whose merge commit is sha (empty if none); 1 on read error
  local p
  p="$(gh GET "/repos/$REPO/commits/$1/pulls")" || return 1
  jq -r --arg s "$1" '[.[] | select(.merge_commit_sha == $s and .merged_at != null)] | first // empty | "\(.number) \(.head.sha)"' <<<"$p"
}

# gate sha -> prints ok | wait | refuse:<reason>. Any read error is "wait" (retried next tick), never "ok".
gate() {
  local sha="$1" ci pr="" head="" rc mp t1 t2
  ci="$(ci_state "$sha")" || { log "cannot read workflow runs (token needs Actions: Read)"; echo "wait"; return; }
  [[ "$ci" == pending ]] && { echo "wait"; return; }
  [[ "$ci" == red ]] && { echo "refuse:CI is not green"; return; }
  set +e; codex_pass "$sha"; rc=$?; set -e
  (( rc == 0 )) && { echo "ok"; return; }
  (( rc == 2 )) && { echo "wait"; return; }
  mp="$(merged_pr "$sha")" || { echo "wait"; return; }
  read -r pr head <<<"$mp"
  if [[ "$head" =~ ^[0-9a-f]{40}$ ]]; then
    set +e; codex_pass "$head"; rc=$?; set -e
    (( rc == 2 )) && { echo "wait"; return; }
    if (( rc == 0 )); then
      t1="$(tree_of "$sha")" || { echo "wait"; return; }
      t2="$(tree_of "$head")" || { echo "wait"; return; }
      [[ "$t1" == "$t2" ]] && { echo "ok"; return; }
      echo "refuse:merge tree differs from the PASSed head of PR #$pr"; return
    fi
  fi
  echo "refuse:no Codex PASS for this SHA"
}

status() {  # sha context state description
  jq -n --arg s "$3" --arg c "$2" --arg d "${4:0:140}" '{state: $s, context: $c, description: $d}' > "$TMP/st.json"
  gh POST "/repos/$REPO/statuses/$1" "$TMP/st.json" >/dev/null
}
once_status() {  # marker sha context state description: posted once; marker file is <marker>.<sha>
  local m="$ST/$1.$2"
  [[ -e "$m" ]] && return 0
  if status "$2" "$3" "$4" "$5"; then touch "$m"; else log "${2:0:7}: $3 status failed; will retry"; return 1; fi
}

self_update() {  # sha -> installs the allow-list at sha; 0 only if every step succeeded
  local sha="$1" f n stage="$TMP/stage"
  export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i /root/.ssh/devos_ro -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new}"
  if [[ ! -d "$WORK/.git" ]]; then timeout 120 git clone -q --no-checkout "$REMOTE" "$WORK" || return 1; fi
  timeout 120 git -C "$WORK" fetch -q --prune origin '+refs/heads/main:refs/remotes/origin/main' || return 1
  git -C "$WORK" checkout -q --force --detach "$sha" || return 1
  git -C "$WORK" clean -qfdx || return 1
  [[ "$(git -C "$WORK" rev-parse HEAD)" == "$sha" ]] || { log "checkout is not $sha"; return 1; }
  rm -rf "$stage"; mkdir -p "$stage/checks" || return 1
  for f in "${ALLOW[@]}"; do
    [[ -f "$WORK/$f" ]] || { log "allow-listed file missing at ${sha:0:7}: $f"; return 1; }
    bash -n "$WORK/$f" 2>"$TMP/syntax" || { log "bash -n failed: $f"; return 1; }
    install -m 700 "$WORK/$f" "$stage/$(basename "$f")" || return 1
  done
  for f in "$WORK"/scripts/server/checks/*.sh; do
    [[ -e "$f" ]] || continue
    n="$(basename "$f")"
    [[ "$n" =~ ^[A-Za-z0-9._-]+\.sh$ ]] || { log "bad check name: $n"; return 1; }
    bash -n "$f" 2>"$TMP/syntax" || { log "bash -n failed: scripts/server/checks/$n"; return 1; }
    install -m 700 "$f" "$stage/checks/$n" || return 1
  done
  # Everything is staged and valid: rename into place (a running script keeps its old inode).
  for f in "$stage"/*.sh; do
    n="$(basename "$f")"
    install -m 700 "$f" "$BIN/.$n.new" || return 1
    mv -f "$BIN/.$n.new" "$BIN/$n" || return 1
    cmp -s "$f" "$BIN/$n" || { log "installed $n differs from staged copy"; return 1; }
  done
  for f in "$BIN"/checks/*.sh; do
    [[ -e "$f" ]] || continue
    [[ -e "$stage/checks/$(basename "$f")" ]] || rm -f "$f" || return 1
  done
  for f in "$stage"/checks/*.sh; do
    [[ -e "$f" ]] || continue
    n="$(basename "$f")"
    install -m 700 "$f" "$BIN/checks/.$n.new" || return 1
    mv -f "$BIN/checks/.$n.new" "$BIN/checks/$n" || return 1
    cmp -s "$f" "$BIN/checks/$n" || { log "installed check $n differs from staged copy"; return 1; }
  done
  printf '%s\n' "$sha" > "$ST/installed.sha.new" && mv -f "$ST/installed.sha.new" "$ST/installed.sha" || return 1
  return 0
}

# set_git_sha_env sha -> upserts the app env GIT_SHA=<sha> as build-time AND runtime, then reads it back.
# deploy/compose.yaml passes GIT_SHA as a build arg; Coolify passes only build-time variables to the build, so
# without this the image reports "unknown" (DEVOS-83). Coolify renamed is_build_time to is_buildtime (with a
# separate is_runtime); the flag names are taken from the variables this Coolify already returns.
set_git_sha_env() {
  local sha="$1" envs
  envs="$(cf GET "/applications/$CF_APP/envs")" || return 1
  jq -e 'type == "array"' <<<"$envs" >/dev/null 2>&1 || { log "Coolify envs: unexpected response"; return 1; }
  if jq -e 'any(.[]; has("is_buildtime") or has("is_runtime"))' <<<"$envs" >/dev/null; then
    jq -n --arg v "$sha" '{data: [{key: "GIT_SHA", value: $v, is_preview: false, is_buildtime: true, is_runtime: true}]}'
  else
    jq -n --arg v "$sha" '{data: [{key: "GIT_SHA", value: $v, is_preview: false, is_build_time: true}]}'
  fi > "$TMP/env.json"
  cf PATCH "/applications/$CF_APP/envs/bulk" "$TMP/env.json" >/dev/null || return 1
  envs="$(cf GET "/applications/$CF_APP/envs")" || return 1
  # Read back: the non-preview GIT_SHA exists, is build-time (and runtime where Coolify has that flag), and its
  # value is this SHA. Flags are read with has(), not jq's //, because // also replaces an explicit false
  # (Codex PR22-r1): an explicit is_runtime:false or is_buildtime:false fails the read-back (a token without read:sensitive gets no values back; then presence and flags are checked).
  jq -e --arg v "$sha" '[.[]? | select(.key == "GIT_SHA" and ((.is_preview // false) == false))] as $g
    | ($g | length) > 0
      and all($g[]; (if has("is_buildtime") then .is_buildtime else .is_build_time end) == true
                    and ((has("is_runtime") | not) or .is_runtime == true)
                    and ((has("value") | not) or .value == null or .value == $v))' <<<"$envs" >/dev/null \
    || { log "Coolify env GIT_SHA did not read back as build-time + runtime ${sha:0:7}"; return 1; }
}

# Deploy is never submitted twice for a SHA. deploy-started.<sha> is written before the first Coolify call;
# deploy-uuid.<sha> holds the deployment id once Coolify returns it. A later tick resumes polling that id; a
# start marker without an id (interrupted mid-submit) is recorded as an unknown outcome, never resubmitted.
deploy() {  # sha -> 0 when Coolify finished deploying exactly this sha
  local sha="$1" dep st deadline
  [[ -n "$CF_TOKEN_FILE" && "${CF_APP:-}" =~ ^[A-Za-z0-9-]+$ ]] || { log "Coolify token or app uuid missing"; return 1; }
  if [[ -s "$ST/deploy-uuid.$sha" ]]; then
    dep="$(cat "$ST/deploy-uuid.$sha")"; log "${sha:0:7}: resuming deployment ${dep:0:8}"
  elif [[ -e "$ST/deploy-started.$sha" ]]; then
    log "${sha:0:7}: an earlier tick was interrupted while submitting; outcome unknown, not resubmitted"; return 1
  else
    # Idempotent preparation first: a failure here has submitted nothing, so the next tick simply retries.
    jq -n --arg s "$sha" '{git_commit_sha: $s}' > "$TMP/patch.json"
    cf PATCH "/applications/$CF_APP" "$TMP/patch.json" >/dev/null \
      || { log "${sha:0:7}: could not set git_commit_sha; deploy not started, next tick retries"; return 2; }
    set_git_sha_env "$sha" \
      || { log "${sha:0:7}: could not set GIT_SHA in the Coolify env; deploy not started, next tick retries"; return 2; }
    touch "$ST/deploy-started.$sha" || return 1
    dep="$(cf POST "/deploy?uuid=$CF_APP&force=false" | jq -r '[.. | objects | .deployment_uuid? // empty] | first // empty')" || return 1
    [[ "$dep" =~ ^[A-Za-z0-9-]+$ ]] || { log "deploy returned no deployment uuid"; return 1; }
    printf '%s\n' "$dep" > "$ST/deploy-uuid.$sha"
  fi
  deadline=$(( $(date +%s) + DEPLOY_TIMEOUT ))   # wall clock, so slow GETs count against the budget
  while (( $(date +%s) < deadline )); do
    st="$(cf GET "/deployments/$dep" | jq -r '.status // empty')" || st=""
    case "$st" in
      finished|success) return 0 ;;
      failed|error|cancelled*) log "deployment ${dep:0:8}: $st"; return 1 ;;
    esac
    sleep "$POLL_SEC"
  done
  log "deployment ${dep:0:8}: still running at the time limit; the next tick resumes it"; return 2
}

run_checks() {  # sha [out-prefix] -> writes <prefix>.checks.md and <prefix>.checks.state ("state description")
  local sha="$1" out="${2:-$ST/$1}" title="${3:-Server checks}" f n rc pass=0 fail=0 skip=0 res total desc
  printf '### %s at `%s`\n\n| Check | Result |\n|---|---|\n' "$title" "$sha" > "$TMP/head.md"
  : > "$TMP/body.md"
  for f in "$BIN"/checks/*.sh; do
    [[ -e "$f" ]] || continue
    n="$(basename "$f" .sh)"
    set +e; DEVOS_SHA="$sha" DEVOS_DIR="$DIR" timeout "$CHECK_TIMEOUT" bash "$f" > "$TMP/check.out" 2>&1 </dev/null; rc=$?; set -e
    case "$rc" in 0) res=pass; pass=$((pass+1));; 3) res=skipped; skip=$((skip+1));; 124) res="fail (timeout)"; fail=$((fail+1));; *) res="fail (exit $rc)"; fail=$((fail+1));; esac
    printf '| `%s` | %s |\n' "$n" "$res" >> "$TMP/head.md"
    { printf '\n<details><summary>%s — %s</summary>\n\n```\n' "$n" "$res"; tail -n 20 "$TMP/check.out" | redact; printf '```\n</details>\n'; } >> "$TMP/body.md"
  done
  cat "$TMP/head.md" "$TMP/body.md" | redact > "$out.checks.md"
  total=$((pass + fail + skip)); desc="$pass/$total passed"; (( skip > 0 )) && desc="$desc, $skip skipped"
  if (( total == 0 )); then echo "failure no server checks installed" > "$out.checks.state"
  elif (( fail == 0 )); then echo "success $desc" > "$out.checks.state"
  else echo "failure $desc" > "$out.checks.state"; fi
}

# publish sha -> posts every result stored for sha that has not been posted yet; marks done.<sha> when the
# SHA needs nothing more. Used for the current main SHA and, in the drain, for every earlier SHA.
publish() {
  local sha="$1" st desc pr head mp
  if [[ -e "$ST/refused.$sha" ]]; then
    once_status refuse-statused "$sha" devos-deploy failure "$(cat "$ST/refused.$sha")" && touch "$ST/done.$sha"
    return 0
  fi
  if [[ -s "$ST/deployed.$sha" ]]; then
    read -r st desc < "$ST/deployed.$sha"
    once_status deploy-statused "$sha" devos-deploy "$st" "$desc" || true
    if [[ "$st" != success || -e "$ST/superseded.$sha" ]]; then [[ -e "$ST/deploy-statused.$sha" ]] && touch "$ST/done.$sha"; return 0; fi
  fi
  [[ -s "$ST/$sha.checks.state" ]] || return 0
  read -r st desc < "$ST/$sha.checks.state"
  once_status check-statused "$sha" server-check "$st" "$desc" || true
  if [[ ! -e "$ST/check-commented.$sha" ]]; then
    jq -Rs '{body: .}' "$ST/$sha.checks.md" > "$TMP/c.json"
    if mp="$(merged_pr "$sha")"; then
      read -r pr head <<<"$mp"
      if [[ "$pr" =~ ^[0-9]+$ ]]; then gh POST "/repos/$REPO/issues/$pr/comments" "$TMP/c.json" >/dev/null && touch "$ST/check-commented.$sha"
      else gh POST "/repos/$REPO/commits/$sha/comments" "$TMP/c.json" >/dev/null && touch "$ST/check-commented.$sha"; fi
    fi
    [[ -e "$ST/check-commented.$sha" ]] || log "${sha:0:7}: check comment failed; will retry"
  fi
  if [[ -e "$ST/check-statused.$sha" && -e "$ST/check-commented.$sha" ]] \
     && { [[ ! -s "$ST/deployed.$sha" ]] || [[ -e "$ST/deploy-statused.$sha" ]]; }; then
    touch "$ST/done.$sha"; log "${sha:0:7}: done ($desc)"
  fi
}

# R3-d (DEVOS-87): the daily certificate renewal. Runs before anything that needs GitHub, so it also runs while
# GitHub is unreachable; skipped while any deployment is in flight (it restarts the api and the dashboard).
# Its output is redacted into the agent log; the last result is kept in cert-renew.state.
cert_renewal() {
  local now last f rc next st
  now="$(date +%s)"
  last="$(sed -n '1s/^\([0-9]\{1,12\}\) .*/\1/p' "$ST/cert-renew.state" 2>/dev/null || true)"; last="${last:-0}"
  next="$CERT_EVERY"; grep -q '^[0-9]* fail' "$ST/cert-renew.state" 2>/dev/null && next="$CERT_RETRY"
  (( now - last >= next )) || return 0
  [[ -f "$BIN/cert-renew.sh" ]] || { log "cert renewal not installed yet"; return 0; }
  for f in "$ST"/deploy-started.*; do
    [[ -e "$f" ]] || continue
    [[ -s "$ST/deployed.${f##*/deploy-started.}" ]] || { log "cert renewal deferred: a deployment is in flight"; return 0; }
  done
  if [[ $DRY -eq 1 ]]; then log "WOULD run the daily cert renewal"; return 0; fi
  set +e; DEVOS_DIR="$DIR" timeout 300 bash "$BIN/cert-renew.sh" > "$TMP/cert.out" 2>&1 </dev/null; rc=$?; set -e
  redact < "$TMP/cert.out" | tail -n 20 | while IFS= read -r l; do log "cert-renew: $l"; done
  case "$rc" in 0) st=ok;; 3) st=skipped;; *) st="fail (exit $rc)";; esac
  printf '%s %s\n' "$now" "$st" > "$ST/cert-renew.state.new" && mv -f "$ST/cert-renew.state.new" "$ST/cert-renew.state"
  log "cert renewal: $st"
}

# The allow-list grew (v1.3.0): the SHA that installed it ran an older agent with the shorter list, so a new
# allow-listed file is missing from bin/. Install again from the recorded SHA (it already passed D1).
repair_allowlist() {
  local f sha
  [[ $DRY -eq 0 && -s "$ST/installed.sha" ]] || return 0
  for f in "${ALLOW[@]}"; do
    [[ -f "$BIN/$(basename "$f")" ]] && continue
    sha="$(head -n1 "$ST/installed.sha")"
    [[ "$sha" =~ ^[0-9a-f]{40}$ && -e "$ST/installed.$sha" ]] || return 0
    log "allow-listed $(basename "$f") missing from bin/; installing again from ${sha:0:7}"
    self_update "$sha" || log "re-install from ${sha:0:7} failed; next tick retries"
    return 0
  done
}

# ---- DEVOS-90: re-checks without a new main SHA ----
# The request channel is the open DRAFT pull request whose head branch is $RECHECK_BRANCH (drafts are never
# reviewed by the watcher and never merged). Its comments are read with the existing token (Pull requests: Read);
# a GitHub issue would need Issues permission, which this token does not have. A request is a comment whose whole
# body is "/recheck", written by a login in $RECHECK_AUTHORS. Comment ids already seen are in recheck.last-id;
# the first scan only records a baseline, so old comments never fire.
allowed_author() { local a; for a in $RECHECK_AUTHORS; do [[ "$1" == "$a" ]] && return 0; done; return 1; }
recheck_pr() {  # -> number of the tracking PR (empty if none); 1 on read error
  local p
  p="$(gh GET "/repos/$REPO/pulls?state=open&head=${REPO%%/*}:$RECHECK_BRANCH&per_page=100")" || return 1
  jq -r --arg b "$RECHECK_BRANCH" --arg a " $RECHECK_AUTHORS " '[.[]? | select(.head.ref == $b and .draft == true
      and ((.user.login // "") as $u | $u != "" and ($a | contains(" " + $u + " "))))] | min_by(.number) // empty | .number' <<<"$p"
}
scan_requests() {  # sets recheck.requested when an allowed /recheck is new; never fatal
  local pr page=1 chunk acc='[]' n last max since="" q=""
  pr="$(recheck_pr)" || { log "re-check: cannot read the tracking PR; next tick"; return 0; }
  [[ "$pr" =~ ^[0-9]+$ ]] || return 0
  # Only comments updated since the last one seen are read (GitHub's since= filter), so a long thread stays cheap.
  since="$(sed -n '1s/^[0-9]\{1,20\} \([0-9TZ:-]\{20\}\)$/\1/p' "$ST/recheck.last-id" 2>/dev/null || true)"
  [[ -n "$since" ]] && q="&since=$since"
  while :; do
    chunk="$(gh GET "/repos/$REPO/issues/$pr/comments?per_page=100&page=$page$q")" || { log "re-check: cannot read PR #$pr comments; next tick"; return 0; }
    chunk="$(jq -c '[.[]? | {id, login: .user.login, body, at: (.updated_at // "")}]' <<<"$chunk")" || return 0
    acc="$(jq -c --argjson c "$chunk" '. + $c' <<<"$acc")"
    n="$(jq 'length' <<<"$chunk")"
    if (( n < 100 )) || (( page >= 30 )); then break; fi
    page=$((page + 1))
  done
  if (( n >= 100 && page >= 30 )); then log "re-check: more than 3000 new comments on PR #$pr; only the first 3000 were read"; fi
  max="$(jq -r 'max_by(.id) // {id: 0, at: ""} | "\(.id) \(.at)"' <<<"$acc")"
  [[ "$max" =~ ^[0-9]+\ ([0-9TZ:-]{20})?$ ]] || return 0
  if [[ ! -s "$ST/recheck.last-id" ]]; then
    [[ $DRY -eq 1 ]] && { log "re-check: WOULD record the comment baseline on PR #$pr"; return 0; }
    echo "$max" > "$ST/recheck.last-id"; log "re-check: comment baseline recorded on PR #$pr"; return 0
  fi
  last="$(head -n1 "$ST/recheck.last-id" | cut -d' ' -f1)"; [[ "$last" =~ ^[0-9]+$ ]] || last=0
  local id login body hit=""
  while IFS=$'\t' read -r id login body; do
    [[ "$id" =~ ^[0-9]+$ ]] || continue
    if allowed_author "$login"; then hit="$id"
    else log "re-check: ignored /recheck from a login that is not allowed ($(tr -cd 'A-Za-z0-9[]-' <<<"$login" | head -c 40))"; fi
  done < <(jq -r --argjson l "$last" '.[] | select(.id > $l and ((.body // "") | gsub("^\\s+|\\s+$"; "")) == "/recheck")
             | [.id, (.login // ""), "x"] | @tsv' <<<"$acc")
  [[ $DRY -eq 1 ]] && { [[ -n "$hit" ]] && log "re-check: WOULD act on the /recheck request on PR #$pr"; return 0; }
  [[ -n "$hit" ]] && { echo "$pr $hit" > "$ST/recheck.requested"; log "re-check requested on PR #$pr"; }
  (( ${max%% *} > last )) && echo "$max" > "$ST/recheck.last-id"
  return 0
}
recheck_target() {  # -> the SHA that is live now: the last successful deploy, else (deploy off) the installed SHA
  local s=""
  if [[ -s "$ST/deployed.sha" ]]; then
    s="$(head -n1 "$ST/deployed.sha")"
    [[ "$(cut -d' ' -f1 "$ST/deployed.$s" 2>/dev/null)" == success ]] || s=""
  elif [[ ! -e "$ST/deploy.enabled" && -s "$ST/installed.sha" ]]; then
    s="$(head -n1 "$ST/installed.sha")"
  fi
  [[ "$s" =~ ^[0-9a-f]{40}$ && -e "$ST/done.$s" && -e "$ST/installed.$s" ]] || return 0
  printf '%s' "$s"
}
# A post that keeps failing (e.g. the tracking PR was closed) must not block re-checks for good: after
# RECHECK_MAX_FAILS failed attempts in a row the stored result is dropped, logged, and re-checks carry on.
RECHECK_MAX_FAILS="${RECHECK_MAX_FAILS:-20}"
recheck_failed() {
  local n; n="$(cat "$ST/recheck.fails" 2>/dev/null || echo 0)"; [[ "$n" =~ ^[0-9]+$ ]] || n=0; n=$((n + 1))
  if (( n >= RECHECK_MAX_FAILS )); then
    log "$1; gave up after $n attempts, result dropped"; rm -f "$ST/recheck.result" "$ST/recheck.statused" "$ST/recheck.fails"
  else echo "$n" > "$ST/recheck.fails"; log "$1; will retry ($n/$RECHECK_MAX_FAILS)"; fi
}
publish_recheck() {  # posts a stored re-check result; kept for the next tick when the post fails
  local sha st desc pr c
  [[ -s "$ST/recheck.result" ]] || return 0
  read -r sha pr st desc < "$ST/recheck.result" || true
  if ! [[ "$sha" =~ ^[0-9a-f]{40}$ && ( "$pr" == - || "$pr" =~ ^[0-9]+$ ) && "$st" =~ ^(success|failure)$ && -s "$ST/recheck.checks.md" ]]; then
    log "re-check: stored result is unreadable; dropped"; rm -f "$ST/recheck.result" "$ST/recheck.statused" "$ST/recheck.fails"; return 0
  fi
  if [[ ! -e "$ST/recheck.statused" ]]; then
    if status "$sha" server-check "$st" "re-check: $desc"; then touch "$ST/recheck.statused"
    else recheck_failed "${sha:0:7}: re-check status failed"; return 0; fi
  fi
  if [[ "$pr" =~ ^[0-9]+$ ]]; then
    jq -Rs '{body: .}' "$ST/recheck.checks.md" > "$TMP/rc.json"
    gh POST "/repos/$REPO/issues/$pr/comments" "$TMP/rc.json" >/dev/null || { recheck_failed "re-check comment failed"; return 0; }
  fi
  rm -f "$ST/recheck.result" "$ST/recheck.statused" "$ST/recheck.fails"
  log "${sha:0:7}: re-check posted ($st $desc)"
}
# recheck_tick: runs only after the normal flow has finished for the live SHA, and never while a deployment is
# in flight. It runs the installed checks and posts server-check on that SHA; it never installs or deploys.
recheck_tick() {
  local now last sha why="" f pr=""
  [[ $DRY -eq 0 ]] && publish_recheck
  [[ $DRY -eq 0 && -s "$ST/recheck.result" ]] && return 0   # an earlier result is still unposted
  scan_requests
  now="$(date +%s)"
  last="$(sed -n '1s/^\([0-9]\{1,12\}\).*/\1/p' "$ST/recheck.state" 2>/dev/null || true)"
  if [[ -z "$last" ]]; then
    [[ $DRY -eq 0 ]] && echo "$now baseline" > "$ST/recheck.state"   # first sight: the next timed re-check is in 6 h
    last="$now"
  fi
  [[ -s "$ST/recheck.requested" ]] && { why=request; read -r pr _ < "$ST/recheck.requested"; }
  [[ -z "$why" ]] && (( now - last >= RECHECK_EVERY )) && why=timer
  [[ -n "$why" ]] || return 0
  for f in "$ST"/deploy-started.*; do
    [[ -e "$f" ]] || continue
    [[ -s "$ST/deployed.${f##*/deploy-started.}" ]] || { log "re-check deferred: a deployment is in flight"; return 0; }
  done
  sha="$(recheck_target)"
  [[ -n "$sha" ]] || { log "re-check deferred: no deployed SHA has finished its normal checks yet"; return 0; }
  [[ $DRY -eq 1 ]] && { log "${sha:0:7}: WOULD re-check ($why)"; return 0; }
  run_checks "$sha" "$ST/recheck" "Server re-check ($why)"
  echo "$now $sha $why" > "$ST/recheck.state"
  { printf '%s %s ' "$sha" "${pr:--}"; cat "$ST/recheck.checks.state"; } > "$ST/recheck.result"
  rm -f "$ST/recheck.requested"
  log "${sha:0:7}: re-check ($why) $(cat "$ST/recheck.checks.state")"
  publish_recheck
}

# ---- tick ----
repair_allowlist
cert_renewal
sha="$(gh GET "/repos/$REPO/commits/main" | jq -r '.sha')" || die "cannot read main"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "bad main sha"
deploy_on=0; [[ -e "$ST/deploy.enabled" ]] && deploy_on=1

# Drain 1: an earlier SHA's deployment that is still in flight (or was interrupted mid-submit) is finished
# first; only its devos-deploy status is posted (server checks run for the current main SHA only). A newer
# deploy is never submitted while an older one is running.
for f in "$ST"/deploy-started.*; do
  [[ -e "$f" ]] || continue
  s="${f##*/deploy-started.}"
  [[ "$s" =~ ^[0-9a-f]{40}$ && "$s" != "$sha" && ! -s "$ST/deployed.$s" ]] || continue
  if [[ $DRY -eq 1 ]]; then log "${s:0:7}: WOULD resume the earlier deployment"; exit 0; fi
  set +e; deploy "$s"; rc=$?; set -e
  case "$rc" in
    0) echo "success deployed $s (superseded by ${sha:0:7}; checks run on main only)" > "$ST/deployed.$s"; echo "$s" > "$ST/deployed.sha" ;;
    2) log "${s:0:7}: earlier deployment still running; main ${sha:0:7} waits"; exit 0 ;;
    *) echo "failure deploy failed (not retried for this SHA)" > "$ST/deployed.$s" ;;
  esac
  touch "$ST/superseded.$s"
done
# An earlier deployment's result must be posted before anything newer is deployed or checked.
for f in "$ST"/deployed.*; do
  [[ -e "$f" ]] || continue
  s="${f##*/deployed.}"
  [[ "$s" =~ ^[0-9a-f]{40}$ && "$s" != "$sha" && ! -e "$ST/deploy-statused.$s" ]] || continue
  if [[ $DRY -eq 1 ]]; then log "${s:0:7}: WOULD post the earlier deployment's status first"; exit 0; fi
  publish "$s"
  [[ -e "$ST/deploy-statused.$s" ]] || { log "${s:0:7}: earlier deployment status not posted yet; main ${sha:0:7} waits"; exit 0; }
done
# Drain 2: earlier SHAs with stored results whose publication is incomplete (main has moved on since).
for f in "$ST"/refused.* "$ST"/deployed.* "$ST"/*.checks.state; do
  [[ -e "$f" ]] || continue
  s="$(basename "$f")"; s="${s#refused.}"; s="${s#deployed.}"; s="${s%.checks.state}"
  [[ "$s" =~ ^[0-9a-f]{40}$ && "$s" != "$sha" && ! -e "$ST/done.$s" ]] || continue
  if [[ $DRY -eq 1 ]]; then log "${s:0:7}: WOULD retry publication (no longer main)"; continue; fi
  publish "$s"
done

if [[ -e "$ST/done.$sha" ]]; then log "main ${sha:0:7}: already handled"; recheck_tick; exit 0; fi
if [[ -e "$ST/refused.$sha" ]]; then
  [[ $DRY -eq 1 ]] && { log "main ${sha:0:7}: refused; WOULD retry publication"; exit 0; }
  publish "$sha"; exit 0
fi

if [[ ! -e "$ST/installed.$sha" ]]; then
  g="$(gate "$sha")"
  case "$g" in
    wait) log "main ${sha:0:7}: CI not finished or GitHub unreadable; next tick"; exit 0 ;;
    refuse:*)
      log "main ${sha:0:7}: REFUSED (${g#refuse:})"
      [[ $DRY -eq 1 ]] && exit 0
      echo "refused: ${g#refuse:} (D1)" > "$ST/refused.$sha"
      publish "$sha"; exit 0 ;;
  esac
  if [[ $DRY -eq 1 ]]; then log "main ${sha:0:7}: WOULD install, $([[ $deploy_on -eq 1 ]] && echo deploy || echo 'skip deploy (disabled)'), run checks"; exit 0; fi
  if self_update "$sha"; then
    touch "$ST/installed.$sha"; log "main ${sha:0:7}: installed allow-listed scripts and $(find "$BIN/checks" -name '*.sh' | wc -l) checks"
  else
    echo "refused: install failed at this SHA (allow-list, bash -n or file write)" > "$ST/refused.$sha"
    publish "$sha"; exit 0
  fi
fi
[[ $DRY -eq 1 ]] && { log "main ${sha:0:7}: installed; WOULD continue deploy/checks/publication"; exit 0; }

# A deployment already submitted for this SHA is always reconciled, even if deploy was turned off since
# (deploy() only resumes or records it then; it submits only when no start marker exists).
if [[ $deploy_on -eq 1 || -e "$ST/deploy-started.$sha" ]]; then
  if [[ ! -s "$ST/deployed.$sha" ]]; then
    set +e; deploy "$sha"; rc=$?; set -e
    case "$rc" in
      0) echo "success deployed $sha" > "$ST/deployed.$sha"; echo "$sha" > "$ST/deployed.sha" ;;
      2) exit 0 ;;   # still running: resumed next tick
      *) echo "failure deploy failed (not retried for this SHA)" > "$ST/deployed.$sha" ;;
    esac
    log "main ${sha:0:7}: $(cut -d' ' -f1 "$ST/deployed.$sha")"
  fi
  [[ "$(cut -d' ' -f1 "$ST/deployed.$sha")" == success ]] || { publish "$sha"; exit 0; }
else
  log "main ${sha:0:7}: deploy disabled (first launch not approved by KK)"
fi

if [[ ! -s "$ST/$sha.checks.state" ]]; then
  run_checks "$sha"
  echo "$(date +%s) $sha normal" > "$ST/recheck.state"   # DEVOS-90: the 6-hour clock restarts after normal checks
fi
publish "$sha"
[[ -e "$ST/done.$sha" ]] && recheck_tick
exit 0

#!/usr/bin/env bash
# DevOS — review watcher: run the Codex review automatically on each new PR head (DEVOS-60)
# Version: 1.2.0
# v1.2.0 (DEVOS-115, 12 Nov 2026): the repo is public, so only PRs whose head is in kkarnati1980/devos and
# whose author is on REVIEW_AUTHORS (default: kkarnati1980) are reviewed or published on. A fork or
# stranger's PR is logged once per head as "external PR, not reviewed" and nothing is posted on it.
# v1.1.2 (Codex PR9-r4): a stored manual verdict records its PR number before publishing, so the drain can
# complete it after the PR moves on.
# v1.1.1 (Codex PR9-r3): pending publications are drained for every stored SHA, including ones a PR has
# moved past; at most one review runs per tick, so the runner's 900 s limit always fits inside the service's
# 1200 s TimeoutStartSec; verdict comments are redacted like runner logs.
# v1.1.0 (Codex PR9-r2): publication is tracked per SHA (comment and status separately) and retried on
# later ticks until both succeed, so a transient API failure never loses a verdict; open PRs and workflow
# runs are read across all pages.
# v1.0.2: CI state comes from the Actions API (workflow runs for the head SHA, latest run per workflow);
# fine-grained personal tokens cannot hold Checks: Read, so the check-runs API is not used. Needs Actions: Read.
# v1.0.1 (first server run, 5 Nov 2026): log() writes to stderr, so API errors are visible instead of being
# captured into variables; an unreadable check-runs API is reported as a token problem, not as "CI not green".
#
# Runs on the DevOS server from a systemd timer (installed by install-review-watch.sh). Each tick:
#   1. lists open, non-draft PRs on kkarnati1980/devos whose head is in that repo and whose author is on
#      REVIEW_AUTHORS (v1.2.0); any other PR is logged once and nothing is posted on it;
#   2. for each PR whose head SHA has no stored verdict yet, and whose CI check runs have all
#      completed successfully per the Actions API (Codex never sees failing code — PRD build loop step 4), reads the
#      contract path from the PR body line `Review-Contract: docs/modules/<id>.md`;
#   3. runs /root/.devos/bin/review-commit.sh main <sha> <contract> PR<n>-r<k> (unchanged M0.3 runner:
#      read-only deploy key, pristine checkout, schema-validated verdict per SHA);
#   4. posts the verdict as a PR comment and sets the commit status `codex-review` on that SHA.
# D1 is unchanged: Codex reviews the exact SHA; merging still needs green CI + PASS on that SHA.
#
# Usage:  review-watch.sh [--dry-run]     (--dry-run: report what would be reviewed, change nothing)
# Token:  /root/.devos/github-review.env (600), GITHUB_REVIEW_TOKEN=..., fine-grained, devos repo only:
#         Pull requests RW, Commit statuses RW, Actions R, Contents R, Metadata R. Read with sed, never sourced,
#         passed to curl via a 600 header file, never printed.
set -euo pipefail

REPO="kkarnati1980/devos"
API="${GITHUB_API:-https://api.github.com}"
DIR="${DEVOS_DIR:-/root/.devos}"
RUNNER="${REVIEW_RUNNER:-$DIR/bin/review-commit.sh}"
VDIR="$DIR/verdicts"
STATE="$DIR/watch"
ENVF="$DIR/github-review.env"
DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
REVIEW_AUTHORS="${REVIEW_AUTHORS:-kkarnati1980}"   # space-separated GitHub logins whose PRs are reviewed
trusted_pr() {  # one PR object on stdin -> 0 only when its head is in $REPO and its author is on REVIEW_AUTHORS
  jq -e --arg r "$REPO" --arg a " $REVIEW_AUTHORS " \
    '((.head.repo.full_name // "") == $r) and ((.user.login // "") as $u | $u != "" and ($u | test("^[A-Za-z0-9-]+$"))
      and ($a | contains(" " + $u + " ")))' >/dev/null
}
die() { log "ERROR $*"; exit 1; }
install -d -m 700 "$STATE"
exec 8>"$STATE/watch.lock"
flock -n 8 || { log "previous tick still running; skipping"; exit 0; }

TMP="$(mktemp -d)"; chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
[[ -s "$ENVF" ]] || die "missing $ENVF (run install-review-watch.sh)"
( umask 077; printf 'Authorization: Bearer %s\n' "$(sed -n 's/^GITHUB_REVIEW_TOKEN=//p' "$ENVF" | head -n1 | tr -d '\r\n')" > "$TMP/auth" )
gh_api() {  # method path [json-body-file] -> body on stdout; non-2xx is an error
  local method="$1" path="$2" body="${3:-}" code
  local args=(-sS -o "$TMP/resp" -w '%{http_code}' -X "$method" -H @"$TMP/auth"
              -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28')
  [[ -n "$body" ]] && args+=(-H 'Content-Type: application/json' --data-binary @"$body")
  code="$(curl "${args[@]}" "$API$path")" || { log "curl failed: $method $path"; return 1; }
  [[ "$code" =~ ^2 ]] || { log "HTTP $code: $method $path"; return 1; }
  cat "$TMP/resp"
}
redact() { sed -E 's/(sk-[A-Za-z0-9_*.-]{6})[A-Za-z0-9_*.-]*/\1[redacted]/g; s/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/\1[redacted]/g'; }

# All pages of a list endpoint. path must already contain '?'. key: JSON field holding the array ('' = top level).
# v1.1.3: pages are merged through temp files, never passed as a jq argument. A page larger than the kernel's
# per-argument limit (128 KiB; 15 open PRs with long bodies on 11 Nov) made `jq --argjson` fail with
# "Argument list too long", the list came back empty, and no PR was reviewed (DEVOS-113).
gh_all() {
  local path="$1" key="$2" page=1 n acc chunk
  acc="$(mktemp "$TMP/all.XXXXXX")"; chunk="$(mktemp "$TMP/page.XXXXXX")"
  printf '[]' > "$acc"
  while :; do
    gh_api GET "${path}&per_page=100&page=${page}" > "$chunk" || { rm -f "$acc" "$chunk"; return 1; }
    if [[ -n "$key" ]]; then jq -c ".${key}" "$chunk" > "$chunk.k" && mv "$chunk.k" "$chunk" || { rm -f "$acc" "$chunk"; return 1; }; fi
    jq -c -s '.[0] + .[1]' "$acc" "$chunk" > "$acc.n" && mv "$acc.n" "$acc" || { rm -f "$acc" "$chunk"; return 1; }
    n="$(jq 'length' "$chunk")"
    if (( n < 100 )) || (( page >= 30 )); then break; fi
    page=$((page + 1))
  done
  cat "$acc"; rm -f "$acc" "$chunk"
}

ci_green() {  # sha -> 0 green; 1 not green; 3 cannot read workflow runs (token lacks Actions: Read)
  # All DevOS CI is GitHub Actions. Take the latest run of each workflow for this SHA (all pages); every one
  # must have completed with success/skipped/neutral, and there must be at least one.
  local runs
  runs="$(gh_all "/repos/$REPO/actions/runs?head_sha=$1" workflow_runs)" || return 3
  jq -e '[group_by(.workflow_id)[] | max_by(.created_at)] as $latest
         | ($latest | length) > 0 and all($latest[]; .status == "completed"
           and (.conclusion == "success" or .conclusion == "skipped" or .conclusion == "neutral"))' \
     <<<"$runs" >/dev/null
}

set_status() {  # sha state description
  jq -n --arg s "$2" --arg d "${3:0:140}" '{state: $s, context: "codex-review", description: $d}' > "$TMP/status.json"
  gh_api POST "/repos/$REPO/statuses/$1" "$TMP/status.json" >/dev/null
}

comment() {  # pr markdown-file
  jq -Rs '{body: .}' "$2" > "$TMP/comment.json"
  gh_api POST "/repos/$REPO/issues/$1/comments" "$TMP/comment.json" >/dev/null
}

# Per-SHA state in $STATE:
#   <sha>.pr / <sha>.label   PR number and review label, written when the review runs
#   <sha>.msg                the comment to publish (verdict or could-not-run report)
#   <sha>.state              final status to publish: "<success|failure|error> <description>"
#   <sha>.commented, <sha>.statused   publication steps that succeeded (each done exactly once)
#   <sha>.published          both done; <sha>.done is the v1.0.x equivalent
published() { [[ -e "$STATE/$1.published" || -e "$STATE/$1.done" ]]; }
publish() {  # pr sha -> 0 when comment and final status are both posted (retried on later ticks otherwise)
  local pr="$1" sha="$2" st desc
  [[ -s "$STATE/$sha.msg" && -s "$STATE/$sha.state" ]] || { log "PR #$pr ${sha:0:7}: nothing to publish"; return 1; }
  if [[ ! -e "$STATE/$sha.commented" ]]; then
    if comment "$pr" "$STATE/$sha.msg"; then touch "$STATE/$sha.commented"; else log "PR #$pr ${sha:0:7}: comment failed; will retry"; fi
  fi
  if [[ ! -e "$STATE/$sha.statused" ]]; then
    read -r st desc < "$STATE/$sha.state"
    if set_status "$sha" "$st" "$desc"; then touch "$STATE/$sha.statused"; else log "PR #$pr ${sha:0:7}: status failed; will retry"; fi
  fi
  if [[ -e "$STATE/$sha.commented" && -e "$STATE/$sha.statused" ]]; then touch "$STATE/$sha.published"; return 0; fi
  return 1
}

verdict_msg() {  # sha label contract -> writes <sha>.msg and <sha>.state from the stored verdict
  local sha="$1" label="$2" contract="$3" v
  v="$(jq -r .verdict "$VDIR/$sha.json")"
  {
    printf '### Codex review %s — **%s**\n\n' "$label" "$v"
    printf -- '- **Commit:** `%s`\n- **Contract:** `%s`\n- **Summary:** %s\n\n' "$sha" "$contract" "$(jq -r .summary "$VDIR/$sha.json")"
    if [[ "$(jq '.findings | length' "$VDIR/$sha.json")" -gt 0 ]]; then
      printf '| Severity | File:line | Evidence | Consequence |\n|---|---|---|---|\n'
      jq -r '.findings[] | "| \(.severity) | `\(.file):\(.line)` | \(.evidence | gsub("\\|"; "\\\\|") | gsub("\n"; " ")) | \(.consequence | gsub("\\|"; "\\\\|") | gsub("\n"; " ")) |"' "$VDIR/$sha.json"
      printf '\n'
    fi
    printf 'Merge gate (D1): green CI **and** a PASS on this exact SHA. Verdict stored on the server as `verdicts/%s.json`.\n' "$sha"
  } | redact > "$STATE/$sha.msg"
  if [[ "$v" == "PASS" ]]; then echo "success Codex PASS ($label)" > "$STATE/$sha.state"
  else echo "failure Codex CHANGES_REQUESTED ($label)" > "$STATE/$sha.state"; fi
}

reviewed=0          # reviews run this tick (max 1: runner limit 900 s < service limit 1200 s)
declare -A tried=() # SHAs whose publication was attempted this tick
prs="$(gh_all "/repos/$REPO/pulls?state=open" '')" || die "cannot list PRs"
count="$(jq 'length' <<<"$prs")"
log "open PRs: $count"

for i in $(seq 0 $((count - 1))); do
  pr="$(jq -r ".[$i].number" <<<"$prs")"
  sha="$(jq -r ".[$i].head.sha" <<<"$prs")"
  draft="$(jq -r ".[$i].draft" <<<"$prs")"
  contract="$(jq -r ".[$i].body // \"\"" <<<"$prs" | sed -n 's/^[[:space:]]*Review-Contract:[[:space:]]*\(docs\/[A-Za-z0-9._/-]*\.md\)[[:space:]]*$/\1/p' | head -n1)"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { log "PR #$pr: bad head sha"; continue; }
  # DEVOS-115: never review, publish or drain for a PR from a fork or an author not on REVIEW_AUTHORS.
  if ! jq -c ".[$i]" <<<"$prs" | trusted_pr; then
    if [[ ! -e "$STATE/$sha.external" ]]; then
      log "PR #$pr ${sha:0:7}: external PR, not reviewed"
      [[ $DRY -eq 1 ]] || : > "$STATE/$sha.external"
    fi
    continue
  fi
  if [[ "$draft" == "true" ]]; then log "PR #$pr ${sha:0:7}: draft, skipped"; continue; fi
  if published "$sha"; then log "PR #$pr ${sha:0:7}: already reviewed and published"; continue; fi

  # Reviewed (or could not run) earlier, but publication is incomplete: publish again, never re-review.
  if [[ -s "$STATE/$sha.msg" ]]; then
    tried[$sha]=1
    if [[ $DRY -eq 1 ]]; then log "PR #$pr ${sha:0:7}: WOULD retry publication"; continue; fi
    if publish "$pr" "$sha"; then log "PR #$pr ${sha:0:7}: publication completed"; fi
    continue
  fi
  # A stored verdict without a message (e.g. from a manual run): build the message and publish it.
  if [[ -s "$VDIR/$sha.json" ]]; then
    tried[$sha]=1
    if [[ $DRY -eq 1 ]]; then log "PR #$pr ${sha:0:7}: WOULD publish the stored verdict"; continue; fi
    label="$(cat "$STATE/$sha.label" 2>/dev/null || echo "PR${pr}-manual")"
    echo "$pr" > "$STATE/$sha.pr"   # recorded before publishing, so the drain can finish it later
    verdict_msg "$sha" "$label" "${contract:-unknown}"
    publish "$pr" "$sha" && log "PR #$pr ${sha:0:7}: stored verdict published"
    continue
  fi

  if [[ -z "$contract" || "$contract" == *..* ]]; then
    log "PR #$pr ${sha:0:7}: no valid 'Review-Contract: docs/....md' line"
    if [[ ! -e "$STATE/$sha.nocontract" && $DRY -eq 0 ]]; then
      printf '**Codex review watcher:** this PR body has no `Review-Contract: docs/modules/<id>.md` line, so it was not reviewed. Add the line; the next commit or tick picks it up.\n' > "$TMP/c.md"
      comment "$pr" "$TMP/c.md" && touch "$STATE/$sha.nocontract"
    fi
    continue
  fi
  set +e; ci_green "$sha"; ci=$?; set -e
  if [[ $ci -eq 3 ]]; then log "PR #$pr ${sha:0:7}: cannot read workflow runs - the token needs 'Actions: Read'"; continue; fi
  if [[ $ci -ne 0 ]]; then log "PR #$pr ${sha:0:7}: CI not green yet"; continue; fi

  round=1
  for f in "$STATE"/*.pr; do
    if [[ -f "$f" && "$(cat "$f")" == "$pr" ]]; then round=$((round + 1)); fi
  done
  label="PR${pr}-r${round}"
  if (( reviewed >= 1 )); then log "PR #$pr ${sha:0:7}: queued for the next tick (one review per tick)"; continue; fi
  if [[ $DRY -eq 1 ]]; then log "PR #$pr ${sha:0:7}: WOULD review as $label against $contract"; continue; fi

  log "PR #$pr ${sha:0:7}: reviewing as $label against $contract"
  set_status "$sha" pending "Codex review $label running" || true
  set +e
  "$RUNNER" main "$sha" "$contract" "$label" > "$TMP/run.log" 2>&1; rc=$?
  set -e
  redact < "$TMP/run.log" > "$TMP/run.safe"
  if grep -q "another review is running" "$TMP/run.safe"; then
    log "PR #$pr: runner busy (manual review in progress); retry next tick"
    set_status "$sha" pending "Codex review queued (runner busy)" || true
    continue
  fi
  reviewed=1
  tried[$sha]=1
  echo "$pr" > "$STATE/$sha.pr"
  echo "$label" > "$STATE/$sha.label"
  if [[ $rc -eq 0 || $rc -eq 2 ]] && [[ -s "$VDIR/$sha.json" ]]; then
    verdict_msg "$sha" "$label" "$contract"
    log "PR #$pr ${sha:0:7}: $(jq -r .verdict "$VDIR/$sha.json")"
  else
    {
      printf '### Codex review %s — could not run (exit %s)\n\nNo verdict was stored. Last lines of the runner log:\n\n```\n' "$label" "$rc"
      tail -n 15 "$TMP/run.safe"
      printf '```\nIt will not be retried for this commit; push a new commit, or run the installer with RETRY_FAILED=1.\n'
    } > "$STATE/$sha.msg"
    echo "error Codex review could not run ($label)" > "$STATE/$sha.state"
    log "PR #$pr ${sha:0:7}: runner failed (exit $rc)"
  fi
  publish "$pr" "$sha" || true
done

# Drain: a SHA reviewed earlier whose comment or status never posted is published even if its PR has since
# moved to a newer head or closed. The PR number comes from <sha>.pr, recorded when the review ran.
for m in "$STATE"/*.msg; do
  [[ -e "$m" ]] || continue
  sha="$(basename "$m" .msg)"
  [[ -n "${tried[$sha]:-}" ]] && continue
  published "$sha" && continue
  pr="$(cat "$STATE/$sha.pr" 2>/dev/null || true)"
  [[ "$pr" =~ ^[0-9]+$ ]] || { log "${sha:0:7}: pending publication has no PR number; skipped"; continue; }
  if [[ $DRY -eq 1 ]]; then log "PR #$pr ${sha:0:7}: WOULD retry publication (no longer the PR head)"; continue; fi
  if publish "$pr" "$sha"; then log "PR #$pr ${sha:0:7}: publication completed (no longer the PR head)"; fi
done

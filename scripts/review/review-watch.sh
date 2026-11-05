#!/usr/bin/env bash
# DevOS — review watcher: run the Codex review automatically on each new PR head (DEVOS-60)
# Version: 1.0.1
# v1.0.1 (first server run, 5 Nov 2026): log() writes to stderr, so API errors are visible instead of being
# captured into variables; an unreadable check-runs API is reported as a token problem, not as "CI not green".
# The token also needs Checks: Read (the check-runs API).
#
# Runs on the DevOS server from a systemd timer (installed by install-review-watch.sh). Each tick:
#   1. lists open, non-draft PRs on kkarnati1980/devos;
#   2. for each PR whose head SHA has no stored verdict yet, and whose CI check runs have all
#      completed successfully (Codex never sees failing code — PRD build loop step 4), reads the
#      contract path from the PR body line `Review-Contract: docs/modules/<id>.md`;
#   3. runs /root/.devos/bin/review-commit.sh main <sha> <contract> PR<n>-r<k> (unchanged M0.3 runner:
#      read-only deploy key, pristine checkout, schema-validated verdict per SHA);
#   4. posts the verdict as a PR comment and sets the commit status `codex-review` on that SHA.
# D1 is unchanged: Codex reviews the exact SHA; merging still needs green CI + PASS on that SHA.
#
# Usage:  review-watch.sh [--dry-run]     (--dry-run: report what would be reviewed, change nothing)
# Token:  /root/.devos/github-review.env (600), GITHUB_REVIEW_TOKEN=..., fine-grained, devos repo only:
#         Pull requests RW, Commit statuses RW, Checks R, Contents R, Metadata R. Read with sed, never sourced,
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

ci_green() {  # sha -> 0 green; 1 not green; 3 cannot read check runs (token lacks Checks: Read)
  local runs
  runs="$(gh_api GET "/repos/$REPO/commits/$1/check-runs?per_page=100")" || return 3
  jq -e '(.check_runs | length) > 0 and all(.check_runs[]; .status == "completed"
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

prs="$(gh_api GET "/repos/$REPO/pulls?state=open&per_page=50")" || die "cannot list PRs"
count="$(jq 'length' <<<"$prs")"
log "open PRs: $count"

for i in $(seq 0 $((count - 1))); do
  pr="$(jq -r ".[$i].number" <<<"$prs")"
  sha="$(jq -r ".[$i].head.sha" <<<"$prs")"
  draft="$(jq -r ".[$i].draft" <<<"$prs")"
  contract="$(jq -r ".[$i].body // \"\"" <<<"$prs" | sed -n 's/^[[:space:]]*Review-Contract:[[:space:]]*\(docs\/[A-Za-z0-9._/-]*\.md\)[[:space:]]*$/\1/p' | head -n1)"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { log "PR #$pr: bad head sha"; continue; }
  if [[ "$draft" == "true" ]]; then log "PR #$pr ${sha:0:7}: draft, skipped"; continue; fi
  if [[ -s "$VDIR/$sha.json" || -e "$STATE/$sha.done" ]]; then log "PR #$pr ${sha:0:7}: already reviewed"; continue; fi
  if [[ -z "$contract" || "$contract" == *..* ]]; then
    log "PR #$pr ${sha:0:7}: no valid 'Review-Contract: docs/....md' line"
    if [[ ! -e "$STATE/$sha.nocontract" && $DRY -eq 0 ]]; then
      printf '**Codex review watcher:** this PR body has no `Review-Contract: docs/modules/<id>.md` line, so it was not reviewed. Add the line; the next commit or tick picks it up.\n' > "$TMP/c.md"
      comment "$pr" "$TMP/c.md" && touch "$STATE/$sha.nocontract"
    fi
    continue
  fi
  set +e; ci_green "$sha"; ci=$?; set -e
  if [[ $ci -eq 3 ]]; then log "PR #$pr ${sha:0:7}: cannot read check runs - the token needs 'Checks: Read'"; continue; fi
  if [[ $ci -ne 0 ]]; then log "PR #$pr ${sha:0:7}: CI not green yet"; continue; fi

  round=1
  for f in "$STATE"/*.pr; do
    if [[ -f "$f" && "$(cat "$f")" == "$pr" ]]; then round=$((round + 1)); fi
  done
  label="PR${pr}-r${round}"
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
  echo "$pr" > "$STATE/$sha.pr"
  if [[ $rc -eq 0 || $rc -eq 2 ]] && [[ -s "$VDIR/$sha.json" ]]; then
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
    } > "$TMP/c.md"
    comment "$pr" "$TMP/c.md" || log "PR #$pr: comment failed"
    if [[ "$v" == "PASS" ]]; then set_status "$sha" success "Codex PASS ($label)" || true
    else set_status "$sha" failure "Codex CHANGES_REQUESTED ($label)" || true; fi
    touch "$STATE/$sha.done"
    log "PR #$pr ${sha:0:7}: $v"
  else
    {
      printf '### Codex review %s — could not run (exit %s)\n\nNo verdict was stored. Last lines of the runner log:\n\n```\n' "$label" "$rc"
      tail -n 15 "$TMP/run.safe"
      printf '```\nIt will not be retried for this commit; push a new commit or ask KK to run it by hand.\n'
    } > "$TMP/c.md"
    comment "$pr" "$TMP/c.md" || true
    set_status "$sha" error "Codex review could not run ($label)" || true
    touch "$STATE/$sha.done"
    log "PR #$pr ${sha:0:7}: runner failed (exit $rc)"
  fi
done

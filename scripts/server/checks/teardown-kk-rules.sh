#!/usr/bin/env bash
# DevOS server check (DEVOS-112, docs/modules/M2.5.md "DEVOS-112: KK's teardown rules check"): the M1.7 policy in
# force on this server lets KK's own Archive and Restore through (`teardown.archive` / `teardown.restore` on a
# project, asked as a generic `kk:` principal on a sentinel project; rules pinned to one login or project are counted, not judged). With no matching rule in enforce mode, KK's Archive would answer 403
# `policy_denied` (default deny, M2.5-b1 decision 8). Read-only: the API container's
# `teardown-rules-cli.js kk-teardown` loads the policy and runs the pure evaluator; it makes no decision and writes
# no receipt.
# Exit 0 pass (both allowed), 1 fail (one is denied or needs approval, or the read failed), 3 skipped (DevOS not
# deployed: no docker on the host, or a successful `docker ps` finds no running API container). Prints fixed lines
# built from the helper's fixed fields only; never a secret or a database message.
set -uo pipefail
EXEC_S="${RULES_EXEC_SECONDS:-30}"
CLI=(node deploy/with-db-url.mjs node apps/api/dist/teardown-rules-cli.js kk-teardown)
command -v docker >/dev/null 2>&1 || { echo "skipped: docker not installed (DevOS not deployed yet)"; exit 3; }
command -v jq >/dev/null 2>&1 || { echo "fail: jq not installed"; exit 1; }
tmpd="$(mktemp -d 2>/dev/null)" || { echo "fail: cannot create a temp directory"; exit 1; }
trap 'rm -rf -- "$tmpd"' EXIT
# Output is captured to files and refused when it holds a NUL byte (a command substitution would drop it silently).
nonul() { local n; n="$(LC_ALL=C tr -cd '\000' < "$1" | wc -c)" || return 1; [[ "$n" =~ ^[[:space:]]*0$ ]]; }
# A failed or timed-out `docker ps` fails; only a successful search that finds no API container skips.
timeout "$EXEC_S" docker ps --filter label=io.devos.service=api --filter status=running --format '{{.ID}}' >"$tmpd/ps.out" 2>/dev/null; prc=$?
[[ $prc -eq 0 ]] || { echo "fail: docker ps failed (exit $prc)"; exit 1; }
nonul "$tmpd/ps.out" || { echo "fail: unreadable docker ps output"; exit 1; }
ID=""
while IFS= read -r l; do
  [[ -z "${l//[[:space:]]/}" ]] && continue
  [[ "$l" =~ ^[0-9a-f]{12,64}$ ]] || { echo "fail: unreadable docker ps output"; exit 1; }
  [[ -z "$ID" ]] && ID="$l"
done <"$tmpd/ps.out"
[[ -n "$ID" ]] || { echo "skipped: no running DevOS API container (DevOS not deployed yet)"; exit 3; }
timeout "$EXEC_S" docker exec "$ID" "${CLI[@]}" >"$tmpd/cli.out" 2>/dev/null; rc=$?
nonul "$tmpd/cli.out" || { echo "fail: unreadable rules check output"; exit 1; }
# The helper prints exactly one non-blank line holding exactly one JSON object; anything else is unreadable.
[[ "$(grep -c '[^[:space:]]' "$tmpd/cli.out")" == 1 ]] || { echo "fail: unreadable rules check output (exit $rc)"; exit 1; }
obj="$(jq -c -s 'if length == 1 and (.[0] | type) == "object" then .[0] else error("bad") end' "$tmpd/cli.out" 2>/dev/null)" || { echo "fail: unreadable rules check output (exit $rc)"; exit 1; }
case "$rc" in
  0|1) ;;
  3) echo "fail: the API container has no database, so the rules cannot be read"; exit 1 ;;
  124) echo "fail: the rules check timed out"; exit 1 ;;
  *) rc=99 ;;
esac
# Only the helper's own fixed codes are printed; any other text is never copied out.
err="$(printf '%s' "$obj" | jq -r '.error // "" | if type == "string" then . else "bad" end' 2>/dev/null)" || err="bad"
if [[ -n "$err" || $rc -eq 99 ]]; then
  case "$err" in usage|teardown-rules-read-failed|teardown-rules-error) ;; "") err="no result" ;; *) err="unrecognised error" ;; esac
  echo "fail: the rules check failed: $err"; exit 1
fi
# Pre-review 1: the outcomes are one of the three effects, and the verdict is recomputed here from the rows: pass
# only when both are enforced `allow`. A `result` that disagrees with its rows is unreadable, never a pass.
# Fields are joined with `|` (not in any allowed field), so an empty field never shifts the columns.
summary="$(printf '%s' "$obj" | jq -r '
  def eff($s): $s == "allow" or $s == "deny" or $s == "require_approval";
  def ok($s): ($s | type) == "string" and ($s | test("\\A[a-z;-]{1,80}\\z"));
  [.actions["teardown.archive"], .actions["teardown.restore"]] as $rows |
  if (.mode == "observe" or .mode == "enforce")
     and (.rules | type) == "number" and (.pinned | type) == "number" and (.actions | type) == "object"
     and all($rows[]; type == "object"
             and eff(.outcome) and eff(.enforced) and ok(.reason)
             and (.matched | type) == "array" and all(.matched[]; type == "string" and test("\\A[A-Za-z0-9-]{1,64}\\z")))
     and .result == (if all($rows[]; .enforced == "allow") then "pass" else "fail" end)
  then
    "\(.result)|\(.mode)|\(.rules)|\(.pinned)",
    (["teardown.archive", "teardown.restore"][] as $a | .actions[$a]
      | "\($a)|\(.enforced)|\(.outcome)|\(.reason)|\(.matched | join(","))")
  else error("bad") end' 2>/dev/null)" || { echo "fail: unreadable rules check output"; exit 1; }
{ IFS='|' read -r result mode nrules npinned; mapfile -t rows; } <<<"$summary"
[[ "$result" == pass || "$result" == fail ]] || { echo "fail: unreadable rules check output"; exit 1; }
[[ "$nrules" =~ ^[0-9]{1,9}$ && "$npinned" =~ ^[0-9]{1,9}$ ]] || { echo "fail: unreadable rules check output"; exit 1; }
# The verdict must agree with the exit code: 0 only with pass, 1 only with fail.
if [[ ( $rc -eq 0 && "$result" != pass ) || ( $rc -eq 1 && "$result" != fail ) ]]; then echo "fail: rules check exit $rc disagrees with its result"; exit 1; fi
echo "policy mode $mode, $nrules enabled rule(s)"
# Pre-review 2: rules pinned to one KK login or one project cannot be judged for a generic KK principal; show them.
[[ "$npinned" != 0 ]] && echo "  note: $npinned teardown rule(s) are pinned to a KK login or a project; this check asks as a generic KK principal, so they are not judged here"
for r in "${rows[@]}"; do
  IFS='|' read -r a enf out why ids <<<"$r"
  echo "  KK $a: $enf (rule outcome $out, $why${ids:+, rules $ids})"
done
if [[ "$result" == pass ]]; then echo "ok: KK's Archive and Restore are allowed"; exit 0; fi
echo "fail: KK's Archive or Restore would be refused by the policy in force"
exit 1

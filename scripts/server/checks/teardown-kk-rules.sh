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
# Pre-review r2 1: read through a variable, so a last line without a newline is still read (never a false skip).
ps="$(cat -- "$tmpd/ps.out")" || { echo "fail: unreadable docker ps output"; exit 1; }
ID=""
while IFS= read -r l; do
  [[ -z "${l//[[:space:]]/}" ]] && continue
  [[ "$l" =~ ^[0-9a-f]{12,64}$ ]] || { echo "fail: unreadable docker ps output"; exit 1; }
  [[ -z "$ID" ]] && ID="$l"
done <<<"$ps"
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
# An `error` key that is not a non-empty string is unrecognised, never read as "no error" (pre-review sweep).
err="$(printf '%s' "$obj" | jq -r 'if has("error") then (.error | if type == "string" and length > 0 then . else "bad" end) else "" end' 2>/dev/null)" || err="bad"
if [[ -n "$err" || $rc -eq 99 ]]; then
  case "$err" in usage|teardown-rules-read-failed|teardown-rules-error) ;; "") err="no result" ;; *) err="unrecognised error" ;; esac
  echo "fail: the rules check failed: $err"; exit 1
fi
# Pre-review 1: the outcomes are one of the three effects, and the verdict is recomputed here from the rows: pass
# only when both are enforced `allow`, the two random sentinels agreed (Codex PR238-r1) and no rule matched through a
# narrow pattern (PR238-r2). In enforce mode the evaluator enforces its rule outcome, so a row whose two differ is
# malformed (PR238-r3). Every row must be one the evaluator can produce (PR238-r4, r5): its reason codes are the
# evaluator's own, each deciding code names the recorded outcome (`default-deny` and `denied-by` only with deny), a
# rule-named code comes with a matched rule and a lone `default-deny` with none and no gate (PR238-r6), a gate code appears only in observe mode and fits the enforced outcome,
# and in observe mode an enforced deny needs a deny rule. A `result` that disagrees with its rows is unreadable, never
# a pass.
# Fields are joined with `|` (not in any allowed field), so an empty field never shifts the columns.
summary="$(printf '%s' "$obj" | jq -r '
  def eff($s): $s == "allow" or $s == "deny" or $s == "require_approval";
  def ok($s): ($s | type) == "string" and ($s | test("\\A[a-z;-]{1,80}\\z"));
  def parts: .reason | split(";");
  def has($p): any(parts[]; . == $p);
  def head: [parts[] | select(startswith("gate-") | not)];
  def means($c): {"allowed-by": "allow", "denied-by": "deny", "default-deny": "deny", "approval-required-by": "require_approval"}[$c];
  # Every row (PR238-r4..r6): at most 10 distinct matched ids, never more than the rules loaded; in enforce mode no
  # gate code and the rule outcome enforced. A check verdict (`narrow-match`, `sentinels-disagree`) stands alone and
  # needs a matched rule (only a matching rule can be narrow or split the sentinels). Otherwise every part is an
  # evaluator code, exactly one deciding code (Codex PR238-r9: the evaluator writes one, then only gate codes), first and naming the recorded outcome; a lone `default-deny` has no matched
  # rule and no gate, any other has one; a gate code needs 2 matched rules (it is added only when the gate does not
  # decide); codes never repeat; and in observe mode the enforced outcome follows only from the gates. Only keys
  # the helper prints are accepted, and both rows together never name more distinct rules than were loaded. Codex
  # PR238-r7: the evaluator reads only the matched rules, and a rule matches the requests of both actions alike, so two rows
  # with the same matched set are the same row. Codex PR238-r8: the helper prints at most 10 matched ids per action
  # (MATCHED_CAP in teardown-rules-cli.ts), so a list of 10 may be cut and the rule is applied only below that. Codex PR238-r10: the evaluator
  # lists matched rules by priority, then id, so the same set comes in the same order for both actions.
  def gated: has("gate-denied-by") or has("gate-approval-required-by");
  def consistent($mode; $nrules):
    (keys == ["enforced", "matched", "outcome", "reason"])
    and (.matched | length) <= 10 and (.matched | length) <= $nrules and (.matched | unique | length) == (.matched | length)
    and ($mode != "enforce" or (.enforced == .outcome and (gated | not)))
    and (.enforced != "deny" or .outcome == "deny") and (.enforced != "require_approval" or .outcome != "allow")
    and if .reason == "narrow-match" or .reason == "sentinels-disagree" then (.matched | length) >= 1
    else all(parts[]; . == "allowed-by" or . == "denied-by" or . == "default-deny" or . == "approval-required-by"
                      or . == "gate-denied-by" or . == "gate-approval-required-by")
      and (parts[0] | startswith("gate-") | not) and (parts | unique | length) == (parts | length)
      and ((gated | not) or (.matched | length) >= 2)
      and (head | length) == 1 and (. as $r | all(head[]; means(.) == $r.outcome))
      and (if all(head[]; . == "default-deny") then (.matched | length) == 0 and (gated | not) else (.matched | length) >= 1 end)
      and (has("gate-denied-by") and has("gate-approval-required-by") | not)
      and ($mode == "enforce"
           or ((if has("gate-denied-by") then .enforced == "deny"
                elif has("gate-approval-required-by") then .enforced == "require_approval"
                else true end)
               and (.enforced != "deny" or (.outcome == "deny" and has("denied-by")))
               and (.enforced != "require_approval" or has("gate-approval-required-by") or .outcome == "require_approval")
               and (.enforced != "allow" or (gated | not))))
    end;
  [.actions["teardown.archive"], .actions["teardown.restore"]] as $rows | .mode as $mode | .rules as $nrules |
  if (.mode == "observe" or .mode == "enforce")
     and (keys == ["actions", "mode", "pinned", "result", "rules"])
     and (.rules | type) == "number" and (.pinned | type) == "number" and .pinned <= .rules and (.actions | type) == "object"
     and (.actions | keys) == ["teardown.archive", "teardown.restore"]
     and all($rows[]; type == "object"
             and eff(.outcome) and eff(.enforced) and ok(.reason)
             and (.matched | type) == "array" and all(.matched[]; type == "string" and test("\\A[A-Za-z0-9-]{1,64}\\z"))
             and consistent($mode; $nrules))
     and ([$rows[].matched[]] | unique | length) <= $nrules
     and (($rows[0].matched | length) >= 10 or ($rows[1].matched | length) >= 10
          or ($rows[0].matched | sort) != ($rows[1].matched | sort) or $rows[0] == $rows[1])
     and .result == (if all($rows[]; .enforced == "allow" and .reason != "sentinels-disagree" and .reason != "narrow-match") then "pass" else "fail" end)
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

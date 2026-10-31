#!/usr/bin/env bash
# DevOS — Codex review of one change (D1 Reviewer; bootstrap tool for Phases 0–4, superseded by M3.4)
# Version: 1.0.0
# Usage (as root on the DevOS server):
#   review-commit.sh <base-ref> <head-ref> <contract-path> [label]
#   e.g. review-commit.sh main kishore/devos-33-m01-server-baseline docs/modules/M0.1.md M0.1
# Reviews `git diff <base>..<head>` at the exact head SHA in Codex's read-only sandbox with the
# M0.3 verdict schema; stores /root/.devos/verdicts/<sha>.json. Exit 0 = PASS, 2 = CHANGES_REQUESTED.
# Repo access: read-only deploy key /root/.ssh/devos_ro. Run from a copy outside the work tree
# (it checks out other commits): /root/.devos/bin/review-commit.sh
set -euo pipefail

DIR=/root/.devos
VDIR="$DIR/verdicts"
SCHEMA="$DIR/verdict.schema.json"
WORK=/root/devos-review
REMOTE=git@github.com:kkarnati1980/devos.git
export GIT_SSH_COMMAND="ssh -i /root/.ssh/devos_ro -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

fail() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }
redact() { sed -E 's/sk-[A-Za-z0-9_*.-]+/sk-[redacted]/g'; }
[[ "${EUID}" -eq 0 ]] || fail "run as root"
[[ $# -ge 3 ]] || fail "usage: $0 <base-ref> <head-ref> <contract-path> [label]"
base="$1"; head="$2"; contract="$3"; label="${4:-review}"
[[ -s "$SCHEMA" ]] || fail "missing $SCHEMA — run the M0.3 spike first"
install -d -m 700 "$VDIR"
command -v shellcheck >/dev/null 2>&1 || apt-get install -y -qq shellcheck >/dev/null

if [[ -d "$WORK/.git" ]]; then
  git -C "$WORK" fetch -q --prune origin '+refs/heads/*:refs/remotes/origin/*'
else
  git clone -q "$REMOTE" "$WORK"
fi
cd "$WORK"
resolve() { git rev-parse --verify -q "origin/$1^{commit}" || git rev-parse --verify -q "$1^{commit}" || fail "cannot resolve $1"; }
B="$(resolve "$base")"; H="$(resolve "$head")"
git checkout -q --detach "$H"
[[ -f "$contract" ]] || fail "contract $contract not present at $H"

prompt="You are the independent Reviewer (Codex, read-only) for the DevOS repository.
Review exactly this change: \`git diff ${B}..${H}\` (head commit ${H}, label ${label}).
Judge it against the module contract at ${contract} (goal, owned files, acceptance tests) and the
'Review guidelines' section of rules.md. Use ADRs in docs/decisions/ that the contract cites as context.
Rules for you:
- Never modify files. Do NOT execute any script under scripts/ — they reconfigure a live server.
- You may run read-only checks: git commands, reading files, \`bash -n <file>\`, \`shellcheck -S warning <file>\`.
Return PASS only if the change meets its contract, has no logic error, unsafe default or regression,
commits no secret, and stays within the module's owned files (plus cited ADRs).
Otherwise CHANGES_REQUESTED with one finding per concrete defect: severity (high/medium/low), file,
line (in the head version), evidence, consequence. Low-severity notes alone must not block PASS.
Set \"sha\" to ${H}. Respond only with the JSON object."

out="$DIR/last-${label}.json"; log="$DIR/codex-${label}.log"
t0="$(date +%s)"
timeout 900 codex exec --sandbox read-only --output-schema "$SCHEMA" --output-last-message "$out" "$prompt" \
  </dev/null >"$log" 2>&1 || { tail -n 20 "$log" | redact >&2; fail "codex exec failed ($label)"; }
t1="$(date +%s)"

python3 - "$out" "$H" <<'PY' || fail "verdict does not match schema"
import json, sys
d = json.load(open(sys.argv[1]))
assert set(d) == {"verdict", "sha", "summary", "findings"}
assert d["verdict"] in ("PASS", "CHANGES_REQUESTED") and d["sha"] == sys.argv[2]
for f in d["findings"]:
    assert set(f) == {"severity", "file", "line", "evidence", "consequence"} and f["severity"] in ("high", "medium", "low")
PY
cp "$out" "$VDIR/$H.json"
verdict="$(jq -r .verdict "$out")"
echo "----- review ${label} $(date -u +%FT%TZ) -----"
echo "base ${base} ${B}"; echo "head ${head} ${H}"; echo "contract ${contract}"
echo "verdict ${verdict} ($((t1 - t0))s) — findings: $(jq -r '[.findings[].severity] | group_by(.) | map("\(.[0])=\(length)") | join(" ")' "$out")"
jq . "$out"
echo "----- end review ${label} -----"
[[ "$verdict" == "PASS" ]] && exit 0 || exit 2

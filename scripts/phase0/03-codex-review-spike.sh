#!/usr/bin/env bash
# DevOS M0.3 — Codex review spike (ADR-0002: Codex CLI, API-key auth, read-only, structured verdict)
# Version: 1.0.2
# v1.0.1 (Codex review 55ee78d): strict schema validation (types of every field);
# AT2 requires the finding to identify the missing /100.
# v1.0.2 (Codex review 2473191): a verdict is written to verdicts/<sha>.json only after
# schema, SHA, read-only and AT checks pass; AT2 requires the literal '/ 100' (or '/100').
# Run as root on the DevOS server (interactive, for the hidden key prompt):
#     ssh -t root@devos 'bash /root/03-codex-review-spike.sh'
# The OpenAI key goes to /root/.devos/openai.env (600) via a hidden prompt and is fed
# to `codex login` on stdin — never printed, never on a command line.
set -euo pipefail

DIR=/root/.devos
ENVF="$DIR/openai.env"
VDIR="$DIR/verdicts"
REPO=/root/m03-sample
SCHEMA="$DIR/verdict.schema.json"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
pass() { printf '  \033[1;32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }
redact() { sed -E 's/sk-[A-Za-z0-9_*.-]+/sk-[redacted]/g'; }
[[ "${EUID}" -eq 0 ]] || { echo "Run as root"; exit 1; }
install -d -m 700 "$DIR" "$VDIR"

say "1/6 Node.js 22 + Codex CLI"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed -E 's/^v([0-9]+).*/\1/')" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
apt-get install -y -qq jq git python3 >/dev/null
npm install -g --silent @openai/codex@latest >/dev/null 2>&1
echo "  node $(node -v), npm $(npm -v), $(codex --version 2>&1 | head -n1)"
HELP="$(codex exec --help 2>&1 || true)"
grep -q -- '--output-schema' <<<"$HELP" && echo "  codex exec supports --output-schema" || fail "codex exec has no --output-schema (see contract fallback)"
grep -q -- '--sandbox' <<<"$HELP" || fail "codex exec has no --sandbox"
grep -qE -- '--output-last-message|-o,' <<<"$HELP" || fail "codex exec has no --output-last-message"

say "2/6 OpenAI key (hidden) + Codex login"
if [[ ! -s "$ENVF" ]]; then
  read -rsp "Paste the OpenAI API key (input hidden), then Enter: " KEY; echo
  [[ -n "$KEY" ]] || fail "empty key"
  umask 077; printf 'OPENAI_API_KEY=%s\n' "$KEY" > "$ENVF"; unset KEY
fi
chmod 600 "$ENVF"
sed -n 's/^OPENAI_API_KEY=//p' "$ENVF" | head -n1 | tr -d '\n' | codex login --with-api-key >/dev/null 2>&1 \
  || fail "codex login --with-api-key failed (see contract fallback)"
codex login status 2>&1 | redact | sed 's/^/  /'
[[ -f /root/.codex/auth.json ]] && chmod 600 /root/.codex/auth.json
echo "  key file $(stat -c %a "$ENVF"); codex auth $(stat -c %a /root/.codex/auth.json 2>/dev/null || echo n/a)"
pass "AT1 install + auth"

say "3/6 Verdict schema"
cat > "$SCHEMA" <<'JSON'
{
  "type": "object",
  "additionalProperties": false,
  "required": ["verdict", "sha", "summary", "findings"],
  "properties": {
    "verdict": { "type": "string", "enum": ["PASS", "CHANGES_REQUESTED"] },
    "sha": { "type": "string" },
    "summary": { "type": "string" },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["severity", "file", "line", "evidence", "consequence"],
        "properties": {
          "severity": { "type": "string", "enum": ["high", "medium", "low"] },
          "file": { "type": "string" },
          "line": { "type": "integer" },
          "evidence": { "type": "string" },
          "consequence": { "type": "string" }
        }
      }
    }
  }
}
JSON
echo "  $SCHEMA"

say "4/6 Sample repo with a planted bug and a clean change"
rm -rf "$REPO"; mkdir -p "$REPO"; cd "$REPO"
g() { git -c user.name=devos-spike -c user.email=spike@devos.local "$@"; }
g init -q -b main
cat > SPEC.md <<'MD'
# Discount spec
`apply_discount(price, pct)`:
- `price` >= 0, `pct` is a percentage in 0..100 inclusive; otherwise raise ValueError.
- Returns the price reduced by `pct` percent, rounded to 2 decimals. Example: apply_discount(100, 20) == 80.0.
`apply_discounts(prices, pct)` returns a list with apply_discount applied to each price.
MD
cat > discount.py <<'PY'
def apply_discount(price, pct):
    if price < 0 or not 0 <= pct <= 100:
        raise ValueError("invalid price or pct")
    return round(price * (1 - pct / 100), 2)
PY
cat > test_discount.py <<'PY'
import unittest
from discount import apply_discount

class TestDiscount(unittest.TestCase):
    def test_twenty_percent(self):
        self.assertEqual(apply_discount(100, 20), 80.0)

    def test_bounds(self):
        with self.assertRaises(ValueError):
            apply_discount(100, 101)

if __name__ == "__main__":
    unittest.main()
PY
g add -A; g commit -qm "A: discount with spec and tests"; A="$(git rev-parse HEAD)"

g checkout -q -b bug
cat > discount.py <<'PY'
def apply_discount(price, pct):
    """Simplified validation and math."""
    if price < 0 or not 0 <= pct <= 100:
        raise ValueError("invalid price or pct")
    return round(price * (1 - pct), 2)
PY
g commit -qam "B: simplify discount math"; B="$(git rev-parse HEAD)"

g checkout -q main; g checkout -q -b clean
cat >> discount.py <<'PY'


def apply_discounts(prices, pct):
    return [apply_discount(p, pct) for p in prices]
PY
cat > test_discount_many.py <<'PY'
import unittest
from discount import apply_discounts

class TestMany(unittest.TestCase):
    def test_list(self):
        self.assertEqual(apply_discounts([100, 50], 10), [90.0, 45.0])

if __name__ == "__main__":
    unittest.main()
PY
g add -A; g commit -qm "C: add apply_discounts helper with test"; C="$(git rev-parse HEAD)"
echo "  A=$A"; echo "  B=$B (planted bug)"; echo "  C=$C (clean)"

review() {  # review SHA LABEL -> writes $DIR/last-<label>.json (unvalidated), echoes seconds
  local sha="$1" label="$2" out="$DIR/last-$2.json" t0 t1 prompt
  g checkout -q --detach "$sha"
  prompt="You are the Reviewer in a build/review pipeline. You review only; never modify files.
Review exactly commit ${sha} in this repository: the change is \`git diff ${sha}~1 ${sha}\`.
Judge it against SPEC.md and the tests. You may read files and run \`python3 -m unittest -q\`.
Return verdict PASS only if the change satisfies the spec, introduces no regression and all tests pass.
Otherwise return CHANGES_REQUESTED with one finding per concrete defect: severity (high/medium/low),
file, line (in the new version), evidence (what the code does), consequence (what goes wrong).
Set \"sha\" to ${sha}. Respond only with the JSON object."
  t0="$(date +%s)"
  PYTHONDONTWRITEBYTECODE=1 timeout 600 codex exec --sandbox read-only --output-schema "$SCHEMA" \
    --output-last-message "$out" "$prompt" </dev/null >"$DIR/codex-$label.log" 2>&1 \
    || { tail -n 20 "$DIR/codex-$label.log" | redact >&2; fail "codex exec failed for $label"; }
  t1="$(date +%s)"
  jq -e . "$out" >/dev/null || fail "$label: last message is not JSON"
  echo "$((t1 - t0))"
}

check_schema() {  # check_schema FILE SHA
  python3 - "$1" "$2" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1])); sha = sys.argv[2]
def text(x): return isinstance(x, str) and x.strip() != ""
assert isinstance(d, dict) and set(d) == {"verdict", "sha", "summary", "findings"}, f"top-level keys {sorted(d) if isinstance(d, dict) else type(d)}"
assert d["verdict"] in ("PASS", "CHANGES_REQUESTED"), f"verdict {d['verdict']!r}"
assert isinstance(d["sha"], str) and d["sha"] == sha, f"sha {d['sha']!r} != {sha}"
assert text(d["summary"]), "summary must be a non-empty string"
assert isinstance(d["findings"], list), "findings must be a list"
for i, f in enumerate(d["findings"]):
    assert isinstance(f, dict) and set(f) == {"severity", "file", "line", "evidence", "consequence"}, f"finding {i} keys"
    assert f["severity"] in ("high", "medium", "low"), f"finding {i} severity"
    assert text(f["file"]) and text(f["evidence"]) and text(f["consequence"]), f"finding {i} text fields"
    assert isinstance(f["line"], int) and not isinstance(f["line"], bool) and f["line"] >= 0, f"finding {i} line"
print("  schema OK")
PY
}

say "5/6 Reviews"
pristine() { [[ "$(git rev-parse HEAD)" == "$1" && -z "$(git status --porcelain --untracked-files=all)" ]] || fail "AT5 repo modified during review of $1"; }
store() { cp "$1" "$VDIR/$2.json"; }   # only called after every check on that verdict passed
before="$(g -C "$REPO" status --porcelain --untracked-files=all)"
[[ -z "$before" ]] || fail "sample repo not clean before reviews"
rm -f "$VDIR/$B.json" "$VDIR/$C.json"

tB="$(review "$B" bug)"
pristine "$B"
check_schema "$DIR/last-bug.json" "$B"
jq -e '.verdict == "CHANGES_REQUESTED" and ([.findings[] | select((.severity=="high" or .severity=="medium") and (.file | test("discount\\.py$")) and ((.evidence + " " + .consequence) | test("/ ?100")))] | length >= 1)' \
  "$DIR/last-bug.json" >/dev/null || { cat "$DIR/last-bug.json"; fail "AT2: no high/medium discount.py finding naming the missing / 100"; }
store "$DIR/last-bug.json" "$B"
pass "AT2 buggy commit -> CHANGES_REQUESTED naming the missing / 100 (${tB}s)"

tC="$(review "$C" clean)"
pristine "$C"
check_schema "$DIR/last-clean.json" "$C"
jq -e '.verdict == "PASS" and ([.findings[] | select(.severity=="high" or .severity=="medium")] | length == 0)' \
  "$DIR/last-clean.json" >/dev/null || { cat "$DIR/last-clean.json"; fail "AT3"; }
store "$DIR/last-clean.json" "$C"
pass "AT3 clean commit -> PASS (${tC}s)"
pass "AT4 both verdicts match the schema (validated before storage)"
pass "AT5 read-only: HEAD unchanged, working tree clean after each review"
pass "AT6 validated verdicts stored per SHA in $VDIR"

say "6/6 Evidence"
echo "----- M0.3 evidence v1.0.2 $(date -u +%FT%TZ) -----"
echo "# versions"; echo "node $(node -v); $(codex --version 2>&1 | head -n1)"
echo "# model"; grep -m1 -iE '^model|model:' "$DIR/codex-bug.log" | redact || echo "(default; see codex logs)"
echo "# verdict B ($B, ${tB}s)"; jq . "$VDIR/$B.json"
echo "# verdict C ($C, ${tC}s)"; jq . "$VDIR/$C.json"
echo "# secrets"; echo "openai.env $(stat -c %a "$ENVF"); .devos $(stat -c %a "$DIR"); verdicts $(stat -c %a "$VDIR"); key never printed"
echo "----- end evidence -----"

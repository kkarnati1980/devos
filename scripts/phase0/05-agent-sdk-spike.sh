#!/usr/bin/env bash
# DevOS M0.5 — Agent SDK spike (unattended run in a container, tool allow-list, hook deny, time + cost)
# Version: 1.0.2
# v1.0.2 (Codex r2 2488aa6): AT6 requires the exact `touch` attempt (by tool_use_id) and its deny;
# AT7 requires duration_api_ms and per-model token usage and stores per-model usage in the summary.
# v1.0.1 (Codex r1 063a32a): AT6 requires the deny marker in the tool_result of the forbidden
# Bash call itself (any denial used to satisfy it). Policy fixes are in agent-spike/run.mjs v1.0.1.
#
# Run as root on the DevOS server, from a checkout of this repo (interactive only for the
# first-time hidden key prompt):
#     ssh -t root@devos 'cd /root/devos-review && bash scripts/phase0/05-agent-sdk-spike.sh'
# Options (env):  ROUNDS=2  MODEL=claude-sonnet-5-5  MAX_BUDGET_USD=0.50  MAX_TURNS=12
#                 ROTATE_KEY=1 (re-prompt for the key)
#
# The Anthropic key goes to /root/.devos/anthropic.env (600) via a hidden prompt. It reaches
# curl through a 600 header file and the container through a read-only bind-mounted file
# (never an env var, never a command line, never printed). Contract: docs/modules/M0.5.md.
set -euo pipefail

DIR=/root/.devos
ENVF="$DIR/anthropic.env"
RUNS="$DIR/runs"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-spike"
IMAGE="${IMAGE:-devos-m05-agent:1.0.0}"
MODEL="${MODEL:-claude-sonnet-5-5}"
ROUNDS="${ROUNDS:-2}"
MAX_BUDGET_USD="${MAX_BUDGET_USD:-0.50}"
MAX_TURNS="${MAX_TURNS:-12}"
API=https://api.anthropic.com

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
pass() { printf '  \033[1;32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }
[[ "${EUID}" -eq 0 ]] || { echo "Run as root"; exit 1; }
[[ "$ROUNDS" =~ ^[0-9]+$ && "$ROUNDS" -ge 2 ]] || fail "ROUNDS must be >= 2 (AT9)"
[[ -f "$SRC/run.mjs" && -f "$SRC/Dockerfile" && -f "$SRC/package-lock.json" ]] || fail "missing $SRC (run from a repo checkout)"
install -d -m 700 "$DIR" "$RUNS"

TMP="$(mktemp -d)"; chmod 700 "$TMP"
CNAME=""
cleanup() {
  [[ -n "$CNAME" ]] && docker rm -f "$CNAME" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
key() { sed -n 's/^ANTHROPIC_API_KEY=//p' "$ENVF" | head -n1 | tr -d '\r\n'; }

say "1/5 Prerequisites"
command -v docker >/dev/null || fail "docker not found"
apt-get install -y -qq jq curl python3 >/dev/null
echo "  $(docker --version)"

say "2/5 Anthropic key (hidden) + model check"
if [[ ! -s "$ENVF" || "${ROTATE_KEY:-0}" == 1 ]]; then
  read -rsp "Paste the Anthropic API key (input hidden), then Enter: " KEY; echo
  [[ "$KEY" =~ ^sk-ant-[A-Za-z0-9_-]{20,}$ ]] || { unset KEY; fail "that does not look like an Anthropic key (sk-ant-...)"; }
  ( umask 077; printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" > "$ENVF" ); unset KEY
fi
chmod 600 "$ENVF"
[[ -n "$(key)" ]] || fail "no key in $ENVF"
( umask 077; printf 'x-api-key: %s\n' "$(key)" > "$TMP/hdr" )
code="$(curl -sS -o "$TMP/models.json" -w '%{http_code}' -H @"$TMP/hdr" -H 'anthropic-version: 2023-06-01' "$API/v1/models?limit=100")" || fail "cannot reach $API"
rm -f "$TMP/hdr"
[[ "$code" == 200 ]] || fail "GET /v1/models -> HTTP $code (bad key or no access)"
echo "  models: $(jq -r '[.data[].id] | join(", ")' "$TMP/models.json")"
jq -e --arg m "$MODEL" 'any(.data[]; .id == $m)' "$TMP/models.json" >/dev/null \
  || fail "MODEL=$MODEL not offered to this key; rerun with MODEL=<one of the ids above>"
pass "AT1 key valid (HTTP 200), model $MODEL available; key file $(stat -c %a "$ENVF"), dir $(stat -c %a "$DIR")"

say "3/5 Image (pinned SDK) + policy self-test (offline)"
if [[ -z "${SKIP_BUILD:-}" ]]; then
  docker build -q -t "$IMAGE" "$SRC" >/dev/null || fail "docker build failed"
fi
SDKV="$(docker run --rm --network none --entrypoint node "$IMAGE" -p "require('/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version")"
echo "  image $IMAGE, agent-sdk $SDKV"
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges "$IMAGE" --self-test \
  || fail "policy self-test failed"
pass "AT2 policy self-test (deny-by-default) passes offline"

say "4/5 Unattended runs ($ROUNDS)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SUMMARY="$RUNS/m05-$STAMP.summary.jsonl"
for r in $(seq 1 "$ROUNDS"); do
  RD="$RUNS/m05-$STAMP-r$r"; install -d -m 700 "$RD"; install -d -o 1000 -g 1000 -m 700 "$RD/work" "$RD/out"
  # Deterministic input with a known word count (varies per round).
  python3 -I -c 'import sys; n=int(sys.argv[1]); print(" ".join(f"word{i}" for i in range(n)))' "$((30 + r * 7))" > "$RD/work/input.txt"
  chown 1000:1000 "$RD/work/input.txt"; EXPECT="$(wc -w < "$RD/work/input.txt" | tr -d ' ')"
  install -d -o 1000 -g 1000 -m 700 "$TMP/sec$r"
  ( umask 077; key > "$TMP/sec$r/key" ); chown 1000:1000 "$TMP/sec$r/key"; chmod 400 "$TMP/sec$r/key"

  CNAME="devos-m05-$STAMP-r$r"; echo "  round $r: container $CNAME, expect $EXPECT words"
  docker create --name "$CNAME" --user 1000:1000 --read-only --tmpfs /tmp:rw,size=512m,mode=1777 \
    --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 2g --cpus 2 \
    -e MODEL="$MODEL" -e MAX_BUDGET_USD="$MAX_BUDGET_USD" -e MAX_TURNS="$MAX_TURNS" -e RUN_TIMEOUT_MS=240000 \
    -v "$RD/work:/work" -v "$RD/out:/out" -v "$TMP/sec$r/key:/run/secrets/anthropic_key:ro" \
    "$IMAGE" >/dev/null
  docker inspect "$CNAME" > "$RD/inspect.json"
  t0=$(date +%s%3N)
  set +e; timeout 300 docker start -a "$CNAME" > "$RD/stdout.log" 2> "$RD/stderr.log"; rc=$?; set -e
  wall=$(( $(date +%s%3N) - t0 ))
  docker rm -f "$CNAME" >/dev/null 2>&1 || true; CNAME=""
  rm -f "$TMP/sec$r/key"
  sed 's/^/    /' "$RD/stdout.log"; [[ -s "$RD/stderr.log" ]] && tail -n 5 "$RD/stderr.log" | sed 's/^/    stderr: /'

  python3 -I - "$RD" "$EXPECT" "$rc" "$wall" "$MAX_BUDGET_USD" "$SDKV" "$MODEL" >> "$SUMMARY" <<'PY' || fail "round $r acceptance checks failed (evidence: $RD)"
import json, os, sys
rd, expect, rc, wall, cap, sdkv, model = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), float(sys.argv[5]), sys.argv[6], sys.argv[7]
TOOLS = {"Read", "Write", "Glob", "Bash"}
MARK = "DEVOS-POLICY-DENY"
def die(msg):
    print(f"  FAIL {msg}", file=sys.stderr); sys.exit(1)
def ok(msg):
    print(f"  PASS {msg}", file=sys.stderr)
def jl(p):
    try:
        with open(p) as f: return [json.loads(l) for l in f if l.strip()]
    except FileNotFoundError: return []

insp = json.load(open(f"{rd}/inspect.json"))[0]
cfg, hc = insp["Config"], insp["HostConfig"]
if cfg.get("User") != "1000:1000": die(f"AT3 user is {cfg.get('User')!r}")
if hc.get("ReadonlyRootfs") is not True: die("AT3 root filesystem not read-only")
if hc.get("CapDrop") != ["ALL"]: die(f"AT3 CapDrop={hc.get('CapDrop')}")
if "no-new-privileges" not in (hc.get("SecurityOpt") or []): die("AT3 no-new-privileges missing")
if cfg.get("Tty") or cfg.get("OpenStdin") or cfg.get("AttachStdin"): die("AT3 container has a TTY/stdin (not unattended)")
if any(e.startswith("ANTHROPIC_API_KEY") for e in cfg.get("Env") or []): die("AT8 key present in container env")
ok("AT3 container: uid 1000, read-only root, cap-drop ALL, no-new-privileges, no TTY/stdin")

try: res = json.load(open(f"{rd}/out/result.json"))
except (FileNotFoundError, ValueError): die(f"AT4 no result.json (exit {rc})")
if rc != 0 or res.get("subtype") != "success" or res.get("is_error"):
    die(f"AT4 run did not succeed: exit {rc}, subtype {res.get('subtype')}, is_error {res.get('is_error')}, {str(res.get('result') or res.get('errors'))[:200]}")
msgs = jl(f"{rd}/out/messages.jsonl")
init = next((m for m in msgs if m.get("type") == "system" and m.get("subtype") == "init"), None)
if not init: die("AT4 no init message")
if set(init.get("tools", [])) != TOOLS: die(f"AT6 tool set {init.get('tools')} != allow-list")
if init.get("permissionMode") != "dontAsk": die(f"AT6 permissionMode {init.get('permissionMode')}")
ok(f"AT4 unattended run succeeded: {res['num_turns']} turns, exit 0")

try: words = json.load(open(f"{rd}/work/result.json")).get("words")
except (FileNotFoundError, ValueError, AttributeError): die("AT5 /work/result.json missing or not a JSON object")
if words != expect: die(f"AT5 words={words!r}, expected {expect}")
ok(f"AT5 task output correct: words={words}")

hooks = jl(f"{rd}/out/hooks.jsonl")
uses = [c for m in msgs if m.get("type") == "assistant"
        for c in (m.get("message", {}).get("content") or []) if isinstance(c, dict) and c.get("type") == "tool_use"]
results = [c for m in msgs if m.get("type") == "user"
           for c in (m.get("message", {}).get("content") or []) if isinstance(c, dict) and c.get("type") == "tool_result"]
denies = [h for h in hooks if h["decision"] == "deny"]
# The required policy test is exactly `touch /work/forbidden.flag` (or `touch forbidden.flag`), whitespace-normalised.
FORBIDDEN = {"touch /work/forbidden.flag", "touch forbidden.flag"}
norm = lambda c: " ".join(str(c or "").split())
touch_uses = {u["id"] for u in uses if u.get("name") == "Bash" and norm((u.get("input") or {}).get("command")) in FORBIDDEN}
if not touch_uses: die("AT6 the agent never attempted the required `touch /work/forbidden.flag` Bash call")
blocked = [h for h in denies if h["tool"] == "Bash" and h.get("id") in touch_uses
           and norm((h.get("input") or {}).get("command")) in FORBIDDEN]
if {h["id"] for h in blocked} != touch_uses:
    die(f"AT6 not every `touch` attempt was denied by the hook (attempts {len(touch_uses)}, hook denies {len(blocked)})")
if os.path.exists(f"{rd}/work/forbidden.flag"): die("AT6 forbidden.flag exists - the blocked action ran")
def text(c):
    v = c.get("content")
    return v if isinstance(v, str) else json.dumps(v)
blocked_ids = {h["id"] for h in blocked}
by_id = {r.get("tool_use_id"): r for r in results}
unreported = [i for i in blocked_ids if not (i in by_id and MARK in text(by_id[i]))]
if unreported:
    die(f"AT6 the deny for the forbidden Bash call never reached the agent as its tool_result: {unreported}")
hook_ids = {h["id"] for h in hooks}
missing = [u["name"] for u in uses if u.get("id") not in hook_ids]
if missing: die(f"AT6 tool calls that bypassed the hook: {missing}")
allowed_off_list = [h for h in hooks if h["decision"] == "allow" and h["tool"] not in TOOLS]
if allowed_off_list: die(f"AT6 off-list tool allowed: {allowed_off_list}")
ok(f"AT6 hook saw all {len(uses)} tool calls; denied {len(denies)} ({', '.join(sorted({h['reason'] for h in denies}))}); forbidden.flag absent")

TK = ("inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens")
isnum = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
for f in ("duration_ms", "duration_api_ms", "total_cost_usd"):
    if not isnum(res.get(f)) or res[f] <= 0: die(f"AT7 {f} missing or not positive: {res.get(f)!r}")
cost = float(res["total_cost_usd"])
mu = res.get("modelUsage")
if not isinstance(mu, dict) or not mu: die("AT7 modelUsage (per-model tokens) missing")
per_model = {}
for name, v in mu.items():
    if not isinstance(v, dict) or not all(isinstance(v.get(k), int) and v[k] >= 0 for k in TK):
        die(f"AT7 modelUsage[{name}] lacks integer token fields {TK}")
    if v["inputTokens"] + v["outputTokens"] <= 0: die(f"AT7 modelUsage[{name}] has no tokens")
    per_model[name] = {k: v[k] for k in TK} | ({"costUSD": v["costUSD"]} if isnum(v.get("costUSD")) else {})
tok = {k: sum(m[k] for m in per_model.values()) for k in TK}
if cost > cap: die(f"AT7 cost ${cost:.4f} above cap ${cap}")
pm_txt = ", ".join("%s in %d out %d" % (k, v["inputTokens"], v["outputTokens"]) for k, v in per_model.items())
ok(f"AT7 recorded: sdk {res['duration_ms']} ms (api {res['duration_api_ms']} ms), wall {wall} ms, ${cost:.4f} <= ${cap}; per-model tokens: {pm_txt}")
print(json.dumps({"run": os.path.basename(rd), "model": init.get("model"), "sdk": sdkv,
                  "claude_code": init.get("claude_code_version"), "turns": res["num_turns"],
                  "duration_ms": res["duration_ms"], "duration_api_ms": res["duration_api_ms"], "wall_ms": wall,
                  "cost_usd": round(cost, 6), "tokens": tok, "model_usage": per_model, "tool_calls": len(uses), "hook_denies": len(denies),
                  "permission_denials": len(res.get("permission_denials") or []), "words": words}))
PY
  # AT8: the key must not appear anywhere in the run's evidence.
  if grep -rqF -f <(key) "$RD"; then fail "AT8 key found in $RD"; fi
  pass "round $r: AT3-AT8"
done

say "5/5 Evidence"
[[ -z "$(find "$TMP" -type f -name key)" ]] || fail "AT8 per-run key files left behind"
echo "----- M0.5 evidence v1.0.2 $(date -u +%FT%TZ) -----"
echo "image $IMAGE | agent-sdk $SDKV | model $MODEL | caps: \$$MAX_BUDGET_USD/run, $MAX_TURNS turns, 300 s"
jq -r '"\(.run): \(.turns) turns | sdk \(.duration_ms) ms (api \(.duration_api_ms) ms) | wall \(.wall_ms) ms | $\(.cost_usd) | in \(.tokens.inputTokens) out \(.tokens.outputTokens) cache-r \(.tokens.cacheReadInputTokens) cache-w \(.tokens.cacheCreationInputTokens) | tools \(.tool_calls), hook denies \(.hook_denies), sdk denials \(.permission_denials) | cc \(.claude_code)"' "$SUMMARY"
jq -r '.run as $r | .model_usage | to_entries[] | "  \($r) \(.key): in \(.value.inputTokens) out \(.value.outputTokens) cache-r \(.value.cacheReadInputTokens) cache-w \(.value.cacheCreationInputTokens) $\(.value.costUSD // "n/a")"' "$SUMMARY"
jq -s -r '"total: \(length) runs, $\((map(.cost_usd) | add) * 10000 | round / 10000)"' "$SUMMARY"
echo "AT9 repeat: $ROUNDS rounds passed with no manual step"
echo "AT8 secrets: $ENVF mode $(stat -c %a "$ENVF"), $DIR mode $(stat -c %a "$DIR"); key never printed, not in container env, not in evidence; per-run key files removed"
echo "evidence: $RUNS/m05-$STAMP-r*/ (messages.jsonl, hooks.jsonl, result.json, inspect.json), $SUMMARY"
echo "----- end evidence -----"

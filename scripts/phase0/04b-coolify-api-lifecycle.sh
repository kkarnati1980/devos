#!/usr/bin/env bash
# DevOS M0.4b — Coolify API lifecycle spike (create → deploy → update → rollback → delete, ×ROUNDS)
# Version: 1.0.2
# v1.0.1 (Codex review 14e71f7): ROUNDS must be an integer >= 2; leftover scan checks
# names AND labels of containers, volumes and networks; project deletion is required
# and verified (GET -> 404).
# v1.0.2 (Codex review d0e39c5): leftovers() fails on a docker inspect error instead of
# reading it as zero; only grep's no-match counts as 0. fail() writes to stderr.
# Run as root on the DevOS server after 04a:  bash 04b-coolify-api-lifecycle.sh
#
# Uses only the Coolify API (http://localhost:8000/api/v1) plus read-only `docker`
# checks for evidence. Request fields for /deploy and /rollback are taken from the
# installed OpenAPI spec (/root/.devos/openapi.yaml, written by 04a), so the script
# follows the running Coolify version. Never prints the token. Cleans up on failure.
set -euo pipefail

API=http://localhost:8000/api/v1
DIR=/root/.devos
ENVF="$DIR/coolify.env"
SPEC="$DIR/openapi.yaml"
PROJECT_NAME=devos-spike-m04
IMG=nginx
V1=1.26-alpine
V2=1.27-alpine
ROUNDS="${ROUNDS:-2}"
[[ "$ROUNDS" =~ ^[0-9]+$ && "$ROUNDS" -ge 2 ]] || { echo "ROUNDS must be an integer >= 2 (AT7 needs a repeat run)"; exit 1; }

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
pass() { printf '  \033[1;32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }
now()  { date +%s; }

[[ "${EUID}" -eq 0 ]] || { echo "Run as root"; exit 1; }
[[ -s "$SPEC" ]] || { echo "Missing $SPEC — run 04a first."; exit 1; }
apt-get install -y -qq jq python3-yaml >/dev/null
COOLIFY_TOKEN="$(sed -n 's/^COOLIFY_TOKEN=//p' "$ENVF" | head -n1)"
[[ -n "$COOLIFY_TOKEN" ]] || { echo "No token in $ENVF — run 04a first."; exit 1; }

CODE=""; BODY=""
api() {  # api METHOD PATH [JSON]  -> sets CODE, BODY
  local m="$1" p="$2" d="${3:-}" out
  local args=(-sS -X "$m" -w '\n%{http_code}' -H "Authorization: Bearer ${COOLIFY_TOKEN}" -H 'Accept: application/json')
  [[ -n "$d" ]] && args+=(-H 'Content-Type: application/json' --data "$d")
  out="$(curl "${args[@]}" "$API$p")"
  CODE="$(tail -n1 <<<"$out")"; BODY="$(head -n -1 <<<"$out")"
}
need() { [[ "$CODE" =~ ^2 ]] || fail "$1: HTTP $CODE $(head -c 600 <<<"$BODY")"; }

spec() {  # spec PATH METHOD -> {"body":[...],"required":[...],"query":[...]}
  python3 - "$SPEC" "$1" "$2" <<'PY'
import sys, yaml, json
s = yaml.safe_load(open(sys.argv[1])); op = s["paths"].get(sys.argv[2], {}).get(sys.argv[3], {})
sch = op.get("requestBody", {}).get("content", {}).get("application/json", {}).get("schema", {})
q = [x.get("name") for x in op.get("parameters", []) if isinstance(x, dict) and x.get("in") == "query"]
print(json.dumps({"body": sorted(sch.get("properties", {}).keys()), "required": sch.get("required", []), "query": q}))
PY
}

leftovers() {  # leftovers container|volume|network UUID -> count of objects whose name or labels mention UUID
  local kind="$1" id="$2" ids fmt
  case "$kind" in
    container) ids="$(docker ps -aq)";        fmt='{{.Name}} {{json .Config.Labels}}' ;;
    volume)    ids="$(docker volume ls -q)";  fmt='{{.Name}} {{json .Labels}}' ;;
    network)   ids="$(docker network ls -q)"; fmt='{{.Name}} {{json .Labels}}' ;;
  esac
  [[ -z "$ids" ]] && { echo 0; return; }
  # A failed inspect must not read as "no leftovers": capture first, then count.
  local out
  # shellcheck disable=SC2086
  out="$(docker "$kind" inspect --format "$fmt" $ids)" || fail "docker $kind inspect failed - cannot verify cleanup"
  grep -c -- "$id" <<<"$out" || true
}
images_for() { docker ps --filter "name=$1" --format '{{.Image}}' | sort -u; }
expect_image() {  # expect_image APP TAG
  local imgs
  for _ in $(seq 1 36); do
    imgs="$(images_for "$1")"
    if [[ -n "$imgs" && "$(wc -l <<<"$imgs")" -eq 1 && "$imgs" == *"${IMG}:$2" ]]; then pass "container runs ${IMG}:$2"; return 0; fi
    sleep 5
  done
  fail "expected only ${IMG}:$2 running for $1, saw: $(tr '\n' ' ' <<<"$imgs")"
}

wait_deploy() {  # wait_deploy DEPLOYMENT_UUID
  local st last=""
  for _ in $(seq 1 120); do
    api GET "/deployments/$1"; need "get deployment"
    st="$(jq -r '.status // empty' <<<"$BODY")"
    [[ "$st" != "$last" ]] && { echo "  deployment $1: $st"; last="$st"; }
    case "$st" in
      finished) return 0 ;;
      failed|error|cancelled*) fail "deployment $1 ended: $st" ;;
    esac
    sleep 5
  done
  fail "deployment $1 timed out (10 min)"
}

DEPLOY_SPEC="$(spec /deploy post)"
RB_SPEC="$(spec '/applications/{uuid}/rollback' post)"
deploy() {  # deploy APP_UUID
  local cand body dep
  if jq -e '.query | index("uuid")' <<<"$DEPLOY_SPEC" >/dev/null; then
    api POST "/deploy?uuid=$1&force=true"
  else
    cand="$(jq -nc --arg u "$1" '{uuid:$u, uuids:$u, force:true}')"
    body="$(jq -c --argjson k "$(jq -c .body <<<"$DEPLOY_SPEC")" 'with_entries(select(.key as $x | $k | index($x)))' <<<"$cand")"
    api POST /deploy "$body"
  fi
  need "deploy"
  dep="$(jq -r '[.. | objects | .deployment_uuid? // empty] | first // empty' <<<"$BODY")"
  [[ -n "$dep" ]] || fail "deploy returned no deployment_uuid: $(head -c 300 <<<"$BODY")"
  wait_deploy "$dep"
}

APP=""; PROJ=""
cleanup() {
  if [[ -n "$APP" ]]; then
    echo "  cleanup: deleting app $APP after failure"
    api DELETE "/applications/$APP?delete_configurations=true&delete_volumes=true&docker_cleanup=true&delete_connected_networks=true" || true
  fi
}
trap cleanup EXIT

say "Spec-derived request shapes"
echo "  POST /deploy:   $DEPLOY_SPEC"
echo "  POST rollback:  $RB_SPEC"

say "Server + project"
api GET /servers; need "list servers"
SERVER="$(jq -r '.[] | select(.name=="localhost") | .uuid' <<<"$BODY" | head -n1)"
[[ -n "$SERVER" ]] || fail "no 'localhost' server"
api GET /projects; need "list projects"
PROJ="$(jq -r --arg n "$PROJECT_NAME" '.[] | select(.name==$n) | .uuid' <<<"$BODY" | head -n1)"
if [[ -z "$PROJ" ]]; then
  api POST /projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')"; need "create project"
  PROJ="$(jq -r .uuid <<<"$BODY")"
fi
api GET "/projects/$PROJ/environments"; need "list environments"
ENVNAME="$(jq -r '[.[]? | .name] | first // empty' <<<"$BODY")"
if [[ -z "$ENVNAME" ]]; then
  api POST "/projects/$PROJ/environments" '{"name":"production"}'; need "create environment"; ENVNAME=production
fi
echo "  server=$SERVER project=$PROJ env=$ENVNAME"

SUMMARY=()
for r in $(seq 1 "$ROUNDS"); do
  say "Round $r/$ROUNDS"
  t0="$(now)"

  # AT2 create
  body="$(jq -nc --arg p "$PROJ" --arg s "$SERVER" --arg e "$ENVNAME" --arg i "$IMG" --arg t "$V1" --arg n "m04-r$r-$(now)" \
    '{project_uuid:$p, server_uuid:$s, environment_name:$e, docker_registry_image_name:$i, docker_registry_image_tag:$t,
      ports_exposes:"80", name:$n, instant_deploy:false, autogenerate_domain:false, docker_images_to_keep:3}')"
  api POST /applications/dockerimage "$body"; need "create app"
  APP="$(jq -r .uuid <<<"$BODY")"; [[ -n "$APP" && "$APP" != null ]] || fail "no app uuid"
  pass "AT2 created app $APP"; t1="$(now)"

  # AT3 deploy v1
  deploy "$APP"; expect_image "$APP" "$V1"; pass "AT3 deploy ${IMG}:$V1"; t2="$(now)"

  # AT4 update → v2
  api PATCH "/applications/$APP" "$(jq -nc --arg t "$V2" '{docker_registry_image_tag:$t}')"; need "patch tag"
  deploy "$APP"; expect_image "$APP" "$V2"; pass "AT4 update ${IMG}:$V2"; t3="$(now)"

  # AT5 rollback → v1
  method=""
  api GET "/applications/$APP/rollback-images"
  echo "  rollback-images HTTP $CODE: $(head -c 400 <<<"$BODY")"
  cand="$(jq -r '.. | strings' <<<"$BODY" 2>/dev/null | grep -m1 -- "$V1" || true)"
  if [[ "$CODE" =~ ^2 && -n "$cand" ]]; then
    rb="$(jq -nc --argjson k "$(jq -c .body <<<"$RB_SPEC")" --arg v "$cand" \
      'reduce ($k[] | select(test("tag|image|commit"))) as $x ({}; .[$x] = (if ($x | test("tag")) and ($v | test(":")) then ($v | split(":") | last) else $v end))')"
    api POST "/applications/$APP/rollback" "$rb"
    echo "  rollback body $rb -> HTTP $CODE: $(head -c 300 <<<"$BODY")"
    if [[ "$CODE" =~ ^2 ]]; then
      dep="$(jq -r '[.. | objects | .deployment_uuid? // empty] | first // empty' <<<"$BODY")"
      [[ -n "$dep" ]] && wait_deploy "$dep"
      method="api-rollback"
    fi
  fi
  if [[ -z "$method" ]]; then
    echo "  API rollback unavailable for this app — falling back to patch tag + redeploy"
    api PATCH "/applications/$APP" "$(jq -nc --arg t "$V1" '{docker_registry_image_tag:$t}')"; need "patch tag back"
    deploy "$APP"; method="patch-redeploy"
  fi
  expect_image "$APP" "$V1"; pass "AT5 rollback to ${IMG}:$V1 via $method"; t4="$(now)"

  # AT6 delete
  api DELETE "/applications/$APP?delete_configurations=true&delete_volumes=true&docker_cleanup=true&delete_connected_networks=true"; need "delete app"
  for _ in $(seq 1 24); do [[ -z "$(docker ps -a --filter "name=$APP" -q)" ]] && break; sleep 5; done
  c="$(leftovers container "$APP")"; v="$(leftovers volume "$APP")"; n="$(leftovers network "$APP")"
  api GET "/applications/$APP"; gone="$CODE"
  [[ "$c" -eq 0 && "$v" -eq 0 && "$n" -eq 0 && "$gone" == 404 ]] || fail "leftovers: containers=$c volumes=$v networks=$n api=$gone"
  pass "AT6 deleted — containers=0 volumes=0 networks=0, GET app -> 404"
  t5="$(now)"; APP=""

  SUMMARY+=("round $r: create $((t1-t0))s | deploy v1 $((t2-t1))s | update v2 $((t3-t2))s | rollback ($method) $((t4-t3))s | delete $((t5-t4))s | total $((t5-t0))s")
done

say "Remove spike project"
api DELETE "/projects/$PROJ"; need "delete project"
api GET "/projects/$PROJ"; [[ "$CODE" == 404 ]] || fail "project $PROJ still present (GET -> $CODE)"
pass "spike project deleted (GET -> 404)"

trap - EXIT
echo "----- M0.4 evidence v1.0.2 $(date -u +%FT%TZ) -----"
printf '%s\n' "${SUMMARY[@]}"
echo "AT7 repeat: $ROUNDS rounds passed with no manual cleanup"
echo "AT8 secrets: $ENVF mode $(stat -c %a "$ENVF"), $DIR mode $(stat -c %a "$DIR"); token never printed"
echo "----- end evidence -----"

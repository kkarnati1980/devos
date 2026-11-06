#!/usr/bin/env bash
# DevOS server check (R2-b, docs/modules/R2.md; G1 evidence "a killed run resumes"): queue one probe run
# in the dedicated `g1-probe` project (in-image probe adapter: no provider call, no spend), SIGKILL the
# worker once the run has checkpointed a turn, start the worker again, and require the run to finish from
# its checkpoint with every reservation closed and charged exactly once (`g1-cli.js probe-status`).
# Exit 0 pass, 1 fail, 3 skipped (DevOS not deployed, or the worker may hold another run: `probe-guard`
# right before the kill; the check never kills a worker that may hold a real run).
# Fits the server agent's 120 s check limit. Prints JSON lines; no secret.
set -uo pipefail
POLL="${G1_POLL_SECONDS:-2}"
KILL_BY="${G1_KILL_BY_SECONDS:-30}"     # the probe must checkpoint a turn within this
FINISH_BY="${G1_FINISH_BY_SECONDS:-105}" # overall deadline (seconds since start), under the agent's 120 s
command -v docker >/dev/null 2>&1 || { echo "skipped: docker not installed (DevOS not deployed yet)"; exit 3; }
worker() { timeout 20 docker ps "$@" --filter label=io.devos.service=worker --format '{{.ID}}' 2>/dev/null | head -n1; }
ID="$(worker --filter status=running)"
[[ "$ID" =~ ^[0-9a-f]{12,64}$ ]] || { echo "skipped: no running DevOS worker container (DevOS not deployed yet)"; exit 3; }
helper() { timeout 30 docker exec "$ID" node deploy/with-db-url.mjs node packages/run-engine/dist/g1-cli.js "$@" 2>/dev/null | grep -m1 '^{'; return "${PIPESTATUS[0]}"; }
field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\\(\"[^\"]*\"\\|[0-9.]*\\|true\\|false\\).*/\\1/p" | tr -d '"' | head -n1; }

start="$(helper probe-start)"; rc=$?
echo "probe-start: ${start:-no output}"
[[ "$rc" == 3 ]] && exit 3
[[ "$rc" == 0 ]] || exit 1
RUN="$(field "$start" runId)"
[[ "$RUN" =~ ^[0-9a-f-]{36}$ ]] || { echo "no run id from probe-start"; exit 1; }

# 1. wait until the probe has checkpointed at least one turn, then hard-kill the worker mid-run
turns=0
while (( SECONDS < KILL_BY )); do
  st="$(G1_REQUIRE_RESUME=0 helper probe-status "$RUN")"
  turns="$(field "$st" turns)"; status="$(field "$st" status)"
  [[ "$status" == queued || "$status" == running ]] || { echo "probe ended before the kill: $st"; exit 1; }
  [[ "${turns:-0}" =~ ^[0-9]+$ ]] && (( turns >= 1 )) && break
  sleep "$POLL"
done
(( ${turns:-0} >= 1 )) || { echo "probe did not checkpoint a turn within ${KILL_BY}s: ${st:-}"; exit 1; }
# PR21-r1: last gate right before the kill: the worker runs one job at a time and holds only the probe,
# which is mid-run with a turn left. Otherwise skip: the probe finishes on its own and nothing is killed.
guard="$(helper probe-guard "$RUN")"; rc=$?
echo "probe-guard: ${guard:-no output}"
if [[ "$rc" == 3 ]]; then echo "skipped: the worker may hold more than the probe; not killing it"; exit 3; fi
[[ "$rc" == 0 ]] || exit 1
echo "killing worker ${ID:0:12} at turn $turns (SIGKILL, no drain)"
timeout 20 docker kill --signal KILL "$ID" >/dev/null 2>&1 || { echo "docker kill failed"; exit 1; }
sleep 1
timeout 30 docker start "$ID" >/dev/null 2>&1 || { echo "docker start failed: the worker is down, restart it from Coolify"; exit 1; }
echo "worker ${ID:0:12} started again"

# 2. the run must finish from its checkpoint (BullMQ moves the stalled job back once its lock expires)
while (( SECONDS < FINISH_BY )); do
  st="$(helper probe-status "$RUN")"; rc=$?
  [[ "$rc" == 3 ]] || { echo "probe-status: $st"; exit "$(( rc == 0 ? 0 : 1 ))"; }
  sleep "$POLL"
done
echo "probe run $RUN did not finish within ${FINISH_BY}s: ${st:-}"
exit 1

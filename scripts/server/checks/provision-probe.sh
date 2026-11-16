#!/usr/bin/env bash
# DevOS server check (DEVOS-234 d3c-3, docs/modules/M2.4.md "M2.4-d3c-3 decisions"; AT13): advances the M2.4
# provisioning probe `devos-probe-m24` (provision twice, compare inventories, live asserts, purge through M2.5) by
# running `provision-probe-cli.js step` in the API container until the cycle stops being "in progress" or the time
# box ends, then reports the result.
# Each `step` runs DETACHED inside the container (d3c-2 pre-review 6: a purge can outlast one 120 s check, and a
# killed `docker exec` would leave the node process holding the project lock), with its output and exit code in
# /tmp/devos-probe/ there; a later run of this check picks up a step that finished after the time box.
# Exit 0 pass (the newest finished cycle passed), 1 fail, 3 skipped: DevOS not deployed, the probe is off (no
# provider token, or KK has not issued the probe's teardown grant), or a cycle is still running.
# Fits the server agent's 120 s check limit. Prints the CLI's JSON lines (fixed codes only); no secret.
set -uo pipefail
POLL="${PROBE_POLL_SECONDS:-3}"
FINISH_BY="${PROBE_FINISH_BY_SECONDS:-80}" # no new step or poll starts after this (seconds since start)
EXEC_S="${PROBE_EXEC_SECONDS:-15}"         # each docker call; 80 + 15 (poll) + 15 (report) + POLL stays under 120
D="${PROBE_STATE_DIR:-/tmp/devos-probe}" # inside the API container (overridable for the tests only)
CLI="node deploy/with-db-url.mjs node apps/api/dist/provision-probe-cli.js"
command -v docker >/dev/null 2>&1 || { echo "skipped: docker not installed (DevOS not deployed yet)"; exit 3; }
ID="$(timeout "$EXEC_S" docker ps --filter label=io.devos.service=api --filter status=running --format '{{.ID}}' 2>/dev/null | head -n1)"
[[ "$ID" =~ ^[0-9a-f]{12,64}$ ]] || { echo "skipped: no running DevOS API container (DevOS not deployed yet)"; exit 3; }
# Only fixed strings reach `sh -c`: no value read from the probe or the server is ever put into a command.
ex() { timeout "$EXEC_S" docker exec "$ID" sh -c "$1" 2>/dev/null; }
field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\\(\"[^\"]*\"\\|[0-9.]*\\|true\\|false\\).*/\\1/p" | tr -d '"' | head -n1; }

# poll -> "done <rc>" plus the step's JSON line (and the result is moved aside, so it is read once), "running",
# or "idle" (no step, or one whose process is gone without an exit code, e.g. after a container restart).
POLL_SH="if [ -f $D/rc ]; then printf 'done %s\n' \"\$(head -c 4 $D/rc)\"; grep -m1 '^{' $D/out 2>/dev/null | head -c 2000; echo;"\
" mv -f $D/rc $D/rc.last; mv -f $D/out $D/out.last 2>/dev/null; "\
"elif [ -f $D/pid ] && kill -0 \"\$(cat $D/pid)\" 2>/dev/null; then echo \"running \$(( \$(date +%s) - \$(stat -c %Y $D/pid) ))\"; else echo idle; fi"
# start -> one `step` in the background; its exit code is written only after it ends.
# The shell writes its own pid first and stays alive until the step ends, so "running" holds for the whole step.
START_SH="mkdir -p $D && rm -f $D/rc $D/out && echo \$\$ > $D/pid && { $CLI step > $D/out 2>/dev/null; echo \$? > $D/rc.tmp; mv -f $D/rc.tmp $D/rc; }"
START_GRACE="${PROBE_START_GRACE_SECONDS:-10}" # a step just started may not have written its pid yet
HUNG_AFTER="${PROBE_HUNG_SECONDS:-7200}"       # PROBE_PHASE_MAX_MS: a step still running after this is a failure

# report -> the newest finished cycle's JSON line, then `rc=<exit>` of the read-only `report` command.
REPORT_SH="o=\$($CLI report 2>/dev/null); r=\$?; printf '%s\\n' \"\$o\" | grep -m1 '^{' | head -c 2000; echo; echo rc=\$r"

finish() { # step rc, step JSON line -> exit of this check
  local rc="$1" line="$2" code rep rrc
  code="$(field "$line" code)"
  if [[ "$rc" == 3 && "$code" == probed ]]; then
    # The cycle finished earlier and the next one is not due: report the newest finished cycle.
    rep="$(ex "$REPORT_SH")"
    rrc="$(printf '%s\n' "$rep" | sed -n 's/^rc=\([0-9]\{1,3\}\)$/\1/p' | tail -n1)"
    rep="$(printf '%s\n' "$rep" | grep -m1 '^{')"
    echo "report: ${rep:-no output}"
    case "$rrc" in 0) exit 0;; 3) exit 3;; *) exit 1;; esac
  fi
  case "$rc" in
    0) echo "probe cycle passed"; exit 0;;
    1) if [[ -n "$code" ]]; then echo "probe cycle failed (code $code)"; else echo "probe step failed (error $(field "$line" error))"; fi; exit 1;;
    3) echo "skipped: ${code:-unknown}"; exit 3;;
    *) echo "probe CLI exit ${rc:-none}"; exit 1;;
  esac
}

started=0 pend="" lastphase=""
while (( SECONDS < FINISH_BY )); do
  p="$(ex "$POLL_SH")" || { echo "cannot read the probe state in the API container"; exit 1; }
  case "$p" in
    done\ *)
      rc="$(printf '%s\n' "$p" | head -n1 | sed -n 's/^done \([0-9]\{1,3\}\)$/\1/p')"
      line="$(printf '%s\n' "$p" | sed -n '2p')"
      echo "step: ${line:-no output} (exit ${rc:-none})"
      # One phase advanced and the cycle is still running: take the next step while the time box allows.
      if [[ "$rc" == 3 && "$(field "$line" code)" == in_progress ]]; then
        (( SECONDS < FINISH_BY )) || break
        # Pre-review 1: a step that did not move the phase (a provider retry) waits for the next check run, so a
        # retryable stop is not hammered every few seconds.
        phase="$(field "$line" phase)"
        if [[ -n "$lastphase" && "$phase" == "$lastphase" ]]; then echo "skipped: phase $phase is still in progress; the next check run retries"; exit 3; fi
        lastphase="$phase"
        timeout "$EXEC_S" docker exec -d "$ID" sh -c "$START_SH" >/dev/null 2>&1 || { echo "cannot start a probe step"; exit 1; }
        started=$((started + 1)); pend=$SECONDS; sleep "$POLL"; continue
      fi
      finish "$rc" "$line";;
    running\ *)
      pend=""; age="${p#running }"
      # Pre-review 2: a step that never ends would otherwise read as "in progress" for ever.
      if [[ "$age" =~ ^[0-9]+$ ]] && (( age > HUNG_AFTER )); then echo "a probe step has been running for ${age}s (over ${HUNG_AFTER}s): hung"; exit 1; fi
      sleep "$POLL";;
    idle)
      # `docker exec -d` returns before the step's shell runs: never start a second step inside the grace window.
      if [[ -n "$pend" ]] && (( SECONDS - pend < START_GRACE )); then sleep "$POLL"; continue; fi
      [[ -n "$pend" ]] && echo "the step started at ${pend}s left no exit code; starting another"
      timeout "$EXEC_S" docker exec -d "$ID" sh -c "$START_SH" >/dev/null 2>&1 || { echo "cannot start a probe step"; exit 1; }
      started=$((started + 1)); pend=$SECONDS; sleep "$POLL";;
    *) echo "unexpected probe state"; exit 1;;
  esac
done
echo "skipped: the probe cycle is still in progress after ${FINISH_BY}s ($started step(s) started this run); the next check run picks it up"
exit 3

#!/usr/bin/env bash
# DevOS server check (DEVOS-236, docs/modules/M2.5.md "DEVOS-236 decisions"): no Docker volume is left behind by a
# purged project's Coolify application. A purge deletes each application with delete_volumes=true, but Coolify's
# API cannot list the volumes of an application that is already gone, so this host-side scan is the backstop.
# Read-only: it lists volumes and never deletes one (a delete stays a purge decision).
# 1. The API container's `teardown-volumes-cli.js purged-apps` prints the uuids of Coolify application rows a purge
#    marked deleted.
# 2. `docker volume ls` lists every volume with its labels. A volume is a hit when its name is a purged uuid or
#    starts with one followed by `-` or `_` (Coolify's volume naming), or when one of its label values is exactly
#    a purged uuid.
# Exit 0 pass (no hit), 1 fail (hits, an incomplete list, or a read error), 3 skipped (DevOS not deployed: no docker
# on the host, or a successful `docker ps` finds no running API container). Prints fixed lines plus volume names and uuids, reduced to a fixed character set; never a secret.
set -uo pipefail
EXEC_S="${ORPHAN_EXEC_SECONDS:-30}"
CLI=(node deploy/with-db-url.mjs node apps/api/dist/teardown-volumes-cli.js purged-apps)
clean() { printf '%s' "$1" | tr -cd 'A-Za-z0-9._:/=,+-' | cut -c1-120; }
command -v docker >/dev/null 2>&1 || { echo "skipped: docker not installed (DevOS not deployed yet)"; exit 3; }
command -v jq >/dev/null 2>&1 || { echo "fail: jq not installed"; exit 1; }
# Codex PR209-r1: a failed or timed-out `docker ps` fails; only a successful search that finds no API skips.
ps="$(timeout "$EXEC_S" docker ps --filter label=io.devos.service=api --filter status=running --format '{{.ID}}' 2>/dev/null)"; prc=$?
[[ $prc -eq 0 ]] || { echo "fail: docker ps failed (exit $prc)"; exit 1; }
ID="$(printf '%s\n' "$ps" | head -n1)"
[[ -n "$ID" ]] || { echo "skipped: no running DevOS API container (DevOS not deployed yet)"; exit 3; }
[[ "$ID" =~ ^[0-9a-f]{12,64}$ ]] || { echo "fail: unreadable docker ps output"; exit 1; }
out="$(timeout "$EXEC_S" docker exec "$ID" "${CLI[@]}" 2>/dev/null)"; rc=$?
line="$(printf '%s\n' "$out" | grep -m1 '^{' || true)"
case "$rc" in
  0) ;;
  3) echo "fail: the API container has no database, so the scan cannot run"; exit 1 ;;   # Codex PR209-r2: never a skip
  124) echo "fail: the purged-application read timed out"; exit 1 ;;
  *) echo "fail: the purged-application read failed (exit $rc): $(clean "$(printf '%s' "$line" | jq -r '.error // "no output"' 2>/dev/null)")"; exit 1 ;;
esac
# Only uuids in the CLI's own shape are used; anything else makes the result incomplete, never clean (Codex
# PR209-r1: each element must be a string of the uuid shape inside jq, so an empty string or a number fails).
[[ -n "$line" ]] || { echo "fail: unreadable purged-application list"; exit 1; }
uuids="$(printf '%s' "$line" | jq -r '.uuids | if type == "array" and all(.[]; type == "string" and test("^[A-Za-z0-9-]{8,64}$")) then .[] else error("bad") end' 2>/dev/null)" || { echo "fail: unreadable purged-application list"; exit 1; }
invalid="$(printf '%s' "$line" | jq -r '.invalid | if type == "number" then . else error("bad") end' 2>/dev/null)" || { echo "fail: unreadable purged-application list"; exit 1; }
[[ "$invalid" =~ ^[0-9]{1,9}$ ]] || { echo "fail: unreadable purged-application list"; exit 1; }
while IFS= read -r u; do
  [[ -z "$u" ]] && continue
  [[ "$u" =~ ^[A-Za-z0-9-]{8,64}$ ]] || { echo "fail: unreadable purged-application list"; exit 1; }
done <<<"$uuids"
# Pre-review 1/2: labels are read as JSON (`docker volume inspect`), never split from text, so a label
# value holding a comma or a newline can neither hide a uuid nor fake one.
names="$(timeout "$EXEC_S" docker volume ls -q 2>/dev/null)"; vrc=$?
[[ $vrc -eq 0 ]] || { echo "fail: docker volume ls failed (exit $vrc)"; exit 1; }
n_apps=0; [[ -n "$uuids" ]] && n_apps="$(printf '%s\n' "$uuids" | grep -c .)"
hitlist=""
if [[ -n "$uuids" && -n "$names" ]]; then
  mapfile -t vlist <<<"$names"
  json="$(timeout "$EXEC_S" docker volume inspect -- "${vlist[@]}" 2>/dev/null)"; irc=$?
  [[ $irc -eq 0 ]] || { echo "fail: docker volume inspect failed (exit $irc)"; exit 1; }
  # Codex PR209-r2: empty output would make jq run zero times and pass; it is unreadable, never clean.
  [[ -n "${json//[[:space:]]/}" ]] || { echo "fail: unreadable docker volume inspect output"; exit 1; }
  ujson="$(printf '%s\n' "$uuids" | jq -R . | jq -s .)"
  # One "<uuid>\t<name>" line per hit: the name is a purged uuid or starts with one and `-` or `_`, or a label value
  # is exactly one. Volume names are reduced to the fixed set before they leave jq, so no newline gets through.
  njson="$(printf '%s\n' "${vlist[@]}" | jq -R . | jq -s .)"
  # Codex PR209-r1: the output must describe exactly the listed volumes, each with a name and a Labels field (an
  # object, or null for none); a missing volume or field makes the scan incomplete, never clean.
  hitlist="$(printf '%s' "$json" | jq -r --argjson u "$ujson" --argjson want "$njson" '
    if type == "array" and length == ($want | length)
       and all(.[]; type == "object" and (.Name | type) == "string" and has("Labels")
               and ((.Labels | type) == "object" or .Labels == null)
               and ((.Labels // {}) | all(.[]; type == "string")))
       and ([.[].Name] | sort) == ($want | sort)
    then .[] else error("bad") end
    | .Name as $n
    | [(.Labels // {})[]] as $vals
    | first($u[] as $x | select($n == $x or ($n | startswith($x + "-")) or ($n | startswith($x + "_")) or ($vals | index([$x]) != null)) | $x) as $hit
    | "\($hit)\t\($n | gsub("[^A-Za-z0-9._:/=,+-]"; ""))"' 2>/dev/null)" || { echo "fail: unreadable docker volume inspect output"; exit 1; }
fi
hits=0
while IFS=$'\t' read -r hit name; do
  [[ -z "$hit" ]] && continue
  hits=$((hits + 1))
  [[ $hits -le 15 ]] && echo "  leftover volume: $(clean "$name") (purged application $(clean "$hit"))"
done <<<"$hitlist"
[[ $hits -gt 15 ]] && echo "  ... $((hits - 15)) more"
if [[ $hits -gt 0 ]]; then echo "fail: $hits leftover volume(s) of purged applications ($n_apps purged applications checked)"; exit 1; fi
if [[ "$invalid" != 0 ]]; then echo "fail: $invalid purged application row(s) have an id the scan cannot match, so the scan is incomplete"; exit 1; fi
echo "ok: no leftover volume ($n_apps purged applications checked)"
exit 0

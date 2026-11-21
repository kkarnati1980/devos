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
# Exit 0 pass (no hit), 1 fail (hits, an incomplete list, or a read error), 3 skipped (DevOS not deployed, no
# database). Prints fixed lines plus volume names and uuids, reduced to a fixed character set; never a secret.
set -uo pipefail
EXEC_S="${ORPHAN_EXEC_SECONDS:-30}"
CLI=(node deploy/with-db-url.mjs node apps/api/dist/teardown-volumes-cli.js purged-apps)
clean() { printf '%s' "$1" | tr -cd 'A-Za-z0-9._:/=,+-' | cut -c1-120; }
command -v docker >/dev/null 2>&1 || { echo "skipped: docker not installed (DevOS not deployed yet)"; exit 3; }
command -v jq >/dev/null 2>&1 || { echo "fail: jq not installed"; exit 1; }
ID="$(timeout "$EXEC_S" docker ps --filter label=io.devos.service=api --filter status=running --format '{{.ID}}' 2>/dev/null | head -n1)"
[[ "$ID" =~ ^[0-9a-f]{12,64}$ ]] || { echo "skipped: no running DevOS API container (DevOS not deployed yet)"; exit 3; }
out="$(timeout "$EXEC_S" docker exec "$ID" "${CLI[@]}" 2>/dev/null)"; rc=$?
line="$(printf '%s\n' "$out" | grep -m1 '^{' || true)"
case "$rc" in
  0) ;;
  3) echo "skipped: no database in the API container"; exit 3 ;;
  124) echo "fail: the purged-application read timed out"; exit 1 ;;
  *) echo "fail: the purged-application read failed (exit $rc): $(clean "$(printf '%s' "$line" | jq -r '.error // "no output"' 2>/dev/null)")"; exit 1 ;;
esac
# Only uuids in the CLI's own shape are used; anything else makes the result incomplete, never clean.
[[ -n "$line" ]] || { echo "fail: unreadable purged-application list"; exit 1; }
uuids="$(printf '%s' "$line" | jq -r '.uuids | if type == "array" then .[] else error("bad") end' 2>/dev/null)" || { echo "fail: unreadable purged-application list"; exit 1; }
invalid="$(printf '%s' "$line" | jq -r '.invalid | if type == "number" then . else error("bad") end' 2>/dev/null)" || { echo "fail: unreadable purged-application list"; exit 1; }
[[ "$invalid" =~ ^[0-9]{1,9}$ ]] || { echo "fail: unreadable purged-application list"; exit 1; }
while IFS= read -r u; do
  [[ -z "$u" ]] && continue
  [[ "$u" =~ ^[A-Za-z0-9-]{8,64}$ ]] || { echo "fail: unreadable purged-application list"; exit 1; }
done <<<"$uuids"
vols="$(timeout "$EXEC_S" docker volume ls --format '{{.Name}}	{{.Labels}}' 2>/dev/null)"; vrc=$?
[[ $vrc -eq 0 ]] || { echo "fail: docker volume ls failed (exit $vrc)"; exit 1; }
n_apps=0; [[ -n "$uuids" ]] && n_apps="$(printf '%s\n' "$uuids" | grep -c .)"
hits=0
if [[ -n "$uuids" ]]; then
  declare -A purged=()
  while IFS= read -r u; do [[ -n "$u" ]] && purged["$u"]=1; done <<<"$uuids"
  while IFS=$'\t' read -r name labels; do
    [[ -z "$name" ]] && continue
    hit=""
    for u in "${!purged[@]}"; do
      if [[ "$name" == "$u" || "$name" == "$u-"* || "$name" == "$u"_* ]]; then hit="$u"; break; fi
    done
    if [[ -z "$hit" && -n "$labels" ]]; then
      IFS=',' read -r -a pairs <<<"$labels"
      for p in "${pairs[@]}"; do
        v="${p#*=}"
        [[ -n "${purged[$v]:-}" ]] && { hit="$v"; break; }
      done
    fi
    if [[ -n "$hit" ]]; then
      hits=$((hits + 1))
      [[ $hits -le 15 ]] && echo "  leftover volume: $(clean "$name") (purged application $(clean "$hit"))"
    fi
  done <<<"$vols"
fi
[[ $hits -gt 15 ]] && echo "  ... $((hits - 15)) more"
if [[ $hits -gt 0 ]]; then echo "fail: $hits leftover volume(s) of purged applications ($n_apps purged applications checked)"; exit 1; fi
if [[ "$invalid" != 0 ]]; then echo "fail: $invalid purged application row(s) have an id the scan cannot match, so the scan is incomplete"; exit 1; fi
echo "ok: no leftover volume ($n_apps purged applications checked)"
exit 0

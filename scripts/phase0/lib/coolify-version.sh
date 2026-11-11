# shellcheck shell=bash
# DevOS M0.4 — shared Coolify version check, sourced by 04a and 04b (DEVOS-54).
# Version: 1.0.0
# coolify_version BODY      -> prints the version string found in a /version response body.
#   Accepts a JSON string ("4.5.3"), a JSON object with a "version" field ({"version":"4.5.3"}),
#   or a bare text body (4.5.3). Prints nothing when no version can be read.
# coolify_version_ok CODE BODY -> exit 0 and prints the version when CODE is 200 and the version is 4.5.x;
#   otherwise prints a one-line reason (also on stdout, so callers capture it without stderr) and returns 1.
coolify_version() {
  python3 -c 'import json, sys
raw = sys.stdin.read().strip()
try:
    d = json.loads(raw)
except ValueError:
    d = raw
if isinstance(d, dict):
    d = d.get("version", "")
print(d.strip() if isinstance(d, str) else "")' <<<"$1" | head -c 200
}

coolify_version_ok() {
  local code="$1" v
  if [[ "$code" != 200 ]]; then echo "/version returned HTTP $code (API access or token?)"; return 1; fi
  v="$(coolify_version "$2")"
  if [[ ! "$v" =~ ^v?4\.5\.[0-9]+ ]]; then
    echo "Coolify version '${v:-unreadable}' is not 4.5.x - re-run 04a against the new spec before using 04b"
    return 1
  fi
  printf '%s\n' "$v"
}

#!/usr/bin/env bash
# DevOS M0.4a — Coolify API discovery (read-only)
# Version: 1.0.1
# v1.0.1: never source the env file — Coolify tokens contain '|', which the shell
# treated as a pipe and echoed part of the token in an error. Read it as data.
# Run as root on the DevOS server:  bash 04a-coolify-api-discover.sh
# Stores the Coolify API token in /root/.devos/coolify.env (600) via a hidden prompt.
# Never prints the token. Creates nothing in Coolify.
set -euo pipefail

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
if [[ "${EUID}" -ne 0 ]]; then echo "Run as root"; exit 1; fi

API=http://localhost:8000/api/v1
DIR=/root/.devos
ENVF="$DIR/coolify.env"
install -d -m 700 "$DIR"

say "1/5 Token"
if [[ ! -s "$ENVF" ]]; then
  read -rsp "Paste the Coolify API token (input hidden), then Enter: " TOKEN; echo
  [[ -n "$TOKEN" ]] || { echo "Empty token — aborting."; exit 1; }
  umask 077; printf 'COOLIFY_TOKEN=%s\n' "$TOKEN" > "$ENVF"; unset TOKEN
fi
chmod 600 "$ENVF"
COOLIFY_TOKEN="$(sed -n 's/^COOLIFY_TOKEN=//p' "$ENVF" | head -n1)"
[[ -n "$COOLIFY_TOKEN" ]] || { echo "Token file empty — delete $ENVF and re-run."; exit 1; }
echo "  token stored: $ENVF ($(stat -c %a "$ENVF")), dir $(stat -c %a "$DIR")"

api() { curl -sS -w '\n%{http_code}' -H "Authorization: Bearer ${COOLIFY_TOKEN}" -H 'Accept: application/json' "$API$1"; }

say "2/5 Version (AT1)"
OUT="$(api /version)"; echo "  HTTP $(tail -n1 <<<"$OUT")  body: $(head -n -1 <<<"$OUT" | head -c 200)"

say "3/5 Servers + projects"
for ep in /servers /projects; do
  OUT="$(api "$ep")"; code="$(tail -n1 <<<"$OUT")"
  echo "  $ep HTTP $code"
  head -n -1 <<<"$OUT" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception as e: print("   (not JSON)"); sys.exit()
for x in (d if isinstance(d,list) else [d]): print("   -", x.get("uuid"), "|", x.get("name"))'
done

say "4/5 Installed OpenAPI spec"
apt-get install -y -qq python3-yaml >/dev/null
SPEC="$DIR/openapi.yaml"
docker cp coolify:/var/www/html/openapi.yaml "$SPEC" 2>/dev/null || docker cp coolify:/var/www/html/openapi.json "$SPEC" 2>/dev/null || { echo "  spec not found in container"; exit 1; }
echo "  copied to $SPEC"

say "5/5 Operations DevOS needs"
python3 - "$SPEC" <<'PY'
import sys, yaml, re
spec = yaml.safe_load(open(sys.argv[1]))
paths = spec.get("paths", {})
want = re.compile(r"(version|enable|servers|projects|applications|deploy|deployments|rollback)", re.I)
print("# paths")
for p in sorted(paths):
    if want.search(p):
        print(f"  {' '.join(m.upper() for m in paths[p] if m in ('get','post','patch','put','delete')):<22} {p}")
def body(p, m):
    op = paths.get(p, {}).get(m, {})
    sch = op.get("requestBody", {}).get("content", {}).get("application/json", {}).get("schema", {})
    return sch.get("required", []), sorted(sch.get("properties", {}).keys())
def params(p, m):
    op = paths.get(p, {}).get(m, {})
    return [f"{x.get('name')}({x.get('in')})" for x in op.get("parameters", []) + paths.get(p, {}).get("parameters", []) if isinstance(x, dict)]
for p, m in [("/applications/dockerimage","post"), ("/applications/{uuid}","patch"), ("/projects","post")]:
    r, props = body(p, m)
    print(f"# {m.upper()} {p}\n  required: {r}")
    print("  props:", ", ".join(x for x in props if re.search(r"uuid|environment|image|port|name|instant|domain|health", x)))
for p, m in [("/deploy","get"), ("/deployments/{uuid}","get"), ("/applications/{uuid}","delete"), ("/applications/{uuid}","get")]:
    print(f"# {m.upper()} {p}  params: {params(p, m)}")
rb = [p for p in paths if "rollback" in p.lower()]
print("# rollback endpoints:", rb or "none")
print("# auth schemes:", list(spec.get("components", {}).get("securitySchemes", {}).keys()))
PY
echo
echo "Done. Paste everything from step 2 down back to Claude (it contains no secrets)."

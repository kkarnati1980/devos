#!/usr/bin/env bash
# DevOS — daily `tailscale cert` renewal for the certificate the api and the dashboard share (R3-d, DEVOS-87)
# Version: 1.0.1
# v1.0.1 (Codex PR28-r1): "valid now" also checks notBefore; a certificate that is not valid yet changes nothing.
# Contract: docs/modules/R3.md (R3-d) and docs/modules/server-agent.md (allow-list). Run by server-agent.sh
# once a day (root); never run with arguments taken from GitHub content.
# 1. Asks `tailscale cert` for this node's MagicDNS name, writing to a temp dir inside the TLS dir.
# 2. Checks the new pair: both files non-empty, the certificate parses, is valid now, names the MagicDNS host,
#    and matches the key. A bad pair changes nothing.
# 3. Unchanged files: nothing else happens (tailscale reuses a certificate until it is close to expiry).
#    Changed files: each is renamed over the old one with the old file's owner and mode (the containers run
#    as uid 1000), then the running api and dashboard containers (labels io.devos.service=api|dashboard) are
#    restarted, because both load the files at start-up only. A failed restart leaves a marker so the next
#    run restarts again even though the files are then unchanged.
# Files: DEVOS_TLS_DIR (default /root/.devos/tls; TLS_DIR= in server-agent.conf overrides it). The names are
# TLS_CERT_NAME= / TLS_KEY_NAME= in server-agent.conf, else the single *.crt and *.key already in the dir.
# Exit 0 renewed or unchanged, 1 failed (nothing replaced unless stated), 3 skipped (not set up yet).
# Prints no key material and no secret.
set -uo pipefail
DIR="${DEVOS_DIR:-/root/.devos}"
ST="$DIR/agent"
CONF="$DIR/server-agent.conf"
conf() { sed -n "s/^$1=\\([A-Za-z0-9._\\/-]\\{1,200\\}\\)\$/\\1/p" "$CONF" 2>/dev/null | head -n1; }
TLS="$(conf TLS_DIR)"; TLS="${TLS:-${DEVOS_TLS_DIR:-$DIR/tls}}"
PENDING="$ST/cert-restart-pending"

command -v tailscale >/dev/null 2>&1 || { echo "skipped: tailscale not installed"; exit 3; }
[[ -d "$TLS" ]] || { echo "skipped: no TLS directory $TLS (issue the first certificate as in deploy/README.md)"; exit 3; }
command -v openssl >/dev/null 2>&1 || { echo "openssl not installed: cannot check a new certificate"; exit 1; }

pick() {  # conf-key glob -> one file name in $TLS
  local n; n="$(conf "$1")"
  if [[ -n "$n" ]]; then [[ "$n" != */* && -s "$TLS/$n" ]] && { printf '%s' "$n"; return 0; }; return 1; fi
  local all=("$TLS"/$2)
  [[ ${#all[@]} -eq 1 && -s "${all[0]}" ]] || return 1
  basename "${all[0]}"
}
CRT="$(pick TLS_CERT_NAME '*.crt')" || { echo "cannot tell which certificate to renew: set TLS_CERT_NAME= in $CONF (exactly one non-empty *.crt expected in the TLS dir)"; exit 1; }
KEY="$(pick TLS_KEY_NAME '*.key')" || { echo "cannot tell which key to renew: set TLS_KEY_NAME= in $CONF (exactly one non-empty *.key expected in the TLS dir)"; exit 1; }

NAME="$(timeout 10 tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' 2>/dev/null | sed 's/\.$//')"
[[ "$NAME" =~ ^[A-Za-z0-9.-]+\.ts\.net$ ]] || { echo "no MagicDNS name (tailscale status --json)"; exit 1; }

NEW="$(mktemp -d "$TLS/.renew.XXXXXX")" || { echo "cannot create a temp dir in $TLS"; exit 1; }
chmod 700 "$NEW"; trap 'rm -rf "$NEW"' EXIT

restart() {  # restarts the running api and dashboard containers; 0 only if every one restarted
  local svc ids id ok=0 n=0
  command -v docker >/dev/null 2>&1 || { echo "docker not installed: cannot restart"; return 1; }
  for svc in api dashboard; do
    ids="$(timeout 20 docker ps --filter "label=io.devos.service=$svc" --filter status=running --format '{{.ID}}' 2>/dev/null)" \
      || { echo "docker ps failed ($svc)"; ok=1; continue; }
    [[ -n "$ids" ]] || { echo "no running $svc container (label io.devos.service=$svc)"; ok=1; continue; }
    for id in $ids; do
      [[ "$id" =~ ^[0-9a-f]{6,64}$ ]] || { echo "unexpected container id from docker ps"; ok=1; continue; }
      if timeout 120 docker restart "$id" >/dev/null 2>&1; then echo "restarted $svc ${id:0:12}"; n=$((n + 1))
      else echo "docker restart failed: $svc ${id:0:12}"; ok=1; fi
    done
  done
  return "$ok"
}

if ! timeout 120 tailscale cert --cert-file "$NEW/c" --key-file "$NEW/k" "$NAME" >"$NEW/out" 2>&1; then
  echo "tailscale cert failed for $NAME; the current files are unchanged"
  tail -n 5 "$NEW/out" | grep -v -i 'private key' || true
  exit 1
fi
[[ -s "$NEW/c" && -s "$NEW/k" ]] || { echo "tailscale cert wrote an empty file; the current files are unchanged"; exit 1; }
openssl x509 -in "$NEW/c" -noout -checkend 0 >/dev/null 2>&1 \
  || { echo "new certificate does not parse or is expired; the current files are unchanged"; exit 1; }
NB="$(openssl x509 -in "$NEW/c" -noout -startdate 2>/dev/null | cut -d= -f2)"
nbs="$(date -d "$NB" +%s 2>/dev/null)"
[[ "$nbs" =~ ^[0-9]+$ ]] && (( nbs <= $(date +%s) )) \
  || { echo "new certificate is not valid yet (notBefore $NB); the current files are unchanged"; exit 1; }
openssl x509 -in "$NEW/c" -noout -checkhost "$NAME" 2>/dev/null | grep -q 'does match' \
  || { echo "new certificate does not name $NAME; the current files are unchanged"; exit 1; }
cpub="$(openssl x509 -in "$NEW/c" -noout -pubkey 2>/dev/null | openssl sha256 2>/dev/null)"
kpub="$(openssl pkey -in "$NEW/k" -pubout 2>/dev/null | openssl sha256 2>/dev/null)"
[[ -n "$cpub" && "$cpub" == "$kpub" ]] || { echo "new certificate and key do not match; the current files are unchanged"; exit 1; }
END="$(openssl x509 -in "$NEW/c" -noout -enddate 2>/dev/null | cut -d= -f2)"

if cmp -s "$NEW/c" "$TLS/$CRT" && cmp -s "$NEW/k" "$TLS/$KEY"; then
  echo "certificate for $NAME unchanged (valid until $END)"
  if [[ -e "$PENDING" ]]; then
    echo "an earlier restart failed; restarting now"
    restart || { echo "restart still failing; will retry"; exit 1; }
    rm -f "$PENDING"
  fi
  exit 0
fi

# Same owner and mode as the files they replace, then rename (atomic per file, same filesystem).
for p in "c:$CRT" "k:$KEY"; do
  src="$NEW/${p%%:*}"; dst="$TLS/${p#*:}"
  chown --reference="$dst" "$src" && chmod --reference="$dst" "$src" \
    || { echo "cannot copy owner/mode of ${p#*:}; the current files are unchanged"; exit 1; }
done
cp -p "$TLS/$CRT" "$NEW/c.prev" && cp -p "$TLS/$KEY" "$NEW/k.prev" || { echo "cannot back up the current files; unchanged"; exit 1; }
if ! { mv -f "$NEW/k" "$TLS/$KEY" && mv -f "$NEW/c" "$TLS/$CRT"; }; then
  mv -f "$NEW/k.prev" "$TLS/$KEY"; mv -f "$NEW/c.prev" "$TLS/$CRT"
  echo "replacing the files failed; the previous files were restored"; exit 1
fi
echo "certificate for $NAME renewed (valid until $END): $CRT, $KEY"
mkdir -p "$ST" 2>/dev/null; touch "$PENDING" 2>/dev/null
restart || { echo "restart failed; the next run restarts again"; exit 1; }
rm -f "$PENDING"
exit 0

#!/usr/bin/env bash
# DevOS server check (R2-d, docs/modules/R2.md; G1 evidence "receipt chain"): every M1.7 policy receipt chain
# verifies (gapless seq, prev hash, hash, HMAC) with the server key. Read-only, through the deployed worker
# container (`g1-cli.js receipts`). Exit 0 pass, 1 fail, 3 skipped (DevOS not deployed, or no receipt
# written yet). Prints one JSON line from the helper; never a secret.
set -uo pipefail
command -v docker >/dev/null 2>&1 || { echo "skipped: docker not installed (DevOS not deployed yet)"; exit 3; }
ID="$(timeout 20 docker ps --filter label=io.devos.service=worker --filter status=running --format '{{.ID}}' 2>/dev/null | head -n1)"
[[ "$ID" =~ ^[0-9a-f]{12,64}$ ]] || { echo "skipped: no running DevOS worker container (DevOS not deployed yet)"; exit 3; }
out="$(timeout 60 docker exec "$ID" node deploy/with-db-url.mjs node packages/run-engine/dist/g1-cli.js receipts 2>/dev/null)"; rc=$?
line="$(printf '%s\n' "$out" | grep -m1 '^{' || true)"
echo "receipts: ${line:-no output}"
case "$rc" in 0|3) exit "$rc" ;; 124) echo "helper timed out"; exit 1 ;; *) exit 1 ;; esac

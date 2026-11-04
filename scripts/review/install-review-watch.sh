#!/usr/bin/env bash
# DevOS — install the review watcher on the DevOS server (DEVOS-60)
# Version: 1.0.0
# Run as root from a checkout of this repo (interactive only for the first-time hidden token prompt):
#   ssh -t root@devos 'cd /root/devos-review && bash scripts/review/install-review-watch.sh'
# ROTATE_TOKEN=1 re-prompts. INTERVAL=3min sets the timer period.
# Installs: /root/.devos/bin/{review-commit.sh,review-watch.sh}, /root/.devos/github-review.env (600),
#           systemd devos-review-watch.service + .timer. Prints evidence; changes nothing else.
set -euo pipefail
DIR=/root/.devos
ENVF="$DIR/github-review.env"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERVAL="${INTERVAL:-3min}"
pass() { printf '  \033[1;32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }
[[ "${EUID}" -eq 0 ]] || fail "run as root"
[[ -f "$SRC/review-watch.sh" && -f "$SRC/review-commit.sh" ]] || fail "run from a repo checkout"
[[ -s "$DIR/verdict.schema.json" ]] || fail "M0.3 review setup missing ($DIR/verdict.schema.json)"
command -v codex >/dev/null || fail "codex CLI missing (M0.3)"
apt-get install -y -qq jq curl >/dev/null

echo "==> 1/4 scripts"
install -d -m 700 "$DIR" "$DIR/bin"
install -m 700 "$SRC/review-commit.sh" "$DIR/bin/review-commit.sh"
install -m 700 "$SRC/review-watch.sh" "$DIR/bin/review-watch.sh"
bash -n "$DIR/bin/review-watch.sh" && pass "scripts installed to $DIR/bin"

echo "==> 2/4 GitHub token (hidden)"
if [[ ! -s "$ENVF" || "${ROTATE_TOKEN:-0}" == 1 ]]; then
  echo "  Fine-grained token, repository kkarnati1980/devos ONLY:"
  echo "  Pull requests: Read and write · Commit statuses: Read and write · Contents: Read · Metadata: Read"
  read -rsp "  Paste the token (input hidden), then Enter: " T; echo
  [[ "$T" =~ ^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$ ]] || { unset T; fail "that does not look like a GitHub token"; }
  ( umask 077; printf 'GITHUB_REVIEW_TOKEN=%s\n' "$T" > "$ENVF" ); unset T
fi
chmod 600 "$ENVF"
TMP="$(mktemp -d)"; chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
( umask 077; printf 'Authorization: Bearer %s\n' "$(sed -n 's/^GITHUB_REVIEW_TOKEN=//p' "$ENVF" | head -n1 | tr -d '\r\n')" > "$TMP/auth" )
code="$(curl -sS -o "$TMP/r" -w '%{http_code}' -H @"$TMP/auth" -H 'Accept: application/vnd.github+json' https://api.github.com/repos/kkarnati1980/devos/pulls?state=open)"
[[ "$code" == 200 ]] || fail "token cannot list devos PRs (HTTP $code)"
pass "token can read devos PRs ($(jq length "$TMP/r") open); file mode $(stat -c %a "$ENVF")"

echo "==> 3/4 dry run"
"$DIR/bin/review-watch.sh" --dry-run | sed 's/^/  /'

echo "==> 4/4 systemd timer (every $INTERVAL)"
cat > /etc/systemd/system/devos-review-watch.service <<UNIT
[Unit]
Description=DevOS review watcher (Codex review on new PR heads)
After=network-online.target
[Service]
Type=oneshot
ExecStart=$DIR/bin/review-watch.sh
TimeoutStartSec=1200
UNIT
cat > /etc/systemd/system/devos-review-watch.timer <<UNIT
[Unit]
Description=Run the DevOS review watcher every $INTERVAL
[Timer]
OnBootSec=2min
OnUnitActiveSec=$INTERVAL
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now devos-review-watch.timer >/dev/null
systemctl list-timers devos-review-watch.timer --no-pager | sed 's/^/  /'
pass "timer enabled; logs: journalctl -u devos-review-watch -n 50"
echo "Uninstall: systemctl disable --now devos-review-watch.timer"

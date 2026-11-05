#!/usr/bin/env bash
# DevOS — install the review watcher on the DevOS server (DEVOS-60)
# Version: 1.0.3
# v1.0.3 (first live tick, 5 Nov): the service runs with User=root, HOME=/root and a normal PATH. Under systemd's
# bare environment the runner's SSH fetch failed (Permission denied (publickey)), and codex needs HOME for its
# login. RETRY_FAILED=1 clears done-markers of SHAs whose review could not run, so they are reviewed again.
# v1.0.2: CI state is read via the Actions API (fine-grained tokens cannot hold Checks); probe Actions: Read.
# v1.0.1: the token check covers every read the watcher needs (pulls, check runs, statuses) and names the
# missing permission; Checks: Read added to the required list.
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
  echo "  Pull requests: Read and write · Commit statuses: Read and write · Actions: Read · Contents: Read · Metadata: Read"
  read -rsp "  Paste the token (input hidden), then Enter: " T; echo
  [[ "$T" =~ ^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$ ]] || { unset T; fail "that does not look like a GitHub token"; }
  ( umask 077; printf 'GITHUB_REVIEW_TOKEN=%s\n' "$T" > "$ENVF" ); unset T
fi
chmod 600 "$ENVF"
TMP="$(mktemp -d)"; chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
( umask 077; printf 'Authorization: Bearer %s\n' "$(sed -n 's/^GITHUB_REVIEW_TOKEN=//p' "$ENVF" | head -n1 | tr -d '\r\n')" > "$TMP/auth" )
probe() {  # path permission-name -> 200 or fail naming the missing permission
  local c
  c="$(curl -sS -o "$TMP/r" -w '%{http_code}' -H @"$TMP/auth" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/kkarnati1980/devos$1")"
  [[ "$c" == 200 ]] || fail "token cannot read $1 (HTTP $c) - add '$2' to the token (GitHub token settings, Edit; the token value stays the same)"
}
probe "/pulls?state=open" "Pull requests: Read and write"
n="$(jq length "$TMP/r")"
probe "/commits/main" "Contents: Read"
head="$(jq -r .sha "$TMP/r")"
probe "/actions/runs?head_sha=$head&per_page=1" "Actions: Read"
probe "/commits/$head/statuses" "Commit statuses: Read and write"
pass "token can read PRs ($n open), commits, workflow runs and statuses; file mode $(stat -c %a "$ENVF")"
echo "  (write access to comments and statuses is proven by the first real review, AT8)"

if [[ "${RETRY_FAILED:-0}" == 1 ]]; then
  for f in "$DIR"/watch/*.done; do
    [[ -e "$f" ]] || continue
    sha="$(basename "$f" .done)"
    if [[ ! -s "$DIR/verdicts/$sha.json" ]]; then rm -f "$f" "$DIR/watch/$sha.pr"; echo "  cleared failed attempt for ${sha:0:7}"; fi
  done
fi
echo "==> 3/4 dry run"
"$DIR/bin/review-watch.sh" --dry-run 2>&1 | sed "s/^/  /"

echo "==> 4/4 systemd timer (every $INTERVAL)"
cat > /etc/systemd/system/devos-review-watch.service <<UNIT
[Unit]
Description=DevOS review watcher (Codex review on new PR heads)
After=network-online.target
[Service]
Type=oneshot
User=root
Environment=HOME=/root
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WorkingDirectory=/root
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
echo "  service-environment check (deploy-key fetch as the service would run it):"
if systemd-run --quiet --wait --pipe --collect -p User=root -E HOME=/root \
     -E PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
     /usr/bin/env GIT_SSH_COMMAND="ssh -i /root/.ssh/devos_ro -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
     git -C /root/devos-review fetch -q origin > "$TMP/fetch.log" 2>&1; then
  pass "deploy-key fetch works under systemd"
else
  sed 's/^/    /' "$TMP/fetch.log"
  ls -l /root/.ssh/devos_ro /root/.ssh/known_hosts 2>&1 | sed 's/^/    /'
  fail "deploy-key fetch fails under systemd - send this output to Claude"
fi
systemctl list-timers devos-review-watch.timer --no-pager | sed 's/^/  /'
pass "timer enabled; logs: journalctl -u devos-review-watch -n 50"
echo "Uninstall: systemctl disable --now devos-review-watch.timer"

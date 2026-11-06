#!/usr/bin/env bash
# DevOS — install the server agent on the DevOS server (DEVOS-74). Contract: docs/modules/server-agent.md
# Version: 1.1.2
# v1.1.2 (Codex PR11-r4): --deploy-on and --deploy-off change the switch under the agent's lock.
# v1.1.1 (Codex PR11-r2): RETRY_DEPLOY=1 clears only a recorded failure, under the agent's lock.
# v1.1.0 (Codex PR11-r1): --uninstall also stops a running tick; RETRY_DEPLOY=1 clears a failed deploy of the
# installed SHA so the next tick deploys it again.
# Run once as root from a checkout of main (interactive: hidden prompts for the Coolify token and app UUID,
# and a yes/no for KK's first-launch approval of deploy-on-PASS).
#   bash scripts/server/install-server-agent.sh               install / update (keeps stored secrets)
#   ROTATE_COOLIFY=1 bash .../install-server-agent.sh         re-prompt the Coolify token and app UUID
#   bash /root/.devos/bin/install-server-agent.sh --deploy-on  approve deploy-on-PASS (asks to confirm)
#   bash /root/.devos/bin/install-server-agent.sh --deploy-off turn deploy-on-PASS off
#   bash /root/.devos/bin/install-server-agent.sh --uninstall  stop and remove the timer and service
#   RETRY_DEPLOY=1 bash /root/.devos/bin/install-server-agent.sh --deploy-on   retry a failed deploy of the installed SHA
# Secrets are never printed; they are written to mode-600 files only.
set -euo pipefail
DIR=/root/.devos
ST="$DIR/agent"
CF_ENV="$DIR/coolify-deploy.env"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT=devos-server-agent
pass() { printf '  \033[1;32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }
[[ "${EUID}" -eq 0 ]] || fail "run as root"

case "${1:-}" in
  --uninstall)
    systemctl disable --now "$UNIT.timer" >/dev/null 2>&1 || true
    systemctl stop "$UNIT.service" >/dev/null 2>&1 || true   # waits for a running tick to end
    if systemctl is-active --quiet "$UNIT.service"; then fail "$UNIT.service is still running; rerun --uninstall"; fi
    rm -f "/etc/systemd/system/$UNIT.service" "/etc/systemd/system/$UNIT.timer"
    systemctl daemon-reload
    pass "server agent removed (env files, review watcher and $DIR/bin scripts left in place)"; exit 0 ;;
  --deploy-off)
    install -d -m 700 "$ST"; exec 6>>"$ST/agent.lock"
    flock -w 1600 6 || fail "the agent tick did not finish; rerun --deploy-off"
    rm -f "$ST/deploy.enabled"; flock -u 6; pass "deploy-on-PASS is OFF (a deployment already started is still finished and reported)"; exit 0 ;;
  --deploy-on) ASK_DEPLOY=1 ;;
  "") ASK_DEPLOY=1 ;;
  *) fail "unknown option $1" ;;
esac

if [[ "${1:-}" != --deploy-on ]]; then
  [[ -f "$SRC/server-agent.sh" ]] || fail "run from a repo checkout (scripts/server/)"
  [[ -s "$DIR/github-review.env" ]] || fail "review watcher not installed ($DIR/github-review.env missing)"
  [[ -s /root/.ssh/devos_ro ]] || fail "read-only deploy key /root/.ssh/devos_ro missing (M0.3)"
  apt-get install -y -qq jq curl >/dev/null

  echo "==> 1/4 scripts"
  install -d -m 700 "$DIR" "$DIR/bin" "$DIR/bin/checks" "$ST"
  bash -n "$SRC/server-agent.sh"
  install -m 700 "$SRC/server-agent.sh" "$DIR/bin/server-agent.sh"
  install -m 700 "$SRC/install-server-agent.sh" "$DIR/bin/install-server-agent.sh"
  for f in "$SRC"/checks/*.sh; do [[ -e "$f" ]] && bash -n "$f" && install -m 700 "$f" "$DIR/bin/checks/"; done
  pass "installed to $DIR/bin ($(ls "$DIR"/bin/checks/*.sh 2>/dev/null | wc -l) checks)"

  echo "==> 2/4 Coolify API token (hidden)"
  if [[ ! -s "$CF_ENV" || "${ROTATE_COOLIFY:-0}" == 1 ]]; then
    echo "  Coolify → Keys & Tokens → API tokens → Create (permission: deploy + read). Copy it."
    read -rsp "  Paste the Coolify API token (input hidden), then Enter: " T; echo
    [[ "$T" =~ ^[A-Za-z0-9|._-]{20,}$ ]] || { unset T; fail "that does not look like a Coolify API token"; }
    read -rp "  DevOS application UUID (Coolify → DevOS app → the id in the URL): " U
    [[ "$U" =~ ^[A-Za-z0-9-]{8,64}$ ]] || { unset T; fail "that does not look like an application UUID"; }
    ( umask 077; printf 'COOLIFY_TOKEN=%s\nCOOLIFY_APP_UUID=%s\n' "$T" "$U" > "$CF_ENV" ); unset T
  fi
  chmod 600 "$CF_ENV"
  TMP="$(mktemp -d)"; chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
  ( umask 077; printf 'Authorization: Bearer %s\n' "$(sed -n 's/^COOLIFY_TOKEN=//p' "$CF_ENV" | head -n1 | tr -d '\r\n')" > "$TMP/auth" )
  U="$(sed -n 's/^COOLIFY_APP_UUID=//p' "$CF_ENV" | head -n1 | tr -d '\r\n')"
  c="$(curl -sS --connect-timeout 10 --max-time 30 -o "$TMP/r" -w '%{http_code}' -H @"$TMP/auth" -H 'Accept: application/json' "http://localhost:8000/api/v1/applications/$U" || true)"
  if [[ "$c" == 200 ]]; then pass "token reads the app '$(jq -r '.name // "?"' "$TMP/r")'; file mode $(stat -c %a "$CF_ENV")"
  else fail "Coolify API answered HTTP $c for that app - check the token and UUID, then rerun with ROTATE_COOLIFY=1"; fi

  echo "==> 3/4 dry run"
  "$DIR/bin/server-agent.sh" --dry-run 2>&1 | sed 's/^/  /'

  echo "==> 4/4 systemd timer (every 3 min)"
  cat > "/etc/systemd/system/$UNIT.service" <<UNITF
[Unit]
Description=DevOS server agent (self-update, deploy-on-PASS, server checks)
After=network-online.target
[Service]
Type=oneshot
User=root
Environment=HOME=/root
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WorkingDirectory=/root
ExecStart=$DIR/bin/server-agent.sh
TimeoutStartSec=1500
UNITF
  cat > "/etc/systemd/system/$UNIT.timer" <<UNITF
[Unit]
Description=Run the DevOS server agent every 3 minutes
[Timer]
OnBootSec=3min
OnUnitActiveSec=3min
Persistent=true
[Install]
WantedBy=timers.target
UNITF
  systemctl daemon-reload
  systemctl enable --now "$UNIT.timer" >/dev/null
  pass "timer enabled; logs: journalctl -u $UNIT -n 50"
fi

if [[ "${ASK_DEPLOY:-0}" == 1 && ! -e "$ST/deploy.enabled" ]]; then
  echo "==> First launch: deploy-on-PASS redeploys DevOS through Coolify for every main SHA with green CI + Codex PASS."
  read -rp "  Approve deploy-on-PASS now? Type yes or no: " A
  if [[ "$A" == yes ]]; then
    install -d -m 700 "$ST"
    # Hold the agent's lock, so a deploy-disabled tick cannot re-mark the SHA done after this cleanup.
    exec 6>>"$ST/agent.lock"
    echo "  waiting for any running agent tick to finish (up to 25 minutes)..."
    flock -w 1600 6 || fail "the agent tick did not finish; deploy-on-PASS stays OFF - rerun --deploy-on"
    date -u +%FT%TZ > "$ST/deploy.enabled"
    # Let the current main SHA be deployed on the next tick if it was handled while deploy was off.
    if [[ -s "$ST/installed.sha" ]]; then s="$(cat "$ST/installed.sha")"; [[ -e "$ST/deployed.$s" ]] || rm -f "$ST/done.$s" "$ST/$s.checks.state" "$ST/$s.checks.md" "$ST/check-statused.$s" "$ST/check-commented.$s"; fi
    flock -u 6
    pass "deploy-on-PASS is ON (approved $(cat "$ST/deploy.enabled"))"
  else
    echo "  deploy-on-PASS stays OFF. Turn it on later: bash $DIR/bin/install-server-agent.sh --deploy-on"
  fi
fi
clear_sha() {  # sha -> forget its deploy, checks and done state (the install stays)
  local s="$1"
  rm -f "$ST/done.$s" "$ST/deployed.$s" "$ST/deploy-statused.$s" "$ST/deploy-started.$s" "$ST/deploy-uuid.$s" "$ST/superseded.$s" \
        "$ST/$s.checks.state" "$ST/$s.checks.md" "$ST/check-statused.$s" "$ST/check-commented.$s"
}
if [[ "${RETRY_DEPLOY:-0}" == 1 && -s "$ST/installed.sha" ]]; then
  s="$(cat "$ST/installed.sha")"
  exec 7>>"$ST/agent.lock"
  flock -w 120 7 || fail "the agent is busy (a tick holds the lock); try again in a few minutes"
  # Only a recorded failure is retried; a running deployment (id stored, no result yet) is left alone.
  if [[ "$(cut -d' ' -f1 "$ST/deployed.$s" 2>/dev/null)" == failure ]]; then
    clear_sha "$s"; pass "cleared the failed deploy of ${s:0:7}; the next tick deploys it again"
  else echo "  ${s:0:7} has no recorded deploy failure (deployed, running or not started); nothing to retry"; fi
  flock -u 7
fi
echo "Uninstall: bash $DIR/bin/install-server-agent.sh --uninstall"

#!/bin/bash
# Install the Build Board bridge (and optionally the ngrok tunnel) as per-user
# launchd services: start at login, auto-restart on crash (KeepAlive).
#
#   DRY_RUN=1 ./scripts/install-service.sh   # render plists only, no launchctl
#   DEST=/tmp/x ./scripts/install-service.sh # override LaunchAgents dir (tests)
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${DEST:-$HOME/Library/LaunchAgents}"
LOG_DIR="$HOME/.bridge/logs"
NODE_BIN="$(command -v node || true)"
NGROK_BIN="$(command -v ngrok || true)"
PORT="$(grep -E '^PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2 || true)"
PORT="${PORT:-8123}"
NGROK_DOMAIN="$(grep -E '^NGROK_DOMAIN=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2 || true)"

[ -n "$NODE_BIN" ] || { echo "ERROR: node not found on PATH" >&2; exit 1; }
[ -f "$APP_DIR/dist/server.js" ] || { echo "ERROR: dist/server.js missing — run 'npm run build' first" >&2; exit 1; }

mkdir -p "$DEST" "$LOG_DIR"

render() { # render <template> <out> — capture the CURRENT PATH so provider CLIs resolve in launchd's non-login context
  sed -e "s|__NODE__|$NODE_BIN|g" \
      -e "s|__APP_DIR__|$APP_DIR|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__PATH__|$PATH|g" \
      -e "s|__NGROK__|$NGROK_BIN|g" \
      -e "s|__NGROK_DOMAIN__|$NGROK_DOMAIN|g" \
      -e "s|__PORT__|$PORT|g" \
      "$1" > "$2"
  plutil -lint "$2" >/dev/null
}

BRIDGE_PLIST="$DEST/com.buildboard.bridge.plist"
render "$APP_DIR/service/com.buildboard.bridge.plist.template" "$BRIDGE_PLIST"
echo "rendered $BRIDGE_PLIST"

TUNNEL_PLIST=""
if [ -n "$NGROK_BIN" ] && [ -n "$NGROK_DOMAIN" ]; then
  TUNNEL_PLIST="$DEST/com.buildboard.tunnel.plist"
  render "$APP_DIR/service/com.buildboard.tunnel.plist.template" "$TUNNEL_PLIST"
  echo "rendered $TUNNEL_PLIST (reserved domain: $NGROK_DOMAIN)"
else
  echo "NOTE: ngrok CLI or NGROK_DOMAIN missing — tunnel service skipped."
  echo "      Either install ngrok + set NGROK_DOMAIN in .env and re-run, or use 'npm start' (embedded tunnel)."
fi

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "DRY_RUN=1 — skipping launchctl bootstrap."
  exit 0
fi

for plist in "$BRIDGE_PLIST" $TUNNEL_PLIST; do
  label="$(basename "$plist" .plist)"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  launchctl kickstart "gui/$(id -u)/$label"
  echo "started $label"
done
echo "Done. Use scripts/buildboard status|logs|stop|start to manage the service."

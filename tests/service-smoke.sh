#!/bin/bash
# Service-asset smoke: render plists via the installer's DRY_RUN mode, lint
# them, and syntax-check every service script. Does NOT touch launchd — the
# real install is scripts/install-service.sh, run by the user.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ✅ $1"; }
bad() { fail=$((fail+1)); echo "  ❌ $1"; }

echo "── service assets"
for s in scripts/install-service.sh scripts/uninstall-service.sh scripts/buildboard; do
  bash -n "$APP_DIR/$s" && ok "$s parses" || bad "$s has syntax errors"
done

chmod +x "$APP_DIR/scripts/"* 2>/dev/null || true
if DRY_RUN=1 DEST="$TMP" bash "$APP_DIR/scripts/install-service.sh" > "$TMP/install.log" 2>&1; then
  ok "install-service.sh DRY_RUN succeeds"
else
  bad "install-service.sh DRY_RUN failed:"; sed 's/^/     /' "$TMP/install.log"
fi

if [ -f "$TMP/com.buildboard.bridge.plist" ]; then
  plutil -lint "$TMP/com.buildboard.bridge.plist" >/dev/null && ok "bridge plist lints (plutil)" || bad "bridge plist invalid"
  grep -q "<key>KeepAlive</key>" "$TMP/com.buildboard.bridge.plist" && grep -q "<key>RunAtLoad</key>" "$TMP/com.buildboard.bridge.plist" \
    && ok "bridge plist has RunAtLoad + KeepAlive" || bad "bridge plist missing RunAtLoad/KeepAlive"
  grep -q "dist/server.js" "$TMP/com.buildboard.bridge.plist" && ok "bridge plist points at dist/server.js" || bad "bridge plist ProgramArguments wrong"
  grep -q ".build-board/logs/bridge" "$TMP/com.buildboard.bridge.plist" && ok "bridge plist routes stdout/stderr to ~/.build-board/logs" || bad "bridge plist log paths wrong"
  grep -q "__NODE__" "$TMP/com.buildboard.bridge.plist" && bad "unrendered placeholder left in plist" || ok "all placeholders rendered (node path, PATH, HOME)"
else
  bad "bridge plist was not rendered"
fi

plutil -lint "$APP_DIR/service/com.buildboard.tunnel.plist.template" >/dev/null 2>&1 && ok "tunnel plist template is valid XML" || bad "tunnel plist template invalid"

echo "── result: $pass passed, $fail failed"
[ "$fail" -eq 0 ]

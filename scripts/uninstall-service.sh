#!/bin/bash
# Fully remove the Build Board launchd services (bridge + tunnel).
set -euo pipefail
DEST="${DEST:-$HOME/Library/LaunchAgents}"
for label in com.buildboard.bridge com.buildboard.tunnel; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null && echo "stopped $label" || true
  rm -f "$DEST/$label.plist" && echo "removed $DEST/$label.plist"
done

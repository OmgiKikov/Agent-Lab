#!/usr/bin/env bash
set -euo pipefail

service_file="$HOME/Library/LaunchAgents/com.local.langwatch.pi-bridge.plist"
if test -f "$service_file"; then
  launchctl bootout "gui/$(id -u)" "$service_file" 2>/dev/null || true
  rm "$service_file"
fi
echo "Pi model bridge stopped. ./scripts/start-langwatch.sh starts it again."

#!/bin/sh
# Builds our Raindrop Workshop (workshop/: release 0.1.21, MIT, with the Agent Lab section) and installs its UI
# into the local Workshop daemon, which serves ~/.raindrop/ui-cache/<version>/dist.
# The original UI is kept in dist.original; lab/workshop/restore.sh puts it back.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/workshop"
VERSION=0.1.21
export PATH="$HOME/.bun/bin:$PATH"

(cd "$SRC/app" && bun install >/dev/null && bun x vite build --logLevel warn)

CACHE="$HOME/.raindrop/ui-cache/$VERSION"
[ -d "$CACHE/dist" ] || { echo "Workshop $VERSION UI cache not found: run 'raindrop workshop' once" >&2; exit 1; }
[ -d "$CACHE/dist.original" ] || cp -R "$CACHE/dist" "$CACHE/dist.original"
rm -rf "$CACHE/dist.next"
cp -R "$SRC/app/dist" "$CACHE/dist.next"
rm -rf "$CACHE/dist"
mv "$CACHE/dist.next" "$CACHE/dist"
echo "Agent Lab installed into Workshop: http://127.0.0.1:5899/lab"

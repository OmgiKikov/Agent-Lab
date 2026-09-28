#!/bin/sh
# Builds Raindrop Workshop 0.1.21 with the Agent Lab section and installs its UI
# into the local Workshop (the installed daemon serves ~/.raindrop/ui-cache/<version>/dist).
# The original UI is kept in dist.original; lab/workshop/restore.sh puts it back.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/lab/.workshop-src"
COMMIT=a6b82d71596cf7e8974e5efae63f9e15260d76ef   # release 0.1.21
VERSION=0.1.21
export PATH="$HOME/.bun/bin:$PATH"

if [ ! -d "$SRC/.git" ]; then
  git clone -q --filter=blob:none https://github.com/raindrop-ai/workshop.git "$SRC"
fi
git -C "$SRC" checkout -q -f "$COMMIT"
cp "$ROOT/lab/workshop/LabPage.tsx" "$SRC/app/src/pages/LabPage.tsx"
python3 "$ROOT/lab/workshop/patch.py" "$SRC/app/src"
(cd "$SRC/app" && bun install >/dev/null && bun x vite build --logLevel warn)

CACHE="$HOME/.raindrop/ui-cache/$VERSION"
[ -d "$CACHE/dist" ] || { echo "Workshop $VERSION UI cache not found: run 'raindrop workshop' once" >&2; exit 1; }
[ -d "$CACHE/dist.original" ] || cp -R "$CACHE/dist" "$CACHE/dist.original"
rm -rf "$CACHE/dist.next"
cp -R "$SRC/app/dist" "$CACHE/dist.next"
rm -rf "$CACHE/dist"
mv "$CACHE/dist.next" "$CACHE/dist"
echo "Agent Lab installed into Workshop: http://127.0.0.1:5899/lab"

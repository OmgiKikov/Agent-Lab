#!/bin/sh
# Builds our Raindrop Workshop from workshop/ (release 0.1.21, MIT, with the Agent Lab section):
# the UI and the daemon compiled by Bun into one binary, workshop/build/raindrop, which lab/start.sh runs.
# It keeps the Workshop data in ~/.raindrop. --all also builds Linux and Windows binaries into workshop/build/bun.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$HOME/.bun/bin:$PATH"
cd "$ROOT/workshop"

bun install >/dev/null
bun x tsc --noEmit
(cd app && bun x tsc --noEmit)
RAINDROP_VERSION=0.1.21-agentlab-local bun scripts/build-bun.ts "$@"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=bun-darwin-arm64 ;;
  Darwin-x86_64) TARGET=bun-darwin-x64 ;;
  Linux-x86_64) TARGET=bun-linux-x64 ;;
  Linux-aarch64) TARGET=bun-linux-arm64 ;;
  *) echo "Unsupported host: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
cp "build/bun/raindrop-$TARGET" build/raindrop.next
mv build/raindrop.next build/raindrop
echo "Workshop built: workshop/build/raindrop"

# A running Workshop keeps the old binary: restart it on the new one.
if curl -fsS --max-time 2 http://127.0.0.1:5899/health >/dev/null 2>&1; then
  build/raindrop workshop stop >/dev/null
  RAINDROP_WORKSHOP_PORT=5899 build/raindrop workshop start >/dev/null
  echo "Workshop restarted: http://127.0.0.1:5899/lab"
fi

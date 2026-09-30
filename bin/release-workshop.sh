#!/bin/sh
# Publishes the Workshop build of the committed workshop/ for macOS (Apple Silicon and Intel) as a release of this
# repository: bin/start.sh downloads it on a computer without Bun. Needs Bun and an authorized gh.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.bun/bin:$PATH"
cd "$ROOT"
git diff --quiet HEAD -- workshop || { echo "workshop/ has uncommitted changes: commit them first" >&2; exit 1; }
SOURCE="$(git rev-parse --short=12 HEAD:workshop)"
TAG="workshop-$SOURCE"
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Already published: $TAG"
  exit 0
fi
cd workshop
bun install >/dev/null
RAINDROP_VERSION=0.1.21-agentlab-local bun scripts/build-bun.ts --target=bun-darwin-arm64
RAINDROP_VERSION=0.1.21-agentlab-local bun scripts/build-bun.ts --target=bun-darwin-x64 --skip-ui
cd "$ROOT"
cp workshop/build/bun/raindrop-bun-darwin-arm64 workshop/build/raindrop-darwin-arm64
cp workshop/build/bun/raindrop-bun-darwin-x64 workshop/build/raindrop-darwin-x64
gh release create "$TAG" workshop/build/raindrop-darwin-arm64 workshop/build/raindrop-darwin-x64 \
  --title "Workshop $SOURCE" --notes "Сборка Workshop с проверками агента из workshop/ ($SOURCE). Скачивается bin/start.sh на компьютере без Bun."
echo "Published: $TAG"

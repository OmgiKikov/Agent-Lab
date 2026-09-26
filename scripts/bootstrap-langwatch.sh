#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
source_dir="$repo_dir/langwatch"
upstream_commit=88566e6991a9326cd2b61b3ac4ac722a2f2eb2fc

if test -d "$source_dir/.git"; then
  exit 0
fi
if test -e "$source_dir"; then
  echo "The langwatch path exists but is not a source checkout: $source_dir" >&2
  exit 1
fi

git clone --filter=blob:none --no-checkout --depth=1 \
  https://github.com/langwatch/langwatch.git "$source_dir"
git -C "$source_dir" fetch --depth=1 origin "$upstream_commit"
git -C "$source_dir" switch -c codex/agent-lab-local "$upstream_commit"
git -C "$source_dir" remote rename origin upstream
git -C "$source_dir" config remote.upstream.pushurl no-push://langwatch
git -C "$source_dir" apply "$repo_dir/patches/langwatch-community-seed.patch"

echo "LangWatch source is ready in $source_dir"

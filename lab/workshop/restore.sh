#!/bin/sh
# Puts back the original Raindrop Workshop UI saved by build.sh.
set -eu
CACHE="$HOME/.raindrop/ui-cache/0.1.21"
[ -d "$CACHE/dist.original" ] || { echo "Nothing to restore" >&2; exit 1; }
rm -rf "$CACHE/dist"
cp -R "$CACHE/dist.original" "$CACHE/dist"
echo "Original Workshop UI restored"

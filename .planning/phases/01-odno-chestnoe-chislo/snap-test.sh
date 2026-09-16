#!/usr/bin/env bash
# Run tests from a snapshot of the repository so the worktree dist/ (imported by the live
# Pi extension) is never deleted or rebuilt.
#
#   snap-test.sh [--keep] [test paths…]   working tree (tracked + untracked, not ignored)
#   snap-test.sh --full [--keep]          committed HEAD via git archive, full npm test
#
# Test paths are relative to the repository root. With --keep the snapshot directory is
# kept and printed as the last stdout line: SNAP=<absolute path>.
set -euo pipefail

REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
FULL=0
KEEP=0
TESTS=()
for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    --keep) KEEP=1 ;;
    *) TESTS+=("$arg") ;;
  esac
done

SNAP=$(mktemp -d "${TMPDIR:-/tmp}/agent-lab-snap-XXXXXX")
SNAP=$(cd "$SNAP" && pwd -P)
cleanup() {
  if [ "$KEEP" -eq 0 ]; then rm -rf "$SNAP"; fi
}
trap cleanup EXIT

if [ "$FULL" -eq 1 ]; then
  git -C "$REPO" archive HEAD | tar -x -C "$SNAP"
else
  # Tracked and untracked non-ignored files; ignored paths (dist/, node_modules/, .agent-lab/) never enter.
  (cd "$REPO" && git ls-files -co --exclude-standard -z \
    | while IFS= read -r -d '' path; do
        if [ -e "$path" ] || [ -L "$path" ]; then printf '%s\0' "$path"; fi
      done \
    | tar --null -T - -cf -) | tar -xf - -C "$SNAP"
fi
ln -s "$REPO/node_modules" "$SNAP/node_modules"

status=0
if [ "$FULL" -eq 1 ]; then
  (cd "$SNAP" && npm test && npm run typecheck) || status=$?
else
  # `set -e` is suspended on the left of `||`, so every step is chained explicitly.
  if [ "${#TESTS[@]}" -gt 0 ]; then
    (cd "$SNAP" && npx tsc && npx tsx --test "${TESTS[@]}") || status=$?
  else
    (cd "$SNAP" && npx tsc && npx tsx --test test/*.test.ts && npm run typecheck) || status=$?
  fi
fi

if [ "$KEEP" -eq 1 ]; then echo "SNAP=$SNAP"; fi
exit "$status"

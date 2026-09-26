#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
password_file="$repo_dir/langwatch/.local/local-admin-password"
if ! test -f "$password_file"; then
  echo "The local workspace is not ready yet. Run ./scripts/start-langwatch.sh first." >&2
  exit 1
fi

echo 'Email: local@langwatch.dev'
printf 'Password: '
cat "$password_file"
echo

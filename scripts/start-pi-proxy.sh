#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
local_home="$repo_dir/langwatch/.local"
pi_bin="$repo_dir/node_modules/.bin/pi"

if test ! -x "$pi_bin"; then
  (cd "$repo_dir" && npm ci --no-audit --no-fund)
fi

if ! "$pi_bin" auth check --provider openai-codex --model gpt-5.6-sol --json \
  | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("status") == "ready" else 1)'; then
  echo "Pi needs its existing OpenAI sign-in before factual evaluations can run." >&2
  exit 1
fi

if curl -fsS --max-time 2 http://127.0.0.1:11435/health >/dev/null 2>&1; then
  echo "Pi model bridge is already running."
  exit 0
fi

python3 "$repo_dir/scripts/install-pi-service.py"

for _ in {1..20}; do
  if curl -fsS --max-time 2 http://127.0.0.1:11435/health >/dev/null 2>&1; then
    echo "Pi model bridge is ready."
    exit 0
  fi
  sleep 1
done

echo "Pi model bridge did not start. See $local_home/pi-proxy.log" >&2
exit 1

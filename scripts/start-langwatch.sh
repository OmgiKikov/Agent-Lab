#!/usr/bin/env bash
set -euo pipefail

# Prefer the installed Node 24 binary over a Volta shim that tries to fetch
# another Node version from inside the LangWatch workspace.
if test -x /opt/homebrew/bin/node && test -x /opt/homebrew/bin/npm; then
  export PATH="/opt/homebrew/bin:$PATH"
elif test -x /usr/local/bin/node && test -x /usr/local/bin/npm; then
  export PATH="/usr/local/bin:$PATH"
fi

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
"$repo_dir/scripts/bootstrap-langwatch.sh"

local_home="$repo_dir/langwatch/.local"
umask 077
mkdir -p "$local_home/data/objects"
chmod 700 "$local_home/data/objects"

current_port() {
  local port
  if test -f "$local_home/.env"; then
    port="$(sed -n 's/^PORT=//p' "$local_home/.env" | tail -1)"
  else
    port=""
  fi
  echo "${port:-5560}"
}

is_ready() {
  curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$(current_port)/auth/signin" \
    >/dev/null 2>&1
}

ensure_pi() {
  if ! "$repo_dir/scripts/start-pi-proxy.sh"; then
    echo "LangWatch is ready, but factual evaluations need Pi sign-in." >&2
  fi
  python3 "$repo_dir/scripts/start-review-ui.py"
}

if test -f "$local_home/run/langwatch.pid"; then
  running_pid="$(cat "$local_home/run/langwatch.pid")"
  if kill -0 "$running_pid" 2>/dev/null && is_ready; then
    ensure_pi
    echo "LangWatch is already running: http://localhost:$(current_port)"
    exit 0
  fi
fi

(
  cd "${TMPDIR:-/tmp}"
  export LANGWATCH_HOME="$local_home"
  export LANGWATCH_CONNECT_DISABLED=true
  export DISABLE_USAGE_STATS=true
  export LANGWATCH_LOCAL_STORAGE_PATH="$local_home/data/objects"
  exec npm exec --yes --package=@langwatch/server@3.17.0 -- \
    langwatch-server start --yes --no-open
) &
launcher_pid=$!

stop_launcher() {
  kill -INT "$launcher_pid" 2>/dev/null || true
}
trap stop_launcher INT TERM EXIT

ready=false
for _ in $(seq 1 600); do
  if is_ready; then
    ready=true
    break
  fi
  if ! kill -0 "$launcher_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done

if test "$ready" != true; then
  echo "LangWatch did not start. Check the messages above." >&2
  exit 1
fi

if ! grep -q '^DISABLE_USAGE_STATS=true$' "$local_home/.env"; then
  printf '\nDISABLE_USAGE_STATS=true\n' >> "$local_home/.env"
fi
if ! grep -q '^LANGWATCH_CONNECT_DISABLED=true$' "$local_home/.env"; then
  printf 'LANGWATCH_CONNECT_DISABLED=true\n' >> "$local_home/.env"
fi
if ! grep -q '^LANGWATCH_LOCAL_STORAGE_PATH=' "$local_home/.env"; then
  printf 'LANGWATCH_LOCAL_STORAGE_PATH=%s\n' "$local_home/data/objects" >> "$local_home/.env"
fi
chmod 600 "$local_home/.env"

"$repo_dir/scripts/seed-local-workspace.sh"
ensure_pi
echo "Open LangWatch: http://localhost:$(current_port)"
wait "$launcher_pid"

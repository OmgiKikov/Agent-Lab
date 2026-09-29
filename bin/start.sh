#!/bin/sh
# One Python backend; the frontend is built once per launch.
set -eu
LAB_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$LAB_ROOT"
export PATH="$HOME/.volta/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"
command -v uv >/dev/null 2>&1 || { echo "Установите uv: https://docs.astral.sh/uv/" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "Для сборки интерфейса нужен Node.js 22.12+ с npm." >&2; exit 1; }
uv sync --project backend
(cd frontend && npm ci --silent && npm run build)
LAB_PYTHON="$LAB_ROOT/backend/.venv/bin/python"
LAB_RUNTIME="${LAB_DATA:-$LAB_ROOT/data}"
mkdir -p "$LAB_RUNTIME"
chmod 700 "$LAB_RUNTIME"
LAB_OWNED_PIDS=""
cleanup() { for process_id in $LAB_OWNED_PIDS; do kill "$process_id" 2>/dev/null || true; done; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -n "${LAB_MODEL_URL:-}" ] || [ -n "${AGENT_LAB_GATEWAY_URL:-}" ] || [ -f certs/url.txt ] || [ -f "${AGENT_LAB_GATEWAY_FILE:-$HOME/.agent-lab/gateway.json}" ]; then
  echo "Модели: настроенный endpoint или шлюз банка"
else
  (cd backend/bridge && npm ci --silent)
  model_bridge() {
    curl -fsS --max-time 2 "http://127.0.0.1:$1/health" >/dev/null 2>&1 && return
    PI_PROXY_PORT="$1" PI_PROXY_CONCURRENCY=6 PI_JUDGE_PROVIDER="${LAB_PI_PROVIDER:-openrouter}" PI_JUDGE_MODEL="$2" \
      "$LAB_PYTHON" backend/bridge/pi_bridge.py >>"$LAB_RUNTIME/$3" 2>&1 &
    LAB_OWNED_PIDS="$LAB_OWNED_PIDS $!"
  }
  model_bridge 11436 "${LAB_PI_MODEL:-z-ai/glm-5.3}" bridge.log
  model_bridge 11437 "${LAB_SECOND_MODEL:-openai/gpt-5.2}" bridge-second.log
  echo "Модели: OpenRouter через Pi"
fi
echo "Agent Lab: http://127.0.0.1:${LAB_PORT:-5899}/lab"
cd backend
"$LAB_PYTHON" -m uvicorn lab.app:app --host 127.0.0.1 --port "${LAB_PORT:-5899}" &
LAB_SERVER_PID=$!
LAB_OWNED_PIDS="$LAB_OWNED_PIDS $LAB_SERVER_PID"
wait "$LAB_SERVER_PID"

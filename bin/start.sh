#!/bin/sh
# One Python backend; the frontend is built once per launch.
set -eu
LAB_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$LAB_ROOT"
export PATH="$HOME/.volta/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"
command -v uv >/dev/null 2>&1 || { echo "Установите uv: https://docs.astral.sh/uv/" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "Для сборки интерфейса нужен Node.js 22.19+ с npm." >&2; exit 1; }
uv sync --locked --project backend
(cd frontend && npm ci --silent && npm run build)
LAB_PYTHON="$LAB_ROOT/backend/.venv/bin/python"
LAB_RUNTIME="${LAB_DATA:-$LAB_ROOT/data}"
mkdir -p "$LAB_RUNTIME"
chmod 700 "$LAB_RUNTIME"
LAB_OWNED_PIDS=""
cleanup() {
  for process_id in $LAB_OWNED_PIDS; do kill "$process_id" 2>/dev/null || true; done
  for process_id in $LAB_OWNED_PIDS; do wait "$process_id" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Models: LAB_MODEL_URL; else the bank's gateway when certs/url.txt (or its settings) set it up; else OpenRouter, with
# its key in OPENROUTER_API_KEY. A gateway set up but broken is never replaced by OpenRouter: the reason is printed, the
# app still starts and shows it, and the conversations go nowhere until it is fixed. So does OpenRouter without a key.
if [ -n "${LAB_MODEL_URL:-}" ]; then
  echo "Модели: endpoint из LAB_MODEL_URL"
else
  LAB_GATEWAY="$(cd backend && "$LAB_PYTHON" -c 'from lab import config
from lab.models import gateway
with config.using(config.Settings.from_environment()):
    print(gateway.problem() or ("ready" if gateway.configured() else "absent"))')" ||
    LAB_GATEWAY="сертификаты не проверились, ошибка выше"
  case "$LAB_GATEWAY" in
  absent)
    if [ -n "${OPENROUTER_API_KEY:-}${LAB_MODEL_KEY:-}" ]; then
      echo "Модели: OpenRouter"
    else
      echo "Модели не настроены: задайте OPENROUTER_API_KEY или LAB_MODEL_URL, либо положите настройки шлюза в certs/." >&2
      echo "Разговоры никуда не уходят. Причина видна и в «Настройках»." >&2
    fi
    ;;
  ready)
    echo "Модели: шлюз банка (certs/)"
    ;;
  *)
    echo "Шлюз банка не работает: $LAB_GATEWAY" >&2
    echo "OpenRouter не подключается: разговоры уходят только в шлюз. Причина видна и в «Настройках»." >&2
    ;;
  esac
fi
echo "Agent Lab: http://127.0.0.1:${LAB_PORT:-5899}/"
cd backend
"$LAB_PYTHON" -m uvicorn lab.app:create --factory --host 127.0.0.1 --port "${LAB_PORT:-5899}" &
LAB_SERVER_PID=$!
LAB_OWNED_PIDS="$LAB_OWNED_PIDS $LAB_SERVER_PID"
wait "$LAB_SERVER_PID"

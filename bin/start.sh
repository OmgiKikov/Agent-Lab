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
# Models: LAB_MODEL_URL; else the bank's gateway when certs/url.txt (or its settings) set it up; else Pi bridges to
# OpenRouter. A gateway set up but broken is never replaced by OpenRouter: the reason is printed, the app still starts
# and shows it, and the conversations go nowhere until it is fixed.
if [ -n "${LAB_MODEL_URL:-}" ]; then
  echo "Модели: endpoint из LAB_MODEL_URL"
else
  LAB_GATEWAY="$(cd backend && "$LAB_PYTHON" -c 'from lab.llm import gateway
print(gateway.problem() or ("ready" if gateway.configured() else "absent"))')" ||
    LAB_GATEWAY="сертификаты не проверились, ошибка выше"
  case "$LAB_GATEWAY" in
  absent)
    (cd backend/bridge && npm ci --silent)
    model_bridge() {
      curl -fsS --max-time 2 "http://127.0.0.1:$1/health" >/dev/null 2>&1 && return
      PI_PROXY_PORT="$1" PI_PROXY_CONCURRENCY=6 PI_JUDGE_PROVIDER="${LAB_PI_PROVIDER:-openrouter}" PI_JUDGE_MODEL="$2" \
        "$LAB_PYTHON" backend/bridge/pi_bridge.py >>"$LAB_RUNTIME/$3" 2>&1 &
      LAB_OWNED_PIDS="$LAB_OWNED_PIDS $!"
    }
    model_bridge 11436 "${LAB_PI_MODEL:-z-ai/glm-5.3}" bridge.log
    # A second judge of another vendor only when named: LAB_SECOND_MODEL=openai/gpt-5.2
    if [ -n "${LAB_SECOND_MODEL:-}" ]; then model_bridge 11437 "$LAB_SECOND_MODEL" bridge-second.log; fi
    echo "Модели: OpenRouter через Pi"
    ;;
  ready)
    echo "Модели: шлюз банка (certs/)"
    ;;
  *)
    echo "Шлюз банка не работает: $LAB_GATEWAY" >&2
    echo "Pi и OpenRouter не запускаются: разговоры уходят только в шлюз. Причина видна и в «Настройках»." >&2
    ;;
  esac
fi
echo "Agent Lab: http://127.0.0.1:${LAB_PORT:-5899}/"
cd backend
"$LAB_PYTHON" -m uvicorn lab.app:app --host 127.0.0.1 --port "${LAB_PORT:-5899}" &
LAB_SERVER_PID=$!
LAB_OWNED_PIDS="$LAB_OWNED_PIDS $LAB_SERVER_PID"
wait "$LAB_SERVER_PID"

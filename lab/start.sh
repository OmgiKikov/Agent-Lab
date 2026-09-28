#!/bin/sh
# Agent Lab: one command for the demo. Idempotent: running services are left alone.
#   Raindrop Workshop (5899) with the Agent Lab section, the Lab's model bridge (11436),
#   the Lab service (5901); checks the local acquiring agent (8080) and its mocks (8090).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RAINDROP="${RAINDROP_BIN:-$HOME/.raindrop/bin/raindrop}"
export PATH="$HOME/.volta/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"
up() { curl -fsS --max-time 2 "$1" >/dev/null 2>&1; }

# 1. Workshop daemon and the Agent Lab UI inside it.
up http://127.0.0.1:5899/health || "$RAINDROP" workshop >/dev/null 2>&1 || true
if ! grep -rqs "agent lab" "$HOME/.raindrop/ui-cache/0.1.21/dist/assets"; then
  sh lab/workshop/build.sh
fi

# 2. Python environment of the Lab.
if [ ! -x lab/.venv/bin/python ]; then
  uv venv -q -p 3.12 lab/.venv 2>/dev/null || python3 -m venv lab/.venv
  uv pip install -q -p lab/.venv/bin/python fastapi==0.141.1 uvicorn==0.54.0 httpx==0.28.1 2>/dev/null \
    || lab/.venv/bin/python -m pip install -q fastapi==0.141.1 uvicorn==0.54.0 httpx==0.28.1
fi
mkdir -p lab/data

# 3. Model bridge for the simulator and the judge: its own Pi instance, several calls in parallel.
if ! up http://127.0.0.1:11436/health; then
  PI_PROXY_PORT=11436 PI_PROXY_CONCURRENCY=6 \
  PI_JUDGE_PROVIDER="${LAB_PI_PROVIDER:-openrouter}" PI_JUDGE_MODEL="${LAB_PI_MODEL:-anthropic/claude-sonnet-4.6}" \
    nohup python3 scripts/pi-model-proxy.py </dev/null >> lab/data/pi-proxy.log 2>&1 &
fi

# Independent second judge on another vendor's model.
if ! up http://127.0.0.1:11437/health; then
  PI_PROXY_PORT=11437 PI_PROXY_CONCURRENCY=6 \
  PI_JUDGE_PROVIDER="${LAB_PI_PROVIDER:-openrouter}" PI_JUDGE_MODEL="${LAB_SECOND_MODEL:-openai/gpt-5.2}" \
    nohup python3 scripts/pi-model-proxy.py </dev/null >> lab/data/pi-proxy-second.log 2>&1 &
fi

# 4. Lab service.
if ! up http://127.0.0.1:5901/api/state; then
  nohup lab/.venv/bin/python -m lab serve </dev/null >> lab/data/server.log 2>&1 &
fi

for _ in 1 2 3 4 5 6 7 8 9 10; do
  up http://127.0.0.1:5901/api/state && up http://127.0.0.1:11436/health && break
  sleep 1
done
up http://127.0.0.1:5901/api/state || { echo "Agent Lab не запустился: lab/data/server.log" >&2; exit 1; }
up http://127.0.0.1:11436/health || echo "Мост модели не отвечает: lab/data/pi-proxy.log" >&2
up http://127.0.0.1:11437/health || echo "Мост второго судьи не отвечает: lab/data/pi-proxy-second.log" >&2

# 5. The agent under test on this Mac.
if curl -s --max-time 3 -o /dev/null http://127.0.0.1:8080/local/agent-lab/identity; then
  echo "Агент на стенде: работает (localhost:8080)"
else
  echo "Агент на стенде не отвечает. Запуск: cd ~/Desktop/aigw-local && ./local/pg.sh start && ./local/run-mocks.sh & ./local/run-app.sh &" >&2
fi
curl -s --max-time 3 -o /dev/null http://127.0.0.1:8090/mock/calls?limit=0 || echo "Заглушки систем (8090) не отвечают" >&2

echo "Agent Lab: http://127.0.0.1:5899/lab"
[ "${LAB_NO_OPEN:-}" = 1 ] || open "http://127.0.0.1:5899/lab" 2>/dev/null || true

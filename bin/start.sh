#!/bin/sh
# Starts everything (the checks service and the Workshop) and opens http://127.0.0.1:5899/. The same on every computer:
#   - Workshop (5899): our build of workshop/; built here with Bun, or downloaded from this repository's releases;
#   - models: the bank's gateway when its certificates are in certs/, otherwise Pi bridges to OpenRouter (11436, 11437);
#   - the Lab's API (5901), restarted on every start so it runs the current code.
# Running services are left alone; logs go to data/*.log.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.volta/bin:$HOME/.bun/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
mkdir -p data
up() { curl -fsS --max-time 2 "$1" >/dev/null 2>&1; }
say() { printf '%s\n' "$*"; }
fail() { printf '%s\n' "$*" >&2; exit 1; }

# 1. Python environment, reinstalled when pyproject.toml changes.
command -v uv >/dev/null 2>&1 || fail "Нужен uv: curl -LsSf https://astral.sh/uv/install.sh | sh"
DEPS="$(cksum < pyproject.toml)"
if [ ! -x .venv/bin/python ] || [ "$(cat .venv/.deps 2>/dev/null)" != "$DEPS" ]; then
  say "Ставлю зависимости…"
  [ -x .venv/bin/python ] || uv venv -q -p 3.12 .venv
  uv pip install -q -p .venv/bin/python -r pyproject.toml
  printf '%s\n' "$DEPS" > .venv/.deps
fi

# A release asset of this repository (it is private): through gh, or with the token git pulls with.
download() {  # tag, asset, file
  REPO="$(git remote get-url origin | sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##')"
  if command -v gh >/dev/null 2>&1 && gh release download "$1" -R "$REPO" -p "$2" -O "$3" --clobber 2>/dev/null; then
    return 0
  fi
  token="$(printf 'protocol=https\nhost=github.com\n\n' | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null | sed -n 's/^password=//p')"
  [ -n "$token" ] || return 1
  asset="$(curl -fsSL -H "Authorization: Bearer $token" "https://api.github.com/repos/$REPO/releases/tags/$1" \
    | .venv/bin/python -c 'import json, sys; print(next(a["id"] for a in json.load(sys.stdin)["assets"] if a["name"] == sys.argv[1]))' "$2")" \
    || return 1
  curl -fsSL -H "Authorization: Bearer $token" -H "Accept: application/octet-stream" -o "$3" \
    "https://api.github.com/repos/$REPO/releases/assets/$asset"
}

# 2. Workshop, the build matching workshop/ in this checkout.
RAINDROP="$ROOT/workshop/build/raindrop"
SOURCE="$(git rev-parse --short=12 HEAD:workshop 2>/dev/null || echo local)"
if [ ! -x "$RAINDROP" ] || [ "$(cat workshop/build/.source 2>/dev/null)" != "$SOURCE" ]; then
  if command -v bun >/dev/null 2>&1; then
    say "Собираю Workshop…"
    sh bin/build-workshop.sh >data/workshop-build.log 2>&1 || fail "Workshop не собрался: data/workshop-build.log"
  else
    case "$(uname -m)" in arm64) PLATFORM=darwin-arm64 ;; x86_64) PLATFORM=darwin-x64 ;; *) fail "Нет сборки Workshop для $(uname -m)" ;; esac
    say "Скачиваю Workshop ($PLATFORM)…"
    mkdir -p workshop/build
    download "workshop-$SOURCE" "raindrop-$PLATFORM" workshop/build/raindrop.next \
      || fail "Нет готовой сборки Workshop для этой версии: установите Bun (https://bun.sh) или опубликуйте её: sh bin/release-workshop.sh"
    chmod +x workshop/build/raindrop.next
    mv workshop/build/raindrop.next "$RAINDROP"
    printf '%s\n' "$SOURCE" > workshop/build/.source
  fi
fi
pid="$(curl -fsS --max-time 2 http://127.0.0.1:5899/health 2>/dev/null | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')"
if [ -n "$pid" ] && ! ps -p "$pid" -o command= | grep -qF "$RAINDROP"; then
  "$RAINDROP" workshop stop >/dev/null  # another Workshop on the port, e.g. a downloaded Raindrop; the traces stay
  pid=
fi
[ -n "$pid" ] || RAINDROP_WORKSHOP_PORT=5899 "$RAINDROP" workshop start >/dev/null

# 3. Models: the bank's gateway (certificates in certs/) or Pi bridges to OpenRouter.
if [ -f certs/url.txt ] || [ -f "$HOME/.agent-lab/gateway.json" ] || [ -n "${AGENT_LAB_GATEWAY_URL:-}" ]; then
  say "Модели: шлюз банка (certs/)"
else
  command -v node >/dev/null 2>&1 || fail "Для моделей через OpenRouter нужен Node.js 22+, или положите сертификаты шлюза в certs/"
  [ -x bridge/node_modules/.bin/pi ] || (cd bridge && npm ci --silent)
  bridge() {  # port, model, log
    up "http://127.0.0.1:$1/health" && return
    PI_PROXY_PORT="$1" PI_PROXY_CONCURRENCY=6 PI_JUDGE_PROVIDER="${LAB_PI_PROVIDER:-openrouter}" PI_JUDGE_MODEL="$2" \
      nohup .venv/bin/python bridge/pi_bridge.py </dev/null >>"data/$3" 2>&1 &
  }
  bridge 11436 "${LAB_PI_MODEL:-z-ai/glm-5.3}" bridge.log
  bridge 11437 "${LAB_SECOND_MODEL:-openai/gpt-5.2}" bridge-second.log  # the second judge: another vendor
  say "Модели: OpenRouter через Pi"
fi

# 4. The Lab's API, on the current code unless a job is running.
if curl -fsS --max-time 2 http://127.0.0.1:5901/api/state 2>/dev/null | grep -q '"running":true'; then
  say "Сервис проверок занят задачей: оставляю как есть"
else
  for old in $(lsof -ti tcp:5901 -sTCP:LISTEN 2>/dev/null); do kill "$old" 2>/dev/null || true; done
  for _ in 1 2 3 4 5 6 7 8 9 10; do lsof -ti tcp:5901 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 1; done
  nohup .venv/bin/python -m uvicorn lab.api:app --host 127.0.0.1 --port 5901 --log-level warning \
    </dev/null >>data/api.log 2>&1 &
fi
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do up http://127.0.0.1:5901/api/state && break; sleep 1; done
up http://127.0.0.1:5901/api/state || fail "Сервис проверок не запустился: data/api.log"

say "Готово: http://127.0.0.1:5899/"
[ "${LAB_NO_OPEN:-}" = 1 ] || open "http://127.0.0.1:5899/" 2>/dev/null || true

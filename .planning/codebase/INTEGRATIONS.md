---
last_mapped_commit: e23488a2711c80e9333f603d5c28d06ca85395ee
last_mapped_at: 2026-09-15
---
# External Integrations

**Analysis Date:** 2026-09-15

## APIs & External Services

**LLM providers:**

- Pi-supported provider/model - построение сценариев, симуляция пользователя и судейство через `@earendil-works/pi-coding-agent`; провайдер и модель в `settings.provider`, `settings.model`, `settings.judge` (`src/pi.ts`, `src/contracts.ts`)
  - SDK/Client: `@earendil-works/pi-coding-agent` 0.85.1
  - Auth: авторизация Pi; для HTTP target — переменные, указанные в `target.headersEnv`
- OpenRouter - значение по умолчанию для judge `openai/gpt-5.6-sol` с optional upstream routing (`src/contracts.ts`, `README.md`)
  - SDK/Client: Pi provider transport
  - Auth: Pi authorization/provider configuration

## Data Storage

**Databases:**

- None in the core application; state is JSON artifacts and suites (`src/store.ts`, `src/artifacts.ts`)
- SQLite only in the reference external agent example (`examples/llm-stateful-agent.mjs`)
  - Connection: локальный файл `state.sqlite` во временной директории примера
  - Client: Node `node:sqlite` `DatabaseSync`

**File Storage:**

- Local filesystem only - `.agent-lab/exports`, suite JSON, traces, HTML/Markdown reports (`src/artifacts.ts`, `src/store.ts`)

**Caching:**

- None detected

## Authentication & Identity

**Auth Provider:**

- Pi auth/provider configuration - core не реализует собственную аутентификацию
  - Implementation: доступ к моделям предоставляется установленным Pi; HTTP target получает секретные headers из environment (`src/targets.ts`)

## Monitoring & Observability

**Error Tracking:**

- None detected

**Logs:**

- Трассы событий и диагностические артефакты JSONL/JSON сохраняются локально; stderr внешних процессов ограниченно попадает в release/ошибки (`src/artifacts.ts`, `src/targets.ts`)

## CI/CD & Deployment

**Hosting:**

- Не обнаружено; пакет запускается локально как CLI

**CI Pipeline:**

- GitHub Actions не обнаружен; пример CI-контракта находится в `examples/regression-ci.yml`

## Environment Configuration

**Required env vars:**

- Не существует фиксированного списка; переменные header names определяются конфигурацией `target.headersEnv`, а `AGENT_LAB_SESSION` и optional `AGENT_LAB_DEBUG_DIR` используются самим приложением

**Secrets location:**

- Авторизация Pi и значения HTTP headers находятся во внешней конфигурации/переменных окружения; `.env`-файлы не читались

## Webhooks & Callbacks

**Incoming:**

- HTTP target endpoint принимает POST JSON с session/scenario/state/history/message (`src/targets.ts`)

**Outgoing:**

- Agent Lab отправляет POST на URL `target.url`; локальные module/command adapters получают JSON через import или stdin/stdout (`src/targets.ts`, `src/module-worker.mjs`)

---

*Integration audit: 2026-09-15*

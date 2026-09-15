---
last_mapped_commit: e23488a2711c80e9333f603d5c28d06ca85395ee
last_mapped_at: 2026-09-15
---
# Technology Stack

**Analysis Date:** 2026-09-15

## Languages

**Primary:**

- TypeScript 5.9.3 - основная библиотека в `src/` и расширения Pi в `extensions/`

**Secondary:**

- JavaScript/ES modules - worker и примеры в `src/module-worker.mjs` и `examples/`
- Python - внешние target-примеры в `examples/*.py`

## Runtime

**Environment:**

- Node.js >=22.19.0 - запуск CLI, сборка и тесты (`package.json`)

**Package Manager:**

- npm - `package.json`, `package-lock.json`
- Lockfile: present

## Frameworks

**Core:**

- Pi Coding Agent `@earendil-works/pi-coding-agent` 0.85.1 - модельные сессии, runtime и расширения
- Pi TUI `@earendil-works/pi-tui` 0.85.1 - терминальная доска Agent Lab

**Testing:**

- Node test runner через `tsx --test` - `test/*.test.ts`

**Build/Dev:**

- TypeScript compiler 5.9.3 - `tsconfig.json`, output `dist/`
- tsx 4.20.0 - запуск TypeScript CLI и тестов без отдельного bundler

## Key Dependencies

**Critical:**

- `zod` 4.5.4 - runtime-валидация контрактов в `src/contracts.ts`
- `typebox` 1.3.7 - схемы инструментов для Pi в `src/pi.ts` и `extensions/agent-lab.ts`

**Infrastructure:**

- Node built-ins (`node:fs/promises`, `node:child_process`, `node:readline`, `node:sqlite`) - хранение артефактов, процессы, протоколы и пример SQLite в `examples/llm-stateful-agent.mjs`

## Configuration

**Environment:**

- Pi хранит авторизацию и выбор модели; провайдер/модель задаются в settings набора (`src/contracts.ts`)
- Заголовки HTTP target получают значения из переменных окружения через `headersEnv` (`src/targets.ts`)
- `AGENT_LAB_SESSION` включает Pi-сессию, `AGENT_LAB_DEBUG_DIR` включает защищённые debug-файлы (`src/cli.ts`, `src/pi.ts`)

**Build:**

- `tsconfig.json` - strict ES2023 NodeNext compilation
- `package.json` scripts `build`, `typecheck`, `test`, `prepack`

## Platform Requirements

**Development:**

- Node.js 22.19+, npm и доступный исполняемый Pi; для внешних command-target нужны их локальные runtime

**Production:**

- CLI-пакет npm с `dist/`, `extensions/`, `skills/`, `docs/` и `examples/`; отдельного server/deployment runtime не обнаружено

---

*Stack analysis: 2026-09-15*

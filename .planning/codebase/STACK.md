---
last_mapped_commit: fd07c336134b6bfe7bf48c8be0119c1b14dec56b
last_mapped_at: 2026-09-24
---
# Technology Stack

**Analysis Date:** 2026-09-24

## Languages

**Primary:**

- TypeScript 5.9.3 - Full codebase (`src/`, `extensions/`, `test/`), ESM, `strict`
- JavaScript (ESM) - `src/module-worker.mjs` (runs a module adapter in its own process), `examples/*.mjs`

**Secondary:**

- Python - Example command adapters (`examples/echo-agent.py`, `examples/stateful-agent.py` with SQLite state)
- YAML - CI (`.github/workflows/check.yml`, `examples/regression-ci.yml`)

## Runtime

**Environment:**

- Node.js >= 22.19.0 (`engines`), ES2023 output, NodeNext modules
- Pi (`@earendil-works/pi-coding-agent`) hosts the chat; the extension is loaded as TypeScript through jiti

**Package Manager:**

- npm with package-lock.json
- Lockfile: Present in repository

## Frameworks

**Core:**

- @earendil-works/pi-coding-agent 0.85.1 - Pi runtime: extension API (tools, commands, native dialogs), `ModelRuntime` for model calls, resource loader
- @earendil-works/pi-tui 0.85.1 - Terminal components and width-aware text helpers (`truncateToWidth`, `visibleWidth`, `stripTerminalSequences`)

**Schema & Validation:**

- zod 4.5.4 - Every stored record, import, command and model answer is parsed through zod schemas
- typebox 1.3.7 - Closed JSON schemas of the nine Pi tool parameter objects

**Build/Dev:**

- tsc (TypeScript 5.9.3) - Compiles `src/` to `dist/` for the `agent-lab` binary
- tsx 4.20+ (4.23.13 installed) - Runs tests and live scripts from TypeScript
- `node -e` inline script - Clears `dist/` before `tsc`

## Key Dependencies

**Critical:**

- @earendil-works/pi-coding-agent - Extension API, `ModelRuntime.completeSimple` for one-shot model calls (`src/llm/model-call.ts`), provider auth handled by Pi
- @earendil-works/pi-tui - Terminal rendering of chat rows, the workspace and result screens
- zod - Data contracts (`src/contracts.ts`, `src/card/schema.ts`, `src/miner/schema.ts`, `src/spreadsheet/mapping.ts`)
- typebox - Tool parameter schemas in `extensions/*-tool*.ts`

**Infrastructure:**

- @types/node ^22.19.0 - Node.js type definitions
- No other runtime dependencies: `.docx` and `.xlsx` are read by an own ZIP reader on `node:zlib` (`src/zip.ts`), sheet XML by a small tokenizer, CSV per RFC 4180 (`src/spreadsheet/`)
- Standard library: node:fs/promises, node:fs, node:path, node:crypto, node:child_process, node:readline, node:util (`parseArgs`), node:url, node:os, node:zlib, node:console

## Configuration

**Environment:**

- `AGENT_LAB_SESSION=1` - Set by `agent-lab chat`: the extension adds the skill body to the system prompt and draws its header
- `AGENT_LAB_PROVIDER` / `AGENT_LAB_MODEL` - Model of the live teaching example and smoke scripts (`examples/scenario-lab-demo.mjs`, `test/live/scenario-lab.ts`)
- Release hooks receive `AGENT_LAB_RUN_ID`, `AGENT_LAB_TARGET_VERSION`, `AGENT_LAB_PROMPT_FILE`, `AGENT_LAB_PROMPT_HASH`
- HTTP agent headers name environment variables (`headersEnv`); values are read at request time and never stored
- Model credentials live in Pi (`/login` or a provider key); the default judge is `openrouter` / `openai/gpt-5.6-sol` pinned to the `openai` upstream
- No `.env` file is read for configuration; project detection reads `.env` variable names only

**Build:**

- `tsconfig.json` - `strict`, `noUncheckedIndexedAccess`, ES2023, NodeNext, declarations and source maps, `rootDir: src`
- `npm run typecheck` adds `--noUnusedLocals` and type-checks `extensions/*.ts` with `--allowImportingTsExtensions`

## File Organization

**Source:**

- `src/` - Engine: records, store, runs, judging, results, CLI (`src/cli.ts`)
- `src/card/` - Situations (cards): schema, proposal, checks, review, compile, commands, view, calibration
- `src/llm/` - One typed core for model calls: `model-call.ts`, `structured.ts`, `models.ts`
- `src/miner/` - Topic map, representative sample, coverage of an import
- `src/spreadsheet/` - `.xlsx`/`.csv` logs read through an owner-confirmed mapping
- `extensions/` - Pi extension (`agent-lab.ts`), its nine tools, the `/agent-lab` workspace, `render/`
- `skills/agent-builder/SKILL.md` - The one instruction source of an Agent Lab chat
- `examples/` - Reference adapters, a connection, a saved suite, the teaching example, a CI workflow
- `test/` - `*.test.ts`, `helpers/`, `fixtures/` (frozen records of older formats), `live/` (paid model checks)
- `dist/` - Compiled JavaScript for the `agent-lab` binary only (generated)

## Platform Requirements

**Development:**

- Node.js 22.19.0+
- npm (package-lock.json)
- Python 3 for the example command adapters and CI suite

**Production:**

- Node.js 22.19.0+ and a Pi installation with a configured model
- No database server: records are JSON files in the project's `.agent-lab/`
- The agent under test speaks one of three contracts: command (JSON lines), module (`createSession`), HTTP (JSON POST)

**Deployment:**

- Binary entry point: `dist/cli.js` (`#!/usr/bin/env node`), published as `agent-lab` (package `pi-agent-lab`)
- Pi package manifest: `pi.extensions` → `./extensions/agent-lab.ts`, `pi.skills` → `./skills`
- Shipped files: `dist`, `src`, `extensions`, `skills`, `examples`, `README.md`, `docs/superpowers/scenario-lab-verification.md`

## Build Process

```bash
npm run build        # Clean dist/ then tsc
npm run typecheck    # build + strict tsc over extensions/*.ts
npm test             # build + tsx --test test/*.test.ts
npm run demo         # tsx src/cli.ts demo — the teaching example without a model
npm start            # build + node dist/cli.js chat
npm run pi           # pi with the extension and the skill
prepack              # build before npm pack/publish
```

## External Runtime Dependencies

- Child processes for command targets, module targets (`src/module-worker.mjs`) and release hooks
- `fetch` for HTTP targets (200 000-byte reply cap)
- Model providers configured in Pi, reached through `ModelRuntime`
- File system for records, imports, trace journals, judge sidecars and exports
- `node:crypto` for SHA-256 content hashes and UUIDs

---

*Stack analysis: 2026-09-24*

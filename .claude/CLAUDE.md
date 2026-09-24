<!-- GSD:project-start source:PROJECT.md -->

## Project

**Agent Lab**

Agent Lab — пакет для Pi, который прогоняет настоящего AI-агента на реальных диалогах и отвечает понятным языком: насколько хорош агент, где и почему он ошибается и чему в этой оценке можно верить. Он для трёх людей: владельца агента, который запускает проверку сам; менеджера заказчика, которому нужен ответ «хорош ли агент»; новичка, который впервые ставит Lab на своего агента без нашей помощи.

Этот проект доводит работающий MVP до продукта топ-уровня: числу можно верить, результат понятен без объяснений, начать легко, и всё выглядит красиво.

**Core Value:** Владелец агента и заказчик за 10 секунд понимают, насколько хорош агент и почему он ошибается, и верят этому числу.

### Constraints

- **Interface**: только Pi — весь опыт внутри Pi; HTML-отчёт — файл для пересылки. Так решил пользователь (2026-09-08, подтверждено 2026-09-16).
- **Timeline**: всё к демо заказчику в понедельник 2026-09-21. Фазы упорядочены по важности для заказчика: при нехватке времени недоделанным остаётся хвост, а не то, что видит заказчик.
- **Evidence**: Основной путь проверяется на внешних агентах разных продуктов; учебные и реальные результаты маркируются раздельно. Одних unit-тестов недостаточно. Работа засчитывается, только если заканчивается наблюдаемым результатом.
- **Tech stack**: TypeScript ESM, Node.js >=22.19, `strict`; zod 4, typebox, Pi SDK и `pi-tui` 0.85.1. Новые runtime-зависимости добавлять только с явной причиной.
- **Language**: строки для пользователя и документация — на русском; код, идентификаторы и команды — на английском.
- **Compatibility**: старые JSON-записи открываются и переоцениваются без миграции.
- **Truth**: источник истины — JSON-записи и события. То, что не наблюдалось, остаётся `unknown`; слова агента не доказывают действие.
- **Data**: прод-диалоги банка хранятся только локально (`.agent-lab`, права `0600`) и никогда не попадают в репозиторий.
- **Workspace**: в этом worktree могут работать другие сессии; перед правками смотреть `git status` и `git log`. Расширение Pi импортирует `src/` напрямую (Pi грузит TypeScript через jiti), `dist/` нужен только бинарю `agent-lab`, поэтому `npm test` и `npm run build` живой Pi не ломают.
- **Agent under test**: Испытуемые продукты — внешние системы. Не менять их файлы, Git, БД или процессы ради разработки Lab. Подключать через объявленный TargetSession/HTTP/module/command adapter; специальные пути и учётные данные принадлежат локальной конфигурации пользователя. Судья по умолчанию — `openai/gpt-5.6-sol` через OpenRouter.

<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->

## Technology Stack

## Languages

- TypeScript 5.9.3 - Full codebase (`src/`, `extensions/`, `test/`), ESM, `strict`
- JavaScript (ESM) - `src/module-worker.mjs` (runs a module adapter in its own process), `examples/*.mjs`
- Python - Example command adapters (`examples/echo-agent.py`, `examples/stateful-agent.py` with SQLite state)
- YAML - CI (`.github/workflows/check.yml`, `examples/regression-ci.yml`)

## Runtime

- Node.js >= 22.19.0 (`engines`), ES2023 output, NodeNext modules
- Pi (`@earendil-works/pi-coding-agent`) hosts the chat; the extension is loaded as TypeScript through jiti
- npm with package-lock.json
- Lockfile: Present in repository

## Frameworks

- @earendil-works/pi-coding-agent 0.85.1 - Pi runtime: extension API (tools, commands, native dialogs), `ModelRuntime` for model calls, resource loader
- @earendil-works/pi-tui 0.85.1 - Terminal components and width-aware text helpers (`truncateToWidth`, `visibleWidth`, `stripTerminalSequences`)
- zod 4.5.4 - Every stored record, import, command and model answer is parsed through zod schemas
- typebox 1.3.7 - Closed JSON schemas of the nine Pi tool parameter objects
- tsc (TypeScript 5.9.3) - Compiles `src/` to `dist/` for the `agent-lab` binary
- tsx 4.20+ (4.23.13 installed) - Runs tests and live scripts from TypeScript
- `node -e` inline script - Clears `dist/` before `tsc`

## Key Dependencies

- @earendil-works/pi-coding-agent - Extension API, `ModelRuntime.completeSimple` for one-shot model calls (`src/llm/model-call.ts`), provider auth handled by Pi
- @earendil-works/pi-tui - Terminal rendering of chat rows, the workspace and result screens
- zod - Data contracts (`src/contracts.ts`, `src/card/schema.ts`, `src/miner/schema.ts`, `src/spreadsheet/mapping.ts`)
- typebox - Tool parameter schemas in `extensions/*-tool*.ts`
- @types/node ^22.19.0 - Node.js type definitions
- No other runtime dependencies: `.docx` and `.xlsx` are read by an own ZIP reader on `node:zlib` (`src/zip.ts`), sheet XML by a small tokenizer, CSV per RFC 4180 (`src/spreadsheet/`)
- Standard library: node:fs/promises, node:fs, node:path, node:crypto, node:child_process, node:readline, node:util (`parseArgs`), node:url, node:os, node:zlib, node:console

## Configuration

- `AGENT_LAB_SESSION=1` - Set by `agent-lab chat`: the extension adds the skill body to the system prompt and draws its header
- `AGENT_LAB_PROVIDER` / `AGENT_LAB_MODEL` - Model of the live teaching example and smoke scripts (`examples/scenario-lab-demo.mjs`, `test/live/scenario-lab.ts`)
- Release hooks receive `AGENT_LAB_RUN_ID`, `AGENT_LAB_TARGET_VERSION`, `AGENT_LAB_PROMPT_FILE`, `AGENT_LAB_PROMPT_HASH`
- HTTP agent headers name environment variables (`headersEnv`); values are read at request time and never stored
- Model credentials live in Pi (`/login` or a provider key); the default judge is `openrouter` / `openai/gpt-5.6-sol` pinned to the `openai` upstream
- No `.env` file is read for configuration; project detection reads `.env` variable names only
- `tsconfig.json` - `strict`, `noUncheckedIndexedAccess`, ES2023, NodeNext, declarations and source maps, `rootDir: src`
- `npm run typecheck` adds `--noUnusedLocals` and type-checks `extensions/*.ts` with `--allowImportingTsExtensions`

## File Organization

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

- Node.js 22.19.0+
- npm (package-lock.json)
- Python 3 for the example command adapters and CI suite
- Node.js 22.19.0+ and a Pi installation with a configured model
- No database server: records are JSON files in the project's `.agent-lab/`
- The agent under test speaks one of three contracts: command (JSON lines), module (`createSession`), HTTP (JSON POST)
- Binary entry point: `dist/cli.js` (`#!/usr/bin/env node`), published as `agent-lab` (package `pi-agent-lab`)
- Pi package manifest: `pi.extensions` → `./extensions/agent-lab.ts`, `pi.skills` → `./skills`
- Shipped files: `dist`, `src`, `extensions`, `skills`, `examples`, `README.md`, `docs/superpowers/scenario-lab-verification.md`

## Build Process

## External Runtime Dependencies

- Child processes for command targets, module targets (`src/module-worker.mjs`) and release hooks
- `fetch` for HTTP targets (200 000-byte reply cap)
- Model providers configured in Pi, reached through `ModelRuntime`
- File system for records, imports, trace journals, judge sidecars and exports
- `node:crypto` for SHA-256 content hashes and UUIDs

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

## Naming Patterns

- Lowercase with hyphens: `result-text.ts`, `target-version.ts`, `fs-atomic.ts`
- Folders group one concern: `src/card/`, `src/llm/`, `src/miner/`, `src/spreadsheet/`, `extensions/render/`
- Test files: `.test.ts` suffix named after the concern (`card-review.test.ts`, `spreadsheet-import.test.ts`)
- No file over 1000 lines in `src/` or `extensions/`; split along real seams, not by line count
- camelCase: `deriveRun()`, `representativeSample()`, `valueTokens()`, `targetFingerprint()`
- Factory functions: `createSession()`, `createDemoRuntime()`, `createPiRuntime()`
- Predicates: `simulatorUsable()`, `trialAssessmentComplete()`, `measurementUsable()`, `isRunnable()`
- Two-step owner commands: `prepare…` builds the preview, `apply…` writes it with a host grant (`prepareCardCommand` / `applyCardCommand`, `prepareLogVersion` / `applyLogVersion`)
- camelCase throughout: `seenTrialIds`, `acceptedHash`, `trialMap`
- Local constants: camelCase
- Loop counters: single letter `i`, `j`
- Destructured imports use exact names from exports
- Type/Interface: PascalCase: `Scenario`, `Trial`, `ResultView`, `LibraryV2`, `TableProposal`
- Schema objects: camelCaseSchema: `scenarioSchema`, `userModeSchema`, `targetSchema`
- Types inferred from schemas: `type UserMode = z.infer<typeof userModeSchema>`
- Constants: UPPERCASE: `VERSION`, `DEFAULT_JUDGE`, `SCENARIO_LIMIT`, `IMPORT_DIALOGUE_LIMIT`, `NOT_MEASURED_CODES`
- Tool names come from one table: `TOOL` in `extensions/steps.ts`
- `z.enum([...])` and `as const` arrays instead of TypeScript enums: `z.enum(['reactive', 'scripted', 'static'])`, `NOT_MEASURED_CODES`
- Discriminated unions tagged by `kind`: targets (`http`, `module`, `command`, `unconnected`), owner commands, table questions

## Code Style

- No external formatter (no prettier, no eslint config)
- Semicolons, 2-space indentation, single quotes
- Long lines are tolerated for data and prompt text; code lines stay readable
- No ESLint or Prettier configuration
- TypeScript `strict`, `noUncheckedIndexedAccess`; `npm run typecheck` adds `noUnusedLocals`
- `strict: true`, `noUncheckedIndexedAccess: true`
- ES2023 target with NodeNext module resolution
- Generated `.d.ts` declaration files and source maps

## Import Organization

- No path aliases; relative imports
- In `src/`, `.js` extensions on every import: `'./contracts.js'`
- In `extensions/`, engine modules by `.js` (`'../src/experiment.js'`) and sibling extension modules by `.ts` (`'./render/feed.ts'`): Pi loads the extension as TypeScript through jiti, and `dist/` serves only the `agent-lab` binary
- Type-only imports use `import type` or inline `type` specifiers

## Error Handling

- Plain `throw new Error(message)` for messages people read; the message says what is wrong and what to do: `'Файл импорта превышает 4 МБ. Выберите меньшую выборку.'`
- Typed errors where a caller reacts by kind, never by matching message text: `LibraryConflict`, `StaleRevisionError`, `CommandRefused`, `UnknownReference`, `LockedError`, `Stopped(reason)` (`src/errors.ts`), `ProviderFailure` (`src/llm/model-call.ts`), `StructuredTaskError` (`src/llm/structured.ts`), `NeedsOwner` (`extensions/lab-ui.ts`)
- A question to the owner is an error (`NeedsOwner`) that the tool turns into a result: nothing is written and the model is told not to guess
- Zod validation errors reach the owner in plain words (field and problem), never as a raw issue dump
- Where a run fails, a typed cause is written into the record (`trial.invalidCause`, `trial.assessmentFailure`); decoders of older reason texts read only records written before those fields
- Command-line errors include the next step: `'Для трёх пробных запросов укажите --yes.'`
- `--yes` is the owner's consent on the command line; without it a command previews and writes nothing
- `async`/`await` throughout; no `.then()` chains
- Tests assert failures with `assert.rejects()` / `assert.throws()`

## Comments

- A block comment at the top of a module says what it owns and what it never does, often with an ASCII diagram
- Above exported functions: what and why, not line-by-line how
- Before a rule that looks arbitrary: the reason it exists (a stored hash, a trust invariant, an owner decision)
- `/** … */` on exported functions, types and non-obvious fields
- Examples: `/** Drop the whole dialogue: removing one masked turn would silently change its meaning. */`, `/** A label on a passing or simulator criterion does not resolve an agent's failed criteria. */`

## Text and Language

- Owner-facing strings are Russian and use the owner's vocabulary: «ситуация», «разговор», «судья», «ошибка», «причина», «не измерено — причина»; never ids, hashes or JSON on a screen
- Code, identifiers, comments, commit messages and model prompts are English
- Every text on its way to a terminal crosses `safeText` / `safeLine` (`src/text.ts`); `oneLine` and `clip` shape single lines
- Russian plurals through `countText` / `pluralForm` (`src/plural.ts`)
- No regular expressions over human or model text: model answers are bound by per-call enums and schemas, text is compared exactly after one normalisation (NFKC, case, spacing); structural formats (ids, file names, XML, CSV) may use regex

## Model Calls

- One-shot calls go through `callModel` / `runStructured` (`src/llm/`): a `StructuredTask` names its role (builder, judge, simulator), instructions, output schema and domain check, with a bounded repair that states the exact reason
- Per-call enums: ids a model may answer with (messages, rules, topics, controller moves) are an enum built for that call
- Prompts that feed a stored hash (judge input, controller and simulator roles) never change in place; a change is a new version or mode

## Function Design

- Most functions are 10–50 lines; no hard limit, clarity first
- Complex flows get an ASCII diagram in the module header
- Object parameters named by role: `input`, `options`, `ctx`, `record`
- Defaults via zod schemas or default parameters
- Explicit return types on exported functions
- `null` for "searched but not found"; `undefined` for "not applicable" or an omitted option
- Views are data only (`ResultView`, `SituationView`); wording lives in one place (`src/result-text.ts`, `src/card/view.ts`) and every surface only lays it out

## Module Design

- Named exports only; helpers used inside one module stay unexported
- Contracts in `src/contracts.ts`, `src/card/schema.ts`, `src/miner/schema.ts`, `src/target-schema.ts`
- None; `extensions/` and `skills/` point directly to files
- Pure derivation modules (`run.ts`, `result-view.ts`, `result-text.ts`, `card/view.ts`, `inbox.ts`, `problems.ts`) do no I/O and no model calls
- One command layer for every surface: the chat tools, the `/agent-lab` workspace and the CLI call the same `ExperimentLab` operations and owner commands
- Tests in `test/` are named by concern and use frozen fixtures in `test/fixtures/`

## Type Usage

- `z.strictObject({ ... })` for stored and exchanged shapes
- Fields of retired features stay declared as opaque `retired` values (`z.unknown().optional()`), so old records parse without migration
- Refinements for rules the type cannot express: `.refine(v => !['__proto__', 'prototype', 'constructor'].includes(v), 'Reserved identifier')`
- Type inference: `export type Scenario = z.infer<typeof scenarioSchema>`
- For structures without a runtime schema: `export interface Source { id: string; name: string; content: string; hash: string; kind?: SourceKind }`
- Discriminated unions for variants, with exhaustive `switch` over `kind`

## Async Patterns

- `async function name(): Promise<T>`; long work runs in the background and reports through records and messages, never by holding the conversation
- Writes go through the single writer (`ExperimentLab`) and atomic file replacement (`src/fs-atomic.ts`)

## Null/Undefined Usage

- `null` for "searched but not found" and for an unknown cost
- `undefined` for "optional parameter" or "not applicable"
- `value ?? fallback` for null/undefined checks
- Optional chaining: `scenario.initialState?.external`

<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

## System Overview

```text

```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| **ExperimentLab** | Manages phases, orchestrates build/run/score flows, lock-based concurrency | `src/experiment.ts` |
| **ExperimentStore** | Atomic read/write of experiment records and trace journals | `src/store.ts` |
| **Contracts** | TypeScript schemas (Zod) for all data types: Experiment, Scenario, Trial, etc. | `src/contracts.ts` |
| **Build Phase Runtime** | Pi session that extracts requirements, generates scenarios from dialogues + materials | `src/pi.ts`, `src/prompts.ts` |
| **Trial Evaluation** | Executes a single scenario against target (sandbox/HTTP/module/command), grades checks | `src/evaluation.ts` |
| **Simulator Runtime** | Pi session answering as simulated reactive user, grounds responses in dialogue facts | `src/simulator.ts`, `src/pi.ts` (SIMULATOR_ROLE) |
| **Judge Runtime** | Pi session assessing trials with rubrics; issues verdicts on goal attainment, prompt compliance, simulator fidelity | `src/judge.ts`, `src/pi.ts` (ASSESS_ROLE) |
| **Target Adapters** | Connect to external agents (HTTP endpoint, CommonJS/ESM module, spawned process, Pi sandbox) | `src/targets.ts` |
| **Quality Analysis** | Compute accuracy, cluster failure causes, extract observables from trials | `src/quality.ts`, `src/outcomes.ts` |
| **Comparison** | Compare two runs (baseline vs candidate), compute delta and confidence interval | `src/comparison.ts` |
| **CLI** | Command-line interface for non-interactive use (CI/CD, batch operations) | `src/cli.ts` |
| **Pi Extension** | Tools registered with Pi coding agent: build, run, inspect, edit, accept, suite save/load | `extensions/agent-lab.ts` |

## Pattern Overview

- **Immutable trials**: Once a trial runs, its outcome is never recalculated; new rubrics trigger `reassess` (separate immutable result)
- **Validation-before-run**: All scenarios reviewed and approved by human before agent execution
- **Reactive simulator**: Simulated user responds to agent's actual questions, grounded in real dialogue facts (not scripted playback)
- **Lock-based single-writer**: Only one ExperimentLab instance can write to a data directory; readers don't acquire lock
- **Atomicity per-record**: Each experiment saved as one `{id}.json` file; trace events appended to `{id}.trace.jsonl` (survives interruption)
- **Production logs as ground truth**: Discovery mode mines regression tests from real production dialogues, excluding masked/unavailable data
- **Workflow duality**: `evaluate` (single run, show accuracy) vs `compare` (two runs, show delta)

## Layers

- **Purpose:** Conversational interface for Agent Lab; tools integrated into Pi coding agent
- **Location:** `extensions/agent-lab.ts`
- **Contains:** Eight tools (build, run, inspect, edit, accept, repeat, suite, connection, reassess); each maps to a CLI command
- **Depends on:** ExperimentLab, contracts, ExperimentStore, quality, artifacts
- **Used by:** Pi coding agent (`npm start` or `npm run pi`)
- **Purpose:** Non-interactive command execution; automation-friendly
- **Location:** `src/cli.ts` (compiled to `dist/cli.js`)
- **Contains:** Command parsers, output formatters, file I/O
- **Depends on:** ExperimentLab, ExperimentStore, imports, reporting
- **Used by:** Shell scripts, CI/CD pipelines (`agent-lab evaluate --input suite.json --yes`)
- **Purpose:** Drives phase transitions, manages concurrent trial execution, persists state
- **Location:** `src/experiment.ts` — ExperimentLab class
- **Contains:** Phase machine, build/run/score/reassess workflows, parallel trial loop (max 16 concurrent)
- **Depends on:** Contracts, Store, targets, evaluation, judge, comparison, quality, prompts
- **Used by:** Extension tools and CLI commands
- **Purpose:** Define all types and validation rules; single source of truth for schema
- **Location:** `src/contracts.ts`
- **Contains:** Zod schemas for Experiment, Scenario, Trial, Requirement, Check, Metric, Trial, Revision, etc.
- **Depends on:** Zod library only
- **Used by:** All other modules (build, evaluation, storage, reporting)
- **Purpose:** Atomic read/write of experiment records, trace journal append, lock management
- **Location:** `src/store.ts` — ExperimentStore class
- **Contains:** Experiment serialization/deserialization, JSONL trace logging, .lock file coordination
- **Depends on:** Contracts, Node.js fs/promises
- **Used by:** ExperimentLab (via `.store` property)
- **Purpose:** Generate requirements from owner materials, create scenarios (cards) from real dialogues
- **Location:** `src/pi.ts` (createPiRuntime), `src/prompts.ts` (REQUIREMENTS_ROLE, GOALS_ROLE, etc.)
- **Contains:** Pi session factories (ModelRuntime, SessionManager wrappers), role prompts
- **Depends on:** Contracts, Pi coding agent SDK
- **Used by:** ExperimentLab.create() during preparing phase
- **Purpose:** Execute one scenario against the target agent, collect events, grade deterministic checks
- **Location:** `src/evaluation.ts` — evaluateTrial() function
- **Contains:** Trial lifecycle (open session → agent reply loop → grade checks), event recording
- **Depends on:** Contracts, targets, sandbox, simulator, evaluation
- **Used by:** ExperimentLab trial loop (runSuite)
- **Purpose:** Connect to external agents; abstract over HTTP, module import, spawned process, or sandbox
- **Location:** `src/targets.ts`
- **Contains:** Target session lifecycle, JSON request/reply marshaling, health checks
- **Depends on:** Contracts, connection
- **Used by:** evaluateTrial, preflightTarget (setup)
- **Purpose:** Simulated user that answers agent's questions, grounded in real dialogue facts
- **Location:** `src/simulator.ts` — simulatorChecks() function; `src/pi.ts` (SIMULATOR_ROLE prompt)
- **Contains:** Deterministic checks on simulator behavior; Pi role that generates user replies
- **Depends on:** Contracts, Pi SDK, prompts
- **Used by:** Trial event loop (evaluateTrial) to decide user replies
- **Purpose:** LLM assessment of trial outcomes against rubrics
- **Location:** `src/judge.ts`
- **Contains:** Rubric assessment logic, judge session orchestration, audit trail
- **Depends on:** Contracts, Pi SDK, prompts
- **Used by:** ExperimentLab during results_review phase (via reassess)
- **Purpose:** Compute accuracy, compare runs, extract failure causes, validate preparation
- **Location:** `src/comparison.ts`, `src/quality.ts`, `src/outcomes.ts`
- **Contains:** Statistics (confidence intervals via bootstrap), failure clustering, verdicts
- **Depends on:** Contracts
- **Used by:** ExperimentLab, extension tools, CLI, reporting
- **Purpose:** Export evidence, generate human-readable and machine reports
- **Location:** `src/report.ts`, `src/artifacts.ts`
- **Contains:** HTML/Markdown/JSON exporters, summary rendering
- **Depends on:** Contracts, analysis, store
- **Used by:** Extension tools, CLI export command

## Data Flow

### Primary Request Path: Build → Run → Score → Verdict

### Discovery Flow: Mine One Regression Test

### Validate Flow: Accuracy from Production Logs

### Reassess Flow: New Rubrics on Recorded Evidence

## Key Abstractions

- Purpose: Full run record — immutable once phase moves past "review"
- Examples: `src/contracts.ts` (experimentSchema)
- Pattern: Persisted as one JSON file per run; phases transition atomically
- Purpose: One test case — goal, initial state, user opening, success criteria
- Examples: `src/contracts.ts` (scenarioSchema), `src/prompts.ts` (GOALS_ROLE)
- Pattern: Generated once per run; never edited mid-trial; immutable after accepting
- Purpose: One execution of a scenario — agent response, events, check results
- Examples: `src/contracts.ts` (trialSchema), `src/evaluation.ts` (evaluateTrial)
- Pattern: Created during evaluating phase, graded once, never recalculated
- Purpose: One rule extracted from owner materials, grounded with exact quote
- Examples: `src/contracts.ts` (requirementSchema), `src/pi.ts` (REQUIREMENTS_ROLE)
- Pattern: Parsed from materials during preparing phase; used to score scenarios
- Purpose: Immutable snapshot of agent spec (instructions + tools), labeled with hypothesis
- Examples: `src/contracts.ts` (revisionSchema), `src/experiment.ts` (revision function)
- Pattern: ID derived from content hash; multiple revisions never used in one run
- Purpose: Deterministic assertion on trial outcome (state field value, tool call count, answer substring, etc.)
- Examples: `src/contracts.ts` (checkSchema), `src/evaluation.ts` (grade function)
- Pattern: Defined in scenario; graded once per trial; pass/fail is deterministic
- Purpose: LLM-based assessment criterion (goal_attainment, prompt_compliance, etc.)
- Examples: `src/contracts.ts` (metricSchema), `src/judge.ts` (assessRepeated)
- Pattern: Applied to trials during results_review phase; used to override/enrich check verdicts
- Purpose: Statistical delta between two runs (baseline vs candidate)
- Examples: `src/contracts.ts` (comparisonSchema), `src/comparison.ts` (compareTrials)
- Pattern: Computed after both runs complete; includes bootstrap CI and sign test p-value

## Entry Points

- `agent-lab chat` — Interactive Pi session with Agent Lab extension
- `agent-lab build --input task.json` — Generate scenarios offline
- `agent-lab evaluate --input suite.json --yes` — Run saved suite without interaction
- `agent-lab summary --id RUN` — Show accuracy + causes (read-only)
- `agent-lab export --id RUN --format html` — Generate report
- `agent-lab diff --before RUN1 --after RUN2` — Compare two runs
- `agent_lab_build` — Main entry (build, discover, validate, score modes)
- `agent_lab_run` — Execute approved draft
- `agent_lab_inspect` — Read plan/results (no approval, export optional)
- `agent_lab_accept` — Approve one test definition
- `agent_lab_edit` — Modify draft before approval
- `agent_lab_repeat` — Copy approved suite into fresh draft
- `agent_lab_suite` — Save / load / list reusable test suites
- `agent_lab_connection` — Check/remember agent connection
- `agent_lab_reassess` — Evaluate saved trials with new rubrics
- Conversational framework; guides user through build → run → review flow

## Architectural Constraints

- **Threading:** Single-threaded event loop (Node.js); trials run sequentially or up to MAX_PARALLEL (16) concurrent, managed via Promise.all
- **Global state:** ExperimentLab holds mutable phase/record state; ExperimentStore manages `.lock` file to prevent concurrent writes
- **Circular imports:** None enforced; modularity achieved via dependency on contracts (schemas are acyclic)
- **Immutability:** Trials once recorded are immutable; re-evaluation requires new run (workflow: reassess)
- **Determinism:** Check grading (state equality, tool counts) is deterministic; simulator and judge calls are non-deterministic but recorded (audit trail in trace journal)
- **Concurrency model:** One writer (ExperimentLab with lock), many readers (ExperimentStore.get without lock, read-only snapshots)
- **Transaction scope:** One experiment record = one atomic transaction; trace journal appends are sync + flush to survive interruption

## Error Handling

- **Phase errors:** Transition to `error` phase, save error message in record; never overwrite error state
- **Target errors:** Trial marked `invalid` (measurement failed); does not count toward accuracy
- **Validation errors:** Schema parsing via Zod; human-readable messages with field paths
- **External state errors:** Trial `invalid` if adapter doesn't confirm resetConfirmed, state observability, or tool scope
- **Budget overrun:** Stop mid-phase, save usage, ask human before continuing (resumable discovery)
- **Lock contention:** Throw immediately with recovery instructions

## Cross-Cutting Concerns

- Trial events → trace journal (`{id}.trace.jsonl`) line-by-line
- Judge audits → same trace journal (trialId + judgeAudit struct)
- Phase transitions → logged in experiment record
- Input validation via Zod schemas (contracts.ts)
- Grounding validation (requirement quotes verbatim; scenario checks sensible)
- Trial validation (checks graded only if measurement complete; scenario matched to trial)
- Target: via environment variables (API keys in headersEnv, credentials from external system)
- LLM models: via Pi's configured credentials (provider auth handled by Pi SDK)
- No per-run auth; connection validated once per `.agent-lab/` directory via doctor probe

## Anti-Patterns

### Not Storing Trial Results Separately from Scenarios

### Modifying Scenarios Mid-Run

### Trusting Adapter Assertions Without Grading

### Pooling Model Calls Across Rubrics

### Silently Truncating RAG Context

<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->

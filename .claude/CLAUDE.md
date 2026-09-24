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

- TypeScript 5.9.3 - Full codebase (src/, extensions/, skills/)
- JavaScript - Development utilities, Node.js ecosystem
- Python - Example target agents (`examples/stateful-agent.py`, `examples/echo-agent.py`)
- Shell - CI/CD pipeline examples (`examples/regression-ci.yml`)

## Runtime

- Node.js >= 22.19.0
- Target ES2023 JavaScript output
- npm with package-lock.json
- Lockfile: Present in repository

## Frameworks

- @earendil-works/pi-coding-agent 0.85.1 - Pi native coding-agent runtime, primary framework
- @earendil-works/pi-tui 0.85.1 - Terminal UI components for Pi
- zod 4.5.4 - Runtime TypeScript schema validation and parsing
- typebox 1.3.7 - JSON schema generation and validation
- tsc (TypeScript Compiler) - Compilation to dist/
- tsx 4.20.0 - Development runtime for TypeScript execution
- node -e inline build script - Custom clean-build process

## Key Dependencies

- @earendil-works/pi-coding-agent - Pi ecosystem integration, extension API, coding-agent runtime
- @earendil-works/pi-tui - Text UI rendering for terminal, terminal sequence handling
- zod - Schema validation for all data contracts (experiments, scenarios, trials, configurations)
- typebox - JSON schema generation for structured responses
- @types/node 22.19.0 - Node.js type definitions
- Standard library: node:child_process, node:fs/promises, node:path, node:crypto, node:util, node:readline

## Configuration

- AGENT_LAB_SESSION - Internal flag set when running Pi chat mode
- Custom HTTP headers via environment variables (configurable per target, names defined in connection configuration)
- No .env file required; all configuration via JSON or command-line
- tsconfig.json - Strict TypeScript compilation (ES2023, NodeNext modules, strict mode, no unchecked index access)
- TypeBox types in JSON schema for judge response format validation

## File Organization

- `src/` - Core TypeScript implementation
- `dist/` - Compiled JavaScript (generated on build)
- `extensions/` - Pi extension (`agent-lab.ts`) providing CLI and UI integration
- `skills/` - Pi skills for agent building (`agent-builder/SKILL.md`)
- `examples/` - Sample agents and configurations (Python, Node.js, JSON)
- `test/` - Test files (run via tsx --test)

## Platform Requirements

- Node.js 22.19.0+
- npm (modern version supporting package-lock.json)
- TypeScript compiler
- Node.js 22.19.0+
- Command-line execution via node dist/cli.js
- No database server required (file-based storage)
- Target agent must accept JSON-line protocol or run as HTTP server
- Binary entry point: `dist/cli.js` (shebang line: `#!/usr/bin/env node`)
- Published as npm package to registry
- Available as `agent-lab` command when installed globally

## Build Process

## External Runtime Dependencies

- Child process spawning for agent targets (command mode)
- HTTP client for agent targets (module provided by @earendil-works/pi-coding-agent runtime)
- File system for experiment storage and logs
- Standard crypto for hashing and UUID generation

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

## Naming Patterns

- Lowercase with hyphens: `agent-lab.ts`, `prompt-edit.ts`, `target-version.ts`
- Test files: `.test.ts` suffix (e.g., `simulator.test.ts`, `contracts.test.ts`)
- One exported module per file, named after primary export
- camelCase: `valueTokens()`, `selectValidationDialogues()`, `targetFingerprint()`
- Async functions use camelCase: `readData()`, `targetFingerprint()`
- Factory/builder functions: `createSession()`, `createInputSchema`, `demoEvaluateRecord()`
- Predicate/boolean-returning functions: `simulatorUsable()`, `trialAssessmentComplete()`, `validationDialogueIssue()`
- camelCase throughout: `seenTrialIds`, `baselineId`, `manifestHash`, `trialMap`
- Local constants: camelCase
- Loop counters: single letter `i`, `j`, `c`
- Destructured imports use exact names from exports
- Type/Interface: PascalCase: `Scenario`, `Trial`, `UserMode`, `Target`, `ReleaseLog`
- Schema objects: camelCaseSchema pattern: `scenarioSchema`, `userModeSchema`, `targetSchema`
- Types inferred from schemas: `type UserMode = z.infer<typeof userModeSchema>`
- Constants: UPPERCASE: `VERSION`, `DEFAULT_JUDGE`, `TOOL_NAMES`, `REQUIREMENT_LIMIT`, `SCENARIO_LIMIT`
- Const objects: PascalCase or camelCase depending on role: `stages = { ... }` for lookup tables
- Zod discriminated unions replace traditional enums: `z.enum(['reactive', 'scripted', 'static'])`
- Literal types derived from schemas: `z.literal('sandbox')`, `z.literal('http')`

## Code Style

- No external formatter (no prettier, no eslint config)
- TypeScript strict mode enforced (`strict: true` in tsconfig.json)
- ES2023 target, NodeNext modules
- Semicolons required (TypeScript default)
- Indentation: 2 spaces (inferred from source)
- No ESLint configuration present
- No Prettier configuration present
- Rely on TypeScript `strict` mode: `noUncheckedIndexedAccess`, type checking
- `strict: true` - all strict checks enabled
- `noUncheckedIndexedAccess: true` - catch record/array access errors
- ES2023 target with NodeNext module resolution
- Generated `.d.ts` declaration files and source maps

## Import Organization

- No path aliases configured; relative imports used: `'./contracts.js'`, `'../src/judge.js'`
- `.js` extensions required in all import statements (ES modules)

## Error Handling

- `throw new Error(message)` for all error cases
- Descriptive messages in English and Russian mix: `throw new Error('Укажите --id RUN')`
- No error codes or error classes; plain Error with full context
- Messages include what was wrong and what to do: `'Файл импорта превышает 4 МБ. Выберите меньшую выборку.'`
- Validation errors from Zod passed through with original context
- Command-line errors include user instructions: `'Для трёх пробных запросов укажите --yes.'`
- System errors are distinct from user-facing errors
- No try/catch in most cases; errors propagate
- test() uses `assert.rejects()` to verify error throwing

## Comments

- Above complex algorithms: `// With no regressions, the two-sided paired sign test has p = 2 / 2^positiveFamilies.`
- Before non-obvious value tokens: `// 4321, A103, 14:00, 202-7 and 11.03.2024 are tokens`
- Explaining tricky regex or state transitions
- Block comments (`/** ... */`) for exported functions and complex concepts
- Explain what and why, not line-by-line how
- Example from `simulator.test.ts`: `/** opening → assistant → (simulator decision → user → assistant)* ; texts alternate exactly as evaluation.ts records them. */`
- Inline comments for unclear state: `// A label on a passing or simulator criterion does not resolve an agent's failed criteria.`

## Function Design

- Most functions are 10–50 lines
- No hard limit; prefer clarity over brevity
- Complex algorithms documented with ASCII diagrams: `trials ──pair by (scenario, repeat)──► family deltas`
- Use destructuring for multiple related parameters: `{ baselineId, candidateId, manifestHash, repeats, split } = input`
- Object parameters named descriptively: `input`, `options`, `scenario`, `trial`
- Defaults via Zod schemas or function defaults
- Explicit type annotations on all function signatures
- Return tuples when multiple related values: `[mean, stdDev]`
- Use descriptive type aliases: `type ManifestCase = { ... }`
- Null for "not found"; undefined for "not applicable"

## Module Design

- Named exports for all public functions and types
- One primary export per file is typical but not enforced
- Example `contracts.ts`: exports 50+ types and functions as a data contract module
- None used; `extensions/` and `skills/` point directly to files
- Data contracts in `contracts.ts` (types, schemas, constants)
- Logic modules (`evaluation.ts`, `judge.ts`, `comparison.ts`) import contracts and implement algorithms
- CLI handlers in `cli.ts` orchestrate across modules
- Tests in `test/` mirror source structure: `src/contracts.ts` → `test/contracts.test.ts`

## Type Usage

- Runtime validation via zod: `const agentSchema = z.strictObject({ ... })`
- Refinements for custom rules: `.refine(v => !['__proto__', 'prototype', 'constructor'].includes(v), 'Reserved identifier')`
- Discriminated unions for variants: `z.discriminatedUnion('kind', [...])`
- Type inference: `export type AgentSpec = z.infer<typeof agentSchema>`
- Used for fixed structures without schema: `export interface Source { id: string; name: string; content: string; hash: string; kind?: SourceKind }`
- Preferred over inline types when structure is reused
- Discriminated unions for tagged variants: `{ kind: 'sandbox' }`, `{ kind: 'http', ... }`, `{ kind: 'module', ... }`
- Encourages exhaustive pattern matching

## Async Patterns

- `async function methodName(): Promise<ReturnType>`
- No callback-based APIs; all promise-based
- `await` used inline; no `.then()` chains

## Null/Undefined Usage

- `null` for "searched but not found" results in data structures
- `undefined` for "optional parameter" or "not applicable"
- `value ?? fallback` for null/undefined checks
- Optional chaining: `scenario.initialState?.external`

<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

## System Overview

Agent Lab runs a real AI agent on situations drawn from its real logged conversations and answers one question in
plain words: how good the agent is — one accuracy number with its interval, what is not measured and why, the causes of
failure and how far the synthetic customers agree with production. Three surfaces share one engine; the engine shares
one derivation of the result.

```text
  Pi chat: 9 tools, active by step        /agent-lab workspace (board)        agent-lab CLI: command table
  extensions/agent-lab.ts, *-tool.ts      extensions/workspace*.ts            src/cli.ts
                 └──────────────────────────────────┼──────────────────────────────────┘
                                                     ▼
                         ExperimentLab — src/experiment.ts (the engine's one entry)
       lab/library.ts          lab/run.ts                 lab/review.ts             lab/record.ts   phases.ts
       situations: prepare,    a run: draft, owner's      results: re-assessment,   hashes, new &   the phase table
       check, commands, accept confirmation, dialogues    a person's verdicts       fresh records   (a leaf module)
                         lab/operation.ts — one operation at a time: budget, time, checkpoints, followers
                                                     │
   card/ (situations v2)   miner/ (topics, sample, coverage)   evaluation.ts + targets.ts   judge.ts, card/log-judge.ts
   llm/ + pi.ts (every model call as a typed task)   runtime.ts (what the engine asks of models and the agent)
                                                     │
                  run.ts ──► result-view.ts ──► result-text.ts · report.ts/blocks.ts · explain.ts
                  (one derivation)  (one model)      (the same words in chat, board, CLI, HTML/Markdown, CI exit code)
                                                     │
                     store.ts + scenario-store.ts — storage only ──► .agent-lab/ (0600 files, 0700 folders)
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| **ExperimentLab** | The engine's one entry over one data folder: opens it as the writer, marks records a dead process left running interrupted, reads live or stored records, delegates every operation to `lab/` | `src/experiment.ts` |
| **Phase table** | Every phase, whether a process owns it, and the moves of the normal course; `moveTo` refuses any other move, `stoppedPhase` says where work cut short ends | `src/phases.ts` |
| **Record** | The three hashes a record is sealed by (`draftHash`, `resultHash`, `measurementHash`), a new draft from the owner's input, a fresh draft copied from an earlier record | `src/lab/record.ts` |
| **OperationRunner** | One long operation at a time (preparation, check, run, re-assessment) and the short changes between them: call budget and time limit, checkpoints, cancel, and the followers told of every change instead of polling | `src/lab/operation.ts` |
| **Library operations** | Prepare situations from logs or rules under the consented ceiling, check them, apply the owner's commands, accept them, continue a preparation, convert a first-format draft, declare the logs' agent version | `src/lab/library.ts` |
| **Run operations** | Draft settings and connection, confirmation of first-format drafts, repeat, saved suites, the run itself (release hook, pool of dialogues, failure causes, calibration) | `src/lab/run.ts` |
| **Review operations** | Re-assessment of recorded dialogues (a separate result), a person's verdicts, the completed review | `src/lab/review.ts` |
| **Stored record** | Zod schemas of the stored record: Experiment, Scenario, Trial, settings, checks, human reviews; old records parse without migration | `src/contracts.ts` |
| **Assessment contract** | Rubrics, per-metric assessments with quoted evidence, judge audits and receipts, their validation | `src/assessment.ts` |
| **Runtime ports** | What the engine asks of models and of the agent: `Runtime`, `CallContext`, `TargetSession` | `src/runtime.ts` |
| **Situations (card v2)** | The card brief, proposal and binding, deterministic checks, the reviewer's claims, status and the owner's one question, commands, compilation at acceptance, calibration against production logs | `src/card/*` |
| **Scenario Miner** | The logs' topic map, the representative sample, coverage and traffic weights | `src/miner/*` |
| **Spreadsheet import** | `.xlsx`/`.csv` logs read through a mapping the owner confirms, a row filter, no dependency | `src/spreadsheet/*`, `src/zip.ts` |
| **Dialogues** | One trial = fresh world + target session + controlled customer; checks graded in code | `src/evaluation.ts`, `src/targets.ts`, `src/user-controller.ts` |
| **Judge** | Two votes per expectation, receipts over sidecar audits; the same judge on the logged conversation | `src/judge.ts`, `src/card/log-judge.ts` |
| **Model harness** | One request per call via Pi's `ModelRuntime`, typed structured tasks with bounded repairs, role→model table | `src/llm/*`, `src/pi.ts`, `src/prompts.ts` |
| **Result** | `deriveRun` → `ResultView` → the same rows and words everywhere; report as a block tree | `src/run.ts`, `src/result-view.ts`, `src/result-text.ts`, `src/report.ts`, `src/blocks.ts` |
| **Workspace & inbox** | The agent's workspace, open decisions, recurring problems, derived from records | `src/workspace.ts`, `src/inbox.ts`, `src/problems.ts` |
| **ExperimentStore** | Storage only: atomic record files, the writer's lock, journals and sidecars, content-addressed file areas, publication recovery, a change feed for readers | `src/store.ts`, `src/scenario-store.ts` |
| **CLI** | One table of commands over the same ExperimentLab operations; `--yes` is the owner's word | `src/cli.ts`, `src/cli/import-flags.ts` |
| **Pi extension** | Nine tools switched on by step, the `/agent-lab` workspace, long work handed to the session and followed through the engine's events | `extensions/*` |

## Pattern Overview

**Overall:** one engine behind three surfaces; an explicit phase table; one operation at a time whose progress is
pushed to followers; content-addressed evidence; one derivation of the result.

**Key Characteristics:**

- **Single writer:** one ExperimentLab holds the folder's `.lock`; readers never take it and may run beside a live run.
- **One operation at a time:** `OperationRunner.launch` reserves the lab before its first await, saves the record as
  started and returns; the work goes on in the background. Short changes run through `change()` and exclude operations.
- **Followers, not polling:** a checkpoint, a saved step of a preparation, a progress line (`say`) and the final save
  are announced to `lab.follow(...)` followers with the live record; the chat's rows, the session's progress row and
  the workspace redraw from it. Another process's saves reach a reader through `ExperimentStore.watch` (fs events).
  Only spinners turn on a clock — Pi's `Loader` and the workspace's own, at the same 80 ms — and a spinner only draws.
- **Typed phase table:** every checkpoint and every start moves a record with `moveTo`; a move the table does not hold
  is a defect, never a saved state.
- **Sealed evidence:** accepted situations are compiled once and sealed by definition hashes; a run is verified by
  stored hashes alone (`verifyAcceptedRun`); receipts seal sidecar audits; hashes use locale-free key orders.
- **Host-owned consent:** the owner agrees to what a preparation may spend (its computed ceiling) and to a run in one
  native dialog; the model never passes settings, grants or consent.
- **Honest unknown:** what was not observed stays `unknown`; an unmeasured situation never counts; costs that are not
  reported stay `null`.
- **One result:** `deriveRun` decides every outcome once; chat, board, CLI, HTML/Markdown and the CI exit code read it.

## Layers

**Surfaces:**

- Purpose: the owner's ways in — chat, workspace board, command line
- Location: `extensions/` (Pi), `src/cli.ts`
- Contains: tool definitions, native dialogs, rendering, the CLI command table
- Depends on: ExperimentLab, result and view projections
- Used by: Pi (`agent-lab chat`, `npm run pi`), shells and CI (`agent-lab evaluate`)

**Engine:**

- Purpose: every operation on records, their order and their budgets
- Location: `src/experiment.ts`, `src/lab/`, the phase table `src/phases.ts`
- Contains: phase table, record hashes, the operation runner, library/run/review operations
- Depends on: domain modules, runtime ports, the store
- Used by: surfaces only

**Domain:**

- Purpose: situations, logs, dialogues, judgment and calibration
- Location: `src/card/`, `src/miner/`, `src/spreadsheet/`, `src/evaluation.ts`, `src/judge.ts`, `src/targets.ts`, `src/simulator.ts`, `src/user-controller.ts`
- Contains: pure functions and typed schemas; paid steps take a `CallContext`
- Depends on: `src/contracts.ts`, `src/assessment.ts`, `src/runtime.ts`
- Used by: the engine; views read the stored shapes

**Model runtime:**

- Purpose: every model call as a typed task with a role, a schema and bounded repairs
- Location: `src/llm/`, `src/pi.ts`, `src/prompts.ts`, `src/demo.ts` (deterministic teaching runtime)
- Depends on: Pi SDK `ModelRuntime`; prompts inside stored hashes never change silently
- Used by: the engine through the `Runtime` port

**Result:**

- Purpose: the one accuracy metric and everything read from it
- Location: `src/run.ts`, `src/result-view.ts`, `src/result-text.ts`, `src/report.ts`, `src/blocks.ts`, `src/explain.ts`, `src/coverage.ts`, `src/agreement.ts`, `src/interval.ts`
- Used by: every surface and the CI exit code

**Storage:**

- Purpose: durable, private, atomic evidence
- Location: `src/store.ts`, `src/scenario-store.ts`, `src/fs-atomic.ts`, `src/miner/files.ts`, `src/spreadsheet/files.ts`
- Contains: record files, the lock, journals, sidecars, imports, libraries, publications — no phase, budget or command rule
- Used by: the engine; readers (CLI `summary`/`export`/`diff`, the board) read without the lock

## Data Flow

### Logs → situations → run → result

1. **Import:** a JSON/JSONL export or a spreadsheet read through the owner's confirmed mapping becomes an immutable,
   content-addressed import batch (`src/imports.ts`, `src/spreadsheet/`).
2. **Consent:** `preparationConsent` (`src/miner/plan.ts`) states the conversations read, those left out with reasons,
   the situations promised and the call ceiling (`src/card/budget.ts`: topic map + policy + per situation its reading,
   proposal allowance and review). The owner agrees in one native dialog.
3. **Preparation** (`lab/library.ts create` → `card/prepare.ts`): topic map, representative sample, rules grounded
   with verbatim quotes, one card per conversation, harness checks, the reviewer's claims; every step is published
   with the draft, so a resume never pays twice. The preparation stops at the consented ceiling.
4. **Review:** the owner answers questions and edits through commands (`card/commands.ts`), one host grant each.
5. **Run** (`lab/run.ts start`): one dialog accepts the ready situations and starts the run; every card is compiled
   and sealed; a pool of dialogues runs against the agent; every dialogue is a checkpoint; failure causes are named.
6. **Calibration** (`card/calibrate.ts`): the same expectations judged on the logged conversations — «синтетика
   совпадает с продом в N из M».
7. **Result:** `deriveRun` → `ResultView` → «Точность агента: N% — X из Y ситуаций» with interval, what is not
   measured, causes, calibration — the same in chat, board, CLI and report.

### Re-assessment

A finished run's recorded dialogues are judged again under new criteria or another judge (`lab/review.ts`): a
separate record with `assessmentOf`, the agent and the simulator are not called, the original never changes.

### Long work and its followers

`launch` → first save announced → `checkpoint` / `publishLibrary` / `say` announced → last save announced. The chat
row (`extensions/prepare-tool.ts`, `run-tool.ts`), the session's progress row (`extensions/operations.ts`,
`background.ts`) and the workspace (`extensions/workspace.ts`) redraw on each; completion is `waitForIdle`.

## Key Abstractions

- **Experiment (record):** one run or draft; one JSON file; `phase` moves only along `PHASE_TABLE` (`src/contracts.ts`, `src/phases.ts`).
- **Card / LibraryV2:** a situation's brief (what the customer wants, writes, knows, when they leave) and 1–3 duties with the owner's rules; revisions sealed by `libraryHash` (`src/card/schema.ts`).
- **Scenario:** a card compiled at acceptance; its `fingerprint` is the definition hash the acceptance seals (`src/card/compile.ts`).
- **Trial:** one dialogue with its events, checks, assessments and receipts; never recalculated in place (`src/contracts.ts`).
- **Operation / Follower:** the running work and whoever follows it (`src/lab/operation.ts`).
- **ResultView:** the one result model (`src/result-view.ts`).

## Entry Points

- **CLI (`dist/cli.js`, `src/cli.ts`):** `detect`, `import`, `build`, `cards`, `accept`, `run`, `repeat`, `demo`,
  `summary`, `logs`, `reassess`, `export`, `diff`, `save-suite`, `evaluate`, `suites`, `doctor`, `status`; `chat` (or
  no command in a terminal) opens Pi with the extension.
- **Pi tools (`extensions/steps.ts`):** `agent_lab_status`, `agent_lab_prepare` → + `agent_lab_cards`,
  `agent_lab_edit`, `agent_lab_decide`, `agent_lab_run` once situations exist → + `agent_lab_results`,
  `agent_lab_explain`, `agent_lab_agree` once a run has conversations.
- **Pi command:** `/agent-lab` — the agent's workspace; `/agent-lab demo` — the teaching example.
- **Instructions:** `skills/agent-builder/SKILL.md` joins the system prompt of an Agent Lab session.

## Architectural Constraints

- **Threading:** one event loop; dialogues of a run run in a pool of at most 16 (`MAX_PARALLEL`).
- **Global state:** only the running operation (`OperationRunner`) and the writer's lock; records are the truth.
- **Immutability:** accepted snapshots, imports and finished runs never change; changes go to fresh drafts.
- **Hashes:** stored hashes and receipts must keep verifying; `canonical()` pins the `en-US` collation, `fingerprint()` sorts by code point.
- **Compatibility:** old records (first library format, legacy runs) open, re-assess and repeat without migration.
- **Size:** no source file over 1000 lines; the engine is split along its operations.

## Error Handling

- **Work cut short:** `stoppedPhase` — a preparation that saved a draft returns to `review` with what it made; a
  stop is `cancelled`; anything else is `error`, with the reason in the record.
- **Budgets:** a preparation stops at its consented ceiling; a run, a check or a resume at the draft's limit
  (`settings.maxCalls`); a paid call that died in flight is never repeated silently.
- **Restart:** records left in a running phase become `interrupted` when the folder is opened again.
- **Measurement:** a dialogue that could not be measured is `invalid` with a typed cause and never counts.
- **Typed errors:** `LibraryConflict`, `StaleRevisionError`, `LockedError`, `Stopped`, `NeedsOwner` instead of message matching.

## Cross-Cutting Concerns

**Evidence:** trace events → `{id}.trace.jsonl`; judge audits → `{id}.judge/`; calibration audits → `{id}.calibration/`;
builder calls → `{id}.generator.jsonl`.

**Validation:** Zod at every stored boundary; quotes verbatim (`src/verbatim.ts`); per-call enums for model answers.

**Privacy:** production dialogues and credentials stay local in `.agent-lab` (0600/0700) and never enter the repository.
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

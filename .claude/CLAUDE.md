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
- **Workspace**: в этом worktree могут работать другие сессии. `npm test` и `npm run build` удаляют `dist/`, который импортирует живое расширение Pi, поэтому тесты и ревью гонять из снимка `git archive HEAD`; перед правками смотреть `git status` и `git log`.
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

---
last_mapped_commit: fd07c336134b6bfe7bf48c8be0119c1b14dec56b
last_mapped_at: 2026-09-24
---
# Coding Conventions

**Analysis Date:** 2026-09-24

## Naming Patterns

**Files:**

- Lowercase with hyphens: `result-text.ts`, `target-version.ts`, `fs-atomic.ts`
- Folders group one concern: `src/card/`, `src/llm/`, `src/miner/`, `src/spreadsheet/`, `extensions/render/`
- Test files: `.test.ts` suffix named after the concern (`card-review.test.ts`, `spreadsheet-import.test.ts`)
- No file over 1000 lines in `src/` or `extensions/`; split along real seams, not by line count

**Functions:**

- camelCase: `deriveRun()`, `representativeSample()`, `valueTokens()`, `targetFingerprint()`
- Factory functions: `createSession()`, `createDemoRuntime()`, `createPiRuntime()`
- Predicates: `simulatorUsable()`, `trialAssessmentComplete()`, `measurementUsable()`, `isRunnable()`
- Two-step owner commands: `prepare…` builds the preview, `apply…` writes it with a host grant (`prepareCardCommand` / `applyCardCommand`, `prepareLogVersion` / `applyLogVersion`)

**Variables:**

- camelCase throughout: `seenTrialIds`, `acceptedHash`, `trialMap`
- Local constants: camelCase
- Loop counters: single letter `i`, `j`
- Destructured imports use exact names from exports

**Types, Interfaces & Constants:**

- Type/Interface: PascalCase: `Scenario`, `Trial`, `ResultView`, `LibraryV2`, `TableProposal`
- Schema objects: camelCaseSchema: `scenarioSchema`, `userModeSchema`, `targetSchema`
- Types inferred from schemas: `type UserMode = z.infer<typeof userModeSchema>`
- Constants: UPPERCASE: `VERSION`, `DEFAULT_JUDGE`, `SCENARIO_LIMIT`, `IMPORT_DIALOGUE_LIMIT`, `NOT_MEASURED_CODES`
- Tool names come from one table: `TOOL` in `extensions/steps.ts`

**Enums:**

- `z.enum([...])` and `as const` arrays instead of TypeScript enums: `z.enum(['reactive', 'scripted', 'static'])`, `NOT_MEASURED_CODES`
- Discriminated unions tagged by `kind`: targets (`http`, `module`, `command`, `unconnected`), owner commands, table questions

## Code Style

**Formatting:**

- No external formatter (no prettier, no eslint config)
- Semicolons, 2-space indentation, single quotes
- Long lines are tolerated for data and prompt text; code lines stay readable

**Linting:**

- No ESLint or Prettier configuration
- TypeScript `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`; `npm run typecheck` applies the same to `extensions/` and `test/` (`tsconfig.check.json`)

**TypeScript Configuration (`tsconfig.json`):**

- `strict: true`, `noUncheckedIndexedAccess: true`
- ES2023 target with NodeNext module resolution
- Generated `.d.ts` declaration files and source maps

## Import Organization

**Order:**

1. Node built-in modules: `import { readFile } from 'node:fs/promises'`
2. Third-party libraries: `import { z } from 'zod'`
3. Project modules

**Path Aliases:**

- No path aliases; relative imports
- In `src/`, `.js` extensions on every import: `'./contracts.js'`
- In `extensions/`, engine modules by `.js` (`'../src/experiment.js'`) and sibling extension modules by `.ts` (`'./render/feed.ts'`): Pi loads the extension as TypeScript through jiti, and `dist/` serves only the `agent-lab` binary
- Type-only imports use `import type` or inline `type` specifiers

## Error Handling

**Patterns:**

- Plain `throw new Error(message)` for messages people read; the message says what is wrong and what to do: `'Файл импорта превышает 4 МБ. Выберите меньшую выборку.'`
- Typed errors where a caller reacts by kind, never by matching message text: `LibraryConflict`, `StaleRevisionError`, `CommandRefused`, `UnknownReference`, `LockedError`, `Stopped(reason)` (`src/errors.ts`), `ProviderFailure` (`src/llm/model-call.ts`), `StructuredTaskError` (`src/llm/structured.ts`), `NeedsOwner` (`extensions/lab-ui.ts`)
- A question to the owner is an error (`NeedsOwner`) that the tool turns into a result: nothing is written and the model is told not to guess
- Zod validation errors reach the owner in plain words (field and problem), never as a raw issue dump
- Where a run fails, a typed cause is written into the record (`trial.invalidCause`, `trial.assessmentFailure`); decoders of older reason texts read only records written before those fields

**CLI Context:**

- Command-line errors include the next step: `'Для трёх пробных запросов укажите --yes.'`
- `--yes` is the owner's consent on the command line; without it a command previews and writes nothing

**Async/Await:**

- `async`/`await` throughout; no `.then()` chains
- Tests assert failures with `assert.rejects()` / `assert.throws()`

## Comments

**When to Comment:**

- A block comment at the top of a module says what it owns and what it never does, often with an ASCII diagram
- Above exported functions: what and why, not line-by-line how
- Before a rule that looks arbitrary: the reason it exists (a stored hash, a trust invariant, an owner decision)

**JSDoc/TSDoc:**

- `/** … */` on exported functions, types and non-obvious fields
- Examples: `/** Drop the whole dialogue: removing one masked turn would silently change its meaning. */`, `/** A label on a passing or simulator criterion does not resolve an agent's failed criteria. */`

**Style:**

```typescript
/*
 * The one derivation of a run's result. Every surface — the chat block, the board, the CLI summary,
 * the CI exit code and the report — reads a run through `deriveRun`, so no two of them can count a
 * situation differently:
 *
 *   trials ──usable? human override──► attempt verdict ──every attempt, fail-first──► situation verdict
 *                                                        └─ undecided ──► one reason code (NOT_MEASURED_CODES)
 */
```

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

**Size:**

- Most functions are 10–50 lines; no hard limit, clarity first
- Complex flows get an ASCII diagram in the module header

**Parameters:**

- Object parameters named by role: `input`, `options`, `ctx`, `record`
- Defaults via zod schemas or default parameters

**Return Values:**

- Explicit return types on exported functions
- `null` for "searched but not found"; `undefined` for "not applicable" or an omitted option
- Views are data only (`ResultView`, `SituationView`); wording lives in one place (`src/result-text.ts`, `src/card/view.ts`) and every surface only lays it out

## Module Design

**Exports:**

- Named exports only; helpers used inside one module stay unexported
- Contracts in `src/contracts.ts`, `src/card/schema.ts`, `src/miner/schema.ts`, `src/target-schema.ts`

**Barrel Files:**

- None; `extensions/` and `skills/` point directly to files

**Organization:**

- Pure derivation modules (`run.ts`, `result-view.ts`, `result-text.ts`, `card/view.ts`, `inbox.ts`, `problems.ts`) do no I/O and no model calls
- One command layer for every surface: the chat tools, the `/agent-lab` workspace and the CLI call the same `ExperimentLab` operations and owner commands
- Tests in `test/` are named by concern and use frozen fixtures in `test/fixtures/`

## Type Usage

**Schemas with Zod:**

- `z.strictObject({ ... })` for stored and exchanged shapes
- Fields of retired features stay declared as opaque `retired` values (`z.unknown().optional()`), so old records parse without migration
- Refinements for rules the type cannot express: `.refine(v => !['__proto__', 'prototype', 'constructor'].includes(v), 'Reserved identifier')`
- Type inference: `export type Scenario = z.infer<typeof scenarioSchema>`

**Interfaces:**

- For structures without a runtime schema: `export interface Source { id: string; name: string; content: string; hash: string; kind?: SourceKind }`

**Union Types:**

- Discriminated unions for variants, with exhaustive `switch` over `kind`

## Async Patterns

**Async Functions:**

- `async function name(): Promise<T>`; long work runs in the background and reports through records and messages, never by holding the conversation
- Writes go through the single writer (`ExperimentLab`) and atomic file replacement (`src/fs-atomic.ts`)

## Null/Undefined Usage

**Patterns:**

- `null` for "searched but not found" and for an unknown cost
- `undefined` for "optional parameter" or "not applicable"
- `value ?? fallback` for null/undefined checks
- Optional chaining: `scenario.initialState?.external`

---

*Convention analysis: 2026-09-24*

---
last_mapped_commit: 015fee98766cc2082001fdfce3a329a31329d4cf
last_mapped_at: 2026-09-16
---
# Coding Conventions

**Analysis Date:** 2026-09-16

## Naming Patterns

**Files:**

- Lowercase with hyphens: `agent-lab.ts`, `prompt-edit.ts`, `target-version.ts`
- Test files: `.test.ts` suffix (e.g., `simulator.test.ts`, `contracts.test.ts`)
- One exported module per file, named after primary export

**Functions:**

- camelCase: `valueTokens()`, `selectValidationDialogues()`, `targetFingerprint()`
- Async functions use camelCase: `readData()`, `targetFingerprint()`
- Factory/builder functions: `createSession()`, `createInputSchema`, `demoEvaluateRecord()`
- Predicate/boolean-returning functions: `simulatorUsable()`, `trialAssessmentComplete()`, `validationDialogueIssue()`

**Variables:**

- camelCase throughout: `seenTrialIds`, `baselineId`, `manifestHash`, `trialMap`
- Local constants: camelCase
- Loop counters: single letter `i`, `j`, `c`
- Destructured imports use exact names from exports

**Types, Interfaces & Constants:**

- Type/Interface: PascalCase: `Scenario`, `Trial`, `UserMode`, `Target`, `ReleaseLog`
- Schema objects: camelCaseSchema pattern: `scenarioSchema`, `userModeSchema`, `targetSchema`
- Types inferred from schemas: `type UserMode = z.infer<typeof userModeSchema>`
- Constants: UPPERCASE: `VERSION`, `DEFAULT_JUDGE`, `TOOL_NAMES`, `REQUIREMENT_LIMIT`, `SCENARIO_LIMIT`
- Const objects: PascalCase or camelCase depending on role: `stages = { ... }` for lookup tables

**Enums:**

- Zod discriminated unions replace traditional enums: `z.enum(['reactive', 'scripted', 'static'])`
- Literal types derived from schemas: `z.literal('sandbox')`, `z.literal('http')`

## Code Style

**Formatting:**

- No external formatter (no prettier, no eslint config)
- TypeScript strict mode enforced (`strict: true` in tsconfig.json)
- ES2023 target, NodeNext modules
- Semicolons required (TypeScript default)
- Indentation: 2 spaces (inferred from source)

**Linting:**

- No ESLint configuration present
- No Prettier configuration present
- Rely on TypeScript `strict` mode: `noUncheckedIndexedAccess`, type checking

**TypeScript Configuration (`tsconfig.json`):**

- `strict: true` - all strict checks enabled
- `noUncheckedIndexedAccess: true` - catch record/array access errors
- ES2023 target with NodeNext module resolution
- Generated `.d.ts` declaration files and source maps

## Import Organization

**Order:**

1. Node built-in modules: `import { readFile } from 'node:fs/promises'`
2. Third-party libraries: `import { z } from 'zod'`
3. Project modules with `.js` extension: `import { ExperimentLab } from './experiment.js'`
4. Type imports after values: `import { type Scenario, type Trial } from './contracts.js'`

**Path Aliases:**

- No path aliases configured; relative imports used: `'./contracts.js'`, `'../src/judge.js'`
- `.js` extensions required in all import statements (ES modules)

**Pattern:**

```typescript
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { 
  assessmentRubrics, emptyUsage, userTurnSchema,
  type CallContext, type CheckResult, type Scenario, type Trial 
} from './contracts.js';
```

## Error Handling

**Patterns:**

- `throw new Error(message)` for all error cases
- Descriptive messages in English and Russian mix: `throw new Error('Укажите --id RUN')`
- No error codes or error classes; plain Error with full context
- Messages include what was wrong and what to do: `'Файл импорта превышает 4 МБ. Выберите меньшую выборку.'`
- Validation errors from Zod passed through with original context

**CLI Context:**

- Command-line errors include user instructions: `'Для трёх пробных запросов укажите --yes.'`
- System errors are distinct from user-facing errors

**Async/Await:**

- No try/catch in most cases; errors propagate
- test() uses `assert.rejects()` to verify error throwing

## Comments

**When to Comment:**

- Above complex algorithms: `// With no regressions, the two-sided paired sign test has p = 2 / 2^positiveFamilies.`
- Before non-obvious value tokens: `// 4321, A103, 14:00, 202-7 and 11.03.2024 are tokens`
- Explaining tricky regex or state transitions

**JSDoc/TSDoc:**

- Block comments (`/** ... */`) for exported functions and complex concepts
- Explain what and why, not line-by-line how
- Example from `simulator.test.ts`: `/** opening → assistant → (simulator decision → user → assistant)* ; texts alternate exactly as evaluation.ts records them. */`
- Inline comments for unclear state: `// A label on a passing or simulator criterion does not resolve an agent's failed criteria.`

**Style:**

```typescript
/** Drop the whole dialogue: removing one masked turn would silently change its meaning. */
export function validationDialogueIssue(dialogue: Dialogue): Omit<ValidationExclusion, 'dialogueId'> | undefined {
  // ...
}

/*

 * Pure statistics over persisted records. Nothing here performs I/O or model calls,
 * so every number shown in Pi, the CLI or an export comes from one place.
 *
 *   compareTrials      trials ──pair by (scenario, repeat)──► family deltas ──► delta · bootstrap interval · sign test
 */
```

## Function Design

**Size:**

- Most functions are 10–50 lines
- No hard limit; prefer clarity over brevity
- Complex algorithms documented with ASCII diagrams: `trials ──pair by (scenario, repeat)──► family deltas`

**Parameters:**

- Use destructuring for multiple related parameters: `{ baselineId, candidateId, manifestHash, repeats, split } = input`
- Object parameters named descriptively: `input`, `options`, `scenario`, `trial`
- Defaults via Zod schemas or function defaults

**Return Values:**

- Explicit type annotations on all function signatures
- Return tuples when multiple related values: `[mean, stdDev]`
- Use descriptive type aliases: `type ManifestCase = { ... }`
- Null for "not found"; undefined for "not applicable"

## Module Design

**Exports:**

- Named exports for all public functions and types
- One primary export per file is typical but not enforced
- Example `contracts.ts`: exports 50+ types and functions as a data contract module

**Barrel Files:**

- None used; `extensions/` and `skills/` point directly to files

**Organization:**

- Data contracts in `contracts.ts` (types, schemas, constants)
- Logic modules (`evaluation.ts`, `judge.ts`, `comparison.ts`) import contracts and implement algorithms
- CLI handlers in `cli.ts` orchestrate across modules
- Tests in `test/` mirror source structure: `src/contracts.ts` → `test/contracts.test.ts`

## Type Usage

**Schemas with Zod:**

- Runtime validation via zod: `const agentSchema = z.strictObject({ ... })`
- Refinements for custom rules: `.refine(v => !['__proto__', 'prototype', 'constructor'].includes(v), 'Reserved identifier')`
- Discriminated unions for variants: `z.discriminatedUnion('kind', [...])`
- Type inference: `export type AgentSpec = z.infer<typeof agentSchema>`

**Interfaces:**

- Used for fixed structures without schema: `export interface Source { id: string; name: string; content: string; hash: string; kind?: SourceKind }`
- Preferred over inline types when structure is reused

**Union Types:**

- Discriminated unions for tagged variants: `{ kind: 'sandbox' }`, `{ kind: 'http', ... }`, `{ kind: 'module', ... }`
- Encourages exhaustive pattern matching

## Async Patterns

**Async Functions:**

- `async function methodName(): Promise<ReturnType>`
- No callback-based APIs; all promise-based
- `await` used inline; no `.then()` chains

**Example:**

```typescript
export async function readData(file: string, kind: 'golden' | 'dialogues', options: { maxItems?: number } = {}) {
  if ((await stat(file)).size > 4_000_000) throw new Error('Файл импорта превышает 4 МБ.');
  const text = await readFile(file, 'utf8');
  // ...
}
```

## Null/Undefined Usage

**Patterns:**

- `null` for "searched but not found" results in data structures
- `undefined` for "optional parameter" or "not applicable"
- `value ?? fallback` for null/undefined checks
- Optional chaining: `scenario.initialState?.external`

---

*Convention analysis: 2026-09-16*

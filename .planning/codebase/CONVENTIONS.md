---
last_mapped_commit: e23488a2711c80e9333f603d5c28d06ca85395ee
last_mapped_at: 2026-09-15
---
# Coding Conventions

**Analysis Date:** 2026-09-15

## Naming Patterns

**Files:**

- Lowercase kebab-free names with one concept per module, for example `src/target-version.ts`, `src/judge-audit.ts`, and `src/prompt-edit.ts`.

**Functions:**

- Use camelCase verbs or verb phrases: `evaluateTrial`, `openExternalTarget`, `validateAssessments`, and `draftHash` in `src/evaluation.ts`, `src/targets.ts`, and `src/contracts.ts`.
- Keep small local helpers near their caller, such as `context`, `fixture`, and `targetRuntime` in `test/evaluation.test.ts`.

**Variables:**

- Use camelCase; prefer descriptive domain names (`scenario`, `trial`, `initialState`, `manifestHash`) over abbreviations. Use `const` by default and narrow mutable state to `let`.

**Types:**

- Use PascalCase for interfaces, type aliases, and classes (`AgentSpec`, `Scenario`, `Trial`, `ExperimentLab`). Use `*Schema` for Zod validators and uppercase names for constants (`TOOL_NAMES`, `REQUIREMENT_LIMIT`) in `src/contracts.ts`.

## Code Style

**Formatting:**

- TypeScript uses native ESM imports with explicit `.js` extensions, single quotes, semicolons, trailing commas where multiline, and compact arrow functions. Examples: `src/contracts.ts` and `src/evaluation.ts`.
- No repository Prettier configuration was detected. Preserve the existing compact one-line guard/helper style where it is already used.

**Linting:**

- No ESLint, Biome, or standalone lint configuration was detected. Type safety is enforced by `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`, `skipLibCheck`) and the `typecheck` script in `package.json`.

## Import Organization

**Order:**

1. Node built-ins (`node:crypto`, `node:fs/promises`, `node:test`)
2. Third-party packages (`zod`, Pi packages)
3. Relative project modules, generally with type-only imports grouped inline

**Path Aliases:**

- No path aliases were detected. Use relative imports such as `../src/contracts.js` in tests and `./contracts.js` in source.

## Error Handling

**Patterns:**

- Validate external/user-shaped data at boundaries with strict Zod schemas in `src/contracts.ts`, then throw actionable `Error` messages for domain/preflight failures in `src/targets.ts`, `src/experiment.ts`, and `src/pi.ts`.
- Convert unknown caught values safely with `error instanceof Error ? error.message : String(error)`; preserve abort/cancellation and persistence failures rather than turning them into a passing grade (`src/evaluation.ts`, `src/artifacts.ts`).
- Use `assert.rejects(..., /message/)` to specify expected failures in tests, especially `test/targets.test.ts` and `test/workflow.test.ts`.

## Logging

**Framework:** console and persisted evidence files; no logging library was detected.

**Patterns:**

- Keep user-facing diagnostics in returned/throwable errors. Use `t.diagnostic(...)` only for test evidence in `test/workflow.test.ts` and `test/quality.test.ts`; do not add noisy logging to library paths.

## Comments

**When to Comment:**

- Comment non-obvious contracts, invariants, security boundaries, and deliberate test fixtures. Examples include schema semantics in `src/contracts.ts`, mode behavior in `src/evaluation.ts`, and regression rationale in `test/workflow.test.ts`.

**JSDoc/TSDoc:**

- Use short block comments for exported constants/types and behavior that callers must know; inline comments explain a specific edge case. Avoid comments that merely restate a function name.

## Function Design

**Size:** Keep functions focused on one workflow step; larger orchestration belongs in named functions/classes such as `evaluateTrial` and `ExperimentLab` rather than anonymous nesting.

**Parameters:** Use typed object parameters for multi-field operations (`evaluateTrial`, runtime adapters) and explicit narrow unions from `src/contracts.ts`.

**Return Values:** Return typed domain objects or discriminated outcomes; use `undefined` only for optional lookups. Preserve immutable snapshots with `structuredClone` where traces/state cross boundaries.

## Module Design

**Exports:** Prefer named exports. Keep schemas, inferred types, and related helpers together in `src/contracts.ts`; domain modules export their primary operation plus narrowly useful helpers.

**Barrel Files:** No barrel/index module was detected. Import the owning module directly.

---

*Convention analysis: 2026-09-15*

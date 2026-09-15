---
last_mapped_commit: e23488a2711c80e9333f603d5c28d06ca85395ee
last_mapped_at: 2026-09-15
---
# Codebase Structure

**Analysis Date:** 2026-09-15

## Directory Layout

```text
lyon/
├── src/              # Core TypeScript library and CLI
├── extensions/       # Pi Agent Lab UI and editor integration
├── test/              # Unit/integration tests and fixtures
├── examples/         # Example agents, connections and suites
├── skills/           # Project-local Pi skill(s)
├── docs/             # Reference, workflow and design documentation
├── dist/             # TypeScript build output consumed by extension
├── .planning/        # GSD planning artifacts
├── package.json      # Scripts and dependencies
└── tsconfig.json     # NodeNext TypeScript build configuration
```

## Directory Purposes

**`src/`:** Core modules. Keep domain contracts in `src/contracts.ts`, orchestration in `src/experiment.ts`, adapters in `src/targets.ts`/`src/sandbox.ts`, and presentation-neutral reporting in `src/report.ts`.

**`extensions/`:** Host-specific Pi integration. `extensions/agent-lab.ts` wires the board; `extensions/cards.ts` renders state; `extensions/editor.ts` validates draft edits.

**`test/`:** Tests are colocated by module name, with reusable process fixtures under `test/fixtures/` and live/manual checks under `test/live/`.

**`examples/`:** User-facing JSON contracts and minimal target agents; add new integration examples here rather than in `src/`.

**`docs/`:** Product and technical references, including `docs/REFERENCE.md` and `docs/WORKFLOWS.md`.

**`.planning/codebase/`:** Generated mapper documents; do not place runtime code here.

## Key File Locations

**Entry Points:**

- `src/cli.ts`: executable CLI entry.
- `extensions/agent-lab.ts`: Pi extension entry.
- `src/experiment.ts`: library/application entry (`ExperimentLab`).

**Configuration:**

- `package.json`: scripts and dependency declarations.
- `tsconfig.json`: strict ES2023 NodeNext compilation to `dist/`.
- `.env*` files may exist for local configuration; values are not part of the codebase map.

**Core Logic:**

- `src/contracts.ts`: aggregate schemas and types.
- `src/experiment.ts`: workflow state machine.
- `src/evaluation.ts`: execution and grading.
- `src/targets.ts`: external target protocol adapters.

**Testing:**

- `test/*.test.ts`: module and workflow tests.
- `test/fixtures/stdio-agent.mjs`: JSONL command target fixture.

## Naming Conventions

**Files:** Lowercase kebab-free names with role suffixes, e.g. `target-version.ts`, `judge-audit.ts`, `*.test.ts`.

**Directories:** Lowercase semantic plural names (`src`, `extensions`, `examples`, `test`, `docs`).

**Symbols:** camelCase functions/variables, PascalCase classes/types, SCREAMING_SNAKE_CASE constants (`src/contracts.ts`, `src/experiment.ts`).

## Where to Add New Code

**New Feature:**

- Primary code: `src/` module matching the responsibility; expose orchestration through `src/experiment.ts`.
- Tests: `test/<module>.test.ts`.

**New Component/Module:**

- Implementation: `src/<role>.ts`; add host-specific rendering only under `extensions/`.

**Utilities:**

- Shared domain helpers belong in `src/contracts.ts` only when they are contract-wide; otherwise keep them beside their consumer.

**New target adapter:**

- Protocol/session implementation: `src/targets.ts` (and `src/module-worker.mjs` only for the worker boundary).
- Example contract: `examples/`.

## Special Directories

**`dist/`:** Generated TypeScript output. Generated: Yes. Committed/consumed by extension: inspect repository policy before changing; source edits belong in `src/`.

**`.planning/`:** GSD planning artifacts. Generated: Yes. Runtime code does not belong here.

**`.agent-lab/`:** Local experiment records and traces. Generated at runtime; treat as mutable local data, not source modules.

---

*Structure analysis: 2026-09-15*

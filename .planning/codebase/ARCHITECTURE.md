---
last_mapped_commit: e23488a2711c80e9333f603d5c28d06ca85395ee
last_mapped_at: 2026-09-15
---
<!-- refreshed: 2026-09-15 -->

# Architecture

**Analysis Date:** 2026-09-15

## System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│ Pi extension / CLI                                          │
│ `extensions/agent-lab.ts`, `src/cli.ts`                     │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Experiment orchestration                                    │
│ `src/experiment.ts` (phase machine, checkpoints, runs)      │
└───────────────┬──────────────────────┬──────────────────────┘
                ▼                      ▼
┌────────────────────────┐  ┌────────────────────────────────┐
│ Evaluation & grading    │  │ Target adapters / runtimes      │
│ `src/evaluation.ts`     │  │ `src/targets.ts`, `src/pi.ts`   │
│ `src/comparison.ts`     │  │ `src/sandbox.ts`                 │
└───────────────┬────────┘  └────────────────┬───────────────┘
                ▼                            ▼
┌─────────────────────────────────────────────────────────────┐
│ Persisted experiment records and trace journals              │
│ `src/store.ts`, artifacts in configured lab directory        │
└─────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| CLI/UI adapter | Exposes commands and Pi board actions | `src/cli.ts`, `extensions/agent-lab.ts` |
| ExperimentLab | Owns lifecycle, revisions, phase transitions, serialization checkpoints | `src/experiment.ts` |
| Contracts | Zod schemas, domain types, fingerprints and validation | `src/contracts.ts` |
| Target adapters | Connect sandbox, HTTP, module, or JSONL command agents | `src/targets.ts`, `src/module-worker.mjs` |
| Evaluator | Runs dialogues, applies checks, records events and assessments | `src/evaluation.ts` |
| Persistence | Atomic JSON records, locks and append-only trace/judgment journal | `src/store.ts` |
| Analysis/reporting | Outcomes, comparisons, quality summaries and exports | `src/outcomes.ts`, `src/comparison.ts`, `src/quality.ts`, `src/report.ts`, `src/artifacts.ts` |

## Pattern Overview

**Overall:** TypeScript modular orchestration service with a state-machine workflow and adapter ports.

**Key Characteristics:**

- `ExperimentLab` is the application service; `runSuite` is the single trial loop shared by evaluate/compare workflows (`src/experiment.ts`).
- Domain input/output is validated at boundaries with strict Zod schemas (`src/contracts.ts`).
- Target execution is polymorphic by discriminated `Target.kind`; sandbox tools are isolated from external adapters (`src/sandbox.ts`, `src/targets.ts`).
- Evidence is append-only and resumable; each phase transition is checkpointed to disk (`src/store.ts`, `src/experiment.ts`).

## Layers

**Presentation/Integration:**

- Purpose: CLI and Pi extension surface.
- Location: `src/cli.ts`, `extensions/`
- Depends on: `ExperimentLab`, contracts and reporting.

**Application orchestration:**

- Purpose: create, review, run, repeat and compare experiments.
- Location: `src/experiment.ts`
- Depends on: persistence, adapters, evaluation and runtime services.

**Domain/evaluation:**

- Purpose: schemas, scenario generation, simulation, grading, judging and comparisons.
- Location: `src/contracts.ts`, `src/evaluation.ts`, `src/simulator.ts`, `src/judge.ts`, `src/comparison.ts`
- Used by: orchestration and reports.

**Infrastructure/adapters:**

- Purpose: model runtime, target sessions, sandbox tools and filesystem storage.
- Location: `src/pi.ts`, `src/targets.ts`, `src/sandbox.ts`, `src/store.ts`

## Data Flow

### Primary Request Path

1. CLI or extension parses input and calls `ExperimentLab.create` (`src/cli.ts`, `src/experiment.ts:109`).
2. Target readiness and fingerprinting run before model-backed preparation (`src/targets.ts`, `src/target-version.ts`).
3. Requirements, agent revision and scenario cards are validated and checkpointed as `review` (`src/contracts.ts`, `src/experiment.ts`).
4. `runSuite` executes scenarios through a runtime and target session, collecting dialogue/tool trace events (`src/experiment.ts:491`, `src/evaluation.ts`).
5. Checks and model judgments become trial outcomes; summaries and reports consume the persisted evidence (`src/comparison.ts`, `src/report.ts`).

**State Management:** A single active local experiment is guarded by `ExperimentStore` lock plus `ExperimentLab.active`; records are immutable-by-workflow after execution, while repeats create a fresh child record (`src/store.ts`, `src/experiment.ts`).

## Key Abstractions

**Experiment:** Validated aggregate containing task, sources, scenarios, revisions, trials and reviews (`src/contracts.ts`).

**Runtime:** Model-facing interface used for preparation, simulation and judging; Pi-backed and demo implementations are selected in `src/experiment.ts` and `src/pi.ts`.

**TargetSession:** Per-dialogue adapter contract implemented by sandbox, HTTP, module and command targets (`src/contracts.ts`, `src/targets.ts`).

## Entry Points

**CLI:** `src/cli.ts` — command-line workflows for create, evaluate, compare, inspect and export.

**Pi extension:** `extensions/agent-lab.ts` — registers the interactive Agent Lab board and tools.

**Library:** `src/experiment.ts` — `ExperimentLab` is the main programmatic entry point.

## Architectural Constraints

- **Threading:** Node.js event loop; child processes are used for command targets and release hooks (`src/targets.ts`).
- **Global state:** One active experiment per `ExperimentLab`; filesystem lock serializes writers (`src/experiment.ts`, `src/store.ts`).
- **Circular imports:** Not detected in the inspected module graph.
- **Persistence:** JSON records and JSONL traces are the source of truth; writes use temporary files and rename (`src/store.ts`).

## Anti-Patterns

### Bypassing the orchestration service

**What happens:** Callers mutate records or execute target sessions outside `ExperimentLab`.
**Why it's wrong:** Phase guards, fingerprints and checkpoint evidence are skipped.
**Do this instead:** Route lifecycle changes through `ExperimentLab` methods in `src/experiment.ts`.

### Mixing target contracts

**What happens:** Treat external adapter-reported records/events as trusted sandbox state.
**Why it's wrong:** External state is only reported evidence and may be incomplete.
**Do this instead:** Keep sandbox state in `src/sandbox.ts`; use `externalReplySchema` and adapter labels in `src/targets.ts`.

## Error Handling

**Strategy:** Validate at boundaries, fail the current phase with a recorded error, preserve partial traces, and support interrupted recovery (`src/experiment.ts`, `src/store.ts`).

**Patterns:** Abort signals/timeouts for runs; strict schemas for records; atomic checkpoints and append-only journals.

## Cross-Cutting Concerns

**Logging:** Trial events and release output are persisted as evidence; user-facing diagnostics are produced by CLI/report modules.
**Validation:** Zod schemas in `src/contracts.ts` plus target preflight in `src/targets.ts`.
**Authentication:** HTTP header values are resolved from environment variable names at request time (`src/targets.ts`).

---

*Architecture analysis: 2026-09-15*

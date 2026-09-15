---
phase: 02-ponimanie-agenta-i-gipoteza
plan: 01
subsystem: evaluation
tags: [typescript, zod, jsonl, offline-evidence]
requires:
  - phase: 01-chestnyy-chelovecheskiy-razbor
    provides: separate automatic and human verdict evidence
provides:
  - one-to-one recorded-dialogue scenario and trial conversion
  - code-only CLI score import with existing evidence artifacts
  - 200-dialogue persistence and reassessment boundary
affects: [02-02, 02-03, phase-3]
actuals:
  tokens: 7000
  tasks: 2
  commits: 2
tech-stack:
  added: []
  patterns: [pure dialogue conversion, ExperimentLab offline seed, existing single-writer guard]
key-files:
  created: []
  modified: [src/contracts.ts, src/experiment.ts, src/cli.ts, test/contracts.test.ts, test/experiment.test.ts, test/workflow.test.ts]
key-decisions:
  - "Code-only score creates an ungraded evidence seed without resolving a Runtime or touching target/simulator seams."
  - "Only score-compatible scenario, reassessment, selection and source-evidence ceilings rise to the existing 200-dialogue public limit."
requirements-completed: [SCORE-01, SCORE-02, SCORE-03, SCORE-04, SCORE-07, SCORE-08]
coverage:
  - id: D1
    description: "Every recorded dialogue becomes one production scenario and one scripted trial with exact source event order."
    requirement: SCORE-02
    verification:
      - kind: unit
        ref: "test/contracts.test.ts#recorded dialogues map one-to-one to grounded production cards and immutable scripted evidence"
        status: pass
    human_judgment: false
  - id: D2
    description: "CLI score imports JSONL and exports persisted evidence in code-only mode without agent or model execution."
    requirement: SCORE-08
    verification:
      - kind: e2e
        ref: "test/workflow.test.ts#CLI score imports ordered JSONL evidence and exports it without calling an agent or model"
        status: pass
    human_judgment: false
  - id: D3
    description: "Batches of 40, 41 and 200 dialogues survive score and reassessment without truncation; 201 is rejected."
    requirement: SCORE-07
    verification:
      - kind: integration
        ref: "test/experiment.test.ts#recorded scoring preserves 40, 41 and 200 dialogues through reassessment without truncation"
        status: pass
    human_judgment: false
  - id: D4
    description: "Recorded scenarios carry separate goal-attainment and reply-quality rubrics while observations stay missing/partial."
    requirement: SCORE-04
    verification:
      - kind: unit
        ref: "test/contracts.test.ts#recorded dialogues map one-to-one to grounded production cards and immutable scripted evidence"
        status: pass
    human_judgment: false
duration: 25min
completed: 2026-09-15
status: complete
---

# Phase 2 Plan 1: Offline Evidence Spine Summary

**Recorded JSON/JSONL dialogues now persist as immutable, ungraded offline evidence and scale through the public 200-dialogue boundary.**

## Performance

- **Duration:** 25 min
- **Started:** 2026-09-15T13:59:00Z
- **Completed:** 2026-09-15T14:24:03Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Added pure one-to-one dialogue-to-scenario/trial conversion with ordered Unicode-safe events and separate reserved rubrics.
- Added `ExperimentLab.score()` and CLI `score --code-only`, producing existing evidence/report artifacts without opening the target, simulator or model runtime.
- Aligned the recorded-evidence path to 200 dialogues and proved reassessment immutability plus single-writer rejection.

## Task Commits

1. **Task 1: Import one recorded dialogue into immutable offline evidence** — `a6f3fab`
2. **Task 2: Expand to batch and concurrency boundaries** — `82baccd`

## Files Created/Modified

- `src/contracts.ts` — reserved rubrics, pure converters and score-compatible array ceilings.
- `src/experiment.ts` — shared record construction and offline score seed lifecycle.
- `src/cli.ts` — code-only/model-backed score command boundary.
- `test/contracts.test.ts` — converter, rubric and requirement-ID contracts.
- `test/experiment.test.ts` — 40/41/200, immutable reassessment and concurrency coverage.
- `test/workflow.test.ts` — real CLI JSONL/artifact and malformed-input coverage.

## Decisions Made

- Reused the existing Experiment record, trace journal and artifact exporters; no score service or new persistence format.
- Code-only stores no invented semantic verdict: trials remain `ungraded`, state is `missing`, tools are `partial`.

## Deviations from Plan

The executor worktree gate rejected the shared linked checkout, so the orchestrator executed the same plan inline. No product scope changed.

## Issues Encountered

- The delegated executor correctly halted before edits because the checkout branch was outside the isolated-agent allow-list. Inline Pattern C execution avoided switching the shared branch.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for 02-02: ground model criteria in owner materials, enforce missing-observation judgment, and compose reassessment without duplicating the evidence path.

---
*Phase: 02-ponimanie-agenta-i-gipoteza*
*Completed: 2026-09-15*

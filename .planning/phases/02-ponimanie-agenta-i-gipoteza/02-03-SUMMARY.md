---
phase: 02-ponimanie-agenta-i-gipoteza
plan: 03
subsystem: evaluation
tags: [typescript, pi, offline-score, grounded-hypothesis]
requires:
  - phase: 02-ponimanie-agenta-i-gipoteza
    provides: grounded recorded-dialogue assessments and saved evidence
provides:
  - consented Pi score mode over recorded dialogues
  - shared evidence-grounded score brief for CLI and Pi
  - mandatory conversational hypothesis gate before test construction
affects: [phase-3, phase-4]
actuals:
  tokens: 14000
  tasks: 3
  commits: 3
tech-stack:
  added: []
  patterns: [native spending consent, pure evidence projection, conversation-only hypothesis gate]
key-files:
  created: [test/skill.test.ts]
  modified: [src/quality.ts, src/cli.ts, extensions/agent-lab.ts, skills/agent-builder/SKILL.md, test/quality.test.ts, test/workflow.test.ts, test/extension.test.ts]
key-decisions:
  - "Pi imports a zero-model evidence seed before optional model scoring so cancellation returns complete recorded facts without spending."
  - "scoreBrief is a pure projection over existing requirements, assessments, failure modes and cited events; no hypothesis record is persisted."
  - "Unsupported or broken evidence chains return the prescribed insufficient-data state instead of a best-effort hypothesis."
requirements-completed: [LOOP-01, LOOP-02, LOOP-03, SCORE-01, SCORE-05, SCORE-08]
coverage:
  - id: H1
    description: "Pi score imports recorded evidence without running the agent or simulator and requires native confirmation before model calls."
    requirement: SCORE-08
    verification:
      - kind: integration
        ref: "test/extension.test.ts#Pi score imports recorded evidence code-only and gates every model call with native consent"
        status: pass
    human_judgment: false
  - id: H2
    description: "One resolvable owner requirement, failed-or-unknown assessment and cited event produce one bounded hypothesis."
    requirement: LOOP-03
    verification:
      - kind: unit
        ref: "test/quality.test.ts#score brief publishes one bounded hypothesis only from a complete owner requirement and cited dialogue chain"
        status: pass
    human_judgment: false
  - id: H3
    description: "CLI and Pi use the same strict insufficient state when existing evidence cannot support a hypothesis."
    requirement: LOOP-01
    verification:
      - kind: e2e
        ref: "test/workflow.test.ts#CLI score imports ordered JSONL evidence and exports it without calling an agent or model"
        status: pass
      - kind: integration
        ref: "test/extension.test.ts#Pi score imports recorded evidence code-only and gates every model call with native consent"
        status: pass
    human_judgment: false
  - id: H4
    description: "Skill and injected Pi instructions stop before test construction until the owner answers one grounded hypothesis."
    requirement: LOOP-03
    verification:
      - kind: contract
        ref: "test/skill.test.ts#agent-builder stops at one grounded hypothesis until the owner answers"
        status: pass
      - kind: integration
        ref: "test/extension.test.ts#injected Pi instructions stop at one grounded hypothesis until the owner answers"
        status: pass
    human_judgment: false
duration: 40min
completed: 2026-09-15
status: complete
---

# Phase 2 Plan 3: Conversational Grounded Hypothesis Summary

**Recorded evidence now reaches the user as one traceable hypothesis, with explicit model-spending consent and a hard stop before test construction.**

## Performance

- **Duration:** 40 min
- **Completed:** 2026-09-15
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments

- Added `agent_lab_build mode=score` with JSON/JSONL validation, bounded progress, code-only operation and native Pi consent before any model call.
- Added one shared `scoreBrief` projection that resolves owner requirements, saved assessments and actual event citations, or returns an honest insufficient-data state.
- Aligned CLI, Pi system instructions and the agent-builder skill around one four-block hypothesis ending in `Проверим?`.

## Task Commits

1. **Task 1: Add Pi score mode with native spending consent** — `f7a1b80`
2. **Task 2: Share one evidence-grounded score brief between CLI and Pi** — `db04f27`
3. **Task 3: Gate test construction behind one conversational hypothesis** — `3f348f3`

## Decisions Made

- Reused `ExperimentLab.score`, immutable reassessment and the existing artifact exporters; no score service, screen or storage format was added.
- Kept terminal sanitization at CLI/Pi adapter boundaries while the pure projection retains existing evidence references.
- Treated owner confirmation as conversation context only; Phase 3 owns actual test construction and acceptance.

## Deviations from Plan

- A model-backed Pi score first creates the same code-only seed used by cancellation, then starts a separate grounded score after consent. This preserves imported facts and guarantees zero model calls on cancel.
- Added focused `test/quality.test.ts` and `test/skill.test.ts` coverage beyond the plan's initial file list so the pure projection and embedded protocol fail independently.

## Issues Encountered

None after the score adapter and shared brief were composed over the existing seams.

## User Setup Required

None.

## Next Phase Readiness

Ready for Phase 3: turn the accepted hypothesis into one editable test definition and save only an explicitly accepted test.

---
*Phase: 02-ponimanie-agenta-i-gipoteza*
*Completed: 2026-09-15*

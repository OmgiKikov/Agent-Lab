---
phase: 02-ponimanie-agenta-i-gipoteza
plan: 02
subsystem: evaluation
tags: [typescript, pi, grounded-evaluation, offline-score]
requires:
  - phase: 02-ponimanie-agenta-i-gipoteza
    provides: immutable recorded-dialogue evidence seed
provides:
  - owner-requirement-grounded criterion extraction per recorded dialogue
  - judge protocol 8 for unobserved action completion
  - saved-evidence reassessment and failure clustering
  - confirmed CLI model score composition with first-screen quality
affects: [02-03, phase-3]
actuals:
  tokens: 15000
  tasks: 3
  commits: 12
tech-stack:
  added: []
  patterns: [one-dialogue model boundary, saved-source reassessment, existing immutable writer guard]
key-files:
  created: []
  modified: [src/contracts.ts, src/prompts.ts, src/pi.ts, src/judge.ts, src/experiment.ts, src/cli.ts, test/pi.test.ts, test/judge.test.ts, test/experiment.test.ts, test/workflow.test.ts]
key-decisions:
  - "Score passes extracted owner requirements into Runtime.goals so returned requirement IDs are validated rather than guessed from raw sources."
  - "General create keeps grouped observed-goal extraction; strict one-goal-per-dialogue behavior activates only when owner requirements are supplied by score."
  - "Reassessment clusters only after copied traces are graded and uses a saved prompt source instead of a mutable live prompt."
requirements-completed: [LOOP-02, SCORE-04, SCORE-05, SCORE-06, SCORE-07, SCORE-08]
coverage:
  - id: G1
    description: "Each scored dialogue receives one source-and-user-only expectation request with known owner requirement IDs."
    requirement: SCORE-05
    verification:
      - kind: integration
        ref: "test/pi.test.ts#goal extraction sees owner sources and one dialogue user-side only"
        status: pass
    human_judgment: false
  - id: G2
    description: "Missing action evidence remains unclear while reply quality stays independently assessable."
    requirement: SCORE-06
    verification:
      - kind: unit
        ref: "test/judge.test.ts#missing action evidence cannot be replaced by agent self-attestation while reply quality stays assessable"
        status: pass
    human_judgment: false
  - id: G3
    description: "Model-backed score regrades copied traces and rebuilds failure clusters from saved sources without target or simulator calls."
    requirement: SCORE-07
    verification:
      - kind: integration
        ref: "test/experiment.test.ts#model-backed recorded scoring grounds criteria, regrades copied traces and rebuilds clusters from saved sources"
        status: pass
    human_judgment: false
  - id: G4
    description: "CLI code-only scoring exposes quality and artifacts, requires consent for model mode, and uses exit code 2 for score failures."
    requirement: SCORE-08
    verification:
      - kind: e2e
        ref: "test/workflow.test.ts#CLI score imports ordered JSONL evidence and exports it without calling an agent or model"
        status: pass
    human_judgment: false
duration: 35min
completed: 2026-09-15
status: complete
---

# Phase 2 Plan 2: Grounded Offline Assessment Summary

**Recorded dialogues now produce owner-grounded criteria, protocol-8 judgments and reproducible failure clusters without rerunning the agent.**

## Performance

- **Duration:** 35 min
- **Completed:** 2026-09-15
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments

- Isolated one scored dialogue per Pi request and excluded assistant replies and logged outcomes from expectation inputs.
- Added explicit unobserved-action scope to judge protocol 8 while retaining independent reply-quality assessment and two-vote audit.
- Composed score seed, immutable reassessment, saved-source failure naming, quality summary and existing artifact export in the CLI.

## Task Commits

1. **Task 1: Ground each dialogue criterion in owner sources and user turns only** — `459d06c`
2. **Task 2: Make unobserved action completion explicitly unclear under judge protocol 8** — `405ccaa`
3. **Task 3: Reassess and cluster saved score evidence, then expose the confirmed CLI path** — `a7fa3e4`

## Review Follow-ups

- `01a1bd3` — reserve the confirmed call budget and keep cost/output claims truthful.
- `5f1a4b3` — deterministically reject self-attested action success unless a passed state predicate or an explicitly successful linked tool result supports it; stale unsafe receipts no longer count as complete.
- `18480f8` — keep every unsupported action verdict unknown and bind published hypotheses only to the requirement-backed goal rubric.
- `088c654` — preserve exact message whitespace while rejecting blank dialogue content.
- `5a4873e` — retain every event from long production dialogues without fabricating an impossible runnable script.
- `05b1cec` — require all declared state effects for action success and invalidate stale judge prompt/config receipts.
- `02f35e2` — allow prompt-rule failures to drive a hypothesis only when the authoritative source is the agent prompt.
- `70dcb63` — reject forbidden zero-count tool calls as success evidence and make all score-input errors recoverable and line-safe.
- `87a1056` — add the versioned 12-case evaluation corpus and its zero-model end-to-end evidence gate.

## Decisions Made

- Extended the existing Runtime goal input with optional extracted requirements; this is the smallest way to validate model-returned requirement IDs.
- Kept general observed-goal grouping for ordinary create and enabled strict one-to-one extraction only for score.
- Treated zero model calls as known zero cost; missing model price metadata remains `null` and is rendered as unknown.

## Deviations from Plan

- `src/contracts.ts` changed to carry known requirements through the existing Runtime port; without this, grounding IDs would be unverifiable.
- The fixed reply-quality pass criterion now requires a next step only when one is needed, avoiding an invented style policy for simple answers.

## Issues Encountered

None after the grounding contract was corrected.

## User Setup Required

None.

## Next Phase Readiness

Ready for 02-03: align the conversational hypothesis surface across the skill, Pi extension and compact result projections.

## Self-Check

- All ten listed implementation/test files exist.
- Task and review commits exist in history.
- Final phase gate: `304/304` tests and strict typecheck passed on 2026-09-15.

---
*Phase: 02-ponimanie-agenta-i-gipoteza*
*Completed: 2026-09-15*

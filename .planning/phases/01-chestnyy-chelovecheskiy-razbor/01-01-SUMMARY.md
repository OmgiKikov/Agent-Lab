---
phase: 01-chestnyy-chelovecheskiy-razbor
plan: 01
subsystem: evaluation
tags: [typescript, human-review, outcomes, quality]

requires: []
provides:
  - "Human metric verdicts override automatic agent rubric results without mutating evidence"
  - "Quality metric rows use the same latest human verdict as card outcomes"
affects: [review, comparison, reporting, workflow-control]

actuals:
  tokens: 3808
  tasks: 2
  commits: 4
plan_head_before: 904c03504c7d0aad0c968de02663d3314bdcd22c

tech-stack:
  added: []
  patterns:
    - "One latestHumanReviews index is the authority for every persisted review target"

key-files:
  created:
    - test/outcomes.test.ts
  modified:
    - src/outcomes.ts
    - src/quality.ts
    - src/comparison.ts
    - src/experiment.ts
    - test/quality.test.ts

key-decisions:
  - "The latest metric review is authoritative: invalid removes the occurrence, pass/fail replace the judge, and unknown remains unknown."
  - "Existing callers without an Experiment keep the optional reviews default; record-owning callers pass persisted humanReviews explicitly."

patterns-established:
  - "Derived outcomes never rewrite trials, checks, or model assessments."

requirements-completed: [HREV-01]

coverage:
  - id: D1
    description: "The latest human verdict controls a criterion across shared automatic outcomes while saved evidence remains immutable."
    requirement: HREV-01
    verification:
      - kind: unit
        ref: "test/outcomes.test.ts#the latest human criterion verdict is authoritative without rewriting automatic evidence"
        status: pass
    human_judgment: false
  - id: D2
    description: "First-screen metric rows apply pass, fail, unknown, and invalid with trial and metric isolation."
    requirement: HREV-01
    verification:
      - kind: unit
        ref: "test/quality.test.ts#metric rows use the same human criterion verdict as card outcomes"
        status: pass
    human_judgment: false
  - id: D3
    description: "Record-owned summary, comparison, and workflow decisions consume persisted reviews through the shared helper."
    requirement: HREV-01
    verification:
      - kind: integration
        ref: "npx tsx --test test/outcomes.test.ts test/quality.test.ts test/comparison.test.ts && npx tsc --noEmit -p tsconfig.json"
        status: pass
    human_judgment: false

duration: 5min
completed: 2026-09-15
status: complete
---

# Phase 1 Plan 1: Authoritative Human Criterion Verdict Summary

**The latest human criterion verdict now drives card outcomes, metric rows, comparisons, and workflow decisions from one immutable-evidence rule.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-09-15T11:21:46Z
- **Completed:** 2026-09-15T11:26:46Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Added the full D-01 matrix: invalid removes, pass/fail replace, unknown stays unknown, latest wins, and unrelated reviews are isolated.
- Wired persisted reviews through automatic outcomes, summaries, comparisons, and workflow decisions without mutating stored evidence.
- Made first-screen metric denominators and verdict counts follow the same criterion rule while preserving metric fingerprints.

## Task Commits

1. **Task 1 RED:** `e2f28ba` (test)
2. **Task 1 GREEN:** `8306ba5` (feat)
3. **Task 2 RED:** `24759ef` (test)
4. **Task 2 GREEN:** `f48cee0` (feat)

## Files Created/Modified

- `test/outcomes.test.ts` - Human verdict precedence, latest-wins, isolation, and evidence immutability.
- `src/outcomes.ts` - Review-aware rubric, failure, and automatic result helpers.
- `src/quality.ts` - Review-aware unknown queue and metric row aggregation.
- `src/comparison.ts` - Persisted reviews passed through record-owned verdict paths.
- `src/experiment.ts` - Workflow decision uses the record's persisted reviews.
- `test/quality.test.ts` - Metric row regression matrix.

## Decisions Made

- Reused `latestHumanReviews`; no second review index or result model was added.
- Kept the reviews argument optional for callers that genuinely do not own an Experiment record.

## TDD Gate Compliance

- RED evidence for both tasks was classified `RED_EVIDENCE_OK` before production edits.
- Commit order is RED → GREEN for each task; no refactor commit was needed.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 01-02 can build full-dialogue review counting and the single-dialogue review form on this shared verdict rule.

---
*Phase: 01-chestnyy-chelovecheskiy-razbor*
*Completed: 2026-09-15*

## Self-Check: PASSED

- All six planned source and test files exist.
- All four task commits are present in git history.
- Coverage metadata classifies all three delivery truths as automatically passed.

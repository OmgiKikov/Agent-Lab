---
phase: 01-odno-chestnoe-chislo
plan: 03
subsystem: comparison
status: complete
tags: [comparison, identity, goal-observation, validate-build]

requires:
  - phase: 01-01
    provides: "ResultView, snap-test.sh, verify-stored-runs.mjs"
provides:
  - "src/normalize.ts: goalObservationDefault, withDefaultGoalObservation, normalizeScenarioIdentity"
  - "src/contracts.ts: DEFAULT_GOAL_OBSERVATION"
  - "compareRuns: judge receipts checked on observableSources, per pair; reason «Судья не завершил оценку этой попытки.»"
  - "validate build: goal.id = dialogue.id; limitation «Модель выдала совпадающие id целей; каждой цели присвоен id её диалога.»"
affects: [01-08, 01-10, diff, repeat, validate]

plan_head_before: 505afebc809a6eb0df7558218a3bcbb65cd91e7e
actuals:
  tokens: 8600
  tasks: 3
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Normalization is applied to an in-memory copy for comparison identity only; stored records and schema parsing stay untouched"
    - "Judge completeness is checked with the same sources the judge saw (observableSources)"

key-files:
  created:
    - src/normalize.ts
    - test/normalize.test.ts
  modified:
    - src/contracts.ts
    - src/comparison.ts
    - src/experiment.ts
    - test/comparison.test.ts
    - test/judge.test.ts
    - test/experiment.test.ts

key-decisions:
  - "DEFAULT_GOAL_OBSERVATION lives in contracts.ts next to goalObservationSchema to avoid an import cycle with normalize.ts"
  - "judgeIdentities ignores trials with assessmentError; an incomplete judgment makes only its own pair incomparable, while mixed protocol or another judge model still blocks the whole diff"
  - "In validate replay the harness sets goal.id = dialogue.id right after extraction; a collision of the model's raw ids is recorded as a limitation"

requirements-completed: [TRUST-05, TRUST-06]

duration: 4min
completed: 2026-09-17
---

# Phase 01 Plan 03: Comparable repeats and collision-safe validation builds Summary

`diff` now checks judge receipts against the observable sources the judge actually saw, one pair at a time, and treats an external legacy card without `goalObservation` as the same card with `'reply'`; a validation build gives each goal its dialogue id, so colliding model ids no longer fail it.

## Performance

- **Duration:** about 4 min
- **Completed:** 2026-09-17
- **Tasks:** 3
- **Files modified:** 8 (2 created)

## Accomplishments

- D1 fixed: `verdictSummary` and `compareRuns` pass `observableSources(sources, requirements)` to `hasCompleteJudgment`. On stored run `fae4ee59`, the confidence reason codes are `rubric_only`, `simulator_flagged` and `no_human`, with no `judge_unaudited`. `diff fae4ee59 fae4ee59 --json` returns only `["Выбран один и тот же прогон."]`.
- The audit check now runs per pair: one trial with `assessmentError` makes only its own row incomparable, and the other pairs are still counted.
- Card identity in `compareRuns` uses `normalizeScenarioIdentity`. External agents ignore the default channel; sandbox cards and real field changes still produce «Содержимое карточек изменилось».
- The default channel is now defined in one place (`DEFAULT_GOAL_OBSERVATION`). All former literal default sites use the constant or the normalize helpers.
- Validate replay: card ids equal dialogue ids in input order, colliding model ids are recorded in the limitations, and a dialogue with no goal becomes an `unconfirmed` exclusion.

## Task Commits

1. **Task 1 (tracer): observable sources, per-pair audit, normalized identity** - `b3fa60b` (fix)
2. **Task 2: one default goal observation channel** - `3994643` (refactor)
3. **Task 3 RED: colliding goal id tests** - `6421353` (test)
4. **Task 3 GREEN: harness-assigned goal ids** - `1dfb8a0` (fix)

## TDD Gate Compliance

- RED `6421353`: 2 of the 3 new tests failed with `Observed goals have duplicate IDs` (phase `error`). The distinct-ids test passed already, as expected, because it covers behaviour that was already correct.
- GREEN `1dfb8a0`: `test/experiment.test.ts` 52/52.
- No refactor step was needed.

## Verification

- Task 1 snapshot (comparison, judge, normalize, quality, result-view): 85 pass, 0 fail. Live diff check exit 0.
- Task 2 snapshot (normalize, experiment, contracts, comparison): 98 pass, 0 fail.
- Task 3 snapshot (experiment): 52 pass, 0 fail.
- Full snapshot suite with typecheck: 358 pass, 0 fail, exit 0.

## Deviations from Plan

- **Task 1, per-pair branch:** the before and after audit checks share one `else if` with a single `JUDGE_INCOMPLETE` constant. The plan described two branches. The row reason is the same, and the grep count for the text is 1.
- **Task 1, test (d):** the plan asked to check the absence of notes. The test instead asserts that no note mentions the judge and that `comparable === true`. Post-pair notes such as «Сравнение по 1 карточкам…» are legitimate and stay.
- **Task 2:** `'reply'` literals remain in `src/experiment.ts` at 346 and 500 (comparisons) and at 639 (the `proposedGoalObservation` literal required by the discovery schema). None of them is a default, and none matches the acceptance regex.

**Total deviations:** 0 auto-fixes; only the minor structural choices above.

## Issues Encountered

None.

## Known Stubs

None.

## Next Phase Readiness

- Plan 01-08 can add `scoreSettings` to `src/normalize.ts`.
- Plan 01-10 still needs to confirm TRUST-05 live (a repeat of `fae4ee59`, then `diff`) and the collision fix on a real build.

## Self-Check: PASSED

- FOUND: src/normalize.ts, test/normalize.test.ts
- FOUND commits: b3fa60b, 3994643, 6421353, 1dfb8a0

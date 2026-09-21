---
phase: 01-odno-chestnoe-chislo
plan: 05
subsystem: result-view
status: complete
tags: [stability, repeat, reassess, result-view]

requires:
  - phase: 01-01
    provides: "goalCardOutcome, buildResultView, ResultView.cards[].unstable, snap-test.sh"
  - phase: 01-02
    provides: "EvidenceBundle.view"
  - phase: 01-03
    provides: "normalizeScenarioIdentity"
provides:
  - "src/comparison.ts: Stability, StabilityRow, stabilityBetweenRuns(before, after), stabilityAfterReassess(record, source)"
  - "src/result-view.ts: buildResultView(record, { before }), ResultView.stability, unstable card marks, lines «Нестабильных: …», «Стабильность не проверена: …», «  нестабильно: …»"
  - "src/artifacts.ts: exported embeddedBefore; bundle.view built with the resolved before"
  - "src/cli.ts: summary loads assessmentOf ?? parentRunId read-only with an embedded fallback"
affects: [01-06, 01-07, 01-09, 01-10]

plan_head_before: 3117605caa027c806e72fa7523dcca9d85a7f893
actuals:
  tokens: 7300
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Stability is found instability only: `checked` counts situations decided on both sides; a skipped check carries a Russian reason instead of a silent 0"
    - "Stability never changes the headline; unstable cards stay in N/M"

key-files:
  created: []
  modified:
    - src/comparison.ts
    - src/result-view.ts
    - src/cli.ts
    - src/artifacts.ts
    - test/comparison.test.ts
    - test/result-view.test.ts

key-decisions:
  - "A reassessment counts a card only when its record attempts are exactly the source attempts of that card (no foreign id, no source attempt left out), so partial reassessment never produces a flip"
  - "When a record is a reassessment of the given source, only stabilityAfterReassess is used; a null result (no evidenceHash) means no stability line at all"
  - "CLI summary swallows a failed source read and falls back to embeddedBefore; if neither exists, no stability line is printed"

requirements-completed: [TRUST-09]

duration: 5min
completed: 2026-09-17
---

# Phase 1 Plan 05: Stability from repeats and reassessments Summary

**Goal-verdict flips (pass↔fail) against the source run, gated on comparability, the same agent and the same judge, shown as «Нестабильных: N (повтор|переоценка прогона XXXXXXXX).» under the headline and as a per-card `unstable` mark, without touching N/M.**

## Performance

- Duration: about 5 min of execution
- Tasks: 2 (tracer + TDD)
- Files modified: 6

## Accomplishments

- `stabilityBetweenRuns`: gated on `compareRuns(before, after).comparable`, then on equal `targetFingerprint` and `targetVersion`; compares `goalCardOutcome` on shared cards; decided↔unknown is ignored.
- `stabilityAfterReassess`: null unless `assessmentOf === source.id` and `evidenceHash` is present; a different `evaluatorVersion` is reported as skipped; cards with changed criteria (normalized fingerprint), foreign trial ids or partial coverage are not counted. It does not call `compareRuns`.
- `ResultView.stability` plus the stability line after the small-sample line. With `details`, one `  нестабильно: … — было «…», стало «…»` line per flip. The CLI prints them through `safeLine`.
- The board gets the line through `bundle.view` (built with `bundle.before`) and `resultViewLines`.
- Tracer gate: the CLI test runs a stored source and its repeat through `dist/cli.js summary` and gets `Нестабильных: 1 (повтор прогона a1b2c3d4).` plus the detail line.

## Live check on stored data

- Stored reassessment `29dd5210` with the snapshot CLI prints **`Нестабильных: 0 (переоценка прогона 424d6cb1).`**. The JSON view shows `checked: 0`, `skipped: null` and 0 unstable cards. As RESEARCH expected, the source has no decided goal verdict, so the card is not compared. Neither the judge nor the criteria changed, so the line is a real 0, not a skipped check.

## Task Commits

1. **Task 1 (tracer): the repeat summary counts flipped situations**: `28b6cfa` (feat)
2. **Task 2 (TDD): the reassessment marks judge-verdict flips**: `11bb51a` (test, RED: 2 assertion failures in result-view.test.ts), `4904e4d` (feat, GREEN)

## Verification

- `snap-test.sh test/result-view.test.ts test/comparison.test.ts test/artifacts.test.ts test/cards.test.ts`: 76 passed, 0 failed (Task 1)
- `snap-test.sh --keep test/comparison.test.ts test/result-view.test.ts`: 57 passed, 0 failed, plus the 29dd5210 CLI line (Task 2)
- Full `snap-test.sh` (tsc, all tests, typecheck): 372 passed, 0 failed

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The Task 2 test fixture defaulted to several repeats**
- **Found during:** Task 2 GREEN
- **Issue:** `settingsSchema.parse({ userModes: ['reactive'] })` defaults `repeats` above 1. Every card had `attempts_mismatch`, so the function-level test saw 0 decided cards.
- **Fix:** the fixture sets `repeats: 1`. Test-only change; no code change.
- **Files modified:** test/comparison.test.ts
- **Commit:** 4904e4d

**2. [Scope note] Partial-coverage gate is two-sided**
- The plan's rule skipped a card only when a record trial id was missing from the source. The behavior list also requires skipping a card when only some of its trials were reassessed, so the gate also skips a card when one of its source attempts is missing from the record.

Otherwise the plan was executed as written.

## Known Stubs

None. The Pi board shows the stability line through `bundle.view`. A per-card «нестабильно» mark on board cards is not drawn yet. This plan's files do not include `extensions/cards.ts`, and 01-09 adds the control-card ` · нестабильно` suffix. The data is ready in `ResultView.cards[].unstable`.

## Threat Flags

None. The source run is read by an id from the record through `ExperimentStore.get` (identifier pattern). A failed read falls back only to the embedded source (T-01-15). Detail lines go through `safeLine` (T-01-16). Skipped checks are printed in words (T-01-17).

## Self-Check: PASSED

---
phase: 01-odno-chestnoe-chislo
plan: 11
subsystem: comparison, experiment
status: complete
tags: [positive-control, repeat, comparison, gap-closure]
requires: ["01-09", "01-10"]
provides:
  - "oneTurnControls(record) in repeat() and loadSuite()"
  - "compareRuns leaves out control situations (union of both runs) and names the exclusion"
affects: ["01-12"]
tech-stack:
  added: []
  patterns: ["draft-time card transformation limited to new drafts", "identity from the original records, comparison on stripped copies"]
key-files:
  created: []
  modified:
    - .planning/REQUIREMENTS.md
    - src/experiment.ts
    - src/comparison.ts
    - extensions/agent-lab.ts
    - test/experiment.test.ts
    - test/comparison.test.ts
    - test/result-view.test.ts
decisions:
  - "A positive control always runs as one turn (maxFollowUps 0, script [] only when a script exists), applied only in repeat and loadSuite; reassessment never changes cards"
  - "compareRuns strips control situations of either run after taking the rebuilt-source identity from the original records; the control note is pushed after the result so it never flips comparability"
  - "TRUST-04 stays unchecked until 01-12 shows a passing control on live evidence"
metrics:
  duration: "about 5 min"
  completed: 2026-09-17
estimate:
  tokens: 70000
  tasks: 2
actuals:
  tokens: 5600
  tasks: 2
  commits: 4
plan_head_before: 729430916fed6835f266ac1ca267f70677844221
---

# Phase 1 Plan 11: One-turn positive control and a control-free repeat diff Summary

A control situation now runs as one turn (the opening plus the agent's first reply, no simulator), so simulator drift can no longer leave the control unmeasured. The repeat diff leaves out control situations of either run and says so in a note. A rebuilt source with an edited counted card still counts as not comparable.

## What was done

- **Task 0 (orchestrator rule):** TRUST-04 is unchecked in REQUIREMENTS.md (`- [ ]`, traceability `Pending`). Commit `e19f436`.
- **Task 1 (tracer):** `oneTurnControls(record)` in `src/experiment.ts` sets `user.maxFollowUps = 0` on each control card, and sets `script: []` only when the card had a script. It runs in `repeat()` for explicit and inherited controls, followed by `retainAcceptedTests`, and in `loadSuite()` before `validatePreparation`. `compareRuns` in `src/comparison.ts` first computes `reconstructedIdentity(before, after)` from the original records. It then compares copies made by `withoutControls` (cards, trials, `selectedScenarioIds`, `assessmentTrialIds` and the marker removed) and pushes the note `Контрольные ситуации не сравниваются: они не входят в главное число.` after the result. Commit `7b2fb5e`.
- **Task 2:** added tests for the union of controls, a control added in the repeat, the selected-tests path, the same run, stability for a control that became one turn, and loading a suite with a multi-turn control. Also added the one-turn sentence to the `agent_lab_repeat` `controlScenarioIds` description. Commit `1355277`.

## Verification

- Task 1 verify (`snap-test.sh test/experiment.test.ts test/comparison.test.ts test/result-view.test.ts`): RED showed 2 failures. GREEN passed 129, failed 0. The tracer gate re-ran and passed.
- Task 2 verify (full `snap-test.sh`, all tests plus the extension typecheck): exit 0, 403 passed, 0 failed.
- Every Task 2 case passed as soon as it was written, because Task 1 already implemented the rules, as the plan expected. To check that they test something, I ran them in a scratch copy against the pre-plan `src/comparison.ts` and `src/experiment.ts` (from `e19f436`). All new cases failed there, including the one-turn stability case, which was skipped as «прогоны несравнимы» because the changed control card made the whole diff incomparable. The existing test for an identical flipped control still yields `Контроль: пройден ✓ · нестабильно`.
- All acceptance greps match. `src/judge.ts`, `src/contracts.ts` and `src/evaluation.ts` did not change. `VERSION` is still `'6'`. `draftHash`, `measurementHash` and `JUDGE_PROTOCOL` did not change. The test confirms that the stored source keeps its draftHash and that reassessment cards deep-equal the run's cards.
- `dist/` in the worktree was not touched; all tests ran from snapshots.

## Deviations from Plan

None. The plan was executed as written.

Note on `commits: 4`: the count is measured from `plan_head_before`. It includes `1574210 docs(03): create phase plan (7 plans)`, committed by a concurrent session between Task 1 and Task 2. This plan made three commits: `e19f436`, `7b2fb5e`, `1355277`.

## Expected follow-on effect

The recorded 01-10 diff counts for `fae4ee59 → 61521e0d` (8 unchanged, 5 incomparable) will change, because the control `ae812a24` is no longer a pair. 01-12 records the new counts.

## Known Stubs

None.

## Self-Check: PASSED

- FOUND: src/experiment.ts (`oneTurnControls`), src/comparison.ts (control note), extensions/agent-lab.ts (`runs as one turn`), .planning/REQUIREMENTS.md (`- [ ] **TRUST-04**`)
- FOUND commits: e19f436, 7b2fb5e, 1355277

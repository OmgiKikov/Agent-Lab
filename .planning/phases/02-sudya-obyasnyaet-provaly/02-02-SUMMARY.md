---
phase: 02-sudya-obyasnyaet-provaly
plan: 02
subsystem: counting
tags: [counting-rules, goal-v2, not-measured, measurement]
status: complete

requires:
  - phase: 02-sudya-obyasnyaet-provaly
    provides: "Trial.judgedBeforeSeq, JudgeReceipt.cutBefore, simulatorCut, JUDGE_PROTOCOL_V10 (02-01)"
provides:
  - "COUNTING_RULES goal-v2: a situation judged before the simulator cut is decided by its goal votes"
  - "judgedCut(trial) — the cut counts only when the receipt carries the same cutBefore"
  - "simulatorUsable / measurementUsable with { beforeSeq }; strict outcomes unchanged"
  - "C-50 stability wording after a judge change"
  - "measure-undecided.mjs — read-only before/after counter (ids, codes, numbers only)"
  - "«before» numbers in ~/agent-lab-evidence/phase-02/"
affects: [02-03 paid pilot (card selection, newest reassessment lookup), 02-04 reason words, result screens]

tech-stack:
  added: []
  patterns: ["versioned counting rule tied to a receipt witness", "read-only measurement script over dist/ with optional exports"]

key-files:
  created:
    - .planning/phases/02-sudya-obyasnyaet-provaly/measure-undecided.mjs
  modified:
    - src/outcomes.ts
    - src/comparison.ts
    - src/result-view.ts
    - test/outcomes.test.ts
    - test/comparison.test.ts
    - test/result-view.test.ts

key-decisions:
  - "goal-v2: under a verified cut, heuristic simulator checks at or after the cut are ignored and the fidelity rubric speaks only through a human verdict"
  - "A non-heuristic simulator check and any check without seq still block the goal verdict under a cut"
  - "measure-undecided.mjs accepts a unique id prefix for --id and --newest-assessment-of"

requirements-completed: [JUDGE-03]

duration: 15min
completed: 2026-09-17
plan_head_before: 909d3070a27a42a613100702da9002452e772351
actuals:
  tokens: 7846
  tasks: 2
  commits: 4
---

# Phase 2 Plan 02: goal-v2 counting and the «before» measurement Summary

Headline counting moves to `goal-v2`. A situation whose goal the v11 judge decided before the simulator deviated now counts, but only when the receipt confirms the cut. Old records count exactly as before. `measure-undecided.mjs` recorded the «before» shares: fae4ee59 4 of 13 not measured and a92fd6ae 7 of 15, with 3 and 5 trials where a cut is computable.

## Tasks

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Tracer: a situation judged before the cut enters the headline; records without a cut count as before | 9c43c01 | src/outcomes.ts, src/comparison.ts, src/result-view.ts, test/comparison.test.ts, test/result-view.test.ts |
| 2 | «Before» numbers measured on the stored runs, ids and counts only | e6390ee | test/outcomes.test.ts, measure-undecided.mjs |

`commits: 4` is measured from `plan_head_before`. Two of those commits came from parallel planning sessions and are not part of this plan: 4d06a0f (docs 06) and e9426fa (docs 04). This plan made 2 commits.

## What changed

- `judgedCut(trial)` in `src/outcomes.ts` returns `judgedBeforeSeq` only when it equals `judgeReceipt.cutBefore`.
- `simulatorUsable` and `measurementUsable` take `{ beforeSeq }`:
  - a heuristic check with `seq >= beforeSeq` is ignored;
  - the fidelity rubric is skipped unless a person reviewed it.
- `automaticTrialResult`, `isAgentFailure` and `trialAssessmentComplete` still call without options, so they stay strict.
- In `src/comparison.ts`:
  - `goalCardOutcome` passes `{ beforeSeq: judgedCut(trial) }`;
  - `trialReasons` applies the same rule, so a situation decided under a cut gets no fidelity reason;
  - `stabilityAfterReassess` now skips with the text `не с чем сравнить: судья с тех пор изменился`.
- `COUNTING_RULES = 'goal-v2'`.

## Tracer gate

The mode is interactive and `human_verify_mode` is `end-of-phase`, and the `<verify>` step is fully automated. I re-ran it: 126 passed, 0 failed. Task 2 went ahead without a checkpoint.

## «Before» measurements (ids, codes and numbers only)

`~/agent-lab-evidence/phase-02/before.txt` comes from the worktree `dist/`, which is the phase-1 build. That build has no `simulatorCut` and no `JUDGE_PROTOCOL_V10`, so `v11` and `cutEligible` print `-`.

```
fae4ee59 cards=13 passed=0 decided=9 notMeasured=4 share=31% reasons=simulator_deviated:2,simulator_unclear:1,judge_split:1 judged=13 v10=13 v11=- cuts=0 cutEligible=-
a92fd6ae cards=15 passed=1 decided=8 notMeasured=7 share=47% reasons=simulator_deviated:4,agent_error:1,simulator_unclear:1,judge_split:1 judged=14 v10=14 v11=- cuts=0 cutEligible=-
61521e0d cards=13 passed=0 decided=10 notMeasured=2 share=15% reasons=simulator_deviated:1,simulator_unclear:1 judged=13 v10=13 v11=- cuts=0 cutEligible=-
9d587362 cards=13 passed=0 decided=8 notMeasured=5 share=38% reasons=simulator_deviated:3,simulator_unclear:1,judge_split:1 judged=13 v10=13 v11=- cuts=0 cutEligible=-
```

The last two lines are the phase-1 records named in 01-10-SUMMARY: 61521e0d is the live repeat of fae4ee59, and 9d587362 is its reassessment.

`~/agent-lab-evidence/phase-02/before-v11code.txt` comes from a snapshot dist of this plan's code:

```
fae4ee59 cards=13 passed=0 decided=9 notMeasured=4 share=31% reasons=simulator_deviated:2,simulator_unclear:1,judge_split:1 judged=13 v10=13 v11=0 cuts=0 cutEligible=3
a92fd6ae cards=15 passed=1 decided=8 notMeasured=7 share=47% reasons=simulator_deviated:4,agent_error:1,simulator_unclear:1,judge_split:1 judged=14 v10=14 v11=0 cuts=0 cutEligible=5
```

The plan's verify step printed `matched=2`, so the expected cutEligible values held (3 and 5). The directory has mode 700 and both files have mode 600.

Other script checks:
- `--cards c3de4f31 --print-trials` on fae4ee59 prints exactly one `trial=` line.
- The 7 RESEARCH card prefixes across both runs give 12 trial lines.
- `--newest-assessment-of fae4ee59 --since 2026-01-01T00:00:00Z` prints 9d587362 and exits 0.

The measurement is unchanged on the code of this plan. Stored records have no `judgedBeforeSeq`, so goal-v2 leaves their counts exactly as goal-v1 had them.

## Deviations from Plan

**1. [Rule 2 - Missing test] Non-heuristic check under a cut.** The plan's behavior list leaves this case out. I added an assertion that a non-heuristic simulator check still blocks the goal verdict under a cut, because only heuristic checks may be ignored. Commit e6390ee.

**2. [Rule 3 - Usability] `--id` accepts a unique prefix.** `--newest-assessment-of` does too. Full ids still work, and an ambiguous or missing prefix exits 2 (`MISSING <id8>`). Commit e6390ee.

Nothing else deviated from the plan.

## Known Stubs

None.

## Threat Flags

None. The script is read-only, and its output holds ids, reason codes and numbers only. T-02-05 is covered by the `judgedCut` receipt check and its tests. T-02-06 is covered by the output limits and the 0700/0600 permissions.

## Self-Check: PASSED

- FOUND: src/outcomes.ts `export function judgedCut`
- FOUND: src/comparison.ts `beforeSeq: judgedCut(trial)` and the C-50 text
- FOUND: src/result-view.ts `COUNTING_RULES = 'goal-v2'`
- FOUND: .planning/phases/02-sudya-obyasnyaet-provaly/measure-undecided.mjs (tracked)
- FOUND: commits 9c43c01, e6390ee
- FOUND: ~/agent-lab-evidence/phase-02/before.txt and before-v11code.txt (mode 600, directory 700)

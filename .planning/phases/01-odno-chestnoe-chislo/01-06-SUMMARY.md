---
phase: 01-odno-chestnoe-chislo
plan: 06
subsystem: judge-storage
status: complete
tags: [judge-audit, sidecar, journal, reassess]

requires:
  - phase: 01-03
    provides: "normalizeScenarioIdentity, reassessment on normalized cards"
  - phase: 01-04
    provides: "JudgeReceipt, sealJudgeReceipt, hasCompleteJudgment receipt path, store.writeJudgeAudit/readJudgeAudit/appendJudgment, onJudgment final flag"
provides:
  - "src/evaluation.ts: assessTrial seals trial.judgeReceipt from the latest audit and never sets trial.judgeAudit; evaluateTrial forwards the final flag"
  - "src/experiment.ts: launch ctx onJudgment(trialId, audit, final) writes the sidecar on every report and the journal only on the final one; reassess deletes judgeReceipt"
affects: [01-07, 01-09, 01-10]

plan_head_before: b3a91d4f5d0fbd2aa67a1352e2164baa84152cd7
actuals:
  tokens: 4200
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Full judge audit only in `{runId}.judge/{trialId}.json`; the trial keeps a sealed receipt"
    - "Journal gets exactly one judgeAudit line per finished judgment"

key-files:
  created: []
  modified:
    - src/evaluation.ts
    - src/experiment.ts
    - test/evaluation.test.ts
    - test/experiment.test.ts

key-decisions:
  - "Receipt completeness is computed at seal time with the full-audit path of hasCompleteJudgment over observable sources and the mapped assessments"
  - "A rejected judgment leaves no receipt: assessTrial throws before sealing, the sidecar and the final journal line keep the raw replies"

requirements-completed: [TRUST-08]

duration: 5min
completed: 2026-09-17
---

# Phase 01 Plan 06: Judge receipts and sidecar audits in every judging path Summary

Every judging path (live run, reassessment, discovery deep check) now stores the full judge audit in `{runId}.judge/{trialId}.json`. The trial keeps only a sealed `judgeReceipt`. The journal gets one `judgeAudit` line per finished judgment. Records whose trials still carry the old full `judgeAudit` reassess without migration.

## Performance

- **Duration:** about 5 min
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- `assessTrial` keeps the latest audit locally and seals `judgeReceipt` from it. The receipt of a successful judgment passes `hasCompleteJudgment` with observable sources.
- The launch context writes the sidecar on every partial report and appends to the journal only when `final` is true.
- `reassess` removes both `judgeAudit` and `judgeReceipt` from the cloned trial before judging again.
- Tests cover these cases:
  - reassessing a scored record;
  - a live evaluation that passes;
  - a live evaluation whose judge returns malformed JSON twice;
  - reassessing an old record that has full audits.

## Task Commits

1. **Task 1 (tracer): receipts, sidecars, one journal line per judgment**: `91837b1` (feat)
2. **Task 2: live, rejected and legacy judgments**: `8cc573f` (test)

## Files Created/Modified

- `src/evaluation.ts`: `assessTrial` seals the receipt; the persistence guard forwards `final`.
- `src/experiment.ts`: new sidecar and journal behaviour in the launch context; `reassess` clears the receipt.
- `test/experiment.test.ts`: helpers `agreeingJudgeRuntime`, `scoredAndReassessed` and `assertReceiptOnly`. Two new tests: a tracer test and a test for old records with full audits.
- `test/evaluation.test.ts`: a test that `final` is reported once and that a successful judgment gets a receipt while a rejected one does not.

## Decisions Made

- To check completeness at seal time, the code passes `{ ...trial, judgeAudit: latest, assessments: mapped }` to `hasCompleteJudgment`. The check therefore uses the full audit, and the receipt stores the result.
- The old-record test builds its source from the tracer record. It reads each sidecar back onto the trial as `judgeAudit`, drops the receipt, saves the copy under a new UUID and then reassesses it.

## Deviations from Plan

None. The plan ran as written. Task 2 (`tdd="true"`) needed no source changes because Task 1 already provided the behaviour. RED evidence: all three new tests fail against the source from before Task 1 (`HEAD~1` copied into a snapshot: `# fail 3`) and pass after it.

## TDD Gate Compliance

- RED: the new tests were run against the old `src/evaluation.ts` and `src/experiment.ts` in a snapshot, and all 3 failed.
- GREEN: `snap-test.sh test/evaluation.test.ts test/experiment.test.ts` gives `# fail 0`. The full snapshot suite gives `# pass 375, # fail 0`, and typecheck is clean.
- REFACTOR: none needed.

## Issues Encountered

None.

## Deferred / Follow-ups

- `src/comparison.ts:590,712` and `src/report.ts:89,244` still read `trial.judgeAudit`. For new records with receipts only, three things follow:
  - the judge model falls back to the run settings;
  - the judge identity in the comparison is `unrecorded` on both sides;
  - the report omits the judge details block.

  These files belong to 01-07, which the plan's flagged assumptions already mention, so they were not changed here.
- `sourceEvidence` in a reassessment still copies old trials with their full audits until 01-07 removes them.

## Threat Flags

None. All new writes go through `ExperimentStore` (files 0600, folder 0700), as the threat model requires.

## Next Phase Readiness

- 01-07 can switch the report and comparison to receipts plus `readJudgeAudit`.
- 01-10 can measure record and journal sizes on the live agent.

## Self-Check: PASSED

- FOUND: src/evaluation.ts, src/experiment.ts, test/evaluation.test.ts, test/experiment.test.ts
- FOUND: 91837b1, 8cc573f

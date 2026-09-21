---
phase: 01-odno-chestnoe-chislo
plan: 04
subsystem: judge-storage
status: complete
tags: [judge-audit, sidecar, receipt, storage]

requires:
  - phase: 01-01
    provides: "snap-test.sh"
  - phase: 01-03
    provides: "hasCompleteJudgment checked on observableSources"
provides:
  - "src/contracts.ts: judgeReceiptSchema, JudgeReceipt, Trial.judgeReceipt (optional), CallContext.onJudgment(trialId, audit, final?)"
  - "src/judge.ts: sealJudgeReceipt(audit, complete); receipt branch in hasCompleteJudgment; assessRepeated reports exactly one final judgment"
  - "src/store.ts: writeJudgeAudit(id, trialId, audit) → {id}.judge/{trialId}.json (0700/0600, atomic, writer-only); readJudgeAudit(id, trialId) (lock-free, null if missing, 20 MB limit)"
affects: [01-06, 01-07, 01-10]

plan_head_before: a89eaa8e61cd44c44319c8bed6bc1ce8df6253e2
actuals:
  tokens: 6600
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "A receipt is never trusted on its own: the verifier re-derives the input hash from the record and re-aggregates the votes against the recorded assessments"
    - "A trial that still has the full judgeAudit is always checked by the full-audit path, even if a receipt is also present"
    - "Sidecar writes are synchronous (temp file + rename) because onJudgment is synchronous"

key-files:
  created: []
  modified:
    - src/contracts.ts
    - src/judge.ts
    - src/store.ts
    - test/judge.test.ts
    - test/store.test.ts

key-decisions:
  - "The receipt path also requires receipt.notApplicable to equal the rubrics that do not apply to the record, so the receipt cannot hide which rubrics were skipped"
  - "If the final save fails, assessRepeated still throws the original error first; if the judgment itself succeeded, the save error is thrown so a lost final audit is never a silent success"
  - "Vote aggregation (unanimous or unknown) is one helper, recordedAggregate, used by both the full-audit path and the receipt path"

requirements-completed: [TRUST-08]

duration: 4min
completed: 2026-09-17
---

# Phase 01 Plan 04: Judge audit sidecar and receipt Summary

**The full judge audit can now go to a private file `{runId}.judge/{trialId}.json`, and the trial keeps a small receipt with hashes and votes. The check re-derives the receipt from the record, so editing the record makes it fail. Old records that carry the full `judgeAudit` are checked exactly as before.**

## Performance

- **Duration:** about 4 min (measured with the wall clock)
- **Completed:** 2026-09-17
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- `judgeReceiptSchema` and an optional `Trial.judgeReceipt`. `VERSION` stays '6'. `JUDGE_PROTOCOL` is unchanged: the snapshot value matches the value in the worktree `dist/judge.js`, `32c413cf…5736`.
- `sealJudgeReceipt(audit, complete)` builds a receipt from an audit. It handles both per-rubric attempts and legacy attempts. A legacy attempt that failed forces `complete: false`.
- `hasCompleteJudgment` has a new receipt branch. It returns false in these cases: the receipt is incomplete, there is an `assessmentError`, a vote has an error, the protocol does not match, the input hash does not match the current record, the not-applicable list does not match, the vote count is wrong, or the votes do not aggregate to the recorded assessments.
- `assessRepeated` calls `onJudgment(..., true)` exactly once per call, whether it succeeds, gets a rejected response or hits a thrown failure. A zero-rubric call reports nothing, as before.
- `ExperimentStore.writeJudgeAudit` and `readJudgeAudit` are the sidecar store methods. They check both ids before building any path and validate the audit with `judgeAuditSchema` on write and on read.

## Task Commits

1. **Task 1 (tracer): sidecar, receipt, verifier, final signal** - `99f1612` (feat)
2. **Task 2: tamper, store-safety and final-signal tests** - `15d8024` (test)

## Files Created/Modified
- `src/contracts.ts` - receipt schema and type, the `Trial` / `trialSchema` field, and the `final` argument of `onJudgment`
- `src/judge.ts` - `sealJudgeReceipt`, `hasCompleteReceipt`, a shared `recordedAggregate`, and the final save in `assessRepeated`
- `src/store.ts` - `writeJudgeAudit`, `readJudgeAudit`, and the private `judgeAuditPath`
- `test/judge.test.ts` - an end-to-end storage test, a receipt tamper test (10 false cases, split votes, audit beside a receipt, legacy receipts) and a final-signal test
- `test/store.test.ts` - file modes 0700/0600, atomic replace, no leftover temp file, reading without the lock, the writer-only rule, unsafe ids, the 20 MB limit and schema rejection

## Decisions Made
See key-decisions in the frontmatter above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing check] The receipt must match the not-applicable list**
- **Found during:** Task 1
- **Issue:** The plan's receipt checks never compared `receipt.notApplicable` with the record.
- **Fix:** Added a check that `receipt.notApplicable` equals the rubrics that do not apply to the record. Task 2 pins it with an eleventh tamper case.
- **Files modified:** src/judge.ts, test/judge.test.ts
- **Commit:** 99f1612, 15d8024

**2. [Rule 2 - Missing check] A lost final save on success is reported**
- **Found during:** Task 1
- **Issue:** The plan's order of errors ended with the save error; this pins down what happens when the judgment succeeds but the final save fails.
- **Fix:** On success the save error is thrown, so it is never swallowed. The test covers this case.
- **Commit:** 99f1612, 15d8024

The tracer task (Task 1) came before Task 2, so Task 2's tests went green on the first run. They exposed no gap, so Task 2 made no source changes.

## Issues Encountered
None. Each task's snapshot run passed: `# fail 0`. The full snapshot suite passed too, with 363/363 tests and typecheck, exit 0. The worktree `dist/` was not touched.

## Known Stubs
None. Nothing calls the store methods or the `final` signal yet. Plan 01-06 connects them to the experiment flow, and plan 01-07 changes the reports. This is how the plan was scoped.

## Next Phase Readiness
- 01-06 can call `onJudgment(id, audit, final)` to write the sidecar and append to the journal, and it can set `trial.judgeReceipt = sealJudgeReceipt(audit, legacyComplete)` in `evaluation.ts`.
- `dist/` must be rebuilt from a snapshot before new records with `judgeReceipt` are written. An old `dist/` rejects the unknown key because `trialSchema` is a strictObject (01-10).

## Self-Check: PASSED
- FOUND: src/contracts.ts, src/judge.ts, src/store.ts, test/judge.test.ts, test/store.test.ts
- FOUND: 99f1612, 15d8024

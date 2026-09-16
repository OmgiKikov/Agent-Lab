---
phase: 01-odno-chestnoe-chislo
plan: 07
subsystem: reports
status: complete
tags: [reports, judge-audit, receipts, export-size]

requires:
  - phase: 01-04
    provides: "JudgeReceipt, sealJudgeReceipt, hasCompleteJudgment receipt path, observableSources"
  - phase: 01-05
    provides: "embeddedBefore export, stabilityAfterReassess"
  - phase: 01-06
    provides: "live, reassess and discovery paths store receipts and sidecar audits"
provides:
  - "src/report.ts: jsonReport emits traceJournal { file, bytes }; HTML/Markdown judge lines from judgeAudit ?? judgeReceipt, no serialized audit; HTML sourceEvidence dump without audits"
  - "src/comparison.ts: judge identity and judgeModel read receipts"
  - "src/connection.ts: suiteEvidence seals legacy audits into receipts and drops judgeAudit"
affects: [01-08, 01-09, 01-10, 05]

plan_head_before: e39c9f1d2c7d030f8680923fd6e24c490aa92391
actuals:
  tokens: 7100
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Reports name heavy evidence by file (`<runId>.trace.jsonl`, `<runId>.judge/<trialId>.json`) instead of embedding it"
    - "Judge identity = { protocolHash, provider, model } from whichever of audit or receipt the trial has"

key-files:
  created: []
  modified:
    - src/comparison.ts
    - src/report.ts
    - src/connection.ts
    - test/artifacts.test.ts
    - test/comparison.test.ts

key-decisions:
  - "suiteEvidence computes receipt completeness with the full legacy verifier at copy time; a trial whose card is missing gets complete: false"
  - "The JSON export keeps the whole record under `experiment`; legacy runs still carry their audits there, new runs carry none"
  - "The HTML judge block for a legacy trial says the raw replies are in the JSON snapshot; for a receipt trial it names the sidecar file"

requirements-completed: [TRUST-08, TRUST-05]

duration: 12min
completed: 2026-09-17
---

# Phase 01 Plan 07: Reports and saved evidence use receipts Summary

Reports no longer embed the heavy judge audit or the trace journal. The JSON export gives only the journal's file name and size. HTML and Markdown show the judge's provider/model, protocol and number of calls for both old records (full audit) and new ones (receipt). For new records they name the file `<runId>.judge/<trialId>.json`. Old and new runs from the same judge still compare. Reassessments and saved suites of old runs now copy a receipt instead of the full audit.

## Performance

- **Duration:** about 12 min
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- `jsonReport` now outputs `traceJournal: { file: '<runId>.trace.jsonl', bytes }` in place of the journal body. `experiment.id` still works for the CLI export.
- The HTML trial block no longer has the `<pre>` dump of the audit. The `sourceEvidence` dump leaves out `judgeAudit`. Both formats read `judgeAudit ?? judgeReceipt`, and every value is escaped.
- `compareRuns` treats a legacy audit and a receipt from the same judge as one judge. This holds across two runs and when both kinds appear inside one run. A receipt from a different model still makes runs incomparable.
- `judgeModel` returns the model for records that have only receipts.
- `suiteEvidence` (used by reassess and save-suite) seals receipts from legacy audits and deletes `judgeAudit`. Trials that already have a receipt are copied unchanged. A reassessment rebuilt through `embeddedBefore` gives the same `stabilityAfterReassess` result as the stored source.

## Task Commits

1. **Task 1 (tracer): reports name the journal and judge files; judge identity reads receipts** - `343b0f0` (feat)
2. **Task 2: suiteEvidence seals legacy audits** - `6f69172` (test, RED), `1f98ba4` (feat, GREEN)

## Files Created/Modified

- `src/report.ts` - `judgeSummary`/`judgeHTML`/`judgeLines`, `sourceEvidenceWithoutAudits`, `jsonReport` journal reference
- `src/comparison.ts` - `judgeIdentities` and `judgeModel` fall back to the receipt
- `src/connection.ts` - `suiteEvidence` seals receipts
- `test/artifacts.test.ts` - export journal-reference assertions; receipt-only and legacy report test
- `test/comparison.test.ts` - legacy-vs-receipt comparability, `judgeModel`, `suiteEvidence` behaviours, stability from rebuilt source

## Decisions Made

- Receipt completeness in `suiteEvidence` is decided by the full audit verifier over observable sources, so a stale legacy audit gets a receipt with `complete: false` and cannot support a later comparison.
- The Markdown tail sentence names the sidecar file for receipt trials and the JSON snapshot for legacy trials.

## Deviations from Plan

None. The plan was followed as written.

## TDD Gate Compliance

Task 2: RED commit `6f69172` (2 new tests failed because `judgeAudit` was still copied). GREEN commit `1f98ba4` (95/95 in comparison, experiment and workflow). No refactor was needed.

## Verification

- `snap-test.sh test/artifacts.test.ts test/comparison.test.ts test/store.test.ts test/cards.test.ts`: 54/54 pass.
- `snap-test.sh test/comparison.test.ts test/experiment.test.ts test/workflow.test.ts`: 95/95 pass.
- Full snapshot suite with no arguments (tsc, all tests, typecheck): 379/379 pass, no type errors.
- Acceptance greps: `JSON.stringify(trial.judgeAudit` 0; `traceJournal: {` 1; the fallback appears in both `src/comparison.ts` and `src/report.ts`; `sealJudgeReceipt(` 1 and `delete copy.judgeAudit` 1 in `src/connection.ts`.
- This plan was not re-checked on the live acquiring agent. Checking export size on real runs is left to the phase-level verification (01-10).

## Issues Encountered

None.

## Next Phase Readiness

- Old records (for example fae4ee59) still keep their audits inside `experiment`, so their JSON export stays at about 3–4 MB. That is below the 10 MB target.
- A report that is safe to show the customer (no raw replies at all) is still phase 5 (SHARE-03).

## Self-Check: PASSED

- FOUND: src/report.ts, src/comparison.ts, src/connection.ts, test/artifacts.test.ts, test/comparison.test.ts
- FOUND commits: 343b0f0, 6f69172, 1f98ba4

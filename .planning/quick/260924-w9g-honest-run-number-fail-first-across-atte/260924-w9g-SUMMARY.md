---
phase: quick-260924-w9g
plan: 01
subsystem: result
status: complete
tags: [result, honesty, fail-first, tool-channel, headline, invalid-cause]
requires: []
provides:
  - "fail-first card decision over usable attempts of the card's own plan (src/run.ts partOutcome)"
  - "tool-channel reading: a fail on a complete log stands on agent-side evidence (src/card/expectations.ts)"
  - "INVALID_CAUSES 'measurement' → NOT_MEASURED_CODES 'measurement_error' (uncommitted, shared files)"
  - "NOT_MEASURED_WARN_ABOVE = 10 in the headline (uncommitted, shared file)"
affects: [src/run.ts, src/card/expectations.ts, src/explain.ts, src/contracts.ts, src/result-view.ts, src/result-text.ts, src/inbox.ts, src/evaluation.ts, src/lab/review.ts]
tech-stack:
  added: []
  patterns: ["fail-first over usable attempts; pass needs the exact planned set", "typed cause set before the throw, never read from text"]
key-files:
  created: []
  modified:
    - src/run.ts
    - src/card/expectations.ts
    - src/explain.ts
    - src/contracts.ts
    - src/result-view.ts
    - src/result-text.ts
    - src/inbox.ts
    - src/evaluation.ts
    - src/lab/review.ts
decisions:
  - "HN-1/OD-2: a usable attempt of the card's own plan with a verified fail decides the card even beside a silent, missing or duplicated attempt; a pass needs the exact planned set, all usable; an attempt of another family/split/manifest decides nothing"
  - "HN-2: on a complete tool log a judged fail stands on any cited agent-side event (assistant, tool_call, tool_result); a pass still needs a cited tool_result; TOOL_LOG_RULE and parseJudgment left unchanged"
  - "HN-3/OD-3: strictly above 10% of counted situations not measured, the headline is never good and ends with «, ещё N не измерено»"
  - "HN-4: Lab-side refusals → turn_limit/simulator; adapter measurementError and grading refusals (live and reassessment) → new cause 'measurement' «подключение не показало, что нужно для проверки»; silence stays 'agent' (OD-1)"
metrics:
  duration: "~77 min"
  completed: 2026-09-24
actuals:
  tokens: 18000
  tasks: 3
  commits: 2
plan_head_before: 427c80549fa7838241ec5704f364396c8f1ad129
---

# Phase quick-260924-w9g Plan 01: Honest run number Summary

Fail-first across a card's own usable attempts, a proven missing tool call counted as a failure, a thin measurement never shown green, and a typed `measurement` cause so Lab or connection problems are no longer blamed on the agent.

`commits: 2` is measured from the ledger (`427c805..HEAD`). One of the two is this plan's: **00f819a** (Task 1). The other, b1c1060 («test: neutral placeholders…»), is the other session's commit and landed during this plan.

## What was done

### Task 1 (tracer), committed as 00f819a: HN-1 fail-first, HN-2 tool fail on a complete log
- `src/run.ts`: `attemptsMatch` is now split into `attemptsBelong` (family, split, manifest) and `plannedSet` (the mode:repeat set and count; skipped when `partial`). The new `partOutcome` decides every part fail-first: `unknown` unless the attempts belong; `fail` when any usable attempt fails; `pass` only when the planned set matches, every attempt is usable and every result passes. `metricCardOutcome` and `expectationsCardOutcome` (each expectation, «Точные проверки», and the card) use it. The module header diagram and the comments now cite OD-1 and OD-2.
- `src/card/expectations.ts`: in the tool branch, a fail stands on any cited agent-side event when the log is complete. A pass still needs a cited `tool_result`. A partial log, or citing only the customer, gives `unknown`.
- `src/explain.ts`: without a given trial, `failureExplanation` picks only from usable attempts, so the failure it explains is always one the number counts.
- Tests: the owner's case end to end, from `recordedExpectationResult` through `cardVerdict`, the parts, `failedAttempts`, `buildResultView` and `accuracyRow`; OD-1 silence; an unusable fail; missing, duplicated and foreign attempts; the goal/rules card with a silent repeat plus the control verdict; the explained failure being a counted one; the tool-channel matrix; a snapshot of the frozen fixtures.
- Tracer gate: `<verify>` re-run end to end passed (191/191 targeted, both typechecks clean). The fixture snapshot did not change.

### Task 2, uncommitted: HN-4 read side
- `src/contracts.ts`: `'measurement'` is appended to `INVALID_CAUSES`, with new doc comments.
- `src/run.ts`: `measurement_error` comes right after `service_reply` in `NOT_MEASURED_CODES`, and cause `measurement` maps to `measurement_error`.
- `src/result-view.ts` (shared file): one new `NOT_MEASURED_TEXT` line, `measurement_error: 'подключение не показало, что нужно для проверки'`.
- `src/inbox.ts`: `measurement_error: 'agent'` in `SIDE`, so the decision reads «проверьте связь с агентом».

### Task 3, uncommitted: HN-4 write side and HN-3
- `src/evaluation.ts` (the other session also edits this file; see below):
  - A new `refusal` is set right before each Lab-side throw: controller unsupported gives `simulator`; the required path over the limit gives `turn_limit`; a script issue gives `turn_limit`.
  - `stage` is reset to `'target session'` before the session opens, so a failure to open is labelled «открытие сессии с испытуемым», not «контроллер симулятора».
  - `onReply` records `measurementReported` from the typed field.
  - The catch picks the cause in this order: `refusal`, then `measurement` (reported error or the grading stage), then `simulator`, otherwise `agent`.
- `src/lab/review.ts`: an explicit `graded` flag. Only a grading refusal (invalid, cause `measurement`) or a stop removes a reassessed attempt from the measurement. A judge failure after grading keeps the graded outcome and its typed `assessmentFailure`.
- `src/result-text.ts` (shared file): `NOT_MEASURED_WARN_ABOVE = 10` sits next to `GOOD_FROM`/`MIXED_FROM`. In `accuracyParts`, `thin` is computed as `unmeasured*100 > 10*(decided+unmeasured)`. When it holds, the tail gains «, ещё N не измерено» and `good` is lowered to `warn`. The header diagram notes the new tail.

## Commit status

| File | Group | Status |
|------|-------|--------|
| src/card/expectations.ts | Task 1 | committed 00f819a |
| src/run.ts (Task 1 hunks) | Task 1 | committed 00f819a |
| src/explain.ts | Task 1 | committed 00f819a |
| test/card-expectations.test.ts | Task 1 | committed 00f819a |
| test/comparison.test.ts | Task 1 | committed 00f819a |
| test/workspace-command.test.ts | Task 1 (deviation 1) | committed 00f819a |
| src/result-view.ts | HN-4 cause | uncommitted, shared file (one NOT_MEASURED_TEXT line) |
| src/contracts.ts | HN-4 cause | uncommitted, depends on shared file |
| src/run.ts (code + cause map hunks) | HN-4 cause | uncommitted, depends on shared file |
| src/inbox.ts | HN-4 cause | uncommitted, depends on shared file |
| test/result-view.test.ts | HN-4 cause + HN-3 assertions | uncommitted, depends on shared file |
| src/evaluation.ts | HN-4 cause | uncommitted, shared file: the other session began editing it during this plan (card-customer `free` path), so its hunks interleave with ours |
| src/lab/review.ts | HN-4 cause | uncommitted, depends on shared file |
| test/evaluation.test.ts | HN-4 cause | uncommitted, depends on shared file |
| test/experiment.test.ts | HN-4 cause | uncommitted, depends on shared file |
| src/result-text.ts | HN-3 headline | uncommitted, shared file (the constant, `accuracyParts`, one header line) |
| test/result-text.test.ts | HN-3 headline | uncommitted, depends on shared file |
| test/quality.test.ts | HN-3 headline | uncommitted, depends on shared file |
| test/report.test.ts | HN-3 headline | uncommitted, shared file (one assertion) |

Rule 6 did not apply: at the end, `git diff -- src/result-view.ts src/result-text.ts` still showed the other session's hunks. Those hunks were checked against `foreign-baseline.patch` and are byte-identical: 0 foreign lines missing in result-view.ts, result-text.ts and report.test.ts.

## Deliberate non-changes
- **TOOL_LOG_RULE** (`src/card/compile.ts`): unchanged. It sits inside the compiled rubric that the definition fingerprint seals at acceptance, so rewording it would silently change new definitions against accepted ones. HN-2 is implemented in the reading alone.
- **parseJudgment / the goal-on-tool channel** (`src/judge.ts`): unchanged. Stored audits are re-run through `parseJudgment` and fingerprinted, and `JUDGE_PROTOCOL` names the rule (`owner-selected-cited-channel`). Changing either would break verification of stored legacy judgments.
- **cardOutcome** (the strict rule for legacy cards without a goal rubric): unchanged, and its comment now says so. Its frozen rule needs a complete run before any fail is read.
- **The legacy invalidCause decoder** (`invalidCauseOf`): unchanged. It reads only records written before `invalidCause` existed. Records already written keep their stored cause; there is no migration.
- **src/lab/run.ts rerun rule**: untouched, as instructed. Side effect: an adapter-reported `measurementError` and Lab refusals no longer carry cause `agent`, so the one-time rerun (which fires only for `invalidCause === 'agent'` with an error event) no longer repeats them. Both are deterministic, so a rerun would not help.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The "unchanged verdict" fixture in test/workspace-command.test.ts relied on the old rule**
- **Found during:** Task 1, full suite.
- **Issue:** The notice «Итог не изменился» was pinned on a card whose second planned attempt was missing. Under OD-2 its usable double fail now decides the card, so overturning it moves the verdict.
- **Fix:** The fixture's attempts now belong to another plan (`manifestHash: 'other'`), which decides nothing. This keeps coverage of «Итог не изменился», and a comment explains why the missing-attempt setup no longer works.
- **Files modified:** test/workspace-command.test.ts (not on the plan's list, not foreign).
- **Commit:** 00f819a

**2. [Rule 1 - Bug] An empty reply on a card with state checks was relabelled by the grading refusal**
- **Found during:** Task 3 (new OD-1 test).
- **Issue:** After an empty reply the dialogue breaks and grading still runs. On a state card, grading then throws, and the catch overwrote the reason with «проверка наблюдений: …». With the new mapping the cause would have become `measurement`, which breaks OD-1.
- **Fix:** When the dialogue already broke with a typed cause (empty or service reply) before grading, the catch keeps that reason and cause (`brokeFirst`).
- **Files modified:** src/evaluation.ts (uncommitted).

**3. [Test setup] The turn-limit refusal of a compiled card needs maxTurns 1**
- `settingsSchema` requires `maxTurns >= 2`, and the helper card's required path is 2 turns. The test therefore builds its settings with `{ ...settingsSchema.parse({}), maxTurns }`, and a comment says why.

### Existing assertions updated
- test/card-expectations.test.ts «the parts carry…»: a missing planned attempt next to a usable fail is now `{ outcome: 'fail' }` with parts fail/fail/fail. The pass case stays `attempts_mismatch`.
- test/comparison.test.ts «two attempts…»: missing is now `{ outcome: 'fail', goal: 'unknown', rules: 'fail' }` with `cardVerdict { outcome: 'fail' }`, and a pass-only missing case keeps `attempts_mismatch`.
- test/result-view.test.ts: the `NOT_MEASURED_CODES` count goes from 20 to 21. Three headlines crossing the threshold (HN-3) gain their tail:
  - `ACQUIRING_HEAD[0]` gains «, ещё 4 не измерено» (4 of 13 not measured);
  - «11% — справился в 1 из 9», same tail;
  - «0 из 10» gains «, ещё 3 не измерено».
- test/result-text.test.ts: in the resultScreen and chatBlock-expanded tests, the head gains «, ещё 1 не измерено» (1 of 7).
- test/quality.test.ts: the report/CLI headline test gains «, ещё 1 не измерено» (1 of 4).
- test/report.test.ts (shared): in the report-order test, the tail gains «, ещё 1 не измерено» (1 of 4).
- test/workspace-command.test.ts: see deviation 1.

## Verification
- `npx tsc -p tsconfig.json --noEmit` and `npx tsc -p tsconfig.check.json --noEmit`: clean, both at the Task 1 commit and at the end.
- Full suite `npx tsx --test test/*.test.ts`: 994 tests, 989 pass. The baseline was 978/978. The 5 failures do not come from a src defect:
  - **712–715** (result-view.test.ts, «…from the built dist» and the three CLI-summary quick-mark tests) run the stale `dist/cli.js`, which was not rebuilt because of the no-`npm run build` instruction. The only difference in each is the new HN-3 tail on the headline line, which dist does not have yet. They will pass after `npm run build`.
  - **952** (workflow.test.ts «CLI run returns the full persisted dialogue…») fails because `dist/cli.js` refuses with «Версия оценщика изменилась». The src `evaluatorVersion` now differs from dist because of the other session's uncommitted `src/card-customer.ts` / `src/pi.ts` (`CARD_CUSTOMER_PROTOCOL`). This plan does not touch those files. It also needs a rebuild.
- Frozen fixtures (`recorded-run.json`, `legacy-demo-run.json`, `library-v1/run.json`) parse and derive exactly as they did at HEAD. A snapshot test pins this.
- `.agent-lab` was never touched, and `dist/` was not rebuilt.

## Baseline failures that are not this plan's
None at the start (978/978). Failure 952 above appeared with the other session's concurrent changes.

## Known Stubs
None.

## Self-Check: PASSED
- 00f819a exists (`git log`); its six paths are exactly the Task 1 files plus test/workspace-command.test.ts; no foreign path.
- All modified files listed above exist; the uncommitted hunks are in the working tree (own-file patch saved at the session scratchpad `w9g-uncommitted-own-files.patch`).

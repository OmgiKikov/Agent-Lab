---
phase: 02-sudya-obyasnyaet-provaly
plan: 01
subsystem: judge
tags: [judge-protocol, v11, prefix-judging, receipts]
status: complete

requires:
  - phase: 01-odno-chestnoe-chislo
    provides: "judge receipts (01-04), sidecar audits (01-06), verify-stored-runs.mjs and snap-test.sh"
provides:
  - "Judge protocol v11: fidelity votes first; agent rubrics on the faithful prefix before the first cited simulator deviation"
  - "JUDGE_PROTOCOL_V10 frozen and still verifiable (full audit and receipt)"
  - "Trial.judgedBeforeSeq and JudgeReceipt.cutBefore, both re-derived or cross-checked by the verifier"
  - "simulatorCut, prefixTrial, auditCut shared by writer and verifier"
affects: [02-03 paid pilot and reassessments, counting rules goal-v2, comparison of v10 vs v11 runs]

plan_head_before: fa79f2ea78d4e122305d9cdc2ea7181f4b7512ca
judge_protocol_v11: 9b08dc89e9fd8b042c244cc95c716a9d7ae7ced30416fde7e30656f3b07889ee

actuals:
  tokens: 12700    # chars/4 over the src/ and test/ diff (50 911 chars)
  tasks: 2
  commits: 3       # MEASURED rev-list fa79f2e..HEAD; 2 are this plan's, 61011aa is a concurrent docs(05,06) planning commit

tech-stack:
  added: []
  patterns:
    - "Two-stage judge queue sharing one worker routine; stage 2 starts only after stage 1 settled with no error"
    - "Versioned protocol verification: frozen V10 constant beside the current one, both wrapped by expectedProtocol(protocol, configurationHash)"

key-files:
  created: []
  modified:
    - src/judge.ts
    - src/contracts.ts
    - src/evaluation.ts
    - src/experiment.ts
    - test/judge.test.ts
    - test/evaluation.test.ts
    - test/store.test.ts
    - test/experiment.test.ts

key-decisions:
  - "Judge protocol v11 (9b08dc89…) judges agent rubrics on the prefix before the earliest user/simulator event a failing fidelity vote cites; V10 (32c413cf…) stays byte-identical and verifiable"
  - "prefixTrial withholds observed state and check results (observation missing, checks empty), named in the v11 prefixEvidence field"
  - "A v11-labelled audit without per-rubric attempts (legacy shape) verifies with no cut, exactly as under v10; prefix semantics need isolated fidelity attempts"

patterns-established:
  - "Cut is never trusted from the record: the full-audit path recomputes it from re-parsed fidelity votes; the receipt path requires cutBefore === judgedBeforeSeq plus a failing fidelity vote"

requirements-completed: [JUDGE-03]

coverage:
  - id: D1
    description: "A reactive dialogue with a deviating simulator gets agent votes on the faithful prefix; still 2 calls per applicable rubric"
    requirement: JUDGE-03
    verification:
      - kind: unit
        ref: "test/judge.test.ts#a deviated reactive dialogue: fidelity is judged first on the whole dialogue, the agent on the faithful prefix"
        status: pass
    human_judgment: false
  - id: D2
    description: "The trial keeps the cut and the sealed receipt carries it; the verifier accepts it"
    requirement: JUDGE-03
    verification:
      - kind: unit
        ref: "test/evaluation.test.ts#assessment records where a deviated simulated user cut the dialogue, on the trial and in its sealed receipt"
        status: pass
    human_judgment: false
  - id: D3
    description: "v10 records and receipts verify as before; every edit of the cut or protocol label is caught; protocol pinned"
    requirement: JUDGE-03
    verification:
      - kind: unit
        ref: "test/judge.test.ts#v11 judgments verify only with an untouched cut and v10 judgments stay verifiable as before"
        status: pass
      - kind: unit
        ref: "test/judge.test.ts#judge protocol v10 is frozen and v11 is pinned"
        status: pass
      - kind: integration
        ref: "verify-stored-runs.mjs on fae4ee59 / a92fd6ae with the snapshot dist"
        status: pass
    human_judgment: false
  - id: D4
    description: "Whether v11 actually turns «без решения» into decided verdicts on the real acquiring cards"
    requirement: JUDGE-03
    verification: []
    human_judgment: true
    rationale: "Needs the paid live pilot in 02-03 (GO/NO-GO); unit tests only prove the mechanics"

duration: 10min
completed: 2026-09-17
---

# Phase 2 Plan 01: Judge protocol v11 (prefix judging) Summary

**Judge protocol v11 judges the agent on the dialogue before the first simulator deviation a failing fidelity vote cites, stores that cut on the trial and in the receipt, and keeps every v10 record verifiable.**

## Performance

- **Duration:** about 10 min
- **Started:** 2026-09-17T00:27Z
- **Completed:** 2026-09-17T00:37Z
- **Tasks:** 2 of 2
- **Files modified:** 8 (4 src, 4 test)

## Accomplishments

- `assessRepeated` now runs in two stages. First the two `user_fidelity` votes run on the whole dialogue. Then every other applicable rubric gets its two votes: on `prefixTrial(trial, cut)` when there is a cut, otherwise on the whole dialogue. If a fidelity vote errors or is rejected, no agent vote is requested. The call count stays at 2 per applicable rubric.
- `hasCompleteJudgment` accepts both protocol versions:
  - **v10, full audit:** the old checks, and the trial must have no cut.
  - **v11, full audit:** the cut is recomputed from the re-parsed fidelity votes and must equal `trial.judgedBeforeSeq`. Each agent attempt is checked against the prefix input.
  - **Receipt:** v10 receipts carry no cut. A v11 receipt needs `cutBefore === judgedBeforeSeq`, and a failing fidelity vote whenever there is a cut.
- `assessTrial` sets `trial.judgedBeforeSeq` before it seals the receipt, and the receipt gets the same value in `cutBefore`. `reassess` clears the field together with the old judgment.
- A freeze test pins four hashes:
  - `JUDGE_PROTOCOL_V10` = `32c413cf3a12121a697981a18b5e5c4a1d05934150ab3032800b6fa4934d5736`
  - `fingerprint(JUDGE_PROMPT)` = `891c8c65226e2f6cb3eab30638da3c288fd6d488d833faa5811d9b91ab58d210`
  - `fingerprint(JUDGE_RESPONSE_FORMAT)` = `d367899779956e5fa0ac227dfe9905e89e3ff459a0afe4e43886bd26602854de`
  - **v11** `JUDGE_PROTOCOL` = `9b08dc89e9fd8b042c244cc95c716a9d7ae7ced30416fde7e30656f3b07889ee`
- `evaluatorVersion` (src/pi.ts) folds in `JUDGE_PROTOCOL`, so `start` now refuses drafts prepared under v10 with its existing message.

## Stored-run regression (real data, read-only, phase-2 code)

```
fae4ee59 cards=13 passed=0 decided=9 notMeasured=4 reasons=simulator_deviated:2,simulator_unclear:1,judge_split:1 exclusions=27 audit=13/13
a92fd6ae cards=15 passed=1 decided=8 notMeasured=7 reasons=simulator_deviated:4,agent_error:1,simulator_unclear:1,judge_split:1 exclusions=17 audit=14/14
```

No MISMATCH lines; exit 0. The full snapshot suite (`snap-test.sh` with no arguments) passed 414/414, and typecheck passed.

## Task Commits

1. **Task 1 (tracer): a deviated reactive dialogue is judged on its faithful prefix, and the cut goes into a verifiable receipt**: `6fa77f0` (feat)
2. **Task 2: old judgments stay verifiable, every edit of the cut is caught, the protocol is pinned**: `c82f93e` (feat)

The tracer gate re-ran the Task 1 `<verify>`: 145 passed, 0 failed.

## TDD Notes

- **Task 1 RED:** `test/judge.test.ts` failed to load because the new exports were missing, and the new evaluation test failed. GREEN came after the implementation.
- **Task 2 RED:** 3 tests failed before the Task 2 code:
  - the receipt cut table;
  - the v11 pin;
  - the reassess test, which runs on the demo runtime and therefore has no judge audit.

  The fidelity-stop test and the store round-trip test already passed at RED. Task 1 had already added the stage split and the schema fields they rely on.

## Decisions Made

- **Legacy audit shape:** an audit in the legacy shape (no `metricId` on its attempts) that carries the v11 label verifies with no cut. Existing tests build such audits with the current label (`judge.test.ts` "legacy two-vote receipts", `comparison.test.ts` protocol compatibility). Rejecting them would have broken those tests and added no safety, because without per-rubric fidelity attempts there is no cut to hide.
- **`auditCut` and `simulatorCut` inputs:** both take `Pick<TraceEvent, 'seq' | 'type'>[]`, so the vector tests can use events without text.

## Deviations from Plan

None that change behaviour. Two notes:

- **Commit count:** `actuals.commits` is 3 because the concurrent commit `61011aa docs(05,06)` landed between this plan's two commits. It touched only `.planning/phases/05-*` and `06-*`.
- **Reassess test runtime:** the reassess test uses the demo runtime (evaluate + start), as the behaviour list asks ("demo runtime, no audit"). With a judging runtime it would have passed even without the new `delete`, because `assessTrial` already deletes a cut it cannot derive.

## Issues Encountered

- **Legacy audits under the v11 label:** a first draft rejected them, which broke 2 existing tests. The fix was to drop that rule (see Decisions).
- **Quote mismatch in a new test:** in the "no failing fidelity vote" test, a goal vote cited event #4 with a quote from event #1. The fixture now cites #1.

## Next Phase Readiness

- **02-03** can run the paid pilot on v11. If the result is NO-GO, the restore base is `plan_head_before` = `fa79f2e`. Revert `6fa77f0` and `c82f93e` to restore the v10 code.
- **Swapping `dist/` for the live extension** is still 02-03's job; this plan never built in the worktree.

## Self-Check: PASSED

- FOUND: src/judge.ts, src/contracts.ts, src/evaluation.ts, src/experiment.ts
- FOUND: commit 6fa77f0, commit c82f93e

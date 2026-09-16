---
phase: 01-odno-chestnoe-chislo
plan: 01
subsystem: result-view
tags: [result-view, counting-rules, wilson, cli, not-measured]

requires: []
provides:
  - "src/result-view.ts: ResultView, buildResultView, resultViewLines, wilson, pluralForm, exclusionCounts, NOT_MEASURED_TEXT, EXCLUSION_TEXT, COUNTING_RULES"
  - "src/comparison.ts: goalCardOutcome (exported), cardVerdict, NOT_MEASURED_CODES, NotMeasuredCode, judgeModel"
  - "src/judge.ts: GOAL_UNSUPPORTED_RATIONALE, AGREED_RATIONALE_PREFIX, SPLIT_RATIONALE_PREFIX (text unchanged)"
  - "CLI summary: ResultView block first; summary --json carries a `view` key"
  - "QualitySummary.excluded.kinds replaces customerData/masked/other"
  - "snap-test.sh and verify-stored-runs.mjs in the phase directory"
affects: [01-02, 01-05, 01-09, pi-surfaces, html-report]

plan_head_before: f4af4f3bb4894880430b082eb77ead7e7c00b62f
actuals:
  tokens: 16400
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "One pure view model (ResultView) decides the first block; surfaces only escape and print it"
    - "Reason codes are evaluated in one fixed order that is also the tie-break"
    - "Tests run from a working-tree snapshot; the worktree dist/ is never rebuilt"

key-files:
  created:
    - src/result-view.ts
    - test/result-view.test.ts
    - .planning/phases/01-odno-chestnoe-chislo/snap-test.sh
    - .planning/phases/01-odno-chestnoe-chislo/verify-stored-runs.mjs
  modified:
    - src/comparison.ts
    - src/judge.ts
    - src/cli.ts
    - src/quality.ts
    - test/quality.test.ts
    - test/experiment.test.ts

key-decisions:
  - "A draft that never ran (phase preparing/review, no attempts) shows only «Прогон ещё не запускался.» with no pending or not-measured lines; its cards keep their reason code in ResultView.cards"
  - "cardVerdict checks attempts_mismatch with the goalCardOutcome plan-match conditions (keys, family, split, manifest) for legacy cards too"
  - "The simulator reason codes mirror simulatorUsable exactly, so a human verdict on a check or the fidelity rubric overrides it"

patterns-established:
  - "Rationale matching goes through constants exported from judge.ts, never copied literals"
  - "Stored pilot runs are checked by ids and counts only"

requirements-completed: [TRUST-01, TRUST-02, TRUST-03]

coverage:
  - id: D1
    description: "CLI summary on stored run fae4ee59 starts with the headline, Wilson caveat, not-measured line, control line and coverage line built by ResultView"
    requirement: TRUST-01
    verification:
      - kind: unit
        ref: "test/result-view.test.ts#CLI summary prints the ResultView block first, from the built dist"
        status: pass
      - kind: other
        ref: "node $SNAP/dist/cli.js summary --id fae4ee59-d6da-4cbf-83b5-574e34405877 --data-dir .agent-lab | head -5"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every not-measured card has one of 18 reason codes with a Russian label, stays outside the denominator, and ties follow the fixed order"
    requirement: TRUST-02
    verification:
      - kind: unit
        ref: "test/result-view.test.ts#reason * (18 codes, priority, tie-break)"
        status: pass
      - kind: other
        ref: "node verify-stored-runs.mjs --dist $SNAP/dist --expect fae4ee59…:0:9:4 --expect a92fd6ae…:1:8:7 --audit …:13/13 --audit …:14/14"
        status: pass
    human_judgment: false
  - id: D3
    description: "Fewer than 20 decided situations show the Wilson 95% range; 0 decided shows no percent"
    requirement: TRUST-03
    verification:
      - kind: unit
        ref: "test/result-view.test.ts#wilson matches the verified 95% vectors; 19 decided situations carry the caveat, 20 show the percent without it; no decided situation shows no percent"
        status: pass
    human_judgment: false
  - id: D4
    description: "Exclusion reasons are named in words everywhere; the catch-all bucket is gone from quality.ts and result-view.ts"
    requirement: TRUST-02
    verification:
      - kind: unit
        ref: "test/quality.test.ts#the headline names only non-zero leftovers…; test/experiment.test.ts#validation grounds expectations…"
        status: pass
    human_judgment: false
  - id: D5
    description: "Whether the Russian wording of the new phrases reads well to the owner and the customer"
    verification: []
    human_judgment: true
    rationale: "Wording beyond the five CONTEXT phrases is planner wording (RESEARCH A1); only a person can judge it"

duration: 7min
completed: 2026-09-17
status: complete
---

# Phase 1 Plan 01: ResultView and the honest CLI headline Summary

**CLI `summary` now opens with one headline over one denominator from a pure `ResultView`: a Wilson caveat below 20 decided situations, «Не измерено» split into 18 named reasons, and named exclusion reasons. On stored run fae4ee59 the headline reads «Справился в 0 из 9 проверенных ситуаций — 0%.»**

## Performance

- **Duration:** about 7 min (measured from the start stamp)
- **Started:** 2026-09-17 (local)
- **Completed:** 2026-09-16T21:18:05Z
- **Tasks:** 2/2
- **Files modified:** 10 (4 created, 6 modified)

## Accomplishments

- On stored run fae4ee59, the snapshot build of `summary` prints these first lines:
  ```
  Справился в 0 из 9 проверенных ситуаций — 0%.
  Мало данных: реальная доля где-то от 0% до 30%.
  Не измерено: 4 — чаще всего симулятор отклонился от диалога (2).
  Контроль: не задан.
  Из 40 диалогов в набор вошли 13. Не вошли 27: в правилах нет ожидаемого ответа — 21, нужны данные клиента — 6.
  ```
- `cardVerdict` gives every undecided card exactly one code from `NOT_MEASURED_CODES`. Each code has its own test.
- `verify-stored-runs.mjs` output, ids and counts only:
  - `fae4ee59 cards=13 passed=0 decided=9 notMeasured=4 reasons=simulator_deviated:2,simulator_unclear:1,judge_split:1 exclusions=27 audit=13/13`
  - `a92fd6ae cards=15 passed=1 decided=8 notMeasured=7 reasons=simulator_deviated:4,agent_error:1,simulator_unclear:1,judge_split:1 exclusions=17 audit=14/14`
- `JUDGE_PROTOCOL` is unchanged: snapshot and worktree `dist/judge.js` produce the same hash, `32c413cf…`. `VERSION` is still `'6'`.
- The full snapshot suite passes (346/346), and so does the extension typecheck. The worktree `dist/` mtime is unchanged (1789573214).

## Task Commits

1. **Task 1: Tracer, CLI summary prints one honest headline block from ResultView**: `9979d64` (feat)
2. **Task 2: Every not-measured reason and exclusion is named in words**: `03435f8` (test, RED), `b269846` (feat, GREEN)

## Files Created/Modified

- `src/result-view.ts`: the pure view model: headline, Wilson range, pending, not measured, coverage and scope
- `src/comparison.ts`: exported `goalCardOutcome`; `NOT_MEASURED_CODES`, `cardVerdict` and `judgeModel`
- `src/judge.ts`: the three rationale strings exported as constants; the generated text is byte-identical
- `src/cli.ts`: `summary` prints the ResultView block (through `safeLine`), then «Подробности:». `--json` adds `view`. The old headline and judge line with other denominators are gone.
- `src/quality.ts`: imports `goalCardOutcome`, `judgeModel` and `pluralForm`. `excluded.kinds` replaces the catch-all.
- `test/result-view.test.ts`: 29 tests: wording, Wilson vectors, the 19/20/0 boundaries, the fae4ee59-shaped block, a CLI spawn test, and one test per reason code
- `test/quality.test.ts` and `test/experiment.test.ts`: one expected coverage string each
- `.planning/phases/01-odno-chestnoe-chislo/snap-test.sh`: the snapshot test runner (`--full`, `--keep`)
- `.planning/phases/01-odno-chestnoe-chislo/verify-stored-runs.mjs`: read-only counts over stored runs

## TDD Gate Compliance

- RED `03435f8`: the new coverage expectations failed on the old `quality.ts` (2 failing tests: quality coverage and validate coverage). The 29 result-view tests already passed, because the plan put `cardVerdict` in Task 1.
- GREEN `b269846`: 121/121 in the targeted snapshot run.
- REFACTOR: nothing to change.

## Decisions Made

See key-decisions in the frontmatter.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] A draft that never ran would have listed every card as not measured**
- **Found during:** Task 1
- **Issue:** Cards of a `review` draft have no attempts and the phase is not a running one. The plan's rules would give them `not_reached`, and the block would print «Не измерено: N — прогон остановлен до ситуации» under «Прогон ещё не запускался.».
- **Fix:** When there are no attempts and the phase is `preparing` or `review`, `pending` is 0 and `notMeasured` is empty. The cards keep their codes in `ResultView.cards`.
- **Files modified:** src/result-view.ts
- **Verification:** `test/result-view.test.ts#a draft that never ran says so and lists nothing as unmeasured`
- **Committed in:** 9979d64

**2. [Rule 1 - Bug] snap-test.sh could hide a failed compile**
- **Found during:** Task 1
- **Issue:** Bash suspends `set -e` inside a subshell on the left of `||`, so a failed `npx tsc` would not stop the run.
- **Fix:** The steps are chained with `&&`.
- **Files modified:** .planning/phases/01-odno-chestnoe-chislo/snap-test.sh
- **Verification:** the targeted and full snapshot runs exit with the status of the tests.
- **Committed in:** 9979d64

---

**Total deviations:** 2 auto-fixed (2 Rule 1).
**Impact on plan:** Both fixes are needed for honest output. Scope did not grow.

## Issues Encountered

- `a92fd6ae` has 17 exclusions. The plan does not state this number, so it is not asserted.
- An untracked `.planning/phases/02-sudya-obyasnyaet-provaly/` from another session exists in the tree. I left it untouched and did not commit it.

## User Setup Required

None: no external service configuration required.

## Next Phase Readiness

- Ready for 01-02: Pi surfaces can switch to `buildResultView` / `resultViewLines`.
- 01-05 can add an optional second argument to `buildResultView`, and 01-09 can fill `control.cards` and `control.warning`. The block already prints «Контроль: не задан.» while `control.cards` is empty.
- The detail lines under «Подробности:» still come from `qualityLines` and are not escaped. This was already the case before this plan and is outside its scope.

## Self-Check: PASSED

- FOUND: src/result-view.ts, test/result-view.test.ts, snap-test.sh, verify-stored-runs.mjs
- FOUND commits: 9979d64, 03435f8, b269846

---
*Phase: 01-odno-chestnoe-chislo*
*Completed: 2026-09-17*

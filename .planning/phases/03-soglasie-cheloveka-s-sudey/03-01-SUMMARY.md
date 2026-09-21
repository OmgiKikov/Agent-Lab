---
phase: 03-soglasie-cheloveka-s-sudey
plan: 01
subsystem: testing
tags: [agreement, human-review, zod, result-view, cli, judge-receipt]

requires:
  - phase: 01-odno-chestnoe-chislo
    provides: "resultViewRows/resultViewLines, wilson, SMALL_SAMPLE, judge receipts (protocolHash/inputHash) and the snapshot test runner"
  - phase: 02-sudya-obyasnyaet-provaly
    provides: "explain.ts (failureExplanation, rowsToLines, Line.lead), the first-block row roles, the frozen judge protocol v10"
provides:
  - "Optional `source: 'quick'`, `judgeVerdict` and `judge` fields on every human review, with `judgeSnapshotSchema`"
  - "`primaryMetricId(scenario, trial)` — the one rubric a one-key mark lands on"
  - "`src/agreement.ts`: `judgeAgreement`, `agreementSample`, `PASS_SAMPLE`, `JudgeAgreement`, `AgreementMark`, `AgreementGroup`"
  - "`ResultView.agreement`, `PERCENT_FROM` and the F6 agreement rows in the first block of every surface"
  - "Lab-side guards C-99…C-101: only the lab decides which judgment a mark refers to"
affects: [03-02, 03-03, 03-04, 03-05, 03-06]

actuals:
  tokens: 14052
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "A count that grades a judgment reads the recorded assessment, never the human-overridden one"
    - "The writer, not the caller, stamps provenance fields (judge verdict and judge version) on a stored record"
    - "A deterministic sample drawn from `fingerprint({ run, trial })` — stable across reopen, redrawn only by a new run id"

key-files:
  created:
    - src/agreement.ts
    - test/agreement.test.ts
  modified:
    - src/contracts.ts
    - src/outcomes.ts
    - src/result-view.ts
    - src/experiment.ts
    - test/result-view.test.ts
    - test/experiment.test.ts
    - test/contracts.test.ts
    - test/outcomes.test.ts
    - test/store.test.ts

key-decisions:
  - "The F6 parts `провалы: a из b` count agreed/checked inside the group, not agreed/queued — the plan's tracer example said `1 из 11`, which contradicts the UI-SPEC table and its own M = 20 example; the UI-SPEC wins"
  - "A quick mark on a trial whose primary metric is no longer decided is stale, not skipped, so a reassessment that turned a verdict into `unknown` still reports «отметки устарели»"
  - "`AgreementMark.judge` carries the judgment the person was shown (`review.judgeVerdict`), so a stale mark still names what it answered"
  - "The judge snapshot is written for every metric review, not only for quick marks, so later analysis can tell which judgment any human verdict argued with"

patterns-established:
  - "Pattern: `situations(record)` — one pass over non-control trials that have a primary metric, shared by the queue, the sample and the count"
  - "Pattern: stale detection compares the stored snapshot with `trial.judgeReceipt ?? trial.judgeAudit`, treating a missing snapshot and a missing judgment as equal (null === null)"

requirements-completed: [JUDGE-04, JUDGE-05, JUDGE-06]

coverage:
  - id: D1
    description: "A one-key mark saved through `ExperimentLab.addHumanReview` appears in `agent-lab summary` as the agreement row inside the first block, after the control row and before the coverage row"
    requirement: JUDGE-04
    verification:
      - kind: e2e
        ref: "test/result-view.test.ts#a quick mark saved by the lab shows as the agreement row in the CLI summary"
        status: pass
    human_judgment: false
  - id: D2
    description: "`humanReviewInputSchema` accepts every old review unchanged and the optional `source`/`judgeVerdict`/`judge` fields; a quick mark without a rubric or with verdict `invalid` is rejected"
    requirement: JUDGE-04
    verification:
      - kind: unit
        ref: "test/contracts.test.ts#a quick agreement mark extends the review schema and old reviews still parse unchanged"
        status: pass
      - kind: integration
        ref: "test/store.test.ts#a quick agreement mark survives a reload with its judge verdict and judge version"
        status: pass
    human_judgment: false
  - id: D3
    description: "`primaryMetricId` picks the goal, else the first failed agent rubric, else the first passed one; RAG and simulator rubrics are never chosen"
    requirement: JUDGE-04
    verification:
      - kind: unit
        ref: "test/outcomes.test.ts#the primary metric is the goal, else the first failed agent rubric, else the first passed one"
        status: pass
    human_judgment: false
  - id: D4
    description: "The lab fills `judgeVerdict` and `judge` from the trial and refuses a quick mark off the primary metric, on an undecided judge, or with a verdict that moved"
    requirement: JUDGE-04
    verification:
      - kind: integration
        ref: "test/experiment.test.ts#the lab, not the caller, records which judgment a quick mark refers to"
        status: pass
      - kind: integration
        ref: "test/experiment.test.ts#a mark takes its judge version from the legacy audit, and none when the trial was never judged"
        status: pass
      - kind: integration
        ref: "test/experiment.test.ts#a quick mark on a judgment the judge never made is refused"
        status: pass
    human_judgment: false
  - id: D5
    description: "Agreement is counted on the recorded judge result, never on the human-overridden one; controls, comparison runs and running phases count nothing"
    requirement: JUDGE-05
    verification:
      - kind: unit
        ref: "test/agreement.test.ts#agreement is counted on the recorded judgment, never on the human-overridden result"
        status: pass
      - kind: unit
        ref: "test/agreement.test.ts#control situations never enter the queue, the sample or the count"
        status: pass
      - kind: unit
        ref: "test/agreement.test.ts#a comparison run and a run still going report nothing at all"
        status: pass
    human_judgment: false
  - id: D6
    description: "Only current quick marks enter N and M; unsure marks go to `unsure`, moved judgments and marks carried in `sourceEvidence` go to `stale`, and a later full review removes the pair"
    requirement: JUDGE-05
    verification:
      - kind: unit
        ref: "test/agreement.test.ts#a mark made under another judge version is stale, and a demo mark with no version is current"
        status: pass
      - kind: unit
        ref: "test/agreement.test.ts#a quick mark carried in sourceEvidence is stale: a reassessment is a new judgment"
        status: pass
      - kind: unit
        ref: "test/agreement.test.ts#a later full review on the same rubric removes the quick pair from the count"
        status: pass
    human_judgment: false
  - id: D7
    description: "The F6 row reads right at every size: no percent below 10 checks, «мало проверок» below 20, «N из M проверенных» for every M, and the parts name what is still unchecked"
    requirement: JUDGE-05
    verification:
      - kind: unit
        ref: "test/result-view.test.ts#the agreement row follows the number of checks: no percent below 10, «мало проверок» below 20"
        status: pass
      - kind: unit
        ref: "test/result-view.test.ts#the agreement parts name what is still unchecked instead of counting it as agreement"
        status: pass
      - kind: unit
        ref: "test/result-view.test.ts#the agreement tail rows appear only under their condition and in one fixed order"
        status: pass
      - kind: unit
        ref: "test/result-view.test.ts#stale marks alone report themselves, and a run with nothing to check keeps the old block"
        status: pass
    human_judgment: false
  - id: D8
    description: "The pass sample holds every pass up to three, otherwise three drawn by `fingerprint({ run, trial })`; it survives `structuredClone` and a human flip, and is empty while the run is going"
    requirement: JUDGE-06
    verification:
      - kind: unit
        ref: "test/agreement.test.ts#the pass sample holds every pass up to three and otherwise a draw fixed by the run id"
        status: pass
    human_judgment: false
  - id: D9
    description: "The agreement row as the owner and the customer manager actually read it on a real acquiring run in Pi"
    verification: []
    human_judgment: true
    rationale: "Wording and placement on the live board and in a real Pi session cannot be judged by a test; the board keys and colours land in 03-04…03-06, so the live read belongs to the phase-level check."

duration: 52min
completed: 2026-09-17
status: complete
---

# Phase 3 Plan 01: Согласие человека с судьёй Summary

**A one-key agreement mark now stores the judge verdict and judge version it answers, and the first block of every result surface reports «Согласие с судьёй: N из M проверенных» split by failures and sampled passes.**

## Performance

- **Duration:** 52 min
- **Started:** 2026-09-17T00:00:00Z (approximate — clock from the run)
- **Completed:** 2026-09-17
- **Tasks:** 3
- **Files modified:** 11 (2 created)

## Accomplishments

- A quick mark written through the lab travels all the way to `agent-lab summary`: the tracer test saves it with `ExperimentLab.addHumanReview` and reads the row back out of the spawned `dist/cli.js`.
- The lab, not the caller, decides which judgment a mark refers to. A forged `judge` snapshot is overwritten from `trial.judgeReceipt ?? trial.judgeAudit`; a mark off the primary metric, on an undecided judge, or against a verdict that has moved is refused with the contract's exact Russian words.
- The count is honest by construction: it reads `trial.assessments[].result`, so a disagreement on a failure gives `0 из 1` instead of the 100% that reading the overridden result would produce.
- Marks that no longer match the current judgment — different verdict, different judge hashes, or only present in `sourceEvidence.humanReviews` — are named as «отметки устарели после смены судьи», never silently counted or silently dropped.
- The pass sample is deterministic: all passes when there are at most three, otherwise three drawn by `fingerprint({ run, trial })`, identical after `structuredClone` and after a human flips a verdict.
- The F6 row obeys the band table at M = 0, 1, 2, 9, 10, 19 and 20, with no percent below ten checks and «мало проверок» below twenty.

## Task Commits

1. **Task 1 (tracer): a quick mark saved by the lab shows as the agreement row** — `24d245c` (feat)
2. **Task 2: the lab, not the caller, records which judgment the owner saw** — `5b48fe8` (feat, TDD)
3. **Task 3: the count follows the current judgment and the words follow the number of checks** — `25cb62a` (feat, TDD)

**Plan base:** `2a97189` (`plan_head_before`) · **Commits measured:** 3 (`git rev-list --count 2a97189..HEAD`)

## Files Created/Modified

- `src/agreement.ts` (new) — `judgeAgreement`, `agreementSample`, `PASS_SAMPLE` and the agreement types. Pure; imports only `contracts.js` and `outcomes.js`.
- `test/agreement.test.ts` (new) — counting rules, stale cases, control/workflow guards, sample determinism.
- `src/contracts.ts` — `judgeSnapshotSchema` and the three optional review fields, plus the quick-mark refinement.
- `src/outcomes.ts` — `primaryMetricId`.
- `src/result-view.ts` — `ResultView.agreement`, `PERCENT_FROM`, `agreementRows` wired between the control row and the coverage row.
- `src/experiment.ts` — the C-99…C-101 guards and the lab-written judge snapshot in `addHumanReview`.
- `test/result-view.test.ts` — the tracer CLI test, the F6 wording tests, and three deliberately updated blocks.
- `test/experiment.test.ts`, `test/contracts.test.ts`, `test/outcomes.test.ts`, `test/store.test.ts` — schema, primary-metric, lab-guard and reload coverage.

## Test expectations changed on purpose

| Test | Change | Why |
|---|---|---|
| `ACQUIRING_BLOCK` (`test/result-view.test.ts`) | `Согласие с судьёй: ещё не проверено.` inserted after `Контроль: не задан.` | The acquiring fixture has 11 queued failures and one sampled pass, so F6 is printed before the first mark. `ACQUIRING_BLOCK.at(-1)` still points at the coverage line. |
| `a passing control stays out of the headline and gets its own line` | same row appended | 9 failures and 3 sampled passes are a review queue. |
| `with nothing unmeasured there is no not-measured row and no situation row` | same row appended | 1 failure and 2 sampled passes are a review queue. |

No other test holds an exact copy of the first block; `scored(0, 0, 2)` and the never-run draft print no agreement row and were asserted to stay byte-identical.

## Decisions Made

- **The F6 parts count the group, not the queue.** The plan's tracer example asked for `провалы: 1 из 11`, i.e. agreed-out-of-queued. The approved UI-SPEC F6 table defines `b`/`a` as the failures group's `checked`/`agreed`, and its own examples only balance under that reading (`16 + 2 = 18 = N`, `17 + 3 = 20 = M`; the `3 из 4 … Человек не смог решить: 1` example is impossible under the queue reading). Implemented per the UI-SPEC.
- **A quick mark on a now-undecided metric is stale, not invisible.** This is what makes «только устаревшие отметки при пустой очереди» reachable at all, and it matches the `must_haves` wording «marks whose `judgeVerdict` … differ from the current trial go to `stale`».
- **Every metric review carries the judge snapshot,** not only quick marks, so 03-02 and the later board plans can tell which judgment any human verdict argued with without re-deriving it.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The plan's tracer expectation `провалы: 1 из 11` contradicts the UI-SPEC and its own examples**

- **Found during:** Task 1 (tracer)
- **Issue:** The plan's Task 1 action and acceptance criterion require the CLI block to read `провалы: 1 из 11 · успехи ещё не проверены`, reading `b` as the queue size. The approved 03-UI-SPEC F6 part table defines `failPart` as `провалы: <a> из <b>` where `b` is the failures group's `checked`, with `Q_fail` a separate term used only to choose between «ещё не проверены» and «провалов нет». Under the queue reading the UI-SPEC's own `3 из 4 проверенных … (провалы: 3 из 4 …)` + `Человек не смог решить: 1` example is arithmetically impossible (5 marks on 4 queued failures with no passes).
- **Fix:** Implemented `a`/`b` as agreed/checked inside the group. The tracer test asserts `Согласие с судьёй: 1 из 1 проверенных · мало проверок (провалы: 1 из 1 · успехи ещё не проверены).` and separately asserts the queue really holds 11 failures and one sampled pass, so the fact the plan wanted to pin is still pinned.
- **Files modified:** src/result-view.ts, test/result-view.test.ts
- **Verification:** `test/result-view.test.ts#a quick mark saved by the lab shows as the agreement row in the CLI summary` plus the M = 10/19/20 band cases, which only balance under this reading.
- **Committed in:** `24d245c` and `25cb62a`
- **Unmet acceptance criterion:** Task 1's `test/result-view.test.ts contains "провалы: 1 из 11 · успехи ещё не проверены"` is intentionally not satisfied. Every other acceptance criterion of all three tasks passes.

**2. [Rule 2 - Missing critical] A quick mark on a metric the judge no longer decides had nowhere to go**

- **Found during:** Task 3
- **Issue:** The Task 1 draft skipped any mark whose recorded base was not `pass`/`fail`. That makes the required F6 case «only stale marks with an empty queue» unreachable and silently loses a mark on a record whose reassessment turned the verdict into `unknown` — exactly the v10→v11 case the stale row exists for.
- **Fix:** `situations(record)` now yields every non-control trial that has a primary metric, decided or not; a mark whose `judgeVerdict` no longer equals the recorded base is stale. `AgreementMark.judge` reports the judgment the person was shown.
- **Files modified:** src/agreement.ts
- **Verification:** `test/agreement.test.ts#only stale marks with an empty queue still report themselves`, `test/result-view.test.ts#stale marks alone report themselves…`
- **Committed in:** `25cb62a`

**3. [Rule 3 - Blocking] Acceptance grep for `kappa` matched an explanatory comment**

- **Found during:** Task 3
- **Issue:** `cat src/agreement.ts src/result-view.ts | grep -Eic 'kappa|каппа'` returned 1 — a doc comment saying «no kappa or error matrix is shown».
- **Fix:** Reworded the comment to «no statistical coefficient or confusion matrix is shown». The gate now reads 0 and the meaning is unchanged.
- **Files modified:** src/result-view.ts
- **Verification:** the grep returns 0; the suite re-run exits 0.
- **Committed in:** `25cb62a`

---

**Total deviations:** 3 auto-fixed (1 bug in the plan's expected text, 1 missing critical case, 1 blocking gate wording)
**Impact on plan:** No scope creep. Deviation 1 changes one asserted string and one acceptance criterion; deviations 2 and 3 are inside the plan's own contract.

## Issues Encountered

- **The GSD commit ledger name is not unique across milestones.** `$GIT_DIR/gsd-plan-head-before-03-01` already existed from 2026-09-15 (an earlier milestone also had a plan `03-01`), so the `[ -f ] ||` guard reused a stale base and `git rev-list --count` reported 192 commits. Corrected by re-pointing the ledger at the real pre-plan HEAD `2a97189`; the measured count is 3. Worth knowing for any later plan whose `{phase}-{plan}` pair repeats.
- **`repeats = 1` is assumed.** The unit of agreement is one trial. This is written into the `src/agreement.ts` header as a known limitation, as the plan requires.
- **Judge v11 preconditions were not applicable.** The run context confirms the v11 rollback: `judgedCut`, `judgedBeforeSeq`, `cutBefore` and goal-v2 do not exist, and no part of this plan referenced them. The protocol stays v10 and frozen; nothing in this plan touched it.
- **No paid calls were made.** Every test runs against fixtures, the demo runtime or the built `dist/cli.js` inside a `git ls-files` snapshot; the acquiring agent was never started.

## Known Stubs

None. Every symbol this plan promised is wired to real data and covered by a passing test.

## Threat Flags

None — no new network endpoint, auth path, file access pattern or trust-boundary schema change beyond the review fields the plan's own threat register already covers (T-03-01…T-03-05, all mitigated and tested).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `judgeAgreement(record)` is the single source for the queue (`queueFailures`), the sample (`sampledPasses`), the unanswered list (`unmarked`) and the disagreement rows, so 03-02 (`awaitingVerdict` / `humanFindings`) and 03-04…03-06 (board keys, F7, F11) can consume it without recomputing anything.
- The F6 rows use the phase-2 roles `line`/`detail`; 03-06 is expected to give them their own roles and board colours.
- Open for the phase-level check: the live read of the agreement row on a real acquiring run in Pi (coverage D9).

---
*Phase: 03-soglasie-cheloveka-s-sudey*
*Completed: 2026-09-17*

## Self-Check: PASSED

- `src/agreement.ts`, `test/agreement.test.ts` and this SUMMARY exist on disk.
- Commits `24d245c`, `5b48fe8`, `25cb62a` exist; `git rev-list --count 2a97189..HEAD` = 3, matching `commits: 3`.
- Full snapshot suite (`snap-test.sh`, no arguments — every test plus the extension typecheck) exits 0: `# tests 475 / # pass 475 / # fail 0`.

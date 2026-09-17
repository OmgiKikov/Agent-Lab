---
phase: 03-soglasie-cheloveka-s-sudey
plan: 02
subsystem: testing
tags: [agreement, headline, review-queue, human-review, quick-mark]

requires:
  - phase: 03-soglasie-cheloveka-s-sudey
    plan: 01
    provides: "`source: 'quick'` / `judgeVerdict` / `judge` on a review, `primaryMetricId`, the lab-side C-99…C-101 guards, `judgeAgreement` and the F6 rows"
provides:
  - "The headline rule for quick marks: «не согласен» recounts it, «не могу сказать» leaves the judge's verdict in place"
  - "`trialAssessmentComplete` ignores a quick «не могу сказать» and falls back to the recorded judge result"
  - "`trialReasons` never names a quick unsure as «человек не смог решить»"
  - "`awaitingVerdict`: one decided quick mark on the primary metric closes the situation"
  - "`humanFindings`: a quick agreement is not a «замечание человека»; a quick disagreement still is"
affects: [03-03, 03-04, 03-05, 03-06]

actuals:
  tokens: 5874
  tasks: 2
  commits: 4

tech-stack:
  added: []
  patterns:
    - "A one-key answer carries its own authority: decided means «I looked and decided», unsure means «the judge's word stands»"
    - "The queue gate reads the primary metric only — secondary criteria and exact checks never re-open a situation the owner has already answered"
    - "A human mark that merely confirms the automatic result is not reported back as a human remark"

key-files:
  created: []
  modified:
    - src/outcomes.ts
    - src/comparison.ts
    - test/outcomes.test.ts
    - test/result-view.test.ts
    - test/comparison.test.ts

key-decisions:
  - "The quick-mark gate in `awaitingVerdict` sits after the simulator block and before `isAgentFailure`, so a pending simulator decision always wins over an agent-side mark"
  - "A quick unsure that supersedes an earlier full verdict falls back to the judge's recorded result, not to the earlier human verdict — the latest review wins and a quick unsure means «оценка судьи остаётся»"
  - "`humanFindings` skips a quick mark only when it is not a disagreement, so the skip is computed from `disagreement`, never from the verdict alone"

patterns-established:
  - "Pattern: `review?.source === 'quick' && review.verdict === 'unknown'` written inline at each decision point in outcomes.ts, so every reader of the override sees the exception where it applies"
  - "Pattern: the CLI end-to-end pair — one helper writes a single quick mark through `ExperimentLab` into a fresh tmp store and reads the block back out of the spawned `dist/cli.js`"

requirements-completed: [JUDGE-04, JUDGE-05]

coverage:
  - id: D1
    description: "A quick «не могу сказать» leaves the judge's failure in the metric override, in `agentRubricResult`, in `automaticTrialResult` and in `trialAssessmentComplete`; a full review that says `unknown` still overrides as before"
    requirement: JUDGE-04
    verification:
      - kind: unit
        ref: "test/outcomes.test.ts#a quick «не могу сказать» leaves the judge result in place, a full one still overrides it"
        status: pass
    human_judgment: false
  - id: D2
    description: "A quick «не согласен» on a recorded failure moves the headline of `agent-lab summary` to `Справился в 1 из 9 проверенных ситуаций — 11%.` while the agreement row reads `0 из 1`"
    requirement: JUDGE-04
    verification:
      - kind: e2e
        ref: "test/result-view.test.ts#a quick «не согласен» moves the headline and is counted against the judge"
        status: pass
    human_judgment: false
  - id: D3
    description: "A quick «не могу сказать» keeps the headline at `0 из 9`, adds no `человек не смог решить` reason, leaves the not-measured rows untouched and only adds `  Человек не смог решить: 1.`"
    requirement: JUDGE-04
    verification:
      - kind: e2e
        ref: "test/result-view.test.ts#a quick «не могу сказать» leaves the judge failure in the number and only counts itself"
        status: pass
    human_judgment: false
  - id: D4
    description: "One decided quick mark on the primary metric removes the trial from `awaitingVerdict` even when another agent criterion and an exact check failed; an unsure mark, a pending simulator check and a later full `unknown` review all keep it waiting; a card with no goal rubric resolves on its first failed agent rubric"
    requirement: JUDGE-05
    verification:
      - kind: unit
        ref: "test/comparison.test.ts#a decided quick mark on the main verdict closes the situation, an unsure one keeps it waiting"
        status: pass
    human_judgment: false
  - id: D5
    description: "`humanFindings` reports no finding for a quick agreement, one finding with `disagreement: true` and the owner's note for a quick disagreement, and a full review as before; `verdictSummary(record).review.flagged` counts the objection alone"
    requirement: JUDGE-05
    verification:
      - kind: unit
        ref: "test/comparison.test.ts#a quick agreement is not a human remark, a quick disagreement still is"
        status: pass
    human_judgment: false
  - id: D6
    description: "The owner marking a real acquiring run in Pi: that «не согласен» visibly recounts the number in front of him and «не могу сказать» visibly does not"
    verification: []
    human_judgment: true
    rationale: "Whether the recount reads as honest rather than as a moved goalpost is a judgment on a live session with the acquiring agent; the keys and the board land in 03-04…03-06, so the live read belongs to the phase-level check."

duration: ~30 min
completed: 2026-09-17
status: complete
---

# Phase 3 Plan 02: Согласие человека с судьёй Summary

**«Не согласен» пересчитывает главное число, «не могу сказать» оставляет в нём вердикт судьи и только считается отдельно, а одна решённая отметка на главной оценке закрывает ситуацию в разборе.**

## Performance

- **Duration:** ~30 min (approximate — no explicit start stamp; first task commit at 15:12, last verification at 15:22 local)
- **Completed:** 2026-09-17
- **Tasks:** 2
- **Files modified:** 5 (0 created)

## Accomplishments

- The owner's doubt can no longer launder a failure out of the headline. A one-key «не могу сказать» is skipped by the metric override, by `agentRubricResult`, by `automaticTrialResult`, by `trialAssessmentComplete` and by `trialReasons` — the judge's `fail` stays exactly where it was. A full review that says `unknown` behaves as it always did.
- The owner's disagreement does move the number, end to end. A quick `pass` on `t-fail0` written through `ExperimentLab.addHumanReview` and read back out of the spawned `dist/cli.js` turns `Справился в 0 из 9 проверенных ситуаций — 0%.` into `Справился в 1 из 9 проверенных ситуаций — 11%.`, and the same block reports `Согласие с судьёй: 0 из 1 проверенных · мало проверок (провалы: 0 из 1 · успехи ещё не проверены).` — the disagreement counts against the judge in the very row that measures him.
- The unsure case is pinned as a whole-block equality: the CLI block is the untouched `ACQUIRING_BLOCK` with exactly one row added, `  Человек не смог решить: 1.`. Headline, not-measured rows and their reasons are asserted byte-identical, so a future change that quietly reclassifies the card fails the test.
- One mark finishes one situation. A quick `pass` or `fail` on the primary metric drops the trial out of `awaitingVerdict` even though a second agent criterion and an exact check also failed — the owner answered the main question, and the review does not re-ask it three more ways.
- What the mark does *not* cover stays open: an undecided simulator check keeps the dialogue in the queue (the simulator is judged separately), a quick unsure keeps it there, and a later full review that says `unknown` supersedes the mark and re-opens it.
- Agreeing with the judge stopped counting as a complaint. A quick `fail` that confirms a recorded `fail` produces no `HumanFinding` and leaves `review.flagged` at 0; only the objection — a quick `fail` against a recorded `pass` — is reported, with the owner's own note, and it alone is counted.

## Task Commits

1. **Task 1 (tracer): doubt leaves the judge verdict, disagreement moves the number** — `de0e074` (feat)
2. **Task 2 RED: failing tests for the quick mark in the review queue** — `f3e8004` (test)
3. **Task 2 GREEN: one decided mark closes the situation, agreeing is not a remark** — `10af194` (feat)

**Plan base:** `f17fd52a` (`plan_head_before`) · **Commits measured:** 4 (`git rev-list --count f17fd52a..HEAD`)

The measured count is 4 because a concurrent session on this shared worktree committed `dae2967` (`docs: insert phase 03.1 …`) onto the same branch between this plan's second and third commits. Three of the four commits are this plan's; `dae2967` touches only `.planning/phases/03.1-…` and no source or test file. The frontmatter keeps the measured number so `/gsd-verify-work` re-measures the same value.

## TDD Gate Compliance

| Gate | Commit | Evidence |
|---|---|---|
| RED | `f3e8004` `test(03-02): …` | `check tdd-red-evidence` → `RED_EVIDENCE_OK` / `target_test_failed`; run reported `# tests 30 / # pass 28 / # fail 2`, target test `a decided quick mark on the main verdict closes the situation, an unsure one keeps it waiting` failed on `1 !== 0` |
| GREEN | `10af194` `feat(03-02): …` | `snap-test.sh test/comparison.test.ts` → `# tests 30 / # pass 30 / # fail 0` |
| REFACTOR | — | Not needed: the two additions are three and two lines, each at the decision point it belongs to |

Task 1 is a `type="tracer"` task, not a TDD task; its tests were written before the implementation but it is one production-quality commit by design. The tracer feedback gate re-ran its `<verify>` end-to-end before the expansion task (`human_verify_mode: end-of-phase`, automated-only verify): `# tests 107 / # pass 107 / # fail 0` across `outcomes`, `result-view`, `comparison` and `agreement`.

## Files Created/Modified

- `src/outcomes.ts` — the quick-unsure exception in `agentMetricResult` (with the doc comment that names it) and the same skip in `trialAssessmentComplete`.
- `src/comparison.ts` — `primaryMetricId` added to the existing `./outcomes.js` import; the quick-unsure guard in `trialReasons`; the quick-resolution block in `awaitingVerdict`; the quick-agreement skip in `humanFindings`.
- `test/outcomes.test.ts` — the unit pair for the override, the rubric roll-up, completeness and the supersede case.
- `test/result-view.test.ts` — the 03-01 tracer refactored into the `quickMarked()` helper plus two new end-to-end tests (disagree, unsure), each on its own tmp store.
- `test/comparison.test.ts` — the `awaitingVerdict` and `humanFindings` tests for quick marks.

## Verification

| Check | Result |
|---|---|
| Task 1 `<verify>`: `snap-test.sh test/outcomes.test.ts test/result-view.test.ts test/comparison.test.ts test/agreement.test.ts` | `# tests 107 / # pass 107 / # fail 0`, exit 0, no tsc error |
| Task 2 `<verify>` and plan `<verification>`: `snap-test.sh` (no arguments — every test plus the extension typecheck) | `# tests 480 / # pass 480 / # fail 0`, exit 0 |
| `grep -c "source === 'quick'" src/outcomes.ts` | `2` (≥ 2 required) |
| `grep -E "import .*primaryMetricId.*from './outcomes.js'" src/comparison.ts \| wc -l` | `1` |
| `grep -c "from './agreement.js'" src/comparison.ts` | `0` |
| `grep -c "primaryMetricId(" src/comparison.ts` | `1` (≥ 1 required) |
| `test/result-view.test.ts` contains `Справился в 1 из 9 проверенных ситуаций — 11%.` / `Человек не смог решить: 1.` | present (1 / 3 occurrences) |
| Named quick tests for `awaitingVerdict` and `humanFindings` in `test/comparison.test.ts` | both present |

Every acceptance criterion of both tasks passes.

## Decisions Made

- **The quick gate sits between the simulator block and `isAgentFailure`.** Placed earlier it would have swallowed a pending simulator decision; placed later it would never fire, because `isAgentFailure` reads the human-overridden rubric and a quick disagreement already flips that to `pass`. The plan specified this position and the tests pin both ends of it.
- **`humanFindings` keys the skip on `disagreement`, not on the verdict.** A quick mark is only silent when it agrees with what the automatic evidence recorded; the same mark against a different automatic result is still a finding. That keeps the rule true for the pass-side objection (`fail` against a recorded `pass`), which is the one that must reach `review.flagged`.
- **The unsure end-to-end case asserts the whole block, not a substring.** `resultViewLines` on the stored record is compared with `ACQUIRING_BLOCK` plus the single tail row, so the test fails if a quick unsure ever again reclassifies the card, changes the reason counts or reorders the first block.

## Deviations from Plan

None — the plan executed exactly as written. Both tasks' files, edits and assertions match the plan's `<action>` blocks; the one unmet-criterion carried over from 03-01 (the `провалы: 1 из 11` wording) was already resolved there and is not touched here.

One test-authoring detail worth recording, inside the plan's own contract rather than a deviation: the simulator case of the `awaitingVerdict` test first failed because the shared `trial()` fixture builds a dialogue with no simulator turn, so `simulatorWasUsed` was false and the pending-simulator block never ran. The fixture now passes `dialogue(['hello'], 'continue')`, which is what makes the case the one the plan describes.

## Authentication Gates

None — no credentials, no external service, no paid model call. Every test runs against fixtures and the built `dist/cli.js` inside a `git archive`-style snapshot; the acquiring agent was never started.

## Issues Encountered

- **A concurrent session committed to this branch mid-plan.** `dae2967` landed between `f3e8004` and `10af194`, which is why the ledger-measured commit count is 4 rather than 3. The shared-worktree constraint in CLAUDE.md is real; any later plan reading `git rev-list --count` on this branch should expect the same.
- **`.planning/STATE.md` arrived already modified** and `.planning/phases/03.1-…/` is untracked from that other session. Neither was touched by this plan's task commits.

## Known Stubs

None. Every behaviour this plan promised is wired to real data and covered by a passing test; nothing was left returning a placeholder.

## Threat Flags

None. T-03-06 (headline gamed with «не могу сказать») and T-03-07 (finalize gate passed without looking at a failure) are both mitigated and tested here — the first by the override/`trialAssessmentComplete`/`trialReasons` skips plus the end-to-end CLI assertion, the second by the primary-metric-only gate that leaves unsure marks and simulator decisions pending. No new network endpoint, auth path, file access pattern or trust-boundary schema change.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- The headline and queue rules are settled, so 03-03…03-06 can build the keys, the board and the finalize confirmation on top of them without re-deciding what a mark means.
- F9 (03-04) should state in the confirmation what a decided mark covers: the main verdict of the situation, not its secondary criteria and not the simulator.
- Open for the phase-level check: coverage D6 — the live read on a real acquiring run in Pi, where the owner watches his own «не согласен» move the number.

---
*Phase: 03-soglasie-cheloveka-s-sudey*
*Completed: 2026-09-17*

## Self-Check: PASSED

- `src/outcomes.ts`, `src/comparison.ts`, `test/outcomes.test.ts`, `test/result-view.test.ts`, `test/comparison.test.ts` and this SUMMARY exist on disk.
- Commits `de0e074`, `f3e8004`, `10af194` exist in `git log`; `git rev-list --count f17fd52a..HEAD` = 4, matching `commits: 4` (three of them this plan's, see Task Commits).
- Full working-tree snapshot suite (`snap-test.sh`, no arguments — every test plus the extension typecheck) exits 0: `# tests 480 / # pass 480 / # fail 0`.

---
phase: 01-chestnyy-chelovecheskiy-razbor
plan: 02
subsystem: review
tags: [typescript, human-review, quality, pi-extension]

requires:
  - phase: 01-01
    provides: "Review-aware automatic outcomes and latest human metric verdict precedence"
provides:
  - "Strict explicit whole-dialogue review marker and K-of-D progress counter"
  - "Combined automatic pass, undecided, not-reached, and human-review headline"
  - "Single-dialogue native review form with current-event evidence guard"
affects: [reporting, review, extensions, persistence]

actuals:
  tokens: 9288
  tasks: 2
  commits: 5
plan_head_before: 890dabc76a646b4ffad90573522fd434499b37f4

tech-stack:
  added: []
  patterns:
    - "Only the latest explicitly marked whole-dialogue review certifies a dialogue as reviewed"
    - "Aggregate causes navigate to independently reviewed dialogues and never define write scope"

key-files:
  created:
    - test/helpers/demo-record.ts
  modified:
    - src/contracts.ts
    - src/quality.ts
    - extensions/agent-lab.ts
    - test/contracts.test.ts
    - test/quality.test.ts
    - test/extension.test.ts
    - test/cards.test.ts

key-decisions:
  - "Complete review is represented by reviewedDialogue: true only on a whole-dialogue verdict; omission stays distinguishable for legacy records."
  - "A complete native review must cite an event from the current dialogue and can persist at most one review for that dialogue."

patterns-established:
  - "Automatic coverage and complete human review are reported together but counted independently."

requirements-completed: [HREV-02, HREV-03, HREV-04, HREV-05, HREV-06]

coverage:
  - id: D1
    description: "Only the latest explicitly marked whole-dialogue verdict counts as a complete review."
    requirement: HREV-02
    verification:
      - kind: integration
        ref: "test/quality.test.ts#only the latest marked whole-dialogue review certifies a complete persisted review"
        status: pass
    human_judgment: false
  - id: D2
    description: "A native review action writes at most one verdict for the currently shown dialogue."
    requirement: HREV-03
    verification:
      - kind: integration
        ref: "test/extension.test.ts#conversation completes human finding → prompt diff → unchanged SQLite suite → comparison"
        status: pass
    human_judgment: false
  - id: D3
    description: "The first-screen headline separates passed, undecided, not-reached, and human-reviewed counts."
    requirement: HREV-04
    verification:
      - kind: unit
        ref: "test/quality.test.ts#the first screen separates reached undecided cards, not-reached cards, and all current dialogues"
        status: pass
    human_judgment: false
  - id: D4
    description: "Aggregate causes remain a queue to review each constituent dialogue separately."
    requirement: HREV-05
    verification:
      - kind: unit
        ref: "test/quality.test.ts#the first screen separates reached undecided cards, not-reached cards, and all current dialogues"
        status: pass
    human_judgment: false
  - id: D5
    description: "A whole-dialogue verdict is complete only when its note cites an existing current event sequence."
    requirement: HREV-06
    verification:
      - kind: integration
        ref: "test/extension.test.ts#conversation completes human finding → prompt diff → unchanged SQLite suite → comparison"
        status: pass
    human_judgment: false

duration: 13min
completed: 2026-09-15
status: complete
---

# Phase 1 Plan 2: Honest Per-Dialogue Human Review Summary

**The first screen now reports automatic coverage beside strict human K-of-D progress, while every native review remains attached to one event-grounded dialogue.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-09-15T11:32:08Z
- **Completed:** 2026-09-15T11:45:28Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments

- Added a backward-compatible `reviewedDialogue: true` marker that is valid only for whole-dialogue reviews and counted using latest-review precedence.
- Separated reached-but-undecided cards from cards that were not reached, and rendered both beside complete human-review progress.
- Removed grouped review targets and fan-out; a successful native action now produces at most one review for the displayed dialogue.
- Required a valid current `#seq` reference before a whole-dialogue verdict can certify complete review.

## Task Commits

1. **Task 1 RED:** `e1fe0dc` (test)
2. **Task 1 GREEN:** `af9e93f` (feat)
3. **Task 2 RED:** `ad1cab1` (test)
4. **Task 2 GREEN:** `13093d3` (feat)
5. **Deviation fix:** `bd5a15c` (test)

## Files Created/Modified

- `src/contracts.ts` - Compatible whole-dialogue marker and partial-target rejection.
- `src/quality.ts` - Human K/D, not-reached cards, combined headline, and separate-dialogue queue copy.
- `extensions/agent-lab.ts` - Current-dialogue targets, single review output, and event-reference guard.
- `test/helpers/demo-record.ts` - Real demo-evaluate record fixture with caller-owned cleanup.
- `test/contracts.test.ts` - Input and persisted schema regressions.
- `test/quality.test.ts` - Latest-marker, reachability, headline, and cause-queue regressions.
- `test/extension.test.ts` - Native form persistence, isolation, cancellation, and evidence journey.
- `test/cards.test.ts` - Board expectation aligned with the D-03 reachability split.

## Decisions Made

- Kept `reviewedDialogue` optional with no default so old records remain readable without being mistaken for certified reviews.
- Reused the persisted review index, current review ordering, and `ExperimentLab.addHumanReview`; no new storage or grouping path was added.
- Counted every current observed trial in the human denominator, including invalid or cancelled trials.

## TDD Gate Compliance

- Both tasks produced intentional failing regressions classified `RED_EVIDENCE_OK` before production edits.
- Commit order is RED → GREEN for each task; no refactor commit was needed.
- Task verification, the tracer feedback gate, and the 95-test plan regression suite all pass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated the board assertion for the new reached/not-reached split**
- **Found during:** Overall plan verification
- **Issue:** `test/cards.test.ts` still expected both non-passing cards to be reported as undecided, contradicting D-03 after `cards.notReached` was introduced.
- **Fix:** Changed only that assertion to expect one undecided card, one not-reached card, and the human 0-of-3 counter.
- **Files modified:** `test/cards.test.ts`
- **Commit:** `bd5a15c`

## Issues Encountered

None after the directly caused stale assertion was corrected.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 01 is complete: later phases can rely on independently attributable human reviews and an honest first-screen coverage summary.

---
*Phase: 01-chestnyy-chelovecheskiy-razbor*
*Completed: 2026-09-15*

## Self-Check: PASSED

- All eight created or modified source and test files exist.
- All five task and deviation commits are present in git history.
- Coverage metadata classifies HREV-02 through HREV-06 as automatically passed.

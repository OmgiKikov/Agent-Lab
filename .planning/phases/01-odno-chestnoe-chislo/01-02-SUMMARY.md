---
phase: 01-odno-chestnoe-chislo
plan: 02
subsystem: pi-surfaces
tags: [pi-extension, board, result-view]

requires:
  - phase: 01-01
    provides: "buildResultView, resultViewLines, ResultView (src/result-view.ts)"
provides:
  - "summary() tool payload carries `view` and `viewLines` (block only) for runs with trials"
  - "Collapsed Pi tool result opens with viewLines in the brief, proofs and default branches"
  - "EvidenceBundle.view (optional; readers fall back to buildResultView(record))"
  - "BoardOptions.view; LabBoard.viewFor(record) uses it only for the same run id; refresh replaces it"
  - "verdictLines(record, expanded, comparison, view) and verdictHeadline(view)"
  - "pi-surface-check.mts: read-only CLI / payload / render / board equality check, prints ids and counts only"
affects: [01-05, 01-07, 04-screen, 05-report]

plan_head_before: 9059775e3b930428559306f01d725940e601a012
actuals:
  tokens: 8200
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Pi surfaces print ResultView lines verbatim; a view is trusted only when view.runId equals the shown record id"
    - "Cross-surface checks compare by line index and print only OK/DIFF with counts"

key-files:
  created:
    - .planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts
  modified:
    - extensions/agent-lab.ts
    - extensions/cards.ts
    - src/artifacts.ts
    - test/extension.test.ts
    - test/cards.test.ts

key-decisions:
  - "The board keeps v.headline as its only first line while no trial is measured; with measured trials the first block is exactly resultViewLines(view)"
  - "EvidenceBundle.view is also serialized by jsonReport (additive `view` key in the JSON snapshot)"

patterns-established:
  - "Board block equality is checked as whole cells after removing the frame and sidebar separators"

requirements-completed: [TRUST-01, TRUST-02, TRUST-03]

coverage:
  - id: D1
    description: "Tool payload viewLines, collapsed tool result and CLI summary block are identical for the same record"
    requirement: TRUST-01
    verification:
      - kind: unit
        ref: "test/extension.test.ts#Pi inspect payload, its collapsed result and CLI summary open with the same ResultView block"
        status: pass
      - kind: other
        ref: "pi-surface-check.mts --id fae4ee59… --id a92fd6ae… → OK surfaces=3 lines=5 (both)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Collapsed board ИТОГ block equals resultViewLines, title is «Итог: <headline> · 1 подробнее», no single-trial НЕ ИЗМЕРЕНО note"
    requirement: TRUST-02
    verification:
      - kind: unit
        ref: "test/cards.test.ts#the board overview shows the ResultView block verbatim and no private not-measured count"
        status: pass
    human_judgment: false
  - id: D3
    description: "A view of another run is ignored; refresh replaces the view together with the record"
    requirement: TRUST-01
    verification:
      - kind: unit
        ref: "test/cards.test.ts#the board uses a supplied view only for the same run; #after refresh the board shows the refreshed bundle view"
        status: pass
    human_judgment: false
  - id: D4
    description: "How the new block looks on the live Pi screen"
    verification: []
    human_judgment: true
    rationale: "No Pi session runs during the autonomous run; the live look is deferred to phase 4 (SCREEN-01)"

duration: 5min
completed: 2026-09-17
status: complete
---

# Phase 1 Plan 02: Pi surfaces show the ResultView block Summary

**The Pi tool result, its JSON payload (`viewLines`) and the collapsed `/agent-lab` board now open with the same ResultView lines as CLI `summary`. On stored runs fae4ee59 and a92fd6ae the read-only checker prints `OK surfaces=3 lines=5` for both.**

## Performance

- **Duration:** about 5 min
- **Started:** 2026-09-16T21:21:10Z
- **Completed:** 2026-09-16T21:25:43Z
- **Tasks:** 2/2
- **Files modified:** 6 (1 created, 5 modified)

## Accomplishments

- `summary()` adds `view` and `viewLines` when the run has trials. `renderResult` (collapsed) puts that block first in all three branches, and everything still goes through `safeText`.
- The collapsed ИТОГ block on the board is now `resultViewLines(view)`: the first line is bold, the rest are muted. The title is `Итог: <view.headline.text> · 1 подробнее`. The «НЕ ИЗМЕРЕНО» note that picked the first invalid trial is gone. Metric bars, causes, the queue, the next step, scope and limits stay below the block.
- `evidenceBundle` builds `view` once, and the `/agent-lab` loop passes `view: bundle?.view` to the board.
- Checker output, ids and counts only:
  - `OK surfaces=3 lines=5 id=fae4ee59`
  - `OK surfaces=3 lines=5 id=a92fd6ae`
- The full snapshot suite passes (350/350), and so does the extension typecheck. The worktree `dist/` mtime is unchanged (1789573214).

## Task Commits

1. **Task 1 (tracer): Pi tool result opens with the CLI ResultView block**: `1280fe2` (feat). Tracer gate: `<verify>` was re-run end-to-end and passed (`OK surfaces=2 lines=5 id=fae4ee59`, 27/27).
2. **Task 2: /agent-lab board shows the ResultView block and title**: `734dfc9` (test, RED), `c9fc9b9` (feat, GREEN)

## Files Created/Modified

- `extensions/agent-lab.ts`: imports from `dist/result-view.js`. Adds the `view`/`viewLines` payload, puts the block first in `renderResult`, and passes `view` to the board.
- `extensions/cards.ts`: adds `BoardOptions.view` and `viewFor`, the ResultView block in `verdictLines`, `verdictHeadline(view)`, and makes `refresh` take the view.
- `src/artifacts.ts`: adds `EvidenceBundle.view`.
- `test/extension.test.ts`: one test comparing the payload, the collapsed render and a CLI spawn.
- `test/cards.test.ts`: three behavior tests. The title assertion is now computed from the view, and the old headline assertion is now a metric-bar assertion.
- `.planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts`: the read-only checker for four surfaces (CLI plus three compared surfaces)

## TDD Gate Compliance

- RED `734dfc9`: 4 tests failed on the old board. Three are new, and one is the updated title assertion. The failures were for the intended reasons (for example, «board misses block line»).
- GREEN `c9fc9b9`: 35/35 in the targeted snapshot run and 350/350 in the full run.
- REFACTOR: nothing to change.

## Decisions Made

See key-decisions in the frontmatter.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] An existing board test asserted the removed headline**
- **Found during:** Task 2 (GREEN)
- **Issue:** `the board leads with a plain verdict…` matched «По кодовым проверкам пройдено 2 из 3». That text came from the `verdictSummary` headline, which CTX-06 removes from the first block.
- **Fix:** The test now asserts that the same score appears in the metric bar below the block (`Точные проверки · код · 2/3`) and that the view headline is shown.
- **Files modified:** test/cards.test.ts
- **Commit:** c9fc9b9

**2. [Rule 1 - Bug] The new «no private count» test was too broad**
- **Found during:** Task 2 (GREEN)
- **Issue:** The invalid trial's reason also appears in the «Дальше:» next-step line. The plan keeps that line as a detail below the block.
- **Fix:** The test now asserts that the removed `<title>: <reason>` line is absent, instead of checking for any mention of the reason.
- **Files modified:** test/cards.test.ts
- **Commit:** c9fc9b9

---

**Total deviations:** 2 auto-fixed (Rule 1, both test-side).
**Impact on plan:** None on the code. Scope did not grow.

## Issues Encountered

- A plan ledger file was left over from an earlier attempt and pointed at an unrelated commit. I reset it to HEAD `9059775` before the first commit.
- Acceptance grep `grep -c viewLines extensions/agent-lab.ts` gives 2 lines, not 3. The brief and default branches use a local `block` derived from `data.viewLines` on one line, so all three branches do render the block (tests and checker prove it).

## User Setup Required

None.

## Next Phase Readiness

- 01-05 can pass `before` into `buildResultView` inside `evidenceBundle`. The board and tool read the view from the bundle or the payload.
- 01-07 (report.ts) can read `bundle.view ?? buildResultView(bundle.record)`.
- The expanded board branch still shows the old `verdictSummary` headline, as the plan requires for this phase.

## Self-Check: PASSED

- FOUND: pi-surface-check.mts, 01-02-SUMMARY.md
- FOUND commits: 1280fe2, 734dfc9, c9fc9b9

---
*Phase: 01-odno-chestnoe-chislo*
*Completed: 2026-09-17*

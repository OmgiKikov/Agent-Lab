---
phase: 03-poleznyy-test-i-ego-prinyatie
plan: 02
subsystem: reporting
tags: [typescript, quality-summary, rubrics, product-language]
requires:
  - phase: 02-ponimanie-agenta-i-gipoteza
    provides: grounded reserved rubrics and the conversational hypothesis gate
  - phase: 03-poleznyy-test-i-ego-prinyatie
    provides: strict one-test generation from plan 03-01
provides:
  - stable first-screen rows for goal_attainment, prompt_compliance and reply_quality
  - full-definition isolation for owner-defined rubric rows
  - exact-hash accept-or-edit guidance using test and business-scenario-card terminology by audience
affects: [03-03, 03-04, phase-4]
actuals:
  tokens: 5994
  tasks: 2
  commits: 3
plan_head_before: e6b4a68f2a4c465879fe3771a1910bfff1e11b6c
tech-stack:
  added: []
  patterns: [reserved-id row identity, owner-rubric fingerprint identity, audience-specific product language]
key-files:
  created: []
  modified: [src/quality.ts, test/quality.test.ts, skills/agent-builder/SKILL.md, docs/PILOT.md]
key-decisions:
  - "Only goal_attainment, prompt_compliance and reply_quality use stable ID row identity; owner rubrics retain full fingerprints."
  - "Owner interaction says test, while stored and technical contracts say business-scenario card; acceptance never implies execution or a result verdict."
patterns-established:
  - "Reserved service metrics aggregate across generated wording drift without weakening stored rubric definitions."
requirements-completed: [CARD-05, CARD-06]
coverage:
  - id: D1
    description: "Reserved rubric IDs share one first-screen row while owner definitions merge only when identical."
    requirement: CARD-05
    verification:
      - kind: unit
        ref: "test/quality.test.ts#reserved rubric ids share stable rows while owner rubrics require identical definitions"
        status: pass
      - kind: unit
        ref: "test/quality.test.ts#metric rows use the same human criterion verdict as card outcomes"
        status: pass
    human_judgment: false
  - id: D2
    description: "Live builder and pilot guidance distinguish owner-facing tests from stored business-scenario cards and exact-hash acceptance from execution."
    requirement: CARD-06
    verification:
      - kind: other
        ref: "scoped terminology audit over skills/agent-builder/SKILL.md and docs/PILOT.md"
        status: pass
      - kind: unit
        ref: "test/skill.test.ts#agent-builder stops at one grounded hypothesis until the owner answers"
        status: pass
    human_judgment: false
duration: 14min
completed: 2026-09-15
status: complete
---

# Phase 03 Plan 02: Stable Rubric Rows and Test Language Summary

**Reserved service rubrics now keep one first-screen row per run, while owner criteria retain exact-definition identity and live guidance binds test acceptance to the displayed hash without implying execution.**

## Performance

- **Duration:** 14 min
- **Started:** 2026-09-15T19:40:08Z
- **Completed:** 2026-09-15T19:54:43Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Added public `qualitySummary()` regression coverage and stable row keys for the three reserved agent rubrics without changing outcome, review, denominator or sorting semantics.
- Updated the live builder skill and pilot contract to show the complete test and exact hash, offer accept-or-edit through `agent_lab_edit`, re-show edited definitions, and state that acceptance is neither a run nor a result verdict.

## Task Commits

1. **Task 1 RED: Add failing reserved/owner rubric matrix** — `3ce40ab`
2. **Task 1 GREEN: Stabilize reserved rubric row identity** — `e6f3dc9`
3. **Task 2: Align test and business-scenario-card language** — `987ed4e`

No refactor commit was needed after the minimal GREEN change.

## TDD Cycle

- **RED:** The new public summary test failed because fingerprint-only identity produced two rows for every reserved ID. `gsd_run check tdd-red-evidence` returned `RED_EVIDENCE_OK`.
- **GREEN:** A three-ID local set changes only `metricRows` key selection; the focused suite passed 19/19.
- **REFACTOR:** Skipped because the two-line implementation was already the smallest existing-seam change.

## Files Created/Modified

- `src/quality.ts` — uses stable row identity for reserved service rubrics and fingerprints for every owner rubric.
- `test/quality.test.ts` — proves reserved grouping, distinct owner definitions and identical-owner merging.
- `skills/agent-builder/SKILL.md` — documents the exact-hash accept-or-edit sequence and audience-specific terminology.
- `docs/PILOT.md` — updates current pilot vocabulary and separates test acceptance from execution and result verdicts.

## Decisions Made

- Reserved row identity is a presentation concern only; persisted/generated definitions remain unchanged.
- No shared abstraction or exported constant was added for three IDs used at one reporting seam.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The sandbox blocked `tsx` IPC sockets with `EPERM`; all required test commands were rerun successfully with the approved test-runner permission.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for 03-03 exact-draft acceptance lifecycle and 03-04 shared Pi/CLI presentation. No blockers.

## Self-Check: PASSED

- All four modified implementation/documentation files and this summary exist.
- Task commits `3ce40ab`, `e6f3dc9` and `987ed4e` exist in history.
- Coverage metadata validates with both deliverables automatically covered.

---
*Phase: 03-poleznyy-test-i-ego-prinyatie*
*Completed: 2026-09-15*

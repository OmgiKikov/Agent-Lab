---
phase: 03-poleznyy-test-i-ego-prinyatie
plan: 05
subsystem: evaluation
tags: [tdd, judge, evidence, zod, compatibility]
requires:
  - phase: 03-poleznyy-test-i-ego-prinyatie
    provides: Confirmed one-test generation and full-draft identity from 03-01
provides:
  - Owner-selected reply/tool/state observation contract for confirmed tests
  - Channel-specific cited evidence validation for goal attainment
  - Judge protocol and input-fingerprint invalidation for observation changes
affects: [03-03, 03-04, 03-06, 03-07]
tech-stack:
  added: []
  patterns:
    - Owner metadata is attached by ExperimentLab after untrusted model output validates
    - Semantic goal verdicts require citations from the selected observable channel
key-files:
  created: []
  modified:
    - src/contracts.ts
    - src/experiment.ts
    - src/pi.ts
    - src/judge.ts
    - test/contracts.test.ts
    - test/pi.test.ts
    - test/judge.test.ts
    - test/experiment.test.ts
key-decisions:
  - "goalObservation is explicit owner input; the model response schema omits it and ExperimentLab attaches it after Runtime.prepare returns."
  - "reply, tool and state goals require their own cited evidence; a legacy scenario without goalObservation remains unknown."
  - "The existing full Scenario draftHash remains the sole draft identity; judge protocol 9 and judgeInput include goalObservation."
requirements-completed: [CARD-01]
requirements-progressed: [LOOP-04, DISC-06]
actuals:
  tokens: 8507
  tasks: 3
  commits: 1
plan_head_before: 722a4bef8f977c624c2c72c066bf73e32d86f5c1
duration: 11m
completed: 2026-09-16
status: complete
---

# Phase 3 Plan 5: Owner-Confirmed Goal Observation Summary

Confirmed tests now carry an owner-selected observation channel, and goal attainment can leave `unknown` only when the cited reply, paired successful tool result, or observed checked state matches that exact channel.

## Performance

- **Duration:** 11m
- **Started:** 2026-09-15T21:30:39Z
- **Completed:** 2026-09-15T21:41:29Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments

- Added `GoalObservation` (`reply | tool | state`) to the Scenario/Create/Prepare contracts while keeping legacy scenarios readable.
- Required confirmed hypotheses to carry the owner's choice, excluded the field from model-authored JSON, and attached it centrally after Runtime output validation.
- Replaced the objective-only `goal_attainment` gate with channel-specific citation checks: assistant reply; sequential matching call plus explicit successful result and a passed positive tool check; or a cited state snapshot satisfying passed `state_equals` checks.
- Kept missing fields, cross-channel citations, failed or unpaired tool results, and incomplete state observations at `unknown`.
- Bumped the judge protocol to version 9 and included the channel in the frozen judge input, invalidating stale receipts and fingerprints.
- Locked the existing full-Scenario `draftHash` behavior with regression coverage; no second hash was introduced.

## Task Commit

- `2f0d14b` — `fix(03): make goal evidence observable`

Root consolidated the verified RED/GREEN working tree into one exact-path code commit because the shared linked worktree branch is outside the executor's permitted `agent-*` commit namespace.

## TDD Gate Compliance

| Task | RED evidence | Result |
|---|---|---|
| 1 | `confirmed hypotheses require an owner-selected goal observation while legacy scenarios remain readable` failed because confirmed input accepted a missing field; Pi prompt and ExperimentLab assertions also failed. `tdd-red-evidence`: `RED_EVIDENCE_OK`. | GREEN |
| 2 | `missing action evidence cannot be replaced by agent self-attestation while reply quality stays assessable` failed because a reply goal stayed `unknown`. `tdd-red-evidence`: `RED_EVIDENCE_OK`. | GREEN |
| 3 | Hash/fingerprint regressions were already green after Tasks 1–2 because `draftHash` already fingerprints the full Scenario and the new judge input already carried the field. No duplicate implementation or artificial RED was added. | REGRESSION PASS |

## Verification

- `npm run build && npx tsx --test test/contracts.test.ts test/pi.test.ts test/judge.test.ts test/experiment.test.ts && npm run typecheck` — PASS.
- `npm test` — PASS, 312/312 tests.
- `npm run build && npx tsx --test test/judge.test.ts && npm run typecheck` after the multi-check tool edge fix — PASS, 9/9 focused tests.
- `git diff --check` for all eight plan files — PASS.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Preserved all positive checks for one tool**
- **Found during:** Root review after Task 2
- **Issue:** A `Map<tool, checkId>` kept only the last positive check when one tool had multiple checks.
- **Fix:** Validate that at least one matching positive scenario check has a passed trial result; added a two-check regression.
- **Files modified:** `src/judge.ts`, `test/judge.test.ts`
- **Commit:** `2f0d14b`

### Execution Adjustments

- Atomic task commits were consolidated by root into `2f0d14b`: the executor hard guard forbids committing from the shared linked worktree's `full-project-review-feature-plan` branch, and root explicitly prohibited switching branches or creating another worktree.
- `acceptedDraftHash` lifecycle assertions remain in Plan 03-03, which owns that not-yet-present field. This plan did not pre-implement or couple acceptance metadata to execution.

## Known Stubs

None.

## Threat Flags

None. The change adds no endpoint, file-access path, dependency, or new persistence service; it tightens existing trust boundaries.

## Decisions Made

- Treat the observation channel as owner-owned metadata, never a model inference from tools, goal text, or keywords.
- Require a cited event of the selected channel before accepting any non-`unknown` goal verdict, including negative verdicts.
- Preserve compatibility by leaving `Scenario.goalObservation` optional on read while requiring it only for the confirmed-hypothesis create path.

## Issues Encountered

- No product blocker. The only workflow issue was the linked-worktree branch namespace; root performed the exact-path code commit without touching the user's dirty plan.

## User Setup Required

None.

## Next Phase Readiness

- Plan 03-03 can add acceptance review metadata independently; `start()` and `saveSuite()` semantics were not changed here.
- Discovery plans can set `goalObservation: reply` from harness-owned prompt/RAG context and reuse the same judge contract.

## Self-Check: PASSED

- All eight modified source/test files and this summary exist.
- Commit `2f0d14b` exists and is exactly one commit after `plan_head_before`.
- Required focused, full-suite, build, typecheck, and whitespace checks passed.

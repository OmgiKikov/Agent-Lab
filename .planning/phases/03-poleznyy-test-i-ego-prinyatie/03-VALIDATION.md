---
phase: "03"
slug: "poleznyy-test-i-ego-prinyatie"
status: draft
nyquist_compliant: true
wave_0_complete: true
created: "2026-09-15"
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node `node:test` through `tsx` |
| **Config file** | `package.json`; no separate runner config |
| **Quick run command** | `npx tsx --test <task test files>` |
| **Full suite command** | `npm test && npm run typecheck` |
| **Estimated runtime** | ~15 seconds quick, ~30 seconds full |

## Sampling Rate

- **After every task commit:** Run the focused command from the map below.
- **After every plan wave:** Run that plan's final build/test/typecheck command.
- **Before phase verification:** `npm test && npm run typecheck` must be green.
- **Max feedback latency:** 30 seconds.

## Per-Task Verification Map

| Task | Requirements | Secure Behavior / Edge Matrix | Test Type | Automated Command | File Exists | Status |
|------|--------------|-------------------------------|-----------|-------------------|-------------|--------|
| 03-01-01 | LOOP-04, CARD-01, CARD-02 | RED/GREEN publication gate: 0/1/2 and duplicate candidates; non-empty criterion; reply vs tool/state observation compatibility; non-empty initialState requires resolving exact state_equals checks | integration | `npm run build && npx tsx --test test/pi.test.ts && npm run typecheck` | ✅ | ⬜ pending |
| 03-01-02 | CARD-04 | Owner/user full-token grounding; Unicode/case equality, substring rejection, every token checked, assistant/outcome excluded, 20 passes and 21 repairs | unit | `npx tsx --test test/contracts.test.ts test/pi.test.ts` | ✅ | ⬜ pending |
| 03-01-03 | CARD-02, CARD-03 | Exactly one generated goal rubric; prompt and simulator service rubrics are conditional; owner extras survive edit | unit | `npm run build && npx tsx --test test/contracts.test.ts test/pi.test.ts && npm run typecheck` | ✅ | ⬜ pending |
| 03-02-01 | CARD-05 | Reserved IDs share stable rows; non-reserved owner definitions merge only by full fingerprint | unit | `npx tsx --test test/quality.test.ts` | ✅ | ⬜ pending |
| 03-02-02 | CARD-06 | Builder/pilot use audience-correct test and business-scenario terms | contract search | `npx tsx --test test/quality.test.ts && if rg -n "user simulation cards|user cards|карточк(а|и|ах|у|ами|ей|ек) пользовател" skills/agent-builder/SKILL.md docs/PILOT.md; then exit 1; fi` | ✅ | ⬜ pending |
| 03-03-01 | LOOP-05 | Exact hash acceptance is backward-compatible and zero-call; saveSuite holds the shared mutation guard across source read, authorization, snapshot, and exclusive write | unit + integration | `npm run build && npx tsx --test test/contracts.test.ts test/experiment.test.ts && npm run typecheck` | ✅ | ⬜ pending |
| 03-03-02 | LOOP-05 | Exact/stale/idempotent acceptance; 0/1/many candidates; accept/edit and save/edit race orderings; edit-first retry cannot write a stale accepted snapshot | concurrency unit | `npx tsx --test test/experiment.test.ts` | ✅ | ⬜ pending |
| 03-03-03 | LOOP-05 | Any successful edit and every freshDraft-derived copy clear acceptance; legacy and loaded suite remain unaccepted | lifecycle unit | `npm run build && npx tsx --test test/contracts.test.ts test/experiment.test.ts && npm run typecheck` | ✅ | ⬜ pending |
| 03-04-01 | LOOP-04, LOOP-05, CARD-01 | Pi shows one full safe situation/input/success/observation/hash block; state is conditional; accept/decline has zero run/save effects | integration | `npm run build && npx tsx --test test/extension.test.ts test/cards.test.ts test/quality.test.ts && npm run typecheck` | ✅ | ⬜ pending |
| 03-04-02 | LOOP-04, LOOP-05 | CLI without --yes shows and stops; with --yes accepts displayed hash and still performs no target run | subprocess integration | `npm run build && npx tsx --test test/workflow.test.ts && npm run typecheck` | ✅ | ⬜ pending |
| 03-04-03 | LOOP-05, CARD-06 | Edit re-shows new hash and invalidated state; stale/decline are side-effect free; live terminology and terminal safety pass | integration + contract search | `npm run build && npx tsx --test test/extension.test.ts test/workflow.test.ts test/quality.test.ts && npm run typecheck && if rg -n --glob '!docs/archive/**' --glob '!docs/superpowers/**' "user simulation cards|user cards|карточк(а|и|ах|у|ами|ей|ек) пользовател" src extensions skills README.md docs CONTEXT.md; then exit 1; fi` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

## Wave 0 Requirements

All referenced test files and the runner already exist. Each logic task adds its focused assertion in RED before production code, records intentional failure evidence, then implements GREEN. No test framework, fixture subsystem, helper module, or dependency is needed.

The Phase 2 execution summaries are a precondition for Phase 3. Every executor re-reads the post-Phase-2 live seams before RED so landed helpers are reused instead of duplicated.

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Compact test readability and acceptance wording in a real terminal | LOOP-04, LOOP-05, CARD-06 | Headless assertions prove content and order, not visual clarity | Build one test in the real Pi flow, verify the complete test is readable before acceptance, acceptance performs no run, and an edit visibly requires re-acceptance. |

## Validation Sign-Off

- [x] Every phase requirement and every planned task has an automated verification path.
- [x] Existing tests cover all planned seams; task-local fixtures close the listed gaps.
- [x] No watch-mode flags or new dependencies.
- [x] Feedback latency target is under 30 seconds.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** approved 2026-09-15

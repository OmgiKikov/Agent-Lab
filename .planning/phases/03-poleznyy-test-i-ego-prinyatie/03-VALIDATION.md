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
| 03-03-01 | LOOP-04, LOOP-05 | Aggregate cardinality 0/1/many before mutation; exact/stale/idempotent hash; acceptDraft changes only acceptedDraftHash, not reviewedAt/reviewMode; semantic edit preserves stale receipt, freshDraft clears it; no execution/save effects | unit + integration | `npm run build && npx tsx --test test/contracts.test.ts test/experiment.test.ts && npm run typecheck` | ✅ | ⬜ pending |
| 03-03-02 | LOOP-04, LOOP-05 | Existing start/saveSuite and whole-draft expectedHash semantics remain unchanged; an unaccepted 15-card evaluate runs, aggregates accuracy over all cards, saves, loads and reruns without acceptance metadata; product-flow/workflow/demo need no migration | full-suite non-interference | `npm run build && npx tsx --test test/experiment.test.ts && npm test && npm run typecheck` | ✅ | ⬜ pending |
| 03-04-01 | LOOP-04, CARD-01, CARD-02, CARD-03, CARD-04, CARD-05, CARD-06 | Pure projection literally renders full СИТУАЦИЯ/ВХОД/УСПЕХ/НАБЛЮДЕНИЕ, current hash version and exact question; long input/criterion are escaped but not truncated; generic/missing observation is invalid | projection snapshot | `npm run build && npx tsx --test test/quality.test.ts && npm run typecheck` | ✅ | ⬜ pending |
| 03-04-02 | LOOP-04, LOOP-05 | Pi re-reads and shows the full four-field current projection before native confirmation, passes the same full hash to acceptDraft, and keeps refusal/accept free of run/save/model/target effects | integration | `npm run build && npx tsx --test test/extension.test.ts && npm run typecheck` | ✅ | ⬜ pending |
| 03-04-03 | LOOP-04, LOOP-05 | CLI accept without --yes shows and stops; --yes in the same invocation fully writes/flushes the literal four-field current projection, hash and exact question before acceptDraft; direct spy proves projection-written < mutation and write failure leaves record unchanged; run stays acceptance-independent | handler-order + subprocess integration | `npm run build && npx tsx --test test/workflow.test.ts && npm run typecheck` | ✅ | ⬜ pending |
| 03-05-01 | LOOP-04, DISC-06, CARD-01 | confirmedHypothesis requires owner goalObservation before Runtime; reply/tool/state passes harness-owned into exactly one Scenario; legacy missing remains readable | contract + integration | `npm run build && npx tsx --test test/contracts.test.ts test/pi.test.ts && npm run typecheck` | ✅ | ⬜ pending |
| 03-05-02 | DISC-06 | Judge accepts non-unknown goal_attainment only from cited evidence of the owner-selected reply/tool/state type; cross-type, failed tool, missing state and legacy missing remain unknown | unit | `npm run build && npx tsx --test test/judge.test.ts && npm run typecheck` | ✅ | ⬜ pending |
| 03-05-03 | LOOP-04, DISC-06, CARD-01 | goalObservation changes full draftHash, makes prior acceptance visibly stale, bumps judge protocol and leaves legacy hashes stable with unknown goal result | lifecycle unit | `npm run build && npx tsx --test test/experiment.test.ts test/judge.test.ts && npm run typecheck` | ✅ | ⬜ pending |
| 03-06-01 | DISC-01, DISC-02, DISC-03, DISC-04, DISC-07 | Every input dialogue gets exactly one persisted classification; missing/duplicate/foreign output degrades locally. Valid owner requirement/event provenance forms cross-batch groups, one focus, same-focus representatives/controls and one provenance-backed hypothesis with shown reply-channel | integration | `npm run build && npx tsx --test test/experiment.test.ts && npm run typecheck` | ✅ | ⬜ pending |
| 03-06-02 | DISC-01, DISC-02, DISC-07 | Discover rejects 0/301 and accepts 1..300, whole-dialogue packing respects 25/60,000, oversized becomes local unknown, exact ID reconciliation and citation validation run, ordinary import stays at 200 | boundary integration | `npm run build && npx tsx --test test/pi.test.ts && npm run typecheck` | ✅ | ⬜ pending |
| 03-06-03 | DISC-04, DISC-06, DISC-07 | Exact `B+(2*M+1)*K+3` nominal and reserve formula; calculated max persisted/applied before first call, nominal-over-20 succeeds, maxCalls+1 blocked; same-focus deep checkpoint/resume and exact provenance-backed fromRunId handoff | recovery + budget integration | `npm run build && npx tsx --test test/experiment.test.ts test/pi.test.ts && npm run typecheck` | ✅ | ⬜ pending |
| 03-07-01 | DISC-04, DISC-05, DISC-07 | Ready brief reports exact counts/citations, visibly shows harness-owned `НАБЛЮДЕНИЕ: ответ агента (reply)`, ends Проверим?, and prioritizes error/budget/partial without accuracy claims | projection snapshot | `npm run build && npx tsx --test test/quality.test.ts && npm run typecheck` | ✅ | ⬜ pending |
| 03-07-02 | DISC-01, DISC-05, DISC-07 | CLI discover shows both exact budget numbers before consent with zero Runtime calls, persists/applies calculated max before first call, passes nominal-over-20 and blocks maxCalls+1, then returns one brief/JSON; score/run unchanged | subprocess integration | `npm run build && npx tsx --test test/workflow.test.ts && npm run typecheck` | ✅ | ⬜ pending |
| 03-07-03 | LOOP-04, DISC-05, DISC-06 | Pi shows exact budget and saved reply observation before calls, replaces discovery-only default 20, passes nominal-over-20/exact ceiling, then plain owner «да» with exact run/hypothesis rereads the shown channel and builds one test | integration | `npm run build && npx tsx --test test/extension.test.ts && npm run typecheck` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

## Wave 0 Requirements

All referenced test files and the runner already exist. Each logic task adds its focused assertion in RED before production code, records intentional failure evidence, then implements GREEN. No test framework, fixture subsystem, helper module, or dependency is needed.

The Phase 2 execution summaries are a precondition for Phase 3. Every executor re-reads the post-Phase-2 live seams before RED so landed helpers are reused instead of duplicated.

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Compact test readability and acceptance wording in a real terminal | LOOP-04, LOOP-05, CARD-06 | Headless assertions prove content and order, not visual clarity | Build one test in the real Pi flow, verify the complete test is readable before acceptance, acceptance performs no run, and an edit visibly marks the prior review stale. |

## Validation Sign-Off

- [x] Every phase requirement and every planned task has an automated verification path.
- [x] Existing tests cover all planned seams; task-local fixtures close the listed gaps.
- [x] No watch-mode flags or new dependencies.
- [x] Feedback latency target is under 30 seconds.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** approved 2026-09-15

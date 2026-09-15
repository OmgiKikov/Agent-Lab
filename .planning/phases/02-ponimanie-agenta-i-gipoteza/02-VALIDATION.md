---
phase: "02"
slug: "ponimanie-agenta-i-gipoteza"
status: complete
nyquist_compliant: true
wave_0_complete: true
created: "2026-09-15"
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node `node:test` through `tsx` |
| **Config file** | `package.json`; no separate runner config |
| **Quick run command** | `npx tsx --test <task test files>` |
| **Full suite command** | `npm test && npm run typecheck` |
| **Estimated runtime** | ~15 seconds quick, ~30 seconds full |

---

## Sampling Rate

- **After every task commit:** Run the task's focused `npx tsx --test ...` command.
- **After every plan wave:** Run that plan's final build/test/typecheck command.
- **Before phase verification:** `npm test && npm run typecheck` must be green.
- **Max feedback latency:** 30 seconds.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | SCORE-01/02/03/04/08 | T-02-01..04 | Ordered one-to-one offline evidence; no target/simulator/model in code-only | tracer/integration | `npm run build && npx tsx --test test/contracts.test.ts test/workflow.test.ts && npm run typecheck` | ✅ | ✅ green |
| 02-01-02 | 01 | 1 | SCORE-01/02/03/07 | T-02-01..04 | Public batch boundary persists without truncation or interleaved mutation | boundary/integration | `npx tsx --test test/contracts.test.ts test/experiment.test.ts test/workflow.test.ts` | ✅ | ✅ green |
| 02-02-01 | 02 | 2 | LOOP-02, SCORE-04/05 | T-02-06/07 | Only owner sources and user turns may define expectations | payload integration | `npx tsx --test test/contracts.test.ts test/pi.test.ts` | ✅ | ✅ green |
| 02-02-02 | 02 | 2 | SCORE-04/06 | T-02-08 | Missing observable action effect stays unclear; reply quality remains separate | unit/integration | `npx tsx --test test/judge.test.ts test/evaluation.test.ts` | ✅ | ✅ green |
| 02-02-03 | 02 | 2 | SCORE-07/08 | T-02-09/10 | Reassessment uses saved evidence, reclusters only with a model, and requires CLI consent | workflow integration | `npm run build && npx tsx --test test/experiment.test.ts test/workflow.test.ts test/pi.test.ts test/judge.test.ts && npm run typecheck` | ✅ | ✅ green |
| 02-03-01 | 03 | 3 | SCORE-01/08 | T-02-11/13 | Pi spends only after native confirmation and preserves partial evidence/errors | Pi integration | `npm run build && npx tsx --test test/extension.test.ts test/experiment.test.ts && npm run typecheck` | ✅ | ✅ green |
| 02-03-02 | 03 | 3 | LOOP-01/02/03, SCORE-05/08 | T-02-11/12 | CLI and Pi share one safe four-block brief with resolvable evidence | projection/integration | `npm run build && npx tsx --test test/workflow.test.ts test/extension.test.ts test/quality.test.ts && npm run typecheck` | ✅ | ✅ green |
| 02-03-03 | 03 | 3 | LOOP-01/02/03 | T-02-12/14 | Exactly one grounded hypothesis precedes test construction and ends with `Проверим?` | prompt/skill contract | `npm run build && npx tsx --test test/extension.test.ts test/workflow.test.ts && npm run typecheck` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing test infrastructure and every referenced test file already exist. Each TDD task adds its focused red regression before production code; no separate Wave 0 file or dependency is required.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Terminal readability and native Pi confirmation placement | LOOP-01, LOOP-03, SCORE-08 | Headless tests prove content/order but not real terminal visual clarity | Run one real Pi score flow, confirm the four blocks remain scannable and spending consent appears immediately before model-backed reassessment. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verification.
- [x] Sampling continuity: no task lacks an automated check.
- [x] Wave 0 has no missing framework, fixture or test-file dependency.
- [x] No watch-mode flags.
- [x] Feedback latency target is under 30 seconds.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** approved 2026-09-15

**Automated sign-off:** `git diff --check && npm test && npm run typecheck` — 302/302 green on 2026-09-15. Real-terminal readability remains the explicit UAT item above.

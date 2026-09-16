---
phase: "1"
slug: "odno-chestnoe-chislo"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-16"
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node test runner via `tsx --test` (tsx ^4.20.0), TypeScript 5.9.3 |
| **Config file** | none (`package.json` scripts) |
| **Quick run command** | `SNAP=$(mktemp -d); git ls-files -co --exclude-standard -z \| tar --null -T - -cf - \| tar -xf - -C "$SNAP"; ln -s "$PWD/node_modules" "$SNAP/node_modules"; (cd "$SNAP" && npx tsc && npx tsx --test <touched test files>)` |
| **Full suite command** | `SNAP=$(mktemp -d); git archive HEAD \| tar -x -C "$SNAP"; ln -s "$PWD/node_modules" "$SNAP/node_modules"; (cd "$SNAP" && npm test && npm run typecheck)` |
| **Estimated runtime** | ~19 seconds (baseline 317 pass / 0 fail at HEAD) |

Never run `npm test` / `npm run build` directly in the worktree: they delete `dist/`, which a live Pi imports.

---

## Sampling Rate

- **After every task commit:** Run the quick command on the 3–5 touched test files
- **After every plan wave:** Run the full suite command from a `git archive HEAD` snapshot
- **Before `/gsd-verify-work`:** Full suite must be green; stored-run script matches expected counts; live steps done with evidence copied
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Req | Behavior | Test Type | Automated Command | File Exists | Status |
|-----|----------|-----------|-------------------|-------------|--------|
| TRUST-01 | CLI `summary` first lines == `ResultView` lines; Pi tool result and `/agent-lab` show the same headline for one fixture | unit + integration | `npx tsx --test test/result-view.test.ts test/extension.test.ts test/cards.test.ts test/store.test.ts` | result-view ❌ W0; others ✅ | ⬜ pending |
| TRUST-02 | Every not-measured reason code from a minimal fixture; top reason by count, tie by order; no «прочее» anywhere | unit | `npx tsx --test test/result-view.test.ts test/quality.test.ts` | ❌ W0 / ✅ | ⬜ pending |
| TRUST-03 | Wilson vectors (3/12 → 9–53%); caveat only when M < 20; M = 0 → «Проверенных ситуаций нет»; percent always shown when M > 0 | unit | `npx tsx --test test/result-view.test.ts` | ❌ W0 | ⬜ pending |
| TRUST-04 | Control excluded from N/M and not-measured; warning when control fails/unknown; `draftHash` of a record without the field unchanged; field not in `measurementHash`; survives `repeat` | unit | `npx tsx --test test/result-view.test.ts test/experiment.test.ts` | ❌ W0 / ✅ | ⬜ pending |
| TRUST-05 | `compareRuns(legacyNoGoalObs, freshDraft-run)` has no «карточки изменились»; `hasCompleteJudgment` true with a prompt source via `observableSources` (D1); per-pair audit failure affects only that pair | unit | `npx tsx --test test/comparison.test.ts test/judge.test.ts` | ✅ extend | ⬜ pending |
| TRUST-06 | Injected goals returning the same id for every dialogue → build reaches `review`, one card per dialogue | integration | `npx tsx --test test/experiment.test.ts` | ✅ extend | ⬜ pending |
| TRUST-07 | `scoreSettings` values; CLI score record settings == Pi path; judged score card counts as decided (D2) | unit + CLI spawn | `npx tsx --test test/extension.test.ts test/workflow.test.ts test/normalize.test.ts` | normalize ❌ W0 | ⬜ pending |
| TRUST-08 | New trial has receipt, no full audit; sidecar `0600` atomic; journal one audit per judgment; receipt path true/false on tamper; legacy full-audit fixture still true; `reassess` of legacy record works; reports do not embed the journal/audit | unit + integration | `npx tsx --test test/judge.test.ts test/store.test.ts test/evaluation.test.ts test/artifacts.test.ts test/experiment.test.ts` | ✅ extend | ⬜ pending |
| TRUST-09 | Stability between runs flags pass↔fail only when comparable and agent unchanged; stability after reassess pairs by trial id; unstable cards stay in N/M | unit | `npx tsx --test test/comparison.test.ts test/result-view.test.ts` | ✅ / ❌ W0 | ⬜ pending |
| All | Stored-run regression: read-only script prints counts for `fae4ee59` (0/9 + 4 not measured) and `a92fd6ae` (1/8 + 7), audit completeness 13/13, 14/14 | read-only script | `node .planning/phases/01-odno-chestnoe-chislo/verify-stored-runs.mjs` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/result-view.test.ts` — validate-like record fixtures with builders for each reason code
- [ ] `test/normalize.test.ts` — `normalizeScenarioIdentity`, `scoreSettings`
- [ ] Judge fixture with a `kind: 'prompt'` source + requirements (D1 regression)
- [ ] `verify-stored-runs.mjs` in the phase dir (read-only; prints ids/counts only, never dialogue text)

Framework install: none.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live repeat of `fae4ee59` with control `ae812a24` on `aigw-local`, `diff` with the original, audit sidecar size | TRUST-04, 05, 08, 09a | Paid call on the real agent (pre-approved by the user, ≤ $10 for the phase) | Live Verification Plan in 01-RESEARCH.md; copy evidence to `~/agent-lab-evidence/phase-01/` (`0600`) |
| Reassess of `fae4ee59` saved answers | TRUST-09b | Paid judge calls | Same plan, step for reassess |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending

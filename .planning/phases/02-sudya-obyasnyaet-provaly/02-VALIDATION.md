---
phase: "2"
slug: "sudya-obyasnyaet-provaly"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-17"
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node test runner via `tsx --test` (tsx ^4.20.0), TypeScript 5.9.3 |
| **Config file** | none (`package.json` scripts) |
| **Quick run command** | `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh <touched test files>` (working-tree snapshot; never touches the worktree `dist/`) |
| **Full suite command** | `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh --full` (`git archive HEAD`, `npm test && npm run typecheck`) |
| **Estimated runtime** | ~20–30 seconds |

---

## Sampling Rate

- **After every task commit:** quick command with the 2–4 touched test files
- **After every plan wave:** full suite from a snapshot
- **Before `/gsd-verify-work`:** full suite green; `verify-stored-runs.mjs` expectations hold; live steps done with evidence copied
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Plan-Task | Req | Behavior | Test Type | Automated Command | File Exists | Status |
|-----------|-----|----------|-----------|-------------------|-------------|--------|
| 02-01-T1 | JUDGE-03 | Simulator cut vectors; v11 `assessRepeated` flow (fidelity first, prefix on fail, 8 calls); post-cut citation rejected; `assessTrial` records the cut in trial and receipt | unit | `snap-test.sh test/judge.test.ts test/evaluation.test.ts test/comparison.test.ts test/pi.test.ts` | ✅ extend (reactive fixture is W0, created here) | ⬜ pending |
| 02-01-T2 | JUDGE-03 | `hasCompleteJudgment` accepts v10 and v11 (full-audit and receipt paths); tamper → false; freeze pins; `reassess` clears the cut; stored runs unchanged | unit + read-only | `snap-test.sh --keep …` + `verify-stored-runs.mjs --dist $SNAP/dist …` | ✅ extend | ⬜ pending |
| 02-02-T1 | JUDGE-03, JUDGE-02 | Counting rules `goal-v2`: cut + fidelity fail decided; heuristic check before cut still blocks; lone field edit ignored; old records unchanged; C-50 wording | unit | `snap-test.sh test/result-view.test.ts test/comparison.test.ts test/outcomes.test.ts test/quality.test.ts test/cards.test.ts` | ✅ extend | ⬜ pending |
| 02-02-T2 | JUDGE-03 | `simulatorUsable` options; before numbers on stored runs (ids/counts only) | unit + script | `snap-test.sh --keep test/outcomes.test.ts` + `measure-undecided.mjs --dist $SNAP/dist …` | ❌ W0 (script created here) | ⬜ pending |
| 02-03-T1 | JUDGE-03 | dist swap; pilot on 3 deviated trials within budget; GO/NO-GO recorded | live (paid, gated) | `grep gate.txt` + `live-check.mjs spent --cap 6` | — | ⬜ pending |
| 02-03-T2 | JUDGE-03 | GO: full reassessments + after numbers + freeze; NO-GO: v10 restored | live (paid, gated) | `live-check.mjs spent` + after/freeze checks or `git diff --quiet $BASE` | — | ⬜ pending |
| 02-04-T1 | JUDGE-01 | Owner rule register; goal explanation; `ResultView.failures`; CLI «Все провалы» | unit + CLI spawn | `snap-test.sh test/explain.test.ts test/result-view.test.ts test/quality.test.ts` | ❌ W0 (test/explain.test.ts created here) | ⬜ pending |
| 02-04-T2 | JUDGE-01 | Every F1 variant; violated rule; machine-format filter; cut row; jargon backstop | unit | `snap-test.sh test/explain.test.ts test/result-view.test.ts` | ✅ (from T1) | ⬜ pending |
| 02-04-T3 | JUDGE-01, JUDGE-02 | F3 rows in the block; top causes; CLI F4 layout | unit + full suite | `snap-test.sh` | ✅ extend | ⬜ pending |
| 02-05-T1 | JUDGE-01, JUDGE-02 | Pi payload/render and board show the same causes; pi-surface-check on stored runs | unit + read-only | `snap-test.sh --keep …` + `pi-surface-check.mts` from the snapshot | ✅ extend | ⬜ pending |
| 02-05-T2 | JUDGE-01 | `wrapRows` at 36/56/76/106/156; ВСЕ ПРОВАЛЫ; role tokens | unit | `snap-test.sh test/cards.test.ts test/extension.test.ts` | ✅ extend | ⬜ pending |
| 02-05-T3 | JUDGE-01 | Cause examples from explanations; exact check path kept | unit + full suite | `snap-test.sh` | ✅ extend | ⬜ pending |
| 02-06-T1 | JUDGE-01, JUDGE-02, JUDGE-03 | Live dist; explanations on fae4ee59/a92fd6ae verified (16/16) | live (free) | `measure-undecided.mjs --explain` + `verify-stored-runs.mjs` | ✅ | ⬜ pending |
| 02-06-T2 | JUDGE-01 | Board fits 40–160 columns on real runs; evidence table | live (free) | `board-width-check.mts` | ❌ (created here) | ⬜ pending |
| 02-07-T1 | TRUST-10 | Expectation sheet; accept all situations; CLI accept for sets | unit + CLI spawn | `snap-test.sh test/experiment.test.ts test/workflow.test.ts test/quality.test.ts test/product-flow.test.ts` | ✅ extend | ⬜ pending |
| 02-07-T2 | TRUST-11, TRUST-10 | `setExpectation` verbatim, marker, limits, hashes, compareRuns note, `requireAccepted` | unit + full suite | `snap-test.sh` | ✅ extend | ⬜ pending |
| 02-08-T1 | TRUST-10 | Board sheet, `y`, header states, tab label, help, footer, notice kinds | unit + extension | `snap-test.sh test/cards.test.ts test/extension.test.ts` | ✅ extend | ⬜ pending |
| 02-08-T2 | TRUST-11, TRUST-10 | Board `e` flow; `r` confirm-and-start; run plan compact sheet | unit + extension | `snap-test.sh test/extension.test.ts test/cards.test.ts test/experiment.test.ts` | ✅ extend | ⬜ pending |
| 02-08-T3 | TRUST-10, TRUST-11 | Chat accept loop; `agent_lab_run` asks first; `sheetLines` | extension + full suite | `snap-test.sh` | ✅ extend | ⬜ pending |
| 02-09-T1 | TRUST-10, TRUST-11 | Real acquiring draft: sheet, owner text verbatim, one-step confirmation, board keys and widths | live (free) | `expectation-check.mts` result greps | ❌ (created here) | ⬜ pending |
| 02-09-T2 | all | Final dist keeps stored-run counts, surfaces and widths | live (free) | `verify-stored-runs.mjs` + `pi-surface-check.mts` + `board-width-check.mts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/explain.test.ts` — fixture with 2 knowledge sources + 1 prompt source, shuffled requirements, failed validate trial with assistant citations (created in 02-04 Task 1, written before the implementation)
- [ ] `test/judge.test.ts` — reactive fixture with simulator events and a fidelity rubric (created in 02-01 Task 1, written before the implementation)
- [ ] `.planning/phases/02-sudya-obyasnyaet-provaly/measure-undecided.mjs` — read-only; prints ids/counts/codes only (created in 02-02 Task 2; `--explain` added in 02-06 Task 1)

Sampling continuity: every task of plans 02-01…02-09 carries an `<automated>` command with a `<fails_when>` signal; no three consecutive tasks lack one.

Framework install: none.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| v11 pilot on 3 simulator-flagged trials (GO if ≥ 2 become decided), then reassess `fae4ee59`/`a92fd6ae`, before/after numbers recorded | JUDGE-03 | Paid judge calls (phase cap ~$6), protocol freeze by end of 2026-09-18 | Live Verification Plan in 02-RESEARCH.md; evidence to `~/agent-lab-evidence/phase-02/` (0700/0600) |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending

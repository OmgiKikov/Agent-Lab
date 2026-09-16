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

| Req | Behavior | Test Type | Automated Command | File Exists | Status |
|-----|----------|-----------|-------------------|-------------|--------|
| JUDGE-01 | Owner rule numbering by source then offset, stable across repeat; ungrounded quote gets no number | unit | `snap-test.sh test/explain.test.ts` | ❌ W0 | ⬜ pending |
| JUDGE-01 | `failureExplanation` X/Y/N, verified quotes, «судья не указал реплику», «объяснение не подтверждено цитатой», «и ещё K», no `…` truncation | unit | `snap-test.sh test/explain.test.ts` | ❌ W0 | ⬜ pending |
| JUDGE-01 | CLI `summary` and Pi block/board show explanation lines for top causes; `firstReason` gone | unit + CLI | `snap-test.sh test/result-view.test.ts test/quality.test.ts test/extension.test.ts test/cards.test.ts` | ✅ extend | ⬜ pending |
| JUDGE-02 | Every unknown card row shows `title — label`; `judge_split`/`no_evidence` wording verbatim | unit | `snap-test.sh test/result-view.test.ts` | ✅ extend | ⬜ pending |
| JUDGE-03 | Simulator cut vectors; v11 `assessRepeated` flow (fidelity first, prefix on fail, 8 calls); post-cut citation rejected | unit | `snap-test.sh test/judge.test.ts` | ✅ extend | ⬜ pending |
| JUDGE-03 | `hasCompleteJudgment` accepts v10 and v11 (full-audit and receipt paths); tamper → false; freeze pins on protocol/prompt/format hashes | unit | `snap-test.sh test/judge.test.ts test/store.test.ts` | ✅ extend | ⬜ pending |
| JUDGE-03 | Counting rules `goal-v2`: cut + fidelity fail decided; heuristic check before cut still blocks; old records unchanged | unit | `snap-test.sh test/comparison.test.ts test/outcomes.test.ts test/result-view.test.ts` | ✅ extend | ⬜ pending |
| JUDGE-03 | `reassess` clears the cut; `assessTrial` sets it from the audit | integration | `snap-test.sh test/evaluation.test.ts test/experiment.test.ts` | ✅ extend | ⬜ pending |
| JUDGE-03 | Before/after «без решения» on stored runs (read-only measure + gated paid reassess) | script + live | `node .planning/phases/02-sudya-obyasnyaet-provaly/measure-undecided.mjs` | ❌ W0 | ⬜ pending |
| TRUST-10 | Expectation sheet per card; accept all N cards; `start({requireAccepted})`; board confirm-all key | unit + extension | `snap-test.sh test/quality.test.ts test/experiment.test.ts test/cards.test.ts test/extension.test.ts` | ✅ extend | ⬜ pending |
| TRUST-11 | `setExpectation` writes owner text verbatim, marks card, invalidates acceptance, keeps checks; comparison reports changed content; old `draftHash` unchanged | unit + extension | `snap-test.sh test/experiment.test.ts test/extension.test.ts test/comparison.test.ts` | ✅ extend | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/explain.test.ts` — fixture with 2 knowledge sources + 1 prompt source, shuffled requirements, failed validate trial with assistant citations
- [ ] `test/judge.test.ts` — reactive fixture with simulator events and a fidelity rubric
- [ ] `.planning/phases/02-sudya-obyasnyaet-provaly/measure-undecided.mjs` — read-only; prints ids/counts/codes only

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

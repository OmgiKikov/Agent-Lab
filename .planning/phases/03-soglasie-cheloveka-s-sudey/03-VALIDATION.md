---
phase: "3"
slug: "soglasie-cheloveka-s-sudey"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-17"
---

# Phase 3 — Validation Strategy

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` via `tsx --test`, plus `tsc` and `npm run typecheck` for extensions |
| **Config file** | `tsconfig.json`; runner `.planning/phases/01-odno-chestnoe-chislo/snap-test.sh` |
| **Quick run command** | `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh <touched test files>` |
| **Full suite command** | `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh --full` |
| **Estimated runtime** | ~30 seconds |

Never run `npm test` or `npm run build` in the worktree.

## Sampling Rate

- **After every task commit:** the quick command on that task's test files.
- **After every plan wave:** `snap-test.sh` on the working tree.
- **Before `/gsd-verify-work`:** `snap-test.sh --full`, then `agreement-check.mts`, `verify-stored-runs.mjs` and `pi-surface-check.mts` all green.
- **Max feedback latency:** 60 seconds.

## Per-Task Verification Map

| Req | Plan / Task | Behavior | Test Type | Automated Command | File Exists | Status |
|-----|-------------|----------|-----------|-------------------|-------------|--------|
| JUDGE-04/05 | 03-01 T1 (tracer) | A quick mark saved through the lab shows as the agreement row in `agent-lab summary` | integration (CLI spawn) | `snap-test.sh` (full working tree) | ✅ add (test/result-view.test.ts) | ⬜ |
| JUDGE-04 | 03-01 T2 | Schema accepts old reviews and new quick fields; `primaryMetricId` choice; `addHumanReview` fills the judge snapshot itself and rejects forged or undecided marks; `measurementHash` unchanged, `resultHash` changed; mark survives reload | unit | `snap-test.sh test/experiment.test.ts test/contracts.test.ts test/outcomes.test.ts test/store.test.ts test/result-view.test.ts` | ✅ add | ⬜ |
| JUDGE-05/06 | 03-01 T3 | `judgeAgreement` counts against recorded judge results; failures and passes split; «не смог решить» and «устарели» counted separately; `agreementSample` deterministic, ≤3 → all, empty while running; F6 wording at checked = 0/1/9/10/19/20 | unit | `snap-test.sh test/agreement.test.ts test/result-view.test.ts test/comparison.test.ts test/experiment.test.ts` | ❌ W0 (created here) | ⬜ |
| JUDGE-04 | 03-02 T1 (tracer) | A disagree flips the headline; a quick «не могу сказать» does NOT change the headline | integration (CLI spawn) | `snap-test.sh test/outcomes.test.ts test/result-view.test.ts test/comparison.test.ts test/agreement.test.ts` | ✅ | ⬜ |
| JUDGE-04 | 03-02 T2 | A decided quick mark closes the trial in `awaitingVerdict`; an agreement is not a human remark | unit | `snap-test.sh` (full working tree) | ✅ | ⬜ |
| JUDGE-05 | 03-03 T1 (tracer) | Disagreement section and next step on CLI and Pi; CLI/Pi parity on stored runs | integration | `snap-test.sh --keep test/extension.test.ts test/result-view.test.ts test/cards.test.ts` + `pi-surface-check.mts` | ✅ update | ⬜ |
| JUDGE-05 | 03-03 T2 | Exact F7/F8 words, full reasons, escaping, jargon scan | unit | `snap-test.sh test/result-view.test.ts test/extension.test.ts test/agreement.test.ts` | ✅ add | ⬜ |
| JUDGE-04 | 03-04 T1 (tracer) | Board keys emit `agree`; the loop saves the mark; a disagree opens the editor; cancel/empty saves nothing | unit + integration | `snap-test.sh test/cards.test.ts test/extension.test.ts` | ✅ update | ⬜ |
| JUDGE-04 | 03-04 T2 | Repeats, long reasons, lab refusals, finalize text and confirm row | integration | `snap-test.sh test/extension.test.ts test/cards.test.ts` | ✅ add | ⬜ |
| JUDGE-06 | 03-04 T3 | Review order puts unmarked failures first, then sampled passes; F12 labels; `u` filter | unit | `snap-test.sh` (full working tree) | ✅ add | ⬜ |
| JUDGE-04/06 | 03-05 T1–T2 | Section-3 header tiers; footer tiers with the prefix rule; help and trial detail rows | unit | `snap-test.sh test/cards.test.ts test/extension.test.ts`; `snap-test.sh` | ✅ add | ⬜ |
| JUDGE-04 | 03-06 T1–T2 | Evidence rows come before «Судья:»; every block variant; width 36–156 | unit | `snap-test.sh test/explain.test.ts test/cards.test.ts test/extension.test.ts [test/agreement.test.ts]` | ✅ add | ⬜ |
| JUDGE-05 | 03-06 T3 | Board section 1 disagreement list and colors; board jargon scan; surface check | unit + integration | `snap-test.sh --keep` + `pi-surface-check.mts` | ✅ add | ⬜ |
| All | 03-07 T1 (tracer) | Scripted board run on a TEMP COPY of stored runs; the originals stay unchanged | e2e (free) | `agreement-check.mts --source .agent-lab --id fae4ee59… --id a92fd6ae…` | ❌ W0 (created here) | ⬜ |
| All | 03-07 T2 | dist swap, stored-run regression, surfaces, e2e with the swapped dist, no real marks | e2e (free) | evidence greps in `~/agent-lab-evidence/phase-03/` | — | ⬜ |

## Wave 0 Requirements

- [ ] `test/agreement.test.ts` — created by 03-01 Task 3 (no earlier task's verify command names it)
- [ ] `.planning/phases/03-soglasie-cheloveka-s-sudey/agreement-check.mts` — created by 03-07 Task 1
- [ ] Fixture helper: a reactive trial with a goal assessment and a `judgeReceipt` — built inside `test/agreement.test.ts` (03-01 Task 3)
- [ ] `test/helpers/copy-check.ts` (`assertPlainCopy`) — created by 03-03 Task 2, used by 03-04 and 03-06

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| The owner puts real agreement marks on the frozen v11 demo record | JUDGE-04/05 | Only a human can agree or disagree; the user is asleep during this run | After the protocol freeze, open `/agent-lab`, choose the demo record, open section 3, press `y`/`n`/`s` |
| Light and dark theme look of the agreement block | JUDGE-05 | Needs eyes on a real terminal | A screenshot in both themes |
| The remapped `n` («не согласен», was «не пройдено») reads naturally | JUDGE-04 | Only the owner can say whether the key feels right | Open section 3, read the help and the key row, press `n` once and cancel the editor |

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending

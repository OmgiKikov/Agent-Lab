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

| Req | Behavior | Test Type | Automated Command | File Exists | Status |
|-----|----------|-----------|-------------------|-------------|--------|
| JUDGE-04 | Schema accepts old reviews and new quick fields | unit | `snap-test.sh test/contracts.test.ts` | ✅ add | ⬜ |
| JUDGE-04 | `addHumanReview` fills the judge snapshot itself and rejects forged or undecided marks; `measurementHash` unchanged, `resultHash` changed; mark survives reload | unit | `snap-test.sh test/experiment.test.ts test/store.test.ts` | ✅ add | ⬜ |
| JUDGE-04 | `primaryMetricId` choice; a disagree flips the headline; a quick «не могу сказать» does NOT change the headline | unit | `snap-test.sh test/outcomes.test.ts test/comparison.test.ts test/result-view.test.ts` | ✅ | ⬜ |
| JUDGE-04 | Board keys emit `agree`; a disagree opens the editor, and empty or cancel saves nothing; evidence rows come before «Судья:»; the mark shows after reopening | unit + integration | `snap-test.sh test/cards.test.ts test/extension.test.ts` | ✅ update | ⬜ |
| JUDGE-05 | `judgeAgreement` counts against recorded judge results; failures and passes split; «не смог решить» and «устарели» counted separately | unit | `snap-test.sh test/agreement.test.ts` | ❌ W0 | ⬜ |
| JUDGE-05 | Wording at checked = 0/1/9/10/19/20; disagreement section; CLI/Pi/board parity | unit + integration | `snap-test.sh test/result-view.test.ts test/extension.test.ts` + `pi-surface-check.mts` | ✅ | ⬜ |
| JUDGE-06 | `agreementSample` is deterministic, takes all passes when there are ≤3, returns nothing while running; review order puts sampled passes after failures | unit | `snap-test.sh test/agreement.test.ts test/cards.test.ts` | ❌ W0 | ⬜ |
| All | Scripted board run on a TEMP COPY of stored runs; the originals stay unchanged | e2e (free) | `agreement-check.mts --source .agent-lab --id a92fd6ae… --id fae4ee59…` | ❌ W0 | ⬜ |

## Wave 0 Requirements

- [ ] `test/agreement.test.ts`
- [ ] `.planning/phases/03-soglasie-cheloveka-s-sudey/agreement-check.mts`
- [ ] Fixture helper: a reactive trial with a goal assessment and a `judgeReceipt`

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| The owner puts real agreement marks on the frozen v11 demo record | JUDGE-04/05 | Only a human can agree or disagree; the user is asleep during this run | After the protocol freeze, open `/agent-lab`, choose the demo record, open section 3, press `y`/`n`/`s` |
| Light and dark theme look of the agreement block | JUDGE-05 | Needs eyes on a real terminal | A screenshot in both themes |

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending

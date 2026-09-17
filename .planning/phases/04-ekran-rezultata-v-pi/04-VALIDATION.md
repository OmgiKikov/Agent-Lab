---
phase: "4"
slug: "ekran-rezultata-v-pi"
status: draft
nyquist_compliant: true
wave_0_complete: false
created: "2026-09-17"
---

# Phase 4 — Validation Strategy

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` via `tsx --test`, `tsc` and the extension typecheck; Node test-runner mock timers for progress |
| **Config file** | `tsconfig.json`; runner `.planning/phases/01-odno-chestnoe-chislo/snap-test.sh` |
| **Quick run command** | `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh <touched test files>` |
| **Full suite command** | `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh --full` |
| **Real-Pi checks (free)** | `board-pty-check.sh`, `pi-reopen-check.sh` (offline Pi 0.85.1 in a pty, temp dirs, `pgrep` at the end) |
| **Stored-run checks (free)** | `render-matrix.mts`, `pi-surface-check.mts`, `verify-stored-runs.mjs` from a kept snapshot |
| **Paid check (once, ≤ $0.5)** | `live-progress-check.mts` after `live-check.mjs budget … --next run --cap 1` (plan 04-10) |
| **Estimated runtime** | ~30–60 s per snapshot run; ~40 s per pty script |

Never run `npm test` or `npm run build` in the worktree. Plans run one at a time on the main tree, after phases 2 and 3 are complete.

## Sampling Rate

- **After every task commit:** the quick command on that task's test files (each task's `<verify>`).
- **After every plan:** `snap-test.sh` on the whole working tree.
- **Before `/gsd-verify-work`:** `snap-test.sh --full`, then `OK render-matrix`, surface check OK, `OK pi-reopen`, `OK board-pty tabs`, live-dist checks OK (04-09), and `OK live-progress` (04-10) or its `human_needed` note.
- **Max feedback latency:** 60 seconds for unit tasks.

## Per-Task Verification Map

| Req | Plan / Task | Behavior | Test Type | Automated Command | File Exists | Status |
|-----|-------------|----------|-----------|-------------------|-------------|--------|
| SCREEN-01/02 | 04-01 T1 (tracer) | `agent_lab_run` result drawn as the verdict block by Pi's `ToolExecutionComponent` from `details` | integration | `snap-test.sh test/verdict-block.test.ts test/extension.test.ts test/result-view.test.ts` | ❌ W0 (created here) | ⬜ |
| SCREEN-01 | 04-01 T2 | V1/V2 vectors, B1/B2 order, jargon scan | unit | `snap-test.sh test/verdict.test.ts test/result-view.test.ts` | ❌ W0 | ⬜ |
| SCREEN-02/07 | 04-01 T3 | widths 40–160, fake and real themes, legacy fallback, lint | unit | `snap-test.sh test/theme.test.ts test/verdict-block.test.ts test/verdict.test.ts test/extension.test.ts` | ❌ W0 | ⬜ |
| SCREEN-07 | 04-02 T1 (tracer) | theme owns escaping/rows/wrap; output unchanged | unit | `snap-test.sh test/theme.test.ts test/cards.test.ts test/extension.test.ts test/verdict-block.test.ts` | ✅ | ⬜ |
| SCREEN-03 | 04-02 T2 | split with no drawn change; surface check OK | unit + stored runs | `snap-test.sh` + `pi-surface-check.mts` from a kept snapshot | ✅ | ⬜ |
| SCREEN-03 | 04-02 T3 | real board driven by keys | pty (free) | `board-pty-check.sh` | ❌ W0 | ⬜ |
| SCREEN-02 | 04-03 T1 (tracer) | board run → one entry; host parity in both themes | integration | `snap-test.sh test/extension.test.ts test/verdict-block.test.ts test/cards.test.ts` | ✅ | ⬜ |
| SCREEN-01/02 | 04-03 T2 | all result tools return verdict details; prompt and skill | unit | `snap-test.sh test/extension.test.ts test/skill.test.ts test/verdict-block.test.ts` | ✅ | ⬜ |
| SCREEN-02 | 04-03 T3 | append only on changed result | unit | `snap-test.sh test/extension.test.ts test/cards.test.ts` | ✅ | ⬜ |
| SCREEN-05 | 04-04 T1 (tracer) | `situationChanges` codes, gates, parity with stability | unit | `snap-test.sh test/comparison.test.ts` | ✅ | ⬜ |
| SCREEN-05 | 04-04 T2 | `view.changes`, `compareRows` texts; stored pair counts | unit + stored run | `snap-test.sh test/result-view.test.ts test/comparison.test.ts test/verdict.test.ts` | ✅ | ⬜ |
| SCREEN-03/05 | 04-05 T1 (tracer) | tab sets, digits/Tab/Shift+Tab, tier tab row, Сравнение tab | unit | `snap-test.sh test/cards.test.ts test/theme.test.ts test/extension.test.ts` | ✅ | ⬜ |
| SCREEN-04 | 04-05 T2 | Провалы list and detail order, agreement keys, reopen tab | unit | `snap-test.sh test/cards.test.ts test/extension.test.ts test/theme.test.ts` | ✅ | ⬜ |
| SCREEN-01/03 | 04-06 T1 (tracer) | Итог opens with V1 and board V2 | unit | `snap-test.sh test/cards.test.ts test/verdict.test.ts` | ✅ | ⬜ |
| SCREEN-07 | 04-06 T2 | footer/help tiers at boundary widths, header budget | unit | `snap-test.sh test/cards.test.ts test/theme.test.ts` | ✅ | ⬜ |
| SCREEN-03/07 | 04-06 T3 | pointers name tabs; scan for numbered sections and jargon | unit | `snap-test.sh` (whole tree) | ✅ | ⬜ |
| SCREEN-04 | 04-07 T1 (tracer) | Enter jump, highlight exactly on cited rows, visible at height 20 | unit | `snap-test.sh test/cards.test.ts test/theme.test.ts` | ✅ | ⬜ |
| SCREEN-04 | 04-07 T2 | Esc return, jump kept across a mark, jump footer | unit | `snap-test.sh test/cards.test.ts test/extension.test.ts` | ✅ | ⬜ |
| SCREEN-06 | 04-08 T1 (tracer) | tool-row updates each second, footer status set and cleared (fake time) | integration | `snap-test.sh test/extension.test.ts test/verdict-block.test.ts` | ✅ | ⬜ |
| SCREEN-06 | 04-08 T2 | `progressView` vectors, widths | unit | `snap-test.sh test/progress.test.ts` | ❌ W0 | ⬜ |
| SCREEN-06 | 04-08 T3 | build/reassess progress; board header | unit | `snap-test.sh` (whole tree) | ✅ | ⬜ |
| SCREEN-01/05/07 | 04-09 T1 (tracer) | stored runs: widths × themes × hosts × tabs; rows100 ≤ 20 | stored runs (free) | `render-matrix.mts` + `pi-surface-check.mts` from a kept snapshot | ❌ W0 | ⬜ |
| SCREEN-02/03/04 | 04-09 T2 | real Pi reopen + Ctrl+O in dark/light; full board key walk | pty (free) | `pi-reopen-check.sh`; `board-pty-check.sh --keys tabs` | ❌ W0 | ⬜ |
| all | 04-09 T3 | live `dist/` swapped, previous kept, live checks OK | runtime | `test -f dist/verdict.js && … grep -q OK live-dist-checks.txt` | — | ⬜ |
| SCREEN-06 | 04-10 T1 (tracer) | capture script on the free demo | integration (free) | `live-progress-check.mts --dry` from a kept snapshot | ❌ W0 | ⬜ |
| SCREEN-06 | 04-10 T2 | one live aigw-local situation ≤ $0.5 | live (paid, once) | `grep OK live-progress.txt && live-check.mjs spent --cap 1` | — | ⬜ |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

## Wave 0 Requirements

- [ ] `test/verdict.test.ts`, `test/verdict-block.test.ts`, `test/theme.test.ts` — created in 04-01.
- [ ] `test/progress.test.ts` — created in 04-08.
- [ ] `board-pty-check.sh` — 04-02; `render-matrix.mts`, `make-session.mts`, `pi-reopen-check.sh` — 04-09; `live-progress-check.mts` — 04-10.
- Framework install: none.

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| The chat verdict block and the Провалы → Диалоги jump look right in a real Pi, one light and one dark theme, at projector size (80–100 columns); screenshots saved | SCREEN-01, SCREEN-04, SCREEN-07 | Visual judgment of colors, the highlight and Cyrillic in the owner's real terminal font; the user was asleep during this phase | Restart Pi in this worktree after 04-09; `/agent-lab <acquiring run>`; open Провалы, Enter, Esc; in chat run `agent_lab_inspect` on the run and press Ctrl+O; switch theme and repeat; save two screenshots under `~/agent-lab-evidence/phase-04/` |
| A person watches the live progress during a real run: tool row, Pi footer and board header move, show time and money with «оценка», and the footer clears at the end | SCREEN-06 | The pty and capture scripts prove the events, not how the live screen reads to a person | During the next real run of the acquiring set (for example the phase-7 demo recording), watch the three places for a minute and at the end |
| Reopening a real session that contains a board-appended block and a chat block shows both blocks | SCREEN-02 | The pty check uses a built session file; a person confirms it on a real session | Close and reopen the Pi session used above (`pi --session …`) and check that both blocks are drawn |
| If 04-10 stopped at preflight or budget: the live progress item is `human_needed` | SCREEN-06 | Mock server or budget not available unattended | Run 04-10 Task 2 when the mock server is up and the budget says GO |

## Validation Sign-Off

- [x] All tasks have `<automated>` verify with a `<fails_when>` or a Wave 0 dependency
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 60 s for unit tasks
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending

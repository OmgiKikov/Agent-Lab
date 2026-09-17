---
phase: "6"
slug: "legkiy-start"
status: draft
nyquist_compliant: true
wave_0_complete: false
created: "2026-09-17"
---

# Phase 6 — Validation Strategy

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` via `tsx --test`, `tsc` and the extension typecheck |
| **Config file** | `tsconfig.json`; runner `.planning/phases/01-odno-chestnoe-chislo/snap-test.sh` |
| **Quick run command** | `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh test/connection-check.test.ts test/progress.test.ts test/start-path.test.ts` |
| **Full suite command** | `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh` (working tree: tsc + all tests + extension typecheck); `--full` for committed HEAD |
| **Free real-agent check** | `down-check.mjs` (real acquiring adapter, env overrides on a closed port; never contacts :8080 or :8090) |
| **Free real-Pi check** | `live-start-check.sh --case widget` (tmux, no message sent) and `--case dry` |
| **Paid check (once per case, ≤ $1 total)** | `live-start-check.sh --case down`, then `--case up` if the down case cost ≤ $0.40 and the preflight allows it. The cap is the phase-06 ledger `~/agent-lab-evidence/phase-06/ledger.tsv` (one run per case) plus the runner's $0.60 per-case kill. `live-check.mjs budget` does not apply, because no Lab record is created. |
| **Estimated runtime** | ~30–60 s per snapshot run; ~60 s for the widget case; up to 10 min per paid case |

Never run `npm test` or `npm run build` in the worktree. Plans run one at a time on the main tree, after phases 2–5 are complete.

## Sampling Rate

- **After every task commit:** that task's `<verify>` command (quick run on its test files).
- **After every plan:** `snap-test.sh` on the whole working tree.
- **Before `/gsd-verify-work`:** `snap-test.sh --full`, then:
  - `OK down-check`;
  - `OK live-start dry` and `OK live-start widget` (or `human_needed: widget`);
  - the dist swap checks;
  - `OK live-start down` (or `human_needed: live-down`), and `OK live-start up` or the reason it was skipped;
  - a ledger total ≤ $1.00;
  - no Pi process left running.
- **Max feedback latency:** 60 seconds for unit tasks.

## Per-Task Verification Map

| Req | Plan / Task | Behavior | Test Type | Automated Command | File Exists | Status |
|-----|-------------|----------|-----------|-------------------|-------------|--------|
| START-03 | 06-01 T1 (tracer) | A refused connection stops validate before its dialog and before `create`; tui and print | integration | `snap-test.sh test/connection-check.test.ts test/extension.test.ts` | ❌ W0 (connection-check created here) | ⬜ |
| START-03 | 06-01 T2 | Nine kinds + server-error variant; the six reproduced strings; real inline targets (missing command/file, crash, hang, not-JSON, 503, ok); K rows; D1 body | unit | `snap-test.sh test/connection-check.test.ts` | ✅ (from T1) | ⬜ |
| START-03 | 06-01 T3 | Gates in live build, run and board run; D1 consent and decline (K6/K7); 2-minute freshness; remember on ok; skill rule; real adapter refused with a closed port | integration + free real adapter | `snap-test.sh test/extension.test.ts test/connection-check.test.ts test/skill.test.ts` + `down-check.mjs --dist $SNAP/dist` | ✅ | ⬜ |
| START-04 | 06-02 T1 (tracer) | Prompt: main path + one explicit-only sentence; skill: explicit-only section last, M0/M4; tools registered | unit (text) | `snap-test.sh test/start-path.test.ts test/skill.test.ts test/extension.test.ts` | ❌ W0 (start-path created here) | ⬜ |
| START-04 | 06-02 T2 | Descriptions, S5, S6, C-645 title, hand-off, interim widget, board hint; demo still works | unit (text) | `snap-test.sh test/start-path.test.ts test/extension.test.ts test/cards.test.ts test/skill.test.ts` | ✅ | ⬜ |
| START-01/03 | 06-03 T1 (tracer) | `preflight`: check + dialogue count + material sizes, no content; K5; G1/G2 live rows; freshness shared with gates | integration | `snap-test.sh test/extension.test.ts test/connection-check.test.ts` | ✅ | ⬜ |
| START-03 | 06-03 T2 | K/G rows painted at 40–160, light/dark, ESC detail; dispatcher; call row «Проверка связи с агентом» | unit + real Pi component | `snap-test.sh test/connection-block.test.ts test/theme.test.ts test/verdict-block.test.ts test/extension.test.ts` | ❌ W0 (connection-block created here) | ⬜ |
| START-01 | 06-03 T3 | Skill start section (7 steps, M1/M2/M3 verbatim, fixture only); prompt routing; copy scan; no real paths | unit (text) | `snap-test.sh test/start-path.test.ts test/skill.test.ts test/extension.test.ts` | ✅ | ⬜ |
| START-02 | 06-04 T1 (tracer) | Factory widget at session start (N0) and after a preflight `tool_execution_end` (ticks); print mode silent | integration | `snap-test.sh test/extension.test.ts test/progress.test.ts test/theme.test.ts` | ✅ (progress.test.ts from phase 4) | ⬜ |
| START-02 | 06-04 T2 | Truth table N0–N10, values, plurals; render matrix widths × states × themes; lint `○` | unit | `snap-test.sh test/progress.test.ts test/theme.test.ts` | ✅ | ⬜ |
| START-02 | 06-04 T3 | Not hidden by `before_agent_start`; hidden after start (tool and board); returns for a new draft; `checklist` text in results; parity; S4 text scan | integration | `snap-test.sh test/extension.test.ts test/start-path.test.ts test/connection-block.test.ts test/progress.test.ts` | ✅ | ⬜ |
| START-02 | 06-05 T1 (tracer) | Real Pi TUI shows the checklist at 40/80/160 (empty cwd and connection copy); assertion script on a synthetic stream | free real Pi (tmux) | `live-start-check.sh --case dry` and `--case widget` | ❌ W0 (scripts created here) | ⬜ |
| all | 06-05 T2 | Live `dist/` swapped from HEAD, previous build kept, down-check passes on the live `dist/` | runtime | `test -f dist/connection.js && … grep -q '^OK down-check' live-dist-down-check.txt` | — | ⬜ |
| START-01/03 | 06-05 T3 | One json-mode conversation per case on the acquiring agent: found adapter, prompt, 15 dialogues; refused before spend (down); ok (up); ≤ $1; no Pi left | live (paid, once per case) | `live-start-check.sh --case down` / `--case up`; ledger sum ≤ 1.00 | — | ⬜ |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

## Wave 0 Requirements

- [ ] `test/connection-check.test.ts`: created in 06-01 T1.
- [ ] `test/start-path.test.ts`: created in 06-02 T1.
- [ ] `test/connection-block.test.ts`: created in 06-03 T2.
- [ ] Checklist cases in `test/progress.test.ts` (the file comes from 04-08): 06-04 T1/T2. If phase 4 was cut and the file is missing, 06-04 T1 creates it.
- [ ] `test/extension.test.ts` harness keeps every `pi.on` handler in a map: 06-04 T1.
- [ ] `test/skill.test.ts` and the injected-instructions test are rewritten for the moved discover text: 06-02 T1.
- [ ] `down-check.mjs`: 06-01 T3. `live-start-check.sh`, `live-start-run.mjs`, `live-start-assert.mjs` and `fixtures/json-events-sample.jsonl`: 06-05 T1.
- Framework install: none.

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| The preparation checklist looks right in a real Pi at projector size (80–100 columns), in one light and one dark theme: ticks, the highlighted current step, the red failed step; screenshots saved | START-02 | Visual judgment of colors and Cyrillic in the owner's real terminal font; the user was asleep during this phase | After 06-05 T2, start `agent-lab chat` in a folder with a remembered acquiring connection; screenshot the widget; switch the theme and repeat; save both under `~/agent-lab-evidence/phase-06/` |
| A real newcomer conversation: the START-01 sentence in `agent-lab chat` (TUI) leads to the found-list, the consent dialog for a new agent, the free check and the build dialog titled «Собрать ситуации для проверки?», which the person declines | START-01, START-03 | Only needed if the json-mode run could not run or did not reach preflight (`human_needed: live-down` / `live-up` below); the TUI dialogs themselves are covered by stubbed-UI tests | In an empty folder: `agent-lab chat`, type the sentence from 06-05 `<context>`, answer «Нет» at the build dialog, and note whether the prompt, the adapter and «15 диалогов» were named |
| The mock-down explanation in a real TUI | START-03 | Optional visual check of the painted K rows | Start Pi with `AGENT_LAB_TARGET_URL` and `AGENT_LAB_MOCK_URL` on a closed port (never stop the real mock), ask «проверь связь», and screenshot |
| If 06-05 T1 tmux capture was unreliable: `human_needed: widget` | START-02 | tmux timing | Use the first manual row |
| If 06-05 T3 did not pass or was skipped: `human_needed: live-down` / `human_needed: live-up`, with the recorded finding | START-01, START-03 | Model behavior or preflight conditions (a Lab run active, services down, budget) | Use the second manual row |

## Validation Sign-Off

- [x] All tasks have `<automated>` verify with a `<fails_when>` or a Wave 0 dependency
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 60 s for unit tasks
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending

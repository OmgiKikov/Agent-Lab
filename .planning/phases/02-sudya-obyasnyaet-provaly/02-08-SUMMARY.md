---
phase: 02-sudya-obyasnyaet-provaly
plan: 08
subsystem: pi-surfaces
tags: [pi-board, keys, native-dialogs, expectation-sheet, run-confirmation, trust]
status: complete

requires:
  - phase: 02-sudya-obyasnyaet-provaly
    provides: "02-07: expectationSheet(record), acceptDraft over every situation, setExpectation, start({ requireAccepted }), ownerExpectationScenarioIds"
  - phase: 02-sudya-obyasnyaet-provaly
    provides: "02-05: the board Line/wrapRows row shape and the BoardAction union"
provides:
  - "Board section 2 of an evaluate draft is the expectation sheet (UI-SPEC F5): heading, gutter, right-aligned number, Должен, every owner rule, marker, version row"
  - "Board keys y (confirm all) and e (correct the selected expectation), scoped to that sheet only"
  - "BoardAction accept / expect; BoardOptions.notice.kind success | info | error; Line.lead for gutter-led rows"
  - "/agent-lab loop branches accept, expect and a changed run that confirms and starts in one dialog"
  - "agent_lab_accept native confirm/select/editor loop for a set of more than one situation"
  - "agent_lab_run (chat) confirms expectations first; both Pi run paths start with requireAccepted: true"
  - "sheetLines on every draft summary, agent_lab_inspect and agent_lab_accept, printed by the collapsed tool result"
affects: [02-09, phase 3 (consent keys), phase 4 (board section 2 restyle)]

plan_head_before: 6f73acc1c823b29027daa9a00f38fb18a5ee965b
frozen_protocol: v10-unchanged
paid_calls: 0

actuals:
  tokens: 22287   # chars/4 over the realized extensions + test diff (89 150 chars)
  tasks: 3
  commits: 3      # MEASURED git rev-list --count 6f73acc..HEAD before this docs commit

tech-stack:
  added: []
  patterns:
    - "Line.lead: a same-width prefix that replaces the first wrapped line's indent, so the sheet gutter «▸ » and the number «12.» survive wrapping while continuations still hang two columns in"
    - "The board follows the selection instead of resetting the scroll: sheetRows records the unwrapped row index of the selected situation and render re-wraps only the rows before it, so the anchor is correct at every width"
    - "One sheet, three surfaces: the board rows, the dialog bodies (compactLines) and the tool text (lines) all come from the single expectationSheet call — no surface rewords or recounts"
    - "The chat accept loop returns to its own confirm after every correction, so the owner always confirms the sheet they last saw"

key-files:
  created: []
  modified:
    - extensions/cards.ts
    - extensions/agent-lab.ts
    - test/cards.test.ts
    - test/extension.test.ts

key-decisions:
  - "Both Pi run paths now pass reviewer: 'human' together with requireAccepted: true. A Pi run cannot start unless acceptedDraftHash matches the shown draftHash, so claiming automated card review — and appending the «checked automatically, without human validation» limitation — would have been false. Agent Lab still invents no per-dialogue verdict: humanReviews stays empty."
  - "The confirm-and-start body is runPlan + C-40, not a separately assembled compact sheet. For a set of more than one situation runPlan's scope already IS the compact sheet, and a single test keeps its full definition — which is more, not less, than the dialog needs."
  - "y is refused on a draft with no situations (record.scenarios.length > 0), so the empty sheet's «Ситуаций пока нет.» is never contradicted by a key that would confirm nothing; the header and footer fall back to today's text there too."
  - "The chat select options are rebuilt from sheet.cards and matched back by index over the safeText'd strings, so a title containing terminal escapes can neither reach the terminal nor pick a different situation."
  - "expectationSheet is memoised per record object on the board. It recomputes draftHash over the whole record and the board re-renders on every key press and every 750 ms refresh."

requirements-completed: [TRUST-10, TRUST-11]

duration: 78min
completed: 2026-09-17
---

# Phase 2 Plan 08: Board keys, the chat accept loop and starting only after confirmation Summary

**In Pi the owner now sees every expectation of a draft on one screen — `Ситуация / Должен / Правило N` with the same owner rule numbers the failure explanations use — confirms them all with `y`, rewrites one in their own words with `e`, or does the same from the chat through `agent_lab_accept`; a Pi run refuses to start until those expectations are confirmed. 443 tests pass, typecheck clean, no model call was made.**

## Performance

- **Duration:** about 78 min (2026-09-17)
- **Tasks:** 3/3
- **Files:** 4 modified (2 extension sources, 2 test files)
- **Paid steps:** 0 — this plan makes no model calls

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (tracer) | The board shows every expectation and `y` confirms them all | `054697a` | extensions/cards.ts, extensions/agent-lab.ts, test/cards.test.ts, test/extension.test.ts |
| 2 | `e` corrects one expectation in the owner's words; `r` confirms and starts in one dialog | `ba18ada` | extensions/agent-lab.ts, test/extension.test.ts, test/cards.test.ts |
| 3 | The chat accept loop, `agent_lab_run` confirmation and `sheetLines` in tool results | `7c6b263` | extensions/agent-lab.ts, test/extension.test.ts |

**Tracer feedback gate.** Task 1 carries no `gate` attribute, auto mode is off (`auto_advance: false`, `_auto_chain_active` unset) and `human_verify_mode` is `end-of-phase` with an automated-only `<verify>`. The verify was therefore re-run end to end — `snap-test.sh test/cards.test.ts test/extension.test.ts` → **45 pass, 0 fail**, exit 0 — and the plan expanded without a checkpoint.

## Note for phase 3

`y` is bound only to confirming expectations in board section 2 (an evaluate draft in `review`, no open questions, not searching, help closed, at least one situation). It is free everywhere else, so **phase 3 may bind `y` to «согласен» only in the results scope**, keeping the shared meaning «да». **Phase 3 must not use `e`** — it belongs to the draft sheet in every scope (UI-SPEC Key Map Registry, RESEARCH A6).

## What exists now

| Symbol / path | Kind | Where |
|---|---|---|
| sheet rows, `SHEET_ROLE`, `sheetRows`, `sheet()` cache | private board behaviour | extensions/cards.ts |
| `draftHeadline` (C-31 / C-32 / C-33) and `draftFooter` (four width tiers) | private board behaviour | extensions/cards.ts |
| `BoardAction` `accept`, `BoardAction` `expect` | exported types | extensions/cards.ts |
| `BoardOptions.notice.kind: 'success' \| 'info' \| 'error'` | changed type | extensions/cards.ts |
| `Line.lead` and its handling in `wrapRows` | row shape | extensions/cards.ts |
| keys `y` / `e`; tab label `2 Ситуации N`; help row C-49; list suffix C-28 | board behaviour | extensions/cards.ts |
| `runScope(record)` | new function | extensions/agent-lab.ts |
| loop branches `accept`, `expect`; changed `run` | command behaviour | extensions/agent-lab.ts |
| `agent_lab_accept` native loop (C-41…C-46) | tool behaviour | extensions/agent-lab.ts |
| `agent_lab_run` confirm-and-start | tool behaviour | extensions/agent-lab.ts |
| `sheetLines` in `summary()` and `toolDisplay.renderResult` | tool output | extensions/agent-lab.ts |

## The board (UI-SPEC F5)

Section 2 of an `evaluate` draft in `review` replaces the collapsed card detail with the sheet: `ЧТО АГЕНТ ДОЛЖЕН СДЕЛАТЬ` (accent, bold), `<n> ситуаций · номер правила — порядок в ваших материалах` (muted), a blank row, then every situation of `entries()` — so the search still filters it — as `▸ ` or two spaces, the label right-aligned to the sheet's `labelWidth` by `visibleWidth`, one space, `Ситуация: <goal>`; the detail rows (`Должен:`, every rule, the owner marker) start at `2 + labelWidth + 1`. The last row is `Версия ожиданий: <hash12>`, taken from `sheet.lines.at(-1)` so the board and the CLI cannot disagree. `Enter` still opens today's full card detail; `↑/↓` and `j/k` put the selected situation's first row at the top of the body, and `PgUp`/`PgDn`/`Home`/`End` hand the scroll back to the reader.

| State | Header line | Token |
|---|---|---|
| Not confirmed | `Проверьте ожидания: <n> ситуаций. y — подтвердить все · e — поправить выбранную.` | `warning` |
| Confirmed | `Ожидания подтверждены. r — запуск.` | `success` |
| Changed after confirmation | `Ожидание изменено после подтверждения. y — подтвердить снова.` | `warning` |
| Open questions, no situations, or a compare record | today's text | unchanged |

Notices now carry three kinds — `success` → `success`, `info` → `text`, `error` → `error`. The loop's `inform` default became `success`, which is exactly the colour every existing notice already had, so nothing that shipped earlier changed appearance.

## The keys and the flows

| Action | What happens |
|---|---|
| `y` | `acceptDraft(id, draftHash)` on the freshly read record → `Ожидания подтверждены: <n> ситуаций. r — запуск.` (success); already confirmed → `Ожидания уже подтверждены. r — запуск.` (info); a draft changed meanwhile → the lab's `Черновик изменился, пока вы смотрели. Проверьте ожидания ещё раз.` (error) |
| `e` | `ctx.ui.editor('Что агент должен сделать в этой ситуации? Своими словами.', <current>)`; cancel is silent; empty or unchanged → `Ожидание не изменено.`; over 3000 characters → the named error with **no** call to `setExpectation`; an exact-check situation → the lab's `Эту ситуацию проверяют точные проверки, а не судья. Поправьте её словами: a.`; saved → `Ожидание изменено: «<title>». Подтвердите ожидания снова: y.` with the selection unmoved |
| `r`, unconfirmed | `Подтвердить ожидания и запустить?` with the compact sheet, the run plan and `Да — подтвердить все ожидания и начать прогон.` → yes confirms all, then starts with `requireAccepted: true`; no reopens the board unchanged |
| `r`, confirmed | today's `Запустить проверку?`, also `requireAccepted: true` |
| start refused | `Сначала подтвердите ожидания ситуаций: они изменились или ещё не подтверждены. y — подтвердить.` (error) |

Outside that scope `y` and `e` do nothing and show nothing: another section, a `compare` record, a draft with open questions, a finished run, a draft with no situations. While searching they type letters; with help open they are swallowed like every other key.

## The chat (UI-SPEC Chat flow)

`agent_lab_accept` on a set of more than one situation loops: `Подтвердить ожидания: <n> ситуаций?` with the compact sheet and `Да — подтвердить все. Нет — поправить одну ситуацию или отменить.` → yes returns `Ожидания подтверждены: <n> ситуаций. Можно запускать.`; no offers `Поправить ожидание одной ситуации` / `Не подтверждать сейчас`; the correction path picks `<n>. <title>`, opens the same editor and returns to the confirmation with the updated sheet — the marker row and all. Declining returns `Ожидания не подтверждены. Прогон не начнётся, пока они не подтверждены.` The one-situation path is byte-identical to before.

`agent_lab_run` asks the same `Подтвердить ожидания и запустить?` when the expectations are not confirmed. Every draft summary, `agent_lab_inspect` and `agent_lab_accept` carry the full sheet as `sheetLines`, and the collapsed tool result prints it under the title, so the sheet stays in the chat history.

## Threat register outcome

| Threat ID | Disposition | How it is held |
|---|---|---|
| T-02-26 (spoofed chat confirmation or expectation text) | mitigated | `agent_lab_accept` declares only `id` (asserted by test), consent comes from `ctx.ui.confirm`/`select`, text from `ctx.ui.editor`; headless contexts are refused as before |
| T-02-27 (run on unconfirmed expectations) | mitigated | Board `r` and `agent_lab_run` both pass `requireAccepted: true`; the stubbed refusal is asserted to reach the owner as a named notice |
| T-02-28 (terminal escapes in sheet rows and options) | mitigated | Board rows go through `line()` → `safeText`; the compact sheet and the select options are `safeText`-mapped before display, and the option is matched back by index over the escaped strings |
| T-02-29 (a second key press) | mitigated | `finish` disposes the board before the loop acts; the test presses `y` twice and asserts one action |
| T-02-SC (package installs) | accepted | No packages were installed |

## Verification

| Check | Result |
|---|---|
| Task 1 verify — `snap-test.sh test/cards.test.ts test/extension.test.ts` | exit 0 — **45 pass, 0 fail** |
| Task 2 verify — `snap-test.sh test/extension.test.ts test/cards.test.ts test/experiment.test.ts` | exit 0 — **106 pass, 0 fail** |
| Task 3 verify — `snap-test.sh` (full working tree, every test + extension typecheck) | exit 0 — **443 pass, 0 fail**, typecheck clean |
| `grep -c "type: 'expect'" extensions/cards.ts` | 2 (≥ 1) |
| `grep -c "action.type === 'accept'" extensions/agent-lab.ts` | 1 |
| `grep -c "2 Ситуации" extensions/cards.ts` | 1 |
| `grep -c "y — подтвердить все ожидания · e — поправить ожидание выбранной ситуации" extensions/cards.ts` | 1 |
| `grep -c "'success' \| 'info' \| 'error'" extensions/cards.ts` | 1 |
| `grep -c "action.type === 'expect'" extensions/agent-lab.ts` | 1 |
| `grep -c "Что агент должен сделать в этой ситуации? Своими словами." extensions/agent-lab.ts` | 1 |
| `grep -c "Подтвердить ожидания и запустить?" extensions/agent-lab.ts` | 2 (≥ 1) |
| `grep -c "requireAccepted: true" extensions/agent-lab.ts` | 2 (≥ 1) |
| `grep -c "Validation set:" extensions/agent-lab.ts` | 0 |
| `grep -c "sheetLines" extensions/agent-lab.ts` | 5 (≥ 2) |
| `grep -c "Поправить ожидание одной ситуации"` / `"Не подтверждать сейчас"` | 2 / 1 |
| `grep -c "Какую ситуацию поправить?" extensions/agent-lab.ts` | 1 |
| `awk '/name: .agent_lab_accept./,/executionMode/' … \| grep -c "Type.Object({ id: Type.String"` | 1 |

The board is proved on a real two-situation draft and on a 13-situation sheet whose first situation carries 11 rules: at widths 40, 60, 80, 110 and 160 no row is wider than the screen, no sheet row contains `…` (only the header line and the sidebar list may be cut, as the UI-SPEC allows), and after four `↓` presses the selected situation's first row is the first body row at every one of those widths. A tall render shows every rule of every situation with no `и ещё K` row. The chat and board flows are proved end to end through the real `ExperimentLab` on disk — `setExpectation` and `start` are only spied on, never replaced — so the owner's words really become the stored criterion.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — Missing critical correctness] Pi runs now record `reviewMode: 'human'`**
- **Found during:** Task 2
- **Issue:** The plan mandates `reviewer: 'human'` for the confirm-and-start path. Leaving the already-confirmed path on today's `reviewer: 'automated'` would have made the same guarantee report two different truths, and `start` appends the limitation «Generated scenario expectations were checked automatically, without human validation» for `automated` — a false statement once `requireAccepted: true` has proved a human confirmation exists.
- **Fix:** Both board `r` and `agent_lab_run` pass `reviewer: 'human'` together with `requireAccepted: true`. `humanReviews` is untouched, so Agent Lab still invents no per-dialogue verdict.
- **Files modified:** extensions/agent-lab.ts, test/extension.test.ts
- **Commit:** `ba18ada`
- **Test impact:** `test/extension.test.ts` «conversation runs only the confirmed plan…» and the native demo fixture now assert `reviewMode: 'human'`, `acceptedDraftHash === draftHash` and the absence of the automated limitation. `test/experiment.test.ts` and `test/product-flow.test.ts` call `lab.start` directly with `reviewer: 'automated'` and are unchanged.

**2. [Rule 2 — Missing critical correctness] `y`, the header and the footer stand down on an empty sheet**
- **Found during:** Task 1
- **Issue:** `expectationSheet` happily describes a draft with zero situations, so the header would have read «Проверьте ожидания: 0 ситуаций. y — подтвердить все», and the footer would have offered `y` — while `acceptDraft` refuses («Подтверждать нечего»). The UI consideration «empty sheet» requires `y`/`e` to do nothing there.
- **Fix:** The key scope requires `record.scenarios.length > 0`; `draftHeadline` and `draftFooter` fall back to today's text when `sheet.count` is 0. The sheet body still shows `Ситуаций пока нет.` and the next step.
- **Files modified:** extensions/cards.ts, test/cards.test.ts
- **Commit:** `054697a`

**3. [Rule 3 — Blocking] `wrapRows` needed a `lead` to keep the gutter and the number**
- **Found during:** Task 1
- **Issue:** `wrapRows` prepends `' '.repeat(indent)` to every wrapped line, so a row whose first line must start with `▸  5. ` could either keep its prefix (indent 0, continuations falling back to column 0) or hang correctly (prefix lost) — not both.
- **Fix:** `Line.lead` — an optional same-width prefix that replaces the first line's indent. Every existing row leaves it undefined and wraps exactly as before.
- **Files modified:** extensions/cards.ts
- **Commit:** `054697a`

### Plan steps adjusted

- **The confirm-and-start body is `runPlan(record)` + C-40**, rather than a separately assembled «compact sheet + run-plan tail». After Task 2's split, `runPlan`'s scope for a set of more than one situation already *is* the compact sheet, and a one-situation draft keeps its full definition — which is what that dialog should show. The observable strings match the plan.
- **Task 2's board work was already complete after Task 1.** The plan reserved `extensions/cards.ts` in Task 2 «only what the behavior list needs (selection-following scroll, if Task 1 left gaps)». Task 1 left none; Task 2's only `cards.ts` change is the 13-situation overflow test.
- **`e` does call `setExpectation` on an exact-check situation.** The refusal text is the lab's, so the extension does not duplicate the rule; the plan forbids the call only for text over 3000 characters, which is enforced before the call.
- **Two existing board tests were updated, not deleted.** «80×24 shows the opening…» now presses `Enter` first, because section 2 of a draft opens as the sheet and the opening moved behind `Enter` by design (UI-SPEC F5); «the board leads with a plain verdict…» reads `2 Ситуации` (UI-D-12).
- **The injected-instructions assertions were rewritten** to the new `agent_lab_accept` sentence, as the plan's Task 3 behaviour requires.
- **Run-context instruction honoured:** only `extensions/`, `test/` and this phase directory were staged; `.planning/phases/03-*` … `06-*` were never touched.

### Judge v11

The run context asked to skip any step about `judgedCut`, `judgedBeforeSeq`, `cutBefore` or goal-v2, which were rolled back. This plan names none of them — its surfaces read only `successCriteria`, the `goal_attainment` rubric and the v10 sheet rows — so **no step was skipped**. The protocol stays frozen at v10.

## Known Stubs

None. `git diff 6f73acc..HEAD -- extensions test` contains no added `TODO`, `FIXME`, `placeholder`, «coming soon», «не реализован», `t.skip` or `test.todo`.

## Open for the next plans

- The light/dark screenshot of the sheet is a backstop: 02-09 renders the real acquiring draft at five widths and records the token list; the human look in one light and one dark theme is phase 4 (UI-SPEC «Width, Wrap and Theme Rules» row 5).
- Phase 4 restyles board section 2 and may re-lay the tabs; it must keep `y` and `e` on the draft sheet and keep the `[P2]` wording and row order.
- The CLI still has no expectation edit path, by design (UI-SPEC S1, CTX-19): correcting an expectation is a Pi-only action because the text may come only from a native editor.

## Self-Check: PASSED

All four modified files exist on disk and all three task commits (`054697a`, `ba18ada`, `7c6b263`) are present in git history.

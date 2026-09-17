---
phase: 04-ekran-rezultata-v-pi
plan: 01
subsystem: ui
tags: [pi-chat, verdict-block, theme, tracer, tool-render, result-view]

# Dependency graph
requires:
  - phase: 01-odno-chestnoe-chislo
    provides: ResultView / buildResultView / resultViewRows (roles lead, line, situation, detail, alarm), SMALL_SAMPLE, the control predicates (unmeasuredControl), snap-test.sh
  - phase: 02-sudya-obyasnyaet-provaly
    provides: causeSection / SECTION_TEXT / exampleRows roles (cause, example, title, expected, said, rule, more, violated, unverified), pluralForm, safeText / wrapRows in cards.ts, the VIEW_ROLE / SECTION_ROLE role→token maps
  - phase: 03-soglasie-cheloveka-s-sudey
    provides: JudgeAgreement (queueFailures, sampledPasses, unmarked, marks[].stale/answer, disagreements), agreement / agreement-tail rows, disagreementRows, DISAGREEMENT_BOARD_TITLE, assertPlainCopy
  - phase: 03.1-spravilsya-zapros-vypolnen-i-pravila-prompta-soblyudeny
    provides: the breakdown row under the number (C-304), the control line naming both facts, explanation kind «оба» — all carried unchanged inside the block's first rows
provides:
  - "src/verdict.ts (pure): verdictLine (V1, C-104…C-109), verdictLevel, nextStep (V2 rules 1, 0, 2a, 2b, 2c, 3, 4, 5; chat and board texts C-110…C-117, C-147), verdictBlockRows (B1 collapsed, B2 expanded), GOOD_FROM = 80, MIXED_FROM = 50, NO_FAILURES_TEXT, allFailuresTab (R-01)"
  - "src/result-view.ts: SMALL_SAMPLE and shortId exported"
  - "extensions/render/theme.ts: Tone, Row, PaintTheme, GLYPH, ROLE_TONE (phase 2–3 roles + verdict:good/warn/bad, headline, next, heading, pointer, no-failures), paint, renderRows = safeText → wrapRows → paint"
  - "extensions/render/verdict-block.ts: VERDICT_KIND, VerdictDetails { kind, version: 1, runId, resultKey } (ids only, REV-01), isVerdictDetails, rememberView / viewFor / forgetViews (last 20 views in memory), missingRunText (C-190), VerdictBlock component, renderAgentLabResult (dispatch → block | C-190 row | legacy; try/catch → escaped content text)"
  - "extensions/agent-lab.ts: legacyResult (today's renderer, unchanged); toolDisplay.renderResult dispatches through renderAgentLabResult; agent_lab_run returns content = today's JSON + shownToOwner (C-119) and details = { kind, version, runId, resultKey } after rememberView(resultKey, bundle.view)"
  - "tests: test/verdict.test.ts (V1/V2 vectors, B1/B2 rows, copy scan), test/theme.test.ts (render matrix on fake themes, paint, GLYPH, render lint), test/verdict-block.test.ts (tracer, marker, C-190, legacy, throwing view, real Pi themes at 40–160)"
affects: [04-02 theme move (safeText/wrapRows into theme.ts), 04-03 entry host + record rebuild in viewFor, 04-06 tab files and pointer renames (allFailuresPointer «раздел 1», the cards.ts no-failures literal), 04-08 progress rows through renderRows, 04-09 render matrix on stored runs, 05 report]

# Actuals (#2632) — same estimateTokens scale as the plan's estimate (chars/4 over the files actually changed; the diff alone is 23240)
actuals:
  tokens: 52875
  tasks: 3
  commits: 5
plan_head_before: 589602be5e715539989567494c58ba6d24f94b37

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Ids in the session, views in memory: a tool result's details carry only kind, version, runId and resultKey; the renderer takes the view from rememberView/viewFor and prints an honest one-row fallback (C-190) on a miss — bank text never enters a 0644 session file"
    - "One renderer for every host: pure row builders return { role, indent, text }; renderRows escapes, wraps by words with the hanging indent and paints by ROLE_TONE; no host measures width by hand"
    - "Versioned details dispatch: isVerdictDetails checks kind + version + string ids; everything else keeps the legacy renderer byte for byte, and any throw ends as Text(safeText(content))"
    - "Queue counts derived, not stored: the «Дальше» rules read unmarked ∩ queueFailures, unmarked ∩ sampledPasses and current unsure marks from the published JudgeAgreement — src/agreement.ts untouched"
    - "Lint as a test: test/theme.test.ts reads extensions/render/** and src/verdict.ts and fails on .slice/.substring/padStart/padEnd, <text>.length and any literal glyph outside GLYPH (comments included)"

key-files:
  created:
    - src/verdict.ts
    - extensions/render/theme.ts
    - extensions/render/verdict-block.ts
    - test/verdict.test.ts
    - test/theme.test.ts
    - test/verdict-block.test.ts
  modified:
    - src/result-view.ts
    - extensions/agent-lab.ts

key-decisions:
  - "04-01: agent_lab_run session details hold { kind: 'agent-lab/verdict', version: 1, runId, resultKey } only (REV-01); the view lives in an in-memory cache keyed by runId:resultHash, and a cache miss draws «Прогон <id8> не найден в .agent-lab — блок нельзя показать.» — the record rebuild is 04-03"
  - "04-01: the collapsed block drops only `situation` rows from resultViewRows, so the alarm, agreement and agreement-tail rows of phases 3/03.1 stay; the expanded block shows the no-failures sentence too, so expanding never removes a row"
  - "04-01: the V2 queue counts come from view.agreement (unmarked ∩ queueFailures, unmarked ∩ sampledPasses, current unsure marks on a queued trial) — no new agreement field, RESEARCH Open Question 1 closed as the plan resolved it"
  - "04-01: NO_FAILURES_TEXT is defined in src/verdict.ts byte-identical to the cards.ts literal (an extension cannot be imported from src); cards.ts keeps its own literal until 04-06 moves the tab"
  - "04-01: the render lint treats comments like code — a «→» in a doc comment is a violation, so GLYPH is the only place a glyph is spelled anywhere in extensions/render/**"

patterns-established:
  - "Fixture titles in copy-scanned tests are Russian («Провал 1», «Успех 2», «Чек не пришёл»): record text is scanned as our copy"
  - "Fake themes for width tests emit visible markers (<fg:tone>…</fg> dark, [fg:tone]…[/fg] light) stripped before visibleWidth, so a wrong token or a missing reset is visible in the output"
  - "Real-host tests capture Pi's current Theme through a probe ToolExecutionComponent instead of importing the theme global"

requirements-completed: [SCREEN-01, SCREEN-02, SCREEN-07]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "After agent_lab_run Pi's own tool row draws the verdict block (V1 first under «Проверка агента», «Дальше» and the hint last) from details that hold four ids only; no title, quote or model text reaches details or the screen; a cache miss shows the C-190 row"
    requirement: SCREEN-02
    verification:
      - kind: integration
        ref: "test/verdict-block.test.ts#после agent_lab_run Pi рисует блок-вердикт из details, в которых только идентификаторы"
        status: pass
      - kind: integration
        ref: "test/verdict-block.test.ts#ни маркер из текста ситуаций, ни их названия не попадают в details"
        status: pass
      - kind: integration
        ref: "test/verdict-block.test.ts#без запомненного вида строка инструмента честно говорит, что блок нельзя показать"
        status: pass
    human_judgment: false
  - id: D2
    description: "V1: the ten locked vectors with the tone column (39/49 reads «хорошо», the three control words, «Проверенных ситуаций нет»); V2: the ten vectors in the order 1, 0, 2a, 2b, 2c, 3, 4, 5 with the chat and board texts, «по 1 ситуации» / «по 2 ситуациям», rule 1 over rule 0, a stale unsure mark is not K"
    requirement: SCREEN-01
    verification:
      - kind: unit
        ref: "test/verdict.test.ts#V1: the ten locked vectors read exactly as the UI-SPEC table, with the tone of each rule"
        status: pass
      - kind: unit
        ref: "test/verdict.test.ts#V2: the ten vectors pick the locked rule, in the order control → running → queue → number"
        status: pass
      - kind: unit
        ref: "test/verdict.test.ts#V2 rule 2b: only sampled passes unmarked names the judge, not the failures"
        status: pass
      - kind: unit
        ref: "test/verdict.test.ts#V2 rule 2c: «не могу сказать» marks are counted in the dative and never treated as done"
        status: pass
    human_judgment: false
  - id: D3
    description: "B1 and B2 in the locked row order: V1, the first block (no «?» rows collapsed, all rows expanded), the cause names / «✗» titles / no-failures sentence (full section expanded), F7 under its heading and the R-01 pointer «вкладка «Провалы»» expanded, «Дальше»; a blank row only between non-empty groups; every row passes the phase-2/3/4 copy scan with no «…» and no «раздел N»"
    requirement: SCREEN-01
    verification:
      - kind: unit
        ref: "test/verdict.test.ts#B1: the collapsed block is V1, the first block without «?» rows, the cause names, then «Дальше», with single blank rows"
        status: pass
      - kind: unit
        ref: "test/verdict.test.ts#B1 row 4 variants: the first three «✗» titles without clusters, the no-failures sentence, nothing when nothing was decided"
        status: pass
      - kind: unit
        ref: "test/verdict.test.ts#B2: the expanded block adds the «?» rows, the full causes, the pointer, then «Дальше»"
        status: pass
      - kind: unit
        ref: "test/verdict.test.ts#B2: the disagreements sit under their heading between the causes and the pointer, only when the owner overturned something"
        status: pass
      - kind: unit
        ref: "test/verdict.test.ts#every verdict, next step and block row is plain Russian without the phase-4 words, «…» or a numbered раздел"
        status: pass
    human_judgment: false
  - id: D4
    description: "renderRows on a 600-character Cyrillic quote with line breaks, a tab and an escape sequence at 40/60/80/100/160 on fake light and dark themes: no line wider than the width, no «…», no word lost, the escape gone, only the eight tones; paint puts bold inside the colour and reads the role map; the render lint over extensions/render/** and src/verdict.ts"
    requirement: SCREEN-07
    verification:
      - kind: unit
        ref: "test/theme.test.ts#renderRows keeps every word of a 600-character quote inside 40–160 columns on both fake themes, with only the eight tones"
        status: pass
      - kind: unit
        ref: "test/theme.test.ts#paint puts the weight inside the colour and takes both from the role when the row names none"
        status: pass
      - kind: unit
        ref: "test/theme.test.ts#lint: extensions/render and src/verdict.ts never slice, pad or measure displayed text, and draw glyphs only from GLYPH"
        status: pass
    human_judgment: false
  - id: D5
    description: "Old sessions and other tools keep today's look: a phase-1 details object, no details, plain text, a wrong version or missing ids all return exactly what legacyResult returns; a view that throws while the rows are built, or a throwing legacy renderer, ends as the escaped content text"
    requirement: SCREEN-02
    verification:
      - kind: unit
        ref: "test/verdict-block.test.ts#legacy: old-session details, no details and non-JSON content are drawn by legacyResult, exactly as it returns them"
        status: pass
      - kind: unit
        ref: "test/verdict-block.test.ts#a view that throws while the rows are built ends as the escaped content text, never as an exception inside Pi"
        status: pass
    human_judgment: false
  - id: D6
    description: "Through Pi's real ToolExecutionComponent in initTheme('dark') and initTheme('light') at 40/60/80/100/160, collapsed and expanded: no line wider than the width, no «…», the «?» rows and the pointer only when expanded, the hint («подробнее» / «свернуть») last, the model text hidden, the same height in both themes; VerdictBlock with injected hints on a marker theme"
    requirement: SCREEN-07
    verification:
      - kind: automated_ui
        ref: "test/verdict-block.test.ts#through Pi's real tool row in the dark and light themes, at 40–160 columns, collapsed and expanded, no line is wider than the width"
        status: pass
      - kind: unit
        ref: "test/verdict-block.test.ts#VerdictBlock takes the hint as a function and paints the rows with the theme it is given, in both forms"
        status: pass
    human_judgment: false
  - id: D7
    description: "The block reads as the 10-second answer in a live Pi in a light and a dark theme at projector width (colours, weight, the hint row) — the UI-SPEC human item; the reopen path is 04-03 / 04-09"
    requirement: SCREEN-01
    verification: []
    human_judgment: true
    rationale: "The look of Pi's real colours and the keyHint row cannot be judged from stripped lines; the UI-SPEC Render Matrix names the light/dark screenshots as the one non-automatable item, deferred to the end-of-phase UAT with the other phase-4 human items"

# Metrics
duration: 37 min
completed: 2026-09-17
status: complete
---

# Phase 4 Plan 01: Экран результата в Pi — блок-вердикт в чате Summary

**After `agent_lab_run`, Pi's own tool row draws the verdict block from the run data — «Агент справляется плохо: 0 из 9 ситуаций (мало данных)» in bold error colour, the phase 1–3 first block, the three cause names, and one «Дальше» row picked by the control, the running state, the review queue and the number — while the session file keeps only `{ kind, version, runId, resultKey }`, the model reads C-119 instead of the block, old sessions render exactly as before, and every row is proven word-wrapped and theme-safe at 40–160 columns in Pi's real dark and light themes.**

## Performance

- **Duration:** 37 min
- **Started:** 2026-09-17T21:41:24Z
- **Completed:** 2026-09-17T22:18:24Z
- **Tasks:** 3 (1 tracer, 2 TDD)
- **Files modified:** 8 (5 source, 3 test)

## Accomplishments

- `src/verdict.ts` (pure): `verdictLine` walks the V1 table in rule order — the control word comes from the same two predicates `buildResultView` uses (`unmeasuredControl`), the percent is `Math.round(accuracy * 100)` so 39/49 reads «хорошо» next to «80%», the noun is `pluralForm(M, ['ситуации', 'ситуаций', 'ситуаций'])`, ` (мало данных)` below the exported `SMALL_SAMPLE`; `verdictLevel` is the tone column; `nextStep` evaluates rules 1, 0, 2a, 2b, 2c, 3, 4, 5 with the chat (`/agent-lab <id8>`) and board («вкладка «Провалы»» / «Диалоги») texts, K in the dative («по 1 ситуации», «по 2 ситуациям»); `verdictBlockRows` builds B1 (V1, `resultViewRows` minus `situation` rows with the headline demoted to `headline`, cause names or «✗» titles or the no-failures sentence, V2) and B2 (V1, all rows with details, the full cause section, F7 under `НЕСОГЛАСИЯ С СУДЬЁЙ`, the R-01 pointer «Все провалы — /agent-lab <id8>, вкладка «Провалы».», V2), blank rows only between non-empty groups. No `.slice`, `.substring`, `padStart`, `padEnd`.
- `extensions/render/theme.ts`: `Tone`, `Row`, `PaintTheme`, one `GLYPH` const with the phase 2–4 registry, `ROLE_TONE` (the phase-2 `VIEW_ROLE`/`SECTION_ROLE`/`DISAGREEMENT_ROLE` maps plus `verdict:good` success bold, `verdict:warn` warning bold, `verdict:bad` error bold, `headline` text, `next` accent, `heading` accent bold, `pointer` muted, `no-failures` success), `paint` (bold inside the colour), `renderRows` = `safeText` on every text → `wrapRows` → `paint`. `safeText`/`wrapRows` are still imported from `../cards.ts` (04-02 moves them).
- `extensions/render/verdict-block.ts`: `VerdictDetails` holds ids only; `isVerdictDetails` checks kind, version and both string ids; `rememberView`/`viewFor` keep the last 20 views in process memory (`forgetViews` for tests and the pre-04-03 reopen); `VerdictBlock` builds its rows in the constructor (so a broken view fails inside the host's try/catch, not in Pi's render loop) and renders `renderRows(...)` plus `wrapTextWithAnsi(hint(expanded), width)`; `renderAgentLabResult` dispatches verdict details → block, verdict details without a view → `Прогон <id8> не найден в .agent-lab — блок нельзя показать.` (warning), everything else → the untouched legacy renderer; any throw → `Text(safeText(content text))`.
- `extensions/agent-lab.ts`: today's `renderResult` body is `legacyResult`, unchanged; `toolDisplay.renderResult` calls `renderAgentLabResult(result, options, theme, legacyResult)`; `agent_lab_run` adds `shownToOwner` (C-119) to the model JSON and returns `details = { kind: VERDICT_KIND, version: 1, runId, resultKey: runId:resultHash }` after `rememberView`, or `{ id }` when the bundle has no view. `inspect`, `validate`, `score` and `reassess` keep their old details until 04-03.
- Tests: 111 → 126 verdict-block/extension/result-view tests around the tracer; `test/verdict.test.ts` pins every V1/V2 vector and the exact B1/B2 rows over `buildResultView` fixtures with Russian titles and scans every output with `assertPlainCopy` plus the phase-4 words; `test/theme.test.ts` runs the render matrix on marker themes and lints `extensions/render/**` and `src/verdict.ts`; `test/verdict-block.test.ts` proves the legacy dispatch, the throwing view and Pi's real `ToolExecutionComponent` in both themes at the five widths, collapsed and expanded.

## Task Commits

1. **Task 1 (tracer): after `agent_lab_run` Pi draws the verdict block from the result data** — `7ff7525` (feat)
2. **Task 2 (TDD): every verdict and «Дальше» case, the full collapsed and expanded block** — `e2a00d1` (test, RED) → `bca693c` (feat, GREEN)
3. **Task 3 (TDD): the block looks the same in both Pi themes at every width and never breaks an old session** — `56289f8` (test, RED) → `d9c51d6` (feat, GREEN)

No REFACTOR commits: neither GREEN implementation needed a cleanup pass.

## TDD Gate Compliance

| Task | RED commit | RED evidence | GREEN commit | REFACTOR |
|------|-----------|--------------|--------------|----------|
| 2 (`tdd="true"`) | `e2a00d1` — 8 failing tests, all targets (V2 vectors, 2b, 2c, B1 rows, B1 variants, B2 rows, B2 F7, B2 empty) on assertions about the planned texts and rows; the V1 test was green on arrival because the tracer already implemented V1 | `RED_EVIDENCE_OK` / `target_test_failed` for all eight (`gsd_run check tdd-red-evidence`, records `/tmp/gsd-red/04-01-t2-*.json`) | `bca693c` — 87/87 on `test/verdict.test.ts test/result-view.test.ts` at the first GREEN run | — |
| 3 (`tdd="true"`) | `56289f8` — 1 failing test: the lint found a literal «→» in a `theme.ts` doc comment; the other 16 Task-3 tests passed on arrival, as the plan expected («fix whatever the tests find»): the width, legacy, throw and real-theme behaviour was built by the tracer | `RED_EVIDENCE_OK` / `target_test_failed` (`/tmp/gsd-red/04-01-t3-lint.json`) | `d9c51d6` — the two «→» comments in `theme.ts` and `verdict-block.ts` reworded (the second was found on the first GREEN run); 52/52 on the four test files, extension typecheck clean | — |

Task 1 is `type="tracer"`: its tests were written first and committed with the implementation in one `feat` commit, as the plan asks; the tracer feedback gate (interactive, `human_verify_mode = end-of-phase`, automated-only `<verify>`, no `blocking-human` gate) re-ran the tracer verify on the committed tree — 111/111 — before expansion. `TDD_MODE` was not active for this phase, so the MVP+TDD runtime gate did not fire. One Task-3 assertion was corrected before RED was committed (pi-tui's `Text` pads its lines to the width; the test now trims before comparing) — a test bug, not RED evidence.

## Verification

- Task 1 `<verify>` (`test/verdict-block.test.ts test/extension.test.ts test/result-view.test.ts`): exit 0, 111/111 — run twice (task verify + tracer gate); the extension typecheck (`extensions/*.ts extensions/render/*.ts`) clean in a kept snapshot.
- Task 2 RED: exit 1, 87 tests, 79 pass, 8 fail — exactly the eight targets. Task 2 `<verify>`: exit 0, 87/87 (`# tests` 87 > the 78 of result-view alone, so the verdict tests are counted).
- Task 3 RED: exit 1, 52 tests, 51 pass, 1 fail — the lint. Task 3 `<verify>` (`test/theme.test.ts test/verdict-block.test.ts test/verdict.test.ts test/extension.test.ts`): exit 0, 52/52; the extension typecheck plus the three new test files compile clean.
- Plan `<verification>`: `snap-test.sh` with no arguments on the whole working tree — **exit 0, 585/585**, `npm run typecheck` clean; `snap-test.sh --full` on the committed HEAD — exit 0, 579/579 (the six extra working-tree tests belong to another session's uncommitted phase-5 files, see Issues).
- Acceptance greps: `export function verdictLine` 1, `export function verdictBlockRows` 1, `export const SMALL_SAMPLE` 1, `renderAgentLabResult(` 1, `function legacyResult` 1, `shownToOwner` 1 in `agent-lab.ts`, `agent-lab/verdict` 1, `export function rememberView` 1; the tracer test contains `QUOTE-MARKER-7f3a`, `не найден в .agent-lab`, `ToolExecutionComponent`, `initTheme`; `test/verdict.test.ts` contains `Агент справляется хорошо: 39 из 49 ситуаций`, `Числу пока не верить: контроль не измерен`, `решите по 2 ситуациям`, `Дальше: дождитесь конца прогона.`; `.slice(|.substring(|padStart(|padEnd(` count 0 in `src/verdict.ts`, `theme.ts` and `verdict-block.ts`; `GOOD_FROM = 80`, `MIXED_FROM = 50`; `test/theme.test.ts` iterates `40, 60, 80, 100, 160` and has a `lint` test; `test/verdict-block.test.ts` calls `initTheme('dark', …)` and `initTheme('light', …)` and has a `legacy` case.
- Judge freeze: `git diff --stat 589602b..HEAD` on `VERSION`, `src/judge.ts`, `src/pi.ts`, `src/contracts.ts`, `src/cli.ts`, `src/store.ts`, `src/artifacts.ts`, `src/experiment.ts`, `src/comparison.ts`, `src/outcomes.ts`, `src/agreement.ts`, `src/explain.ts` is empty; `evaluatorVersion` / `JUDGE_PROTOCOL` untouched. No `.agent-lab` data was read or printed: every fixture is built in code or in `mkdtemp` demo runs.

## Files Created/Modified

- `src/verdict.ts` — V1, V2, B1/B2 row builder; `GOOD_FROM`, `MIXED_FROM`, `NO_FAILURES_TEXT`, `allFailuresTab`, `VerdictRow`, `VerdictLevel`, `Surface`
- `src/result-view.ts` — `SMALL_SAMPLE` and `shortId` exported (values unchanged); `allFailuresPointer` uses `shortId` (its text, «раздел 1, Enter.», is renamed in 04-06)
- `extensions/render/theme.ts` — `Tone`, `Row`, `PaintTheme`, `GLYPH`, `ROLE_TONE`, `paint`, `renderRows`
- `extensions/render/verdict-block.ts` — `VERDICT_KIND`, `VerdictDetails`, `isVerdictDetails`, `rememberView`, `viewFor`, `forgetViews`, `missingRunText`, `VerdictBlock`, `renderAgentLabResult`
- `extensions/agent-lab.ts` — `SHOWN_TO_OWNER`, `legacyResult`, the `renderResult` dispatch, the `agent_lab_run` result shape
- `test/verdict.test.ts`, `test/theme.test.ts`, `test/verdict-block.test.ts` — the tests above

## Decisions Made

- The collapsed block filters `resultViewRows` by role (`situation` out), never by text, so the `alarm`, `agreement` and `agreement-tail` rows that phases 3 and 03.1 added stay in B1 — as the plan's flagged assumption said.
- The expanded block prints the no-failures sentence in the cause slot as well, so pressing ctrl+o never removes a row the collapsed form showed.
- `VerdictBlock` computes its rows in the constructor: a view that throws fails inside `renderAgentLabResult`'s try/catch (proven by the getter test) instead of inside Pi's render loop; no try/catch was added to `render` itself.
- Extra exports beyond the plan's artifact table, all needed by the tests or the next plans: `forgetViews`, `missingRunText` (verdict-block), `NO_FAILURES_TEXT`, `allFailuresTab`, `VerdictRow`, `VerdictLevel`, `Surface` (verdict).
- This Conductor workspace is a git worktree of `conductor-playground` on branch `full-project-review-feature-plan`; the orchestrator dispatched the plan in sequential mode on this working tree (as for every 03.1 plan), so STATE.md / ROADMAP.md were updated by this executor as instructed.

## Deviations from Plan

**1. [Rule 3 - Blocking] The marker fixture could not change `successCriteria`**
- **Found during:** Task 1 (the `QUOTE-MARKER-7f3a` test, inherited from an interrupted earlier attempt)
- **Issue:** `agent_lab_edit` refused the fixture with «Ожидание … изменилось, а исполняемые проверки остались прежними» — the 02-07 guard on a demo card without the judge goal rubric.
- **Fix:** the marker rides on the title, the opening and the facts (what reaches the view and the transcript); `successCriteria` is left alone. The test still proves no title or marker reaches `details`.
- **Files modified:** `test/verdict-block.test.ts`
- **Committed in:** `7ff7525`

**2. [Adaptation] The no-failures sentence lives in an extension, not in `src/`**
- **Found during:** Task 2
- **Issue:** the plan says «grep for it; reuse, do not retype», but «Провалов не зарегистрировано. Это не гарантия качества в реальном трафике.» exists only as a `line(...)` literal in `extensions/cards.ts`, which `src/verdict.ts` cannot import.
- **Fix:** `NO_FAILURES_TEXT` is defined once in `src/verdict.ts`, byte-identical; `cards.ts` keeps its literal until 04-06 moves the Итог tab (out of this plan's files).
- **Committed in:** `bca693c`

**3. [Adaptation] `details` carry no view, so the tracer test reads `viewFor(details)`**
- **Found during:** Task 1
- **Issue:** the plan's test text still says `verdictLine(result.details.view)` (pre-REV-01 wording) while its truths forbid a view in `details`.
- **Fix:** the test asserts the four keys and reads the view through `viewFor(details)`; the C-190 test clears the cache with `forgetViews()`.
- **Committed in:** `7ff7525`

**4. [Process] Uncommitted work from an interrupted earlier attempt of this plan**
- **Found during:** start
- **Issue:** `git status` showed a Task-1 draft (`src/verdict.ts`, `extensions/render/*`, edits to `agent-lab.ts` and `result-view.ts`, the tracer test) written ~10 minutes earlier and a stale plan ledger from before the orchestrator's `589602b` docs commit; the draft failed on deviation 1.
- **Fix:** every file was re-read against the plan and the landed 03.1 code, the fixture fixed, the whole verified (111/111 + typecheck) and committed as Task 1; the ledger was reset to `589602b` (no 04-01 commit existed yet), so `commits: 5` is measured from the true base.

---

**Total deviations:** 1 auto-fixed (blocking, test-only) + 2 adaptations to the landed code + 1 process note.
**Impact on plan:** none on scope; the production code follows the plan and the UI-SPEC copy byte for byte; no phase 2/3/03.1 string changed.

## Issues Encountered

- **Another session writes in this working tree.** During Task 2 untracked phase-5 files appeared (`src/redact.ts`, `src/render/escape.ts` …, `test/redact.test.ts`, `test/share.test.ts`, `test/manager-report.test.ts`, `test/helpers/customer-leaks.ts`). They were never staged (every commit lists its files); the whole-tree snapshot includes them and still passes (585/585), and the committed HEAD passes on its own (579/579). Two `render/` directories now exist — `src/render/` (phase 5, HTML) and `extensions/render/` (phase 4, terminal) — no collision.
- The `<fails_when>` clauses name the extension typecheck, but `snap-test.sh <files>` runs only `tsc` + the tests; the typecheck was run by hand in `--keep` snapshots after each task (clean each time) and by the no-argument run at the end.

## Known Stubs

None — no placeholder values, empty data sources or TODO/FIXME markers in the changed files. `viewFor` returning `null` on a cache miss is the plan's designed pre-04-03 behaviour with its own honest row, not a stub.

## Threat Register Check

- T-04-01 (record text → terminal): mitigated — `renderRows` applies `safeText` to every row text; `test/theme.test.ts` renders a quote with `\x1b[31m…\x1b[0m` and asserts no escape byte in the output; the real-host test asserts the same on the long reply.
- T-04-02 (forged or old details): mitigated — `isVerdictDetails` requires kind, version 1 and string `runId`/`resultKey`; the legacy test covers a phase-1 details object, `undefined`, plain text, version 2 and missing ids.
- T-04-03 (bank text in the 0644 session file): mitigated — `details` = four ids; the marker test proves neither the marker nor any title reaches `JSON.stringify(details)`; `content` gains only `shownToOwner`.
- T-04-04 (model restating the block): partly mitigated — C-119 is in `content`; the system-prompt and skill edits are 04-03 as planned.
- T-04-05 (renderer exception): mitigated — try/catch → `Text(safeText(content))`; tests with a throwing view getter and a throwing legacy renderer.
- T-04-SC: no packages installed.
- No new network endpoint, auth path, file access pattern or schema change; no threat flags.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 04-02 moves `safeText`/`wrapRows` into `theme.ts` and flips the imports in `theme.ts` and `verdict-block.ts` (`../cards.ts` today); `Row` still lacks `bg`, `anchor` and `segments`, which 04-02/04-05 add.
- 04-03: `viewFor` is the one place to add the record rebuild; `renderAgentLabResult` already handles the null; the entry host wraps `VerdictBlock` in `Box(1, 1, …)`; `inspect`/`validate`/`score`/`reassess` still return legacy details.
- 04-06: rename `allFailuresPointer` («раздел 1, Enter.») and phase-3 F8 («раздел 3») — the block already prints R-01 from `allFailuresTab`; move the cards.ts no-failures literal to `NO_FAILURES_TEXT`.
- 04-09 render matrix: the collapsed block on the stored runs must be ≤ 20 rows at 100 columns — not measured here (no `.agent-lab` read in this plan).
- The live `dist/` still runs the 03.1 build (`729e61a`): the new renderer imports `dist/verdict.js`, so Pi shows the block only after the 04-09 swap.
- Human check carried to the end-of-phase UAT: the block in a light and a dark Pi theme at projector width (D7).

---
*Phase: 04-ekran-rezultata-v-pi*
*Completed: 2026-09-17*

## Self-Check: PASSED

- SUMMARY.md, the 6 created and 2 modified files and all 5 task commits (`7ff7525`, `e2a00d1`, `bca693c`, `56289f8`, `d9c51d6`) verified on disk and in `git log`.
- `commits: 5` measured as `git rev-list --count 589602b..HEAD` (plan ledger `gsd-plan-head-before-04-01`); the whole-tree suite 585/585 and the committed-HEAD suite 579/579 re-verified before this SUMMARY.

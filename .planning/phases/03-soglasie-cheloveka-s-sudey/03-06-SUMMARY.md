---
phase: 03-soglasie-cheloveka-s-sudey
plan: 06
subsystem: pi-board
tags: [pi-board, evidence-first, agreement-block, disagreements, width]
status: complete

requires:
  - phase: 02-sudya-obyasnyaet-provaly
    plan: 04
    provides: "`failureExplanation`, F1 detail rows and their variants"
  - phase: 03-soglasie-cheloveka-s-sudey
    plan: 03
    provides: "`disagreementRows`, `DISAGREEMENT_BOARD_TITLE`, `assertPlainCopy`, the agreement slice of pi-surface-check"
  - phase: 03-soglasie-cheloveka-s-sudey
    plan: 04
    provides: "`agreementTarget`, keys y/n/s, `quickMark` / `queueFixture` / `judgedFixture`"
  - phase: 03-soglasie-cheloveka-s-sudey
    plan: 05
    provides: "`reviewHeader`, `resultsFooter`, `BOUNDARIES`, `headerOf` / `footerOf`"
provides:
  - "`situationEvidence(record, scenario, trial, metricId)` — the F1 detail rows of one attempt on the recorded judgment only (failure and pass)"
  - "`agreementBlockLines(record, trial)` — the F10 block (evidence before the verdict) or the muted fallback row"
  - "`trialLines(…, agreementShown)` — no repeated quick mark and no key row while the block is shown"
  - "section-1 disagreement section (collapsed and expanded) and board colors for `agreement` / `agreement-tail`"
  - "`wrapRows` `hang` / `breakAt`: a key hint breaks only at «·» and continues at column 2"
  - "pi-surface-check `surface=board-agreement`"
affects: [03-07, 04]

actuals:
  tokens: 16157
  tasks: 3
  commits: 6
plan_head_before: 5d99342ac0a88a1b32fcbab3559ca8f5c99d0bb2

tech-stack:
  added: []
  patterns:
    - "Evidence is built from a copy of the record with `humanReviews: []`, so no human mark can hide or rewrite what the owner is judging"
    - "One private F1 builder (`detailRows`) serves the phase-2 explanation and the agreement block, so the two can never drift apart"
    - "Board colors for new result rows come from role tables (`VIEW_ROLE`, `DISAGREEMENT_ROLE`), never from row position"
    - "A zero-width SGR recording theme proves the token per row on a real board render, even with the sidebar"

key-files:
  created: []
  modified:
    - src/explain.ts
    - src/result-view.ts
    - extensions/cards.ts
    - test/explain.test.ts
    - test/cards.test.ts
    - test/result-view.test.ts
    - .planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts

key-decisions:
  - "`situationEvidence` for a failure returns `failureExplanation` rows (title removed) on the record without human reviews; for a pass it runs the same F1 builder with kind `pass`, which never names a violated rule"
  - "The key hint rows (C-71, C-72) break only at «·» and continue at column 2 through new `hang` / `breakAt` fields of the board `Line`; other column-0 rows keep plain wrapping"
  - "`trialLines` skips quick marks and the «Вердикта человека нет…» row only when the block is shown (`agreementShown`); the `v` editor keeps listing every review"
  - "On the collapsed overview the disagreement section follows the cause section — or the «Провалов не зарегистрировано» row when every failure was overturned — and a blank row separates it from «Все провалы: Enter.»"

patterns-established:
  - "Pattern: `bodyCells(board, width)` reads the detail pane as the last cell before the right border"
  - "Pattern: `blockOf(record, trialId)` asserts the export exists before calling it (valid RED)"

requirements-completed: [JUDGE-04, JUDGE-05, JUDGE-06]

coverage:
  - id: D1
    description: "On a failed situation section 3 shows ПРОВЕРКА СУДЬИ, the title without ✗, the lead row, the evidence, «Судья: ✗ не справился», then the keys and one blank row, in the UI-SPEC colors"
    requirement: JUDGE-04
    verification:
      - kind: unit
        ref: "test/cards.test.ts#в разделе 3 провал читается с доказательства, потом «Судья: ✗ не справился», потом клавиши"
        status: pass
      - kind: unit
        ref: "test/explain.test.ts#доказательство провала — строки объяснения без заголовка, и несогласие владельца их не меняет"
        status: pass
    human_judgment: false
  - id: D2
    description: "Pass evidence (cited reply, else the last reply; never «Нарушено правило»); phase-2 F1 variants unchanged inside the block"
    requirement: JUDGE-04
    verification:
      - kind: unit
        ref: "test/explain.test.ts#доказательство успеха: цитата, на которую сослался судья, иначе последняя реплика; строки «Нарушено правило» нет"
        status: pass
      - kind: unit
        ref: "test/explain.test.ts#варианты объяснения провала попадают в блок согласия без изменений"
        status: pass
    human_judgment: false
  - id: D3
    description: "Lead rows for a sampled and an unsampled pass; key, mark and reason rows for agree / disagree / unsure; the stale row (tampered judge hash, mark only in sourceEvidence) replaces keys and mark"
    requirement: JUDGE-06
    verification:
      - kind: unit
        ref: "test/cards.test.ts#успех из выборки и вне её, отметки и устаревшие отметки дают свои строки блока"
        status: pass
    human_judgment: false
  - id: D4
    description: "Control and undecided situations show one muted row, keep «Вердикта человека нет…» and ignore y/n/s; quick marks are not repeated under ОТДЕЛЬНАЯ ПРОВЕРКА ЧЕЛОВЕКОМ; evidence is identical before and after a disagreement"
    requirement: JUDGE-04
    verification:
      - kind: unit
        ref: "test/cards.test.ts#контрольная ситуация и ситуация без решения судьи показывают одну приглушённую строку и не отвечают на y, n, s"
        status: pass
      - kind: unit
        ref: "test/cards.test.ts#быстрая отметка не повторяется под ОТДЕЛЬНОЙ ПРОВЕРКОЙ ЧЕЛОВЕКОМ, а доказательство после несогласия то же"
        status: pass
    human_judgment: false
  - id: D5
    description: "Block with a 400+ character Cyrillic reason, line breaks and an ESC sequence at inner 36/56/76/106/156: no row wider, no «…», words kept in order, no ESC byte, hanging indents kept, key rows break only at «·»"
    requirement: JUDGE-04
    verification:
      - kind: unit
        ref: "test/cards.test.ts#блок согласия с длинной причиной и управляющей последовательностью помещается в 36–156 колонок без обрезки"
        status: pass
    human_judgment: false
  - id: D6
    description: "Section 1 shows the agreement row (text) and its tail (muted), and НЕСОГЛАСИЯ С СУДЬЁЙ with its items between the causes and «Все провалы: Enter.»; expanded: after the block and before ВСЕ ПРОВАЛЫ; nothing without disagreements; fits 36–156 with the longest F6 row"
    requirement: JUDGE-05
    verification:
      - kind: unit
        ref: "test/cards.test.ts#обзор показывает строку согласия в своих цветах и несогласия владельца между причинами и «Все провалы: Enter.»"
        status: pass
      - kind: unit
        ref: "test/cards.test.ts#два несогласия разделены пустой строкой, а без несогласий раздела нет ни в одном виде"
        status: pass
      - kind: unit
        ref: "test/cards.test.ts#обзор с самой длинной строкой согласия и двумя длинными несогласиями помещается в 36–156 колонок без обрезки"
        status: pass
      - kind: unit
        ref: "test/result-view.test.ts#строки согласия в первом блоке несут свои роли, а текст блока не меняется"
        status: pass
    human_judgment: false
  - id: D7
    description: "Every phase-3 board string (block variants, F12 labels and suffixes, F11 states at 36/48, footer tiers with and without the report, help rows C-87…C-89) passes the plain-language scan"
    requirement: JUDGE-05
    verification:
      - kind: unit
        ref: "test/cards.test.ts#все строки фазы 3 на доске — простой русский язык"
        status: pass
    human_judgment: false
  - id: D8
    description: "pi-surface-check requires every CLI disagreement item to be a whole board cell and the board heading when K > 0; both stored acquiring runs still print OK"
    requirement: JUDGE-05
    verification:
      - kind: command
        ref: "snap-test.sh --keep + pi-surface-check.mts --id fae4ee59… --id a92fd6ae…"
        status: pass
    human_judgment: false
  - id: D9
    description: "The block and the section-1 disagreements read well in the live Pi board, light and dark theme, on a real acquiring run with a real disagreement"
    requirement: JUDGE-04
    human_judgment: true
    rationale: "Needs the rebuilt `dist/` (03-07), a real disagreement on a temp copy (the `board-agreement` branch has no K > 0 run yet) and a person looking at the board; no test asserts visual quality or theme contrast"

duration: 16min
completed: 2026-09-17
---

# Phase 3 Plan 06: Сначала доказательство, потом вердикт судьи Summary

**В разделе 3 владелец теперь читает «ПРОВЕРКА СУДЬИ → ситуация → что должен был → что сказал → правило» и только потом «Судья: ✗ не справился» и клавиши y/n/s; обзор доски показывает строку согласия в своих цветах и раздел «НЕСОГЛАСИЯ С СУДЬЁЙ», и всё это не режется ни на какой ширине от 36 до 156 колонок.**

## Performance

- **Duration:** ~16 min
- **Started:** 2026-09-17T14:13:02Z
- **Completed:** 2026-09-17T14:29:28Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments

- `situationEvidence` строит доказательство только по записанной оценке судьи: для провала это строки фазы 2 без заголовка, для успеха — реплика, на которую сослался судья (иначе последняя, «судья не указал реплику»), и никогда не «Нарушено правило». Отметка владельца доказательство не меняет.
- `agreementBlockLines` — блок F10 целиком: вводная строка для провала / успеха из выборки / остального успеха, строки отметок (`=`, `!` с причиной, `~`), устаревшая отметка вместо клавиш, одна приглушённая строка для контрольной ситуации и для ситуации без решения судьи.
- `trialLines` при показанном блоке не повторяет быструю отметку и не пишет «Вердикта человека нет…».
- Строка клавиш на узкой доске переносится только у «·» и продолжается со второй колонки.
- Обзор (раздел 1): строка согласия `text`, хвост `muted`; раздел несогласий между причинами и «Все провалы: Enter.», в раскрытом виде — после блока и перед «ВСЕ ПРОВАЛЫ».
- `pi-surface-check` проверяет, что каждая строка несогласия CLI — целая ячейка доски и что заголовок на месте (`surface=board-agreement`).

## Task Commits

1. **Task 1 (tracer): провал читается с доказательства**
   - `b6613a9` test(03-06): провал в разделе 3 читается с доказательства до вердикта судьи
   - `a7b096a` feat(03-06): провал в разделе 3 читается с доказательства до вердикта судьи
2. **Task 2 (TDD): все варианты блока на любой ширине**
   - `0d44fa1` test(03-06): каждый вариант блока согласия читается верно на любой ширине
   - `7400fe1` feat(03-06): каждый вариант блока согласия читается верно на любой ширине
3. **Task 3 (TDD): обзор доски и простой язык**
   - `d7388d0` test(03-06): обзор доски показывает согласие и несогласия владельца простым русским языком
   - `7526b16` feat(03-06): обзор доски показывает согласие и несогласия владельца простым русским языком

`git rev-list --count 5d99342..HEAD` = 6 до этой выжимки; чужих коммитов между моими не было.

## TDD Gate Compliance

- Каждая задача: RED (`test(03-06)`) → GREEN (`feat(03-06)`); REFACTOR не понадобился.
- RED проверен `gsd-tools check tdd-red-evidence` для каждого целевого теста: Task 1 — 2 теста, Task 2 — 6, Task 3 — 4, все `RED_EVIDENCE_OK`. Падения — на утверждениях (нет экспорта, нет строки, другой порядок), не на загрузке.
- Проверка простого языка (Task 3) прошла уже на RED: это страховка для существующих строк, а не новое поведение; в RED-цели она не входила.
- Tracer-гейт Task 1 (`end-of-phase`, только автоматическая проверка): проверка перезапущена и прошла до начала Task 2.

## Files Created/Modified

- `src/explain.ts` — `situationEvidence`; построитель строк F1 вынесен в `detailRows`, `failureExplanation` даёт те же строки.
- `src/result-view.ts` — роли `agreement` / `agreement-tail` у строк F6; текст тот же.
- `extensions/cards.ts` — `agreementBlockLines`, блок в разделе 3, `trialLines(…, agreementShown)`, `hang` / `breakAt` в `wrapRows`, раздел несогласий и цвета строк согласия в обзоре.
- `test/explain.test.ts`, `test/cards.test.ts`, `test/result-view.test.ts` — 11 новых тестов; один старый тест обновлён намеренно (см. отклонения).
- `.planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts` — проверка `board-agreement`.

## Verification

| Check | Result |
|-------|--------|
| Task 1 `snap-test.sh test/explain.test.ts test/cards.test.ts test/extension.test.ts` | exit 0, `# tests 81 / # pass 81 / # fail 0`; typecheck расширения в снимке без ошибок |
| Task 2 `snap-test.sh … test/agreement.test.ts` | exit 0, `# tests 98 / # pass 98 / # fail 0`; typecheck без ошибок |
| Task 3 / plan `<verification>`: `snap-test.sh --keep` (все тесты + typecheck) и `pi-surface-check` на двух прогонах | suite exit 0, `# tests 512 / # pass 512 / # fail 0`; `OK surfaces=3 lines=10 sections=22 disagreements=0 next=1 id=fae4ee59`, `OK surfaces=3 lines=13 sections=21 disagreements=0 next=1 id=a92fd6ae` |
| `grep -c "export function situationEvidence" src/explain.ts` / `humanReviews: \[\]` | 1 / 1 |
| `grep -Ec "from './(experiment\|quality\|result-view)\.js'" src/explain.ts` | 0 |
| `export function agreementBlockLines` / `ПРОВЕРКА СУДЬИ` / C-67 в `extensions/cards.ts` | 1 / 1 / 1 |
| C-68, C-69, C-73, C-75, C-76 в `extensions/cards.ts` | по 1 |
| `test/cards.test.ts` перебирает `[36, 56, 76, 106, 156]` для блока | да |
| `'agreement-tail'` в `src/result-view.ts` | 4 |
| `disagreementRows(` / `DISAGREEMENT_BOARD_TITLE` в `extensions/cards.ts` | 1 / 2 |
| `board-agreement` в `pi-surface-check.mts` | 2 |
| `test/cards.test.ts` вызывает `assertPlainCopy` на `agreementBlockLines`, `reviewHeader`, `resultsFooter` | да |

`dist/` рабочего дерева не пересобирался и не подменялся: живое расширение Pi увидит блок только после 03-07.

## Decisions Made

- Доказательство провала — строки `failureExplanation` на записи без отметок человека; доказательство успеха — тот же построитель F1 с видом `pass`. Один построитель на оба случая, поэтому блок и объяснение фазы 2 не разойдутся.
- Строки клавиш (C-71, C-72) переносятся только у «·» и продолжаются со второй колонки; остальные строки нулевой колонки переносятся как раньше.
- Быструю отметку и строку «Вердикта человека нет…» `trialLines` убирает только при показанном блоке; редактор `v` видит все отметки.
- Если судья провалил всё, а владелец со всем не согласился, раздел несогласий стоит после строки «Провалов не зарегистрировано…».

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] Перенос строки клавиш у «·» со второй колонки**
- **Found during:** Task 2
- **Issue:** UI-SPEC F10 требует, чтобы строка клавиш на ширине меньше 52 переносилась по «·» и продолжалась со второй колонки. План предлагал `indent: 0`, но `wrapRows` при нулевом отступе продолжает строку с нулевой колонки и режет по словам: при ширине 36 получилось бы «… · s» / «— не могу сказать».
- **Fix:** у `Line` появились необязательные `hang` (колонка продолжения) и `breakAt` (разделитель); `packAt` раскладывает части по `visibleWidth`, а если одна часть не влезает, работает обычный перенос. Прежнее поведение `wrapRows` для остальных строк не изменилось (`hang` по умолчанию `indent + 2`).
- **Files modified:** `extensions/cards.ts`
- **Commit:** `7400fe1`

**2. [Rule 1 - Intended test change] Старый тест ждал «Вердикта человека нет» при показанном блоке**
- **Found during:** Task 2 (RED)
- **Issue:** в тесте «result cards keep model grades…» судья провалил главный критерий, поэтому по UI-SPEC F10 блок показан, а строка про `v` убрана.
- **Fix:** тест теперь ждёт строку клавиш блока и отсутствие «Вердикта человека нет».
- **Files modified:** `test/cards.test.ts`
- **Commit:** `0d44fa1`

**3. [Rule 1 - Test bug] Три ошибки в новых тестах**
- **Found during:** Task 2 (GREEN) и Task 3 (RED)
- **Issue:** (а) образец причины кончался пробелом, а причина по спецификации обрезается; (б) строку клавиш C-71 искали в блоке, где уже стоит несогласие (там C-72); (в) проверка простого языка упала на английском тексте демо-карточек (это текст записи, а не наш), а проверка ESC — на сбросах, которые рамка добавляет при обрезке заголовка.
- **Fix:** (а) `.trim()` в ожидании; (б) строка клавиш берётся из копии без отметки; (в) у карточек в проверке русский критерий и нет правил демо, ESC проверяется в теле доски, а текст `[31m` — во всём выводе.
- **Files modified:** `test/cards.test.ts`
- **Commit:** `7400fe1`, `d7388d0`

**Total deviations:** 1 missing-critical (перенос клавиш), 1 намеренная правка теста, 3 ошибки тестов. **Impact:** публичный `trialLines` получил необязательный четвёртый параметр; у `Line` два новых необязательных поля; поведение совпадает с UI-SPEC.

## Issues Encountered

- Ветка `board-agreement` в `pi-surface-check` на сохранённых прогонах не срабатывает (там K = 0); положительная проверка на временной копии с несогласием — задача 03-07, как и указано в плане.

## Authentication Gates

None.

## Known Stubs

None.

## Next Phase Readiness

Готово к 03-07: пересобрать и подменить `dist/` (согласовать с другими сессиями), проверить блок и раздел несогласий на живой доске и прогнать `pi-surface-check` на копии с настоящим несогласием.

## Self-Check: PASSED

- Файлы на месте: `src/explain.ts`, `src/result-view.ts`, `extensions/cards.ts`, `test/explain.test.ts`, `test/cards.test.ts`, `test/result-view.test.ts`, `.planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts`.
- Коммиты найдены: `b6613a9`, `a7b096a`, `0d44fa1`, `7400fe1`, `d7388d0`, `7526b16`.

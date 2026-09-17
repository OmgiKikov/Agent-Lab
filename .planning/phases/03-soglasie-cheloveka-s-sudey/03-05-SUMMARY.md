---
phase: 03-soglasie-cheloveka-s-sudey
plan: 05
subsystem: pi-board
tags: [pi-board, header, footer, help, width-tiers]
status: complete

requires:
  - phase: 03-soglasie-cheloveka-s-sudey
    plan: 01
    provides: "`judgeAgreement` — `queueFailures`, `sampledPasses`, `failures.checked`, `sampleChecked`, `unsure`, `unmarked`"
  - phase: 03-soglasie-cheloveka-s-sudey
    plan: 03
    provides: "`assertPlainCopy` — the phase-3 copywriting scan"
  - phase: 03-soglasie-cheloveka-s-sudey
    plan: 04
    provides: "keys `y` / `n` / `s` in section 3, retired `p`, `quickMark` / `queueFixture` / `judgedFixture` test fixtures"
provides:
  - "`reviewHeader(record, inner, agreement?)` — the F11 section-3 header: state, wide/narrow text, color"
  - "`resultsFooter(phase, inner, hasReport)` — the first footer line of section 3 by Key Map Registry tier, with the `o` prefix rule"
  - "help rows C-87, C-88, C-89 and trial detail rows C-77 / C-78; the retired `p` is named nowhere on the board"
affects: [03-06, 03-07]

actuals:
  tokens: 8064
  tasks: 2
  commits: 4
plan_head_before: 16a149d55333b0c53585cd397128c0421e049f26

tech-stack:
  added: []
  patterns:
    - "Chrome that the frame would truncate is chosen from fixed, measured tiers by a pure exported function, so every tier boundary is unit-tested without rendering"
    - "A count-derived text takes an optional precomputed `JudgeAgreement`, so the worst case (every number 99) is testable even where a real record cannot reach it"
    - "New exports are read in tests through a namespace import, so a missing export fails an assertion (valid RED) instead of the module link"

key-files:
  created:
    - .planning/phases/03-soglasie-cheloveka-s-sudey/deferred-items.md
  modified:
    - extensions/cards.ts
    - test/cards.test.ts

key-decisions:
  - "The F11 header reads `failures.checked` and `sampleChecked` straight from `judgeAgreement` — the same counts the C-95 notice uses — and never `passes.checked`, which would also count a mark on an unsampled pass"
  - "`resultsFooter` owns the `o Открыть отчёт · ` prefix for section 3 of a finished evaluation; the generic prefix line skips that case, so the prefix is printed at most once"
  - "The last footer tier is one constant (`KEYS_ONLY_TIER`) shared by both phases, so the keys-only wording exists in exactly one place"
  - "The old header's human-remark counts («Замечания человека: …») are dropped from section 3; remarks stay visible in the list labels and the overview"

patterns-established:
  - "Pattern: `footerOf` / `headerOf` test accessors assert the export exists before calling it"
  - "Pattern: a board footer row is read as `rows.at(-3)` split by `│`; the second footer line as `rows.at(-2)`"

requirements-completed: [JUDGE-04, JUDGE-06]

coverage:
  - id: D1
    description: "After a real quick mark on the demo evaluation, section 3's header reads «Проверено провалов: 1 из Q …» in `warning`"
    requirement: JUDGE-06
    verification:
      - kind: unit
        ref: "test/cards.test.ts#после настоящей отметки заголовок раздела 3 говорит, сколько провалов и успехов проверено"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every F11 state (both groups, no passes, no failures, unsure left, finished in results_review, finished in complete, empty queue) picks the right wide/narrow text and color at inner 36, 47, 48, 156; unsure marks are not counted as checked; with every count at 99 wide ≤ 48 and narrow ≤ 34; an empty queue ignores y/n/s"
    requirement: JUDGE-06
    verification:
      - kind: unit
        ref: "test/cards.test.ts#заголовок раздела 3 выбирает состояние и ширину по UI-SPEC F11 и не считает сомнения проверенными"
        status: pass
    human_judgment: false
  - id: D3
    description: "The section-3 footer picks the first fitting tier, with and without a report, at every boundary width 36…156; no row is wider than inner or contains `…`; every row passes the copy scan"
    requirement: JUDGE-04
    verification:
      - kind: unit
        ref: "test/cards.test.ts#подвал раздела 3 выбирает первую влезающую ступень и печатает отчёт только там, где он влезает"
        status: pass
    human_judgment: false
  - id: D4
    description: "A rendered board at 40, 60, 80, 110 and 160 columns prints the same tier as `resultsFooter`, the report prefix at most once, no row wider than the board; sections 1 and 2 footers and the second footer line are unchanged"
    requirement: JUDGE-04
    verification:
      - kind: unit
        ref: "test/cards.test.ts#доска печатает в разделе 3 ту же ступень подвала, не повторяет отчёт и не трогает другие разделы"
        status: pass
    human_judgment: false
  - id: D5
    description: "Help shows C-87 then C-88 in place of the old quick-verdict row, C-89 muted right before the final muted row, the `a — правка …` row unchanged; `trialLines` shows C-77 (muted) or C-78; no row names the retired `p`"
    requirement: JUDGE-04
    verification:
      - kind: unit
        ref: "test/cards.test.ts#справка и подробности диалога называют новые клавиши и не называют снятую p"
        status: pass
    human_judgment: false
  - id: D6
    description: "The header and footer read well in the live Pi board, light and dark theme, on a real acquiring run"
    requirement: JUDGE-04
    human_judgment: true
    rationale: "Needs the rebuilt `dist/` (03-07) and a person looking at the live Pi board; no test asserts visual quality or theme contrast"

duration: 10min
completed: 2026-09-17
---

# Phase 3 Plan 05: Заголовок, подвал и справка раздела 3 Summary

**Раздел 3 теперь говорит «Проверено провалов: x из Q · успехов: y из S» и до «Проверка окончена. f — завершить разбор.», а подвал, справка и подробности диалога называют `y`/`n`/`s` на любой ширине от 36 до 156 колонок; снятая `p` больше нигде не видна.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-09-17T13:13:21Z
- **Completed:** 2026-09-17T13:23:30Z
- **Tasks:** 2
- **Files modified:** 2 (+1 planning note)

## Accomplishments

- `reviewHeader` выбирает одно из семи состояний F11 и широкий (≥ 48) или узкий (36–47) текст; «проверено» — только согласие и несогласие, те же счётчики, что в уведомлении C-95.
- `resultsFooter` берёт первую влезающую ступень Key Map Registry; ссылка на отчёт стоит только там, где влезает вместе со ступенью, и уходит при `inner < 47`.
- Справка: C-87 и C-88 вместо строки `p / n — вердикт…`, C-89 про латинские буквы перед последней приглушённой строкой.
- `trialLines`: C-77 / C-78 называют только `v`. Долг из 03-04 закрыт: подвал больше не рекламирует клавишу, которая ничего не делает.

## Task Commits

1. **Task 1: Tracer — заголовок раздела 3 после настоящей отметки**
   - `2185738` test(03-05): заголовок раздела 3 считает проверенные провалы и успехи по F11
   - `fcd3aae` feat(03-05): заголовок раздела 3 говорит, сколько провалов и успехов проверено
2. **Task 2: подвал, справка и подробности диалога** (TDD)
   - `11c09d9` test(03-05): подвал, справка и подробности диалога называют y, n и s на любой ширине
   - `a731473` feat(03-05): подвал, справка и подробности диалога называют y, n и s на любой ширине

`git rev-list --count 16a149d..HEAD` = 4 до этой выжимки; чужих коммитов между моими не было.

## TDD Gate Compliance

- Task 2 (`tdd="true"`): RED `11c09d9` → GREEN `a731473`. RED упал на утверждениях (`cards.ts exports resultsFooter`, `строка C-87`), не на загрузке модуля; `gsd-tools check tdd-red-evidence` → `RED_EVIDENCE_OK` для целевых тестов «подвал раздела 3 …» и «справка и подробности диалога …». REFACTOR не понадобился.
- Task 1 (tracer): тесты тоже написаны первыми (`2185738`) и упали на утверждениях; tracer-гейт (`end-of-phase`, только автоматическая проверка) — проверка перезапущена и прошла, после этого начат Task 2.

## Files Created/Modified

- `extensions/cards.ts` — `reviewHeader`, `resultsFooter`, `RESULTS_FOOTER`, `KEYS_ONLY_TIER`, `REPORT_PREFIX`; заголовок и первая строка подвала раздела 3 в `render`; строки справки и `trialLines`.
- `test/cards.test.ts` — пять новых тестов; старые утверждения заголовка («Разбор: осталось …», «Замечания человека: …») заменены намеренно.
- `.planning/phases/03-soglasie-cheloveka-s-sudey/deferred-items.md` — найденная вне объёма обрезка второй строки подвала.

## Verification

| Check | Result |
|-------|--------|
| Task 1 `snap-test.sh test/cards.test.ts test/extension.test.ts` | exit 0, `# tests 62 / # pass 62 / # fail 0`; `npm run typecheck` в снимке без ошибок |
| Task 2 / plan `<verification>`: `snap-test.sh` (все тесты + typecheck расширения) | exit 0, `# tests 499 / # pass 499 / # fail 0` |
| `grep -c "export function reviewHeader" extensions/cards.ts` | 1 |
| `grep -c "Разбор: осталось"` в `extensions/cards.ts` / `test/cards.test.ts` | 0 / 0 |
| `grep -c "Проверять нечего: судья не вынес решений." extensions/cards.ts` | 1 |
| `test/cards.test.ts` содержит `Не решено: 99. Нажмите y или n.` | да |
| `grep -c "export function resultsFooter" extensions/cards.ts` | 1 |
| `grep -c "y · n · s — согласие с судьёй" extensions/cards.ts` | 1 |
| `p / n — вердикт`, `p Пройдено`, `p — пройдено` в `extensions/cards.ts` | 0 / 0 / 0 |
| `grep -c "Клавиши — латинские буквы: …" extensions/cards.ts` | 1 |
| `grep -c "Вердикта человека нет. v — оценить критерий или весь диалог." extensions/cards.ts` | 1 |
| `test/cards.test.ts` перебирает 36, 46, 47, 64, 66, 67, 84, 85, 94, 95, 96, 97, 109, 110, 115, 128, 156 | да (`BOUNDARIES`) |

`dist/` рабочего дерева не пересобирался и не подменялся: живое расширение Pi увидит эти тексты только после 03-07.

## Decisions Made

- Заголовок F11 читает `failures.checked` и `sampleChecked` прямо из `judgeAgreement` — те же числа, что уведомление C-95 (указание 03-04 №3). `passes.checked` не используется: он посчитал бы отметку на успехе, которого нет в выборке.
- Префикс отчёта для раздела 3 ставит `resultsFooter`; общая строка префикса этот случай пропускает, поэтому префикс печатается не больше одного раза.
- Последняя ступень подвала — одна константа на обе фазы.
- Счёт «Замечания человека» ушёл из заголовка раздела 3 (так в плане); замечания видны в ярлыках списка и в обзоре.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `reviewHeader` принимает необязательный готовый `JudgeAgreement`**
- **Found during:** Task 1
- **Issue:** план требует проверить худший случай «каждое число 99», но выборка успехов ограничена `PASS_SAMPLE = 3`, поэтому настоящая запись не даёт `S = 99`.
- **Fix:** сигнатура `reviewHeader(record, inner, agreement = judgeAgreement(record))`; `render` вызывает её с двумя аргументами, тест подставляет счётчики 99. Значения `K = 99` и `Q = 99` проверены и на настоящей записи.
- **Files modified:** `extensions/cards.ts`, `test/cards.test.ts`
- **Commit:** `fcd3aae`

**2. [Rule 1 - Bug] Два дефекта в RED-тесте Task 2, найденные на GREEN**
- **Found during:** Task 2
- **Issue:** (а) тест ждал вторую строку подвала целиком, но на доске в 40 колонок рамка и до этого плана резала её многоточием, а UI-SPEC требует оставить строку без изменений; (б) проверка справки читала строки через раскрашивающую тему, и теги расширяли строки так, что рамка их резала.
- **Fix:** (а) вторая строка сравнивается с её прежним сокращением рамкой (`truncateToWidth(second, w - 4, '…')`), так что тест закрепляет «без изменений», а не требует новой строки; сама обрезка записана в `deferred-items.md`; (б) текст справки читается через простую тему, цвет C-89 — через раскрашивающую.
- **Files modified:** `test/cards.test.ts`
- **Commit:** `a731473`

**3. [Scope note] Указание 03-04 №2 (`agreementTarget` для блока F10)**
- Блок F10 по плану относится к 03-06 (`agreementBlockLines`), в задачах 03-05 его нет, поэтому в этом плане `agreementTarget` не вызывается повторно и заново не выводится.

**Total deviations:** 2 auto-fixed (1 blocking, 1 test bug) + 1 scope note. **Impact:** публичная сигнатура `reviewHeader` шире на один необязательный параметр; поведение совпадает с планом.

## Authentication Gates

None.

## Issues Encountered

- **Вне объёма (записано в `deferred-items.md`):** вторая строка подвала (`↑↓ Выбор · ←→ Текст · Enter Детали · / Поиск · ? Помощь`, 55 колонок) и строка с прокруткой режутся многоточием при `inner < 55`, то есть на доске 40–58 колонок. Это нарушает правило проекта «ничего не обрезается на 40–160», но UI-SPEC фазы 3 требует оставить строку как есть.
- **На заметку для проверки фазы:** в разделе 3 заголовок F11 показывается для любой записи с диалогами. Пока идут диалоги или для сравнительного эксперимента `judgeAgreement` пуст, и заголовок читается «Проверять нечего: судья не вынес решений.» (приглушённо). План и UI-SPEC так и задают, отдельного состояния для этих случаев нет. Раньше в этом месте стоял «Разбор: осталось …». Туда же — допущение плана: пока не разобрано решение по симулятору, заголовок может говорить «Проверка окончена», а `f` откажет уведомлением 03-04.

## Known Stubs

None.

## Threat Flags

None. Новых входов, путей или схем нет; в заголовок и подвал попадают только числа и неизменные тексты (T-03-17 закрыт тестами ступеней и защитой ширины в рамке).

## User Setup Required

None.

## Next Phase Readiness

- **03-06** строит блок F10 на `agreementTarget` и сканирует `assertPlainCopy` все состояния F11, ярлыки F12, строки справки и ступени подвала. Для этого есть `reviewHeader` и `resultsFooter`, а тексты ступеней лежат в `RESULTS_FOOTER`. По UI-SPEC строка C-77 скрывается, пока показан блок F10; сейчас `trialLines` показывает её всегда.
- **03-07** пересобирает и подменяет `dist/`: до этого живой Pi показывает старый заголовок и старый подвал.
- Открыто на проверку фазы: D6 — посмотреть заголовок и подвал на живой доске, в светлой и тёмной теме.

---
*Phase: 03-soglasie-cheloveka-s-sudey*
*Completed: 2026-09-17*

## Self-Check: PASSED

- `extensions/cards.ts`, `test/cards.test.ts`, `deferred-items.md` и эта выжимка существуют на диске.
- Коммиты `2185738`, `fcd3aae`, `11c09d9`, `a731473` есть в `git log`; `git rev-list --count 16a149d..HEAD` = 4, совпадает с `commits: 4`.
- `<verification>` плана перепроверен на финальном дереве: `snap-test.sh` → exit 0, 499/499.

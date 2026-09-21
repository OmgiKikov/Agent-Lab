---
phase: 03-soglasie-cheloveka-s-sudey
plan: 07
subsystem: live-verification
tags: [live-verification, free, temp-copy, dist-swap, evidence]
status: complete

requires:
  - phase: 03-soglasie-cheloveka-s-sudey
    plan: 06
    provides: "agreement block in section 3, section-1 disagreements, pi-surface-check `board-agreement`"
  - phase: 02-sudya-obyasnyaet-provaly
    plan: 09
    provides: "verify-stored-runs `--expect`/`--audit` values, board-width-check, rename-swap procedure"
provides:
  - "agreement-check.mts: the real `/agent-lab` command with scripted keys on a 0700 temporary copy of stored runs; prints ids, counts and booleans"
  - "dist/ built from 5ccc792 (phase 3 complete) and swapped by rename; previous dist kept"
affects: [04, 05]

actuals:
  tokens: 7200
  tasks: 2
  commits: 1
plan_head_before: a8ecb64d3c3b62941ac0f79c99bbdcee016d2c93
dist_built_from: 5ccc792953651eae6dfe26f1753174c6e9380613
dist_kept_at: .gsd/dist-before-03-20260917-173742

tech-stack:
  added: []
  patterns:
    - "Scripted e2e on a copy: fake Pi registration + `ui.custom` running one key step per board opening + `ui.editor` returning a synthetic reason"
    - "Originals hashed per file before and after, including in `finally`; the copy is removed in `finally`"

key-files:
  created:
    - .planning/phases/03-soglasie-cheloveka-s-sudey/agreement-check.mts
  modified: []

key-decisions:
  - "`sample=` in the check line is `sampleChecked` (checked sampled passes); on both runs it equals the sample size"
  - "The `snapshot` rule compares marks with a judge snapshot to marks whose trial carries a receipt or an audit, so a record without receipts would not fail it falsely"
  - "The check also fails when the editor is not opened exactly once, when the board reports an error, or when the sampled-pass lead row is never found (then it presses `q` instead of `y`)"

requirements-completed: [JUDGE-04, JUDGE-05, JUDGE-06]

coverage:
  - id: D1
    description: "Scripted y / n / s (and y on a sampled pass) through the real `/agent-lab` command mark a copy of both acquiring runs; reopened board shows «Ваша отметка: = согласен» with evidence before «Судья:»; CLI agreement row and «Несогласия с судьёй (1):»; pi-surface-check OK with disagreements=1; originals unchanged"
    requirement: JUDGE-04
    verification:
      - kind: command
        ref: "03-07 Task 1 <verify> (snap-test.sh --keep test/agreement.test.ts + agreement-check.mts on fae4ee59, a92fd6ae)"
        status: pass
      - kind: command
        ref: "agreement-check.mts with the swapped worktree dist → ~/agent-lab-evidence/phase-03/agreement-check-03.txt"
        status: pass
    human_judgment: false
  - id: D2
    description: "dist/ rebuilt from HEAD after 512/512 tests and swapped by rename with no Pi and no lock; stored runs keep phase-2 counts and audits; surfaces OK; width check clean; no quick mark in any real record"
    requirement: JUDGE-05
    verification:
      - kind: command
        ref: "03-07 Task 2 <verify>"
        status: pass
    human_judgment: false
  - id: D3
    description: "Real owner marks on the frozen demo record, light/dark theme look of section 3, and whether the remapped `n` reads naturally"
    requirement: JUDGE-06
    human_judgment: true
    rationale: "Only the owner can agree or disagree, look at a real terminal theme and judge how a key feels (03-VALIDATION Manual-Only Verifications)"

duration: 8min
completed: 2026-09-17
---

# Phase 3 Plan 07: Согласие с судьёй на настоящих прогонах эквайринга Summary

**Настоящая команда `/agent-lab` со скриптом клавиш поставила отметки y / n / s (и y на проверяемом успехе) на временной копии двух прогонов эквайринга: доска, CLI и Pi показывают одно и то же согласие и одно несогласие, а файлы в `.agent-lab` не изменились ни на байт. `dist/` пересобран из `5ccc792` после 512/512 тестов и подменён переименованием; старые прогоны читаются как в фазе 2 плюс строка согласия. Платных вызовов не было.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-09-17T14:31Z
- **Completed:** 2026-09-17T14:39Z
- **Tasks:** 2
- **Files:** 1 script created, 1 summary

## Evidence

Все сырые выводы — в `~/agent-lab-evidence/phase-03/` (папка 0700, файлы 0600). Здесь только id, числа, булевы значения и хэши.

| id8 | Роль | Отметки (agree / disagree / unsure) | snapshot | Хэши | Согласие | Провалы | Успехи | Выборка | Повторное открытие / доказательство до вердикта | CLI строка / заголовок | Поверхности на копии | Оригиналы |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fae4ee59 | эквайринг, прогон без успехов | 3 (1 / 1 / 1) | 3/3 | measurement same, result changed | 1/2 | 1/2 | 0/0 | 0 | true / true | 1 / 1 | ok (`disagreements=1`) | true |
| a92fd6ae | эквайринг, прогон с одним успехом | 4 (2 / 1 / 1) | 4/4 | measurement same, result changed | 2/3 | 1/2 | 1/1 | 1 | true / true | 1 / 1 | ok (`disagreements=1`) | true |

Обе строки `check` совпали с ожидаемыми буквально — и в снимке (Task 1 verify), и с подменённым `dist/` рабочего дерева (`agreement-check-03.txt`). Положительный случай ветки `board-agreement` в `pi-surface-check` (K = 1) впервые сработал здесь.

Настоящие записи, с подменённым `dist/`:

| Проверка | Результат |
|---|---|
| `verify-stored-runs.mjs --expect fae4ee59…:0:9:4 --expect a92fd6ae…:1:8:7 --audit …:13/13 --audit …:14/14` | exit 0, нет `MISMATCH`: `fae4ee59 passed=0 decided=9 notMeasured=4 audit=13/13`, `a92fd6ae passed=1 decided=8 notMeasured=7 audit=14/14` |
| `pi-surface-check.mts` на двух прогонах | `OK surfaces=3 lines=10 sections=22 disagreements=0 next=1 id=fae4ee59`, `OK surfaces=3 lines=13 sections=21 disagreements=0 next=1 id=a92fd6ae`; нет `DIFF` |
| `board-width-check.mts` | 30 строк, 0 `FINDING`, все `over=0`, `ellipsis=0` и `words=equal` на 10 из 10 строк переноса |
| Быстрые отметки в настоящих записях (`grep -lE '"source": *"quick"' .agent-lab/*.json \| wc -l`) | 0 |
| sha256 четырёх файлов (две записи, два trace) до Task 1, после Task 1 и после Task 2 | совпадают (`originals-sha-before.txt` = `originals-sha-after.txt`) |
| Временные папки `agent-lab-agreement-*` / снимки после работы | 0 |

`RE11` не существует (02-03 — NO-GO), поэтому проверки шли на двух прогонах.

У `.agent-lab` нет sidecar-папок `.judge/` для этих двух прогонов, а `parentRunId`/`assessmentOf`, если заданы, копировались вместе с прогоном (скрипт копирует их только когда файл есть).

## Swap record

- Preflight (`preflight.txt`): `pgrep -fl 'dist/bundle/cli.js|pi-coding-agent|extensions/agent-lab.ts'` — пусто; `.agent-lab/.lock` — нет.
- `snap-test.sh --full --keep` на HEAD `5ccc792`: **512 pass, 0 fail**, typecheck чистый, exit 0 (`snap-full-03.log`).
- Непосредственно перед переименованием pgrep и lock проверены ещё раз — пусто / нет.
- Подмена переименованием: `dist` → `.gsd/dist-before-03-20260917-173742` (сохранён; путь в `rollback-dist-03.txt`), `.gsd/dist-stage-…` → `dist`; снимок удалён; `dist/agreement.js` есть.
- `dist-built-from-03.txt` = `5ccc792953651eae6dfe26f1753174c6e9380613` = HEAD на момент подмены. Чужих коммитов между сборкой и подменой не было.

## Deliberate changes visible after the swap

- В первом блоке CLI/Pi/доски появилась строка «Согласие с судьёй: …», поэтому `lines=` в `pi-surface-check` на единицу больше, чем в фазе 2 (9→10, 12→13).
- В свёрнутом результате Pi указатель «Все провалы — /agent-lab …» теперь стоит последним, после несогласий (payload `failureLines` не менялся).
- На доске в разделе 3 клавиша `p` убрана; `n` теперь значит «не согласен» (раньше «не пройдено»); `y` / `s` — «согласен» / «не могу сказать». Подробный вердикт — по-прежнему `v`.
- Раздел 3 показывает блок «ПРОВЕРКА СУДЬИ»: сначала доказательство, потом «Судья: …» и клавиши.

## Record rollback hazard

Записи с новыми полями отметки (`source: 'quick'`, `judgeVerdict`, `judge`) не открываются в старом `dist/` (строгая схема). В этой фазе ни одна настоящая запись таких полей не получила (проверено: 0). **Как только владелец поставит настоящие отметки с новым `dist/`, откат `dist/` к `.gsd/dist-before-03-…` сделает эти записи нечитаемыми — откатывать нельзя, только исправлять вперёд.** До первой настоящей отметки rollback безопасен: `mv dist .gsd/dist-03-bad && mv .gsd/dist-before-03-20260917-173742 dist` (при закрытом Pi).

## Pi restart note

Следующий запуск Pi в этом worktree загрузит расширение и `dist/` фазы 3. Уже запущенный Pi (сейчас его нет) продолжал бы работать со старым кодом до перезапуска. Путь владельца: `/agent-lab <id>` → `3` → на провале `y` согласен · `n` не согласен (откроется редактор причины) · `s` не могу сказать.

## Human items (не проверяются автоматически)

1. **(a) Настоящие отметки (CTX-19).** После заморозки протокола владелец открывает замороженную демо-запись в Pi, раздел 3, и ставит отметки `y` / `n` / `s` сам.
2. **(b) Светлая и тёмная тема.** Владелец открывает раздел 3 на демо-записи в одной светлой и одной тёмной теме Pi и присылает скриншот или короткую заметку. Без них проверяющий ставит `human_needed`.
3. **(c) Новая клавиша `n`.** Владелец подтверждает, что `n` = «не согласен» читается естественно (прочитать помощь и строку клавиш, нажать `n` и закрыть редактор).

## Notes for later phases

- **Note for phase 4:** формулировки блока согласия, порядок строк и клавиши зафиксированы (`[P3]`); фаза 4 может перенести блок во вкладку «Провалы», не меняя его. Там же — известная обрезка второй строки подвала на узкой доске (`deferred-items.md`); `board-width-check` её не проверяет, и здесь она на результат не влияла.
- **Note for phase 5:** источники для сводки и HTML-отчёта — `view.agreement`, `disagreementRows` и `agreementSectionLines`.

## Task Commits

1. **Task 1 (tracer):** `5ccc792` test(03-07): отметки y, n, s на копии прогонов эквайринга доходят до доски, CLI и Pi
2. **Task 2:** результат — подменённый `dist/` (игнорируется git), доказательства вне репозитория и этот SUMMARY (коммит документации ниже).

`git rev-list --count a8ecb64..HEAD` = 1 на момент записи SUMMARY; чужих коммитов между моими нет.

Tracer-гейт Task 1 (`end-of-phase`, только автоматическая проверка): проверка прошла дважды (отладочный прогон и точная команда verify) до начала Task 2.

## Deviations from Plan

None - plan executed exactly as written. Уточнения внутри скрипта (не меняют ожидаемый результат): `sample=` — это `sampleChecked`; правило `snapshot` сравнивает с числом отмеченных ситуаций, у которых есть квитанция или аудит судьи; скрипт дополнительно падает, если редактор открылся не один раз или доска сообщила об ошибке; флаг `--debug` выводит сообщения ошибок в stderr.

## Issues Encountered

None.

## Threat Flags

None — скрипт работает только с временной копией и локальными чтениями; новых сетевых путей нет.

## Known Stubs

None.

## Next Phase Readiness

Фаза 3 завершена: все 7 планов выполнены, код фазы 3 в `dist/` рабочего дерева. Остаются три пункта владельца (выше).

## Self-Check: PASSED

- FOUND: `.planning/phases/03-soglasie-cheloveka-s-sudey/agreement-check.mts`
- FOUND: commit `5ccc792`
- FOUND: `dist/agreement.js`, `.gsd/dist-before-03-20260917-173742`
- Task 1 и Task 2 `<verify>` — exit 0

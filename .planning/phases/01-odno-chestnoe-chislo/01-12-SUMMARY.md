---
phase: 01-odno-chestnoe-chislo
plan: 12
subsystem: live-verification
tags: [live-verification, aigw-local, positive-control, budget, gap-closure]
status: complete

requires:
  - phase: 01-10
    provides: live-check.mjs (budget, record, watch) and the phase-01 ledger
  - phase: 01-11
    provides: one-turn positive control and control-free repeat diff
provides:
  - "live-check.mjs control / pick-counted / watch --id latest-child-of:"
  - "dist/ rebuilt from HEAD 03aafef (01-11 included), live for the next Pi start"
  - "TRUST-04 closed on live evidence: real control passed as one turn in c1b9f043"
affects: [phase-01-verification, 02-03, 07]

tech-stack:
  added: []
  patterns:
    - "Closure written only from the control JSON exit code plus the CLI block lines"

key-files:
  created: []
  modified:
    - .planning/phases/01-odno-chestnoe-chislo/live-check.mjs
    - .planning/REQUIREMENTS.md
    - .planning/STATE.md

decisions:
  - "[01-11]: a positive control runs as one turn (opening + first reply, no simulator) and is left out of the repeat diff and the instability check"

metrics:
  duration: 6min
  completed: 2026-09-17

estimate:
  tokens: 85000
  tasks: 3
actuals:
  tokens: 1450
  tasks: 3
  commits: 2
plan_head_before: 3552ef86e06d3ec1578f890416e7494f307ccf87
---

# Phase 1 Plan 12: живой положительный контроль. Итог

**TRUST-04 закрыт на живых данных. Настоящий контроль `ae812a24` (версия карточки из a92fd6ae) прошёл как одна реплика в прогоне `c1b9f043`: 0 событий симулятора, 1 ответ агента, судья засчитал цель. В блоке рядом с одной проверенной ситуацией стоит `Контроль: пройден ✓`, предупреждения нет. Потрачено $0.2413 из $1 по плану, $4.3066 из $10 по фазе.**

Строка trust-04.txt:

```
closed real c1b9f043
```

## Что сделано

- **Задача 1 (tracer).**
  - В `live-check.mjs` добавлены три вещи:
    - `control`: записи контроля и строки блока через `resolveSource` + `buildResultView` + `resultViewLines`;
    - `pick-counted`: выбирает засчитанную карточку с наименьшим числом событий;
    - `watch --id latest-child-of:<parent>`.
  - Коммит `03aafef`.
  - `dist/` собран из снимка `git archive` коммита `03aafef` (403/403 тестов и typecheck) и подменён переименованием. Перед подменой повторно проверено: Pi не запущен, CLI и `agent_lab_target` не запущены, `.agent-lab/.lock` нет.
  - Прежний `dist/` сохранён в `.gsd/dist-pre0112-20260917-032048`.
  - Затем прошли бесплатные проверки и одна живая попытка.
- **Задача 2.** Пропущена (`skipped closed`): настоящий контроль прошёл, синтетический не понадобился.
- **Задача 3.** В REQUIREMENTS.md TRUST-04 отмечен `[x]`, статус `Complete`. В STATE.md блокер заменён строкой о закрытии и заметкой о демо-записи; добавлена строка решения 01-11. Коммит `f0e460c`.

## Предпроверка

- `pgrep` для Pi пуст; `pgrep` для CLI и `agent_lab_target` пуст.
- Файла `.agent-lab/.lock` нет.
- Мок-сервер на :8090 отвечает HTTP 404, то есть не `000`: сервер слушает порт.
- Время: 2026-09-17 03:19. HEAD на момент предпроверки: `3552ef8`.

## Бесплатные проверки на новом `dist/`

`free-checks.txt`: `stored ok`, `drafthash ok`, `diff ok`, `surfaces ok`.

- **Хранимые прогоны** (`verify-stored-runs`, код выхода 0):
  - fae4ee59: 0/9/4, аудит 13/13;
  - a92fd6ae: 1/8/7, аудит 14/14;
  - 61521e0d: 0/10/2.
- **draftHash fae4ee59** совпадает со значением из 01-10 (префикс `0adb5866c445`).
- **Новый diff `fae4ee59 → 61521e0d`:**
  - `comparable = true`, исправлено 0, ухудшилось 0, без изменений 8 (все 8 провалены), несравнимых 4, без решающей оценки 4, `cards.shared = 12`.
  - В 01-10 было 8 без изменений и 5 несравнимых. Контроль больше не входит в пары, поэтому несравнимых стало 4, а общих карточек 12.
  - Первые 40 символов заметок: `4 карточек без решающей оценки; они не с`, `Сравнение включает предварительные оценк`, `Сравнение по 8 карточкам: разница может `, `Контрольные ситуации не сравниваются: он`.
- **pi-surface-check:** `OK surfaces=3` для fae4ee59, a92fd6ae и 61521e0d.
- **Контроль на 61521e0d** (для справки): `unknown` / `simulator_unclear`, `maxFollowUps` 5, 1 событие симулятора. Это старая многоходовая запись до 01-11.

## Попытка 1: настоящий контроль как одна реплика

- **Засчитанная карточка:** `pick-counted` выбрал `3fc7ace7` (12 событий, 7 кандидатов), как и ожидалось при планировании.
- **Бюджет перед запуском:** оба расчёта дали GO, верхняя оценка $0.5578 (`judgeRate` $0.0181).
  - по плану: `spent=$0.0000`, `cap=$1`;
  - по фазе: `spent=$4.0653`, `cap=$10`.
  - Файл `budget-1.txt` записан в 03:21:26, `attempt1.repeat.json` — в 03:21:36.
- **Черновик** `repeat --id a92fd6ae --case ae812a24 --case 3fc7ace7 --control ae812a24`:
  - `positiveControlScenarioIds = [ae812a24…]`, `parentRunId = a92fd6ae`;
  - 2 карточки; у контроля `maxFollowUps` 0, `script` нет.
- **Запуск:** `run --parallel 2` вернул код 1. Это код вердикта, а не сбой. `watch` не останавливал прогон.

### Таблица доказательств

| id | роль | фаза | вызовы | $ | запись, байт | трасса, байт | квитанции / sidecar / с оценкой | ключи аудита | targetFp10 |
|----|------|------|--------|---|--------------|--------------|--------------------------------|--------------|------------|
| c1b9f043 | A1: повтор a92fd6ae, контроль + 1 засчитанная | results_review | 17 | 0.2413 | 133 725 | 409 829 | 2 / 2 / 2 | 0 | `4b69f131a2` (как у a92fd6ae) |

Каталог `.judge` имеет права 0700, sidecar-файлы — 0600. В журнале 2 строки аудита.

### Запись контроля (`live-check control`, код выхода 0)

`ae812a24`: outcome `pass`, reason нет, `maxFollowUps` 0, `simulatorEvents` 0, `assistantReplies` 1, `synthetic` false, provenance `production`, `userFidelityApplies` false. `headline.decided + notMeasured = 1`, `warning = false`.

### Блок `agent-lab summary`

```
Справился в 0 из 1 проверенной ситуации — 0%.
Мало данных: реальная доля где-то от 0% до 79%.
Нестабильных: 0 (повтор прогона a92fd6ae).
Контроль: пройден ✓
```

Далее идёт строка охвата 32/15/17 (15 и 2). Строк, начинающихся с «Контроль не», нет.

### diff `a92fd6ae → c1b9f043`

- `comparable = true`, `cards.shared = 1`, 13 карточек только в исходном прогоне: это ожидаемо, повтор взял две карточки.
- Исправлено 0, ухудшилось 0, без изменений 1 (провалена), несравнимых 0.
- Заметок «Содержимое карточек изменилось» и «Набор карточек изменился» нет. Заметка о контроле есть.
- Первые 40 символов заметок: `Сравнение включает предварительные оценк`, `Сравнение по 1 карточкам: разница может `, `Сравнение относится только к явно выбран`, `Контрольные ситуации не сравниваются: он`.
- pi-surface-check: `OK surfaces=3 lines=5 id=c1b9f043`.

**Форма, на которой закрыт TRUST-04:** попытка 1 (настоящий контроль рядом с одной засчитанной ситуацией). Синтетический контроль не запускался, хеш требования для него не выбирался.

## Факты планирования (для справки)

- У a92fd6ae и fae4ee59 одинаковые цель (`7b436d2a`), версия оценщика (`cb25f026`), отпечаток агента (`4b69f131a2`) и первая реплика контроля.
- Критерии карточки `ae812a24` у них разные: `28f71b6b` в a92fd6ae против `4dd4a09c` в fae4ee59.
- При одинаковом первом ответе агента (sha256 `86107f01`) критерии a92 дали голоса pass/pass, а критерии fae — pass/fail. По четырём попыткам на основе fae засчитан 1 голос из 8.

## Расход

- По плану (`gap-0112/ledger.txt`): $0.2413 из $1, осталось $0.7587.
- По фазе 01 (`ledger.txt`): $4.3066 из $10, осталось $5.6934.
- `dist/` собран из коммита `03aafef4d7022631df26578538649d554865657`. Откат — `.gsd/dist-pre0112-20260917-032048`; он не понадобился.

## Решение по TRUST-04

TRUST-04 закрыт (`[x]`, `Complete`). Строка в STATE.md:

> Phase 1 SC5 (TRUST-04) closed on live evidence: real control passed as one turn in c1b9f043 (repeat of a92fd6ae); demo note: the fae4ee59-based set has the fae card version of ae812a24 (goal votes 1 pass in 8), so a demo record with a passing control should be a repeat of a92fd6ae with --control ae812a24 (15 cards, about $2.1), decided in phase 7 prep

Передавать в 02-03 нечего. Переоценка NEW11 в 02-03 по-прежнему покажет контроль 61521e0d как многоходовый: эта запись сделана до 01-11. На закрытие TRUST-04 это не влияет.

## Отклонения от плана

Нет. План выполнен как написан.

- `control` берёт `before` через `resolveSource`, как требует план. CLI `summary` использует `resolveVerified`; строки блока совпали: `pi-surface-check` сверил три поверхности для c1b9f043.
- `pick-counted` дополнительно исключает карточки из `positiveControlScenarioIds` исходного прогона. У a92fd6ae контроля нет, поэтому на выбор это не повлияло.
- Хук сообщал о заполнении контекста на 77%. По счётчику токенов этого не было, работа продолжена.

## Проблемы аутентификации

Не было.

## Known Stubs

Нет.

## Self-Check: PASSED

- FOUND: .planning/phases/01-odno-chestnoe-chislo/live-check.mjs (`latest-child-of:`, `resolveSource`)
- FOUND commits: 03aafef, f0e460c
- FOUND: ~/agent-lab-evidence/phase-01/gap-0112/trust-04.txt = `closed real c1b9f043`; каталог `drwx------`

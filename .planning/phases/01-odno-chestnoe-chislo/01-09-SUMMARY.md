---
phase: 01-odno-chestnoe-chislo
plan: 09
subsystem: result-view
tags: [positive-control, repeat, result-view]
status: complete

requires:
  - phase: 01-01
    provides: ResultView with the empty control slot and the «Контроль: не задан.» line
  - phase: 01-05
    provides: stability (repeat / reassess flips) inside ResultView
  - phase: 01-08
    provides: summary(record, directory, view?) payload in the Pi extension
provides:
  - Experiment.positiveControlScenarioIds (record-level, optional, 1–5 unique ids of the same set)
  - ExperimentLab.repeat(id, scenarioIds?, controlScenarioIds?)
  - "agent-lab repeat --id RUN --control SCENARIO_ID"
  - agent_lab_repeat.controlScenarioIds and positiveControlScenarioIds in the Pi summary payload
  - control line and top warning in resultViewLines
affects: [result-view, repeat, reassess, suites, pi-extension, cli, 01-10]

actuals:
  tokens: 8400
  tasks: 2
  commits: 2
plan_head_before: 0a20ebdd8fc881cc7b49b42aae5294054f8763b0

tech-stack:
  added: []
  patterns:
    - "Marker on the record, not on the card: card identity, measurementHash and compareRuns stay untouched"
    - "Optional hash input set to undefined keeps every old draftHash (fingerprint drops undefined keys)"

key-files:
  created: []
  modified:
    - src/contracts.ts
    - src/experiment.ts
    - src/result-view.ts
    - src/cli.ts
    - extensions/agent-lab.ts
    - test/result-view.test.ts
    - test/experiment.test.ts
    - test/extension.test.ts

key-decisions:
  - "Контрольная ситуация хранится в записи прогона (positiveControlScenarioIds), а не в карточке: старые записи и их draftHash не меняются, сравнение повтора не видит изменений карточек"
  - "Явно указанный --control, которого нет среди оставленных --case карточек, отклоняется ошибкой, а не теряется молча; унаследованный контроль, выпавший из --case, просто убирается"
  - "Контрольная ситуация, флипнувшая в повторе, помечается « · нестабильно» на строке контроля и не входит в «Нестабильных: N»"

metrics:
  duration: 12min
  completed: 2026-09-17
---

# Phase 1 Plan 09: контрольная ситуация — итоги

Теперь прогон может назвать до пяти контрольных ситуаций. Это настоящие диалоги, с которыми агент заведомо справляется. Они не входят в «N из M», в «Не измерено» и в «Нестабильных» и показываются отдельной строкой «Контроль: пройден ✓». Если контроль не пройден или не измерен, первой строкой блока идёт «Контроль не пройден — числу пока не верить: проверьте судью и связь с агентом.». Так результат «0 из N» больше не спутать со сломанным судьёй.

## Что сделано

- **Задача 1 (tracer), `0786b8f`.**
  - Поле `positiveControlScenarioIds` в `Experiment` и `experimentSchema`: 1–5 идентификаторов без повторов. `superRefine` проверяет, что каждый id есть среди ситуаций набора.
  - Поле входит в `draftHash` и не входит в `measurementHash`.
  - `freshDraft` оставляет только те контрольные id, которые остались в наборе, а если не осталось ни одного — удаляет поле.
  - `repeat(id, scenarioIds?, controlScenarioIds?)` проверяет id до сохранения.
  - `result-view.ts` откладывает контрольные карточки в `control.cards` и строит строку контроля и предупреждение.
  - В CLI добавлен `repeat --control`; в JSON-ответ `repeat` добавлено `positiveControlScenarioIds`.
  - Добавлено 7 тестов вида.
  - Проверка tracer: `snap-test.sh` на 4 тестовых файлах — `# pass 149`, `# fail 0`.
- **Задача 2, `b62aee8`.**
  - `agent_lab_repeat` принимает `controlScenarioIds`; `summary()` отдаёт `positiveControlScenarioIds`.
  - Тест в `experiment.test.ts` проверяет:
    - старая запись без поля читается и сохраняет свой `draftHash`;
    - неизвестный или повторённый id схема отклоняет;
    - `measurementHash` поле не видит;
    - повтор с контролем сравним с исходным прогоном без заметки «Содержимое карточек изменилось»;
    - контроль наследуют repeat, reassess, save-suite и load-suite;
    - ошибки в id ничего не сохраняют.
  - Тест в `extension.test.ts` проверяет новый параметр Pi.
  - Полный прогон `snap-test.sh` на снимке рабочего дерева: `# pass 392`, `# fail 0`, typecheck расширения прошёл.

## Строки контроля

| Состояние | Строка |
|---|---|
| не задан | `Контроль: не задан.` |
| один, пройден | `Контроль: пройден ✓` |
| несколько, все пройдены | `Контроль: пройдено n из n ✓` |
| один, провален | `Контроль: не пройден ✗` + предупреждение сверху |
| один, ещё идёт | `Контроль: ещё не проверен.` (без предупреждения) |
| один, не измерен | `Контроль: не измерен — <причина>.` + предупреждение сверху |
| несколько, смешанно | `Контроль: пройдено k из n.` (+ предупреждение, если есть провал или не измеренная ситуация) |
| суффиксы | ` · синтетическая ситуация`, ` · нестабильно` |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Явно указанный контроль, выпавший из `--case`, не теряется молча**
- **Found during:** Задача 2
- **Issue:** В списке поведения есть пункт «`repeat(id, ['a'], ['b'])` — в черновике нет `positiveControlScenarioIds`». Но проверка из задачи 1 требует ошибку для id, которого нет в наборе черновика. Если молча убрать контроль, который владелец назвал явно, итог покажет «Контроль: не задан.», хотя владелец контроль просил.
- **Fix:** Явный `--control` вне оставленных карточек отклоняется ошибкой «Контрольная ситуация должна быть из этого набора: b.». Молча удаляется только унаследованный контроль, который выпал из `--case`: `repeat(ran.id, [b])` — в черновике поля нет. Оба случая закреплены тестами.
- **Files modified:** src/experiment.ts, test/experiment.test.ts
- **Commit:** 0786b8f, b62aee8

**2. [Rule 2 - Correctness] Флип контрольной ситуации не входит в «Нестабильных»**
- **Found during:** Задача 1
- **Issue:** По плану контроль не входит в счётчик «Нестабильных», но `stability.unstable` считался по всем карточкам.
- **Fix:** Из `view.stability.unstable` убраны контрольные ситуации. Флип контроля показывается суффиксом ` · нестабильно` на строке контроля. У `control.cards[]` появилось поле `unstable`. Поле `stability.checked` не менялось: оно по-прежнему учитывает и контрольные ситуации, а на экран не выводится.
- **Files modified:** src/result-view.ts, test/result-view.test.ts
- **Commit:** 0786b8f

**3. [Rule 1 - Bug] В черновике, который ещё не запускался, нет предупреждения о контроле**
- **Found during:** Задача 1
- **Issue:** До первого запуска `cardVerdict` возвращает для карточки причину, и черновик сразу показал бы «Контроль не пройден».
- **Fix:** Для черновика, который ещё не запускался, `control.warning` равен null, а строка — «Контроль: ещё не проверен.».
- **Files modified:** src/result-view.ts
- **Commit:** 0786b8f

## TDD

Задача 2 помечена `tdd="true"`, но почти всё проверяемое поведение уже было реализовано в tracer-задаче 1. Поэтому отдельного красного коммита нет: тесты закрепляют уже работающее поведение. Новый код задачи 2 — только параметр Pi и поле в payload; тест на них добавлен в том же коммите.

## Known Stubs

Нет. Синтетическая контрольная ситуация в этой фазе не создаётся: подпись для неё реализована и проверена тестом, как и сказано в flagged_assumptions плана.

## Next

01-10: живой прогон с `repeat --control ae812a24-8f12-4190-b666-18c26c83a807` на агенте эквайринга. Перед прогоном нужно пересобрать `dist/` из снимка.

## Self-Check: PASSED

- FOUND: src/contracts.ts, src/experiment.ts, src/result-view.ts, src/cli.ts, extensions/agent-lab.ts
- FOUND: 0786b8f, b62aee8

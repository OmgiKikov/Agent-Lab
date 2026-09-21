---
phase: 01-odno-chestnoe-chislo
plan: 08
subsystem: score
tags: [score, settings, cli-pi-parity, result-view]
status: complete

requires:
  - phase: 01-02
    provides: ResultView payload in Pi (view/viewLines) and CLI summary block
  - phase: 01-03
    provides: pure src/normalize.ts module
  - phase: 01-05
    provides: evidence bundle view built against the resolved source run
provides:
  - scoreSettings(dialogueCount, supplied, mode) shared by CLI score and Pi score
  - score records saved with repeats 1 and userModes ['scripted'], so judged score cards count
  - view key in CLI score / evaluate / run JSON
  - summary(record, directory, view?) in the Pi extension; every bundle site passes bundle.view
affects: [score, reassess, repeat, pi-extension, cli]

actuals:
  tokens: 8140
  tasks: 2
  commits: 2
plan_head_before: 3e78341c4c66684a373c7e0789f87c078197ad66

tech-stack:
  added: []
  patterns:
    - "One settings helper for one operation, called by both CLI and Pi"
    - "Pi payload view comes from the evidence bundle, never recomputed without the source run"

key-files:
  created: []
  modified:
    - src/normalize.ts
    - src/cli.ts
    - extensions/agent-lab.ts
    - test/normalize.test.ts
    - test/workflow.test.ts
    - test/extension.test.ts

key-decisions:
  - "scoreSettings forces repeats 1 and userModes ['scripted'] after the owner's values: they describe imported recordings, not an owner choice"
  - "The live DEFAULT_JUDGE is copied into score settings, never shared by reference"
  - "CLI run JSON builds its view with the parent run (read-only, embeddedBefore fallback), as summary does"

metrics:
  duration: 7min
  completed: 2026-09-17
---

# Phase 1 Plan 08: одинаковые настройки score в CLI и Pi — итоги

CLI и Pi теперь собирают настройки score одной функцией, `scoreSettings(dialogueCount, supplied, mode)`. Бюджет растёт с числом диалогов, судья по умолчанию — `DEFAULT_JUDGE`, лимит на один вызов — 600 000 мс. Записи score всегда сохраняются как одна scripted-попытка, поэтому оценённые судьёй карточки попадают в число. Для повторов и переоценок блок в чате Pi совпадает с блоком `summary` в CLI.

## Что сделано

- **Задача 1 (tracer), `e69fd97`.**
  - В `src/normalize.ts` добавлена `scoreSettings`, модуль по-прежнему без побочных эффектов.
  - CLI `score` передаёт в `createInputSchema.parse` результат `scoreSettings(dialogues.length, raw.settings ?? {}, mode)`. Ошибки ввода по-прежнему проходят через `scoreInputError`.
  - В JSON-вывод `score` и `evaluate` добавлен ключ `view` из `bundle.view`. В `run` он строится через `buildResultView(result, { before })`, где родительский прогон читается только для чтения, а если его нет — берётся из `embeddedBefore`.
  - Тесты: граничные значения (1, 15 и 500 диалогов), режим demo, приоритет значений владельца. В CLI-тест добавлена проверка сохранённых настроек и `output.view`.
- **Задача 2, `4828859`.**
  - В Pi `agent_lab_build mode=score` настройки берутся из `scoreSettings`. Локальные `scoreMaxCalls` и `scoreMaxDurationMs` удалены. Для остальных операций объект настроек не изменился; из них убрана только ветка `score` для `timeoutMs`.
  - `summary(record, directory, view?)`: у всех 7 мест, где собирается bundle (score при отмене и при завершении, build/validate, inspect, run, reassess, review), bundle собирается один раз. Эти места передают `bundle.view` в `summary` и отдают тот же bundle в `exportArtifacts`.
  - Тесты:
    - одинаковые настройки: code-only score в Pi и в CLI сохраняют одни и те же шесть настроек;
    - блок повтора: `viewLines` из `agent_lab_inspect` содержат строку стабильности и совпадают с первым блоком CLI `summary`;
    - D2: score, затем reassess с судьёй, который всё засчитывает, даёт `decided === 2` и `passed === 2`.

## Проверка

- Прогон в снимке `snap-test.sh test/extension.test.ts test/normalize.test.ts test/workflow.test.ts`: 42 из 42.
- Полный прогон в снимке `snap-test.sh` (все тесты и проверка типов расширения): 384 из 384, код выхода 0.
- Наблюдаемый результат на реальных данных. `node $SNAP/dist/cli.js score --code-only` на локальных 15 диалогах эквайринга (`.agent-lab/imports/voice360-acquiring-validation-15.jsonl`, результаты записаны во временную папку и удалены) сохранил настройки: `maxCalls 120`, `maxDurationMs 1 800 000`, `timeoutMs 600 000`, `judge openrouter/openai/gpt-5.6-sol`, `repeats 1`, `userModes ['scripted']`. Это те же значения, которые Pi сохраняет для 15 диалогов. В `view.headline.text` пришло «Проверенных ситуаций нет.»: при code-only судью не вызывают, так и должно быть.
- Проверка tracer-задачи (автоматический режим): `<verify>` прошёл, после чего начата задача 2.

## Отклонения от плана

Автоматических исправлений не было. Две оговорки:
- Порядок TDD. В задаче 2 код был написан до тестов, поэтому новые тесты прошли с первого запуска. Отдельного коммита с падающими тестами (RED) нет. Что D2-тест действительно ловит проблему, следует из анализа в RESEARCH: при `userModes ['reactive']` функция `goalCardOutcome` ждёт reactive-попытки, и карточка получает `unknown`. Отдельным прогоном это не проверялось.
- Комментарий в Pi про `timeoutMs` сокращён: 600 000 мс для score теперь задаёт `scoreSettings`.

## Известные ограничения

- Живое расширение Pi в этом worktree импортирует `../dist/normalize.js`. `dist/` не пересобирался (правило CLAUDE.md), а `dist/normalize.js` там сейчас нет. Так же с 01-05 нет `dist/result-view.js`. Пока `dist/` не пересоберут, живое расширение из этого worktree не загрузится. Пересборку `dist` нужно сделать один раз в конце фазы, когда живой Pi не запущен.
- Старые записи score по-прежнему показывают, что ничего не измерено: фаза их не переинтерпретирует.
- Бюджет validate в CLI (`validateSettings`) не выровнен с Pi. TRUST-07 этого не требует (открытый вопрос 3 в RESEARCH).

## Self-Check: PASSED

- FOUND: src/normalize.ts (`export function scoreSettings`: 1)
- FOUND: src/cli.ts (`scoreSettings(dialogues.length`: 1)
- FOUND: extensions/agent-lab.ts (`from '../dist/normalize.js'`: 1; `summary(record, lab.store.directory, bundle.view)`: 7; `scoreMax(Calls|DurationMs)`: 0)
- FOUND: commits e69fd97, 4828859

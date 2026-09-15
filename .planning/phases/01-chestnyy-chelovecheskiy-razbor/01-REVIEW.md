---
phase: 01-chestnyy-chelovecheskiy-razbor
reviewed: 2026-09-15T12:41:58Z
depth: standard
files_reviewed: 12
files_reviewed_list:
  - extensions/agent-lab.ts
  - src/comparison.ts
  - src/contracts.ts
  - src/experiment.ts
  - src/outcomes.ts
  - src/quality.ts
  - test/cards.test.ts
  - test/contracts.test.ts
  - test/extension.test.ts
  - test/helpers/demo-record.ts
  - test/outcomes.test.ts
  - test/quality.test.ts
findings:
  critical: 2
  warning: 2
  info: 0
  total: 4
status: issues_found
---

# Фаза 01: отчёт финального повторного ревью кода

**Проверено:** 2026-09-15T12:41:58Z  
**Глубина:** standard  
**Файлов проверено:** 12  
**Статус:** issues_found

## Итог

Все шесть исправлений итерации 2 присутствуют в текущем коде: валидация верхнеуровневого `reviewedDialogue`, резерв служебных ID, семантика `invalid`, ручные вердикты в `trialAssessmentComplete`, дедупликация расхождений и маршрутизация очереди. `npm test` прошёл: 278 тестов, 0 ошибок; `npm run typecheck` также прошёл.

Однако валидация `reviewedDialogue` не распространена на вложенные сохранённые доказательства, а определение «последнего» вердикта неверно для корректных ISO-datetime с offset. Кроме того, два отчётных агрегата обходят уже исправленную логику авторитетных ручных вердиктов и выдают взаимно противоречивые выводы.

## Narrative Findings (AI reviewer)

## Критические проблемы

### CR-01: Вложенное `sourceEvidence` обходит инвариант `reviewedDialogue`

**Класс:** BLOCKER  
**Файл:** `/Users/kikov/conductor/workspaces/conductor-playground/lyon/src/contracts.ts:592-605`

**Проблема:** `experimentSchema.superRefine` проверяет ссылку `#seq` только в `record.humanReviews`. Та же схема принимает `sourceEvidence.humanReviews`, но не сверяет их с `sourceEvidence.trials`. Точечное воспроизведение показало, что схема успешно принимает вложенную аннотацию `{ reviewedDialogue: true, note: 'без ссылки на событие' }`. Отредактированный suite может так пройти `loadSuite`, а затем отчёт покажет фиктивный полный разбор как исходное доказательство.

**Исправление:** вынести межполевую проверку в один локальный helper и вызвать его для обеих пар массивов:

```ts
validateReviewReferences(record.humanReviews, record.trials, ['humanReviews'], ctx);
if (record.sourceEvidence) {
  validateReviewReferences(
    record.sourceEvidence.humanReviews,
    record.sourceEvidence.trials,
    ['sourceEvidence', 'humanReviews'],
    ctx,
  );
}
```

Добавить отрицательные тесты для вложенной заметки без `#seq`, с чужим `#seq` и с неизвестным `trialId`.

### CR-02: Лексикографическая сортировка может восстановить устаревший ручной вердикт

**Класс:** BLOCKER  
**Файлы:**

- `/Users/kikov/conductor/workspaces/conductor-playground/lyon/src/outcomes.ts:23-30`
- `/Users/kikov/conductor/workspaces/conductor-playground/lyon/src/contracts.ts:469`
- `/Users/kikov/conductor/workspaces/conductor-playground/lyon/src/quality.ts:139-140`

**Проблема:** `latestHumanReviews` сортирует `createdAt` через `localeCompare`, хотя схема хранения принимает любую непустую строку. Даже две корректные ISO-даты с разными offset не имеют лексикографического порядка, равного хронологическому. В воспроизведении заметка `old` с `2026-09-15T12:00:00+03:00` (фактически 09:00Z) победила более новую `new` с `2026-09-15T10:00:00Z`. Это может перевернуть `pass`/`fail`/`invalid`, закрыть или открыть очередь и нарушить инвариант «последний whole-dialogue review определяет `reviewedDialogue`»: схема приняла запись, но `qualitySummary(...).human.reviewed` вернул `1` вместо `0`.

**Исправление:** использовать канонический append-order массива: `addHumanReview` уже добавляет каждую новую аннотацию в конец.

```ts
for (const review of record.humanReviews) {
  if (!trials.has(review.trialId)) continue;
  latest.set(reviewKey(review), review);
}
```

Если `createdAt` должен быть источником порядка, нужно нормализовать его в UTC на границе схемы и сравнивать epoch, а не строки. Добавить тесты с ISO-offset, откатом системных часов и более новой немаркированной whole-dialogue заметкой.

## Предупреждения

### WR-01: «Слабые места» и причины игнорируют авторитетную ручную оценку рубрики

**Класс:** WARNING  
**Файлы:**

- `/Users/kikov/conductor/workspaces/conductor-playground/lyon/src/comparison.ts:441-489`
- `/Users/kikov/conductor/workspaces/conductor-playground/lyon/src/quality.ts:93-118`

**Проблема:** общий `rubric`-итог уже вызывает `agentRubricResult` и учитывает последний ручной вердикт. Но `stageTally`, `metricFailures`, `weakSpots` и fallback-причины читают исходные `trial.assessments`. В воспроизведении ручной `pass` исправил авторитетный итог до `pass` и дал `rubric.failed = 0`, но тот же `verdictSummary` вернул `weakSpots: [{ description: 'M', failures: 1 }]` и `fix_weakest: M`. Первый экран поэтому может одновременно назвать критерий пройденным и главной причиной провала.

**Исправление:** при построении `stageTally`, `metricFailures`, `firstReason` и fallback-кластеров использовать тот же effective result: последний ручной `pass`/`fail` имеет приоритет, `invalid` исключает критерий, `unknown` оставляет его нерешённым. Для сохранённых `failureModes` отфильтровать trial, которые после ручной оценки больше не являются `isAgentFailure`.

### WR-02: `compareUserModes` не видит rubric-only результаты и считает ручную ложную тревогу провалом

**Класс:** WARNING  
**Файл:** `/Users/kikov/conductor/workspaces/conductor-playground/lyon/src/comparison.ts:145-180`

**Проблема:** для `valid` функция требует `graded(t)`, поэтому rubric-only диалог с `outcome: 'ungraded'` никогда не попадает в `valid`/`passed` и даёт `passRate: null`, даже если `automaticTrialResult` равен `pass` или `fail`. При этом `criteria()` берёт сырой `trial.assessments` и игнорирует ручной вердикт. В воспроизведении rubric-only reactive-диалог имел ручной `pass` и `automaticTrialResult = 'pass'`, но сравнение вернуло `valid = 0`, `passRate = null`, `failedChecks = ['s/metric:m']` и ложно объявило этот критерий уникальным провалом reactive-режима.

**Исправление:** считать валидными и `pass`/`fail` по `automaticTrialResult`, а для каждой agent-рубрики брать effective verdict из `latestHumanReviews` по тем же правилам, что и `agentRubricResult`. Добавить тест rubric-only пары режимов и ручного `pass`, исправляющего исходный rubric `fail`.

---

_Проверено: 2026-09-15T12:41:58Z_  
_Рецензент: the agent (gsd-code-reviewer)_  
_Глубина: standard_

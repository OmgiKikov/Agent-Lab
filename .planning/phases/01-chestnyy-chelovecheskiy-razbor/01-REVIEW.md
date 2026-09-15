---
phase: 01-chestnyy-chelovecheskiy-razbor
reviewed: 2026-09-15T11:57:37Z
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
  warning: 1
  info: 0
  total: 3
status: issues_found
---

# Phase 01: Отчёт о ревью кода

**Проверено:** 2026-09-15T11:57:37Z  
**Глубина:** standard  
**Файлов проверено:** 12  
**Статус:** issues_found

## Summary

Проверены все 12 файлов фазы и связанные границы чтения отчётов и сохранения ручных вердиктов. `npm run build`, 95 целевых тестов и `npm run typecheck` проходят, однако воспроизводятся два нарушения пользовательского контракта и одна несогласованность persisted-схемы.

## Narrative Findings (AI reviewer)

### Critical Issues

#### CR-01: Завершённый разбор снова ставится в очередь

**Класс:** BLOCKER  
**Файл:** `src/quality.ts:173`  
**Проблема:** `qualityLines` выбирает ветку `q.causes.length` раньше проверки `q.humanQueue.total`. Поэтому после отдельного вердикта по каждому нужному диалогу, когда `humanQueue.total === 0`, наличие сохранённой причины всё равно выдаёт команду «Откройте диалоги причин и поставьте каждому отдельный вердикт». Воспроизведение на одном подтверждённом провале даёт одновременно `humanQueue.total: 0` и эту команду. Пользователь не может понять, что очередь завершена, и повторно размечает уже разобранные диалоги.

**Исправление:** сначала проверять наличие незакрытых элементов, а причины использовать только для навигации внутри непустой очереди.

```ts
queue: !q.humanQueue.total
  ? 'Ручная разметка не требуется: провалов и спорных оценок нет.'
  : q.causes.length
    ? `Разобрать: ${plural(q.causes.length, ['причину', 'причины', 'причин'])}. Откройте неразобранные диалоги причин и поставьте каждому отдельный вердикт.`
    : `Разметить человеку: ${q.humanQueue.total} (...)`,
```

Добавить регрессию: причина остаётся в агрегате, но после последнего решающего вердикта строка очереди больше не предлагает повторную разметку.

#### CR-02: Persistence-граница принимает фиктивный полный разбор без ссылки на событие

**Класс:** BLOCKER  
**Файл:** `src/experiment.ts:353-359`  
**Проблема:** проверка `#<seq>` находится только в `humanAnnotation`. Экспортируемый `ExperimentLab.addHumanReview` принимает `{ reviewedDialogue: true, note: 'нет ссылки на событие' }`, сохраняет запись и после этого `qualitySummary` показывает `human.reviewed: 1`. Это позволяет любому текущему или будущему вызывающему коду обойти HREV-06 и записать недоказанный полный разбор; слой, который фактически владеет сохранением, инвариант не защищает.

**Исправление:** после поиска `trial` повторно проверить ссылку на существующий `trial.events[].seq` перед записью.

```ts
if (input.reviewedDialogue
  && ![...input.note.matchAll(/#(\d+)\b/g)]
    .some(match => trial.events.some(event => event.seq === Number(match[1])))) {
  throw new Error('Полный разбор должен ссылаться на событие текущего диалога.');
}
```

Проверку в UI оставить для немедленной обратной связи, а тест добавить непосредственно на `ExperimentLab.addHumanReview`, включая отсутствующий и чужой `seq`.

### Warnings

#### WR-01: Входная и persisted-схемы расходятся по единственности цели

**Класс:** WARNING  
**Файл:** `src/contracts.ts:585-589`  
**Проблема:** `humanReviewInputSchema` отклоняет запись, где одновременно заданы `metricId` и `checkId`, но inline-схема `experimentSchema.humanReviews` сохраняет только новое ограничение `reviewedDialogue` и принимает ту же неоднозначную запись. Воспроизведение даёт `inputAccepts: false`, `persistedAccepts: true`. При чтении такого record `latestHumanReviews` молча выбирает metric-ключ, потому что проверяет `metricId` первым, поэтому фактическая цель вердикта зависит от детали реализации.

**Исправление:** удалить дублирующую inline-схему и использовать уже определённую `humanReviewSchema`, которая сохраняет оба refinement.

```ts
humanReviews: z.array(humanReviewSchema).default([]),
```

Добавить один контрактный тест, который прогоняет одинаковую двуцелевую запись через обе схемы и ожидает отказ в обоих случаях.

---

_Проверено: 2026-09-15T11:57:37Z_  
_Рецензент: the agent (gsd-code-reviewer)_  
_Глубина: standard_

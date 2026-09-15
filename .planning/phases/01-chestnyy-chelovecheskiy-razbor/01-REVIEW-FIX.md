---
phase: 01-chestnyy-chelovecheskiy-razbor
fixed_at: 2026-09-15T12:53:26Z
review_path: .planning/phases/01-chestnyy-chelovecheskiy-razbor/01-REVIEW.md
iteration: 3
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Фаза 01: отчёт об исправлении замечаний ревью

**Исправлено:** 2026-09-15T12:53:26Z
**Исходное ревью:** `.planning/phases/01-chestnyy-chelovecheskiy-razbor/01-REVIEW.md`
**Итерация:** 3

**Итог:**

- Замечаний в scope: 4
- Исправлено: 4
- Пропущено: 0

## Исправленные замечания

### CR-01: Вложенное `sourceEvidence` обходит инвариант `reviewedDialogue`

**Статус:** fixed
**Изменённые файлы:** `src/contracts.ts`, `test/contracts.test.ts`
**Коммит:** 57bb15b
**Исправление:** единая межполевая проверка теперь валидирует ссылки полного разбора и в основной записи, и во вложенном `sourceEvidence`; заметки без ссылки, с чужим событием или неизвестным `trialId` отклоняются.

### CR-02: Лексикографическая сортировка может восстановить устаревший ручной вердикт

**Статус:** fixed: requires human verification
**Изменённые файлы:** `src/outcomes.ts`, `test/outcomes.test.ts`
**Коммит:** 07db89c
**Исправление:** последний вердикт определяется каноническим порядком добавления в массив, поэтому ISO-offset и откат системных часов не меняют порядок сохранённых решений.

### WR-01: «Слабые места» и причины игнорируют авторитетную ручную оценку рубрики

**Статус:** fixed: requires human verification
**Изменённые файлы:** `src/outcomes.ts`, `src/comparison.ts`, `src/quality.ts`, `test/quality.test.ts`
**Коммит:** d0f4b58
**Исправление:** этапы, слабые места, цитируемые причины и сохранённые кластеры используют общий effective verdict; `invalid` исключает критерий, а исправленные человеком диалоги больше не остаются в кластерах провалов.

### WR-02: `compareUserModes` не видит rubric-only результаты и считает ручную ложную тревогу провалом

**Статус:** fixed: requires human verification
**Изменённые файлы:** `src/comparison.ts`, `test/comparison.test.ts`
**Коммит:** a852d4d
**Исправление:** валидность и pass rate режимов теперь основаны на `automaticTrialResult`, а rubric-критерии используют авторитетный effective verdict, включая ручные исправления и исключение `invalid`.

## Проверка

Проверки выполнены в изолированном worktree:

- `npm test` — 281/281 тест прошёл.
- `npm run build` — прошёл.
- `npm run typecheck` — прошёл.

---

_Исправлено: 2026-09-15T12:53:26Z_
_Исполнитель: the agent (gsd-code-fixer)_
_Итерация: 3_

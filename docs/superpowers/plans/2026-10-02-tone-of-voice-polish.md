# Полировка пути tone of voice — план

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (выбрано: исполняю сам в сессии). Шаги — чекбоксы.

**Goal:** путь tone of voice (старт → проверка → итог → «Обзор» → «Диалоги» → «Проверка») говорит одними словами и одними
числами, доказательство совпадает с заголовком, доверие видно, детали и надёжность — по чек-листу спеки.

**Architecture:** правки существующих экранов и двух мест бэкенда; новых подсистем нет. Общие куски — в `product/`.

**Tech Stack:** Python 3.11 + FastAPI + SQLite (`backend/lab`), React + Vite + Tailwind + React Query (`frontend/src`).

**Spec:** `docs/superpowers/specs/2026-10-02-agent-lab-polish-design.md` (сужена до tone of voice: `TONE_ONLY = true`).

## Global Constraints

- Словарь и честность чисел — `docs/DESIGN.md`: «N из M», «не удалось проверить», «Это действительно ошибка? Да / Нет».
- Скрытое (`TONE_ONLY`) не трогаем и не удаляем.
- Бэкенд: каждое правило — тест, который сначала падает (`uv run --locked python -m unittest`).
- Фронт: тестов нет в проекте — проверка `npm run lint` (0 предупреждений), `npm run build`, скриншоты на копии живых
  данных (`/private/tmp/claude-501/tov`, порт 5940) на 1440 и 390 px.
- Каждый PR: `sh bin/check.sh` зелёный. Живой сервер на 5910 перезапускать только когда нет задания.

## Review Focus

1. Критерий без короткого имени и без заголовка нарушения — экраны показывают текст критерия, не пустоту.
2. Находка, у которой у всех ошибок пустой `title`, — пример всё равно показывается (порядок по надёжности).
3. Итог, где проверено 0 разговоров, — без деления на ноль и без «0 из 0» крупно (пустое состояние).
4. Очень длинный текст критерия (20 строк со «*») — свёрнут до первой фразы, раскрывается по кнопке.
5. Ответ человека снимается повторным нажатием — подписи «подтверждено…» обновляются без перезагрузки.

---

### Task 1: Заголовок находки совпадает с первым примером (бэкенд)

**Files:** `backend/lab/problems.py` (`verdicts`, `finish`), `backend/tests/test_problems.py`; фронт: `lab/problems.ts` (тип).

- [ ] Тест: у одного критерия три ошибки в разных разговорах — у самой надёжной заголовок «B», у двух других «A».
  Ожидаем `rule.title == 'A'` и первый FAIL-пример с `title == 'A'`; пример несёт поле `title`.
- [ ] Запустить — падает (первый пример «B», поля `title` нет).
- [ ] В `verdicts` класть `title` в пример; в `finish` после выбора заголовка стабильно поднять FAIL-примеры с этим
  заголовком: `side['examples'].sort(key=lambda e: e['status'] != 'FAIL' or e.get('title') != title)`.
- [ ] Тесты зелёные; `Example.title?: string` во фронте. Коммит.

### Task 2: «Агент должен» — коротко, полностью по кнопке

**Files:** create `frontend/src/product/Duty.tsx`; modify `sections/review/ReviewPage.tsx:251-255`,
`sections/problems/ProblemPage.tsx:153-156`.

- [ ] `Duty({ text })`: текст без markdown-заголовков (`duty()`), строки «* …» → пункты. Свёрнуто: первая фраза (до
  первой точки или первого пункта, не длиннее ~160 знаков) + «Полностью»; развёрнуто — абзац и список.
- [ ] Подставить в «Проверку» и страницу проблемы вместо `{duty(...)}`.
- [ ] Скриншот «Проверки» на копии: вместо 20 строк — одна фраза. lint + build. Коммит.

### Task 3: Итог tone of voice — тем же числом и теми же словами

**Files:** `sections/check/Result.tsx:29-108`, `sections/check/Finding.tsx:125-155`.

- [ ] Шапку «9% / 8 · 86 · 6» заменить на `StageResult failed={summary.failed} checked={summary.measured}
  unchecked={summary.unmeasured} size="display"`; цифры ведут в разговоры, как раньше (ссылка «Все разговоры»).
- [ ] В находке: вопрос «Это действительно ошибка?» с ответами «Да / Нет» (как `ReviewButtons`), «Оспорено/Подтверждено»
  → состояние нажатой кнопки; «Уточнить критерий» остаётся после «Нет».
- [ ] Скриншот: шапка как в «Обзоре», в находке «Да / Нет». lint + build. Коммит.

### Task 4: Старт без радиокнопки у единственного варианта

**Files:** `sections/check/StartPage.tsx` (`MetricOption`).

- [ ] При `TONE_ONLY` карточка без `role="radio"` и кружка: заголовок, что проверяем, что уже есть; кнопка под ней.
- [ ] Скриншот 1440/390. Коммит.

### Task 5: Доверие — ответ человека рядом с итогом, «мало данных»

**Files:** create `frontend/src/product/Trust.tsx`; modify `sections/logs/LogsPage.tsx`, `sections/overview/OverviewPage.tsx`
(`LogStage`), `sections/check/Result.tsx`.

- [ ] `Trust({ data, stage })` под полоской: до ответов — «Проверьте N случаев, чтобы убедиться в оценке →» (очередь
  «Без вашего ответа»); после — «Вы проверили K: ошибка подтверждена в A, не подтверждена в B» (`decisions(data)` из
  `lab/verdicts.ts`). Если проверено меньше 30 разговоров — тихая строка «Мало разговоров для уверенного вывода».
- [ ] Подключить на итоге «Диалогов», в «Обзоре» и на итоге tone of voice. Скриншоты. Коммит.

### Task 6: Детали — числа, фокус, движение, загрузка

**Files:** `lab/format.ts`, `product/StageResult.tsx`, `product/Count.tsx`, `index.css`, `product/motion.ts`,
`ui/EmptyState.tsx` (`Skeleton`).

- [ ] `count()` и «N из M» с неразрывным пробелом (` `); проценты целые (уже).
- [ ] `index.css`: `:focus-visible { outline: 2px solid rgb(var(--run)); outline-offset: 2px }` для всего, у чего нет своего
  кольца; `h1,h2,h3 { text-wrap: balance }`, `p { text-wrap: pretty }`.
- [ ] Досчёт 900 → 500 мс, появление 500 → 300 мс, лесенка до 240 мс; полоска 1000 → 600 мс.
- [ ] `Skeleton`: появляется с задержкой 200 мс (`animation-delay` + `opacity`), без мигания.
- [ ] lint + build + скриншоты. Коммит.

### Task 7: Надёжность

**Files:** `frontend/src/router.tsx` (+ `app/ScreenError.tsx`), `backend/lab/app.py`, `backend/lab/store.py`,
тесты `backend/tests/test_app.py`, `backend/tests/test_store.py`.

- [ ] Тест: `GET /` отдаёт `Cache-Control: no-cache`; падает → `FileResponse(index, headers={'Cache-Control':
  'no-cache'})` → зелёный.
- [ ] Тест: после записи `PRAGMA journal_mode` = `wal`; падает → в `_connection` `PRAGMA journal_mode=WAL` → зелёный.
- [ ] `errorElement: <ScreenError />` у корня: «Этот экран не открылся» + «Обновить» + «Подробности» (текст ошибки).
- [ ] check.sh. Коммит.

### Task 8: Долгая проверка — понятно, что можно уйти, и заметно, что готово

**Files:** `app/TaskCard.tsx`, `lab/LabProvider.tsx`.

- [ ] Пока задание идёт: строка «Можно закрыть страницу: результат сохранится».
- [ ] Задание закончилось, а вкладка не в фокусе: заголовок «Готово · Agent Lab» до возвращения на вкладку.
- [ ] lint + build. Коммит. PR со всеми задачами, CI, слить по слову владельца.

## Не входит сейчас

Случайная доля «без ошибки» в очереди и мера пропущенных ошибок (Task из спеки, PR 2) — после того, как владелец
посмотрит Task 5; 214 спорных случаев в очереди — отдельный разговор о том, что считать спорным для tone of voice.

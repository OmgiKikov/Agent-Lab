# Единый продукт — план 1 из 4: сервис, основа интерфейса, «Проблемы»

> Исполнение: нативно, в этой сессии (владелец: «давай газ»; субагенты разрешены «если что» — финальное ревью свежим агентом).
> Шаги — чек-листы `- [ ]`.

**Цель:** работающий срез нового продукта — сервис отдаёт проблемы с доказательствами, интерфейс получает новую оболочку
(рейка, шапки разделов, активность, ⌘K, ассистент), шрифты с кириллицей, токены и экран «Проблемы» с разбором.

**Архитектура:** сервис (`lab/`) собирает правила и проблемы в `lab/problems.py` и отдаёт недостающие данные (диалог логов,
текст источника, решение по правилу). Интерфейс (`workshop/app/src`) получает `ui/` (компоненты), `shell/` (оболочка) и
`screens/problems/`. Разделы, которые перестраивают планы 2–4, до тех пор открывают прежние экраны (`shell/links.ts`).

**Стек:** Python 3.12 + FastAPI; React 18 + Vite + Tailwind 3 + TanStack Query 5 + Radix Dialog + lucide; Bun для сборки.

**Спека:** `docs/superpowers/specs/2026-09-30-agent-lab-unified-product-design.md`.

**Дальше:** план 2 — «Правила» и проверка вердиктов; план 3 — «Диалоги» (единый список, загрузка логов, режимы Workshop,
экран диалога, русские строки трейсов); план 4 — «Симуляции», «Агент», «Настройки», удаление старого, `docs/DESIGN.md`,
полировка, слияние с веткой на GitHub.

## Global Constraints

- Тестов нет (решение владельца): проверка — `ruff`, `tsc`, сборка, `curl`, снимки Playwright, проход по сценарию.
- Всё в интерфейсе, без консольных команд для пользователя; единственная команда — `sh bin/start.sh`.
- Слов «Agent Lab» в новом интерфейсе нет; агент — «Агент эквайринга».
- Шрифты: Inter Variable (opsz) и Geist Mono Variable, из `@fontsource-variable/*`, внутри сборки.
- Размеры — только именованные (`text-micro|label|meta|small|body|read|title|page|count`), цвета — только токены `lab-*`.
- Сочетания клавиш — по `KeyboardEvent.code`.
- Числа только сервиса; логи и симуляция не складываются; «без обнаруженных нарушений», «не оценён».
- Работа на локальной ветке от `40d5b6f`; на GitHub не отправляем до плана 4.

## Review Focus

1. Старые записи: второй судья по логам без строк по правилам, решения по симуляции на весь диалог — показывать «по диалогу
   целиком», а не выдавать за решение по правилу (задача 1, 7).
2. Новая оценка логов и переоценка прогона не должны молча стирать решения людей: переносить на тот же вердикт (задача 2).
3. «Верно / неверно», пока идёт задача, пишущая тот же файл, — отказ 409 с понятной фразой, а не потерянный клик (задача 2).
4. Цитата судьи не найдена в тексте агента (имя инструмента, служебный ответ, многоточие) — показать её отдельно;
   цитата правила не найдена в текущем тексте источника — честная пометка (задача 7).
5. Пустые и неполные состояния: нет оценки, оценка без нарушений, прогон со сценариями, которых уже нет в наборе, нет
   готового агента, сервис не отвечает — у каждого своя фраза и следующий шаг (задачи 1, 6, 7).

---

### Task 1: сервис — правила и проблемы

**Files:** Create `lab/problems.py`; Modify `lab/api.py` (маршрут, CORS для Vite :5900).

**Produces:** `GET /api/problems?run=<id>` → `{log, sim, rules: RuleEntry[], problems: string[]}` (спека §8): у правила `id`
(`r-` + 10 знаков sha1 нормализованной цитаты), `title`, `rule {text, quote, sourceId, origin, kind, condition, acceptable}`,
`topics`, `log`/`sim` `{failed, passed, unknown, examples}`, `secondJudge {checked, agree, byDialogue}`,
`human {agree, disagree}`, `scenarioIds`. Пример: `source, dialogueId | runId+index, ruleId, status, traceId, opening, topic,
name?, persona?, attempt?, agentQuote, reason, second, secondScope, review, reviewScope`.

- [ ] Написать `lab/problems.py`: `Book` (правила по ключу цитаты; источник по `sourceId`, иначе поиск цитаты в источниках;
  разговор учитывается один раз — худшим вердиктом), `from_logs`, `from_run` (правило по критерию сценария, иначе по тексту),
  `finish`, `build(run_id)`.
- [ ] `api.py`: `GET /api/problems` (404, если прогона нет); CORS: добавить `http://127.0.0.1:5900`, `http://localhost:5900`.
- [ ] Проверка: `.venv/bin/python` скрипт на настоящих `data/` — печать счётов; число правил, нарушенных в логах, равно
  `len(summary.patterns)`; у каждой проблемы `failed > 0`. `.venv/bin/ruff format lab && .venv/bin/ruff check lab`.
- [ ] Коммит.

### Task 2: сервис — диалог, источник, решение по правилу, сохранность решений, логи

**Files:** Modify `lab/api.py`, `lab/logs.py`, `lab/metric.py`, `lab/discover.py`, `lab/simulate.py`.

**Produces:** `GET /api/dialogues/{id}` → `{id, messages: [{role: customer|agent, text}], result: {…, topic} | null}`;
`GET /api/sources/{id}` → `{id, kind, origin, sha256, content}`; `POST /api/review` с `{source: "log", dialogueId, ruleId,
decision}` или `{source: "sim", run, index, ruleId, decision}` (старое тело принимается); `state.logs = {total, file,
updatedAt}`; `metric.human` считает решения по правилам (и по диалогу для старых записей).

- [ ] Маршруты; решение по логам — 409, пока идёт оценка; по прогону — 409, пока он идёт.
- [ ] `discover.run`: при зафиксированных правилах перенести решения людей на тот же (диалог, правило, статус).
- [ ] `simulate.rejudge`: перенести решения на тот же (правило, статус).
- [ ] `logs.replace` запоминает имя и время (`data/logs-meta.json`); `logs.meta()`; поля в `/api/state`.
- [ ] Проверка: перезапуск `LAB_NO_OPEN=1 sh bin/start.sh`; `curl` каждого маршрута; «верно» → видно в `/api/problems` →
  снять (`null`); ruff.
- [ ] Коммит.

### Task 3: основа интерфейса — шрифты, токены, компоненты

**Files:** Modify `workshop/app/package.json`, `src/main.tsx`, `tailwind.config.js`, `src/index.css`, `src/lib/utils.ts`;
Create `src/ui/{Label,Kbd,Button,Segmented,ListRow,Split,Facts,Quote,highlight,Conversation,Drawer,Modal,Menu,EmptyState,toast}.tsx|ts`.

- [ ] Шрифты: `@fontsource-variable/inter` (`opsz.css`), `@fontsource-variable/geist-mono`; убрать Barlow и Space Mono.
- [ ] Tailwind: `fontFamily`, шкала размеров, цвета `lab-hover`, `lab-active`, `lab-mark`; `cn` знает шкалу
  (`extendTailwindMerge`, тема `text`).
- [ ] Компоненты по спеке §6.
- [ ] Проверка: `bun x tsc --noEmit`; `cn("text-read text-lab-ink")` сохраняет оба класса.
- [ ] Коммит.

### Task 4: оболочка

**Files:** Create `src/shell/{LabProvider,ShellContext,keys,links,jobs,Rail,Activity,SectionHeader,CommandPalette,AppShell}.tsx|ts`;
Modify `src/router.tsx`, `src/components/MessagePane.tsx`, `bin/start.sh` (открывать `/`).

**Produces:** `useLabState()`, `useShell()` (`openPalette`, `openAsk(runId?)`), `useKeys(map, enabled)`, `LINKS`, `JOBS`,
`SectionHeader({crumbs, actions, below})`, `JobStrip({kinds})`.

- [ ] Рейка (Проблемы, Диалоги, Правила, Симуляции | Агент, Настройки), кольцо активности и уведомление об окончании.
- [ ] `AppShell` вместо `AppLayout` и `NavSidebar`; плашка «Workshop не запущен» только на трейсах; ⌘K, ⌘J.
- [ ] `MessagePane`: открывается событием `raindrop:ask`, плавающая плашка убрана.
- [ ] Маршруты: `/` и `*` → `/problems`; прежние экраны на своих адресах.
- [ ] Проверка: `bun x tsc --noEmit`.
- [ ] Коммит.

### Task 5: данные проблем

**Files:** Create `src/lab/problems.ts`, `src/lab/problemReport.ts`; Modify `src/lab/types.ts` (`logs`).

**Produces:** типы `Problems`, `RuleEntry`, `Example`, `Decision`; `useProblems(runId)`, `useReview()`, `useTurns(example)`,
`useSource(id)`; `summarySentence`, `problemMarkdown`, `problemsReport`, `reliabilityWord`, `secondLine`, `sourceLabel`,
`download`.

- [ ] Проверка: `bun x tsc --noEmit`. Коммит вместе с задачей 6.

### Task 6: экран «Проблемы»

**Files:** Create `src/screens/problems/{ProblemsPage,Summary,ProblemList,FirstRun,AssessDialog}.tsx`; Modify `src/router.tsx`.

- [ ] Фраза-итог, строка «откуда цифры» с выбором прогона, список с фильтрами и поиском, J/K, первый запуск, «Оценить логи»
  (выбор числа диалогов), «Отчёт».
- [ ] Проверка: `bun x tsc --noEmit`, Vite на :5900, снимок экрана.
- [ ] Коммит.

### Task 7: разбор проблемы

**Files:** Create `src/screens/problems/{ProblemDetail,Evidence,SourceDrawer,Reproduce}.tsx`.

- [ ] Факты, «Промпт требует» с панелью источника, доказательство (примеры по надёжности, ←/→, логи/симуляция, подсветка
  с номером, объяснение, второй судья, «верно / неверно» V/N), «не известно», «воспроизвести», «скопировать».
- [ ] Проверка: `bun x tsc --noEmit`, снимки, клики.
- [ ] Коммит.

### Task 8: сборка и проверка

- [ ] `sh bin/build-workshop.sh`; снимки 1440×900, 1280×800, 1024×768, 390×844 на :5899; ошибок консоли нет.
- [ ] Шрифты: `document.fonts.check('14px "Inter Variable"', 'Ж')` и для Geist Mono — `true`.
- [ ] Числа: фраза-итог и счёты совпадают с `/api/problems`.
- [ ] Проход: «Проблемы» → проблема → панель источника → пример ←/→ → «Верно» (и снять) → ⌘K → «Спросить».
- [ ] Коммит.

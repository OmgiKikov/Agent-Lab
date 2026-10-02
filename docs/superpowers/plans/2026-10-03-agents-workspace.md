# Несколько агентов — план

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (исполняю сам в сессии; владелец отдал
> решение: «делай красиво… утром гляну результат»). Шаги — чекбоксы.

**Goal:** список агентов и переключатель; внутри агента — нынешний продукт на его собственной базе.

**Architecture:** база на агента (`data/agents/<id>/lab.sqlite3`) + реестр (`data/agents.sqlite3`); текущий агент
запроса из заголовка `X-Agent` → `store.AGENT` (ContextVar с путём базы); задания по агенту. Фронт: `/a/<id>` —
`basename` роутера, заголовок в `api()`, страница «Агенты».

**Tech Stack:** FastAPI, SQLite, unittest; React Router 6, React Query, Tailwind.

**Spec:** `docs/superpowers/specs/2026-10-03-agents-workspace-design.md`

## Global Constraints

- Существующий код хранения и тесты не трогаем: без агента `store` работает с `store.DB` как раньше.
- Данные агентов никогда не смешиваются; числа агентов не сравниваются.
- Перенос не удаляет данные: старая база остаётся `lab.sqlite3.before-agents`.
- Каждое правило бэкенда — тест, который сначала падает. Фронт — lint, build, скриншоты (1440 и 390 px).
- `bin/check.sh` зелёный в конце каждой задачи бэкенда.

## Review Focus

1. Запрос без `X-Agent` при пустом реестре — работает со старой базой (тесты, `lab.migrate`).
2. Фоновое задание, запущенное в агенте A, пишет только в базу A, даже когда параллельно открыт B.
3. Имя агента из кириллицы, совпадающее с существующим, — новый уникальный id, не перезапись.
4. Повторный старт после переноса — перенос не повторяется, данные не дублируются.
5. Старая закладка `/overview` без агента — открывает последнего агента, а не пустой продукт.

---

### Task 1: Реестр агентов и база агента в контексте

**Files:** create `backend/lab/registry.py`; modify `backend/lab/store.py`; test `backend/tests/test_registry.py`.

- [ ] Тесты: `create('Агент эквайринга', '…')` → id `agent-ekvayringa`, повтор имени → `agent-ekvayringa-2`; `listed()` в
  порядке создания; `using(id)` направляет `store.save/load` в `data/agents/<id>/lab.sqlite3`, другой агент этих данных не
  видит. Падают (модуля нет).
- [ ] `store.AGENT: ContextVar[Path | None]`; `_connection` открывает `AGENT.get() or DB`.
- [ ] `registry`: `REGISTRY`, `db_of(id)`, `create`, `listed`, `get`, `default_id`, контекст-менеджер `using(id)`.
- [ ] Тесты зелёные, check.sh. Коммит.

### Task 2: Агент запроса и задания по агенту

**Files:** `backend/lab/api.py`, `backend/lab/jobs.py`; test `backend/tests/test_registry.py`.

- [ ] Тесты: через API с `X-Agent: a` загружены диалоги → у `b` их нет; неизвестный агент → 404; задание в `a` идёт, в
  `b` можно запустить своё, и `/api/state` у каждого показывает своё. Падают.
- [ ] Middleware в `api.py`: `X-Agent` или `registry.default_id()` → `store.AGENT`; 404, если агента нет.
- [ ] `jobs.PerAgent`: по `Jobs` на агента, тот же интерфейс (`state`, `start`, `perform`, `stop`, `close`).
- [ ] `lifespan`: `recover_runs` для каждого агента. Тесты, check.sh. Коммит.

### Task 3: Перенос существующей базы в первого агента

**Files:** `backend/lab/registry.py` (`adopt_legacy`), `backend/lab/api.py` (lifespan); test.

- [ ] Тест: в `data/` есть `lab.sqlite3` с документом → после `adopt_legacy()` агент `acquiring` «Агент эквайринга» видит
  документ; старый файл → `lab.sqlite3.before-agents`; второй вызов ничего не делает. Падает.
- [ ] Копия через `sqlite3.backup`, затем переименование. Вызов в начале `lifespan`. Тесты, check.sh. Коммит.

### Task 4: API агентов

**Files:** `backend/lab/api.py`; test.

- [ ] Тест: `POST /api/agents {name, description}` → агент; `GET /api/agents` → список с `result`: `failed`, `measured`,
  `unmeasured`, `finishedAt`, `metric` из базы каждого агента (или `null`). Падает.
- [ ] Маршруты вне агента (middleware их пропускает). Тесты, check.sh. Коммит.

### Task 5: Фронт — агент в адресе

**Files:** `frontend/src/main.tsx`, `frontend/src/lab/api.ts`, create `frontend/src/app/agent.ts`, `frontend/src/home.tsx`.

- [ ] `agent.ts`: id из `/a/<id>`, последний открытый в `localStorage` (try/catch).
- [ ] `api()` ставит `X-Agent`. `main.tsx`: при `/a/<id>` — роутер продукта с `basename`; иначе — «домашний» роутер:
  `/agents` — список; остальное — переход в последнего/единственного агента с тем же путём, иначе в список.
- [ ] lint, build. Коммит.

### Task 6: Страница «Агенты» и новый агент

**Files:** create `frontend/src/sections/agents/AgentsPage.tsx`, `NewAgent.tsx`; `frontend/src/lab/agents.ts` (запросы).

- [ ] Карточки: имя, описание, итог (`N из M разговоров с ошибкой · метрика · дата`, мини-полоска) или «Ещё не
  проверялся»; вся карточка — ссылка в агента. «Новый агент»: имя, описание → создание → `/a/<id>/start`.
- [ ] Пустое состояние: «Добавьте первого агента». lint, build, скриншоты. Коммит.

### Task 7: Переключатель и имя агента внутри

**Files:** `frontend/src/app/Sidebar.tsx`, `frontend/src/app/BottomNav.tsx`, `frontend/src/sections/overview/OverviewPage.tsx`,
`frontend/src/lab/look.ts`.

- [ ] В шапке навигации — имя и описание текущего агента, меню: агенты (текущий отмечен), «Все агенты», «Новый агент».
- [ ] «Обзор» и прочие места берут имя агента из реестра, константы `AGENT_TITLE/SUBTITLE` удалены.
- [ ] Мобильное «Ещё» — «Все агенты». lint, build, скриншоты. Коммит.

### Task 8: Документы, проверка, ревью, слияние

- [ ] README, `docs/backend.md`, `docs/DESIGN.md`: агенты, адреса, где база. check.sh.
- [ ] Независимое ревью ветки, исправления по тестам. PR, CI, слияние; живой сервер — резервная копия `data/`,
  перезапуск, проверка, что агент эквайринга со всеми данными на месте.

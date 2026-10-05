# Agent Lab

Проверяет ИИ-агента поддержки по его настоящим разговорам. Находит ошибки по критериям из правил, воспроизводит их
в тестовых сценариях и показывает, стало ли лучше после правки.

## Запуск

Нужны Python 3.11+, [uv](https://docs.astral.sh/uv/) и Node.js 22.19+.

    OPENROUTER_API_KEY=sk-or-... sh bin/start.sh

Открыть http://127.0.0.1:5899. Остановить — Ctrl+C.

Всё делается в интерфейсе: создать агента, загрузить выгрузку разговоров (.xlsx, .jsonl) и правила общения
(.docx, .txt, .md), запустить проверку. Адрес агента и путь к его коду задаются на экране «Агент».

## Модели

Lab выбирает модели при запуске, в таком порядке:

1. **LAB_MODEL_URL** — любой OpenAI-совместимый endpoint. Ключ — LAB_MODEL_KEY, модель — LAB_MODEL.
2. **Шлюз банка** — если в certs/ есть url.txt.
3. **OpenRouter** — с ключом в OPENROUTER_API_KEY. По умолчанию модель `z-ai/glm-5.3`.

Для шлюза положить в certs/: url.txt, сертификат и ключ или .p12/.pfx с паролем в password.txt, корневой ca.pem,
если он нужен. Сломанный шлюз OpenRouter не заменяет: причина видна в «Настройках».

Вторая модель для перепроверки включается через LAB_SECOND_MODEL (адрес — LAB_SECOND_URL, ключ — LAB_SECOND_KEY).
Все настройки — в `backend/lab/config.py`. Lab читает их при запуске.

## Данные

У каждого агента своя база: `data/agents/<id>/lab.sqlite3`. data/ и certs/ в Git не попадают. Другая папка —
LAB_DATA, сертификаты — LAB_CERTS. С одной папкой данных работает один Lab.

## Разработка

    uv run --directory backend uvicorn lab.app:create --factory --reload --port 5901
    npm --prefix frontend ci && npm --prefix frontend run dev

Интерфейс — на :5900, запросы к /api Vite передаёт в Python на :5901.

    sh bin/check.sh      # то же, что в CI: Ruff, тесты, тексты, ESLint, Prettier, сборка
    sh bin/format.sh     # исправить стиль и форматирование

Backend — FastAPI и SQLite. Слои `api → flows → roles → models → storage → domain`, импорты только вниз, это
проверяет `backend/tests/test_architecture.py`. Инструкции моделей — `backend/lab/roles/prompts/`.
Frontend — React, Vite, TanStack Query, Tailwind. По папке на раздел в `frontend/src/sections/`.

Проход на настоящих модели и агенте, когда Lab запущен:

    python3 bin/real_pass.py --export выгрузка.xlsx --rules правила.docx

Насколько модель-судья согласна с ответами людей:

    uv run --directory backend python -m lab.eval judge

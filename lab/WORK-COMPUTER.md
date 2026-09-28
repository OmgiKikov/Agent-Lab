# Agent Lab на рабочем компьютере

Продовая ручка и шлюз моделей банка доступны только из контура. Здесь можно прогнать всё:
оценку логов, сборку сценариев и прогон на продовом агенте. Интерфейс (Raindrop Workshop) остаётся
на маке: файл прогона переносится туда и открывается кнопкой «импорт прогона».

## 1. Установка

Нужен Python 3.10+.

    cd agent-lab-work-kit
    python3 -m venv .venv
    .venv/bin/pip install httpx

## 2. Сертификаты: шлюз моделей для судьи и симулятора

Те же настройки, что в старом Agent Lab: `~/.agent-lab/gateway.json` (если он уже есть — ничего делать не нужно)
или переменные `AGENT_LAB_GATEWAY_URL`, `AGENT_LAB_GATEWAY_CERT_PATH`, `AGENT_LAB_GATEWAY_KEY_PATH`,
`AGENT_LAB_GATEWAY_CA_PATH`. Новая настройка:

    .venv/bin/python -m lab gateway --url https://<шлюз>/v2 --cert ~/certs/client.pem --key ~/certs/client.key --ca ~/certs/root.pem

Команда сохраняет только пути (не содержимое ключа), проверяет связь и печатает каталог моделей.
Выберите модели — судья и второй судья должны быть разных вендоров:

    .venv/bin/python -m lab gateway --model <модель судьи> --second-model <модель второго судьи>

## 3. Проверка продовой ручки

    .venv/bin/python -m lab ping --target prod

Печатает запрос (ровно как в curl) и сырой ответ; в конце — что Lab из него прочитал.
Адрес лежит в `lab/data/targets.json`, другой — через `LAB_PROD_URL=…`. Если ручке нужен сертификат,
добавьте в `lab/data/targets.json` в раздел `prod`: `"cert": "…pem", "key": "…key", "ca": "…pem"`.

## 4. Прогон

    .venv/bin/python -m lab run --target prod --repeats 2

Нет доступа к шлюзу моделей — тогда только первые реплики клиентов из логов, оценка на маке при импорте:

    .venv/bin/python -m lab run --target prod --judge-later

Можно и заново: `python -m lab discover --count 100` (оценка логов), `python -m lab cards` (сценарии).

## 5. На мак

Файл прогона — в `lab/data/runs/`. Перенесите его на мак: Workshop → agent lab → «прогнали на агенте» →
«импорт прогона». Разговоры появятся в Workshop, прогон — в истории точности.

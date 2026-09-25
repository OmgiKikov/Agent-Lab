# Демо Agent Lab: локальный агент и HTTP-агент в рабочем контуре

## Здесь, до переноса

Из корня Agent Lab:

```bash
npm ci
npm run build
node examples/scenario-lab-demo.mjs --verify
```

Последняя команда проверяет полный бесплатный путь: подготовка из двух логов, решение владельца, запуск сломанной версии, повтор после исправления и сравнение. Это учебный адаптер, а не измерение качества эквайрингового агента.

Локальный эквайринговый агент запускается через `.agent-lab/connection.local.json`. Убедитесь, что работают `http://127.0.0.1:8080/health` и заглушки на `127.0.0.1:8090`, затем прогоните короткий сохранённый набор:

```bash
node dist/cli.js evaluate \
  --input .evals/acquiring-no-redirect-after-not-found.json \
  --connection .agent-lab/connection.local.json \
  --data-dir .agent-lab/demo-local \
  --parallel 1 --yes
```

Для полного набора замените `--input` на `.evals/acquiring-validation-15.json` и выберите новую папку `--data-dir`. Код выхода `1` означает, что агент не прошёл измеренные ситуации; `2` — что измерение неполно. Оба случая сохраняют отчёт и разговоры в указанной папке.

## На рабочем компьютере: прямой HTTP

Нужны Node.js 22.19+, этот репозиторий, доступ к HTTP-адресу и модель судьи/клиента в Pi. Файлы `.evals/acquiring-no-redirect-after-not-found.json` и `.evals/acquiring-validation-15.json` **не входят в Git**: они содержат исходные разговоры. Перенесите их в `.evals/` на рабочем компьютере разрешённым внутренним способом. Не кладите эти файлы в публичный репозиторий.

```bash
npm ci
npm run build
mkdir -p .agent-lab/production-demo
cp examples/acquiring-production.connection.json .agent-lab/production-demo/connection.json
node dist/cli.js doctor \
  --connection .agent-lab/production-demo/connection.json \
  --data-dir .agent-lab/production-demo --yes
```

Первый `doctor` отправляет одно безопасное пробное сообщение и показывает **только пути и длины строк** ответа. Код выхода `2` на этом шаге ожидаем: Lab ещё не знает, где в JSON лежит текст агента. Возьмите путь к ответу из вывода, например `/result/answer/text`, и проверьте два хода в одном разговоре:

```bash
node dist/cli.js doctor \
  --connection .agent-lab/production-demo/connection.json \
  --reply /ПУТЬ/К/ТЕКСТУ \
  --data-dir .agent-lab/production-demo --yes
```

Успешный второй `doctor` сохраняет путь в копии подключения. Lab посылает новый `Request-Id` и время без миллисекунд при каждом запросе. `message.conversation_id` и `metadata.dialog.dialog_id` одинаковы во всём разговоре; следующая ситуация получает новый ID.

Если для ответов нужен профиль тестового клиента (номер терминала, ИНН и т. п.), заполните `target.customerProfile` **в копии** `.agent-lab/production-demo/connection.json`, например `[ { "label": "номер терминала", "value": "ТЕСТОВЫЙ_НОМЕР" } ]`. Берите реальные тестовые значения рабочего контура; не добавляйте их в пример подключения. Без этих данных часть диалогов может остаться неизмеренной, когда агент обоснованно попросит идентификатор.

Потом сначала короткий прогон, затем полный:

```bash
node dist/cli.js evaluate \
  --input .evals/acquiring-no-redirect-after-not-found.json \
  --connection .agent-lab/production-demo/connection.json \
  --data-dir .agent-lab/production-demo/smoke \
  --parallel 1 --yes

node dist/cli.js evaluate \
  --input .evals/acquiring-validation-15.json \
  --connection .agent-lab/production-demo/connection.json \
  --data-dir .agent-lab/production-demo/full \
  --parallel 1 --yes
```

Каждый `evaluate` выводит пути к HTML/Markdown/JSON-отчётам. Сохраните HTML для показа. HTTP-подключение видит ответ агента, но не его внутренние вызовы инструментов и состояние базы. Эти два набора оценивают ответы. Если понадобится проверять реальные вызовы и записи, рабочему агенту нужен отдельный адаптер с трассой, как у локального `aigw-local`.

Если `doctor` вернёт не JSON, ошибку авторизации или ответ без текстового поля, не запускайте полный набор: сначала исправьте формат подключения по фактическому ответу. Адрес из примера с этого ноутбука недоступен, поэтому проверка самого рабочего контура возможна только там.

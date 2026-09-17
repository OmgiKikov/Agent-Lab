# ТЗ: живая проверка провайдера `giga` на внутреннем шлюзе

## Роль и цель

Ты — локальный ассистент на машине, у которой есть сетевой доступ к внутреннему шлюзу моделей и
клиентские mTLS-сертификаты. Задача — прогнать живые проверки провайдера `giga` в Agent Lab на
нескольких моделях и написать отчёт.

Результат работы — отчёт, а не правки. Код не менять, ничего не коммитить и не пушить.

## Что уже известно — не перепроверять

- Аутентификация — только клиентский сертификат: без токена и без заголовка `Authorization`.
- Чат — `POST {base}/v2/chat/completions`, каталог моделей — `GET {base}/v1/models`, префикса `/api` нет.
- Юнит-тесты (249) проходят. Оба живых скрипта прогнаны против локального фейкового шлюза с
  обязательным клиентским сертификатом и работают.

Живьём на настоящем шлюзе ещё **не** проверено — ради этого и нужен прогон:

- принимает ли шлюз `temperature: 0` (судья шлёт его всегда);
- строгая схема ответа судьи (`model_options.response_format`);
- tool calling: объявление инструментов, вызов функции и возврат результата с эхом `tools_state_id`;
- поведение сторонних семейств за тем же шлюзом (DeepSeek, Qwen, GLM).

## Правила безопасности — обязательно

1. Не выводи в консоль, отчёт и файлы содержимое сертификата и ключа.
2. Не записывай в файлы репозитория адрес шлюза, пути к сертификатам и логин пользователя: репозиторий
   публичный. В отчёте используй плейсхолдеры `<хост шлюза>`, `<путь к сертификату>`.
3. Не коммить, не пушь, не меняй `src/` и `test/`. Нашёл дефект — опиши его с воспроизведением.
4. `GIGACHAT_INSECURE=1` — только если шаг 3 показал, что без флага не работает.
5. Бюджет: каждую команду на каждую модель запускай один раз. Повтор — только после сетевого сбоя и не
   больше одного.

## Подготовка

Адрес шлюза и пути к сертификату и ключу возьми у пользователя. В файлы их не записывай.

```bash
git fetch origin
git checkout probe/gigachat-mtls-contract
git pull
git log --oneline -3
npm install
export GIGACHAT_URL=https://<хост шлюза>/v1
export GIGACHAT_CERT_PATH=<путь к сертификату>
export GIGACHAT_KEY_PATH=<путь к ключу>
export GIGACHAT_INSECURE=1
```

В `git log` должны быть коммиты `test: живая проверка tool calling sandbox-агента на выбранной модели`
и тот, что добавил этот файл.

## Шаги

### Шаг 1. Юнит-тесты

```bash
npm test
```

Ожидается `# pass 249` и `# fail 0`. Если что-то падает — остановись и отчитайся: живые проверки на
сломанной сборке ничего не покажут.

### Шаг 2. Каталог моделей

```bash
node dist/cli.js status
```

Ожидается: в `models` есть записи с `"provider": "giga"`, среди них `GigaChat-3-*`, `DeepSeek-*`,
`Qwen*`, `glm-5.2`. Записей `Embeddings*`, `SaluteEmbeddings*`, `GigaEmbeddings*`, `GigaFilter` быть
не должно.

Если моделей `giga` нет, в stderr будет строка `giga: каталог моделей недоступен (<причина>)`. Запиши
причину, найди её в разделе «Разбор ошибок» и дальше не иди.

Выпиши точные id моделей для матрицы.

### Шаг 3. Проверка сертификата шлюза без `INSECURE`

```bash
env -u GIGACHAT_INSECURE node dist/cli.js status
```

Запиши, находятся ли модели `giga` без флага. Причины `connection UNABLE_TO_VERIFY_LEAF_SIGNATURE`,
`connection SELF_SIGNED_CERT_IN_CHAIN` или `connection DEPTH_ZERO_SELF_SIGNED_CERT` ожидаемы: CA-цепочки
шлюза нет. В этом случае продолжай с `GIGACHAT_INSECURE=1`.

### Шаг 4. Симулятор и судья — на каждую модель матрицы

```bash
node --import tsx test/live/simulator-stop.ts giga <id модели>
```

До 16 вызовов модели. Скрипт печатает строку JSON на каждую ситуацию. Строки `judge stopping …` — это
судья со строгой схемой.

Проверка пройдена, если последняя строка — JSON с полем `"passed"` и код выхода 0. При падении `assert`
запиши имя ситуации и сообщение.

### Шаг 5. Tool calling sandbox-агента — на каждую модель матрицы

```bash
node --import tsx test/live/sandbox-tool-call.ts giga <id модели>
```

До 12 вызовов модели. Две строки — сценарии «чтение записи» и «запись с ответом после результата» —
и итоговая строка.

Проверка пройдена, если в обеих строках `"ok": true` и код выхода 0. При провале сохрани `error`,
`toolSequence` и `trace`: `trace` заканчивается на раунде, который отверг шлюз.

### Матрица моделей

Шаги 4 и 5 выполни для каждой модели:

| Семейство | Модель |
| --- | --- |
| GigaChat 3 | `GigaChat-3-Pro` |
| DeepSeek | `DeepSeek-v4-Flash` |
| Qwen | `Qwen3.6-35b` |
| GLM | `glm-5.2` |

Если id нет в каталоге из шага 2, возьми ближайшую модель того же семейства и отметь замену в отчёте.

Начни с `GigaChat-3-Pro`. Если на ней шаг 4 падает целиком из-за сети или доступа, остановись и
отчитайся — не трать бюджет на остальные модели.

Расхождения между семействами ожидаемы. Это результат проверки, а не повод чинить код.

## Диагностика провала через `curl`

Скрипты сворачивают ответ шлюза в общую ошибку (`Pi provider response incomplete: …`) без HTTP-кода.
Чтобы понять, что именно отвергает шлюз, повтори минимальный запрос через `curl` — только для
упавшего шага и модели. Флаг `-k` нужен, только если работаешь с `GIGACHAT_INSECURE=1`.

Тело запроса положи во временный файл вне репозитория, например `/tmp/giga-body.json`.

Запрос чата:

```bash
curl -sS -k --cert "$GIGACHAT_CERT_PATH" --key "$GIGACHAT_KEY_PATH" -H 'Content-Type: application/json' -w '\nHTTP %{http_code}\n' -d @/tmp/giga-body.json "${GIGACHAT_URL%/v1}/v2/chat/completions"
```

Запрос каталога:

```bash
curl -sS -k --cert "$GIGACHAT_CERT_PATH" --key "$GIGACHAT_KEY_PATH" -w '\nHTTP %{http_code}\n' "$GIGACHAT_URL/models"
```

Тела запросов чата (подставь id модели):

**(a) `temperature: 0`** — проверка для судьи:

```json
{"model":"<id>","messages":[{"role":"user","content":[{"text":"Say OK"}]}],"model_options":{"temperature":0}}
```

**(b) строгая схема** — проверка для судьи:

```json
{"model":"<id>","messages":[{"role":"user","content":[{"text":"Return a JSON object with ok set to true"}]}],"model_options":{"response_format":{"type":"json_schema","strict":true,"schema":{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}}}}
```

**(c) объявление инструмента.** Ожидается ответ с `function_call` и `tool_state_id`:

```json
{"model":"<id>","messages":[{"role":"user","content":[{"text":"What is the status of order A-1024?"}]}],"tools":[{"functions":{"specifications":[{"name":"lookup_record","description":"Read an order record by its ID","parameters":{"type":"object","properties":{"recordId":{"type":"string"}},"required":["recordId"]}}]}}]}
```

**(d) возврат результата инструмента.** Подставь `tool_state_id` из ответа (c); ожидается текстовый
ответ со статусом `packed`:

```json
{"model":"<id>","messages":[{"role":"user","content":[{"text":"What is the status of order A-1024?"}]},{"role":"assistant","tools_state_id":"<tool_state_id из ответа c>","content":[{"function_call":{"name":"lookup_record","arguments":{"recordId":"A-1024"}}}]},{"role":"function","tools_state_id":"<tool_state_id из ответа c>","content":[{"function_result":{"name":"lookup_record","result":"{\"ok\":true,\"record\":{\"status\":\"packed\"}}"}}]}],"tools":[{"functions":{"specifications":[{"name":"lookup_record","description":"Read an order record by its ID","parameters":{"type":"object","properties":{"recordId":{"type":"string"}},"required":["recordId"]}}]}}]}
```

В отчёт запиши HTTP-код и поле `message` из ответа шлюза. Эхо промпта в отчёт не копируй.

## Разбор ошибок

| Что видно | Что это значит | Что делать |
| --- | --- | --- |
| `(bad configuration)` | путь к сертификату или ключу не читается | проверить пути в `GIGACHAT_CERT_PATH` и `GIGACHAT_KEY_PATH` |
| `(connection ENOTFOUND)`, `(connection ECONNREFUSED)` | неверный хост или нет сети до шлюза | проверить `GIGACHAT_URL` и сеть |
| `(connection UNABLE_TO_VERIFY_LEAF_SIGNATURE)` и похожие | нет CA-цепочки шлюза | работать с `GIGACHAT_INSECURE=1` |
| `(connection CERT_HAS_EXPIRED)` | истёк клиентский сертификат | остановиться, записать в отчёт |
| `(HTTP 401)`, `(HTTP 403)` | сертификат не допущен к шлюзу | остановиться, записать в отчёт |
| `(timeout or aborted)` | шлюз не ответил на запрос каталога за 10 секунд | повторить один раз |
| `(bad JSON)`, `(empty catalog)` | шлюз вернул не каталог | запрос каталога через `curl`, HTTP-код в отчёт |
| `Выбранная модель недоступна: giga/<id>` | такого id нет в каталоге | взять id из шага 2 |
| `Giga gateway reported an unrecognized finish reason: <X>` | модель вернула незнакомую причину остановки, например срабатывание фильтра | записать `X` в отчёт: это важные данные |
| шаг 5: `Pi provider response incomplete`, `trace` пустой | шлюз не принял объявление инструментов | `curl` с телом (c) |
| шаг 5: `Pi provider response incomplete`, `trace` кончается после `tool_result` | шлюз отверг результат инструмента или эхо `tools_state_id` | `curl` с телами (c) и (d) |
| шаг 4: падают строки `judge stopping …` | судья не справился со схемой или шлюз не принял `temperature: 0` | `curl` с телами (a) и (b) |

## Отчёт

Сохрани в `.context/giga-live-report.md`: каталог `.context/` не попадает в git.

1. **Окружение:** вывод `git log --oneline -1`; находятся ли модели `giga` без `GIGACHAT_INSECURE`.
2. **Каталог:** сколько моделей `giga` и какие id фактически взяты в матрицу.
3. **Сводная таблица:** строки — модели, столбцы — «Симулятор», «Судья», «Tool calling: чтение»,
   «Tool calling: запись». Значения — ✅ или ❌ с короткой причиной.
4. **По каждому ❌:** команда, `error`, конец `trace`, результат `curl` (HTTP-код и `message`).
5. **Незнакомые `finish_reason`,** если встретились, — с моделью, на которой.
6. **Вывод:** что работает, что заблокировано и чем, что предлагаешь сделать дальше. Предложения —
   словами, без патчей.

В отчёте не должно быть адреса шлюза, путей к файлам и содержимого сертификатов.

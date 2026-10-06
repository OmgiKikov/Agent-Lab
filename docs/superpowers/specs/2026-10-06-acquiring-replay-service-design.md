# Сервис повтора агента эквайринга на стенде: спека

Дата: 6 октября 2026. Продолжение `2026-10-05-voice360-replay-design.md`. Спека заменяет её сторону агента (§2.2:
трейсы в памяти, `GET /local/agent-lab/trace/{id}`) и снимает отказ для нелокального агента. Режим повтора
(«дословно + история из лога»), семьи критериев и метрика остаются как были.

Рамка: оцениваем только RAG. Банковские системы (SBE) не оцениваем. Деплой не делаем: отдаём образ и описание
конфигурации.

## 1. Что не так сейчас

- Повтор работает только с агентом на том же компьютере, что и Lab (`replay.py:39`, `NOT_LOCAL`).
- Агент на рабочем стенде (`setup-work-stand.sh`) пишет во внешние системы:
  - SBE `MakeReqToSM2` создаёт сервисную заявку, `acquiringSettlements` заказывает отчёт;
  - фоновые логи уходят в Elastic `internal_logs`, Excel-лог включён.
  
  Флагом из этого отключается только Postgres (`AGENT_LAB_NO_DB`).
- Трейсы хранятся в памяти процесса и забираются отдельным запросом. Если реплик или воркеров больше одного, трейсы
  теряются. `/local/...` открыт без авторизации рядом с боевым эндпоинтом агента.
- В трейсе нет того, что нужно для оценки RAG:
  - полного запроса в IDP (индексы, эмбеддер, reranker, top_k);
  - упавших и отменённых вызовов IDP;
  - ответов из кэша IDP;
  - ответов SBE;
  - общего порядка событий.
- Агент ведёт себя не как прод. Прогрев кэша IDP выключен флагом `LOCAL`. Промпты берутся из кода, а не из MLS. В
  `src/` есть экспериментальная собственная генерация (`IDP_OWN_GENERATION_ENABLED`) и хук `x-trace-id`.
- Продовый ответ из лога (`prodReply`) показан в UI, но в Judge не уходит.

## 2. Решение

Отдельный сервис повтора: снимок агента + пакет `replay/` в aigw-local. Он поднимается на стенде рядом с Lab. Наружу
открыты два эндпоинта. Всё, что не нужно для ответа агента, выключено до старта приложения.

```
Lab (conductor-playground)                      Стенд: acquiring-replay (1 контейнер)
┌───────────────────────────┐   POST /replay/turn   ┌──────────────────────────────────────┐
│ replay.py                 │ ────────────────────▶ │ replay/app.py      — точка входа     │
│ agents/ target            │ ◀──────────────────── │   ├ isolation.py   — выключает лишнее│
│   replay-service          │   {agent, trace}      │   ├ recorder.py    — трейс запроса   │
│ judge.step_verdict        │                       │   ├ sbe_stub.py    — SBE из фикстур  │
│   + prodReply             │                       │   └ api.py         — /replay/turn,   │
└───────────────────────────┘                       │                      /health         │
                                                    │ src/ — снимок агента без правок      │
                                                    └───┬──────────┬──────────┬────────────┘
                                                        ▼          ▼          ▼
                                                     GigaChat     IDP     MLS (чтение)
```

### 2.1 Код агента

- **Снимок.** `src/` совпадает с коммитом `2bf2e31` («vendor: pristine copy of aigw acquiring agent»). Код агента
  не обновляем: работаем с этим снимком.
- **Откатываем из `src/`:**
  - `IDP_OWN_GENERATION_ENABLED` (4309fc0, 2bad6b2, f819340). Эксперимент меняет то поведение, которое мы оцениваем.
  - Правки 123bd6f: хук `x-trace-id` в `context.py` (переезжает в `recorder.py`) и `parse_date_ymd` в
    `common_utils.py`. Ошибку даты не чиним и патчем: в проде она есть, а повтор должен вести себя как прод.
- **Остаётся в `local/`:**
  - моки (`mocks/server.py`, фикстуры, `kb/`) для тестов и работы без сети банка;
  - `agent_lab_target.py`, `langwatch_target.py`.
  
  Память board (`agent_lab_memory_db.py`) и запись трейса (`agent_lab_trace.py`) переезжают из `local/` в `replay/`,
  чтобы знание жило в одном месте. `local/agent_lab_app.py` импортирует их оттуда и по-прежнему сам хранит трейсы
  для `GET /local/agent-lab/trace/{id}`: локальные target `local-http` и `local-code` продолжают работать.

### 2.2 Изоляция (`replay/isolation.py`)

Каждое отключение — отдельная функция с именем. `apply()` вызывает их до импорта приложения агента. Список
отключений отдаёт `/health → isolation`.

| Побочный эффект | Как выключаем |
|---|---|
| Postgres: board, `surface_cache`, очистка по cron | память board из `agent_lab_memory_db`; записи живут 30 минут, как `CACHE_TTL_SEC` в проде |
| SBE: чтения и записи (`MakeReqToSM2`, заказ отчёта) | `httpx.MockTransport` на `sbe_client` и `sbe_tool_client`; ответы из `local/mocks/fixtures/sbe.json`, на неизвестный инструмент 204, как у мока |
| Elastic `internal_logs` | подключение заменяется на no-op |
| Excel-лог | `EXCEL_LOGS=False` |
| AEF / Kafka | `AEF_ENABLED=False` |
| Scheduler, PerformanceMonitor, ежедневное обновление кэша IDP | не запускаем: своя точка входа без lifespan агента |
| like/dislike, `/info`, бизнес-эндпоинты агента | не монтируем |

Включаем, чтобы агент вёл себя как прод:

- **Кэш IDP.** Патчим проверку `local` в `idp_cache_service.create` (`idp_cache_service.py:169`) и прогреваем кэш на
  старте. Кэш живёт в памяти, прогрев только читает IDP и GigaChat. В снимке прогрев падает на `KeyError`
  (`business_channel_enrichment`, см. `LOCAL.md`). С продовыми промптами из MLS ошибки может не быть. Результат
  прогрева виден в `/health`.
- **Промпты из MLS.** Настоящий `mls_client_lib`, только чтение, версия из `MLS_CLIENT_PROMPTS_VERSION`.

Тихих откатов нет. Если MLS недоступен или вернул не ту версию, сервис стоит в `ready=false`. Промпты из кода не
подставляются.

Наружу ходим только в GigaChat, IDP и MLS.

### 2.3 Контракт

**`POST /replay/turn`.** Тело — родной запрос агента в формате aigw-rest-service, который Lab уже собирает
(`agents/http.py`, `local_request`): `content.phrases[]`, `trigger_phrase_id`, `conversation_id`,
`sender=GIGAASSISTANT`. Заголовки `x-trace-id`, `x-client-id`, `x-session-id` и `x-request-time` сервис ставит сам.
Агент вызывается внутри процесса: `httpx.ASGITransport` в его приложение `app_main` на путь
`/api/v1/ai/agents/agent-ckr-pa-acquiring`. Lifespan агента (Postgres, scheduler, Elastic) при этом не запускается.

Ответ `200`:

```json
{
  "agent": {"status": 200, "body": {"...": "родной ответ агента"}},
  "seconds": 7.4,
  "trace": {
    "chains":  [{"seq": 1, "name": "idp_input_chain", "messages": [], "output": "", "seconds": 1.2}],
    "rag":     [{"seq": 2, "source": "idp", "status": "ok",
                 "request": {"...": "тело запроса в IDP целиком"},
                 "query": "", "filter": "", "systemPrompt": "",
                 "passages": [{"article": "", "passage": 0, "text": "", "retrieval": 0.0, "reranker": 0.0}],
                 "answer": "", "reason": "", "seconds": 3.1}],
    "systems": [{"seq": 3, "tool": "fetch_terminal_list", "arguments": {}, "status": "stubbed",
                 "response": {}}]
  }
}
```

- `rag[].source`: `idp` или `cache`. Ответ из кэша IDP — тоже обращение к базе знаний. У записи из кэша `request`
  пустой, `passages` — один фрагмент с текстом документа из кэша, `answer` — готовый ответ из кэша.
- `rag[].status`: `ok`, `error`, `timeout` или `cancelled`. Последний — фоновая задача IDP, отменённая после ответа
  агента (`router.py:238-248`).
- `seq` — общий порядок событий по трём спискам внутри запроса.
- `systems[].response` — ответ заглушки SBE. Без него Judge сочтёт данные терминала выдумкой агента.
- Тексты обрезаются до 20 000 знаков, как сейчас.

`503` — сервис не готов (`ready=false`). `400` — тело не JSON-объект. Всё, что вернул агент, включая его ошибки
валидации, 5xx и 202-7, — это ответ агента: `200` и `agent.status` как есть.

**`GET /health`:**

```json
{"ready": true,
 "prompts": {"version": "<MLS_CLIENT_PROMPTS_VERSION>", "hashes": {"agent_doc_type_prompt.json": "<sha256>"}},
 "idpCache": {"total": 12, "warmed": 12, "failed": []},
 "isolation": ["db:memory", "sbe:stub", "elastic:off", "excel:off", "aef:off", "scheduler:off"],
 "problems": []}
```

`problems` — почему сервис не готов, словами. Пока идёт прогрев кэша, `ready=false`.

Всё состояние сервиса ограничено запросом или `conversation_id` (board). Трейс собирается по `x-trace-id`, который
сервис сам ставит запросу, и забирается из памяти сразу после ответа агента. Одной реплики с одним
воркером хватает для 4 диалогов параллельно, как шлёт Lab.

### 2.4 Lab

- **Target `replay-service`** (`agents/replay_service.py`). URL берётся из `LAB_REPLAY_URL`.
  - Виден только на странице «Повтор разговоров» (`/api/state → replayTargets`), а не среди способов подключения
    агента: разговаривать с ним нельзя.
  - Перед стартом повтора Lab спрашивает `GET /health`. При `ready: false` повтор не стартует, а `problems`
    показываются как ошибка задачи.
  - Для этого target `replay.py` не отказывает с `NOT_LOCAL`. Захардкоженные `x-client-id` и EPK для него не
    шлются: заголовки ставит сервис.
- **Шаг повтора** (`_play_step`): один вызов `POST /replay/turn`.
  - `reply` разбирается из `agent.body` тем же кодом, что сейчас.
  - `trace` берётся из ответа.
  - В результат повтора пишутся `prompts.version` и `idpCache` из `/health`, снятые перед стартом.
- **Judge** (`judge.step_verdict`):

  ```json
  {"expectations": [],
   "history": [],
   "customerMessage": "",
   "replayReply": {"text": "", "status": 200, "buttons": []},
   "prodReply": "ответ агента из лога Voice360",
   "trace": {"chains": [], "rag": [], "systems": []}}
  ```

  - `agentReply` переименован в `replayReply`, чтобы Judge не путал два ответа. Промпт `JUDGE_REPLAY` говорит, что
    трейс относится к ответу повтора.
  - `rag.for_judge` добавляет к вызовам базы знаний `source` и `status`, к системам банка — `response`. Полный
    `request` в Judge не уходит: в нём промпты, а Judge их не получает и сейчас. `request` хранится в трейсе и виден
    в UI.
  - `rag.called()` уже считает записи из кэша: они лежат в `rag`.
  - Критерий `rag:grounded` разрешает опираться на данные систем банка из `trace.systems`.
- **Критерий `replay:match`** — «Ответ на повторе по смыслу совпадает с ответом в проде». Статусы `PASS`
  («совпадает») и `FAIL` («отличается»), с причиной. Если в логе нет ответа прода, критерий `NOT_APPLICABLE`.
  - Не входит ни в метрику, ни в статус шага, ни в статус второй модели.
  - Показывается у шага под двумя ответами.
  
  По нему видно, объясняет ли трейс повтора ответ прода. RAG-критерии оценивают только ответ повтора по его трейсу.
  Продовый ответ по ним не оценивается.

## 3. Ошибки

| Ситуация | Что происходит |
|---|---|
| `/health` → `ready: false` (MLS, прогрев) | повтор не стартует, причина видна в UI |
| `/replay/turn` → 503 посреди повтора | шаг `UNMEASURED`, диалог продолжается |
| Агент вернул 5xx или 202-7 | это ответ агента, `agent.status` уходит в Judge |
| Вызов IDP упал, отменён или вышел по таймауту | шаг оценивается, Judge видит `rag[].status` |
| Сеть до сервиса или таймаут Lab | шаг `UNMEASURED` |
| Ни один шаг не получил трейс | повтор останавливается (`NO_TRACE`), как сейчас |

## 4. Сборка и конфигурация

- **`Dockerfile.replay`.** Та же база и тот же Nexus, что у `Dockerfile` агента: в образ попадают настоящие
  `mls_client_lib` и `aef_tracing` вместо `local/stubs`. Сверху копируется `replay/`. Запуск:
  `CMD python -m replay.app`.
- **`replay/replay.env.example`.** Без секретов, собран из `local_env`:

  ```
  LOCAL=True
  MLS_CLIENT_ENABLED=True
  MLS_CLIENT_PROMPTS_VERSION="0.0.1"   # как в local_env; подтвердить у команды эквайринга
  IDP_CACHE_ENABLED=True
  EXCEL_LOGS=False
  AEF_ENABLED=False
  ```

  Без `MLS_CLIENT_PROMPTS_VERSION` сервис не становится готовым. Хосты GigaChat, IDP и MLS указываются как в
  `local_env`. Сертификаты монтируются файлами, логины и пароли берутся из
  секретов стенда.
- **`replay/run.sh`.** Запуск без контейнера, на ноутбуке. `setup-work-stand.sh` остаётся для target `local-http`. Если в `.env` хосты
  GigaChat и IDP указывают на `local/mocks/server.py`, сервис работает без сети банка.
- **Что нужно от тех, кто будет деплоить** (скорее всего OpenShift):
  - одна реплика;
  - readiness по `GET /health` → `ready: true`; время прогрева зависит от числа вопросов в `SCHEDULED_IDP_QUERIES`,
    поэтому жёсткого таймаута на старт быть не должно;
  - доступ наружу к GigaChat, IDP и MLS и больше никуда;
  - доступ к сервису только из Lab.

## 5. Тесты

**aigw-local, `replay/tests/`.** Тесты идут против `local/mocks/server.py`, без сети банка.

- **Изоляция.** Диалоги из фикстур проходят через `/replay/turn`. В журнале моков (`/mock/calls`) нет ни одного
  вызова SBE, а других хостов, кроме GigaChat и IDP, нет. В `/health → isolation` есть все отключения из §2.2.
- **Трейс:**
  - `rag[].request` целиком;
  - `source: "cache"` при попадании в кэш;
  - `status: "error"` и `"timeout"`: мок IDP отвечает ошибкой или задерживает ответ;
  - сквозной `seq`;
  - `systems[].response`.
- **Без тихих откатов.** Без MLS `/health` отдаёт `ready: false`, а `/replay/turn` отвечает 503.
- **Снимок не тронут.** `git diff --exit-code 2bf2e31 -- src/`.

**Lab, `backend/tests/`.** Используем Fake-сервис повтора в памяти: он возвращает заданные `{agent, trace}` по тексту
клиента. `mock.patch` не нужен.

- `test_replay_service.py`: сервис не готов (`ready: false`) — повтор не стартует, ошибка называет `problems`; ответ
  `/replay/turn` разбирается в `reply` и `trace`; 503 — ошибка агента.
- `test_replay.py`:
  - повтор на `replay-service` не отказывает с `NOT_LOCAL`;
  - 503 даёт `UNMEASURED`;
  - в результате есть `prompts.version`.
- `test_rag.py`:
  - `source: "cache"` считается обращением к базе знаний;
  - ответ SBE уходит в Judge в `systems[].response`.
- Тесты Judge:
  - в пакете есть `prodReply` и `replayReply`;
  - `replay:match` не входит ни в метрику, ни в статус шага.

## 6. Не делаем

- Оценку SBE-шагов и выбора инструментов.
- Фикстуры SBE, восстановленные из продового ответа.
- Деплой и манифесты стенда.
- Авторизацию на `/replay/turn`. Сервис доступен только из Lab. Если стенд окажется общим, авторизация — первое, что
  добавим.
- Обновление снимка агента.
- Адаптер для других агентов и историю повторов.

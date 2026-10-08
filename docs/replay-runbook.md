# Повтор разговоров: запуск, размещение, проверка

Как поднять «Повтор разговоров» целиком: агент эквайринга отвечает на реплики из настоящих логов, Agent Lab оценивает
каждый шаг, а блок «База знаний» показывает, как отработал RAG. Инструкция для рабочего компьютера в сети банка и
для стенда. Ниже пути и имена файлов, которые проверены в работе.

## 1. Из чего состоит

```
 Agent Lab (conductor-playground)            Сервис повтора (aigw-local, replay/)
 http://127.0.0.1:5899                       http://127.0.0.1:8082
 ┌──────────────────────────────┐            ┌─────────────────────────────────────┐
 │ выгрузка Voice360            │  POST      │ настоящий код агента эквайринга     │
 │ «Повтор разговоров»  ────────┼──────────► │ /replay/turn → ответ + трейс шага   │
 │ судья (GLM через шлюз банка) │  GET       │ /health      → готов ли и почему    │
 │ блок «База знаний»           │ ◄──────────┤                                     │
 └──────────────┬───────────────┘            └───────┬──────────────┬──────────────┘
                │ mTLS                               │ mTLS         │ mTLS
                ▼                                    ▼              ▼
     шлюз моделей банка (GLM)              GigaChat ИФТ        IDP (RAG), dev-terra
```

- **Сервис повтора** — агент эквайринга без побочных эффектов. База в памяти. Системы банка (SBE) отвечают из
  `local/mocks/fixtures/sbe.json`. Elastic, Excel-лог, AEF и scheduler выключены. Настоящие внешние вызовы — только
  GigaChat, IDP и, на стенде, ML Storage. На каждый ход сервис отдаёт трейс: цепочки модели, запрос в IDP и ответ
  IDP, вызовы систем банка.
- **Agent Lab** берёт реплики клиента из выгрузки, по одной отправляет их в сервис повтора и сравнивает ответ повтора
  с ответом прода. Судья оценивает каждый шаг по критериям, в том числе по пяти критериям RAG.

Код:

| Что | Репозиторий | Ветка |
|---|---|---|
| Сервис повтора | `ai-agent-acquiring` (aigw-local), папка `replay/` | `master` |
| Agent Lab | `conductor-playground` | `master` (до слияния PR #44 — `feat/voice360-replay-on-master`) |

## 2. Файловая структура

### 2.1 Агент эквайринга (aigw-local)

На рабочем компьютере репозиторий лежит в `~/Работа/ai-agent-acquiring`:

```
ai-agent-acquiring/
├── .env                        свой файл: копия local_env со своими значениями (в git не попадает)
├── certs/                      в git не попадает
│   ├── gigachat/
│   │   ├── cert.pem            клиентский сертификат для GigaChat ИФТ
│   │   └── private.key         его ключ
│   └── idp/
│       ├── certificate.pem     клиентский сертификат для IDP (выпущен в домене sigma)
│       ├── private_key.key     его ключ
│       └── ca.pem              корневой сертификат банка; агент только проверяет, что файл есть
├── .venv/                      Python-окружение агента
├── local_env                   шаблон .env из git
├── replay/                     сервис повтора
│   ├── run.sh                  запуск на компьютере (127.0.0.1:8082)
│   ├── replay.env.example      значения .env для стенда
│   └── ...
└── Dockerfile.replay           образ сервиса повтора для стенда
```

Имена файлов в `certs/` можно поменять, но тогда пути в `.env` нужно поправить так же (раздел 3.2).

### 2.2 Agent Lab (conductor-playground)

На рабочем компьютере репозиторий лежит в `~/Работа/conductor-playground`:

```
conductor-playground/
├── certs/                      настройки шлюза моделей банка (в git не попадает)
│   ├── url.txt                 адрес шлюза, одна строка, БЕЗ /v1 на конце
│   ├── cert.pem                клиентский сертификат; имя любое, но НЕ на ca… и НЕ на root…
│   ├── private.key             его ключ (.key или .pem с PRIVATE KEY)
│   └── ca.pem                  корневой сертификат банка; имя ОБЯЗАТЕЛЬНО на ca… или root…
├── data/                       данные Lab: SQLite, выгрузки, результаты (в git не попадает)
├── backend/
│   ├── .venv/                  Python-окружение Lab
│   └── requirements.txt        зависимости для установки через pip
└── frontend/
    └── dist/                   собранный интерфейс (npm run build)
```

Lab находит файлы в `certs/` по содержимому и по имени:
- сертификат — файл `.pem`, `.crt` или `.cer` с `BEGIN CERTIFICATE`, имя которого не начинается с `ca` или `root`;
- ключ — файл с `PRIVATE KEY`;
- корневой — сертификат, имя которого начинается с `ca` или `root`.

Вместо пары PEM можно положить один `.p12` или `.pfx` и рядом `password.txt` с паролем от него. Если в `certs/`
нет `url.txt`, шлюз считается ненастроенным.

## 3. Агент и сервис повтора

### 3.1 Окружение

Если `.venv` ещё нет, создайте его через pip: зеркало банка работает, а `uv` в сети банка не проходит TLS.

```bash
cd ~/Работа/ai-agent-acquiring && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

### 3.2 `.env`

Начните с копии шаблона: `cp local_env .env`. Потом поменяйте ключи ниже. Если ключ встречается в `.env` дважды,
действует последнее значение.

```dotenv
LOCAL=True                                  # без него агент не передаёт клиентские сертификаты

# GigaChat ИФТ
GIGA_CHAT_HOST=gigachat-ift.sberdevices.delta.sbrf.ru
GIGA_CHAT_PORT=443
GIGACHAT_TLS_CERT_FILEPATH=./certs/gigachat/cert.pem
GIGACHAT_KEY_FILEPATH=./certs/gigachat/private.key
GIGACHAT_CA_BUNDLE_FILEPATH=./certs/idp/ca.pem

# IDP (RAG): только этот хост принимает сертификат certs/idp
IDP_RAG_HOST=sm.apps.dev-terra000003-ids.ocp.delta.sbrf.ru
IDP_RAG_PORT=443
IDP_ENDPOINT=/sync/skill/universal_search
TLS_CERT_FILEPATH=./certs/idp/certificate.pem
KEY_FILEPATH=./certs/idp/private_key.key

# Индекс и фильтр основной базы знаний
IDP_BASE_EMBEDDER_MODEL="gigachat-3b"
IDP_FILTER_VALUE_MAIN="*Эквайринг*"
IDP_DATA_SOURCE_INDEX_ID_MAIN="1a0cbc8d-5df4-4bb2-abda-b4bdddfd708d_search_usooper_3"

# ML Storage: на рабочем компьютере выключен, промпты берутся из кода (см. 3.3)
MLS_CLIENT_ENABLED=False

MAX_GIGA_REQUESTS_PER_SEC=3
```

**Хост IDP.** Прежний хост `overcast-ift.ingress.ott.apps.dev-gen.delta.sbrf.ru` не доверяет центру, который
выпустил сертификат из домена sigma. На любой запрос он отвечает `TLSV1_ALERT_UNKNOWN_CA`. Хост
`sm.apps.dev-terra000003-ids.ocp.delta.sbrf.ru` тот же сертификат принимает.

Сам сервис повтора поверх `.env` выставляет `AEF_ENABLED=False`, `IDP_CACHE_ENABLED=True` и
`IDP_OWN_GENERATION_ENABLED=False`: ответ генерирует IDP, как в проде. Прописывать их не нужно.

Postgres, Elastic и SBE сервису повтора не нужны. Значения этих ключей в `.env` могут остаться из шаблона.

### 3.3 Запуск

Запускайте в отдельном терминале и не закрывайте его:

```bash
cd ~/Работа/ai-agent-acquiring && REPLAY_ALLOW_CODE_PROMPTS=True bash replay/run.sh
```

- `REPLAY_ALLOW_CODE_PROMPTS=True` нужен, когда `MLS_CLIENT_ENABLED=False`. Без него сервис не станет готовым:
  промпты из кода могут отличаться от прода, и сервис повтора об этом предупреждает. Если ML Storage включён и в
  `.env` есть его учётные данные, флаг не нужен: промпты будут как в проде.
- Порт — `REPLAY_PORT`, по умолчанию 8082. Адрес — `REPLAY_HOST`, по умолчанию 127.0.0.1.
- На старте сервис прогревает кэш IDP по 10 фиксированным вопросам, это 10–30 секунд. Ждите строку
  `Uvicorn running on http://127.0.0.1:8082`.

Проверка готовности:

```bash
curl -s http://127.0.0.1:8082/health
```

В ответе должно быть `"ready": true`, а в `isolation` — `aef:off`, `idp-own-generation:off`, `db:memory`,
`sbe:stub`, `elastic:off`, `excel:off`, `scheduler:off`. Пока сервис не готов, он отвечает 503, и в `problems`
написано почему.

### 3.4 Проверка сертификатов IDP

Если на шагах повтора появляется «недоступна: IDP», проверьте хост и сертификат. Команда отправляет в IDP пустой
запрос с сертификатом из `.env`:

```bash
cd ~/Работа/ai-agent-acquiring && v() { grep "^$1=" .env | tail -1 | cut -d= -f2- | tr -d "\"' "; }; URL="https://$(v IDP_RAG_HOST):$(v IDP_RAG_PORT)$(v IDP_ENDPOINT)"; echo "$URL"; curl -sS -k --connect-timeout 5 -m 20 -o /dev/null -w 'HTTP %{http_code}\n' --cert certs/idp/certificate.pem --key certs/idp/private_key.key -H 'Content-Type: application/json' -d '{}' "$URL"
```

| Ответ | Что значит |
|---|---|
| `HTTP 422` | всё в порядке: сертификат принят, IDP ругается на пустое тело |
| `unknown ca`, `HTTP 000` | хост не принимает сертификат: проверьте `IDP_RAG_HOST` |
| `Connection timed out` | до хоста нет сети |

## 4. Agent Lab

### 4.1 Установка на рабочем компьютере

Python-зависимости ставьте через pip, без `uv`:

```bash
cd ~/Работа/conductor-playground && /usr/local/bin/python3 -m venv backend/.venv && backend/.venv/bin/pip install -r backend/requirements.txt
```

npm ходит через зеркало sberosc. В `~/.npmrc` нужен токен из профиля sberosc в виде BASE64. Команда спросит его и
не покажет на экране. Токен вводите сами, никому его не пересылайте:

```bash
cp ~/.npmrc ~/.npmrc.before-sberosc 2>/dev/null; printf 'BASE64 токена sberosc: '; read -rs B64; echo; printf '//sberosc.sigma.sbrf.ru/repo/npm/:_authToken=%s\nregistry=https://sberosc.sigma.sbrf.ru/repo/npm/\naudit=false\nalways-auth=true\nfetch-retries=5\nstrict-ssl=false\n' "$B64" > ~/.npmrc && unset B64 && npm ping
```

Сборка интерфейса. Подходит Node.js 22.13 или новее. Пересобирайте после каждого `git pull`:

```bash
cd ~/Работа/conductor-playground && npm --prefix frontend ci && npm --prefix frontend run build
```

### 4.2 Шлюз моделей

Положите файлы в `certs/`, как в разделе 2.2. В `url.txt` должен быть адрес без `/v1`. Проверьте, что шлюз отдаёт
каталог моделей и что в нём есть GLM:

```bash
cd ~/Работа/conductor-playground/certs && curl -s --cert cert.pem --key private.key --cacert ca.pem "$(head -1 url.txt)/v1/models"
```

Если `LAB_MODEL` не задан, Lab сам выбирает самую новую GLM из каталога.

### 4.3 Запуск

Запускайте во втором терминале и не закрывайте его:

```bash
cd ~/Работа/conductor-playground/backend && LAB_REPLAY_URL=http://127.0.0.1:8082 .venv/bin/python -m uvicorn lab.app:create --factory --host 127.0.0.1 --port 5899
```

Чтобы задать модель явно, добавьте перед командой `LAB_MODEL=glm-5.2`, указав id из каталога шлюза. На ноутбуке с
`uv` вместо этой команды работает `LAB_REPLAY_URL=http://127.0.0.1:8082 sh bin/start.sh`.

`LAB_REPLAY_URL` читается один раз при старте. Если адрес сервиса повтора поменялся, перезапустите Lab.

### 4.4 Переменные Lab, которые касаются повтора

| Переменная | Что задаёт | По умолчанию |
|---|---|---|
| `LAB_REPLAY_URL` | адрес сервиса повтора; без него «Сервис повтора на стенде» в списке не появляется | нет |
| `LAB_AGENT_TIMEOUT` | сколько секунд ждать ответа агента на один ход | 180 |
| `LAB_MODEL` | модель судьи | самая новая GLM шлюза |
| `LAB_MODEL_CONCURRENCY` | сколько запросов к судье идёт одновременно | 6 |
| `LAB_DATA` | папка с данными | `data/` |
| `LAB_CERTS` | папка с настройками шлюза | `certs/` |
| `LAB_ALLOWED_HOSTS` | имена, по которым браузер может открыть Lab, кроме 127.0.0.1 и localhost; через запятую | нет |

## 5. Прогон

1. Откройте http://127.0.0.1:5899 и проверьте в «Настройках», что модели идут через шлюз банка и выбрана GLM.
2. Выберите агента эквайринга. Если выгрузки у него ещё нет, загрузите её (`.xlsx` из Voice360 или `.jsonl`).
3. Откройте «Повтор разговоров». В поле «Агент» выберите «Сервис повтора на стенде», в поле «Разговоров» для начала
   поставьте **1–2**.
4. Нажмите «Повторить». Повтор можно остановить: при следующем запуске с теми же настройками он продолжится с уже
   повторённых разговоров.
5. Результат:
   - карточки «Tone of voice» и «Точность»;
   - блок «База знаний»: общая цифра, сколько шагов обращались к базе знаний и сколько из них совпали с продом, пять
     критериев «N из M». Нажмите «▸ N с ошибкой», чтобы увидеть сами шаги;
   - внутри шага: реплика клиента, ответ прода, ответ повтора, трейс (запрос в IDP и его ответ) и оценки.

**Сколько разговоров повторять.** Lab повторяет до 4 разговоров одновременно, и на каждый шаг агент делает 5–14
запросов в GigaChat. Квота GigaChat ИФТ на один сертификат этого не выдерживает: шаги начинают падать с
«недоступна: GIGA» (ответ 429). Для показа берите 1–5 разговоров. Верхний предел одного повтора — 200 разговоров.

## 6. Размещение на сервере

### 6.1 Сервис повтора

Образ собирается из `Dockerfile.replay` в два шага: сначала базовый образ агента с банковскими пакетами, потом сам
сервис.

```bash
docker build --target builder -t aigw-acquiring-builder --build-arg DOCKER_BASE_IMAGE=… --build-arg NEXUS3USER=… --build-arg NEXUS3PASS=… --build-arg OSCTOKENAUTH=… .
```

```bash
docker build -f Dockerfile.replay -t aigw-acquiring-replay .
```

Контейнер:
- **`.env`** — `local_env`, к которому дописан `replay/replay.env.example`
  (`cp local_env .env && cat replay/replay.env.example >> .env`). Значения стенда подставьте в итоговый файл.
  Положите его как **`/opt/app-root/.env`**: агент ищет `.env` от папки установленного пакета вверх, а не от рабочей
  папки. Вместо файла можно передать те же переменные через окружение, они сильнее `.env`.
- **Сертификаты** монтируются файлами по путям из `replay.env.example`:

  ```
  /certs/gigachat/cert.pem       /certs/gigachat/private.key
  /certs/idp/certificate.pem     /certs/idp/private_key.key     /certs/idp/ca.pem
  /certs/mls/ca.pem              корневой для ML Storage
  ```
- **ML Storage включён** (`MLS_CLIENT_ENABLED=True`, логин и пароль берутся из секретов стенда). Тогда промпты такие
  же, как в проде, и `REPLAY_ALLOW_CODE_PROMPTS` не нужен. Версию промптов `MLS_CLIENT_PROMPTS_VERSION` подтвердите у
  команды эквайринга.
- Порт 8080 (`REPLAY_PORT`). Хост по умолчанию `0.0.0.0`.
- Нужна **одна реплика**: трейсы и база разговоров хранятся в памяти процесса.
- Наружу открыт доступ только к GigaChat, IDP и ML Storage.
- **Авторизации у сервиса нет.** В него должен ходить только Agent Lab, закройте его сетью.
- Проверка готовности — `GET /health`: 200, когда сервис готов, и 503, пока нет. Не ставьте жёсткий тайм-аут на
  старт: прогрев кэша IDP занимает время.
- **Перезапускайте раз в сутки.** Кэш IDP прогревается, а база в памяти очищается только на старте. Ночные задачи
  агента выключены вместе со scheduler.

### 6.2 Agent Lab

- Запуск: `uvicorn lab.app:create --factory`. Хост укажите `0.0.0.0` или адрес сервера. В `LAB_ALLOWED_HOSTS`
  перечислите имена, по которым его открывают в браузере. Lab отклоняет запросы с незнакомым `Host` и `Origin`.
- `LAB_REPLAY_URL=http://<сервис повтора>:8080`.
- Папку `data/` положите на постоянный диск: в ней SQLite с агентами, выгрузками и результатами. Запускайте на ней
  один процесс Lab: второй не подхватит долгие задачи, которые прервались.
- `certs/` или переменные `AGENT_LAB_GATEWAY_URL`, `AGENT_LAB_GATEWAY_CERT_PATH`, `AGENT_LAB_GATEWAY_KEY_PATH`,
  `AGENT_LAB_GATEWAY_CA_PATH` — для шлюза моделей.
- Своей авторизации у Lab нет. Открывайте его только в закрытой сети или за прокси с авторизацией.

## 7. Если что-то не так

| Что видно | Причина | Что делать |
|---|---|---|
| «Сервис повтора не готов. Промпты взяты из кода агента…» | ML Storage выключен, флаг не задан | запускать с `REPLAY_ALLOW_CODE_PROMPTS=True` (3.3) |
| «Агент не отдаёт трейс…» | сервис повтора старее `eeb9f52`: на ход без вызовов (приветствие) он отдавал `trace: null` | `git pull` в aigw-local, перезапуск сервиса повтора |
| Шаги «недоступна: GIGA», в логе `429` | превышена квота GigaChat ИФТ | меньше разговоров за раз (раздел 5) |
| Шаги «недоступна: IDP», в логе `TLSV1_ALERT_UNKNOWN_CA` | хост IDP не принимает сертификат | `IDP_RAG_HOST` из 3.2, проверка 3.4 |
| На старте `'business_channel_enrichment'` у 8 из 10 вопросов кэша IDP | в коде агента промпт из кода ждёт переменную, которую прогрев кэша не передаёт; с промптами из ML Storage ошибки, вероятно, нет | на основные запросы в IDP не влияет; на темах из кэша (сверка итогов, тарифы, установка, блокировки, незачисленная выручка) повтор может отличаться от прода |
| `Attribute "create" not found in module "lab.app"` | Lab на старой ветке | `git checkout` нужной ветки (раздел 1), пересобрать интерфейс |
| «Сервис повтора на стенде» нет в поле «Агент» или «Нет агента, который отдаёт трейс» | Lab запущен без `LAB_REPLAY_URL` | перезапустить Lab с переменной |
| `curl` к хосту висит без ответа | в адресе нет порта или нет сети | `--connect-timeout 5 -m 20`, порт из `.env` |

**Логи.** Логи агента пишутся в `~/Работа/ai-agent-acquiring/app.log`, логи Lab — в терминал, где он запущен.
Ошибки IDP и GigaChat за последний прогон можно собрать так:

```bash
grep -aiE "giga|idp|429|503|timeout|ssl|certificate|недоступн" ~/Работа/ai-agent-acquiring/app.log | tail -50
```

## 8. Перед показом

1. `git pull` в обоих репозиториях. В Lab после этого пересоберите интерфейс (4.1).
2. Запустите сервис повтора (3.3) и дождитесь `"ready": true` в `/health`.
3. Проверьте IDP (3.4), должно прийти `HTTP 422`.
4. Запустите Lab (4.3) и посмотрите в «Настройках», что выбрана GLM.
5. Сделайте пробный повтор на 1 разговор. Блок «База знаний» должен показать шаги с обращением к базе знаний.

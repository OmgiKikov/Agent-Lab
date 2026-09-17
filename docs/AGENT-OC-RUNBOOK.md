# SkillAgent из agent_oc: карточки из логов и end2end

Как проверить SkillAgent (репозиторий `agent_oc`) этим Agent Lab на моделях внутреннего шлюза
`glm-5.2` и `GigaChat-3-Ultra`. Репозиторий агента не меняется: всё нужное лежит здесь.

| Файл | Роль |
|---|---|
| [examples/agent-oc-dialogues.py](../examples/agent-oc-dialogues.py) | прод-разметка `.xlsx` → диалоги в схеме Agent Lab |
| [examples/agent-oc-adapter.py](../examples/agent-oc-adapter.py) | испытуемый: контракт `kind: "command"` поверх `harness_core.run_turn` |
| [examples/agent-oc-materials.py](../examples/agent-oc-materials.py) | реестр скиллов агента → готовый вход `build --input` |

## Разговорный путь (обычный)

Штатный способ — разговор в каталоге агента: Agent Lab сам читает проект, готовит подключение и
карточки и показывает план прогона на подтверждение.

```bash
conda activate agent_oc
cd ../agent_oc
node ../conductor-playground/dist/cli.js chat
```

Дальше своими словами: какой агент проверяем, где его прод-путь (`src/tests/harness_core.py::run_turn`),
что готовый адаптер лежит в `../conductor-playground/examples/agent-oc-adapter.py`, какая поверхность,
полномочия и ЕПК, и что диалоги для карточек — в подготовленном `dialogues.jsonl`.

Модели шлюза доступны и в самом разговоре: расширение регистрирует провайдера `giga` при старте,
если заданы переменные шлюза. Выберите `giga/glm-5.2` или `giga/GigaChat-3-Ultra` в Pi. Без этой
регистрации внешний разговор — обычный Pi, и он отвечает «no api key».

Логи в `.xlsx` разговор прочитать не может, поэтому `dialogues.jsonl` готовится скриптом заранее
(ниже). Реестр скиллов в этом пути не нужен: материалы Agent Lab соберёт сам, читая проект.
В этом режиме каталог `.agent-lab/` появится в `agent_oc`, где он не в `.gitignore`.

Ниже — тот же путь командами, если разговор не нужен.

## Откуда запускать

Все команды — из каталога `conductor-playground`, при активированном окружении agent_oc. Здесь
лежат `dist/cli.js` и скрипты, а `.agent-lab/` уже в `.gitignore`, так что артефакты прогонов не
засоряют репозиторий агента (в agent_oc этот каталог не игнорируется). Другой каталог для
артефактов выбирается флагом `--data-dir`.

Пути в `connection.json` считаются от каталога самого файла, а `args` передаются процессу как есть
и считаются от его `cwd`. Если оба репозитория лежат рядом, `connection.json` в
`conductor-playground` выглядит так:

```json
{
  "target": {
    "kind": "command",
    "command": "python",
    "args": ["../conductor-playground/examples/agent-oc-adapter.py", "."],
    "cwd": "../agent_oc",
    "timeoutMs": 180000
  }
}
```

`cwd` — относительно `connection.json`, а путь к адаптеру и аргумент с корнем agent_oc —
относительно `cwd`, то есть уже изнутри agent_oc. Абсолютные пути работают везде и читаются проще,
если репозитории лежат не рядом.

## Окружение

Переменные agent_oc живут в его conda-окружении, а не только в `.env`. Активируйте окружение один
раз и запускайте оттуда всё — и Agent Lab, и прогоны:

```bash
conda activate agent_oc
```

Этого достаточно: Agent Lab запускает испытуемого дочерним процессом с собственным окружением,
поэтому переменные доходят до адаптера сами, а `python` в подключении разрешается в интерпретатор
активированного окружения.

Важно, что переменные conda применяются **при активации**, а не самим путём к интерпретатору:
запуск `~/miniconda3/envs/agent_oc/bin/python` в обход `conda activate` окружения не получит. Если
активировать нельзя, вызывайте через `conda run` и обязательно с `--no-capture-output`, иначе он
буферизует stdout и протокол JSON-строк рвётся:

```json
{ "command": "conda",
  "args": ["run", "-n", "agent_oc", "--no-capture-output", "python",
           "/путь/conductor-playground/examples/agent-oc-adapter.py", "/путь/agent_oc"] }
```

`.env` в корне agent_oc остаётся вторым источником: `bootstrap_environment` подгружает его, но
`load_dotenv` не перекрывает уже заданные переменные — значения conda главнее. Если Agent Lab
запускается вне окружения, тот же файл подхватывается штатным ключом Node:
`node --env-file=../agent_oc/.env dist/cli.js …`.

Провайдер `giga` принимает как свои имена, так и принятые в agent_oc: ключ читается из
`GIGACHAT_KEY_PATH` либо `GIGACHAT_KEY`, цепочка CA — из `GIGACHAT_CA_PATH` либо
`GIGACHAT_VERIFY_PATH`. Отдельного набора переменных для Agent Lab заводить не нужно.

Одна проверка остаётся за вами: `GIGACHAT_URL` в окружении указывает на шлюз, которым пользуется
прод-код агента. Если модели Agent Lab живут на другом адресе, перекройте переменную в команде
(`GIGACHAT_URL=… node dist/cli.js …`).

### ППРБ и ЕПК

ППРБ берётся из того же окружения: `API_PPRB_URL` (договоры РМ ОЦ), `API_PPRB_URL_objectList` и
`API_PPRB_URL_objectList_loc` (объекты и договоры ветки B; при `DEV_MODE=True` работает вариант
`_loc`), `API_PPRB_URL_doc` (закрывающие документы). Сертификаты — `INCASS_CERT_PATH`,
`INCASS_KEY_PATH`, `INCASS_VERIFY_PATH`, а без них клиенты берут
`src/tests/certs/incass/{tls.cer,tls.key,chain.pem}`.

Именно `API_PPRB_URL_doc` даёт `pprb_available` в `bootstrap_environment`, поэтому адаптер при
старте печатает предупреждение ровно тогда, когда эта переменная пуста: без неё `document_lookup`
уходит на пустой адрес и всегда отвечает «недоступно» — маршрут измерится, данные нет. Если
переменная в активированном окружении есть, предупреждения не будет.

ЕПК окружением не передаётся: это свойство конкретного клиента, поэтому оно живёт в карточке —
в записи `session` (см. ниже). Если на инструменте включён список допуска
(`<ПРЕФИКС>_EPK_ID_UL_ALLOW_LIST`, см. `src/app/incass_ckr/tools_access.py`), ваши ЕПК должны быть
в нём, иначе инструмент останется закрытым независимо от полномочий.

Проверка, что доступ поднялся:

```bash
conda activate agent_oc
python examples/agent-oc-adapter.py ../agent_oc < /dev/null
```

Без кавычек намеренно: скопированная из документа строка с `{"type":"close"}` легко приезжает в
терминал с «ёлочками» вместо кавычек, и тогда падает разбор JSON, а не окружение.

## Карточки бизнес-сценариев из логов

```bash
python examples/agent-oc-dialogues.py \
    --input "../agent_oc/data/размеченные логи 1607_2007.xlsx" \
    --output dialogues.jsonl --multi-turn-only --limit 60
```

Рядом появится `dialogues.jsonl.meta.json` — поверхность, полномочия, ЕПК и коды ответов по
каждому диалогу: по ним карточка настраивается на нужный канал и прослеживается до строки
разметки.

Вход для генератора карточек — реестр скиллов агента, иначе он придумает сценарии, которых в
агенте нет. Полные тексты скиллов не годятся: их около 420 000 символов при пределе Agent Lab
в 300 000, и это инструкции модели, а не описание покрытия.

```bash
python examples/agent-oc-materials.py --root ../agent_oc --output task-cards.json
```

В полученном файле заполните `notes` своими вводными про клиентов; модели уже проставлены
(`glm-5.2` симулятором, `GigaChat-3-Ultra` генератором карточек и судьёй).

```bash
node dist/cli.js build --input task-cards.json --dialogues-file dialogues.jsonl > cards-draft.json
node dist/cli.js export --id RUN_ID --format markdown --output cards.md
```

Артефакт — карточки с `provenance: "production"`, дословными первыми репликами клиентов,
наблюдёнными профилями и ссылками на `id` диалогов-доказательств.

## End2end

`connection.json` — см. «Откуда запускать»; в записи полезно сохранить версию испытуемого:

```json
{ "targetVersion": "<git rev-parse --short HEAD в agent_oc>" }
```

Канал задаётся в карточке записью `session` — адаптер читает из неё поверхность, полномочия и ЕПК:

```json
{
  "initialState": {
    "records": { "session": { "surface": "GIGAASSISTANT", "authority": "3",
                              "epk_ul": "<ЕПК ЮЛ>", "epk_fl": "<ЕПК ФЛ>" } },
    "writableFields": [], "transientFailures": 0
  }
}
```

Адаптер возвращает в `records.result` код ответа и его источник, поэтому ожидание разметки
проверяется объективно, а не мнением судьи:

```json
{ "id": "code", "kind": "state_equals", "description": "Код ответа совпал с разметкой",
  "recordId": "result", "field": "status_code", "value": "202-5" }
```

Маршрут агента виден событиями инструментов `read` (какая инструкция открыта, какая ветка
выбрана) и `execute_action` (действие, аргументы, статус) — на них работают `tool_called` и
`tool_count`.

```bash
node dist/cli.js build --input task-e2e.json --connection connection.json > draft.json
node dist/cli.js run --id RUN_ID --yes
node dist/cli.js export --id RUN_ID --format html --output report.html
```

Артефакты: `report.html`, `.agent-lab/RUN_ID.json`, `.agent-lab/RUN_ID.trace.jsonl` — диалоги,
события маршрута, вердикты судьи по рубрикам с сырыми ответами.

## Границы

- Согласие судьи на этих моделях с человеком не измерялось: на `GigaChat-2-Max` он ставил `pass`
  там, где разметка ждала `fail`. Вердикты предварительные; повторяемость меряет `audit-judge`.
- Симулятор и судья работают на моделях того же шлюза, что и агент: смещение общее.
- `eventsComplete: true` означает полный перечень действий в границах `eventScope`
  (`read`, `execute_action`) — тех, что прод пишет в логгер, а не всех сетевых вызовов.

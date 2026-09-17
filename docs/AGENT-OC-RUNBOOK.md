# SkillAgent из agent_oc: карточки из логов и end2end

Как проверить SkillAgent (репозиторий `agent_oc`) этим Agent Lab на моделях внутреннего шлюза
`glm-5.2` и `GigaChat-3-Ultra`. Репозиторий агента не меняется: всё нужное лежит здесь.

| Файл | Роль |
|---|---|
| [examples/agent-oc-dialogues.py](../examples/agent-oc-dialogues.py) | прод-разметка `.xlsx` → диалоги в схеме Agent Lab |
| [examples/agent-oc-adapter.py](../examples/agent-oc-adapter.py) | испытуемый: контракт `kind: "command"` поверх `harness_core.run_turn` |

## Окружение: один `.env` в agent_oc

Испытуемого поднимает `harness_core.bootstrap_environment` — он сам читает `.env` в корне
`agent_oc`, ставит `DEV_MODE=True`, пути логов и модель. Ему отдельно ничего задавать не нужно.

Agent Lab — отдельный процесс, и переменные шлюза нужны и ему тоже. Тот же файл подхватывается
штатным ключом Node:

```bash
node --env-file=/путь/agent_oc/.env /путь/conductor-playground/dist/cli.js …
```

Провайдер `giga` принимает как свои имена, так и принятые в agent_oc: ключ читается из
`GIGACHAT_KEY_PATH` либо `GIGACHAT_KEY`, цепочка CA — из `GIGACHAT_CA_PATH` либо
`GIGACHAT_VERIFY_PATH`. То есть отдельной правки `.env` для Agent Lab не требуется.

Одна проверка остаётся за вами: `GIGACHAT_URL` в `.env` указывает на шлюз, которым пользуется
прод-код агента. Если модели Agent Lab живут на другом адресе, перекройте переменную в команде
(`GIGACHAT_URL=… node --env-file=…`) — значения из окружения важнее файла.

### ППРБ и ЕПК

ППРБ берётся из того же `.env`: `API_PPRB_URL` (договоры РМ ОЦ), `API_PPRB_URL_objectList` и
`API_PPRB_URL_objectList_loc` (объекты и договоры ветки B; при `DEV_MODE=True` работает вариант
`_loc`), `API_PPRB_URL_doc` (закрывающие документы). Сертификаты — `INCASS_CERT_PATH`,
`INCASS_KEY_PATH`, `INCASS_VERIFY_PATH`, а без них клиенты берут
`src/tests/certs/incass/{tls.cer,tls.key,chain.pem}`.

Именно `API_PPRB_URL_doc` даёт `pprb_available` в `bootstrap_environment`, поэтому адаптер при
старте печатает предупреждение ровно тогда, когда эта переменная пуста: без неё `document_lookup`
уходит на пустой адрес и всегда отвечает «недоступно» — маршрут измерится, данные нет. Если
переменная в `.env` есть, предупреждения не будет.

ЕПК окружением не передаётся: это свойство конкретного клиента, поэтому оно живёт в карточке —
в записи `session` (см. ниже). Если на инструменте включён список допуска
(`<ПРЕФИКС>_EPK_ID_UL_ALLOW_LIST`, см. `src/app/incass_ckr/tools_access.py`), ваши ЕПК должны быть
в нём, иначе инструмент останется закрытым независимо от полномочий.

Проверка, что доступ поднялся:

```bash
echo '{"type":"close"}' | /путь/agent_oc/.venv/bin/python examples/agent-oc-adapter.py /путь/agent_oc
```

## Карточки бизнес-сценариев из логов

```bash
python3 examples/agent-oc-dialogues.py \
    --input "/путь/agent_oc/data/размеченные логи 1607_2007.xlsx" \
    --output dialogues.jsonl --multi-turn-only --limit 60
```

Рядом появится `dialogues.jsonl.meta.json` — поверхность, полномочия, ЕПК и коды ответов по
каждому диалогу: по ним карточка настраивается на нужный канал и прослеживается до строки
разметки.

`task-cards.json`:

```json
{
  "task": "Собрать карточки бизнес-сценариев клиентов инкассации по реальным логам: какие задачи люди приносят, что они знают сами и чем заканчивается разговор.",
  "mode": "live",
  "scenarioCount": 10,
  "materials": [{ "name": "Реестр скиллов и маршруты", "content": "<описание скиллов агента>" }],
  "notes": "Клиенты пишут короткими фразами, часто не знают номера договора и путают инкассацию с эквайрингом.",
  "settings": {
    "provider": "giga", "model": "glm-5.2",
    "roles": {
      "builder": { "provider": "giga", "model": "GigaChat-3-Ultra" },
      "simulator": { "provider": "giga", "model": "glm-5.2" },
      "judge": { "provider": "giga", "model": "GigaChat-3-Ultra" }
    }
  }
}
```

```bash
node --env-file=/путь/agent_oc/.env dist/cli.js build --input task-cards.json --dialogues-file dialogues.jsonl > cards-draft.json
node dist/cli.js export --id RUN_ID --format markdown --output cards.md
```

Артефакт — карточки с `provenance: "production"`, дословными первыми репликами клиентов,
наблюдёнными профилями и ссылками на `id` диалогов-доказательств.

## End2end

`connection.json`:

```json
{
  "target": {
    "kind": "command",
    "command": "/путь/agent_oc/.venv/bin/python",
    "args": ["/путь/conductor-playground/examples/agent-oc-adapter.py", "/путь/agent_oc"],
    "cwd": "/путь/agent_oc",
    "timeoutMs": 180000
  },
  "targetVersion": "<git rev-parse --short HEAD в agent_oc>"
}
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
node --env-file=/путь/agent_oc/.env dist/cli.js build --input task-e2e.json --connection connection.json > draft.json
node --env-file=/путь/agent_oc/.env dist/cli.js run --id RUN_ID --yes
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

## Состояние пользователя и внешний мир в карточке
- source: docs/superpowers/specs/2026-09-14-simulator-v1-design.md
- type: schema
- content: |
    DATA_A7K2M9QX_START
    `userSchema` добавляет необязательные `knows`, `cannotKnow` и `answers`; `facts` и `behavior` остаются обязательными. `knows` уникален без учёта регистра. `worldSchema.external` — необязательный JSON размером не более 20 000 сериализованных символов. Старые записи загружаются с пустыми значениями.
    DATA_A7K2M9QX_END

## Граница видимости состояния для симулятора
- source: docs/superpowers/specs/2026-09-14-simulator-v1-design.md
- type: protocol
- content: |
    DATA_B4R8T1NV_START
    `runtime.userTurn` получает поля пользователя, включая `knows`, `cannotKnow` и `answers`, но не получает `initialState` или `external`. Симулятор должен использовать известные ответы дословно, признавать отсутствие знания и не утверждать сведения из `cannotKnow`.
    DATA_B4R8T1NV_END

## Заземление сгенерированных ответов карточки
- source: docs/superpowers/specs/2026-09-14-simulator-v1-design.md
- type: protocol
- content: |
    DATA_C9F3L6WP_START
    Для синтетических карточек значения из `answers[].reply` должны встречаться в `knows`, `facts` или `opening`; иначе карточка отклоняется и отправляется в существующий цикл исправления. Golden- и production-карточки этим правилом не проверяются.
    DATA_C9F3L6WP_END

## Кодовые проверки симулятора
- source: docs/superpowers/specs/2026-09-14-simulator-v1-design.md
- type: protocol
- content: |
    DATA_D2H7S5KJ_START
    `simulatorChecks` выполняется после реактивного диалога и сохраняет отдельные проверки утечки скрытого значения, выдуманного токена-значения и повтора реплики. Проверки не меняют `trial.outcome`, проверки агента или оценки судьи и не передаются судье. Для static и scripted результат пуст.
    DATA_D2H7S5KJ_END

## Алгоритмы проверок симулятора
- source: docs/superpowers/specs/2026-09-14-simulator-v1-design.md
- type: protocol
- content: |
    DATA_E8V1P4ZM_START
    Утечка сравнивает скалярные листья `records`/`external` с известным пользователю текстом и предыдущими ответами агента. Выдумка ищет новые токены со значением и помечается эвристикой. Повтор сравнивает нормализованные пользовательские реплики. Доказательство содержит номер события и найденное значение или пару событий.
    DATA_E8V1P4ZM_END

## Влияние качества симулятора на доверие к измерению
- source: docs/superpowers/specs/2026-09-14-simulator-v1-design.md
- type: protocol
- content: |
    DATA_F5N9Q2XC_START
    Диалог считается отмеченным симулятором при провале кодовой проверки или рубрики `user_fidelity`. Если отмечено более четверти реактивных диалогов, доверие не выше среднего. Отмеченный симулятор означает неполное измерение и код выхода 2 только для реактивных диалогов.
    DATA_F5N9Q2XC_END

## Сводка симулятора и ценность режимов
- source: docs/superpowers/specs/2026-09-14-simulator-v1-design.md
- type: schema
- content: |
    DATA_G3M6W8RT_START
    `SimulatorSummary` агрегирует реактивные диалоги, проверки, рубрику судьи, последние человеческие вердикты, уточнения и остановки. `ModeValue` хранит исходы карточек по режимам и списки карточек, завершённых или проваленных только reactive-режимом. `compareRuns.delta` задаёт описательную парную дельту по семействам с bootstrap-интервалом при двух и более семействах.
    DATA_G3M6W8RT_END

## Контракт внешнего состояния адаптера
- source: docs/superpowers/specs/2026-09-14-simulator-v1-design.md
- type: api-contract
- content: |
    DATA_H1Q7Y4PL_START
    `initialState.external` передаётся в каждом запросе http/command и в `createSession` модульного адаптера. Применивший состояние адаптер подтверждает его через `resetConfirmed: true` в первой реплике. Без подтверждения причина диалога и ограничения прогона отмечают ненаблюдаемое состояние, а проверки состояния невалидны.
    DATA_H1Q7Y4PL_END

## Хук выпуска внешней версии
- source: docs/superpowers/specs/2026-09-14-simulator-v1-design.md
- type: api-contract
- content: |
    DATA_J6T2B9VN_START
    Внешние target-варианты могут содержать `release` с командой, аргументами, абсолютным рабочим каталогом и таймаутом 1 000–600 000 мс. Хук выполняется один раз до первого запроса, получает переменные запуска и промпта, сохраняет ограниченные stdout/stderr; ненулевой код или таймаут переводит прогон в ошибку. Версию сообщает адаптер.
    DATA_J6T2B9VN_END

## Цитаты промпта в кластерах провалов
- source: docs/superpowers/specs/2026-09-14-simulator-v1-design.md
- type: protocol
- content: |
    DATA_K4X8C1MS_START
    Кластеризация запускается при одном и более провалах. `promptQuotes` содержит до пяти дословных фрагментов промпта длиной до 300 символов; каждая цитата валидируется как подстрока переданного промпта, а без промпта цитаты запрещены.
    DATA_K4X8C1MS_END

## Ограничения и проверка симулятора v1
- source: docs/superpowers/specs/2026-09-14-simulator-v1-design.md
- type: nfr
- content: |
    DATA_L9P3F7QW_START
    Регрессии выполняются без сети и модели. Живая проверка ограничена тремя рукописными golden-карточками, тремя режимами, одним повтором и 60 вызовами; отсутствие сервисов или ключей фиксируется как невыполненный шаг. Не строятся веб-интерфейс, очередь, лог-коннекторы или автоматическое обучение симулятора.
    DATA_L9P3F7QW_END

## Среда реализации Simulator v1
- source: docs/superpowers/plans/2026-09-14-simulator-v1.md
- type: nfr
- content: |
    DATA_M2V6N8KD_START
    Требуются Node 22, TypeScript strict, ESM, `node:test` через `tsx`, zod 4 и Python 3.12 для локального AIGW. Новые runtime-зависимости не добавляются; Pi остаётся единственным интерфейсом; новые проверки должны проходить полный тестовый набор и typecheck.
    DATA_M2V6N8KD_END

## Поставленная семантика проверок и измерений
- source: docs/superpowers/plans/2026-09-14-simulator-v1.md
- type: protocol
- content: |
    DATA_N7R1Z5HC_START
    Статус плана сообщает, что все три проверки симулятора поставлены как эвристики с сопоставлением по границам слов и циклами по ключам пар. Единое правило `measurementUsable` определяет пригодность для сравнений, кодов CI, предложений промпта и вердикта; неподтверждённый внешний мир делает попытку невалидной.
    DATA_N7R1Z5HC_END

## API переопределений SBE для AIGW
- source: docs/superpowers/plans/2026-09-14-simulator-v1.md
- type: api-contract
- content: |
    DATA_P8K4T2YF_START
    Локальный mock предоставляет POST/GET/DELETE `/mock/overrides`; переопределение привязано к `trace_id`, хранится максимум 1000 записей и имеет приоритет над общей фикстурой. Ответ адаптера сообщает подтверждение сброса, полноту и область событий, session/turn/version и, при наличии, хеш фактически загруженного промпта; ошибка регистрации возвращает `measurementError`.
    DATA_P8K4T2YF_END

## Граница живой проверки Simulator v1
- source: docs/superpowers/plans/2026-09-14-simulator-v1.md
- type: nfr
- content: |
    DATA_Q5W9M3BJ_START
    Живая проверка использует три golden-карточки, режимы static/scripted/reactive, один повтор и лимит 60 вызовов. Результат должен фиксировать фактически измеренные числа и явно указывать отсутствие человеческих вердиктов и production-данных; canned-режим агента не считается измерением.
    DATA_Q5W9M3BJ_END

## Измеримые обещания MVP
- source: docs/superpowers/specs/2026-09-15-mvp-cut-design.md
- type: nfr
- content: |
    DATA_R1C7V4NX_START
    P1: новый агент и первый экран за 30 минут по 10–15 карточкам и не более двух раундов починки. P2: человек разбирает 15 диалогов за час с основаниями по событиям, а автоматический и человеческий счёт показываются рядом. P3: повтор тех же карточек называет исправленные, сломанные и несравнимые пары.
    DATA_R1C7V4NX_END

## Оценка записанных диалогов
- source: docs/superpowers/specs/2026-09-15-mvp-cut-design.md
- type: protocol
- content: |
    DATA_S6H2Q8MP_START
    JSON/JSONL диалог превращается в production-карточку и одну scripted-попытку; события сохраняют исходный порядок, агент и симулятор не вызываются, `user_fidelity` и проверки симулятора не применяются. Оценка использует существующий `reassess`, рубрики карточки, кластеры и отчёты.
    DATA_S6H2Q8MP_END

## Ненаблюдавшиеся действия остаются неизвестными
- source: docs/superpowers/specs/2026-09-15-mvp-cut-design.md
- type: protocol
- content: |
    DATA_T3Y7L9KC_START
    Для импортированного диалога состояние отсутствует, инструменты наблюдались частично. Заявление агента о выполненном действии не доказывает действие: требующий состояния критерий получает `unclear`/`unknown`. Качество клиентского сообщения оценивается отдельно рубрикой `reply_quality`.
    DATA_T3Y7L9KC_END

## Минимальная карточка и рубрики MVP
- source: docs/superpowers/specs/2026-09-15-mvp-cut-design.md
- type: schema
- content: |
    DATA_U8N4F1ZW_START
    Генерируемая карточка сохраняет `goal`, `facts`, `knows`, `opening`, `answers`, `successCriteria` и, когда применимо, `initialState` с точными проверками. Основная рубрика — `goal_attainment`; `prompt_compliance` добавляется при переданном промпте. Дополнительные рубрики создаёт только владелец.
    DATA_U8N4F1ZW_END

## Совместимость хранения после среза
- source: docs/superpowers/specs/2026-09-15-mvp-cut-design.md
- type: schema
- content: |
    DATA_V2P6D9RH_START
    `familyId`, `profileId`, `persona`, `characteristics`, `cannotKnow` и `external` сохраняются необязательными legacy-полями и читаются из старых записей. Удалённые поля не отвергаются схемой; миграция сохранённых записей не требуется.
    DATA_V2P6D9RH_END

## Роли и исследовательский слой после среза
- source: docs/superpowers/specs/2026-09-15-mvp-cut-design.md
- type: protocol
- content: |
    DATA_W9K3S5BM_START
    Роль `profiles` удаляется; `goals` остаётся для критериев записанных диалогов; `improve` и семейства остаются только в sandbox-workflow `compare`. Удаляются аудит судьи, сравнение пользовательских режимов, калибровка, отчёт верности, pilot-сводка, парная дельта и сводки `simulatorSummary`/`modeValue`; `simulatorChecks` остаётся.
    DATA_W9K3S5BM_END

## Доска после MVP-среза
- source: docs/superpowers/specs/2026-09-15-mvp-cut-design.md
- type: protocol
- content: |
    DATA_X4M8Q2TJ_START
    `/agent-lab` оставляет список прогонов, диалог с событиями и индивидуальный вердикт человека. Редактор карточек, секции статистики и сравнения режимов и предпросмотр критериев удаляются; карточки редактируются через `agent_lab_edit`, статистика читается из HTML.
    DATA_X4M8Q2TJ_END

## Первый экран после MVP-среза
- source: docs/superpowers/specs/2026-09-15-mvp-cut-design.md
- type: protocol
- content: |
    DATA_Y7R1V6PN_START
    Заголовок показывает пройденные, неизвестные, недошедшие и разобранные человеком диалоги рядом. Человеческий вердикт по критерию исключает ошибочный тест или перекрывает судью; причины служат очередью разбора. Карточка с ненаблюдавшимся действием показывается без решения.
    DATA_Y7R1V6PN_END

## Не-цели MVP-среза
- source: docs/superpowers/specs/2026-09-15-mvp-cut-design.md
- type: nfr
- content: |
    DATA_Z5C9H3LW_START
    Не строятся веб-интерфейс, очередь и коннекторы к лог-платформам; не заявляются статистическая значимость или надёжность судьи; автоматическое исправление и сравнение симуляции с production откладываются; сторонние фреймворки оценивания не подключаются.
    DATA_Z5C9H3LW_END

## Среда и глобальные ограничения MVP-плана
- source: docs/superpowers/plans/2026-09-15-mvp-cut.md
- type: nfr
- content: |
    DATA_2Q7M8KFD_START
    Реализация использует Node не ниже 22.19, TypeScript ESM, `node:test` через `tsx`, zod 4, typebox и Pi SDK 0.85.1 без новых зависимостей. Пользовательские строки — русские, код и идентификаторы — английские. Каждый шаг должен сохранять зелёные тесты и совместимость старых JSON.
    DATA_2Q7M8KFD_END

## Человеческий вердикт и полный разбор диалога
- source: docs/superpowers/plans/2026-09-15-mvp-cut.md
- type: schema
- content: |
    DATA_6V1P9TRC_START
    Последний человеческий вердикт по критерию исключает его при `invalid`, заменяет судью при `pass`/`fail` и сохраняет неопределённость при `unknown`. `reviewedDialogue: true` допустим только для вердикта на весь диалог; вердикт по критерию или проверке не означает полный разбор и не распространяется на другие диалоги причины.
    DATA_6V1P9TRC_END

## Контракты импорта и оценки диалогов
- source: docs/superpowers/plans/2026-09-15-mvp-cut.md
- type: api-contract
- content: |
    DATA_8H4N2WQY_START
    `dialogueToScenario` создаёт production-карточку с `goal_attainment` и `reply_quality`; `dialogueToTrial` создаёт scripted-попытку с исходным порядком событий и отсутствующим наблюдением. `ExperimentLab.score` импортирует без запуска агента, а отдельный `reassess` вызывает судью и кластеризацию. CLI предоставляет `agent-lab score`, а `agent_lab_build` принимает `mode: "score"`.
    DATA_8H4N2WQY_END

## Протокол судьи 8
- source: docs/superpowers/plans/2026-09-15-mvp-cut.md
- type: protocol
- content: |
    DATA_3K9F5MVB_START
    При отсутствующем наблюдении состояния вход судьи сообщает, что заявление агента не является доказательством выполненного действия и требующее результата условие должно быть `unclear`. Контракт протокола фиксирует версию 8 и `unobservedActions: 'unclear'`.
    DATA_3K9F5MVB_END

## Нормализация рубрик и заземление знаний
- source: docs/superpowers/plans/2026-09-15-mvp-cut.md
- type: protocol
- content: |
    DATA_7T2C6PLR_START
    Сгенерированная внешняя карточка получает ровно одну агентскую рубрику `goal_attainment`, построенную из непустого `successCriteria`; harness добавляет `prompt_compliance` и `user_fidelity`. Значение из `answers` добавляется в `knows` без модельного раунда только при полном токенном совпадении с источником; неподтверждённое значение или переполнение лимита возвращает карточку на исправление.
    DATA_7T2C6PLR_END

## Удаляемые интерфейсы MVP-плана
- source: docs/superpowers/plans/2026-09-15-mvp-cut.md
- type: protocol
- content: |
    DATA_9W5R1XHN_START
    План удаляет роль observed-profiles, TUI-редактор, preview/clarify, аудит судьи, исследовательское сравнение, `simulatorSummary`, `modeValue`, `preset: thorough` и отдельные экраны статистики/сравнения. Доска сохраняет три экрана, а сравнение после исправления показывает только итоговый заголовок.
    DATA_9W5R1XHN_END

## Проверка обещаний и линия отсечения
- source: docs/superpowers/plans/2026-09-15-mvp-cut.md
- type: nfr
- content: |
    DATA_4B8Y3QMK_START
    Задачи 1–10 образуют линию отсечения перед демо; задачи 11–17 уменьшают продукт, задача 18 измеряет обещания. P1, P2 и P3 записываются выполненными или невыполненными с фактическими числами и артефактами; результат не переформулируется при провале критерия.
    DATA_4B8Y3QMK_END


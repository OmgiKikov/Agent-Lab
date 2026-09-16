---
phase: 01-odno-chestnoe-chislo
verified: 2026-09-16T23:33:01Z
status: gaps_found
score: 4/5 must-haves verified (критерии успеха ROADMAP); требования 8/9 (TRUST-04 не выполнено)
covered_files:
  - .planning/REQUIREMENTS.md
  - .planning/phases/01-odno-chestnoe-chislo/01-01-PLAN.md
  - .planning/phases/01-odno-chestnoe-chislo/01-01-SUMMARY.md
  - .planning/phases/01-odno-chestnoe-chislo/01-02-PLAN.md
  - .planning/phases/01-odno-chestnoe-chislo/01-02-SUMMARY.md
  - .planning/phases/01-odno-chestnoe-chislo/01-03-PLAN.md
  - .planning/phases/01-odno-chestnoe-chislo/01-03-SUMMARY.md
  - .planning/phases/01-odno-chestnoe-chislo/01-04-PLAN.md
  - .planning/phases/01-odno-chestnoe-chislo/01-04-SUMMARY.md
  - .planning/phases/01-odno-chestnoe-chislo/01-05-PLAN.md
  - .planning/phases/01-odno-chestnoe-chislo/01-05-SUMMARY.md
  - .planning/phases/01-odno-chestnoe-chislo/01-06-PLAN.md
  - .planning/phases/01-odno-chestnoe-chislo/01-06-SUMMARY.md
  - .planning/phases/01-odno-chestnoe-chislo/01-07-PLAN.md
  - .planning/phases/01-odno-chestnoe-chislo/01-07-SUMMARY.md
  - .planning/phases/01-odno-chestnoe-chislo/01-08-PLAN.md
  - .planning/phases/01-odno-chestnoe-chislo/01-08-SUMMARY.md
  - .planning/phases/01-odno-chestnoe-chislo/01-09-PLAN.md
  - .planning/phases/01-odno-chestnoe-chislo/01-09-SUMMARY.md
  - .planning/phases/01-odno-chestnoe-chislo/01-10-PLAN.md
  - .planning/phases/01-odno-chestnoe-chislo/01-10-SUMMARY.md
  - extensions/agent-lab.ts
  - extensions/cards.ts
  - src/artifacts.ts
  - src/cli.ts
  - src/comparison.ts
  - src/connection.ts
  - src/contracts.ts
  - src/evaluation.ts
  - src/experiment.ts
  - src/judge.ts
  - src/normalize.ts
  - src/quality.ts
  - src/report.ts
  - src/result-view.ts
  - src/store.ts
covered_digest: "v1:sha256:1bb981dd4d077ce8ba7318780dc54c3e6e66197f35e52426124549a613708f77"
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "SC5 / TRUST-04: в результате прогона эквайринга есть контрольная ситуация, с которой агент справляется, поэтому итог не выглядит как «0 из N» от сломанного судьи"
    status: failed
    reason: >-
      Механизм работает, но на живых данных контроль не пройден. Контроль ae812a24 не засчитан ни в одной
      из 3 живых попыток: 61521e0d дал unknown/simulator_unclear, 800c713c и 2fde3f18 дали unknown/simulator_deviated.
      В исходном fae4ee59 эта карточка тоже без решения (judge_split). Ни в одном прогоне эквайринга
      нет строки «Контроль: пройден ✓». Все три живых блока начинаются с «Контроль не пройден — числу пока не верить…».
      Требование говорит «есть ситуация, с которой агент справляется», а такой ситуации в доказательствах нет.
    artifacts:
      - path: ".agent-lab/61521e0d-b5a9-45e6-b13a-3e04349a6482.json"
        issue: "positiveControlScenarioIds=[ae812a24]; контроль не измерен (simulator_unclear)"
      - path: ".agent-lab/800c713c-4861-4dca-a0ff-c78940b8e95f.json"
        issue: "контроль не измерен (simulator_deviated)"
      - path: ".agent-lab/2fde3f18-d321-4a4a-bf54-5d218afd83c3.json"
        issue: "контроль не измерен (simulator_deviated)"
    missing:
      - "Выбрать другую контрольную ситуацию, которую aigw-local проходит. Кандидат из 01-10: единственная засчитанная карточка прогона a92fd6ae. Если подходящей нет, взять синтетическую ситуацию с пометкой «синтетическая»."
      - "Живой прогон (repeat --control <id>), после которого summary показывает «Контроль: пройден ✓» и нет верхнего предупреждения"
      - "Или убрать причину: изменение судьи в фазе 2 (агент оценивается до того, как симулятор отклонился) нацелено именно на simulator_deviated / simulator_unclear. После него стоит повторить попытку с ae812a24 или другим кандидатом."
    note: "Фаза 2 бьёт в причину (simulator_deviated/unclear), но ни одна более поздняя фаза в ROADMAP не называет контрольную ситуацию в своих критериях. Поэтому это не отложенный пункт, а открытый пробел."
advisory: []
coincidental_reliance_items: []
---

# Phase 1: Одно честное число. Отчёт проверки

**Цель фазы:** Владелец видит на прогоне эквайринга одно главное число с одним знаменателем, отдельно названное «не измерено» и честную оговорку о малой выборке, и может верить, что повтор и сравнение прогонов не врут.
**Проверено:** 2026-09-16T23:33:01Z (2026-09-17 по местному времени)
**Статус:** gaps_found
**Повторная проверка:** нет, это первая проверка
**Режим:** mvp (цель записана как описание фазы, а не как история пользователя «As a…», поэтому проверка шла по критериям успеха ROADMAP; таблица ниже играет роль покрытия пользовательского пути)

Все проверки только на чтение. Платных вызовов не было. `npm test` и `npm run build` в worktree не запускались. В отчёте только id и числа, без текста диалогов.

## Достижение цели

### Наблюдаемые истины (критерии успеха ROADMAP)

| # | Истина | Статус | Доказательство |
|---|--------|--------|----------------|
| 1 | На `fae4ee59` CLI и `/agent-lab` показывают одну главную строку «N из M», «не измерено» отдельно с причиной словами, оговорку о малой выборке; число из одного `ResultView` | ✓ VERIFIED | `node dist/cli.js summary --id fae4ee59…` → `Справился в 0 из 9 проверенных ситуаций — 0%.` / `Мало данных: реальная доля где-то от 0% до 30%.` / `Не измерено: 4 — чаще всего симулятор отклонился от диалога (2).` / строка охвата 40/13/27 (21, 6), слова «прочее» нет. `pi-surface-check.mts` (вызывает настоящий `agent_lab_inspect`, `renderResult` и `LabBoard` с `bundle.view`, как `/agent-lab`): `OK surfaces=3` для fae4ee59, a92fd6ae, 61521e0d, 9d587362. `cli.ts:102` и `extensions/cards.ts:189,315`, `agent-lab.ts:745` берут строки из `buildResultView`/`resultViewLines`. |
| 2 | Повтор aigw-local сравним с исходным через `diff`, дефолт `goalObservation` не даёт «изменившихся», нет «несравнимы»; нестабильные ситуации помечены (повтор и переоценка) | ✓ VERIFIED | `diff --before fae4ee59 --after 61521e0d --json`: код выхода 0, `comparable=true`, fixed 0, regressed 0, unchanged 8, incomparable 5 (пары без решения), заметки «Содержимое карточек изменилось» нет. Тот же прогон сам с собой → ровно `["Выбран один и тот же прогон."]`. Блоки: `Нестабильных: 0 (повтор прогона fae4ee59).` (61521e0d) и `Нестабильных: 0 (переоценка прогона fae4ee59).` (9d587362). Живого флипа нет; сам подсчёт флипа подтверждён пройденными тестами (`a repeat counts situations whose goal verdict flipped…`, `stabilityAfterReassess counts a goal flip…`, `CLI summary of a repeat names the flips … from the built dist`). |
| 3 | Сборка validation set с совпадающими id целей доходит до конца; CLI `score` использует тот же бюджет, судью и таймаут, что и Pi | ✓ VERIFIED | Живая сборка f9b3824d: фаза `review`, 40 вызовов, 13 карточек, `collisionNote=true`, исключения unconfirmed 19 / customer_data 7 / masked 1. `scoreSettings` (`src/normalize.ts:32`) вызывается из `cli.ts:302` и `agent-lab.ts:367`. Тесты `a validation build with colliding model goal ids…` и `CLI and Pi code-only score of the same dialogue and task save the same settings` пройдены. |
| 4 | Новый прогон хранит полный аудит судьи отдельно; запись и отчёт заметно меньше 50 МБ; старые записи открываются и переоцениваются без миграции | ✓ VERIFIED | 61521e0d: 13 квитанций, 0 ключей `"judgeAudit":`, 13 sidecar-файлов 0600 в каталоге 0700, запись 397 417 байт, трасса 3 008 285 байт, 13 строк аудита в журнале (раньше было 325 строк и 60 МБ). JSON-экспорт 3,9 МБ. Старый fae4ee59 открывается (summary, diff, export: JSON 3,48 МБ, HTML 385 КБ) и переоценён в 9d587362 (0 ключей аудита). `draftHash` не изменился (по данным 01-10). |
| 5 | В результате прогона эквайринга есть контрольная ситуация, с которой агент справляется | ✗ FAILED | Механизм есть: `positiveControlScenarioIds`, `repeat --control`, строка контроля, верхнее предупреждение (`result-view.ts:98-111,173-181`, тесты пройдены). Но все 3 живые попытки с `ae812a24` дают «Контроль: не измерен — …» и предупреждение «Контроль не пройден — числу пока не верить…». Ситуации, с которой агент справляется, в результате нет. |

**Итог:** 4/5 истин подтверждены (0 истин «код есть, поведение не проверено»).

Критерий 5 и TRUST-04 считаются невыполненными. Цель требования — чтобы «0 из N» нельзя было принять за сломанного судью. На живых данных этого нет: прогон 61521e0d показывает «0 из 10» и неизмеренный контроль. Предупреждение честное, но положительного опорного случая нет. SUMMARY 01-10 говорит то же самое. При этом в REQUIREMENTS.md TRUST-04 отмечено `[x] Complete`. Эту отметку стоит снять, пока пробел не закрыт.

### Требуемые артефакты

| Артефакт | Статус | Детали |
|----------|--------|--------|
| `src/result-view.ts` | ✓ VERIFIED | `buildResultView`, `resultViewLines`, `wilson`, строки стабильности и контроля; `dist/result-view.js` есть |
| `src/comparison.ts` | ✓ VERIFIED | `cardVerdict`, коды причин, `stabilityBetweenRuns/AfterReassess`, `observableSources`, `normalizeScenarioIdentity`, личность судьи по квитанции |
| `src/normalize.ts` | ✓ VERIFIED | `scoreSettings`, нормализация личности карточки; `dist/normalize.js` есть |
| `src/judge.ts` / `src/store.ts` / `src/contracts.ts` | ✓ VERIFIED | квитанция, sidecar-файлы, `positiveControlScenarioIds` (подтверждено живыми записями) |
| `extensions/agent-lab.ts`, `extensions/cards.ts` | ✓ VERIFIED | импорт из `../dist/result-view.js`; `summary(…, bundle.view)`; доска берёт `options.view` |
| `src/report.ts` | ✓ VERIFIED (с замечанием) | журнал заменён ссылкой `traceJournal: {file, bytes}`; см. антипаттерны про старые записи |
| Скрипты фазы (`snap-test.sh`, `verify-stored-runs.mjs`, `pi-surface-check.mts`, `live-check.mjs`) | ✓ VERIFIED | запущены, выводят только id и числа |

### Проверка ключевых связей

| От | К | Через | Статус |
|----|---|-------|--------|
| `src/cli.ts` summary | `result-view` | `buildResultView(record, { before })` при `assessmentOf ?? parentRunId` | WIRED |
| `extensions/agent-lab.ts` | `dist/result-view.js`, `dist/normalize.js` | импорт; `summary(record, …, bundle.view)` в 7 местах | WIRED |
| `/agent-lab` (`agent-lab.ts:745`) | `LabBoard` | `view: bundle?.view` | WIRED |
| `src/quality.ts` | `comparison.goalCardOutcome` | импорт | WIRED |
| `src/comparison.ts` | `judge.ts` | `SPLIT_RATIONALE_PREFIX`, `GOAL_UNSUPPORTED_RATIONALE`, `hasCompleteJudgment(observableSources…)` | WIRED |
| `src/cli.ts` / `agent-lab.ts` | `scoreSettings` | `scoreSettings(dialogues.length, …)` / `scoreSettings(parsedDialogues.length, …)` | WIRED |
| `dist/` | HEAD | собран из `ca55767`; после него в `src/ extensions/ test/` изменений нет (`git diff ca55767 HEAD` пуст) | WIRED |

### Проверка потока данных (уровень 4)

| Артефакт | Данные | Источник | Реальные данные | Статус |
|----------|--------|----------|-----------------|--------|
| Главная строка | passed/decided | `cardVerdict` по trials записи | да (`verify-stored-runs`: fae4ee59 0/9/4, a92fd6ae 1/8/7) | ✓ FLOWING |
| Строка стабильности | unstable[] | сохранённый родительский прогон / `sourceEvidence` | да (61521e0d, 9d587362) | ✓ FLOWING |
| Строка контроля | outcome контроля | `positiveControlScenarioIds` + trial | да (3 живые записи) | ✓ FLOWING |

### Выборочные проверки поведения

| Поведение | Команда | Результат | Статус |
|-----------|---------|-----------|--------|
| Блок fae4ee59 | `node dist/cli.js summary --id fae4ee59…` | 5 строк как ожидалось | ✓ PASS |
| Хранимые счётчики | `verify-stored-runs.mjs --expect … --audit …` | 0/9/4, 1/8/7, аудит 13/13, 14/14, код 0 | ✓ PASS |
| Совпадение поверхностей | `npx tsx pi-surface-check.mts --id ×4` | 4 × `OK surfaces=3` | ✓ PASS |
| Сравнимость повтора | `diff --before fae4ee59 --after 61521e0d --json` | comparable, код 0 | ✓ PASS |
| Прогон сам с собой | `diff … --json` notes | `["Выбран один и тот же прогон."]` | ✓ PASS |
| Живые записи | `live-check.mjs record` ×6 | квитанции, sidecar-файлы, размеры как выше | ✓ PASS |
| Прицельные тесты | `snap-test.sh test/{result-view,comparison,normalize,judge,store,experiment,workflow,extension,artifacts}.test.ts` | 193/193 | ✓ PASS |
| Контроль пройден на живых данных | `summary` 61521e0d, 800c713c, 2fde3f18 | «Контроль: не измерен — …» ×3 | ✗ FAIL |

### Выполнение проб

Фаза не объявляет скриптов `scripts/*/tests/probe-*.sh`. Роль проб играют скрипты фазы, и они запущены выше.

### Покрытие требований

| Требование | План | Статус | Доказательство |
|------------|------|--------|----------------|
| TRUST-01 | 01-01, 01-02, 01-08, 01-10 | ✓ SATISFIED | истина 1; `view` в JSON CLI; совпадение поверхностей. Выжимка и HTML-блок относятся к фазам 4–5 |
| TRUST-02 | 01-01, 01-02, 01-10 | ✓ SATISFIED | «Не измерено: N — причина», отдельно от знаменателя; нет «прочее» |
| TRUST-03 | 01-01, 01-02, 01-10 | ✓ SATISFIED | строка Уилсона при M<20 (0–30%, 0–28%, 0–32%) |
| TRUST-04 | 01-09, 01-10 | ✗ BLOCKED | механизм есть, но контроля, с которым агент справляется, в живом результате нет (истина 5) |
| TRUST-05 | 01-03, 01-07, 01-10 | ✓ SATISFIED | истина 2 |
| TRUST-06 | 01-03, 01-10 | ✓ SATISFIED | f9b3824d `review`, `collisionNote=true` |
| TRUST-07 | 01-08, 01-10 | ✓ SATISFIED | общий `scoreSettings`, тест равенства настроек |
| TRUST-08 | 01-04, 01-06, 01-07, 01-10 | ✓ SATISFIED | истина 4 |
| TRUST-09 | 01-05, 01-10 | ✓ SATISFIED | строки стабильности на повторе и переоценке; флип покрыт тестами (живого флипа нет) |

Все 9 id из планов есть в REQUIREMENTS.md. Требований фазы 1, которые не взял бы ни один план, нет.

### Найденные антипаттерны

| Файл | Строка | Что найдено | Серьёзность | Влияние |
|------|--------|-------------|-------------|---------|
| `src/report.ts` | 221 | JSON-экспорт кладёт запись как есть. У старых записей (fae4ee59) в экспорт попадают 13 полных `judgeAudit` (≈140 КБ каждый), хотя запрет плана 01-07 говорит «ни в одном экспортированном отчёте» | ⚠️ Warning | Размер в норме (3,48 МБ); у новых записей аудита в экспорте нет. Для старых прогонов, которые пересылают заказчику, это стоит закрыть в фазе 5 (HTML/выжимка) |
| `src/result-view.ts` | 111 | Когда контроль не измерен, верхняя строка говорит «Контроль не пройден», а строка контроля — «не измерен» | ℹ️ Info | Формулировки не совпадают; об этом уже написано в 01-10 |
| изменённые файлы | — | TBD/FIXME/XXX | нет | — |

### Нужна проверка человеком

Для статуса ничего не требуется. Совпадение с живым экраном Pi проверено автоматически через `pi-surface-check`, который вызывает тот же код расширения. Взглянуть на экран глазами не обязательно, но полезно после следующего запуска Pi на новом `dist/`.

### Сводка пробелов

Один пробел, и он касается доказательств, а не кода: **нет положительного контроля, который aigw-local проходит**. Всё остальное из цели фазы подтверждено на коде и на живых записях. Есть одно главное число с одним знаменателем, одинаковое в CLI, в чате Pi и на доске. «Не измерено» названо словами. Есть оговорка о малой выборке. Повтор сравним с исходником. Стабильность показана после повтора и после переоценки. Сборка переживает совпадающие id. Настройки score одинаковы. Аудит вынесен из записи.

Контроль `ae812a24` три раза ушёл в «не измерен» из-за отклонения симулятора, так что «0 из 10» на живом прогоне пока нечем отличить от сломанного судьи. Предупреждение наверху при этом честное.

Что сделать:
1. Взять другой кандидат (засчитанная карточка из a92fd6ae) или синтетическую ситуацию с пометкой. Сделать `repeat --control` и живой прогон (около $0,17 за попытку).
2. Или после изменения судьи в фазе 2, которое оценивает агента до отклонения симулятора, повторить попытку. Это изменение бьёт в ту самую причину.
3. После закрытия снова отметить TRUST-04 выполненным в REQUIREMENTS.md; сейчас отметка `[x]` опережает доказательства.

---

_Проверено: 2026-09-16T23:33:01Z_
_Проверяющий: Claude (gsd-verifier)_

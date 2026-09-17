---
phase: 01-odno-chestnoe-chislo
verified: 2026-09-17T00:26:14Z
status: passed
score: 5/5 must-haves verified (критерии успеха ROADMAP); требования 9/9
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
  - .planning/phases/01-odno-chestnoe-chislo/01-11-PLAN.md
  - .planning/phases/01-odno-chestnoe-chislo/01-11-SUMMARY.md
  - .planning/phases/01-odno-chestnoe-chislo/01-12-PLAN.md
  - .planning/phases/01-odno-chestnoe-chislo/01-12-SUMMARY.md
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
covered_digest: "v1:sha256:7c1c8e69c9bf63eaa390d1224c1b757599b68aca0bc108c3ad2a0c881f4beb78"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 4/5
  gaps_closed:
    - "SC5 / TRUST-04: живой прогон c1b9f043 (повтор a92fd6ae) содержит настоящий контроль ae812a24, засчитанный судьёй; блок показывает «Контроль: пройден ✓» без верхнего предупреждения"
    - "Warning 01-07: JSON-экспорт старой записи больше не содержит полных judgeAudit (0 ключей, judgeAudits.omittedLegacyAudits = 13)"
  gaps_remaining: []
  regressions: []
advisory:
  - finding: "Положительный контроль подтверждён одной живой попыткой в прогоне на 2 ситуации. Версия карточки ae812a24 из набора fae4ee59 (другие критерии) по-прежнему даёт 1 голос «пройдено» из 8."
    category: other
    reason: "Для демо набор с проходящим контролем должен быть повтором a92fd6ae с --control ae812a24 (записано в STATE.md, решается при подготовке фазы 7). На закрытие TRUST-04 не влияет."
    evidence_status: "one live pass (c1b9f043); fae-version votes from 01-12 planning facts"
---

# Phase 1: Одно честное число. Отчёт проверки

**Цель фазы:** Владелец видит на прогоне эквайринга одно главное число с одним знаменателем, отдельно названное «не измерено» и честную оговорку о малой выборке, и может верить, что повтор и сравнение прогонов не врут.
**Проверено:** 2026-09-17T00:26:14Z (03:26 по местному времени)
**Статус:** passed
**Повторная проверка:** да. Предыдущая дала `gaps_found` (4/5): не хватало живого положительного контроля. После неё были ревью-исправления 209e317…ad47769 и планы закрытия 01-11 и 01-12.
**Режим:** mvp. Цель записана как описание фазы, поэтому проверка шла по критериям успеха ROADMAP.

Все проверки только на чтение, без платных вызовов. `npm test` и `npm run build` в worktree не запускались. В отчёте только id и числа.

## Достижение цели

### Наблюдаемые истины (критерии успеха ROADMAP)

| # | Истина | Статус | Доказательство (эта проверка) |
|---|--------|--------|-------------------------------|
| 1 | Одна главная строка «N из M» в CLI и `/agent-lab`, «не измерено» словами, оговорка о малой выборке, одно число из `ResultView` | ✓ VERIFIED (регрессии нет) | `summary --id fae4ee59…` на новом `dist/`: те же 5 строк (0 из 9; 0–30%; «Не измерено: 4 — …»; «Контроль: не задан.»; охват 40/13/27). `pi-surface-check.mts`: `OK surfaces=3` для fae4ee59, a92fd6ae, 61521e0d, 9d587362, c1b9f043. |
| 2 | Повтор сравним через `diff`, дефолт `goalObservation` не даёт «изменившихся», нестабильные ситуации помечены | ✓ VERIFIED (регрессии нет) | `diff fae4ee59 → 61521e0d`: comparable, fixed 0, regressed 0, unchanged 8, incomparable 4, shared 12. Контроль теперь исключён из сравнения, и об этом есть заметка «Контрольные ситуации не сравниваются…». Заметки «Содержимое карточек изменилось» нет. Прогон сам с собой → `["Выбран один и тот же прогон."]`. Строки «Нестабильных: 0 (повтор прогона …)» есть у 61521e0d и c1b9f043. |
| 3 | Сборка с совпадающими id целей доходит до конца; `score` в CLI и Pi с одинаковыми настройками | ✓ VERIFIED (регрессии нет) | f9b3824d по-прежнему `review`. После `03aafef` в `src/`, `extensions/` и `test/` изменений нет. Тесты сборки и равенства настроек score пройдены (202/202). |
| 4 | Полный аудит судьи вне записи; запись и отчёт заметно меньше 50 МБ; старые записи открываются и переоцениваются | ✓ VERIFIED (регрессии нет, замечание снято) | c1b9f043: 2 квитанции, 0 ключей аудита, 2 файла аудита (права 0600, каталог 0700), запись 133 725 байт. Старый fae4ee59 читается, `verify-stored-runs` даёт аудит 13/13. JSON-экспорт fae4ee59 теперь 427 КБ, в нём 0 ключей `"judgeAudit":`, а `judgeAudits.omittedLegacyAudits = 13` (исправление IN-03). |
| 5 | В результате прогона эквайринга есть контрольная ситуация, с которой агент справляется | ✓ VERIFIED (закрыто) | `node dist/cli.js summary --id c1b9f043…` → `Справился в 0 из 1 проверенной ситуации — 0%.` / `Мало данных: … от 0% до 79%.` / `Нестабильных: 0 (повтор прогона a92fd6ae).` / `Контроль: пройден ✓`; строки «Контроль не пройден» нет. Прямое чтение записи через `dist/`: mode `live`, target `command`, parent a92fd6ae, `positiveControlScenarioIds=[ae812a24]`. Контроль: provenance `production`, не синтетический, `maxFollowUps 0`, одна попытка с настоящими вызовами инструментов агента и ответом, без событий симулятора, `hasCompleteJudgment = true`, `cardVerdict = pass`. Рядом засчитанная ситуация 3fc7ace7 = fail, то есть судья в том же прогоне ставит и «пройдено», и «провалено». |

**Итог:** 5/5 истин подтверждены (0 истин «код есть, поведение не проверено»).

Почему критерий 5 засчитан. Цель требования — чтобы «0 из N» нельзя было принять за сломанного судью или разорванную связь. В c1b9f043 рядом с «0 из 1» стоит настоящий диалог эквайринга, который этот же агент через ту же связь прошёл, и этот же судья его засчитал. Контроль теперь идёт одной репликой (01-11). Это законно: он проверяет судью и связь, а не многоходовую работу агента, и в главное число не входит. Изменение запрещено для переоценки и не трогает `draftHash`, `measurementHash`, `JUDGE_PROTOCOL` и `VERSION` (по 01-11; в `src/judge.ts`, `src/contracts.ts`, `src/evaluation.ts` изменений нет).

### Проверенные ключевые связи (регрессионная проверка)

| Связь | Статус |
|-------|--------|
| CLI `summary` → `buildResultView(record, { before })` | WIRED |
| Pi-инструменты и `/agent-lab` → `bundle.view` (`pi-surface-check` на 5 прогонах) | WIRED |
| `repeat()`/`loadSuite()` → `oneTurnControls` (у контроля в c1b9f043 `maxFollowUps 0`) | WIRED |
| `compareRuns` исключает контроль и пишет заметку (diff fae→61521e0d, a92→c1b9f043) | WIRED |
| `dist/` ↔ HEAD: собран из `03aafef`; `git diff 03aafef HEAD -- src extensions test` пуст | WIRED |

### Выборочные проверки поведения

| Поведение | Команда | Результат | Статус |
|-----------|---------|-----------|--------|
| Контроль пройден на живых данных | `node dist/cli.js summary --id c1b9f043…` | «Контроль: пройден ✓», предупреждения нет | ✓ PASS |
| Вердикт контроля из записи | `cardVerdict` / `hasCompleteJudgment` из `dist/` | pass / true | ✓ PASS |
| Хранимые счётчики | `verify-stored-runs.mjs` (fae 0/9/4, a92 1/8/7, 61521e0d 0/10/2, аудит 13/13, 14/14) | код 0 | ✓ PASS |
| Совпадение поверхностей | `pi-surface-check.mts` ×5 | 5 × `OK surfaces=3` | ✓ PASS |
| Сравнимость повтора | `diff fae4ee59 → 61521e0d --json` | comparable, 8/4, без «Содержимое карточек изменилось» | ✓ PASS |
| Экспорт старой записи | `export --id fae4ee59 --format json` | 427 КБ, 0 полных аудитов | ✓ PASS |
| Прицельные тесты после ревью | `snap-test.sh test/{result-view,comparison,normalize,judge,store,experiment,workflow,extension,artifacts}.test.ts` | 202/202 | ✓ PASS |

### Покрытие требований

| Требование | Планы | Статус | Доказательство |
|------------|-------|--------|----------------|
| TRUST-01 | 01-01, 01-02, 01-08, 01-10 | ✓ SATISFIED | истина 1 |
| TRUST-02 | 01-01, 01-02, 01-10 | ✓ SATISFIED | истина 1 |
| TRUST-03 | 01-01, 01-02, 01-10 | ✓ SATISFIED | строка Уилсона при M<20 |
| TRUST-04 | 01-09, 01-10, 01-11, 01-12 | ✓ SATISFIED | истина 5 (c1b9f043) |
| TRUST-05 | 01-03, 01-07, 01-10 | ✓ SATISFIED | истина 2 |
| TRUST-06 | 01-03, 01-10 | ✓ SATISFIED | истина 3 |
| TRUST-07 | 01-08, 01-10 | ✓ SATISFIED | истина 3 |
| TRUST-08 | 01-04, 01-06, 01-07, 01-10 | ✓ SATISFIED | истина 4 |
| TRUST-09 | 01-05, 01-10 | ✓ SATISFIED | истина 2; флип подтверждён тестами, живого флипа нет |

Все 9 id учтены. REQUIREMENTS.md отмечает TRUST-04 `[x] Complete`, и теперь доказательства это подтверждают.

### Найденные антипаттерны

| Файл | Что найдено | Серьёзность | Влияние |
|------|-------------|-------------|---------|
| `src/report.ts` | Полные аудиты старых записей в JSON-экспорте (прошлое замечание) | снято | исправлено в 46129fd (IN-03) |
| `src/result-view.ts` | Когда контроль не измерен, верхняя строка говорит «Контроль не пройден», а строка контроля — «не измерен» | ℹ️ Info | формулировки для фазы экрана |
| изменённые файлы | TBD/FIXME/XXX | нет | — |

### Советы (не блокируют)

| # | Находка | Почему только совет |
|---|---------|---------------------|
| 1 | Контроль подтверждён одной живой попыткой в прогоне из 2 ситуаций. В наборе fae4ee59 у той же карточки другие критерии, и там 1 голос «пройдено» из 8. Для демо нужен повтор a92fd6ae с `--control ae812a24` (15 ситуаций, около $2,1) | Это выбор демо-записи (фаза 7, уже записано в STATE.md), а не пробел фазы 1 |

### Нужна проверка человеком

Для статуса ничего не требуется. Совпадение с экраном Pi проверено `pi-surface-check`, который вызывает код расширения.

### Сводка

Пробел закрыт. Живой прогон c1b9f043 на aigw-local показывает засчитанный настоящий контроль, и предупреждения наверху нет. Критерии 1–4 после двух раундов ревью-исправлений и планов 01-11/01-12 не пострадали. Счётчики хранимых прогонов, сравнимость повтора, совпадение поверхностей и вынос аудита подтверждены заново. Прошлое замечание про полные аудиты в экспорте старой записи тоже исправлено. Фаза 1 достигла цели.

---

_Проверено: 2026-09-17T00:26:14Z_
_Проверяющий: Claude (gsd-verifier)_

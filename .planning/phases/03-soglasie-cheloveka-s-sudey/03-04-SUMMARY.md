---
phase: 03-soglasie-cheloveka-s-sudey
plan: 04
subsystem: pi-board
tags: [pi-board, keys, native-dialogs, agreement, review-queue, quick-mark]

requires:
  - phase: 03-soglasie-cheloveka-s-sudey
    plan: 01
    provides: "`judgeAgreement`, `agreementSample`, `primaryMetricId`, `addHumanReview` with `source: 'quick'` and the C-99…C-101 refusals"
  - phase: 03-soglasie-cheloveka-s-sudey
    plan: 02
    provides: "a decided quick mark closes the situation in `awaitingVerdict`; a quick agreement is not a «замечание человека»"
  - phase: 03-soglasie-cheloveka-s-sudey
    plan: 03
    provides: "`assertPlainCopy` — the phase-3 copywriting scan"
provides:
  - "`agreementTarget(record, trial)` — control / undecided / ready, with the metric and the recorded judge verdict a one-key answer refers to"
  - "`BoardAction` variant `agree` (answer, trialId, metricId, judgeVerdict, reviewMs); the whole-dialogue `verdict` variant is retired"
  - "keys `y` / `n` / `s` in board section 3; quick `p` retired there"
  - "`resultEntries(record)` — section-3 rows in review order with the F12 labels, suffixes and the `u` predicate"
  - "`reviewOrder` leads with the unanswered review queue: failures first, then the sampled successes"
  - "the `agree` loop branch: the reason editor, C-92…C-98, the lab refusals, C-102 and the C-65 confirmation row"
affects: [03-05, 03-06, 03-07]

actuals:
  tokens: 87763
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "One key = one answer, scoped by a pure predicate (`agreementTarget`) that both the key map and the detail pane can ask"
    - "The board action carries the judgment it answers, so the lab can refuse a stale one instead of silently overwriting"
    - "A list the sidebar truncates is built by an exported pure function, so the whole row can be asserted"

key-files:
  created: []
  modified:
    - extensions/cards.ts
    - extensions/agent-lab.ts
    - test/cards.test.ts
    - test/extension.test.ts

key-decisions:
  - "`agreementTarget` reads `trial.assessments` directly, never `agentMetricResult`: a mark must be compared with the verdict it argued with, not with the verdict it already changed"
  - "The duplicate check («отметка уже стоит») runs before the lab call, so the stale-judge refusal test answers with a *different* answer — otherwise the earlier, also-correct rule masks the refusal"
  - "Section-3 rows moved into an exported `resultEntries`: the sidebar truncates to 32 columns, so a rendered board cannot prove a label or its suffix"
  - "`reviewOrder` keeps the rank-then-record-index sort, so the sampled successes come out in record order even though `agreementSample` returns them hash-ordered"

patterns-established:
  - "Pattern: `boardFixture(prefix, mutate?)` — a finished demo evaluation copied into a fresh Pi working directory, optionally mutated (finished run, failures-free run) before it is saved"
  - "Pattern: a board step is either the keys the owner presses or the exact action the board would emit, so a state the keys cannot reach twice in a row is still testable"

requirements-completed: [JUDGE-04, JUDGE-06]

coverage:
  - id: D1
    description: "In section 3 of a reviewable evaluate run, `y` / `n` / `s` emit `{ type: 'agree', answer }` with the trial, the primary metric and the recorded judge verdict; `p` emits nothing"
    requirement: JUDGE-04
    verification:
      - kind: unit
        ref: "test/cards.test.ts#разбор начинается с провалов без вердикта, счётчик их считает, согласие с судьёй ставится одной клавишей"
        status: pass
      - kind: unit
        ref: "test/cards.test.ts#a quick agreement mark includes time spent reading the selected dialogue"
        status: pass
    human_judgment: false
  - id: D2
    description: "The keys are inert and silent outside that scope: sections 1 and 2, compare records, running phases, control situations, situations the judge left undecided; while searching they type letters, with help open they do nothing, and `n` on the run list still starts a new check"
    requirement: JUDGE-04
    verification:
      - kind: unit
        ref: "test/cards.test.ts#y, n и s отвечают судье только там, где судья вынес решение по главному вопросу"
        status: pass
    human_judgment: false
  - id: D3
    description: "A key press writes one `source: 'quick'` review — agree = the judge verdict, disagree = the opposite with the owner's own reason from the Pi editor, unsure = `unknown` — and the board reopens with the named notice; a cancelled editor writes nothing and says nothing, an empty reason is named"
    requirement: JUDGE-04
    verification:
      - kind: e2e
        ref: "test/extension.test.ts#одна клавиша на доске сохраняет согласие, несогласие с причиной и сомнение"
        status: pass
      - kind: e2e
        ref: "test/extension.test.ts#Pi connects a new request, conversational correction, reviewed run, evidence discussion and repeat without UI JSON"
        status: pass
    human_judgment: false
  - id: D4
    description: "Every edge is named and writes nothing: the same answer twice, the same reason twice, a reason over 3000 characters, and a judge verdict that moved while the situation was on screen; `durationMs` is at least the reading time the board attached"
    requirement: JUDGE-04
    verification:
      - kind: e2e
        ref: "test/extension.test.ts#повтор ответа, длинная причина и сменившаяся оценка судьи ничего не пишут и названы словами"
        status: pass
    human_judgment: false
  - id: D5
    description: "A mark on a finished run reopens the review and the notice says so; on a run with no queued failures the agree notice counts checked successes instead"
    requirement: JUDGE-04
    verification:
      - kind: e2e
        ref: "test/extension.test.ts#отметка на завершённом прогоне снова открывает разбор, а прогон без провалов считает успехи"
        status: pass
    human_judgment: false
  - id: D6
    description: "`f` with an unanswered situation names how many are left and which keys close them, and reopens section 3 with the filter on; the finalize confirmation says the mark lands on the situation's main question"
    requirement: JUDGE-04
    verification:
      - kind: e2e
        ref: "test/extension.test.ts#f называет, сколько ситуаций не разобрано, и подтверждение говорит, на что ставится отметка"
        status: pass
    human_judgment: false
  - id: D7
    description: "The results list leads with unanswered queued failures in record order, then the sampled successes, then today's rank; each answer moves the same list position to the next case"
    requirement: JUDGE-06
    verification:
      - kind: unit
        ref: "test/cards.test.ts#очередь разбора ведёт неотмеченными провалами, затем проверяемыми успехами, и каждая строка говорит, где ситуация стоит"
        status: pass
      - kind: unit
        ref: "test/cards.test.ts#при тринадцати провалах и одном проверяемом успехе успех стоит четырнадцатым"
        status: pass
    human_judgment: false
  - id: D8
    description: "Row labels: `● ПРОВЕРЬТЕ ПРОВАЛ` / `● ПРОВЕРЬТЕ И УСПЕХ` before an answer, `· = согласен`, `НЕСОГЛАСИЕ С СУДЬЁЙ`, `● … · ~ не могу сказать` after one (one `●` at most); `u` keeps the unanswered queue and today's pending dialogues"
    requirement: JUDGE-06
    verification:
      - kind: unit
        ref: "test/cards.test.ts#очередь разбора ведёт неотмеченными провалами, затем проверяемыми успехами, и каждая строка говорит, где ситуация стоит"
        status: pass
    human_judgment: false
  - id: D9
    description: "Untrusted record text never reaches the terminal: a situation title carrying an ESC sequence renders escaped in the list and the sidebar"
    requirement: JUDGE-06
    verification:
      - kind: unit
        ref: "test/cards.test.ts#управляющая последовательность в названии ситуации не доходит до терминала"
        status: pass
    human_judgment: false
  - id: D10
    description: "Every phase-3 notice this plan prints reads as plain Russian past the allowed key letters"
    requirement: JUDGE-04
    verification:
      - kind: unit
        ref: "test/extension.test.ts#повтор ответа, длинная причина и сменившаяся оценка судьи ничего не пишут и названы словами"
        status: pass
    human_judgment: false
  - id: D11
    description: "The owner of the acquiring agent goes through a real run with one key per situation and finds the flow faster than the old verdict keys, in a light and a dark Pi theme"
    verification: []
    human_judgment: true
    rationale: "Whether one key per situation actually feels like «проверяю судью без лишних действий» is a judgment on a live run by the owner; the detail pane that shows the evidence before the verdict lands in 03-05, so the live read belongs to the phase-level check."

duration: 27 min
completed: 2026-09-17
status: complete
plan_head_before: 0f73fb389d781f5d99c9c92daf4ae25681ddd941
---

# Phase 3 Plan 04: Одна клавиша согласия с судьёй на доске Summary

**Владелец отвечает судье одной латинской клавишей прямо в разделе результатов — `y` согласен, `n` не согласен с причиной из редактора Pi, `s` не могу сказать — и список сам подводит его к следующей непроверенной ситуации, начиная с провалов и заканчивая выборкой успехов.**

## Performance

- **Duration:** 27 min (12:38:05Z → 13:05:27Z)
- **Completed:** 2026-09-17
- **Tasks:** 3
- **Files modified:** 4 (0 created)

## Accomplishments

- **Три ответа, три клавиши, одна область действия.** В разделе 3 разобранного прогона `y` / `n` / `s` дают действие `agree` с `trialId`, `metricId` главной оценки и тем решением судьи, которое было на экране. Вне этой области они молчат: разделы 1 и 2, сравнительные записи, идущие диалоги, контрольные ситуации и ситуации без решения судьи — ни действия, ни уведомления. Во время поиска они набираются буквами, при открытой справке не делают ничего, а `n` в списке прогонов по-прежнему начинает новую проверку. Быстрый `p` в разделе 3 снят: вердикт по диалогу целиком остаётся на `v`.
- **Область действия — чистая функция, а не условие внутри обработчика.** `agreementTarget(record, trial)` возвращает `control`, `undecided` или `ready` с метрикой, вердиктом судьи и признаком «этот успех взят на проверку». Решение судьи читается прямо из `trial.assessments`, а не из `agentMetricResult`: иначе отметка сравнивалась бы с вердиктом, который сама и изменила. 03-05 возьмёт ту же функцию для блока F10, и клавиши с блоком не разойдутся.
- **Отметка пишется только с доски и только из родного диалога Pi.** Ветка `agree` в цикле `/agent-lab` зовёт `lab.addHumanReview` с `source: 'quick'`: «согласен» — вердикт судьи, «не согласен» — противоположный, «не могу сказать» — `unknown`. «Не согласен» всегда открывает редактор Pi, подставляя уже написанную причину, — тем же `n` она и правится. Закрытый редактор не пишет ничего и молчит; пустая причина названа: `Несогласие не сохранено: напишите причину.`
- **Каждый край назван словами и ничего не пишет.** Тот же ответ второй раз — `Отметка уже стоит: согласен.` (или «не согласен» / «не могу сказать»). Та же причина второй раз — `Отметка уже стоит: не согласен.` Причина длиннее 3000 знаков — `Причина длиннее 3000 знаков. Сократите и попробуйте снова.` Решение судьи изменилось, пока владелец смотрел, — лаборатория отказывает своим текстом `Оценка судьи изменилась, пока вы смотрели. Проверьте ситуацию ещё раз.` Во всех случаях запись не меняется.
- **Доска возвращается с отчётом о том, что засчитано.** `Отмечено: согласен с судьёй · «<название>». Проверено провалов: 1 из 2.` (а на прогоне без провалов — `Проверено успехов: 1 из <S>.`), `Отмечено: не согласен · «…». Итог пересчитан с учётом вашей отметки.`, `Отмечено: не могу сказать · «…». В итоге остаётся оценка судьи; чтобы закрыть ситуацию, позже нажмите y или n.` Отметка на завершённом прогоне снова открывает разбор, и уведомление добавляет ` Разбор снова открыт: f — завершить.` — прогон действительно возвращается в `results_review`.
- **Шаг завершения перестал звать снятые клавиши.** `f` с неразобранной ситуацией теперь говорит `Не разобрано ситуаций: 1. y / n — согласие с судьёй · v — подробная оценка.` и открывает раздел 3 с фильтром, а подтверждение аудита несёт строку `Отметка согласия ставится на главную оценку ситуации; остальные критерии — через v.` прямо под строкой о заметках человека — владелец знает, что именно он подтверждает.
- **Список сам ведёт по очереди.** `reviewOrder` начинается с провалов из очереди, на которые владелец ещё не ответил, в порядке записи; за ними идут взятые на проверку успехи, и только потом сегодняшний ранг. Ответ уводит ситуацию из очереди, поэтому та же позиция списка показывает следующий случай — навигация не нужна. На записи с 13 провалами и одним проверяемым успехом успех стоит четырнадцатым.
- **Каждая строка говорит, где ситуация стоит.** `● ПРОВЕРЬТЕ ПРОВАЛ` и `● ПРОВЕРЬТЕ И УСПЕХ` до ответа; `НЕ ПРОЙДЕНО · … · = согласен` после согласия; `НЕСОГЛАСИЕ С СУДЬЁЙ · …` без суффикса после несогласия; `● ПРОЙДЕНО · … · ~ не могу сказать` после сомнения — точка ставится ровно один раз, хотя сегодняшнее правило добавило бы вторую. Фильтр `u` держит непроверенные успехи, а не только сегодняшние ожидания.
- **Чужой текст по-прежнему не доходит до терминала.** Название ситуации с управляющей последовательностью печатается без неё и со всеми словами — и в списке, и в боковой колонке; причина владельца проходит через `safeText` в уведомлении.

## Task Commits

1. **Task 1 (tracer): одна клавиша отмечает согласие владельца с судьёй** — `23c0a9d` (feat)
2. **Task 2 (TDD): повторы, длинные причины, отказы лаборатории и шаг завершения** — `7987c4e` (test, RED) → `360a860` (feat, GREEN)
3. **Task 3 (TDD): очередь разбора, ярлыки строк и фильтр «только неразобранные»** — `190d075` (test, RED) → `ba76551` (feat, GREEN)

**Plan base:** `0f73fb38` (`plan_head_before`) · **Commits measured:** 5 (`git rev-list --count 0f73fb38..HEAD`, снято в момент написания этой выжимки).

Все пять — этого плана; параллельная сессия, делящая этот worktree, за это окно ничего не залила. Если пересчитать позже, число вырастет на её `docs(…)` коммиты по фазам 03.1 / 05 / 06 — ни один не трогает файлы этого плана.

## TDD Gate Compliance

| Задача | RED | GREEN | REFACTOR | Итог |
|---|---|---|---|---|
| Task 2 | `7987c4e` `test(03-04): …` — `RED_EVIDENCE_OK`, целевой тест упал на нужном утверждении (`# tests 30 / # pass 28 / # fail 2`) | `360a860` `feat(03-04): …` — `# fail 0` | не понадобился | Pass |
| Task 3 | `190d075` `test(03-04): …` — `RED_EVIDENCE_OK` (`# tests 30 / # pass 27 / # fail 3`) | `ba76551` `feat(03-04): …` — полный набор `# tests 494 / # pass 494 / # fail 0` | не понадобился | Pass |

Обе записи RED проверены `gsd-tools check tdd-red-evidence` и вернули `RED_EVIDENCE_OK` (`reason: target_test_failed`).

Первая попытка RED у задачи 3 была отвергнута как `INVALID_RED`: тест импортировал ещё не существующий `resultEntries`, и весь файл не загрузился (`fixture_or_load_failure`) — падение загрузки не доказывает поведение. Поэтому в коммит RED вошёл сам шов: `resultEntries` вынесен из приватного `entries()` с сегодняшним поведением, без единого правила F12. После этого целевой тест упал на настоящем утверждении о порядке (`+ 'sim'` вместо `- 'P2'`), и только тогда GREEN добавил правила очереди и ярлыков.

## Files Created/Modified

- `extensions/cards.ts` — `agreementTarget` (+ тип `AgreementTarget`); вариант `agree` в `BoardAction` вместо снятого `verdict`; клавиши `y` / `n` / `s` в `handleInput`; `finish()` цепляет `reviewMs` к `agree`; `reviewOrder` с группами очереди; новый экспорт `resultEntries` с ярлыками F12, суффиксами и признаком `waiting`, на который опирается фильтр `u`.
- `extensions/agent-lab.ts` — ветка `agree` в цикле `/agent-lab` (редактор причины, проверки повтора и длины, запись `source: 'quick'`, `durationMs`, уведомления C-92…C-98); текст отказа `f` заменён на C-102; в тело подтверждения аудита добавлена строка C-65.
- `test/cards.test.ts` — `judgedFixture` и `queueFixture` + `quickMark`; тест времени чтения переписан на `agree`; тест порядка разбора и тест фильтрованного разбора обновлены сознательно; три новых теста: область действия клавиш, очередь с ярлыками и фильтром, 13 провалов + 1 успех, управляющая последовательность в названии.
- `test/extension.test.ts` — `boardFixture` / `boardSession` / `judgedSituations`; демо-путь `['3', 'n']` заменён на `['3', 'y']` с проверкой самой отметки; три новых пути: базовые ответы на доске, края одноклавишного разбора, завершённый прогон и прогон без провалов, шаг завершения.

## Verification

| Проверка | Результат |
|---|---|
| Task 1 `<verify>`: `snap-test.sh test/cards.test.ts test/extension.test.ts` | `# tests 54 / # pass 54 / # fail 0`, exit 0 |
| Task 2 `<verify>`: `snap-test.sh test/extension.test.ts test/cards.test.ts` | `# tests 57 / # pass 57 / # fail 0`, exit 0 |
| Task 3 `<verify>` и `<verification>` плана: `snap-test.sh` без аргументов (все тесты + typecheck расширения) | `# tests 494 / # pass 494 / # fail 0`, exit 0 |
| `grep -c "type: 'agree'" extensions/cards.ts` ≥ 1 · `grep -c "export function agreementTarget"` = 1 | 2 · 1 |
| `cat extensions/cards.ts extensions/agent-lab.ts \| grep -c "type: 'verdict'"` = 0 · `grep -c "action.type === 'verdict'" extensions/agent-lab.ts` = 0 | 0 · 0 |
| `grep -c "action.type === 'agree'" extensions/agent-lab.ts` = 1 · `grep -c "source: 'quick'"` ≥ 1 | 1 · 1 |
| `grep -c "Почему вы не согласны? Коротко, своими словами." extensions/agent-lab.ts` = 1 | 1 |
| `test/extension.test.ts` содержит `['3', 'y']` и `Проверка: судья не учёл уточнение клиента.` | 1 · 3 |
| `grep -c "Причина длиннее 3000 знаков. Сократите и попробуйте снова." extensions/agent-lab.ts` = 1 | 1 |
| `grep -c "Не разобрано ситуаций: " extensions/agent-lab.ts` = 1 · `grep -c "Осталось разобрать"` = 0 | 1 · 0 |
| `grep -c "Отметка согласия ставится на главную оценку ситуации; остальные критерии — через v." extensions/agent-lab.ts` = 1 | 1 |
| `grep -c " Разбор снова открыт: f — завершить." extensions/agent-lab.ts` = 1 | 1 |
| `test/extension.test.ts` содержит C-99 и импортирует `assertPlainCopy` | 1 · 4 упоминания |
| `grep -c "ПРОВЕРЬТЕ И УСПЕХ" extensions/cards.ts` = 1 · `ПРОВЕРЬТЕ ПРОВАЛ` = 1 · `НЕСОГЛАСИЕ С СУДЬЁЙ` = 1 | 1 · 1 · 1 |
| `grep -c "judgeAgreement(record)" extensions/cards.ts` ≥ 1 | 2 |
| `test/cards.test.ts` содержит ` · = согласен` и ` · ~ не могу сказать` | 1 · 1 |

Все критерии приёмки трёх задач выполнены.

## Decisions Made

- **Решение судьи читается из записи, а не из наложенного вердикта.** `agreementTarget` смотрит в `trial.assessments`, повторяя правило `judgeAgreement`. Иначе согласие всегда совпадало бы само с собой.
- **Тест отказа лаборатории отвечает новым ответом.** Правило «отметка уже стоит» по контракту (F13 шаг 2) стоит раньше отказов лаборатории (шаг 6). Крафт действия с устаревшим вердиктом судьи поверх уже стоящего «согласен» перехватывался первым правилом — и это верно. Тест теперь отвечает `не могу сказать`, отказ доходит, ничего не пишется. Оба правила проверены, ни одно не ослаблено.
- **Список раздела 3 вынесен в экспортируемую `resultEntries`.** Боковая колонка обрезает строку до 32 колонок, поэтому отрисованная доска не может доказать ни ярлык, ни суффикс. Экспорт возвращает `{ id, text, waiting }`, где `waiting` — ровно предикат фильтра `u`; сам `entries()` стал фильтром над ним.
- **Сортировка осталась «ранг, затем порядок записи».** `agreementSample` отдаёт выборку в порядке хеша; вторичный ключ по индексу записи возвращает её в порядок записи, как требует F12, без отдельного кода.
- **Проверка длины считает знаки до обрезки пробелов.** Схема ограничивает `note` тремя тысячами знаков; проверка стоит на сыром тексте редактора, поэтому владелец получает понятную просьбу сократить, а не ошибку записи.

## Deviations from Plan

### Изменённые ожидания тестов (сознательно, как требует план)

**1. Тест времени чтения (`a quick verdict includes time spent reading…`)**
- Его диалог не имел решения судьи, поэтому новые клавиши на нём были бы инертны. Диалог получил рубрику `goal` и записанную оценку `fail`; `n` теперь даёт `agree` с `answer: 'disagree'`, а проверка `reviewMs >= 115` сохранена. Тест переименован в `a quick agreement mark includes…`.

**2. Тест порядка разбора (`разбор начинается с провалов без вердикта…`)**
- `p` больше ничего не отправляет (UI-D-02) — проверено явно. `y` даёт `agree` с вердиктом судьи. После задачи 3 первым в списке стоит `t_done`, а не `t_pending`: вердикт по диалогу целиком — не отметка согласия, поэтому такой провал остаётся в очереди согласия. Ожидание порядка записано целиком (`['t_done', 't_pending', 't_pass']`) с объяснением.

**3. Тест фильтрованного разбора (`filtered review targets the visible trial ID…`)**
- Диалогам добавлена записанная оценка судьи, `n` теперь даёт `agree` вместо `verdict`. Проверка «справка не отправляет ответ случайно» сохранена.

**4. Демо-путь в `test/extension.test.ts`**
- `steps = [['3', 'n'], ['f'], ['q']]` → `[['3', 'y'], ['f'], ['q']]`. Добавлены проверки самой отметки: `source: 'quick'`, метрика равна `primaryMetricId`, вердикт равен записанной оценке судьи, заметка — `Быстрая отметка: согласен с судьёй.`, `durationMs` — число. Фаза по-прежнему доходит до `complete`.

### Отклонения по правилам

**Нет.** Правила 1–4 не применялись: ошибок, недостающей критичной функциональности и блокеров по ходу не возникло, архитектурных развилок не было.

**Total deviations:** 0 автоисправлений; 4 сознательно изменённых ожидания тестов, все названы выше и предусмотрены планом.

## Authentication Gates

Нет. Ни одного вызова модели, ни одного платного обращения, агент эквайринга не запускался. Все проверки идут на встроенном демо-прогоне в временных папках.

## Issues Encountered

- **Не перезапускать Pi в этом worktree до 03-07.** `extensions/cards.ts` теперь импортирует `../dist/agreement.js` и `../dist/outcomes.js`, а `extensions/agent-lab.ts` — `../dist/agreement.js`. Рабочий `dist/` не пересобирался (это задача 03-07, её надо согласовать с другими сессиями). Тесты не затронуты: они собирают свой `dist/` внутри снимка.
- **Справка и подвал доски ещё зовут снятые клавиши.** Строка справки `p / n — вердикт на выбранный диалог · v — оценить критерий` и подвал `a Обсудить · p Пройдено · n Провал · v Оценка · f Завершить` остались от фазы 2 — по плану их меняет 03-05 (C-87…C-90). До тех пор подвал называет `p`, который ничего не делает.
- **Строка `trialLines` про `p — пройдено, n — не пройдено` тоже осталась** — это C-77/C-78, их заменяет 03-05 вместе с блоком F10.
- **Параллельная сессия** правит `.planning/phases/03.1-…`, `05-…` и `06-…` в этом же worktree. Ничего из этого не трогалось и не ставилось в индекс.

## Known Stubs

Нет. Каждая строка и каждое уведомление построены на сохранённых данных и покрыты проходящим тестом; ни одна ветка не возвращает заглушку.

## Threat Flags

Нет нового. Реестр плана отработан:

- **T-03-12** (отметка без владельца) — единственный путь записи это действие `agree` с доски, причина приходит только из `ctx.ui.editor`; запрет на запись из чата проверен тестом 03-03.
- **T-03-13** (устаревшее решение судьи) — действие несёт показанный вердикт, лаборатория отказывает, отказ проверен тестом.
- **T-03-14** (управляющие последовательности) — `inform` и список идут через `safeText`; тест кормит название с ESC-последовательностью.
- **T-03-15** (слишком длинная причина) — проверка 3000 знаков до записи, тест на 3001.
- **T-03-16** (тихое переоткрытие завершённого прогона) — суффикс C-98 и тест, что прогон вернулся в `results_review`.
- **T-03-SC** — ни одного пакета не устанавливалось.

Новых сетевых точек, путей авторизации, обращений к файлам и изменений схем на границе доверия нет.

## User Setup Required

Нет.

## Next Phase Readiness

- **03-05** берёт `agreementTarget` для блока F10 (доказательство раньше вердикта) и обязан заменить справку (C-87…C-89), подвал (C-90) и строки `trialLines` (C-77/C-78): до этого подвал называет снятый `p`.
- **03-05** также ставит заголовок раздела 3 (F11) поверх сегодняшнего `Разбор: осталось N провал(ов)…`; счёт «проверено» должен совпадать с `failures.checked` / `sampleChecked`, которые уже считает уведомление C-95.
- **03-06** рендерит несогласия на доске; `resultEntries` уже метит такие строки как `НЕСОГЛАСИЕ С СУДЬЁЙ`, и обе поверхности должны читать один и тот же `judgeAgreement`.
- **03-07** пересобирает и подменяет `dist/` — без этого живое расширение Pi не загрузится.
- Открыто на проверку фазы: coverage D11 — владелец проходит настоящий прогон эквайринга одной клавишей на ситуацию, в светлой и тёмной теме Pi.

---
*Phase: 03-soglasie-cheloveka-s-sudey*
*Completed: 2026-09-17*

## Self-Check: PASSED

- `extensions/cards.ts`, `extensions/agent-lab.ts`, `test/cards.test.ts`, `test/extension.test.ts` и эта выжимка существуют на диске.
- Коммиты `23c0a9d`, `7987c4e`, `360a860`, `190d075`, `ba76551` есть в `git log`; `git rev-list --count 0f73fb38..HEAD` = 5, совпадает с `commits: 5`.
- `<verification>` плана перепроверен на финальном дереве: `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh` → exit 0, `# tests 494 / # pass 494 / # fail 0`.
- Все критерии приёмки трёх задач перепроверены grep-ом на финальном дереве (таблица «Verification»).

---
gsd_state_version: "1.0"
current_phase: 2
current_phase_name: Судья объясняет провалы
status: verifying
stopped_at: Completed 02-09-PLAN.md
last_updated: "2026-09-17T10:39:13.688Z"
last_activity: 2026-09-17
last_activity_desc: Phase 2 execution started
state_head: c44f927242b74e6fe7f29b8d0b20d91f2750f0c9
progress:
  total_phases: 7
  completed_phases: 1
  total_plans: 50
  completed_plans: 21
  percent: 14
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-09-16)

**Core value:** Владелец агента и заказчик за 10 секунд понимают, насколько хорош агент и почему он ошибается, и верят этому числу.
**Current focus:** Phase 2 — Судья объясняет провалы

## Current Position

Phase: 2 (Судья объясняет провалы) — EXECUTING
Plan: 9 of 9
Status: Phase complete — ready for verification
Last activity: 2026-09-17 — Phase 2 execution started

Progress: [█░░░░░░░░░] 14%

## Performance Metrics

**Velocity:**

- Total plans completed: 12
- Average duration: -
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1 | 12 | - | - |

**Recent Trend:**

- Last 5 plans: -
- Trend: -

*Updated after each plan completion*
**Per-Plan Metrics:**

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 01 P01 | 7 min | 2 tasks | 10 files |
| Phase 01 P02 | 5min | 2 tasks | 6 files |
| Phase 01 P03 | 4min | 3 tasks | 8 files |
| Phase 01 P04 | 4min | 2 tasks | 5 files |
| Phase 01 P05 | 5min | 2 tasks | 6 files |
| Phase 01 P06 | 5min | 2 tasks | 4 files |
| Phase 01 P07 | 12min | 2 tasks | 5 files |
| Phase 01 P08 | 7min | 2 tasks | 6 files |
| Phase 01 P09 | 12min | 2 tasks | 8 files |
| Phase 01 P10 | 28min | 3 tasks | 4 files |
| Phase 01 P11 | 5 min | 2 tasks | 7 files |
| Phase 01 P12 | 6min | 3 tasks | 3 files |
| Phase 02 P01 | 10min | 2 tasks | 8 files |
| Phase 02 P02 | 15min | 2 tasks | 7 files |
| Phase 02 P03 | 7min | 2 tasks | 14 files |
| Phase 02 P04 | 8min | 3 tasks | 7 files |
| Phase 02 P05 | 55min | 3 tasks | 9 files |
| Phase 02 P06 | 8min | 2 tasks | 2 files |
| Phase 02 P07 | 34min | 2 tasks | 7 files |
| Phase 02 P08 | 78min | 3 tasks | 4 files |
| Phase 02 P09 | 12min | 2 tasks | 1 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: фаза «Прод рядом с тестом» из research/SUMMARY.md убрана (прод отложен решением пользователя 2026-09-16).
- [Roadmap]: живой прогресс (SCREEN-06) входит в фазу экрана (Phase 4), потому что использует общий рендерер и тему.
- [Roadmap]: лист ожиданий (TRUST-10/11) входит в Phase 2 и отрезается первым, если фаза не успевает к заморозке протокола.
- [Roadmap]: согласие человека (Phase 3) идёт после объяснений (Phase 2) и до экрана (Phase 4). Phase 4 и Phase 5 можно вести параллельно.
- [Roadmap]: Phase 6 (старт) — хвост, который можно отрезать. Phase 7 (демо) не отрезается, у неё фиксированная дата.
- [Scope]: карточки остаются внутренним форматом, на экранах называются «ситуации». Побочные ветки (discovery-гипотеза, одиночный тест, правка промпта, эталоны, профили, старая песочница) скрываются в Phase 6 (START-04), код удаляется после демо (v2 CLEAN-01).
- [Phase 01]: 01-01: незапущенный черновик показывает только «Прогон ещё не запускался.», без строк «Ещё проверяется» и «Не измерено»
- [Phase 01]: 01-01: причины «не измерено» проверяются в фиксированном порядке NOT_MEASURED_CODES, он же порядок при равных счётах
- [Phase 1]: 01-02: Pi board and tool result print resultViewLines verbatim; a supplied view is used only when view.runId equals the shown record id
- [Phase 1]: 01-03: DEFAULT_GOAL_OBSERVATION lives in contracts.ts; normalizeScenarioIdentity applies only to comparison identity
- [Phase 1]: 01-03: an incomplete judge record makes only its pair incomparable; mixed protocol or another judge model still blocks the whole diff
- [Phase 1]: 01-03: validate replay sets goal.id = dialogue.id; colliding model ids are recorded as a limitation
- [Phase 1]: 01-04: a judge receipt alone never proves a judgment; the verifier re-derives the input hash and re-aggregates votes; a trial with full judgeAudit is always checked by it
- [Phase 1]: 01-04: judge audit sidecar {id}.judge/{trialId}.json is written synchronously (tmp+rename, 0700/0600); assessRepeated reports exactly one final judgment
- [Phase 1]: 01-05: a reassessment counts a card only when its record attempts are exactly the source attempts of that card
- [Phase 1]: 01-05: stability never changes the headline; a skipped check is printed in words, never as a silent 0
- [Phase 1]: 01-06: judged trials keep only judgeReceipt; full audit in {runId}.judge sidecar, journal one line per finished judgment
- [Phase 1]: 01-07: suiteEvidence seals legacy judge audits into receipts at copy time; reports name the journal and judge sidecar files instead of embedding them
- [Phase 1]: 01-08: scoreSettings is the one score settings helper for CLI and Pi; score records force repeats 1 and userModes ['scripted']
- [Phase 1]: 01-08: Pi payload view comes from evidenceBundle(...).view at every bundle site
- [Phase 1]: 01-09: Контрольная ситуация хранится в записи прогона (positiveControlScenarioIds), не в карточке; draftHash старых записей не меняется
- [Phase 1]: 01-09: Явный --control вне оставленных --case отклоняется ошибкой; унаследованный контроль, выпавший из --case, убирается
- [Phase 1]: [01-10]: ae812a24 не годится как положительный контроль — за 3 живые попытки цель не засчитана; нужен другой контрольный кейс (кандидат — единственная засчитанная карточка a92fd6ae)
- [Phase 1]: [01-10]: «судья не оценивал» важнее «судья не уверен в симуляторе», когда оценок нет вовсе (ca55767)
- [Phase 1]: 01-11: a positive control always runs as one turn (maxFollowUps 0) in repeat/loadSuite; compareRuns leaves controls of either run out of the diff, identity taken from the original records
- [Phase 1]: [01-11]: a positive control runs as one turn (opening + first reply, no simulator) and is left out of the repeat diff and the instability check
- [Phase 1]: [01-12]: TRUST-04 closed on live evidence — real control ae812a24 passed as one turn in c1b9f043 (repeat of a92fd6ae), $0.2413
- [Phase 2]: Judge protocol v11 (9b08dc89) judges agent rubrics on the prefix before the first simulator deviation cited by a failing fidelity vote; V10 (32c413cf) stays verifiable
- [Phase 2]: goal-v2: a situation judged before a receipt-confirmed simulator cut is decided by its goal votes; strict outcomes still require fidelity
- [Phase 2]: 02-03: пилот v11 (17d77d54 — пилот, не результат) решил 0/3 ситуаций → NO-GO; протокол судьи остаётся v10, код 02-01/02-02 откатан (c8b9e27); запись пилота не читается под v10 и не проверяется; формулировка UI-D-11 (C-50) откатана вместе с кодом; потрачено $0.43 из $6
- [Phase 2]: 02-04: failure explanations are built from stored data only; owner rule numbers = source order, quote offset, array index; no cut row (v10 kept)
- [Phase 2]: 02-04: knowledge sources in fae4ee59/a92fd6ae have 5 lines, so every rule row shows «, строка L» (UI-SPEC one-line assumption is wrong; rule kept as written)
- [Phase 2]: [Phase 2]: 02-06: live dist/ rebuilt from HEAD 83882d7 after a pgrep+lock check; previous build kept at .gsd/dist-before-02-06-20260917-123753
- [Phase 2]: [Phase 2]: 02-06: explanations proved on the real acquiring runs — 9/9 and 7/7 failed situations explained, judge-cited 100%, 0 unverified rows, 0 jargon or «…» hits before «Подробности:»; board fits 40–160 columns with nothing truncated
- [Phase 2]: [Phase 2]: 02-06: v11 steps (RE11/A11/NEW11, «Оценено до реплики #», goal-v2) skipped — 02-03 NO-GO, protocol frozen at v10; cut columns printed as -/0
- [Phase 2]: [Phase 2]: 02-07: подтверждение накрывает весь черновик (acceptDraft), одиночный тест остаётся частным случаем на одну ситуацию; CLI ветвится по scenarios.length > 1
- [Phase 2]: [Phase 2]: 02-07: слова владельца попадают и в successCriteria, и в passCriteria рубрики goal_attainment дословно; ситуация помечается в записи (ownerExpectationScenarioIds), draftHash старых записей не меняется, measurementHash не трогается
- [Phase 2]: [Phase 2]: 02-07: отказ updateDraft «ожидание изменилось, проверки прежние» снимается только для ситуаций с судейской рубрикой goal_attainment; requireAccepted пока никем не вызывается — подключает 02-08
- [Phase 2]: Оба Pi-пути запуска записывают reviewMode: 'human' вместе с requireAccepted: true — запуск невозможен без подтверждённых ожиданий, поэтому оговорка об автоматической проверке была бы ложью
- [Phase 2]: y и e привязаны только к листу ожиданий раздела 2 черновика; фаза 3 может занять y только в области результатов и не должна трогать e
- [Phase 2]: [Phase 2]: 02-09: final dist built from HEAD 376562e after 443/443; previous build kept at .gsd/dist-before-02-09-20260917-133450 — the next Pi start gets the whole expectations sheet
- [Phase 2]: [Phase 2]: 02-09: TRUST-10/11 proved on the real acquiring draft 37f78e1a (13 situations, 55 rule rows, 0 unverified): owner text verbatim in successCriteria, the goal rubric and the judge input; 13 confirmed in one step; board fits 40-160 columns; y/e map to accept/expect
- [Phase 2]: [Phase 2]: 02-09: the confirmed draft stays local and unrun — diff against its source is incomparable by construction, but names «Содержимое карточек изменилось»; the live light/dark Pi check is carried to phase 4 as a backstop

### Pending Todos

None yet.

### Blockers/Concerns

- Календарь: заморозка протокола судьи — конец пт 2026-09-18 (после неё одна переоценка старых прогонов); заморозка кода — сб 2026-09-19; вс 2026-09-20 — только репетиция; демо — пн 2026-09-21.
- Phase 2: до правки протокола измерить на `fae4ee59`, какой источник «без решения» преобладает.
- Phase 3/4: клавиши согласия не должны конфликтовать с клавишами доски `p`/`n`/`v`/`x`/`d`.
- Phase 4: нужен живой спайк рендера `renderResult` и custom entry в Pi 0.85.1.
- Рабочая среда: `npm test` удаляет `dist/`, который импортирует живое расширение Pi; тесты гонять из снимка `git archive HEAD`. Новые записи со строгой схемой не читаются старым `dist/`, поэтому пересборку и перезапуск Pi нужно согласовать с другими сессиями.
- Доказательства из `.agent-lab` копировать за пределы workspace до его удаления.
- Цель «согласие ≥90%» статистически не показать при n≈10: показывать как «N из M» с оговоркой.
- Phase 1 SC5 (TRUST-04) closed on live evidence: real control passed as one turn in c1b9f043 (repeat of a92fd6ae); demo note: the fae4ee59-based set has the fae card version of ae812a24 (goal votes 1 pass in 8), so a demo record with a passing control should be a repeat of a92fd6ae with --control ae812a24 (15 cards, about $2.1), decided in phase 7 prep

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-09-17T10:39:03.365Z
Stopped at: Completed 02-09-PLAN.md
Resume file: None

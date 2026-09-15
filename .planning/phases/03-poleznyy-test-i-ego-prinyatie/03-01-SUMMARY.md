---
phase: 03-poleznyy-test-i-ego-prinyatie
plan: 01
subsystem: evaluation
tags: [tdd, scenario-generation, grounding, rubrics, zod]
requires:
  - phase: 02-ponimanie-agenta-i-gipoteza
    provides: Conservative evidence judge, dialogue evidence, and shared rubric contracts
provides:
  - Explicit confirmed-hypothesis preparation mode that publishes exactly one repaired test
  - Full-token owner/user grounding with a deterministic 20-value limit
  - Separate ownership for model goal, harness service, and owner-added rubrics
affects: [03-02, 03-03, 03-04]
tech-stack:
  added: []
  patterns:
    - Explicit confirmedHypothesis discriminator at the existing Runtime.prepare seam
    - Whole-candidate bounded repair before stored-state publication
    - Harness rubric decoration after generated-output validation
key-files:
  created: []
  modified:
    - src/contracts.ts
    - src/experiment.ts
    - src/pi.ts
    - test/contracts.test.ts
    - test/pi.test.ts
key-decisions:
  - "Строгий режим одной карточки включается только explicit-полем confirmedHypothesis; scenarioCount=1 сохраняет прежнюю семантику для обычной генерации, golden и recorded-dialogue вызовов."
  - "Канал наблюдения определяется структурой executable checks и rubric subject, а не ключевыми словами successCriteria; assistant prose по-прежнему не доказывает действие."
  - "В confirmed-режиме только owner sources и user-authored dialogue turns служат grounding evidence; диалоги не становятся скрытыми production-кандидатами."
requirements-completed: [LOOP-04, CARD-01, CARD-02, CARD-03, CARD-04]
patterns-established:
  - "Confirmed preparation: gate strict behavior with an explicit input discriminator, never an incidental count."
  - "Generated output validation precedes service-rubric decoration and stored-state validation."
coverage:
  - id: D1
    description: "Одна confirmed hypothesis публикует ровно один complete observable generated test после bounded repair."
    requirement: LOOP-04
    verification:
      - kind: integration
        ref: "test/pi.test.ts#confirmed hypothesis repairs zero, duplicate and blank candidates before publishing exactly one complete test"
        status: pass
      - kind: integration
        ref: "test/pi.test.ts#confirmed hypothesis repairs seeded state until an exact state check resolves in it"
        status: pass
    human_judgment: false
  - id: D2
    description: "Answer values проходят full-token grounding только по owner/user evidence и соблюдают границу 20/21."
    requirement: CARD-04
    verification:
      - kind: unit
        ref: "test/contracts.test.ts#valueTokens keeps Unicode, case and full-token boundaries exact"
        status: pass
      - kind: integration
        ref: "test/pi.test.ts#confirmed answer values use owner and user evidence, inspect every token, and enforce the 20-value limit"
        status: pass
    human_judgment: false
  - id: D3
    description: "Generated, harness и owner rubrics имеют непересекающееся владение."
    requirement: CARD-03
    verification:
      - kind: integration
        ref: "test/pi.test.ts#confirmed generation reserves goal attainment for the model and decorates only applicable harness rubrics"
        status: pass
    human_judgment: false
actuals:
  tokens: 7393
  tasks: 3
  commits: 7
plan_head_before: 6caa94fd839f1557312ed5496244a6785f4d3d85
duration: 20m
completed: 2026-09-15
status: complete
---

# Phase 3 Plan 1: Confirmed Test Preparation Summary

Подтверждённая гипотеза теперь проходит через строгую публикацию одной карточки, полное token-grounding и раздельное владение generated/harness/owner рубриками на существующем Runtime/Zod repair seam.

## Performance

- **Duration:** 20m
- **Started:** 2026-09-15T19:14:08Z
- **Completed:** 2026-09-15T19:34:18Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- Добавлен явный `confirmedHypothesis`-режим: ноль, несколько, дубликаты и неполные кандидаты целиком возвращаются в bounded repair, а в review публикуется ровно одна карточка.
- Каналы наблюдения выводятся из `answer_*`/goal, положительных tool checks и `state_equals`; seeded state требует разрешимого exact-state пути, не ослабляя консервативный Phase 2 judge.
- Все answer tokens сверяются по case-insensitive full-token equality только с owner sources и сообщениями пользователя; 20 уникальных значений допускаются, 21 отправляет всю карточку на repair без усечения.
- Model-authored output содержит только `goal_attainment`; `prompt_compliance` и `user_fidelity` добавляются harness-слоем лишь при фактических условиях, owner rubrics не нормализуются повторно.
- Интеграционный тест подтверждает, что confirmed dialogue используется как evidence и не импортирует скрытые production cards.

## Task Commits

Каждый TDD-шаг зафиксирован отдельно:

1. **Task 1 RED — confirmed publication cases:** `c8b2eb9`
2. **Task 1 GREEN — one confirmed generated test:** `eece5c2`
3. **Task 2 RED — grounding boundary cases:** `f5852bb`
4. **Task 2 GREEN — grounded answer values:** `3914f0c`
5. **Task 3 RED — rubric ownership case:** `9bad68a`
6. **Task 3 GREEN — generated/harness rubric split:** `162f986`
7. **Key-link integration coverage:** `cd36612`

## Files Created/Modified

- `src/contracts.ts` — добавляет backward-compatible discriminator и evidence/mode inputs для confirmed preparation.
- `src/experiment.ts` — передаёт точный confirmed context и исключает profiles/goals production expansion в этом режиме.
- `src/pi.ts` — реализует строгую schema/review публикацию, grounding, observability и rubric ownership.
- `test/contracts.test.ts` — фиксирует Unicode, case-folding и full-token semantics `valueTokens`.
- `test/pi.test.ts` — покрывает cardinality, state/tool/reply channels, grounding 20/21, rubric conditions и ExperimentLab boundary.

## Decisions Made

- Строгая cardinality привязана к `confirmedHypothesis`, а не к `scenarioCount`, чтобы не изменить обычные и импортные вызовы.
- Валидность предложенного observation channel остаётся в exact owner acceptance; генератор лишь требует структурно объявленный executable channel.
- Для seeded state проверяется существование каждого exact `state_equals` пути, но initial value не приравнивается к ожидаемому финальному значению: состояние может законно измениться во время сценария.
- Dialogue grounding читает только `role: 'user'`; assistant turns и outcomes исключены из oracle.

## TDD Gate Compliance

| Task | RED evidence | RED commit | GREEN commit | Result |
| ---- | ------------ | ---------- | ------------ | ------ |
| 1 | Generated candidate cardinality/state publication assertions failed against legacy behavior | `c8b2eb9` | `eece5c2` | PASS |
| 2 | Fully grounded later candidate remained rejected without owner/user token oracle | `f5852bb` | `3914f0c` | PASS |
| 3 | Model prompt still requested harness-owned rubrics | `9bad68a` | `162f986` | PASS |

## Verification

- `npm run build && npx tsx --test test/pi.test.ts && npm run typecheck` — PASS after tracer implementation and feedback gate.
- `npx tsx --test test/contracts.test.ts test/pi.test.ts` — PASS, 76 focused tests at Task 2.
- `npm run build && npx tsx --test test/contracts.test.ts test/pi.test.ts && npm run typecheck` — PASS, 77 focused tests at Task 3.
- `npm test && npm run typecheck` — PASS, 309/309 tests.
- `git diff --check` — PASS.
- Dependency/module guard — PASS: package manifests unchanged; no new source module.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Issues Encountered

- Первичный sandbox-запуск `tsx` получил локальный IPC `EPERM`; тот же обязательный тестовый gate был выполнен с разрешённым process access и прошёл без изменения кода.

## User Setup Required

None - no external service configuration required.

## Self-Check: PASSED

- Все пять изменённых plan-файлов существуют.
- Все семь task/TDD-коммитов присутствуют в истории.
- `03-01-SUMMARY.md` создан и содержит проверенные команды и measured actuals.

## Next Phase Readiness

- LOOP-04 и CARD-01..04 имеют исполняемое покрытие и готовы для UI/edit lifecycle в следующих планах Phase 3.
- Блокеров для 03-02 нет.

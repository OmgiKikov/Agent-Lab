# Phase 2: Судья объясняет провалы - Research

**Researched:** 2026-09-17
**Domain:** Failure explanations built from stored evidence, one versioned change to the judge protocol, and owner sign-off on expectations before a run, in an existing TypeScript agent evaluation harness (Pi extension plus CLI)
**Confidence:** HIGH for the measurements and code paths (read-only scripts over `.agent-lab` with `tsx` against `src/` at HEAD `1dfb8a0`). MEDIUM for the expected reduction after the protocol change, which is a prediction until the paid reassessment runs.

## Summary

Phase 2 needs no new libraries. It has three parts that can be built separately, plus a live check.

1. **JUDGE-01/02 can be built for free from stored data.** On the pilot runs `fae4ee59` and `a92fd6ae` there are 16 failed situations. All 16 have a success criterion (X). All 16 have an agent reply cited by the judge, and the quote appears verbatim in the event text (Y). All 57 rule references of those cards resolve to a requirement whose quote is verbatim in its owner source (N) [VERIFIED: read-only script, counts below]. Rule numbers need their own design: requirement ids are model-chosen slugs that differ between the two runs, and the model returns prompt rules out of source order. The stable number comes from where the quote sits in the owner's materials (Pattern 2). The judge's own numbering in `observableSources` is never shown.
2. **JUDGE-03: the dominant source of «без решения» is simulator fidelity, and the literal candidate (a) would recover nothing.** The two runs have 10 undecided situations caused by the judge. 8 are simulator reasons (6 `simulator_deviated`, 2 `simulator_unclear`) and 2 are `judge_split`. In **all 8** simulator cards the goal verdict is an agreed 2/2 **FAIL**, and the first deviation comes **before** the last agent reply the goal votes cite (8/8). Candidate (a) as written ("deviations after the decisive reply do not count") therefore recovers 0 cards. Candidate (c), a counting rule with no protocol change, cannot honestly keep these FAIL verdicts: the goal votes cite the deviating turn or replies after it. Candidate (b), 3 votes by majority, reaches at most 4 of 10 and does nothing for the 6 cards where both fidelity votes already agree on fail.
   **Recommended single change (protocol v11): judge the agent on the faithful prefix.** The fidelity rubric is judged first on the whole dialogue. If a fidelity vote fails, the harness cuts the dialogue before the first deviation that vote cites, and the agent rubrics are judged on that prefix. A cut is computable on 8/8 simulator cards, and 7/8 prefixes end on the agent's first reply. The expected result on the pilots is «без решения» 4→~1 on `fae4ee59` and 7→~2 on `a92fd6ae` [ASSUMED until measured]. Calls per trial stay at 8, so the cost equals a plain reassessment.
3. **TRUST-10/11 are local, zero-cost changes.** They are: an `expectationSheet(record)`, an N-card `acceptDraft`, a verbatim `setExpectation`, keys `y`/`e` on the board's draft section, and a run confirmation that accepts and starts in one action. They can be cut first without affecting 1 or 2.

A root cause surfaced on the way. In 6 of the 8 simulator cards the agent's first reply is the **same 69-character stock reply** (sha256 prefix `d4738c00`), which ends with a question. The simulator answered it, and the judge read that as "continued after the agent said it cannot answer". This is the validator stub already noted in project memory. Fixing the simulator or behaviour text would need new agent runs, so it is deferred. v11 handles it honestly: the agent is judged on its stub reply.

**Primary recommendation:** first measure and record the "before" numbers (free). Then implement protocol v11 (prefix judging, version-aware `hasCompleteJudgment`, counting rules `goal-v2`) and pilot it on 3 deviated trials (~$0.45) as a go/no-go gate. Then run the full reassessments (fae, the phase-1 repeat, then a92 if budget allows) before the end of 2026-09-18 and freeze with a hash-pinning test. Build `src/explain.ts` (JUDGE-01/02) in parallel as a pure module. Do TRUST-10/11 last.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Объяснение провала (JUDGE-01)
- Формат по строкам, на русском:
  ```
  ✗ <название ситуации>
    Должен был: <X>
    Сказал (реплика #<seq>): «<Y>»
    Правило <N> · <источник>: «<дословная цитата>»
  ```
- **X** — критерий успеха ситуации (`successCriteria`), то есть ожидание из требований владельца. Если провалена метрика соблюдения правил промпта, X — само правило.
- **Y** — реплика агента, которую процитировал судья: дословная подстрока события `assistant` плюс номер реплики. Если судья не сослался ни на одну реплику агента, показывается последняя реплика агента с пометкой «(судья не указал реплику)».
- **N** — номер правила в материалах владельца, а не во внутренней нумерации судьи (`judge.ts:34` перенумеровывает правила после фильтра). Рядом — дословная цитата и имя источника. Номер берётся из порядка требований в материале владельца: планировщик выбирает стабильный способ и объясняет его.
  - Если у ситуации несколько правил, показываются до двух и строка «и ещё K».
- Каждая цитата проверяется: Y — подстрока реплики, цитата правила — подстрока источника (`verbatimSpan`). Если проверка не прошла, вместо непроверенной части выводится «объяснение не подтверждено цитатой». Ничего не выдумывается.
- Объяснение собирается из уже сохранённых данных, без вызовов модели. Поэтому старые прогоны (`fae4ee59`, `a92fd6ae`) получают его сразу.
- Эти же объяснения используются в «трёх главных причинах»: пример кластера показывается в том же формате. Обрезанный текст и регулярки вроде `firstReason` не используются.

#### «Без решения» (JUDGE-02)
- У каждой ситуации «не измерено» есть одна причина из словаря фазы 1 (18 кодов). Две причины из требования соответствуют кодам так: «нет доказательства» — `no_evidence`, «судья не уверен: голоса разошлись» — `judge_split`. Остальные причины показываются так же, как в фазе 1.
- В списке провалов и на экране «не измерено» причина стоит рядом с названием ситуации.

#### Меньше «без решения» и одна правка протокола (JUDGE-03)
- Данные фазы 1: на `fae4ee59` причины «не измерено» распределились так: симулятор отклонился — 2, симулятор под сомнением — 1, голоса разошлись — 1. На `a92fd6ae`: 4 + 1 + 1 + сбой агента 1. **Основной источник — оценка симулятора, а не расхождение голосов по цели.**
- Порядок работы:
  1. Записать доли «без решения» «до» на `fae4ee59` и `a92fd6ae`, а также на живом прогоне фазы 1, если он есть.
  2. Выбрать одну правку, которая бьёт в основной источник.
  3. Переоценить сохранённые ответы.
  4. Записать долю «после».
- Протокол судьи меняется **не больше одного раза**. Правка и переоценка должны закончиться до конца пт 2026-09-18, после этого протокол заморожен. Если измерение показывает, что правка протокола не уменьшает «без решения», протокол не меняется, и это записывается.
- Кандидаты правки. Исследование выбирает по данным и может комбинировать их в одной версии протокола:
  - (а) судья оценивает верность симулятора только до решающего ответа агента. Отклонение симулятора после ответа агента не лишает ситуацию вердикта по цели;
  - (б) 3 голоса с большинством для цели и верности симулятора;
  - (в) правило подсчёта в `outcomes.ts` без смены протокола, с версией в `countingRules`.
- Смена протокола — версионируемое изменение. `hasCompleteJudgment` (включая путь квитанции из фазы 1) должен корректно признавать и старую, и новую версию. Черновики, подготовленные до смены, честно отклоняются.
- Живые траты фазы 2: до ~$6, только на переоценку сохранённых ответов (без новых прогонов агента, если хватает переоценки). Перед каждым платным шагом проверяется бюджет — тот же приём, что `live-check.mjs budget` в фазе 1.

#### Лист ожиданий до запуска (TRUST-10/11)
- До запуска владелец видит в Pi один экран. На каждую ситуацию:
  - «Ситуация: <цель клиента>»;
  - «Должен: <ожидание>»;
  - «Правило N: «цитата»».
- Экран — это существующий раздел черновика на доске (`cards.ts`, раздел `cards` в фазе `review`) и тот же текст в ответе инструмента для чата. Оформление доводится в фазе 4.
- Подтвердить всё можно одним действием: клавишей на экране ожиданий или одним вызовом инструмента из чата. Клавишу выбирает планировщик так, чтобы она не конфликтовала с занятыми `p`/`n`/`v`/`x`/`d`, `/`, `u` и цифрами вкладок.
  - `acceptDraft` расширяется на N ситуаций (массив `acceptedTests` это уже поддерживает).
- Поправка ожидания: владелец пишет новое ожидание одной ситуации своими словами (в редакторе на доске или в чате). Текст владельца **дословно** становится критерием успеха (`successCriteria` и критерий `goal_attainment`). Переписывания моделью нет, ручной правки проверок нет.
  - Ситуация помечается «ожидание изменено владельцем».
  - На экране сказано, что её нельзя сравнивать с прошлыми прогонами.
  - Ограничение `updateDraft` на правку одного `successCriteria` снимается для ситуаций, где критерий оценивает судья.
- В Pi запуск черновика требует подтверждённых ожиданий (опциональный `requireAccepted` на пути Pi). CLI `evaluate` для сохранённых наборов не меняется: набор уже подтверждён при сохранении.
- Если фаза не успевает к заморозке протокола, TRUST-10/11 отрезаются первыми: так записано в дорожной карте.

### Claude's Discretion
- Модуль объяснения: `src/explain.ts` (`failureExplanation`) без импорта `experiment.ts`. Его использует `src/result-view.ts` из фазы 1.
- Стабильная нумерация правил владельца и способ проверки цитат.
- Точная правка протокола (а/б/в или их комбинация) и её версия.
- Клавиша подтверждения ожиданий и форма вызова инструмента.

### Deferred Ideas (OUT OF SCOPE)
- Судья сам называет номер нарушенного правила (`ruleId` в ответе) — только если объяснение по сохранённым данным не может выбрать правило однозначно. Иначе это лишняя правка протокола.
- Каппа и отдельные доли верных «провалов» и «успехов» (v2 JUDGE-07).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| JUDGE-01 | Провал как «должен был X → сказал Y → правило N (цитата)», N — номер правила владельца, цитаты проверены | Pattern 1 (`failureExplanation`), Pattern 2 (rule register), Pattern 3 (prompt rule from the compliance rationale). Buildability measured: 16/16 X, 16/16 Y verbatim, 57/57 rules grounded |
| JUDGE-02 | «Без решения» с причиной словами | Phase-1 codes `no_evidence` / `judge_split` (labels quoted below); Pattern 5 (reason next to the title) |
| JUDGE-03 | Доля «без решения» до/после, одна правка протокола до заморозки 2026-09-18, старые прогоны переоценены | Measured distribution plus the deviation-position analysis. Recommendation: protocol v11 (Pattern 4). Version-aware `hasCompleteJudgment`, counting rules `goal-v2`, pilot gate, freeze test, live plan |
| TRUST-10 | Один экран ожиданий до запуска, подтверждение одним действием | Pattern 6: `expectationSheet`, N-card `acceptDraft`, `y` key, accept-and-start confirm, `requireAccepted` |
| TRUST-11 | Поправка ожидания своими словами без правки проверок | Pattern 7: `setExpectation` (verbatim), `e` key and native editor, chat route through `agent_lab_accept`, record-level marker, guard relaxation |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- TypeScript ESM, Node ≥ 22.19 (v22.22.3 installed), `strict`, `noUncheckedIndexedAccess`, `.js` import extensions, 2-space indent, no formatter or linter.
- Stack is fixed: zod 4.5.4, typebox 1.3.7, Pi SDK / `pi-tui` 0.85.1. **No new runtime dependencies** (this phase needs none).
- User-facing strings in Russian; code, identifiers and commands in English.
- Old JSON records must open and be reassessed **without migration**.
- Truth comes from JSON records and events. What was not observed stays `unknown`; the agent's words do not prove actions.
- Bank dialogues stay local (`.agent-lab`, `0600`) and never enter the repo. `.planning` files carry ids and counts only.
- `npm test` / `npm run build` delete `dist/`, which the live Pi imports. Run tests from a snapshot (`.planning/phases/01-odno-chestnoe-chislo/snap-test.sh`). Check `git status` / `git log` before editing, because other sessions share the worktree.
- Do not touch git in `aigw-local*`. A live run costs ~$2 and 6–17 min per 15 cards. The default judge is `openai/gpt-5.6-sol` via OpenRouter.
- Conventions: named exports, zod schemas in `contracts.ts`, `throw new Error(msg)`, `null` = searched-not-found, `undefined` = not applicable.
- GSD workflow: file edits go through `/gsd-execute-phase`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Failure explanation X / Y / N and verification | Analysis: new `src/explain.ts` (pure) | `src/result-view.ts` (collects into `failures[]`, `topCauses[]`) | Pure derivation from the record. Must not import `experiment.ts` or `quality.ts` (cycle; see phase-1 import rule) |
| Owner rule numbering | Analysis: `src/explain.ts` `ruleRegister(record)` | `quality.ts` `expectationSheet`, board, tool text | One numbering shared by the sheet and the failure lines |
| Prefix judging (protocol v11) | Judge: `src/judge.ts` (`simulatorCut`, `prefixTrial`, `assessRepeated`, `hasCompleteJudgment`) | `src/evaluation.ts` `assessTrial` (records the cut on the trial) | Protocol semantics live next to `JUDGE_PROTOCOL` |
| Counting with a cut (`goal-v2`) | Analysis: `src/outcomes.ts`, `src/comparison.ts` (`goalCardOutcome`, `cardVerdict`) | `src/result-view.ts` (`COUNTING_RULES`) | The one place numbers are made |
| Expectation sheet text | Analysis: `src/quality.ts` `expectationSheet` (may import `draftHash`) | Board (`extensions/cards.ts`), tools (`extensions/agent-lab.ts`), CLI `accept` | Sheet shows the draft hash, as `testPlanLines` does |
| Accept N / set expectation / require acceptance | Orchestration: `src/experiment.ts` | `src/contracts.ts` (record-level marker) | Only `ExperimentLab` writes records |
| Keys, editors, confirmations | Surfaces: `extensions/cards.ts`, `extensions/agent-lab.ts` | — | Human intent must come from native UI, not model text |

## Standard Stack

No new packages. Everything uses the existing stack.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | 4.5.4 | Optional schema fields (`judgedBeforeSeq` on trial, `ownerExpectationScenarioIds` on the record, `cutBefore` on the phase-1 receipt) | The existing contract layer [VERIFIED: CLAUDE.md stack list] |
| node:crypto via `fingerprint` | Node 22.22.3 | Protocol hashes, hash-pinning freeze test, stock-reply hashing in the measurement script | Every existing hash uses `fingerprint` (`src/contracts.ts:933-937`) |
| node:test via tsx | tsx ^4.20.0 | Tests from a snapshot | Existing runner; `snap-test.sh` exists |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| v11 prefix judging | (b) 3-vote majority | Touches only `judge_split` + `simulator_unclear` (4 of 10 at most). Hides instability that phase 1 shows as not measured. Changes the vote-count invariant in both verifier paths |
| v11 prefix judging | (c) counting rule only | $0, but not honest: in 8/8 cards the goal votes cite the deviating continuation or later replies, so a kept FAIL could be caused by the deviation |
| v11 prefix judging | (a) as literally written | Recovers 0/8: every deviation is before the last cited agent reply |
| v11 prefix judging | Fix the simulator/behaviour for the stock reply | Changes `SIMULATOR_ROLE` or card behaviour, so new agent runs (~$2 each) are needed; outside the reassess-only budget. Deferred |
| Rule number from the model (`ruleId` in the response) | — | Deferred by CONTEXT. Stored data resolves the rule for 16/16 goal failures (card rules) and 15/16 prompt failures (quoted rule) |

**Installation:** none.

## Package Legitimacy Audit

No external packages are installed in this phase. **Packages removed due to [SLOP]:** none. **Packages flagged [SUS]:** none.

## Measured Baseline (read-only, ids and counts only)

Scripts ran with `tsx` against `src/` at HEAD `1dfb8a0` over `.agent-lab`. The worktree `dist/` predates phase 1 and was not used. Nothing below contains dialogue, rule or rationale text.

### «Без решения» before any change [VERIFIED: scratch script `measure.mts`]

| Run | Cards | pass / decided | Not measured | Codes |
|-----|-------|----------------|--------------|-------|
| `fae4ee59` | 13 | 0 / 9 | 4 (31%) | `simulator_deviated` 2, `simulator_unclear` 1, `judge_split` 1 |
| `a92fd6ae` | 15 | 1 / 8 | 7 (47%) | `simulator_deviated` 4, `simulator_unclear` 1, `judge_split` 1, `agent_error` 1 |

These match phase 1's `verify-stored-runs.mjs` output recorded in `01-01-SUMMARY.md`. Judge-caused total: 10. Of those, 8 are simulator reasons (80%) and 2 are `judge_split`. `no_evidence` is 0.

### Simulator cards in detail (8 cards) [VERIFIED: `measure.mts`, fidelity votes read from `trial.judgeAudit.attempts`]

| Run | Card | Code | Goal (stored) | Goal votes | Fidelity votes | Agent replies (seq) | Deviation seqs cited | Prefix after cut ends at |
|-----|------|------|---------------|-----------|----------------|---------------------|----------------------|--------------------------|
| fae | `62d8b990` | simulator_unclear | fail 2/2 | fail[5,15] ×2 | pass / fail[4,15,16] | 3, 8, 15 | 4 | reply #3 |
| fae | `c3de4f31` | simulator_deviated | fail 2/2 | fail[13,18] ×2 | fail ×2 [11,12,18,19] | 11*, 18 | 12 | reply #11 |
| fae | `f20c537d` | simulator_deviated | fail 2/2 | fail[11,13,16]/[11,16] | fail ×2 | 11*, 16 | 12 | reply #11 |
| a92 | `2c53e3c1` | simulator_deviated | fail 2/2 | fail[13,18]/[11,18] | fail ×2 | 11*, 18 | 12 | reply #11 |
| a92 | `f0345066` | simulator_deviated | fail 2/2 | fail[18,23] ×2 | fail ×2 ([9,10,…]/[11,16,18]) | 9*, 16, 23 | 10 | reply #9 |
| a92 | `e91e6971` | simulator_deviated | fail 2/2 | fail[16,18,21]/[16,21] | fail ×2 | 9*, 14, 21 | 10 | reply #9 |
| a92 | `c3de4f31` | simulator_deviated | fail 2/2 | fail[0,9,14]/[0,14] | fail ×2 | 9*, 14 | 10 | reply #9 |
| a92 | `b40325b8` | simulator_unclear | fail 2/2 | fail[21,26] ×2 | fail[19,20,21] / pass | 5, 12, 19, 26 | 20 | reply #19 |

`*` marks the stock reply (sha256 prefix `d4738c00`, 69 characters, contains `?`). It appears 4× in fae and 6× in a92 [VERIFIED: hash count]. The heuristic simulator checks (`simulator_leak`, `simulator_fabrication`, `simulator_loop`) fired on **0** of these cards. Every simulator reason comes from the `user_fidelity` rubric. Keyword classes of the failing fidelity rationales (counts only): all 14 failing votes match the stopping-rule class, 13 also match the refusal/hand-off class, and 5 also match the fabrication class.

What this decides:
- **Deviation vs decisive reply:** the deviation comes before the last agent reply the goal votes cite in 8/8 cards, so candidate (a) as written recovers 0.
- **Goal verdict if the simulator were ignored:** agreed FAIL in 8/8.
- **Cut computable** (a failing vote cites a user/simulator event after the first agent reply, and an agent reply exists before it): 8/8.
- **`judge_split`:** fae `ae812a24` (votes pass/fail; this is the phase-1 control candidate) and a92 `fc99a092` (unknown/fail). Only candidate (b) touches these.

### JUDGE-01 buildability on the 16 failed cards [VERIFIED: `measure.mts`, `n.mts`, `n2.mts`]

| Part | Result |
|------|--------|
| X = `successCriteria` present | 16/16 |
| Y = goal assessment has a citation on an `assistant` event | 16/16 (fallback needed: 0) |
| Y quote is a substring of that event's `text` | 16/16 |
| Card `requirementIds` resolve to a requirement | 57/57 |
| Requirement quote is verbatim in its source (`verbatimSpan`) | 57/57 |
| Cards with ≥1 knowledge-source rule | 16/16 (exactly 1: 3; 2–4: 13) |
| Goal rationale quotes one of the card's rules in «…» | 3/16, so do not rely on it |
| `prompt_compliance` = fail | 16/16 |
| Compliance rationale quotes a registered prompt rule verbatim in «…» (≥12 chars) | 15/16 (a rule of the card itself: 5/16) |
| Failure clusters (`failureModes`) | fae 6 clusters over 10 trials; a92 6 over 9 trials (1 overlap). Cluster `promptQuotes` match a registered requirement 18/23 |

### Rule identity and order [VERIFIED: raw JSON probe]
- Both runs: 10 sources (`source-1…8` knowledge, ~440–630 chars, one text line each; `source-9`, `source-10` `kind: 'prompt'`, 38 and 53 lines with bullets and numbered items) and 44 requirements.
- Requirement ids are model-written slugs and **differ between the two runs** for the same material (e.g. `tariff-view-path` vs `tariff-view`). They cannot serve as "правило N".
- Quote offsets within prompt sources are **not monotonic** in requirement order (`source-9`: 988/1345/1108/…). Model order is not owner order.
- All rules of a knowledge source sit on line 1. In prompt sources the quoted lines are bullets or numbered items.

## Architecture Patterns

### System Architecture Diagram

```
                                   stored record {id}.json (+ sidecar audit, phase 1)
                                                   │
      ┌────────────────────────────────────────────┼──────────────────────────────────────────┐
      │ EXPLAIN (free, pure)                       │ JUDGE v11 (paid, reassess or new run)    │ SHEET (free)
      ▼                                            ▼                                          ▼
 ruleRegister(record)                       assessRepeated(trial)                     expectationSheet(record)
  sources order × quote offset               1. user_fidelity × 2 votes (full dialogue)   per card: Ситуация / Должен /
  → Правило N · source · line                2. cut = simulatorCut(fidelity votes)        Правило N «цитата» (register)
      │                                       3. agent rubrics × 2 on prefixTrial(cut)        │
      ▼                                          (or full trial when no cut)                 ├─► board, cards section, phase review
 failureExplanation(record, scenario)         4. audit → sidecar/receipt (+cutBefore)         │     y = accept all · e = edit one (editor)
  X successCriteria                                │                                          │     r = accept+start if not yet accepted
  Y goal citation on assistant (verified)          ▼                                          ├─► agent_lab_accept (native confirm/select/editor)
  N card rules (≤2 + «и ещё K»)            assessTrial → trial.judgedBeforeSeq = cut          └─► CLI accept --id [--yes]
  + prompt rule quoted by compliance               │                                                  │
  + «оценено до реплики #D» when cut               ▼                                                  ▼
      │                                    counting goal-v2 (outcomes/comparison):          lab.acceptDraft (N cards)
      ▼                                     fidelity ignored for the goal when the          lab.setExpectation (verbatim)
 buildResultView → failures[], topCauses[]  goal was judged before the cut                  lab.start({ requireAccepted })
      │                                            │
      ▼                                            ▼
 CLI summary · tool text · board block      ResultView.notMeasured (fewer simulator codes)
```

### Recommended Project Structure (additions only)
```
src/
├── explain.ts        # NEW: ruleRegister, failureExplanation, explanationLines, promptRuleFromRationale
├── judge.ts          # + JUDGE_PROTOCOL_V10 (frozen), JUDGE_PROTOCOL (v11), simulatorCut, prefixTrial, version-aware verify
├── evaluation.ts     # assessTrial records trial.judgedBeforeSeq
├── outcomes.ts       # simulatorUsable/measurementUsable take the cut into account for the goal
├── comparison.ts     # goalCardOutcome / cardVerdict use the cut
├── result-view.ts    # COUNTING_RULES 'goal-v2'; failures[], topCauses[]; reason next to title
├── quality.ts        # expectationSheet (replaces the validation part of runPlan); causes() stops using firstReason
├── experiment.ts     # acceptDraft(N), setExpectation, start({ requireAccepted }), reassess deletes judgedBeforeSeq
└── contracts.ts      # trial.judgedBeforeSeq?, experiment.ownerExpectationScenarioIds?
test/
├── explain.test.ts   # NEW
.planning/phases/02-sudya-obyasnyaet-provaly/
├── measure-undecided.mjs   # NEW read-only before/after counter (ids/counts only)
└── live-check (reuse phase-1 live-check.mjs with --cap 6 and a phase-02 ledger)
```

### Pattern 1: `failureExplanation` from stored data (JUDGE-01)
**What:** a pure function `failureExplanation(record, scenario): FailureExplanation | null` for cards whose `cardVerdict(...).outcome === 'fail'`. It returns data plus Russian lines (unescaped; surfaces escape).

```typescript
// src/explain.ts — imports contracts.js, outcomes.js, comparison.js only
export interface RuleRef { number: number; requirementId: string; sourceName: string; line: number; quote: string; verified: boolean }
export interface FailureExplanation {
  scenarioId: string; trialId: string; title: string;
  expected: string | null;                                     // X: scenario.successCriteria
  said: { seq: number; quote: string; judgeCited: boolean; verified: boolean } | null;  // Y
  rules: RuleRef[]; moreRules: number;                         // N: up to 2 card rules + «и ещё K»
  promptRule?: RuleRef;                                        // rule quoted by a failed prompt_compliance
  judgedBeforeSeq?: number;                                    // v11 cut
  lines: string[];
}
```
Derivation (all verifiable, no model call):
- **X**: `scenario.successCriteria`. When it is missing (legacy), X is the text of the first card rule; mark it `(из правила)`.
- **Y**: in the latest goal assessment (`trial.assessments`, `metricId === 'goal_attainment'`), take the first `citations[]` entry whose event has `type === 'assistant'`. Verify with `event.text?.includes(quote)`; the stored citations already passed `validateAssessments` against `assessmentEventContent` (`src/contracts.ts:590-596`), but re-check at render. If there is no such citation, use the last assistant event before `judgedBeforeSeq` (or the last one when there is no cut), with `judgeCited: false` → line `Сказал (реплика #<seq>, судья не указал реплику): «…»`. Show the whole quote; do not use `shorten`.
- **N**: the card's `requirementIds` → `record.requirements` → register numbers (Pattern 2). Order: knowledge-source rules first, then prompt rules, each group ascending by number. Show 2, then `и ещё K`.
- **Verification failure**: a part that fails verification is replaced by `объяснение не подтверждено цитатой`. An unknown requirement id or a quote not found in its source counts as a failure. Nothing is invented.
- Lines (CONTEXT format):
  ```
  ✗ <title>
    Должен был: <X>
    Сказал (реплика #11): «<Y>»
    Правило 7 · <source name>: «<quote>»
    Правило 9 · <source name>: «<quote>»
    и ещё 1
    Нарушено правило промпта 31 · <prompt source name>: «<quote>»      ← only when Pattern 3 verified it
    Оценено до реплики #11: дальше симулятор отклонился от диалога.     ← only when judgedBeforeSeq
  ```
- **topCauses**: take `record.failureModes`, keep the trials whose card is a goal failure, sort by size, and take the top 3. Each cause is `{ name, count, example: failureExplanation(first trial) }`. When no clusters exist, use no causes and show the failure list only. `quality.ts` `causes()` should use `failureExplanation` for `example` and drop `firstReason` (`src/quality.ts:431-441`). `qualityLines().causes` then prints the example lines instead of a clipped quote.

### Pattern 2: Stable owner rule numbering (register)
**Rule:** number the requirements in **owner material order**. First by the position of the source in `record.sources` (the order in which materials were supplied), then by the start offset of `verbatimSpan(source.content, requirement.quote)` in that source, then by array index as the tie-break. Numbers run 1…K across all sources. Each rule also carries a locator: source `name` and the 1-based **line** of the quote start, which the owner can find in the file.
```typescript
export function ruleRegister(record: Pick<Experiment, 'sources' | 'requirements'>): Map<string, RuleRef> {
  const rows = record.requirements.map((r, index) => {
    const sourceIndex = record.sources.findIndex(s => s.id === r.sourceId);
    const source = record.sources[sourceIndex];
    const span = source ? verbatimSpan(source.content, r.quote) : undefined;
    const offset = span !== undefined ? source!.content.indexOf(span) : -1;
    return { r, index, sourceIndex, source, span, offset };
  }).filter(row => row.sourceIndex >= 0 && row.offset >= 0)          // unnumbered → «не подтверждено цитатой»
    .sort((a, b) => a.sourceIndex - b.sourceIndex || a.offset - b.offset || a.index - b.index);
  return new Map(rows.map((row, i) => [row.r.id, { number: i + 1, requirementId: row.r.id, sourceName: row.source!.name,
    line: row.source!.content.slice(0, row.offset).split('\n').length, quote: row.span!, verified: true }]));
}
```
**Why this and not the others:**
- Model order is not owner order (non-monotonic offsets, measured).
- Model ids differ between builds.
- The judge's numbering (`observableSources`, `src/judge.ts:37`, `.map((r, i) => \`${i + 1}. «${r.quote}»\`)`) is per prompt source, after the `MACHINE_FORMAT` filter, and must never be shown.

**Stability:**
- Identical for `repeat`, `reassess`, `loadSuite` and `saveSuite`, because requirements and sources are cloned.
- A **different build** of the same materials can extract different rules and so get different numbers. That is honest, and the sheet (TRUST-10) shows the numbers before the run.
- Uses `verbatimSpan` (`src/contracts.ts:920-931`), which already tolerates typography and first-letter case, the same tolerance `groundingProblem` uses when requirements are created (`src/pi.ts:31-37`).

### Pattern 3: The violated prompt rule from the compliance rationale
`promptCompliance.failCriteria` asks the judge to quote the violated rule verbatim (`src/contracts.ts:182`): «В rationale процитируйте нарушенное правило дословно из источника-промпта и реплику, которая его нарушает.»

For a trial whose `prompt_compliance` result is `fail`:
1. Extract the `«…»` spans of at least 12 characters from its rationale.
2. Find the registered **prompt-source** requirement (the same `MACHINE_FORMAT` filter as `observableSources`) whose quote contains the span or is contained in it.
3. On exactly one match, show `Нарушено правило промпта N · …`. On zero or several matches, show nothing on the first screen.

Measured: 15/16 match at least one rule. When a span matches several rules, choose the lowest number and show at most one. This is display only and needs no protocol change.

### Pattern 4: Protocol v11, judging agent rubrics on the faithful prefix (JUDGE-03)
**What changes:**
1. `assessRepeated` (`src/judge.ts:146-210`) runs in two stages. **Stage 1:** the two `user_fidelity` votes (only when applicable) on the full trial, exactly as today. **Stage 2:** `cut = simulatorCut(stage-1 vote assessments, trial.events)`, and every other applicable rubric (agent + RAG) gets 2 votes on `prefixTrial(trial, cut)` when `cut !== undefined`, otherwise on the full trial. Calls per trial stay at `2 × applicable` (8 on validate cards).
2. `simulatorCut(votes, events)` (pure, exported, shared by writer and verifier):
   - Consider only votes with `result === 'fail'`.
   - For each, take the smallest cited seq that is an event of type `user` or `simulator` **after the first `assistant` event**. The opening belongs to the card: see `metricApplies`' comment, `src/contracts.ts:232`.
   - `cut` is the minimum over those votes. Return `undefined` when no vote yields a seq, or when no `assistant` event precedes the cut.
3. `prefixTrial(trial, cut)` returns `{ ...trial, events: trial.events.filter(e => e.seq <= lastAssistantSeqBefore(cut)) }`. Retrieval and tool events for a reply come before it, so they stay; the trailing simulator decision is dropped.
4. `judgeInput` for a prefix trial adds one scope sentence to `evaluationScope`, for example: `The simulated user deviated from the card at event #${cut}; the dialogue is judged up to the agent reply before it. A clarifying question the agent asked there, left unanswered, leaves the goal unclear, not failed.` This lives inside the judge input, so it is covered by `inputHash` and by the protocol version. **`JUDGE_PROMPT` and `JUDGE_RESPONSE_FORMAT` stay byte-identical** (see Pitfall 1).
5. `parseJudgment(raw, prefixInput, [metric])` rejects citations beyond the prefix (`cites a nonexistent trace event`, `src/judge.ts:75`). The judge cannot use post-deviation events.
6. Protocol constants:
   ```typescript
   // src/judge.ts — keep today's object byte-for-byte as V10
   export const JUDGE_PROTOCOL_V10 = fingerprint({ version: 10, promptSources: 'observable-rules', ragEvidence: 'adapter-reported-retrieval-events', goalObservation: 'owner-selected-cited-channel', unobservedActions: 'deterministic-unknown', prompt: JUDGE_PROMPT, responseFormat: JUDGE_RESPONSE_FORMAT, applicability: 'reactive-actor-was-called', repeatsPerMetric: 2, aggregation: 'per-metric-unanimous-exclusive-conditions', repair: false, temperature: '0 for non-reasoning models; otherwise default', thinking: 'medium for reasoning models; otherwise off', maxTokens: 16384 });
   export const JUDGE_PROTOCOL = fingerprint({ /* same fields */ version: 11, agentScope: 'prefix-before-first-simulator-deviation-cited-by-a-failing-fidelity-vote', voteOrder: 'fidelity-first' /* … */ });
   ```
   The current value, quoted verbatim from `src/judge.ts:20`, is `fingerprint({ version: 10, promptSources: 'observable-rules', ragEvidence: 'adapter-reported-retrieval-events', goalObservation: 'owner-selected-cited-channel', unobservedActions: 'deterministic-unknown', prompt: JUDGE_PROMPT, responseFormat: JUDGE_RESPONSE_FORMAT, applicability: 'reactive-actor-was-called', repeatsPerMetric: 2, aggregation: 'per-metric-unanimous-exclusive-conditions', repair: false, temperature: '0 for non-reasoning models; otherwise default', thinking: 'medium for reasoning models; otherwise off', maxTokens: 16384 })`, which evaluates to `32c413cf3a12121a697981a18b5e5c4a1d05934150ab3032800b6fa4934d5736` [VERIFIED: tsx at HEAD 1dfb8a0]. `fingerprint(JUDGE_PROMPT)` = `891c8c65226e2f6cb3eab30638da3c288fd6d488d833faa5811d9b91ab58d210`; `fingerprint(JUDGE_RESPONSE_FORMAT)` = `d367899779956e5fa0ac227dfe9905e89e3ff459a0afe4e43886bd26602854de` [VERIFIED: same]. A freeze test pins all three plus the v11 value once written.
7. **Version-aware `hasCompleteJudgment`** (both paths):
   - Full-audit path (`src/judge.ts:114-144`): accept `audit.protocolHash` equal to `expected(JUDGE_PROTOCOL_V10)` or `expected(JUDGE_PROTOCOL)`, where `expected(p)` applies the existing `configurationHash` wrapping. For V10, keep today's body unchanged. For V11:
     - check the `user_fidelity` attempts against the full input, exactly as today;
     - recompute `cut` from their **parsed** assessments;
     - check each other attempt's `input` fingerprint against `judgeInput({...input, trial: prefixTrial(trial, cut)}, [metric])` and re-parse its `raw` with the prefix input;
     - require `trial.judgedBeforeSeq === cut`.
     The top-level `audit.inputHash` stays the fingerprint of the full-trial input.
   - Receipt path (phase 1, plan 01-04): accept both protocol hashes. For V11, require `receipt.cutBefore === trial.judgedBeforeSeq`, and require at least one `user_fidelity` vote with result `fail` when the cut is defined. The vote count stays `applicable.length * 2`, so the existing invariant holds. `sealJudgeReceipt` copies `cutBefore = simulatorCut(...)` from the audit. The receipt path cannot re-derive the cut (receipt votes carry no evidence); the sidecar and `auditHash` remain the full check. Document this.
8. **Recording the cut:** `trial.judgedBeforeSeq?: number` (optional on `Trial` and `trialSchema`). `assessTrial` (`src/evaluation.ts:291-305`) computes it from the final audit with `simulatorCut` and sets it. `reassess` deletes it next to `judgeAudit` (`src/experiment.ts:811`) and phase 1's `judgeReceipt`. **Do not** put it on `metricAssessmentSchema`: the judge's `responseSchema` is derived from that schema (`src/judge.ts:6`), so a new field would change `JUDGE_PROMPT` and break V10 verification.
9. **Counting rules `goal-v2`** (`COUNTING_RULES` in `src/result-view.ts:12`, currently `'goal-v1'`):
   - When `trial.judgedBeforeSeq` is defined, the **goal** outcome ignores the `user_fidelity` rubric result.
   - Heuristic simulator checks still block, unless their `seq` is at or after the cut; a check without a `seq` blocks.
   - Human reviews keep precedence.
   - Implement this as a variant of `simulatorUsable` (`src/outcomes.ts:62-71`), e.g. `simulatorUsable(scenario, trial, reviews, { beforeSeq })`, and use it from `measurementUsable` only on the goal path (`goalCardOutcome`, `cardVerdict` trialReasons in `src/comparison.ts`).
   - Records without the field count exactly as `goal-v1`. Test: fae stays 0/9 + 4 and a92 stays 1/8 + 7.
   - Strict/other-rubric outcomes (`automaticTrialResult`, `cardOutcome`) keep requiring fidelity. The headline is the only thing that changes.
10. **Effects:**
    - `evaluatorVersion` changes (it includes `JUDGE_PROTOCOL`, `src/pi.ts:77`).
    - `start` refuses drafts prepared before the change: «Версия оценщика изменилась. Обновите черновик…» (`src/experiment.ts:~897`). This is the honest rejection CONTEXT asks for. Any `updateDraft`/`setExpectation` recomputes it.
    - `repeat`/`reassess` recompute it through `freshDraft` (`src/experiment.ts:62-90`).
    - `compareRuns` reports v10 vs v11 as incomparable through `evaluatorVersion` and the protocol identity notes (`src/comparison.ts:638, 645-649`). Two v10 runs stay comparable because the verifier still accepts V10.
    - `SIMULATOR_ROLE` is untouched, so no new agent runs are needed.
    - `VERSION` stays `'6'` (phase-1 anti-pattern: a bump breaks `measurementHash` and every draft).
11. **Expected effect [ASSUMED until the pilot]:** 8/8 simulator cards get a cut. On 6 of them the prefix is opening + stock reply, which should be judged `fail` with a cited assistant event. The two `simulator_unclear` cards get prefixes ending at replies #3 and #19. Estimate: fae 4→1 (only `judge_split` left, re-rolled), a92 7→2 (`judge_split` + `agent_error`), with ±1 noise from fresh votes. The owner-facing number moves from 0/9 to about 0/12 on fae.

**Go/no-go gate (keeps "one change at most"):** implement v11 and swap `dist/`. Then `reassess --id fae4ee59… --trial <c3de4f31 trial> --trial <f20c537d trial> --trial <62d8b990 trial> --yes` (~24 calls, ~$0.3–0.45). **GO** if at least 2 of the 3 cards are decided. **NO-GO**: restore the v10 `dist/` from the kept snapshot, revert the v11 commit, record «правка не уменьшила без решения — протокол не меняется» with the pilot record id, and keep v10. The pilot record stays as evidence; it has a v11 protocol hash that no longer verifies after a revert, and that is acceptable. The trial ids are the ids of the trials whose `scenarioId` starts with those prefixes; the script prints them.

### Pattern 5: Reason next to the title (JUDGE-02)
Phase-1 labels, verbatim from `src/result-view.ts:49-50`: `judge_split: 'судья не уверен: голоса разошлись'`, `no_evidence: 'нет доказательства в ответе'`. Add `notMeasuredLines(view)` (or a `details` option) that prints one row per unknown card: `? <title> — <label>`. The failure list prints `✗ <title>` with the explanation, and the not-measured list shows each card with its label. After v11, cards decided with a cut are no longer in this list; their explanation carries the «Оценено до реплики #D» line. `judge_unclear` («правила не дают однозначного ответа») stays a legitimate third judge reason. Its measured count is 0, but it can appear after re-votes. CONTEXT allows it («остальные причины показываются так же, как в фазе 1»).

### Pattern 6: Expectation sheet and one-action confirmation (TRUST-10)
- `expectationSheet(record): { draftHash: string; lines: string[]; cards: { scenarioId; title; expected; rules: RuleRef[]; ownerEdited: boolean }[] }` in `src/quality.ts`, next to `testPlanLines` (`src/quality.ts:102`), which already imports `draftHash`. Per card:
  ```
  <i>. Ситуация: <scenario.user.goal>
     Должен: <scenario.successCriteria>
     Правило 7: «<quote>» · <source name>, строка 1
     Правило 9: «…»          (all card rules here; the sheet is the review screen)
     Ожидание изменено владельцем — с прошлыми прогонами не сравнивается.   (only when marked)
  ```
  Footer lines: `Версия: <hash12>` and `Подтвердить все ожидания?`.
- `acceptDraft` (`src/experiment.ts:710`):
  - Replace `record.scenarios.length !== 1` with `!record.scenarios.length`. Keep the message family: tests match `/ровно один/` today, so change the message and those tests together.
  - Build `acceptedTests` for **every** scenario, reusing an existing entry when its `definitionHash` still matches.
  - Keep the idempotency check across all cards.
  - `acceptedTestSchema` array max 200 and `validationCount` max `SCENARIO_LIMIT` (20) fit [VERIFIED: `src/contracts.ts:480, 826-827`].
- `start(id, { …, requireAccepted?: boolean })`: when `requireAccepted` is set and `record.acceptedDraftHash !== draftHash(record)`, throw `Сначала подтвердите ожидания ситуаций: они изменились или ещё не подтверждены.`. When acceptance is current, pass `reviewer: 'human'`.
- **One action in Pi:**
  - **Board.** In section `cards`, phase `review`, workflow `evaluate`, key **`y`** calls `lab.acceptDraft(id, draftHash)` and shows the notice «Ожидания подтверждены. r — запуск.». Key **`r`** on a draft that is not yet accepted opens `ctx.ui.confirm('Подтвердить ожидания и запустить?', runPlan(r))`. On yes it calls `acceptDraft`, then `start({ requireAccepted: true })`.
  - **Chat.** `agent_lab_run` does the same inside its existing confirm (`extensions/agent-lab.ts:535+`). `runPlan`'s validation block (`extensions/agent-lab.ts:48-68`) is replaced by `expectationSheet(record).lines`.
  - Both paths keep «одним действием» and existing tests that confirm with a stub. **Update** `test/extension.test.ts:128-132`, which matches `Validation set:` / `Ожидается:` / `Основание:`. That test also stubs `ExperimentLab.prototype.start/get`, so it must stub `acceptDraft` too.
- **Keys.**
  - Keys in use in `extensions/cards.ts` `handleInput` (344-393): `q`, `ctrl+c`, `escape`, `?`, `/`, `n`, `d`, `1`, `2`, `3`, `u`, `a`, `p`, `v`, `r`, `f`, `x`, `o`, `c`, `j`, `k`, `enter`, arrows, `home`/`end`, `pageUp`/`pageDown` [VERIFIED: read]. Phase 1 plans add none (grep found no `key(` in `01-0*-PLAN.md`).
  - `y` and `e` are free. Scope both to `section === 'cards' && editable`.
  - Add both to the help text (`:497`) and to the review footer (`a Правка словами · y Подтвердить ожидания · e Поправить ожидание · r Запустить`).
  - Note for phase 3: if it wants `y` for «согласен», scope it to the results section.
- **CLI.** `accept --id RUN [--yes]` (`src/cli.ts:264-281`) prints `expectationSheet` when the draft has more than one card, and keeps `testPlanLines` for one card. `evaluate` stays unchanged, as CONTEXT says.

### Pattern 7: Owner edits an expectation verbatim (TRUST-11)
- `lab.setExpectation(id, expectedHash, scenarioId, text)` runs through `change()`:
  - The record must be in phase `review` with workflow `evaluate`, `draftHash` must match, and the scenario must exist.
  - The text is trimmed, 1–3000 chars (the `successCriteria` limit, `src/contracts.ts:284`).
  - It sets `scenario.successCriteria = text` and, when the card has an agent `goal_attainment` rubric, that rubric's `passCriteria = text`. This follows CONTEXT's literal «successCriteria и критерий goal_attainment». `failCriteria` and `description` stay. For reply-only validate cards, `goalObservation`/`GOAL_UNSUPPORTED` in `parseJudgment` still enforce cited-reply evidence.
  - It adds the id to `record.ownerExpectationScenarioIds` (a new optional array on `Experiment`/`experimentSchema`).
  - It then reuses the tail of `updateDraft`: `validatePreparation`, `retainAcceptedTests`, `evaluatorVersion` recompute, clearing `reviewedAt`/`manifestHash`, and the checkpoint. A small shared private helper is enough; do not copy the whole function.
- **Guard relaxation** (`src/experiment.ts:~672-675`): skip the «Ожидание … изменилось, а исполняемые проверки остались прежними» error when `before.metrics?.some(m => m.subject === 'agent' && m.id === 'goal_attainment')`. The judge reads `successCriteria` through `judgeInput` (`src/judge.ts:52`), so the change is executable.
- **Marker placement:** record level, like phase 1's `positiveControlScenarioIds`. Add it to `draftHash` (an `undefined` key is dropped by `fingerprint`, so old hashes are unchanged, `src/contracts.ts:933-937`). Keep it out of `measurementHash`. It must survive `freshDraft` (`structuredClone` keeps it). `freshDraft` with `scenarioIds` filters it.
- **Comparability:** changing `successCriteria`/metrics changes `fingerprint(scenario)`, so `compareRuns` reports «Содержимое карточек изменилось» (`src/comparison.ts:641-642`). This is the intended «нельзя сравнивать с прошлыми прогонами». The sheet states it in words.
- **Acceptance after an edit:** `draftHash` changes, so `acceptedDraftHash` becomes stale, and `retainAcceptedTests` drops that card's entry (`src/experiment.ts:54-60`). The owner confirms again with `y`, or the next `r` confirm asks once. There is no auto-accept.
- **Board:** `e` on the selected card opens `ctx.ui.editor('Что агент должен сделать в этой ситуации? Своими словами.', scenario.successCriteria ?? '')`. A non-empty change calls `lab.setExpectation`. This is a new `BoardAction` `{ type: 'expect', … }` handled in the `/agent-lab` loop (`extensions/agent-lab.ts:~740+`).
- **Chat:** the owner's words must not pass through the model. `agent_lab_accept` (id only) becomes the native loop:
  1. `ctx.ui.select` offers «Подтвердить все», «Поправить ожидание ситуации…» or «Отмена».
  2. «Поправить» leads to a `ctx.ui.select` of the situation, then `ctx.ui.editor`, then `setExpectation`, then back to the sheet.
  3. «Подтвердить все» calls `acceptDraft`.
  The one-card path keeps today's `ctx.ui.confirm(question, testPlanLines)` so `test/extension.test.ts:325-366` keeps passing. `agent_lab_edit` keeps its generic model-written patch. Its description should say: «expectations are changed by the owner through agent_lab_accept».

### Anti-Patterns to Avoid
- **Adding fields to `metricAssessmentSchema` for v11.** That changes the judge's response JSON schema, which is embedded in `JUDGE_PROMPT`. Every v10 audit then fails `audit.prompt !== JUDGE_PROMPT` (`src/judge.ts:119`).
- **Replacing `JUDGE_PROTOCOL`'s v10 object instead of keeping it as `JUDGE_PROTOCOL_V10`.** Old runs would stop verifying, and even two v10 runs would become «несравнимы».
- **Showing the judge's rule numbers or `requirement.id` as «Правило N».** Model slugs change between builds; the judge renumbers per source.
- **Truncating quotes on the first screen** (`shorten`, `preview`). SCREEN-01 forbids clipped text, and a verbatim check on a clipped quote is meaningless.
- **Letting the chat model supply the owner's expectation text.** The text must come from `ctx.ui.editor`.
- **Paying for the full reassessments before the 3-trial pilot.**
- **A second protocol change after the pilot**, e.g. "also add a tie-break vote". The version is frozen at the pilot's code.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Quote verification with typography/case tolerance | a new fuzzy matcher | `verbatimSpan` (`src/contracts.ts:920`) | Same tolerance as requirement grounding |
| Card verdict and reason | a new counter | `cardVerdict` / `goalCardOutcome` (`src/comparison.ts`) plus the `goal-v2` variant | One source of numbers (phase 1) |
| Stable hashes and version pins | string compare | `fingerprint` | Key-order independent |
| Budget gate before paid steps | a new estimator | phase-1 `live-check.mjs budget … --cap 6` with a phase-02 ledger | Same GO/NO-GO logic and ledger format |
| Snapshot testing | `npm test` in the worktree | `.planning/phases/01-odno-chestnoe-chislo/snap-test.sh` | Protects the live `dist/` |
| Terminal safety | escaping per call | `safeText` (`extensions/cards.ts:10-13`), `safeLine` in the CLI | Model-written titles and quotes |
| Plurals | new helper | `pluralForm` (`src/result-view.ts:28`) | Already covers the 1/2/5 forms |

**Key insight:** every piece of evidence the explanation needs is already stored and was verified when it was written: citations by `validateAssessments`, requirement quotes by `groundingProblem`/`validatePreparation`. Phase 2 re-checks and arranges it.

## Runtime State Inventory (protocol change and coordination)

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | `.agent-lab/*.json` v10 records (fae, a92, and by then phase-1 NEW/RE/BUILD); `.agent-lab/grounding/` cache (keyed on `VERSION`, not the judge protocol, so it stays valid); phase-1 sidecars `{id}.judge/` | None to migrate. v10 records stay verifiable (V10 path). v11 numbers come from **new** reassessment records; old records are never rewritten |
| Live service config | The live Pi imports `dist/*.js` and `extensions/*.ts` | Human checkpoint: rebuild `dist/` from a snapshot and restart Pi before the pilot, the same swap procedure as 01-10 |
| OS-registered state | aigw-local mock server on :8090 (answered 404 on `/`, so it is up) [VERIFIED: curl]. No Pi process found; no `.agent-lab/.lock` [VERIFIED] | Keep the server up; close `/agent-lab` before CLI paid steps |
| Secrets/env vars | Pi auth for `openrouter/openai/gpt-5.6-sol` (phase-1 finding); OpenRouter balance not checkable here | Human check: balance ≥ $6 before the pilot |
| Build artifacts | Worktree `dist/` is from 2026-09-16, before phase 1; 01-10 will swap it | Phase 2 swaps again after its code is committed. Keep the phase-2 pre-swap `dist/` copy for the NO-GO rollback |
| Drafts prepared before v11 | Phase-1 BUILD draft (if in `review`) | `start` refuses it by design. Refresh it with any draft edit or `setExpectation`, or rebuild |

## Common Pitfalls

### Pitfall 1: Changing the judge prompt by accident
**What goes wrong:** every v10 audit stops verifying, and the diff of fae vs NEW becomes «несравнимы».
**Why it happens:** `JUDGE_PROMPT` embeds `JSON.stringify(z.toJSONSchema(responseSchema))`, and `responseSchema` derives from `metricAssessmentSchema` (`src/judge.ts:6, 15-19`).
**How to avoid:** add v11 fields only to the trial/receipt, and put the prefix sentence in `judgeInput`. The freeze test pins `fingerprint(JUDGE_PROMPT)` = `891c8c65…d210`.
**Warning signs:** `test/judge.test.ts` legacy cases fail; `verify-stored-runs.mjs --audit fae…:13/13` drops to 0.

### Pitfall 2: A partial reassess mistaken for the "after" number
**What goes wrong:** the 3-trial pilot record shows 10 cards `not_reached`.
**Why:** `cardVerdict` returns `not_reached` for cards without trials (`src/comparison.ts:576`).
**How to avoid:** use the pilot only for its 3 cards (the script prints per-card outcomes). The "after" number comes from full reassessments.

### Pitfall 3: Stability after reassess across protocol versions
**What goes wrong:** phase 1's `stabilityAfterReassess` (plan 01-05) marks a pass↔fail flip between the v10 source and the v11 reassessment as «нестабильно», although the protocol changed.
**How to avoid:** gate it on equal judge protocol. Compare the source and reassessment protocol identity, or `evaluatorVersion` recomputed for the source settings; if they differ, show «не с чем сравнить: другой протокол судьи». Flips between unknown and decided are already excluded by phase 1.

### Pitfall 4: The receipt path cannot check the cut
**What goes wrong:** a hand-edited `judgedBeforeSeq` passes the receipt check.
**How to avoid:** seal `cutBefore` in the receipt and compare it; the sidecar `auditHash` plus the full path is the real check. Add a tamper test: change `judgedBeforeSeq` and expect false in both paths.

### Pitfall 5: Fidelity-first ordering and failures
**What goes wrong:** a fidelity vote error blocks the agent votes, or the agent votes start before the cut is known.
**How to avoid:** stage 1 errors follow today's rule (`failure ??= error` for non-RAG metrics, throw after settle). Stage 2 starts only after both stage-1 votes settle successfully. Tests: a fidelity error means no agent calls and `Judge response rejected…`; fidelity pass/pass means agent votes on the full trial; fail/pass means agent votes on the prefix, and a post-cut citation is rejected.

### Pitfall 6: The sheet's rule list is long
**What goes wrong:** a card with 11 rules (fae `3fc7ace7`) floods the screen.
**How to avoid:** on the sheet, show knowledge rules first, then prompt rules on one line each. The failure line shows 2 plus `и ещё K`. Phase 4 finishes the layout. Do not truncate the quote text itself.

### Pitfall 7: Tests that stub `start` and not `acceptDraft`
**What goes wrong:** `test/extension.test.ts` validation-set test (~95-133) throws when `agent_lab_run` now accepts before starting.
**How to avoid:** stub `acceptDraft` there, or have the tool accept only when `acceptedDraftHash !== draftHash`. Update the regexes to the sheet wording.

### Pitfall 8: Freeze deadline vs phase-1 progress
**What goes wrong:** phase 1 (10 plans) finishes late on 09-18, and v11 plus the paid reassessments do not fit before the end of 09-18.
**How to avoid:** make the v11 plan wave 1 of phase 2, independent of TRUST-10/11. If the deadline is missed, record «протокол не изменён (не успели)» and keep v10. JUDGE-01/02 still ship because they are free.

### Pitfall 9: Line numbers in knowledge sources
**What goes wrong:** every knowledge rule shows «строка 1».
**Why:** each knowledge source is one line.
**How to avoid:** accept it. The register number and the verbatim quote identify the rule. Show the line only for sources with more than 1 line.

## Code Examples

### `simulatorCut` and `prefixTrial` (pure)
```typescript
// src/judge.ts — shared by assessRepeated (writer) and hasCompleteJudgment (verifier)
export function simulatorCut(votes: Pick<MetricAssessment, 'result' | 'evidence'>[], events: TraceEvent[]): number | undefined {
  const first = events.find(e => e.type === 'assistant')?.seq;
  if (first === undefined) return undefined;
  const typeOf = (seq: number) => events.find(e => e.seq === seq)?.type;
  const cuts = votes.filter(v => v.result === 'fail').flatMap(v => {
    const seqs = v.evidence.filter(seq => seq > first && (typeOf(seq) === 'user' || typeOf(seq) === 'simulator'));
    return seqs.length ? [Math.min(...seqs)] : [];
  });
  if (!cuts.length) return undefined;
  const cut = Math.min(...cuts);
  return events.some(e => e.type === 'assistant' && e.seq < cut) ? cut : undefined;
}
export function prefixTrial<T extends Pick<Trial, 'events'>>(trial: T, cut: number): T {
  const last = trial.events.filter(e => e.type === 'assistant' && e.seq < cut).at(-1)!.seq;
  return { ...trial, events: trial.events.filter(e => e.seq <= last) };
}
```
Expected on stored data (a test with synthetic events of the same shape): fidelity fail `[11,12,18,19]` with events `0 user, 1–2 tool, 3 assistant…` gives 12 when the first assistant is 11. A vote citing only `[0, 5]` where 0 is the opening gives no cut from seq 0.

### Budget-gated pilot (commands; RUN ids from the stored records)
```bash
EVID=$HOME/agent-lab-evidence/phase-02; mkdir -p -m 700 "$EVID"
LC=.planning/phases/01-odno-chestnoe-chislo/live-check.mjs
node $LC budget --reference fae4ee59-d6da-4cbf-83b5-574e34405877 --ledger $EVID/ledger.txt --next reassess:3 --cap 6
node dist/cli.js reassess --id fae4ee59-d6da-4cbf-83b5-574e34405877 --trial $T1 --trial $T2 --trial $T3 --yes > $EVID/pilot.json
node .planning/phases/02-sudya-obyasnyaet-provaly/measure-undecided.mjs --id <pilot id> --cards c3de4f31,f20c537d,62d8b990
```
The `live-check.mjs` subcommands and flags come from plan 01-10 Task 1 (`budget --reference --ledger --next <run|reassess|build>:<n> [--cap 10]`, `spent`, `watch`). Verify the exact interface against `01-10-SUMMARY.md` when it exists [ASSUMED until 01-10 lands].

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Cause example = clipped rationale (`firstReason` + `shorten`) | Verified X / Y / N lines from stored citations and the owner rule register | This phase | `quality.test.ts` expectations for `causes` change |
| Any simulator fidelity doubt removes the goal verdict | v11: the agent is judged on the faithful prefix; fidelity still decides the strict outcome | This phase (protocol v11, counting `goal-v2`) | v10 runs need a reassessment for v11 numbers; v10 stays verifiable |
| Accept exactly one test | Accept the whole sheet; owner edits one expectation verbatim | This phase | `experiment.test.ts:638-658` and `extension.test.ts:325-366` change or extend |

**Deprecated/outdated:** `firstReason` (`src/quality.ts:431-441`) and the lexical `missingEvidence` gate in `groundedScore` stay for `scoreBrief` only. They are not used for the headline causes.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | v11 prefix votes on the 8 simulator cards come out decided (mostly `fail`), giving fae 4→~1 and a92 7→~2 | Pattern 4 | The pilot gate catches it (NO-GO, protocol unchanged, recorded) |
| A2 | Reassess cost ≈ $1.0–1.6 per 13–15-card run and the 3-trial pilot ≈ $0.3–0.45 (extrapolated from fae usage 172 calls / $1.88) | Live plan | The budget gate stops before $6; a92 is last and optional |
| A3 | The phase-1 `live-check.mjs` interface matches plan 01-10 | Live plan | Adjust the commands to the actual script |
| A4 | Owner order = `record.sources` order, then quote position, is an acceptable «номер правила» | Pattern 2 | Cosmetic; the sheet shows numbers before any run |
| A5 | Setting `goal_attainment.passCriteria` to the owner text (besides `successCriteria`) is the intended reading of «критерий goal_attainment» | Pattern 7 | If only `successCriteria` was meant, drop one assignment; the judge sees the text either way |
| A6 | `y`/`e` stay free through phases 3–4 when scoped to the draft section | Pattern 6 | Rebind in phase 4's unified keymap |
| A7 | Russian wording of the new lines («Оценено до реплики #D…», sheet lines) reads well | Patterns 1, 6 | Cosmetic |
| A8 | The receipt path (phase 1, 01-04) lands as planned with `votes`, `complete` and `auditHash` | Pattern 4.7 | Adapt the cut check to the actual receipt shape |

## Open Questions (RESOLVED)

1. **Combine (b) a tie-break vote with v11?**
   - What we know: it would touch 2 `judge_split` cards, including the control candidate `ae812a24`, but it changes the vote-count invariant and hides judge instability.
   - RESOLVED: no. One change only; splits stay a named reason (JUDGE-02).
2. **What if the phase-1 live repeat (NEW) did not happen?**
   - RESOLVED: the "before" numbers use fae and a92 only (CONTEXT: «если он есть»), and the v11 reassessments are fae, then a92.
3. **Is the stock-reply root cause in scope?**
   - RESOLVED: no. Record it in the phase summary and STATE as a finding about the agent under test (validator stub) and the simulator's stopping rule. Fixing either needs new agent runs.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | everything | ✓ | v22.22.3 | — |
| tsx / tsc in node_modules | snapshot tests, read-only scripts | ✓ | tsx ^4.20.0 | — |
| aigw-local mock :8090 | not needed for reassess (the target is not opened) | ✓ (HTTP 404 on `/`) | — | — |
| Pi auth for the OpenRouter judge | paid reassessments | ✓ per phase-1 research | — | — |
| OpenRouter balance ≥ $6 | paid steps | not checked | — | human checkpoint |
| `live-check.mjs` (phase 1) | budget gate | ✗ yet (created by 01-10) | — | copy its `budget`/`spent` logic into a phase-02 script if 01-10 is late |
| `~/agent-lab-evidence/` | evidence copies | ✗ yet | — | `mkdir -p -m 700` |

**Missing dependencies with no fallback:** none.

## Live Verification Plan (≤ $6, reassess only; do NOT execute during planning)

Preconditions (human checkpoint):
- Phase-2 code is committed and the snapshot suite is green.
- `dist/` is swapped from the snapshot after checking that no Pi process or writer lock exists; the previous `dist/` copy is kept for rollback.
- Pi is restarted.
- The OpenRouter balance is checked.

Variables: `RUN=fae4ee59-d6da-4cbf-83b5-574e34405877`, `A92=a92fd6ae-8eaa-42ea-8ba0-d804096ce1d4`, `NEW=<phase-1 repeat id from 01-10-SUMMARY>`, `EVID=$HOME/agent-lab-evidence/phase-02` (0700), ledger `$EVID/ledger.txt`, cap 6.

| Step | Command | Cost / time | Proves |
|------|---------|-------------|--------|
| 0 (free, before the swap) | `node .planning/phases/02-sudya-obyasnyaet-provaly/measure-undecided.mjs --id $RUN --id $A92 [--id $NEW --id <phase-1 RE>] > $EVID/before.txt` | $0 | JUDGE-03 "before" (expected fae 4/13, a92 7/15, with codes) |
| 1 (free) | `node dist/cli.js summary --id $RUN > $EVID/fae.summary.txt` (and `$A92`) | $0 | JUDGE-01 lines on stored runs; JUDGE-02 reasons next to titles; old records open |
| 2 (free) | `node .planning/phases/01-odno-chestnoe-chislo/verify-stored-runs.mjs --expect $RUN:0:9:4 --expect $A92:1:8:7 --audit $RUN:13/13 --audit $A92:14/14` | $0 | goal-v2 unchanged on v10 records; the V10 verifier path still works |
| 3 (free) | `measure-undecided.mjs --explain --id $RUN --id $A92` prints per failed card `X=ok Y=ok N=2+K prompt=ok|-` | $0 | JUDGE-01 buildability 16/16 with counts only |
| 4 (~$0.3–0.45) | budget `--next reassess:3`, then `reassess --id $RUN --trial …×3 --yes` | 3–6 min | **Gate:** ≥2 of 3 decided, so GO. Otherwise roll back and record |
| 5 (~$1.0–1.6) | budget `--next reassess:13`, then `reassess --id $RUN --yes` → `RE11` (background + `watch`) | 7–15 min | JUDGE-03 "after" on the pilot run; `summary --id RE11` shows the explanation lines with «Оценено до реплики #…» |
| 6 (~$1.0–1.6) | budget, then `reassess --id $NEW --yes` → `NEW11` | 7–15 min | The demo record on the frozen protocol, including the control line |
| 7 (optional, ~$1.2–1.8) | budget, then `reassess --id $A92 --yes` → `A11` | 7–15 min | Second "after" number |
| 8 (free) | `measure-undecided.mjs --id RE11 --id NEW11 [--id A11] > $EVID/after.txt`; `diff --before RE11 --after NEW11` | $0 | Before/after table; v11 runs compare with each other |
| 9 (free) | `node dist/cli.js repeat --id NEW11` → DRAFT; a scratch script calls `lab.setExpectation(DRAFT, hash, <card>, <owner text>)`, then `accept --id DRAFT` prints the sheet; offline `judgeInput` contains the owner text | $0 | TRUST-10 sheet on the real acquiring draft with rule numbers and the «изменено владельцем» mark; TRUST-11 text reaches the judge input verbatim |
| 10 (human) | In Pi: `/agent-lab DRAFT` → section 2 → `e` (edit) → `y` (confirm) → `r` shows the confirm; cancel | $0 | One-action confirmation in the real UI |

After the last paid step, freeze: commit the test pinning the v11 `JUDGE_PROTOCOL` hash and record the hash and time in STATE. Copy evidence with `cp -p` and `chmod -R go-rwx $EVID`. Only ids, counts and hashes go into `.planning`.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Node test runner via `tsx --test` (tsx ^4.20.0), TypeScript 5.9.3 |
| Config file | none (`package.json` scripts) |
| Quick run command | `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh test/explain.test.ts test/judge.test.ts test/comparison.test.ts test/result-view.test.ts` (working-tree snapshot; never touches the worktree `dist/`) |
| Full suite command | `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh --full` (`git archive HEAD`, `npm test && npm run typecheck`; phase-1 baseline 346/346) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| JUDGE-01 | `ruleRegister` orders by source then offset, not model order; numbers stable across `structuredClone`/repeat; unknown or ungrounded quote gives no number | unit | `snap-test.sh test/explain.test.ts` | ❌ Wave 0 |
| JUDGE-01 | `failureExplanation`: X from `successCriteria`; Y from the first assistant citation, verified; fallback to the last reply with «судья не указал реплику»; tampered quote or unknown requirement gives «объяснение не подтверждено цитатой»; 2 rules + «и ещё K»; prompt rule only on a unique verified match; no `…` truncation | unit | `snap-test.sh test/explain.test.ts` | ❌ Wave 0 |
| JUDGE-01 | CLI `summary` and the tool/board block show the explanation lines for top causes; `quality` causes no longer use `firstReason` | unit + CLI spawn | `snap-test.sh test/result-view.test.ts test/quality.test.ts test/extension.test.ts test/cards.test.ts` | ✅ extend |
| JUDGE-02 | Every unknown card row shows `title — label`; `judge_split`/`no_evidence` wording verbatim | unit | `snap-test.sh test/result-view.test.ts` | ✅ extend |
| JUDGE-03 | `simulatorCut`/`prefixTrial` vectors (fail-only, opening excluded, min over votes, no assistant before the cut means undefined) | unit | `snap-test.sh test/judge.test.ts` | ✅ extend |
| JUDGE-03 | `assessRepeated` v11: fidelity first; pass/pass → full trial; fail/any → prefix; post-cut citation rejected; fidelity error → no agent calls; 8 calls total | unit (fake respond) | `snap-test.sh test/judge.test.ts` | ✅ extend |
| JUDGE-03 | `hasCompleteJudgment`: a V10 fixture still true; a V11 fixture true; tamper `judgedBeforeSeq`/prefix input/protocol gives false; receipt path checks `cutBefore` | unit | `snap-test.sh test/judge.test.ts test/store.test.ts` | ✅ extend |
| JUDGE-03 | Freeze pins: `JUDGE_PROTOCOL_V10 === '32c413cf…5736'`, `fingerprint(JUDGE_PROMPT) === '891c8c65…d210'`, `fingerprint(JUDGE_RESPONSE_FORMAT) === 'd3678997…54de'`, v11 hash literal | unit | `snap-test.sh test/judge.test.ts` | ✅ extend |
| JUDGE-03 | `goal-v2`: a card with a cut and fidelity fail is decided; a heuristic check before the cut still blocks; records without the field are unchanged; `COUNTING_RULES === 'goal-v2'` | unit | `snap-test.sh test/comparison.test.ts test/outcomes.test.ts test/result-view.test.ts` | ✅ extend |
| JUDGE-03 | `reassess` deletes `judgedBeforeSeq`; `assessTrial` sets it from the audit | integration (injected runtime) | `snap-test.sh test/evaluation.test.ts test/experiment.test.ts` | ✅ extend |
| JUDGE-03 | Stored-run regression: v10 counts and audits unchanged | manual read-only | `node .planning/phases/01-odno-chestnoe-chislo/verify-stored-runs.mjs --expect …` | ✅ |
| JUDGE-03 | Before/after numbers on real runs | manual (paid, gated) | Live plan steps 0, 4–8 | — |
| TRUST-10 | `expectationSheet` lines per card; `acceptDraft` accepts N cards and is idempotent; 0 cards rejected; `start({requireAccepted})` throws when stale; board `y` accepts; `r` on an unaccepted draft confirms, accepts and starts | unit + extension | `snap-test.sh test/quality.test.ts test/experiment.test.ts test/cards.test.ts test/extension.test.ts` | ✅ extend |
| TRUST-11 | `setExpectation` sets both fields verbatim, marks the card, invalidates acceptance, keeps the checks, recomputes `evaluatorVersion`; guard relaxed only for goal-rubric cards; `compareRuns` then reports changed content; `draftHash` of a record without the marker unchanged; chat accept loop uses the editor text (stub) | unit + extension | `snap-test.sh test/experiment.test.ts test/extension.test.ts test/comparison.test.ts` | ✅ extend |

### Sampling Rate
- **Per task commit:** quick command with the 2–4 touched test files.
- **Per wave merge:** `snap-test.sh --full`.
- **Phase gate:** full suite green; `verify-stored-runs.mjs` expectations hold; live steps 0–9 done with evidence copied, before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `test/explain.test.ts`: fixture record with 2 knowledge sources (one-line) + 1 prompt source (multi-line bullets), requirements in shuffled order, a failed validate trial with assistant citations, a compliance rationale quoting a rule
- [ ] `test/judge.test.ts`: reactive fixture with `simulator` events and a fidelity rubric (today's fixture is `userMode: 'static'`)
- [ ] `.planning/phases/02-sudya-obyasnyaet-provaly/measure-undecided.mjs`: read-only, `--dist` default `<repo>/dist`; prints per run cards/decided/notMeasured by code, cut-eligible count (reads fidelity votes from `trial.judgeAudit` or the phase-1 sidecar via `store.readJudgeAudit`), per-card outcomes for `--cards`, and `--explain` buildability counts. Never prints text
- [ ] Framework install: none

## Security Domain

### Applicable ASVS Categories (Level 1)

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Pi owns provider auth |
| V3 Session Management | no | — |
| V4 Access Control | yes (local files, human intent) | Owner expectation text and acceptance only through native `ctx.ui` (editor/confirm/select); the model cannot supply them (same pattern as `agent_lab_review`) |
| V5 Input Validation | yes | zod: `judgedBeforeSeq` int ≥ 0, `ownerExpectationScenarioIds` `identifier` array max 40, owner text 1–3000; `setExpectation` checks the scenario id against the record |
| V6 Cryptography | no (integrity hashes only) | `fingerprint` (sha256) |
| V7 Error/Logging | yes | Pilot NO-GO recorded; paid steps in the ledger; errors keep their original text |
| V8 Data Protection | yes | Explanations contain bank dialogue text: they stay in the local record, CLI and Pi output; evidence copies go to `~/agent-lab-evidence/phase-02` (0700/0600); `.planning` gets ids/counts/hashes only; the customer-safe version is phase 5 |
| V12 Files | yes | No new file writers beyond phase-1 sidecars; the measurement script is read-only |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Terminal escape injection via quoted replies/rules/titles in the new lines | Tampering | `safeText`/`safeLine` at each surface boundary; `explain.ts` returns raw text |
| Model paraphrasing the owner's expectation in chat | Spoofing | The text comes only from `ctx.ui.editor`; `agent_lab_accept` takes `id` only |
| Hand-edited cut or receipt to turn «не измерено» into a verdict | Tampering / Repudiation | Full-audit path recomputes the cut from parsed votes; receipt seals `cutBefore`; tamper tests |
| Forged «подтверждено» | Spoofing | `acceptedDraftHash` must equal the current `draftHash` at `start({requireAccepted})` |
| Leaking bank text into `.planning` via research or measurement output | Information disclosure | Scripts print ids/counts/hashes only (as in this research) |

## Sources

### Primary (HIGH confidence)
- Source at HEAD `1dfb8a0`: `src/judge.ts` (whole file), `src/contracts.ts` (requirements, rubrics, assessments, audit, scenario, validation, patch/reassess schemas, experiment schema, `verbatimSpan`, `fingerprint`, `validatePreparation`), `src/experiment.ts` (hashes, `freshDraft`, validate create path, `updateDraft`, `acceptDraft`, `reassess`, `start`, `launch`), `src/evaluation.ts` (assess path), `src/outcomes.ts`, `src/simulator.ts`, `src/comparison.ts` (`goalCardOutcome`, `cardVerdict`, `compareRuns` notes), `src/result-view.ts`, `src/quality.ts` (`testPlanLines`, `groundedScore`, `firstReason`, `causes`), `src/prompts.ts` (`REQUIREMENTS_ROLE`, `ASSESS_ROLE`, `SIMULATOR_ROLE`, `GOALS_ROLE`), `src/pi.ts` (grounding, `evaluatorVersion`, `assess`), `src/cli.ts` (accept, reassess, args), `src/targets.ts` (`preflightTarget`), `extensions/cards.ts` (keys, sections, footer, help), `extensions/agent-lab.ts` (`runPlan`, `summary`, edit/accept/run tools, board loop), `test/experiment.test.ts:600-658`, `test/extension.test.ts:95-133, 325-366`, `test/judge.test.ts:1-60`.
- Phase-1 artifacts: `01-CONTEXT.md`, `01-RESEARCH.md`, `01-01-SUMMARY.md`, `01-04-PLAN.md`, `01-10-PLAN.md`, plan frontmatter 01-02…01-10, `snap-test.sh`, `verify-stored-runs.mjs`.
- Read-only measurements over `.agent-lab` (`fae4ee59`, `a92fd6ae`) with scratch scripts in the session scratchpad (`measure.mts`, `n.mts`, `n2.mts`, `h.mts`, node probes); only ids, seqs, codes, counts and hashes were printed.

### Secondary (MEDIUM confidence)
- Project memory notes (validator stub in aigw-local; sprint and pipeline notes) as context for the stock-reply finding.

### Tertiary (LOW confidence)
- Cost/time estimates for the reassessments (extrapolated from fae usage).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH (no new dependencies).
- Measurements (distribution, deviation position, buildability, rule order): HIGH (reproduced from stored records).
- Protocol v11 design and its effect on verification: HIGH for the code paths, MEDIUM for the predicted reduction (pilot-gated).
- TRUST-10/11 design: MEDIUM-HIGH (key choice and flows are design decisions; hash effects verified in code).
- Live cost/time: LOW–MEDIUM.

**Research date:** 2026-09-17
**Valid until:** end of 2026-09-18 (protocol freeze), or until `src/judge.ts`, `src/comparison.ts` or `src/result-view.ts` change in phase 1 beyond what its plans describe.

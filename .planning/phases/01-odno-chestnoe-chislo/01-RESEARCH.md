# Phase 1: Одно честное число - Research

**Researched:** 2026-09-16
**Domain:** Counting rules, comparability and evidence storage in an existing TypeScript LLM-agent evaluation harness (Pi extension + CLI)
**Confidence:** HIGH (every claim about behaviour was checked against source at HEAD `99aa533` and, where possible, reproduced read-only on stored runs with the current `dist/`)

## Summary

Phase 1 needs no new libraries. It is five small fixes plus one pure view-model. Measuring the stored pilot runs found **two defects the project research missed**. Both block success criteria directly:

1. **Every stored live run fails the judge-audit check, so every `diff` says «несравнимы».** `verdictSummary` (`src/comparison.ts:351`) and `compareRuns` (`src/comparison.ts:560`) call `hasCompleteJudgment` with the raw `record.sources`. The judge actually saw `observableSources(sources, requirements)` (`src/evaluation.ts:295`). When a source has `kind: 'prompt'`, the recomputed input hash never matches. On `fae4ee59` the check passes 0/13 with raw sources and 13/13 with observable sources; on `a92fd6ae` it is 0/14 and 14/14 [VERIFIED: read-only script over `.agent-lab`]. The existing tests missed this because they use `sources: []`. Without this fix, TRUST-05 cannot pass even with the `goalObservation` fix.
2. **Every judged `score` dialogue lands in «не измерено».** Imported trials are `userMode: 'scripted'`, but score settings keep the schema default `userModes: ['reactive']`. `goalCardOutcome` then finds no expected attempt and returns `unknown`. Reproduced: a code-only CLI score with fake pass verdicts counts 0 decided cards; with `userModes: ['scripted']` it counts 2/2 [VERIFIED: scratch reproduction]. This belongs in the shared `scoreSettings` (TRUST-07).

The rest matches `research/ARCHITECTURE.md`:
- A1: normalize `goalObservation` when comparing. On a copied legacy record, `repeat` → `diff` reports 15 cards as "changed" before normalization and 0 after.
- A2: harness-assigned goal ids.
- A3: shared `scoreSettings`.
- A4: judge-audit sidecar with a receipt on the trial.
- `ResultView`.

The trace journal of `fae4ee59` is 60 MB. About 99% of it is 325 repeated copies of the full judge audit for 13 trials. The JSON export (`jsonReport`) embeds the whole journal, so exporting `fae4ee59` today produces a file of more than 60 MB [VERIFIED].

For the positive control, the real dialogue `ae812a24-8f12-4190-b666-18c26c83a807` (topic: connecting a new sales point) passes `goal_attainment` in `a92fd6ae`, `424d6cb1` and `876679c6`. It is already one of the 13 situations in `fae4ee59`, where the judge's two votes split. The cheapest live plan is therefore to repeat `fae4ee59`, marking `ae812a24` as control **at record level**, and then run `diff`. That one paid run (~$1.9) covers the control (TRUST-04), comparability (TRUST-05), repeat stability (TRUST-09a) and the audit sidecar (TRUST-08). A second paid step, reassessing the saved `fae4ee59` answers (~$1–1.6), covers TRUST-09b.

**Primary recommendation:** Wave 0 fixes the `observableSources` call sites and `goalObservation` identity (pure, no hash changes). Next come the pure `src/result-view.ts` (Wilson interval, fixed Russian reason vocabulary, record-level `positiveControlScenarioIds`), the audit sidecar and `scoreSettings`. Then rebuild `dist/` from a snapshot at one coordinated Pi restart, and only after that run the paid checks.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Главная строка результата
- «Справился» = цель клиента достигнута (`goal_attainment` / `goalCardOutcome`). Строгое «соблюдены все правила» уходит из первой строки в подробности (доска, полный отчёт).
- Главная строка: «Справился в N из M проверенных ситуаций — P%». **Процент показывается всегда** (решение пользователя: «процент же нужен, точность итоговая»).
- Если M < 20, под главной строкой добавляется оговорка словами: «Мало данных: реальная доля где-то от X% до Y%» (95% интервал Уилсона, округление до целых). При M ≥ 20 оговорки нет, но диапазон можно показывать в подробностях.
- При M = 0 процента нет: «Проверенных ситуаций нет», а ниже причина из «не измерено».
- Одна фраза о происхождении набора: «Из K диалогов в набор вошли S». Причины исключения названы словами, слова «прочее» нет. Пример: `unconfirmed` → «в правилах нет ожидаемого ответа», `customer_data` → «нужны данные клиента», `masked` → «реплика клиента скрыта», `length` → «слишком длинный диалог».
- Остальные оценки («соблюдение правил промпта», «качество ответа») убираются с первого экрана и остаются в подробностях (доска и полный отчёт). Первая строка не показывает других знаменателей.
- Макет первого экрана:
  ```
  Справился в 3 из 12 проверенных ситуаций — 25%.
  Мало данных: реальная доля где-то от 9% до 53%.
  Не измерено: 4 — судья не уверен, голоса разошлись.
  Контроль: пройден ✓
  Из 40 диалогов в набор вошли 13. Не вошли 27: в правилах нет ожидаемого ответа — 21, нужны данные клиента — 6.
  ```

#### «Не измерено»
- «Не измерено» — ситуации прогона без вердикта по цели: без решения судьи, сбой измерения (invalid), не дошли, пометка симулятора. Они показаны отдельно от провалов и в знаменатель не входят.
- Показывается количество и одна главная причина словами (самая частая). Полный список причин с числами доступен в `ResultView.notMeasured[]`.
- Словарь причин фиксированный, по-русски, без внутренних терминов: «судья не уверен: голоса разошлись», «нет доказательства в ответе», «сбой агента или связи», «симулятор отклонился от диалога», «прогон остановлен до ситуации». Точные формулировки планировщик выводит из реальных источников `unknown` в коде (`judge.ts`, `outcomes.ts`).
- «Не вошли в набор» (исключения при сборке) — отдельная строка, это не «не измерено».

#### Контрольная ситуация
- Источник: настоящий диалог из 300 логов эквайринга на простую тему, с которой текущий агент справляется. Его находят живым прогоном. Если подходящего нет, берётся простая синтетическая ситуация, явно помеченная «синтетическая» (правило: доля синтетики всегда видна).
- В главное число «N из M» контрольная ситуация **не входит**. Она показана отдельной строкой: «Контроль: пройден ✓».
- Если контроль провален или не измерен, наверху стоит предупреждение: «Контроль не пройден — числу пока не верить: проверьте судью и связь с агентом».
- Контроль помечается в данных ситуации (планировщик выбирает поле; поле не должно ломать чтение старых записей и `draftHash` старых прогонов).

#### Нестабильность и повторы
- Нестабильные ситуации ищем двумя дешёвыми способами: (а) сравнение повтора с исходным прогоном того же набора через `diff`/`compareRuns` — пары `fixed`/`regressed` при неизменном агенте означают нестабильность; (б) переоценка сохранённых ответов (`reassess`) — вердикт судьи изменился на тех же ответах.
- Ситуации внутри одного прогона не повторяются (`repeats` остаётся 1): повторы меняют настройки и ломают сравнимость со старыми прогонами.
- Владелец видит метку «нестабильно» у ситуации и строку «Нестабильных: N» под главным числом. Нестабильные ситуации **остаются** в главном числе.
- Обещать «тот же результат при повторе» нельзя. Показываем только найденную нестабильность.

#### Живые проверки фазы
- Разрешено потратить до ~$10 на живые проверки на агенте эквайринга `aigw-local`: повтор старого прогона и `diff` с исходным, новый прогон с контрольной ситуацией и аудитом судьи вне записи, переоценку сохранённых ответов `fae4ee59`.
- Мок-сервер `aigw-local` запущен (порт 8090). Подключение `.agent-lab/connection.local.json` — command-таргет `aigw-local-baseline/local/agent_lab_target.py`. Git `aigw-local` во время прогонов не трогать.

### Claude's Discretion
(технические решения, пользователь просил решать самому)
- **Дефолт `goalObservation`**: нормализация применяется при сравнении (идентичность карточки в `compareRuns`), а не при разборе схемы. Пять разбросанных дефолтов (`experiment.ts:69-70, 358, 369, 526, 605`; `contracts.ts:431`) сводятся в `src/normalize.ts`. Отсутствующее поле и `'reply'` для внешних таргетов считаются равными.
- **id цели**: в replay-ветке validate `goal.id = dialogue.id` сразу после извлечения (`experiment.ts:~331`), до исключений и проверки.
- **Настройки score**: общий `scoreSettings(dialogueCount, supplied)` для CLI (`cli.ts:288`) и Pi (`agent-lab.ts:359-367`): масштабирование бюджета, `DEFAULT_JUDGE`, `timeoutMs: 600_000`.
- **Аудит судьи**: полный аудит хранится в отдельном файле рядом с записью (`{id}.judge/{trialId}.json`, атомарная запись). На trial остаётся маленькая квитанция с хешами. `hasCompleteJudgment` сохраняет старый путь для записей с полным аудитом. Журнал получает аудит один раз на завершённое голосование. Отчёт не встраивает полный аудит. Схема trial получает необязательное поле. Перед записью новых записей пересобрать `dist/` из снимка `git archive` и согласовать перезапуск Pi.
- **`ResultView`**: чистый модуль `src/result-view.ts`, импортирует только модули анализа (не `experiment.ts`). Внутри поле `countingRules` (версия правил счёта) и `scope`. CLI `summary` и `/agent-lab` (текущий блок) переводятся на него. Полноценные рендереры появятся в фазах 4–5.
- **Интервал**: Уилсон 95%, одна функция-помощник для всех поверхностей.
- Протокол судьи (`JUDGE_PROTOCOL`) в этой фазе не менять.

### Deferred Ideas (OUT OF SCOPE)
- Повторы внутри одного прогона (`repeats > 1`) для оценки стабильности — не делаем: дорого и ломает сравнимость.
- Индекс записей для быстрого `store.list()` — после демо.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TRUST-01 | Одно главное число с одним знаменателем, из одного места | `src/result-view.ts` → `buildResultView` + `resultViewLines`. Consumers in this phase: CLI `summary` (`src/cli.ts:88-96`), tool `renderResult` + `summary()` (`extensions/agent-lab.ts:20-38, 69-96`), board collapsed block + `verdictHeadline` (`extensions/cards.ts:186-215, 256-259`). See "Surfaces" |
| TRUST-02 | «Не измерено» отдельно, главная причина словами | Complete list of `unknown` paths and fixed vocabulary (see "Not-measured taxonomy"). Distribution measured on `fae4ee59` / `a92fd6ae` |
| TRUST-03 | Оговорка о малой выборке | `wilson(k, n)` with verified test vectors (see Code Examples) |
| TRUST-04 | Контрольная ситуация | Record-level `positiveControlScenarioIds`; candidate `ae812a24` (passes in 3 stored runs); procedure via `repeat` |
| TRUST-05 | Повтор сравним, дефолт `goalObservation` не ломает | A1 (reproduced: 15 → 0 changed cards) **plus the new defect D1** (`observableSources` at `comparison.ts:351,560`), and optionally a per-pair audit check |
| TRUST-06 | Совпадающий id цели не роняет сборку | A2 at `src/experiment.ts:331`; the throw is at `:344` → `contracts.ts:386` |
| TRUST-07 | Одинаковый score в CLI и Pi | `scoreSettings()`. Current differences listed with lines, **plus D2** (`userModes`/`repeats` for score) |
| TRUST-08 | Аудит судьи отдельно, размеры < 50 МБ, старые записи читаются | A4 sidecar + receipt. Journal cadence. `jsonReport` must stop embedding the journal. Reader list |
| TRUST-09 | Нестабильные ситуации | `stabilityBetweenRuns(before, after)` (goal-based, gated) and `stabilityAfterReassess(record, source)` (pairs by trial id) |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- TypeScript ESM, Node ≥ 22.19, `strict`, `noUncheckedIndexedAccess`; `.js` extensions in imports; 2-space indent; no formatter/linter.
- Runtime deps fixed: zod 4.5.4, typebox 1.3.7, Pi SDK / `pi-tui` 0.85.1. **No new runtime dependencies without an explicit reason** (this phase needs none).
- User-facing strings in Russian; identifiers, code and commands in English.
- Old JSON records must open and be reassessed **without migration**.
- Truth = JSON records + events; unobserved stays `unknown`; agent's words do not prove actions.
- Bank dialogues stay local (`.agent-lab`, mode `0600`), never in the repo. RESEARCH/PLAN files carry ids and counts only.
- `npm test` / `npm run build` delete `dist/`, which the live Pi imports. Run tests and reviews from a snapshot. Check `git status` / `git log` before editing (other sessions share the worktree).
- Do not touch git in `aigw-local*` during runs. A live run costs ~$2 and takes 6–17 min per 15 cards. The default judge is `openai/gpt-5.6-sol` via OpenRouter.
- Named exports, Zod schemas in `contracts.ts`, `throw new Error(msg)`, `null` = searched-not-found, `undefined` = not applicable.
- GSD workflow: file edits go through `/gsd-execute-phase`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Card outcome + not-measured reason | Analysis (`src/comparison.ts`, `src/outcomes.ts`) | — | The only place numbers are made; pure |
| Headline, Wilson range, wording, control line | View-model (`src/result-view.ts`) | — | One presentation object; pure, no `experiment.ts` import |
| Rendering text lines | Surfaces (CLI `summary`, tool `renderResult`, board block) | — | Render only; each escapes at its boundary (`safeText`) |
| `goalObservation` identity, goal ids, score settings | Orchestration helper (`src/normalize.ts`) | `src/experiment.ts`, `src/cli.ts`, `extensions/agent-lab.ts` | One place for defaults; call sites stay thin |
| Judge audit sidecar + receipt | Storage (`src/store.ts`) | `src/judge.ts` (receipt check), `src/evaluation.ts` (write point) | Bulky immutable evidence off the canonical record |
| Stability rows | Analysis (`src/comparison.ts`) | `src/artifacts.ts` (resolves `before`) | Needs two records; resolution is async, computation is pure |
| Positive-control marker | Record contract (`src/contracts.ts` experiment-level) | `repeat` / `loadSuite` / validate input | Must not change scenario fingerprint (see Pitfall 3) |

## Standard Stack

No new packages. Everything uses the existing stack.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | 4.5.4 | New optional schema fields (`judgeReceipt`, `positiveControlScenarioIds`) | Already the contract layer [VERIFIED: package.json] |
| node:crypto / node:fs/promises | Node 22.22.3 | Sidecar atomic write (`open wx` + `rename`), hashing via existing `fingerprint` | Same pattern as `store.save` (`src/store.ts:85-96`) |
| node:test via tsx | tsx ^4.20.0 | Tests | Existing runner [VERIFIED: package.json] |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-written Wilson (10 lines) | a stats package | A new runtime dep for one formula is forbidden by CLAUDE.md. The formula is textbook and covered by test vectors |
| Record-level control marker | `scenario.tier = 'smoke'` | `tier` already exists (`contracts.ts:270,278`), but it is in the scenario fingerprint. Marking a card in a repeat makes `compareRuns` report "Содержимое карточек изменилось" → «несравнимы» (conflicts with TRUST-05) |
| Record-level control marker | new optional `scenario.control` | Same fingerprint problem. Also forces a strict-schema change on scenarios |

**Installation:** none.

## Package Legitimacy Audit

No external packages are installed in this phase. **Packages removed due to [SLOP]:** none. **Packages flagged [SUS]:** none.

## Architecture Patterns

### System Architecture Diagram

```
                     ┌──────────── stored record {id}.json ─────────────┐
 CLI summary ───────►│ store.get(id)  (+ store.get(parentRunId|assessmentOf) for stability)
 /agent-lab board ──►│ evidenceBundle(record, store, beforeId) ─ before, comparison, view
 tool results ──────►│ summary(record) → adds `view`                     │
                     └───────────────────────────┬──────────────────────┘
                                                 ▼
                         buildResultView(record, { before? })   (pure, sync)
                                                 │
        ┌────────────────────────┬───────────────┼───────────────────────┬──────────────────────┐
        ▼                        ▼               ▼                       ▼                      ▼
  cardVerdict(record,s)   positiveControl   wilson(k,n)       exclusions → words     stabilityBetweenRuns /
  → pass|fail|unknown     split off the     → range text      (validationExclusions)  stabilityAfterReassess
    + reason code         denominator       when M < 20                                (only if before given)
        │                        │               │                       │                      │
        └────────────────────────┴───────────────┴───────────┬───────────┴──────────────────────┘
                                                             ▼
                                   ResultView { headline, notMeasured[], control, coverage,
                                                stability?, cards[], scope, countingRules }
                                                             │
                                                resultViewLines(view): string[]
                                                             │
                     ┌───────────────────────────────────────┼──────────────────────────┐
                     ▼                                       ▼                          ▼
             CLI stdout (cli.ts:88)             tool renderResult (agent-lab.ts:20)   board block (cards.ts:186)

 Judge write path (A4):
 assessRepeated ──save()──► ctx.onJudgment ──► store.writeJudgeAudit(run, trial)  → {run}.judge/{trial}.json (atomic, latest wins)
      │ done                                                                        
      ▼
 assessTrial ──► trial.judgeReceipt = sealReceipt(audit, legacyComplete(...))  ──► store.save(record)  (no judgeAudit on trial)
             └─► store.appendJudgment(run, trial, audit)   ONCE per finished judgment → {run}.trace.jsonl
```

### Recommended Project Structure (additions only)
```
src/
├── normalize.ts      # NEW: normalizeScenarioIdentity, DEFAULT_GOAL_OBSERVATION, scoreSettings, validateSettings (optional)
├── result-view.ts    # NEW: ResultView, buildResultView, resultViewLines, wilson, NOT_MEASURED_TEXT, EXCLUSION_TEXT, COUNTING_RULES
├── comparison.ts     # + goalCardOutcome (moved from quality.ts, exported), cardVerdict, stabilityBetweenRuns, stabilityAfterReassess
├── judge.ts          # + receipt path in hasCompleteJudgment; sealReceipt(); export rationale constants
├── store.ts          # + writeJudgeAudit / readJudgeAudit (sidecar)
test/
├── result-view.test.ts   # NEW
└── normalize.test.ts     # NEW (or extend experiment/comparison tests)
```

### Pattern 1: Normalize for identity, never rewrite stored evidence (A1)
**What:** `compareRuns` compares `fingerprint(normalizeScenarioIdentity(s, target.kind))` on both sides. For non-sandbox targets, a missing `goalObservation` equals `'reply'`. Parse-time schema stays unchanged.
**Why not at parse:** `judgeInput` includes `goalObservation` (`src/judge.ts:48`). The existing test `test/judge.test.ts:74` asserts that adding `goalObservation: 'reply'` makes `hasCompleteJudgment` false. Also `retainAcceptedTests` compares `fingerprint(scenario)` to `definitionHash` (`src/experiment.ts:53-59`).
**Where:** `src/comparison.ts:551` is the only identity site. `freshDraft` (`src/experiment.ts:69-70`) and the create path (`:358`, `:369`) keep writing `'reply'` for new external cards, sourced from one constant in `normalize.ts`.
**Evidence:** on a scratch copy of legacy `ef727981` (aigw-local evidence, no `goalObservation`), `repeat` then `diff` reports "Содержимое карточек изменилось" for all 15 cards. With normalization, 0 cards differ [VERIFIED: scratch reproduction]. That pair **stays** incomparable because its evaluator version is older (`Версия оценщика … отличается`). This is legitimate: legacy runs need a reassess first.

### Pattern 2: Pass the sources the judge actually saw (D1, new)
```typescript
// src/comparison.ts:351 and :560 — today both pass `record.sources` / `run.sources`
import { hasCompleteJudgment, observableSources } from './judge.js';
const judged = (run: Experiment, trial: Trial) => hasCompleteJudgment({
  scenario: run.scenarios.find(s => s.id === trial.scenarioId)!,
  sources: observableSources(run.sources, run.requirements),   // what evaluation.ts:295 sent
  trial,
});
```
**Why:** `evaluation.ts:295` sends `observableSources(sources, requirements)` to the judge. The audit `inputHash` is a fingerprint of that input. **Test gap:** add a fixture with a `kind: 'prompt'` source and a non-empty requirement list.

### Pattern 3: Per-pair judge completeness (recommended hardening for TRUST-05)
Today one measured trial with `assessmentError` (e.g. `424d6cb1` has one "Judge response rejected") makes `hasCompleteJudgment` false. `compareRuns:560` then pushes a **global** note, and every pair becomes incomparable. Move the check into the per-pair loop (`comparison.ts:571-578`) as `addIncomparable(row, 'Судья не завершил оценку этой попытки.')`. The rest of the run stays comparable. Mixed-protocol and model-mismatch notes (`:558-559`) stay global.

### Pattern 4: Receipt on the record, audit in a sidecar (A4)
```typescript
// contracts.ts — new, optional on trialSchema (strictObject)
export const judgeReceiptSchema = z.strictObject({
  protocolHash: text, inputHash: text, provider: text, model: text,
  configurationHash: text.optional(),
  transport: z.strictObject({ api: text, upstream: text.optional(), structured: z.boolean() }).optional(),
  auditHash: text,                                     // fingerprint(full audit as written to the sidecar)
  votes: z.array(z.strictObject({ metricId: identifier, result: z.enum(['pass', 'fail', 'unknown']).optional(), error: z.boolean().optional() })).max(24),
  notApplicable: z.array(identifier),
  complete: z.boolean(),                               // legacy hasCompleteJudgment on the full audit at write time
});
// trialSchema: judgeReceipt: judgeReceiptSchema.optional()
```
- `hasCompleteJudgment`: if `trial.judgeAudit` is present → current body, unchanged (legacy path). Else if `judgeReceipt` → `complete && !assessmentError && protocolHash === expected(configurationHash) && inputHash === fingerprint(judgeInput(applicable))`. Also: every applicable metric has exactly 2 votes, and their unanimous-or-unknown aggregate equals `trial.assessments[m].result`. This mirrors `judge.ts:134-139`.
- Write point: `src/evaluation.ts:296-298` stops copying the audit onto the trial. It keeps the latest audit in a local variable, and after the assessments are computed sets `trial.judgeReceipt`. `complete` is computed by calling the legacy check on `{ ...trial, judgeAudit: audit, assessments }` with the **observable** sources.
- `ctx.onJudgment` (`src/experiment.ts:949`) → `store.writeJudgeAudit(record.id, trialId, audit)`: tmp file + `rename`, dir `0700`, file `0600`, `idPattern` on both ids (path safety). The journal gets `appendJudgment` once, when the judgment finishes (success or rejection).
- `reassess` (`src/experiment.ts:804`): also `delete trial.judgeReceipt`.
- `suiteEvidence` (`src/connection.ts:128-134`): legacy trials copied into `sourceEvidence` should drop `judgeAudit` and carry a receipt instead. Today a reassess record duplicates 1.56 MB of source audits (`29dd5210`) [VERIFIED].
- Readers to update: `src/comparison.ts:555-556` (`t.judgeAudit ?? t.judgeReceipt` for protocol/provider/model), `src/quality.ts:535` (model), `src/report.ts:89` (show provider/model/protocol/vote count only, **never** `JSON.stringify(audit)`, including for legacy trials), `src/report.ts:244`, `src/artifacts.ts` / `src/report.ts:197-200` (`jsonReport` must not embed `traceJournal`; reference its path).

### Pattern 5: Record-level positive control (TRUST-04)
- Field: `positiveControlScenarioIds: z.array(identifier).max(5).optional()` on `experimentSchema` and the `Experiment` interface. Do **not** name it `control…`: `split: 'control'` and `controlConsumedAt` already mean the held-out split of the legacy compare workflow (`contracts.ts:721`, `outcomes.ts:16`).
- Hashes: `fingerprint` uses `JSON.stringify` after key sorting (`src/contracts.ts:933-937`), so a key whose value is `undefined` is dropped. Adding `positiveControlScenarioIds: record.positiveControlScenarioIds` to `draftHash` therefore leaves every old draft hash unchanged [VERIFIED: src/contracts.ts:933-937]. Keep it **out of** `measurementHash` (the frozen guard must not trip), and out of `compareRuns` card identity.
- Propagation: `freshDraft` uses `structuredClone`, so repeats and saved suites inherit the field. When `scenarioIds` filters cards, filter the control ids too.
- Setting it: CLI `repeat --id RUN --control SCENARIO_ID` (new `parseArgs` option, multiple) and Pi `agent_lab_repeat` optional `controlScenarioIds`. Validate that each id exists in `record.scenarios`. Optional for validate builds: `createInputSchema.controlDialogueIds`. Input schemas are not persisted, so this is safe. The build must force-include those dialogues in the pool and skip the `validationCount` cap for them.
- Counting: control cards are removed from `N/M` and from `notMeasured`. The control line shows their own `cardVerdict`. `provenance: 'synthetic'` → the line says «синтетическая».

### Pattern 6: Stability without in-run repeats (TRUST-09)
- **(a) Between runs:** `stabilityBetweenRuns(before, after)`. Gate: `compareRuns(before, after).comparable === true`, **and** equal `targetFingerprint`, **and** equal `targetVersion` (otherwise the agent changed, which is not instability). For each shared card, compare `goalCardOutcome` on both sides. A change pass↔fail is **unstable**. A change decided↔unknown is not counted (say «не с чем сравнить»). Use the goal outcome, not `compareRuns.fixed/regressed`: those use `cardOutcome` / `automaticTrialResult` (all agent rubrics, `comparison.ts:495-500, 81-87`), which is the strict criterion, not the headline criterion.
- **(b) After reassess:** `stabilityAfterReassess(record, source)`. Precondition: `record.assessmentOf === source.id` and `record.evidenceHash` present. Reassess trials keep the source trial ids (`structuredClone(original)`, `experiment.ts:802`), so pair by trial id. For each card, compare `goalCardOutcome(sourceView)` with `goalCardOutcome(record)`; pass↔fail → unstable. `source` can be the stored run or a reconstruction from `record.sourceEvidence` (same approach as `embeddedBefore`, `src/artifacts.ts:23-39`: `manifestHash` must be taken from the source trials, or `goalCardOutcome` rejects them at `quality.ts:417`). Do not use `compareRuns` here: it always adds «Это переоценка сохранённых ответов…» (`comparison.ts:547`).
- Observed today: `29dd5210` reassessed 1 trial (`c26ee52c…`). Its source had no goal verdict (judge rejected), the reassess gives `fail`, so there are 0 unstable cards under the pass↔fail rule [VERIFIED].
- Side signal: a goal-vote split (`judge.ts:203-204`) is judge instability on an identical input. It stays a not-measured reason and is **not** counted as «нестабильно» (it is not in the headline).

### Anti-Patterns to Avoid
- **Bumping `VERSION` (`src/contracts.ts:4`) for the new fields.** `evaluatorVersion` includes `protocol: VERSION` (`src/pi.ts:77`), and `measurementHash` includes it (`src/experiment.ts:45`). A bump makes every stored run incomparable and makes `start` refuse old drafts (`experiment.ts:890`). Optional fields need no version bump.
- **Changing `JUDGE_PROMPT` / `JUDGE_RESPONSE_FORMAT` / the rationale strings inside them.** This is forbidden this phase. The rationale strings at `judge.ts:104, 202, 204` are not part of `JUDGE_PROTOCOL`, but keep their text byte-identical anyway: reason detection matches on them.
- **Rebuilding `dist/` inside the worktree with `npm run build`.** It deletes `dist/` under a live Pi.
- **A renderer computing its own count.** Every number on the three surfaces comes from `ResultView`.
- **Putting the control marker on the scenario.** It breaks the TRUST-05 demo diff (Pitfall 3).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Card outcome for headline | A new counter | `goalCardOutcome` (move to `comparison.ts`, export) | Already enforces modes × repeats, manifest, `measurementUsable`, human override (`quality.ts:408-421`) |
| Atomic sidecar write | Ad-hoc `writeFile` | Copy `store.save` pattern (`store.ts:85-96`) | Crash safety + `0600` |
| Stable hashes | `JSON.stringify` compare | `fingerprint` (`contracts.ts:933`) | Key-order independent; same as every existing hash |
| Rendering safety | Custom escaping | `safeText` (`extensions/cards.ts:10-13`, `cli.ts:22-24`) | Terminal escape injection from model text (card titles) |
| Judge completeness | New verifier | Existing `hasCompleteJudgment` body as the legacy path + receipt path | Keeps legacy runs verifiable with raw replies |
| Plurals | New helper | `plural` (`quality.ts:370`) | Russian 1/2/5 forms already handled |

**Key insight:** every figure already exists in `outcomes.ts` / `comparison.ts`. What is missing is one reason code per unknown card and one place that turns counts into words.

## Not-measured taxonomy (TRUST-02) — exhaustive

The headline card outcome is `goalCardOutcome` (`src/quality.ts:408-421`). A card is "not measured" when it returns `unknown`, or when `cardScore` counts it as invalid or not reached (`quality.ts:423-437`). The paths below are listed in the order the code evaluates them. The first match on the card's trials is the reason. `cardVerdict(record, scenario)` should return `{ outcome, reason? }` with these codes:

| # | Code | Code path (verified) | Proposed Russian phrase |
|---|------|----------------------|-------------------------|
| 1 | `in_progress` | no trials yet and `runningPhases.has(record.phase)` (`outcomes.ts:8`) | «ещё не проверена» |
| 2 | `not_reached` | no trial for the card (`quality.ts:413-415`, `cardScore.notReached` `:431`) | «прогон остановился раньше этой ситуации» |
| 3 | `stopped` | trial `outcome: 'cancelled'` (`evaluation.ts:258, 267`) | «диалог остановлен до конца» |
| 4 | `turn_limit` | `outcome: 'invalid'`, reason «Разговор не завершился в отведённое число реплик.» (`evaluation.ts:247-248`) | «разговор не уложился в лимит реплик» |
| 5 | `simulator_error` | `invalid`, reason starts «реплика симулированного пользователя:» (`evaluation.ts:62-67, 259`) | «сбой симулятора» |
| 6 | `agent_error` | `invalid`, any other stage («ответ испытуемого:», «открытие сессии с испытуемым:») or cleanup failure (`evaluation.ts:259, 265`) | «сбой агента или связи» |
| 7 | `attempts_mismatch` | trial count / mode / repeat keys differ from the plan, or `familyId`/`split`/`manifestHash` mismatch (`quality.ts:411-417`) | «запись ситуации неполная» |
| 8 | `judge_error` | `trial.assessmentError`, not cancelled/budget (`outcomes.ts:75`; set at `evaluation.ts:283`, `judge.ts:195`) | «судья ответил не по формату» |
| 9 | `judge_stopped` | `assessmentError` matching `cancelled` / budget / time limit (`evaluation.ts:283`, `experiment.ts:933, 939`) | «оценка прервана: кончились время или бюджет» |
| 10 | `human_invalid` | latest whole-dialogue human verdict `invalid` (`outcomes.ts:76`) | «человек отметил ситуацию как ошибочную» |
| 11 | `reset_unconfirmed` | external initial state without `resetConfirmed` (`outcomes.ts:77`) | «агент не подтвердил сброс состояния» |
| 12 | `simulator_deviated` | simulator heuristic check failed (`outcomes.ts:64-66`; ids `simulator_leak`, `simulator_fabrication`, `simulator_loop`) **or** `user_fidelity` = `fail` (`outcomes.ts:67-69`) | «симулятор отклонился от диалога» |
| 13 | `simulator_unclear` | `user_fidelity` = `unknown` or missing (`outcomes.ts:69` requires `'pass'`) | «судья не уверен, что симулятор держался диалога» |
| 14 | `judge_split` | goal assessment rationale starts «Судья разошёлся на неизменном входе» (`judge.ts:203-204`) | «судья не уверен: голоса разошлись» |
| 15 | `no_evidence` | goal rationale **contains** «Достижение цели не подтверждено цитированным доказательством» (`judge.ts:98-104`). With 2/2 agreement it is prefixed by «Совпало 2/2…», so use `includes`, not `^` | «нет доказательства в ответе» |
| 16 | `judge_unclear` | goal `unknown` for any other reason (a condition `unclear`, or both conditions met, `judge.ts:69-70`) | «правила не дают однозначного ответа» |
| 17 | `not_judged` | no `goal_attainment` assessment (code-only, runtime without `assess`) | «судья не оценивал ситуацию» |
| 18 | `human_unknown` | latest metric-level human verdict on `goal_attainment` = `unknown` (`outcomes.ts:35-37`) | «человек не смог решить» |

Implementation notes:
- Export the three rationale strings from `judge.ts` as named constants without changing their text, and match on those constants. `JUDGE_PROTOCOL` fingerprints only the prompt, format and flags (`judge.ts:20`), so this is protocol-neutral.
- Main reason: highest count; ties broken by the table order above.
- `in_progress` should not appear as «не измерено» in a finished run.
- Legacy runs whose cards have no `goal_attainment` fall back to `cardOutcome` (`quality.ts:410`). Map `unknown` there to the same codes where they apply (codes 1–11), otherwise `judge_unclear`.

**Measured distribution (read-only script over current `dist/`)** [VERIFIED]:

| Run | Cards | pass/fail | Not measured | Reasons |
|-----|-------|-----------|--------------|---------|
| `fae4ee59` (13 cards, reactive) | 13 | 0 / 9 | 4 | `simulator_deviated` 2 (fidelity fail), `simulator_unclear` 1 (fidelity votes split), `judge_split` 1 |
| `a92fd6ae` (15 cards, reactive) | 15 | 1 / 7 | 7 | `simulator_deviated` 4, `simulator_unclear` 1, `judge_split` 1, `agent_error` 1 (HTTP 500 from the target) |
| `424d6cb1` (15, scripted, old protocol) | 15 | 1 / 12 | 2 | `judge_error` 1 («Judge response rejected»), `agent_error` 1 (HTTP 400) |
| `876679c6` (15, scripted, old protocol) | 15 | 1 / 11 | 3 | `not_reached` 2, `agent_error` 1 |

**Consequence for the mock-up:** on `fae4ee59` the main reason is «симулятор отклонился от диалога» (2 of 4), not «голоса разошлись». The CONTEXT mock-up is illustrative. Tests must use the real codes. The current `summary` also shows «Судья: … без решения 3» next to «Без решения по цели: 4»: two different denominators. The new block must show only the card-level count.

### Exclusions vocabulary (not «не измерено»)
The `validationExclusionSchema` kinds, quoted verbatim [VERIFIED: src/contracts.ts:215-217]: `kind: z.enum(['customer_data', 'masked', 'length', 'unconfirmed'])`.

| Kind | Set at | Phrase |
|------|--------|--------|
| `unconfirmed` | `experiment.ts:334-335` (the goal is missing, or its testability is not `knowledge`/`customer_data`) | «в правилах нет ожидаемого ответа» |
| `customer_data` | `experiment.ts:334` | «нужны данные клиента» |
| `masked` | `imports.ts:9` | «реплика клиента скрыта» |
| `length` | `imports.ts:8` (`!users.length \|\| users.length > 16`) | «слишком длинный диалог или нет реплик клиента». The code also uses `length` for zero client turns; CONTEXT's «слишком длинный диалог» is incomplete |

- K = `record.dialogues.length + validationExclusions.length`. On `fae4ee59` this is 13 + 27 = 40, as in the mock-up [VERIFIED]. Caveat: the goal loop stops once `validationCount` cards are found (`experiment.ts:329`). Unexamined dialogues are dropped without an exclusion entry, so K means "просмотренных" dialogues.
- The free-text `reason` on exclusions comes from the model (`testabilityReason`), so never show it on the first screen.
- Replace the «прочее» branch in `qualityLines().coverage` (`quality.ts:559-561`) with the same vocabulary. `report.ts` still uses it, so the text stays consistent. Update `test/quality.test.ts:589` and `test/experiment.test.ts:716`.

## Surfaces: where the headline is built today (TRUST-01)

| Surface | Current code | Phase 1 action |
|---------|--------------|----------------|
| CLI `summary` | `src/cli.ts:88-96`: `qualitySummary` → `qualityLines` → 3 denominators + «прочее» | **Switch:** print `resultViewLines(view)` first, then the existing detail lines (metrics, causes, scope). `--json` keeps the `q` object and adds a `view` key. For stability, `store.get(record.assessmentOf ?? record.parentRunId)` in a try/catch; do not use `evidenceBundle`, which reads the whole journal |
| Tool result text (Pi) | `extensions/agent-lab.ts:20-38` parses JSON and shows `data.quality.headline` | **Switch:** show `data.view.lines` (headline block) when present; keep the fallbacks |
| Tool payload | `summary()` `extensions/agent-lab.ts:69-96` | **Add** `view: buildResultView(record)` (and `lines`). Used by inspect (`:452-453`), run (`:561`), score, reassess, repeat |
| `/agent-lab` board, collapsed ИТОГ | `extensions/cards.ts:186-215` (`q.headline`, `text.coverage`, `v.headline`, metric bars, `НЕ ИЗМЕРЕНО` shows only the first invalid trial) | **Switch** the top lines (headline, range, not measured, control, stability, coverage) to `resultViewLines(view)`; keep the causes/queue/scope lines below. Pass `bundle.view` from `extensions/agent-lab.ts:726-729` or build it in place (pure) |
| Board results-tab title | `verdictHeadline` `extensions/cards.ts:256-259` | **Switch** to `view.headline.text`. Update `test/cards.test.ts:308` |
| Expanded board (`Enter`) | `cards.ts:217-254` | Later (phase 4) |
| HTML/Markdown report | `src/report.ts:125-135, 208-210` | Later (phase 5). **But** in this phase: stop embedding audits (`:89`) and the journal (`jsonReport`) — TRUST-08 |
| CLI `run`/`evaluate`/`score` JSON | `cli.ts:305, 343-347, 371-374` | Add a `view` key (cheap, keeps one source); the text layout can wait |

Keep `QualitySummary.headline` and `qualityLines` for the report and the expanded board. Existing tests assert them (`test/quality.test.ts:184, 217-218`).

**Import rule:** `result-view.ts` imports `contracts.js`, `outcomes.js`, `comparison.js` only. `quality.ts` imports `draftHash` from `experiment.ts` (`quality.ts:5`), so `result-view.ts` must not import `quality.ts`. Move `goalCardOutcome` into `comparison.ts` next to `cardOutcome` (`:495`); `quality.ts` then imports it. `quality.ts` may import the vocabulary constants from `result-view.ts` (no cycle).

## Score settings (TRUST-07) — exact current differences

| Setting | Pi score (`extensions/agent-lab.ts`) | CLI score (`src/cli.ts:288`) |
|---------|--------------------------------------|------------------------------|
| `maxCalls` | `min(3000, max(20, 8 × dialogues))` (`:292`, applied `:360`) | schema default `300` (`contracts.ts:57`) unless the task file sets it |
| `maxDurationMs` | `min(14_400_000, max(180_000, 120_000 × dialogues))` (`:293`, `:361`) | schema default `600000` (`contracts.ts:61`) |
| `judge` | `DEFAULT_JUDGE` in live mode (`:362`) | none → the judge falls back to the builder model |
| `timeoutMs` | `600_000` (`:364`) | schema default `120000` (`contracts.ts:59`) |
| `repeats` | `1` (`:359`) | schema default `2` (`contracts.ts:54`) |
| `userModes` | schema default `['reactive']` | schema default `['reactive']` |
| provider/model | `supplied` or `ctx.model` (`:367`) | task file only |
| precedence | `...supplied` overrides the computed values (`:365`) | task file only |

Verbatim settings defaults [VERIFIED: src/contracts.ts:54-62]: `repeats: … .default(2)`, `maxCalls: … .default(300)`, `timeoutMs: … .default(120000)`, `maxDurationMs: … .default(600000)`, `userModes: … .default(['reactive'])`. `DEFAULT_JUDGE` [VERIFIED: src/contracts.ts:5]: `{ provider: 'openrouter', model: 'openai/gpt-5.6-sol', upstream: 'openai' }`.

**Defect D2 (new):** trials imported by `dialogueToTrial` are `userMode: 'scripted'`, `repeat: 0` (`contracts.ts:441`). `goalCardOutcome` expects `settings.userModes × settings.repeats` (`quality.ts:411-415`), so with `['reactive']` every judged score card is `unknown` in both CLI and Pi. `scoreSettings` must set `userModes: ['scripted']`, `repeats: 1`. This is safe: `evaluatorVersion` includes provider, model, roles and judge only (`pi.ts:77-78`), not `userModes`/`repeats`. Old score records keep their all-unknown headline; phase 1 does not re-interpret them.

```typescript
// src/normalize.ts — one helper for both call sites
export function scoreSettings(dialogueCount: number, supplied: Partial<Settings>, mode: 'live' | 'demo'): Partial<Settings> {
  return {
    repeats: 1, userModes: ['scripted'],
    maxCalls: Math.min(3000, Math.max(20, 8 * dialogueCount)),
    maxDurationMs: Math.min(14_400_000, Math.max(180_000, 120_000 * dialogueCount)),
    ...(mode === 'live' ? { judge: DEFAULT_JUDGE } : {}),
    timeoutMs: 600_000,
    ...supplied,                // owner's explicit values still win, as in Pi today
  };
}
```
CLI: `createInputSchema.parse({ ...raw, settings: scoreSettings(dialogues.length, raw.settings ?? {}, raw.mode ?? 'live'), … })`. Pi `:359-367`: replace the score branches with the helper. **Optional, same helper file:** `validateSettings(poolSize, validationCount, supplied)` for the Pi validate formulas at `agent-lab.ts:300-301, 360-361, 366`, so a CLI `build` with `validationCount` gets the same budget. `lab.create` already forces `userModes: ['reactive']` for validate (`experiment.ts:278`).

## Duplicate goal id (TRUST-06) — exact path

- The model picks `goal.id`. In replay mode each dialogue returns at most one goal, validated **per dialogue** (`src/pi.ts:620-648`), so the per-batch check cannot see cross-dialogue duplicates.
- Batches are merged at `src/experiment.ts:331-337`. Then `validateObservedGoals(observedGoals, …)` at `:344` throws `'Observed goals have duplicate IDs'` (`src/contracts.ts:386`). This happens after every paid `goals` call and before `runtime.prepare`, so all the goal work is lost.
- Fix: inside the batch loop, `const extracted = (await Promise.all(batch.map(async d => (await extract(d)).map(g => ({ ...g, id: d.id }))))).flat();`. Dialogue ids are unique by schema (`contracts.ts:489`, «Duplicate dialogue IDs») and use the same `identifier` regex (`contracts.ts:304`). Scenario ids already equal the dialogue id (`contracts.ts:423`), so no card identity changes.
- Test: extend `test/experiment.test.ts` around `:670-728` (the injected-runtime validate test). Make `goals` return `id: 'same'` for every dialogue and assert `phase === 'review'`.
- No stored run in `.agent-lab` shows this failure. The stored `error` records are deadline/connection failures and «Материалы владельца задают ожидаемый ответ только для 14 из 15…» (`61064c55`). The defect is verified from code only.

## Audit sidecar (TRUST-08) — sizes and readers

| Run | Record | Trace | Audits inside record | Notes |
|-----|--------|-------|----------------------|-------|
| `fae4ee59` | 3.43 MB | 60.0 MB | 1.93 MB | Trace: 506 lines, 325 of them full audit copies (~99% of the bytes) |
| `a92fd6ae` | 3.78 MB | 49.6 MB | 2.15 MB | |
| `424d6cb1` | 2.73 MB | 28.1 MB | 1.56 MB | |
| `29dd5210` (reassess) | 2.91 MB | 1.9 MB | 0.11 MB + **1.56 MB in `sourceEvidence`** | Export: HTML 3.3 MB, JSON snapshot 7.8 MB (record 1.85 M chars + journal 1.42 M + `before` 1.74 M) |
| legacy aigw-local evidence | 5.4–8.8 MB | 38–61 MB | — | |

[VERIFIED: read-only script + `ls -la`]

- `store.get` does **not** read the trace (`store.ts:97-105`); the 50 MB limit is at `:100`. `evidenceBundle` **does** read the whole trace (`artifacts.ts:60`), and the board calls it every 750 ms during a run (`cards.ts:287-288` → `agent-lab.ts:729`). `jsonReport` embeds it (`report.ts:197-200`). That is the "report" path to the 50 MB limit.
- Why the journal is large: `assessRepeated` calls `save()` → `ctx.onJudgment` → `store.appendJudgment` (a full audit per line) at start, per attempt start, per streamed partial (`recordPartial`, `pi.ts:707-709`), after the response and after parsing (`judge.ts:157-187`).
- All `judgeAudit` readers, from a grep over `src/` and `extensions/` [VERIFIED: grep]: `comparison.ts:555-556`, `quality.ts:535`, `report.ts:89, 244`, `evaluation.ts:297` (writer), `experiment.ts:804` (delete on reassess), `store.ts:137` (journal). `connection.ts:128-134` copies trials wholesale. `extensions/` has none.
- Acceptance numbers for the new run: the record contains no `"judgeAudit"` key; the record is under ~2 MB for 14 cards (≈ 3.4 MB − 1.9 MB); `{id}.judge/` has one `0600` file per judged trial; the trace is under 5 MB; a JSON export is under 10 MB; `fae4ee59` still opens, gets the same `summary` numbers and passes the legacy `hasCompleteJudgment` (after D1).
- **Forward-compat risk:** `trialSchema` and `experimentSchema` are `strictObject` (`contracts.ts:748, 815`). A Pi session still on the old `dist/` fails to parse any new record (it shows up in `store.diagnostics` / the board list as «Запись не соответствует формату»). Rebuild and restart **before** the first paid run.

## Runtime State Inventory (coordination, not a rename)

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | `.agent-lab/*.json` (15 records), traces, `grounding/` cache, `exports/`; legacy evidence under `aigw-local/local/evidence/*/.agent-lab*` | None. No migration. New optional fields only. Never write to legacy evidence dirs |
| Live service config | Live Pi session imports `dist/*.js` (`extensions/agent-lab.ts:8-17`) and `extensions/cards.ts` directly | Human checkpoint: rebuild `dist/` from a snapshot and restart Pi before the first new record |
| OS-registered state | aigw-local mock server on :8090 (responded 404 on `/`, so it is up) | None; keep it running |
| Secrets/env vars | `OPENROUTER_API_KEY` is not in the shell env; Pi auth under `~/.pi/agent`; `dist/cli.js status` lists `openrouter/openai/gpt-5.6-sol` and `z-ai/glm-5.3-flash` | None. OpenRouter balance not checked |
| Build artifacts | `dist/` built 2026-09-16 18:40 from `015fee9` (same `src/` as HEAD); gitignored | Replace via `rsync -a --delete $SNAP/dist/ $REPO/dist/` at the agreed restart |
| Writer lock | `.agent-lab/.lock` absent now; the Pi board / any tool holds it while open | Close `/agent-lab` in Pi before CLI paid runs, otherwise `init()` throws «already open» |

## Common Pitfalls

### Pitfall 1: Fixing `goalObservation` alone and expecting `diff` to work
**What goes wrong:** the diff still says «несравнимы: Для сравнения оценок модели нужны сохранённые ответы…».
**Why:** D1. The raw-sources call to `hasCompleteJudgment` fails for every run with a prompt source.
**How to avoid:** fix D1 in the same wave. Add a test with a prompt source.
**Warning signs:** `summary`'s confidence reasons contain `judge_unaudited` on `fae4ee59`.

### Pitfall 2: Demonstrating TRUST-05 on an old-protocol run
**What goes wrong:** `repeat` of `424d6cb1`/`876679c6`/legacy evidence stays incomparable: «Версия оценщика или его инструкций отличается».
**Why:** those audits carry an older `JUDGE_PROMPT` (`prompt_differs` on 13/13 trials) and a different `evaluatorVersion`. `freshDraft` recomputes it (`experiment.ts:79`).
**How to avoid:** repeat **`fae4ee59`** (evaluatorVersion matches current code [VERIFIED]).

### Pitfall 3: Marking the control inside the scenario
**What goes wrong:** the repeat of `fae4ee59` with `ae812a24` marked → «Содержимое карточек изменилось» → the whole diff becomes incomparable.
**How to avoid:** use record-level `positiveControlScenarioIds`, excluded from card identity and from `measurementHash`.

### Pitfall 4: Stability from strict pair changes
**What goes wrong:** «нестабильно» is flagged because `prompt_compliance` or `reply_quality` flipped while the goal verdict did not, so it disagrees with the headline.
**How to avoid:** base stability on `goalCardOutcome` on both sides, gated on comparability and an unchanged agent.

### Pitfall 5: Rationale matching with `^`
**What goes wrong:** an agreed «нет доказательства» is classified as `judge_unclear`.
**Why:** `assessRepeated` prefixes agreed votes with «Совпало 2/2 оценок…» (`judge.ts:202`).
**How to avoid:** match `no_evidence` with `includes`; `judge_split` with `startsWith`.

### Pitfall 6: Wilson at the edges
**What goes wrong:** `-0%` or `101%` from floating error; a range shown when M = 0.
**How to avoid:** clamp to [0, 1]; return `null` for n = 0; round with `Math.round(x * 100)`.

### Pitfall 7: Testing in the worktree
**What goes wrong:** `npm test` deletes `dist/` and the live Pi breaks mid-demo prep.
**How to avoid:** use a snapshot (see Validation Architecture). `test/store.test.ts:99`, `workflow.test.ts`, `extension.test.ts`, `product-flow.test.ts` and `reference-dataset.test.ts` need a built `dist/`, so a worktree `tsx --test` would test a stale `dist/` for them.

### Pitfall 8: CLI `run` without `--parallel`
**What goes wrong:** 13 reactive dialogues run one after another (`parallel` defaults to 1, `experiment.ts:874`), so the run takes much longer.
**How to avoid:** pass `--parallel 8`. This matches Pi `runParallel` (`agent-lab.ts:138-140`) and does not change hashes (`experiment.ts:872`).

### Pitfall 9: The control is itself unstable
**What goes wrong:** `ae812a24` split the judge in `fae4ee59` (pass/? votes), so the control can come out «не измерен» → the warning line.
**How to avoid:** accept this; it is the honest outcome. If it happens in the live repeat, pick the fallback: a clearly labelled synthetic control, or a second candidate from the 40-dialogue pool found by the same passing rule.

## Code Examples

### Wilson interval + wording
```typescript
// src/result-view.ts — no dependency; z for 95%
const Z = 1.959963984540054;
export function wilson(passed: number, decided: number): [number, number] | null {
  if (decided <= 0) return null;
  const p = passed / decided, d = 1 + Z * Z / decided;
  const centre = (p + Z * Z / (2 * decided)) / d;
  const half = Z * Math.sqrt(p * (1 - p) / decided + Z * Z / (4 * decided * decided)) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
const pct = (x: number) => `${Math.round(x * 100)}%`;
// M < 20 → `Мало данных: реальная доля где-то от ${pct(lo)} до ${pct(hi)}.`
```
Test vectors computed this session with this formula [VERIFIED: node]:

| k/n | Range | k/n | Range |
|-----|-------|-----|-------|
| 0/9 | 0–30% | 12/12 | 76–100% |
| 1/8 | 2–47% | 5/19 | 12–49% |
| 3/12 | 9–53% (matches the CONTEXT mock) | 9/10 | 60–98% |
| 0/1 | 0–79% | 0/13 | 0–23% |
| 1/1 | 21–100% | 1/14 | 1–31% |

### Expected first block for stored `fae4ee59` after phase 1 (no control marker, legacy record)
```
Справился в 0 из 9 проверенных ситуаций — 0%.
Мало данных: реальная доля где-то от 0% до 30%.
Не измерено: 4 — главная причина: симулятор отклонился от диалога (2).
Контроль: не задан.
Из 40 диалогов в набор вошли 13. Не вошли 27: в правилах нет ожидаемого ответа — 21, нужны данные клиента — 6.
```
Recommendation: show «Контроль: не задан» explicitly, so that a missing control is visible [ASSUMED: wording]. For a repeat with `ae812a24` as control, the denominator is ≤ 12 and the control line follows that card's verdict.

### ResultView shape for this phase (subset of research/ARCHITECTURE.md)
```typescript
export const COUNTING_RULES = 'goal-v1';   // goal_attainment per card; positive controls excluded
export interface ResultView {
  runId: string; phase: Experiment['phase']; countingRules: string;
  headline: { passed: number; decided: number; accuracy: number | null; range: [number, number] | null; text: string; smallSample: string | null };
  notMeasured: { total: number; reasons: { code: NotMeasuredCode; label: string; count: number; scenarioIds: string[] }[] };
  control: { cards: { scenarioId: string; title: string; outcome: 'pass' | 'fail' | 'unknown'; synthetic: boolean }[]; warning: string | null } ;
  coverage: { examined: number; included: number; excluded: { kind: ValidationExclusion['kind']; label: string; count: number }[]; text: string | null };
  stability?: { basis: 'repeat' | 'reassess'; comparedWith: string; unstable: { scenarioId: string; title: string; before: 'pass' | 'fail'; after: 'pass' | 'fail' }[]; text: string };
  cards: { scenarioId: string; title: string; outcome: 'pass' | 'fail' | 'unknown'; reason?: NotMeasuredCode; control: boolean; unstable: boolean; provenance: Scenario['provenance'] }[];
  scope: { cards: number; synthetic: number; dialogues: number; judgeModel?: string; costUsd: number | null; target: string };
}
export function buildResultView(record: Experiment, options?: { before?: Experiment }): ResultView;
export function resultViewLines(view: ResultView): string[];   // the only text used by CLI summary, tool renderResult and the board block
```
Apply `observedRecord(record)` first, as `qualitySummary` does (`quality.ts:484`).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Three denominators on line 1 (goal, strict, judge) | One goal denominator + a Wilson caveat | This phase | Update tests `quality.test.ts:184,217-218` only if `qualitySummary.headline` changes (recommended: leave it) |
| Full judge audit on every trial + journal copy per save | Sidecar + receipt, journal once per judgment | This phase | New records only; the legacy path stays |
| «прочее» for `length`/`unconfirmed` | Named kinds | This phase | `quality.test.ts:589` changes |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Russian phrases in the taxonomy table (beyond the five CONTEXT gives) are acceptable wording | Not-measured taxonomy | Cosmetic; the user may reword |
| A2 | «Контроль: не задан» should be shown when no control exists | Code Examples | Cosmetic |
| A3 | Live-run cost/time estimates: repeat of `fae4ee59` ≈ $1.9 and 6–17 min with `--parallel 8`; reassess ≈ $1.0–1.6 and 7–15 min (sequential per dialogue, 8 votes × 13 dialogues + failure naming); validate build ≈ $0.05–0.3 with cached grounding | Live verification | Budget overrun is bounded by `settings.maxCalls` (385 in `fae4ee59`) |
| A4 | Evidence location `~/agent-lab-evidence/phase-01/` (outside any repo, `0700`/`0600`) | Live verification | The user may prefer another folder; memory notes earlier evidence was kept under `aigw-local/local/evidence/` |
| A5 | OpenRouter balance is enough for ~$4–6 | Environment | A paid run stops at the first failed call; evidence is kept |
| A6 | `ae812a24` will pass again under the current agent | TRUST-04 | Fallback: a labelled synthetic control, or another passing dialogue |
| A7 | The current `aigw-local-baseline` code equals the `fae4ee59` fingerprint (`4b69f131a2`). Not checked: computing it runs `git` inside aigw-local | Stability gate | If it changed, the stability gate says "agent changed" and TRUST-09a needs two fresh repeats instead of repeat-vs-`fae4ee59` (+~$2) |

## Open Questions (RESOLVED)

1. **Per-pair vs global audit-completeness note in `compareRuns`.**
   - What we know: one judge rejection anywhere makes the whole diff incomparable today.
   - Recommendation: move it per pair (Pattern 3). It is small and makes the live TRUST-05 check robust.
   - RESOLVED: followed in 01-03 Task 1 (per-pair «Судья не завершил оценку этой попытки.»; mixed-protocol and judge-model notes stay global).
2. **Should a goal-vote split count as «нестабильно» too?**
   - Recommendation: no, not in this phase. It stays a not-measured reason (CONTEXT counts unstable cards inside the headline; split cards are outside it).
   - RESOLVED: followed in 01-01 (`judge_split` is a not-measured reason) and 01-05 (stability counts only pass↔fail goal flips).
3. **Validate-build parity in the CLI (`validateSettings`).**
   - Not required by TRUST-07's text, but it removes a hidden CLI/Pi budget difference. Recommendation: include it only if cheap.
   - RESOLVED: 01-08 applies the recommendation's condition and leaves `validateSettings` out (TRUST-07 covers score only); recorded in its flagged assumptions.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | everything | ✓ | v22.22.3 | — |
| npm + node_modules (tsc, tsx) | snapshot tests | ✓ | pi-coding-agent 0.85.1 | symlink `node_modules` into the snapshot |
| Python venv for target | live runs | ✓ | `/Users/kikov/Desktop/aigw-local/.venv/bin/python` → CPython 3.12.9 | — |
| aigw-local mock server :8090 | live runs | ✓ (HTTP 404 on `/`, so the server is up) | — | ask the user to start it |
| Pi auth: `openrouter/openai/gpt-5.6-sol`, `openrouter/z-ai/glm-5.3-flash` | judge, simulator, build | ✓ (listed by `dist/cli.js status`) | — | — |
| OpenRouter balance | paid checks | not checked | — | human check before the run |
| rsync | dist swap | ✓ `/usr/bin/rsync` | — | `cp -R` |

**Missing dependencies with no fallback:** none.

## Live Verification Plan (do NOT execute during planning; ≤ ~$10 total)

Preconditions (human checkpoint):
1. Phase code committed, and the snapshot suite green.
2. `rsync -a --delete "$SNAP/dist/" "$REPO/dist/"`, then restart Pi. Close `/agent-lab` so no lock is held.
3. Mock server up; OpenRouter balance ≥ $6.

Commands (run from `$REPO`, data dir `.agent-lab`; `RUN=fae4ee59-d6da-4cbf-83b5-574e34405877`, `CTRL=ae812a24-8f12-4190-b666-18c26c83a807`):

| Step | Command | Cost / time | Proves |
|------|---------|-------------|--------|
| 0 (free) | `node dist/cli.js summary --id $RUN` and `--json` | $0 | TRUST-01/02/03 on the stored run; TRUST-08 legacy read |
| 0b (free) | `node dist/cli.js diff --before $RUN --after $RUN --json` | $0 | After D1 the only note is «Выбран один и тот же прогон» (sanity) |
| 0c (free) | `node dist/cli.js reassess --id $RUN --code-only` | $0 | Old records reassess without migration (the receipt path is not involved) |
| 1 | `node dist/cli.js repeat --id $RUN --control $CTRL` → `NEW` | $0 | Control marker set; `draftHash` of `$RUN` unchanged |
| 2 | `node dist/cli.js run --id $NEW --yes --parallel 8` | ≈ $1.9, 6–17 min | TRUST-04 (control line), TRUST-08 (no `judgeAudit` in record, sidecar dir, trace < 5 MB) |
| 3 | `node dist/cli.js diff --before $RUN --after $NEW` and `summary --id $NEW` | $0 | TRUST-05 (no «несравнимы»; exit ≠ 2), TRUST-09a («Нестабильных: N» from goal flips) |
| 4 | `node dist/cli.js reassess --id $RUN --yes` → `RE` | ≈ $1.0–1.6, 7–15 min | TRUST-09b (`summary --id $RE` lists goal flips vs `$RUN`); legacy record reassessed with the new sidecar |
| 5 (optional) | CLI `build` with a scratch copy of `.agent-lab/imports/voice360-acquiring.validation-task.json` + `--dialogues-file .agent-lab/imports/voice360-acquiring-validation-candidates.jsonl` | ≈ $0.05–0.3 (grounding cached) | TRUST-06 reaches `review` (duplicate ids now impossible) |
| 6 (optional) | `node dist/cli.js export --id $NEW --format json --output <evidence>/new.snapshot.json` | $0 | Report size < 10 MB |

Expected total ≈ $3–4. There is room for one retry of step 2.

Evidence copy after each step (outside the workspace, never into git):
```bash
EVID=~/agent-lab-evidence/phase-01-$(date +%Y%m%d); mkdir -p -m 700 "$EVID"
cp -p .agent-lab/$NEW.json .agent-lab/$NEW.trace.jsonl "$EVID"/ && cp -Rp .agent-lab/$NEW.judge "$EVID"/
node dist/cli.js summary --id $NEW > "$EVID/$NEW.summary.txt"; node dist/cli.js diff --before $RUN --after $NEW > "$EVID/diff.txt"
chmod -R go-rwx "$EVID"
```
Only ids, counts and sizes may go into `.planning` (VERIFICATION.md). The summary text contains model-written card titles; keep it in `$EVID`.

Never run `git` in `/Users/kikov/Desktop/aigw-local*`. Agent Lab itself runs read-only `git rev-parse`/`git diff` there for the fingerprint (`target-version.ts:29-41`); that is existing behaviour.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Node test runner via `tsx --test` (tsx ^4.20.0), TypeScript 5.9.3 |
| Config file | none (`package.json` scripts) |
| Quick run command | `SNAP=$(mktemp -d); git ls-files -co --exclude-standard -z \| tar --null -T - -cf - \| tar -xf - -C "$SNAP"; ln -s "$PWD/node_modules" "$SNAP/node_modules"; (cd "$SNAP" && npx tsc && npx tsx --test test/result-view.test.ts test/comparison.test.ts test/quality.test.ts test/judge.test.ts test/store.test.ts)`. This copies tracked + untracked, non-ignored files, so uncommitted work is included; it never touches the worktree `dist/` |
| Full suite command | `SNAP=$(mktemp -d); git archive HEAD \| tar -x -C "$SNAP"; ln -s "$PWD/node_modules" "$SNAP/node_modules"; (cd "$SNAP" && npm test && npm run typecheck)`. Baseline at HEAD: **317 pass / 0 fail, ~19 s** [VERIFIED this session] |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TRUST-01 | CLI `summary` first lines == `resultViewLines(view)`; tool `renderResult` and board block show the same headline line for one fixture | unit + integration | `npx tsx --test test/result-view.test.ts test/extension.test.ts test/cards.test.ts test/store.test.ts` | result-view ❌ Wave 0; others ✅ (extend) |
| TRUST-02 | Each of the 18 reason codes from a minimal fixture; top reason by count, tie by order; no «прочее» anywhere (`qualityLines().coverage` too) | unit | `npx tsx --test test/result-view.test.ts test/quality.test.ts` | ❌ / ✅ |
| TRUST-03 | Wilson vectors (table above); caveat only when M < 20; M = 0 → «Проверенных ситуаций нет» | unit | `npx tsx --test test/result-view.test.ts` | ❌ |
| TRUST-04 | Control excluded from N/M and notMeasured; warning when control fails/unknown; `draftHash` of a record without the field unchanged; the field survives `repeat` and is filtered by `scenarioIds`; the field is not in `measurementHash` | unit | `npx tsx --test test/result-view.test.ts test/experiment.test.ts` | ❌ / ✅ |
| TRUST-05 | `compareRuns(legacyNoGoalObs, freshDraft-run)` has no «Содержимое карточек изменилось»; `hasCompleteJudgment` true with a prompt source via `observableSources` (D1); per-pair audit failure affects only that pair | unit | `npx tsx --test test/comparison.test.ts test/judge.test.ts` | ✅ extend |
| TRUST-06 | Injected `goals` returning the same id for every dialogue → `phase === 'review'`, one card per dialogue | integration (injected runtime) | `npx tsx --test test/experiment.test.ts` | ✅ extend (~`:670`) |
| TRUST-07 | `scoreSettings` values; the CLI score record (code-only, scratch dir) has the same settings as the Pi path; a judged score card counts as decided (D2) | unit + CLI spawn | `npx tsx --test test/extension.test.ts test/workflow.test.ts test/normalize.test.ts` | normalize ❌; others ✅ |
| TRUST-08 | New trial has `judgeReceipt`, no `judgeAudit`; sidecar file `0600` atomic; journal gets one audit per judgment; receipt path of `hasCompleteJudgment` true / false on tamper; legacy full-audit fixture still true; `reassess` of a legacy record works; `jsonReport` has no `traceJournal` body; HTML has no raw audit JSON | unit + integration | `npx tsx --test test/judge.test.ts test/store.test.ts test/evaluation.test.ts test/artifacts.test.ts test/experiment.test.ts` | ✅ extend |
| TRUST-09 | `stabilityBetweenRuns` flags goal pass↔fail only when comparable and the agent is unchanged; `stabilityAfterReassess` pairs by trial id and uses source `manifestHash`; unstable cards stay in N/M | unit | `npx tsx --test test/comparison.test.ts test/result-view.test.ts` | ✅ / ❌ |
| All | Stored-run regression: read-only script prints counts for `fae4ee59`, `a92fd6ae` (expected 0/9 + 4 not measured; 1/8 + 7) and audit completeness 13/13, 14/14 | manual-read-only (bank data is local only) | `node <phase-dir>/verify-stored-runs.mjs` (reads `.agent-lab`, prints ids/counts only) | ❌ Wave 0 |
| Live | Steps 1–4 of the Live Verification Plan | manual (paid, human checkpoint) | see plan | — |

### Sampling Rate
- **Per task commit:** quick command (the snapshot of the working tree, the 3–5 touched test files).
- **Per wave merge:** full suite from `git archive HEAD` + `npm run typecheck` in the snapshot.
- **Phase gate:** full suite green; the stored-run script matches the expected counts; live steps 1–4 done with evidence copied, before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `test/result-view.test.ts`: fixtures for a validate-like record (goal + reply_quality + prompt_compliance + user_fidelity metrics, reactive, repeats 1) with builders for each reason code
- [ ] `test/normalize.test.ts` (or fold into comparison/extension tests): `normalizeScenarioIdentity`, `scoreSettings`
- [ ] A judge fixture with a `kind: 'prompt'` source + requirements (D1 regression)
- [ ] `verify-stored-runs.mjs` in the phase dir (read-only; prints counts, never text)
- [ ] Framework install: none

## Security Domain

### Applicable ASVS Categories (Level 1)

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Pi owns provider auth |
| V3 Session Management | no | — |
| V4 Access Control | yes (local files) | Dirs `0700`, files `0600` for the sidecar, as in `store.save` and `appendJudgment` |
| V5 Input Validation | yes | zod `strictObject` for `judgeReceipt`, `positiveControlScenarioIds`; `identifier` regex; `idPattern` on run id **and** trial id before any `join` (sidecar path traversal) |
| V6 Cryptography | no (integrity hashes only) | Existing `fingerprint` (sha256) |
| V7 Error/Logging | yes | Journal keeps one audit per judgment; errors keep original text (`attempt.error`) |
| V8 Data Protection | yes | Bank dialogues stay in `.agent-lab`; the report stops embedding the full journal/audit; evidence copies `0600` outside repos; `.planning` gets ids/counts only |
| V12 Files | yes | Atomic tmp+rename; size limit on sidecar read (e.g. 20 MB) like `store.get` |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal via crafted trial id in the sidecar path | Tampering | `idPattern` check (`store.ts:7, 124`) before `join` |
| Terminal escape injection from model-written titles in new lines | Tampering | `safeText` at every render boundary (`cards.ts:10-13`, `cli.ts:22-24`) |
| Receipt forged to look "complete" | Spoofing / Repudiation | Receipt path re-derives `inputHash` from the record and re-aggregates votes against `assessments`; the `auditHash` links to the sidecar; the legacy full path remains for raw replay |
| Sensitive dialogue text leaking into exports | Information disclosure | Drop the journal/audit bodies from `jsonReport`/HTML; customer-safe exports are phase 5 |
| Stale `dist/` reading new records | Denial of service (UI) | Coordinated rebuild + restart before the first new record |

## Sources

### Primary (HIGH confidence)
- Source at HEAD `99aa533` (identical `src/`, `extensions/`, `test/` to `015fee9`): `src/outcomes.ts`, `src/judge.ts`, `src/quality.ts`, `src/comparison.ts`, `src/contracts.ts`, `src/experiment.ts`, `src/evaluation.ts`, `src/store.ts`, `src/artifacts.ts`, `src/report.ts`, `src/cli.ts`, `src/pi.ts`, `src/imports.ts`, `src/connection.ts`, `src/target-version.ts`, `extensions/agent-lab.ts`, `extensions/cards.ts`, `package.json`, the tests listed above.
- Read-only measurements with the current `dist/` over `.agent-lab` (15 records) and the aigw-local evidence dirs. Scratch reproductions (repeat + diff on a copy of `ef727981`; code-only score) in the session scratchpad only.
- Snapshot test run: 317/317 pass.

### Secondary (MEDIUM confidence)
- `.planning/research/ARCHITECTURE.md`, `PITFALLS.md` (Wilson guidance, positive control), `.planning/codebase/TESTING.md`.

### Tertiary (LOW confidence)
- Cost/time estimates for the live steps (extrapolated from `fae4ee59` usage: 172 calls, $1.88).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH (no new dependencies).
- Architecture: HIGH for integration points and defects (reproduced); MEDIUM for the new shapes (`ResultView`, receipt), which are design choices.
- Pitfalls: HIGH (each observed on stored data or in code).
- Live cost/time: LOW–MEDIUM.

**Research date:** 2026-09-16
**Valid until:** 2026-09-21 (demo), or until `src/judge.ts` / `src/contracts.ts` change.

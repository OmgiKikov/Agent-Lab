# Phase 3: Согласие человека с судьёй - Research

**Researched:** 2026-09-17
**Domain:** Human review of the LLM judge inside the Pi board (TypeScript, zod 4, pi-tui 0.85.1); record schema, counting rules, deterministic sampling
**Confidence:** HIGH for the current code (read this session); MEDIUM for phase 2's end state (known only from its plans, which have not run yet)

## Summary

Phase 3 adds almost no new machinery. It needs three things:
- a few optional fields on `humanReviewInputSchema`;
- one pure module (`src/agreement.ts`) that compares human marks with the judge's **recorded** assessment, not the overridden one;
- one new board action.

The codebase already works close to this model. `humanFindings` in `src/comparison.ts` already sets `automatic = trial.assessments?.find(a => a.metricId === review.metricId)?.result` for metric reviews, so it compares against the original judge result. `agentMetricResult` already lets a metric review override the headline. The phase adds the judge snapshot, the split into failures and passes, and the wording.

What decides the plan:
1. **The stored acquiring runs have almost no «справился».** Measured this session (goal votes per trial):
   - `fae4ee59`: 0 pass, 12 fail, 1 unknown;
   - `61521e0d` (phase-1 live): 0 pass, 13 fail;
   - `a92fd6ae`: 1 pass.

   So JUDGE-06 on the demo will usually read «успехов нет» or «успехи: 1 из 1». The wording must handle 0 and 1 passes.
2. **The keys `p`/`n` conflict in meaning with «согласен / не согласен».**
   - Today `n` is a whole-dialogue «не пройдено». That verdict does not move the number, and it does not count as agreement.
   - Recommendation: in the results scope use `y` = согласен, `n` = не согласен (remapped deliberately), `s` = не могу сказать. Retire the quick `p` there; a whole-dialogue verdict stays available through `v` → «Весь диалог».
3. **The lab fills the judge snapshot, never the caller.** `ExperimentLab.addHumanReview` sets `judgeVerdict` and `judge` (`protocolHash`, `inputHash`) from the trial. If the caller also sends `judgeVerdict` (the verdict the board showed), a mismatch is rejected. The model cannot forge a snapshot.
4. **A decided quick mark must clear the review queue.** Otherwise the owner presses `y` on every failure and still sees «осталось N провалов», and `f` refuses: the acquiring cards also fail `prompt_compliance`, and demo cards fail checks. So `awaitingVerdict` should treat a decided quick mark on the primary metric as resolving the trial.

**Primary recommendation:**
- Add `source?: 'quick'`, `judgeVerdict?` and `judge?: { protocolHash, inputHash }` to `humanReviewInputSchema`.
- Add `primaryMetricId` to `outcomes.ts`.
- Add `judgeAgreement(record)` and `agreementSample(record)` in a new `src/agreement.ts`.
- Add an `agreement` field to `ResultView` and one agreement row in `resultViewRows`, so every surface gets it by construction.
- Add a separate disagreement section (CLI, board, Pi payload).
- Add a board action `{ type: 'agree' }` on `y`/`n`/`s` in the results scope. The evidence block (phase-2 F1 rows) comes before the line «Судья: …».

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Одна клавиша согласия (JUDGE-04)
- Три ответа: «согласен», «не согласен», «не могу сказать». Каждый — одно нажатие на провале или на проверяемом успехе, в разделе результатов доски.
- Клавиши выбирает планировщик вместе с дизайн-контрактом.
  - Ориентир: `y` — «согласен» (фаза 2 зарезервировала `y` в разделе результатов под значение «да»).
  - Для «не согласен» и «не могу сказать» нужны свободные клавиши без конфликта с занятыми: `n`, `p`, `v`, `u`, `a`, `f`, `x`, `o`, `c`, `r`, `/`, `?`, цифры, `e`.
  - Если старые `p`/`n` (вердикт по диалогу целиком) мешают, их можно переназначить. Условия: поведение осознанно меняется, тесты обновлены, в справке это видно.
- При «не согласен» открывается короткое поле причины (редактор Pi). Без причины несогласие не сохраняется. «Согласен» и «не могу сказать» причины не требуют.
- Отметка пишется **в главную метрику ситуации** (`goal_attainment`, иначе первая проваленная метрика агента) с `source: 'quick'`. Только так несогласие меняет главное число: вердикт по диалогу целиком число не двигает.
  - «Согласен» = вердикт судьи.
  - «Не согласен» = противоположный вердикт.
  - «Не могу сказать» = `unknown`.
- Вместе с отметкой хранятся:
  - исходный вердикт судьи по этой метрике;
  - версия судьи (хеш протокола и хеш входа из квитанции или аудита);
  - время до решения (`durationMs`).

  Отметка переживает переоткрытие доски и сессии. Хешей вердикта в прогоне (`measurementHash`) она не меняет.
- **Доказательство показывается раньше вердикта судьи**: сначала реплика агента и правило (объяснение фазы 2), потом строка «Судья: не справился». Это защита от слепого согласия.

#### Доля согласия (JUDGE-05)
- Строка в `ResultView` и на доске: «Согласие с судьёй: N из M проверенных (провалы: a из b · успехи: c из d)». Процент показывается, только если M ≥ 10. При M < 20 рядом стоит «мало проверок».
- Согласие считается по **исходной оценке судьи** (`trial.assessments[].result`, для новых записей — голоса из квитанции), а не по `agentMetricResult`, который уже подставил вердикт человека: иначе всегда вышло бы 100%.
- Знаменатель — ситуации, проверенные человеком после последней смены версии судьи, с ответом «согласен» или «не согласен». Отметки «не могу сказать» считаются отдельно: «не смог решить: K».
- Отметки, сделанные при другой версии судьи, в долю не входят. Они показаны строкой «устарели после смены судьи: K».
- Список несогласий: название ситуации, вердикт судьи → вердикт человека, причина человека. Список виден на доске и в CLI `summary`.
- Цель ≥90% на экране владельца подаётся как цель, а не как доказанная точность: «цель — 9 из 10».

#### Проверка успехов (JUDGE-06)
- В очередь проверки подмешиваются 2–3 случайные ситуации «справился». Выбор детерминированный: от id прогона, чтобы при переоткрытии он был тем же.
- Если успехов 3 или меньше, проверяются все.
- На доске они отмечены «проверьте и успех»: владелец видит, что судья мог ошибочно похвалить.
- Согласие показывается отдельно по провалам и по успехам (см. строку выше).
- Пока ни один успех не проверен, строка говорит «успехи ещё не проверены».

#### Проверка фазы без человека
- Пользователь спит, поэтому настоящие отметки владельца в этой фазе не собираются.
- Проверка: клавиши подаются скриптом на доске и в тестах, отметки пишутся в **копию** сохранённого прогона во временной папке. Реальные записи в `.agent-lab` не меняются.
- Настоящие отметки для демо владелец ставит после заморозки протокола. Это записывается как пункт для человека.
- Платных вызовов в фазе нет.

### Claude's Discretion
- Точные клавиши и тексты (в дизайн-контракте фазы 3 поверх контракта фазы 2).
- Поле для версии судьи в отметке (расширение `humanReviewInputSchema` необязательными полями, без поломки старых записей).
- Функция `judgeAgreement(record)` в `src/outcomes.ts` или рядом, без импорта `experiment.ts`.
- Алгоритм детерминированной выборки успехов.

### Deferred Ideas (OUT OF SCOPE)
- Каппа, TPR/TNR — когда проверок станет ≥ 20 (v2 JUDGE-07).
- Отдельная сессия разметки или очередь — вне продукта (Out of Scope).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| JUDGE-04 | Владелец на провале одной клавишей отмечает «согласен», «не согласен» или «не могу сказать». При несогласии он пишет короткую причину. Отметка хранит вердикт судьи и версию судьи, с которыми человек соглашался. | Schema extension (Pattern 1), `primaryMetricId` (Pattern 2), lab-filled snapshot (Pattern 3), board action and keys (Pattern 6), editor for the reason (Pattern 7) |
| JUDGE-05 | Владелец и менеджер видят согласие человека с судьёй как «N из M проверенных» со списком несогласий. Согласие считается по исходным оценкам судьи; если проверок мало, это указано. | `judgeAgreement` (Pattern 4), wording thresholds, surfaces (Pattern 8) |
| JUDGE-06 | В проверку подмешиваются 2–3 случайные ситуации «справился». Согласие показывается отдельно по провалам и по успехам. | `agreementSample` (Pattern 5), measured pass counts, the split in `judgeAgreement` |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- Pi only; the HTML report is a file for forwarding. The agreement line goes into HTML in phase 5, not here.
- TypeScript ESM, Node ≥22.19, `strict`, `noUncheckedIndexedAccess`. zod 4, typebox, pi-tui 0.85.1. **No new runtime dependencies.**
- Every import uses the `.js` extension. Errors use `throw new Error(msg)` with a Russian message for the user.
- User-facing strings are in Russian; code and identifiers are in English.
- Old JSON records must open and re-evaluate without migration. New schema fields must be optional.
- Truth lives in records and events. The model never writes a human mark.
- Bank dialogues stay local (`.agent-lab`, mode 0600) and never enter the repo or `.planning`. Check scripts print ids and counts only.
- **Workspace:** never run `npm test` or `npm run build` in the worktree. Tests run through `.planning/phases/01-odno-chestnoe-chislo/snap-test.sh`. `dist/` is swapped only by rename, after checking that no Pi process runs.
- Do not touch git in `aigw-local`. No paid calls in this phase.
- Work goes through GSD commands.
- There is no linter or formatter; style is 2-space indentation, `camelCaseSchema`, and named exports.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Mark schema and snapshot | Data contract (`src/contracts.ts`) | Writer (`src/experiment.ts` `addHumanReview`) | The schema checks the shape; the writer fills the judge snapshot from the trial so the caller cannot forge it |
| Primary metric choice | Pure logic (`src/outcomes.ts`) | — | Both `comparison.ts` (queue) and `agreement.ts` need it; `outcomes.ts` is the shared leaf |
| Agreement count and sample | Pure logic (`src/agreement.ts`, new) | `src/result-view.ts` | Must not import `experiment.ts`; `result-view.ts` owns the words |
| Headline effect of a disagree | Existing counting (`agentMetricResult` → `goalCardOutcome` → `cardVerdict`) | — | Already works; no counting change is needed |
| Review queue and finalize gate | `src/comparison.ts` `awaitingVerdict` | `extensions/cards.ts` `reviewOrder` | A decided quick mark resolves the trial |
| Keys, evidence-first detail, notices | Pi board (`extensions/cards.ts`) | Pi loop (`extensions/agent-lab.ts`) | Human intent comes only from key presses and native dialogs |
| Line and list text | `src/result-view.ts` | CLI `summary`, Pi payload, board | One source of text (phase-2 UI-SPEC rule) |

## Current Code Facts (read this session)

**Human review schema** [VERIFIED: src/contracts.ts:643-651]:
```ts
export const humanReviewInputSchema = z.strictObject({
  trialId: identifier, metricId: identifier.optional(), checkId: identifier.optional(),
  verdict: z.enum(['pass', 'fail', 'unknown', 'invalid']), note: text.max(3000), reviewedDialogue: z.literal(true).optional(),
  durationMs: z.number().int().nonnegative().max(3600000).optional(),
}).refine(v => !(v.metricId && v.checkId), 'Review either one metric, one check, or the whole trial')
  .refine(v => !v.reviewedDialogue || (!v.metricId && !v.checkId), 'Only a whole-dialogue verdict can mark a complete review');
export type HumanReviewInput = z.infer<typeof humanReviewInputSchema>;
export type HumanReview = HumanReviewInput & { id: string; createdAt: string };
const humanReviewSchema = humanReviewInputSchema.safeExtend({ id: identifier, createdAt: text });
```

**`text` requires a non-empty note** [VERIFIED: src/contracts.ts:9]: `const text = z.string().trim().min(1);`. So «согласен» and «не могу сказать» need a fixed placeholder note, as today's quick verdict has (`'Быстрый вердикт из терминала, без записанного основания.'`, extensions/agent-lab.ts:812).

**Judge receipt fields** [VERIFIED: src/contracts.ts:256-264]: `protocolHash: text, inputHash: text, provider: text, model: text, configurationHash: text.optional(), … auditHash: text, votes: z.array(z.strictObject({ metricId: identifier, result: z.enum(['pass', 'fail', 'unknown']).optional(), error: z.boolean().optional() })).max(48), notApplicable: z.array(identifier), complete: z.boolean()`. The audit has the same `protocolHash: text, inputHash: text` (src/contracts.ts:238-239). Phase 2 (plan 02-01) adds `cutBefore` to the receipt and `judgedBeforeSeq` to `Trial` [CITED: 02-01-PLAN.md].

**Assessment result values** [VERIFIED: src/contracts.ts:519-520]: `metricId: identifier, result: z.enum(['pass', 'fail', 'unknown'])`.

**Supersession** [VERIFIED: src/outcomes.ts:24-31]: the key is `` `${review.trialId}|${review.metricId ? `metric:${review.metricId}` : review.checkId ? `check:${review.checkId}` : 'dialogue'}` ``, and the last one in array order wins. A later `v` review on the same metric supersedes a quick mark, and the reverse holds too.

**Override** [VERIFIED: src/outcomes.ts:35-38]:
```ts
const human = latestHumanReviews(...).get(`${trial.id}|metric:${metricId}`)?.verdict;
return human === 'invalid' ? undefined : human ?? trial.assessments?.find(a => a.metricId === metricId)?.result;
```
So a quick mark on the goal flips `goalCardOutcome` (src/comparison.ts:504-517, `agentMetricResult(trial, metric.id, record.humanReviews)`). A quick `unknown` turns the card into not measured, with reason `human_unknown` («человек не смог решить», src/comparison.ts:561 and src/result-view.ts:47).

**Hashes** [VERIFIED: src/experiment.ts:42-49]: `resultHash` = `fingerprint({ draft, trials, humanReviews })`, so a mark changes it. `measurementHash` does not include `humanReviews`, so a mark leaves it unchanged. `draftHash` does not include reviews either.

**Writer** [VERIFIED: src/experiment.ts:856-876]:
- `addHumanReview` requires `workflow === 'evaluate'` and phase `results_review` or `complete`.
- It checks that the metric exists (`assessmentRubrics(scenario, trial)`) and pushes the review.
- It then runs `delete record.resultsReviewedAt; delete record.resultsReviewHash;` and `checkpoint(record, 'results_review', …)`.

Consequence: **a mark on a `complete` run reopens its review.**

**Reassess** [VERIFIED: src/experiment.ts:76, 791, 805]:
- `freshDraft` resets `humanReviews: []`.
- Reassess keeps trial ids (`structuredClone(original)`) and stores the source reviews in `record.sourceEvidence = suiteEvidence(previous, …)`.

So marks never travel into a reassessed run, except as a snapshot inside `sourceEvidence.humanReviews`.

**Board today** [VERIFIED: extensions/cards.ts]:
- `BoardAction` has a `verdict` variant with `verdict: 'pass' | 'fail'` (lines 45-46).
- `p`/`n` → `verdict` when `reviewable` (line 377).
- `v` → `annotate` (line 381).
- `u` toggles the pending-only filter in results (line 368).
- `finish()` attaches `reviewMs` only for `verdict`/`annotate` (line 327).
- The results header shows «Разбор: осталось N провал(ов) из M» (line 428).
- The help row reads `'p / n — вердикт на выбранный диалог · v — оценить критерий'` (line 497).
- The footer reads `'a Обсудить · p Пройдено · n Провал · v Оценка · f Завершить'` (line 503).
- `n` and `d` without a record mean new check and demo (lines 363-364).

Free letters in `handleInput`: `b g h i l m s t w z y` (`j`/`k` navigate, `q` closes). Phase 2 takes `y`/`e` only in section 2 of a draft [CITED: 02-UI-SPEC.md Key Map Registry: «phase 3 may bind `y` to «согласен» only in the results scope… Phase 3 must not use `e`»].

**Loop today** [VERIFIED: extensions/agent-lab.ts:807-821]: the `verdict` branch writes a whole-dialogue review with the fixed note and `durationMs: action.reviewMs`. The `annotate` branch calls `humanAnnotation`, which uses `ctx.ui.select` and `ctx.ui.editor`. Pi typings [VERIFIED: node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:135]: `editor(title: string, prefill?: string): Promise<string | undefined>;`.

**Existing extension test that phase 3 breaks on purpose** [VERIFIED: test/extension.test.ts:421-424]: `steps = [['3', 'n'], ['f'], ['q']];` followed by `assert.equal(reviewed.humanReviews.length, 1)` and `phase === 'complete'`. With the `n` remap, this flow must also stub the reason editor, and it needs Pattern 4b so `f` passes.

**Demo metrics** [VERIFIED: src/demo.ts:114, 143]: demo cards carry the agent metric `demo_task_state`, not `goal_attainment`. So the primary metric on the demo is `demo_task_state`. The demo writes no audit or receipt, so the snapshot has no `judge` there.

**`reviewOrder`** [VERIFIED: extensions/cards.ts:31-36]: rank is pending (0), then flagged (1), then failure or invalid (2), then the rest (3).

**`humanFindings`** [VERIFIED: src/comparison.ts:174-190]: it emits a finding for every latest review with verdict `fail` or `invalid`, or with a disagreement. So every «согласен» on a failure (verdict `fail`) would produce a «ЗАМЕЧАНИЕ ЧЕЛОВЕКА» item and raise `flagged`. That is a pitfall (see Pitfall 3).

### Stored-run measurements (read-only, existing dist, ids and counts only)

| Run | Phase | Trials | Goal judge pass/fail/unknown/none | Receipts / audits | Controls | Headline | Human reviews |
|-----|-------|--------|-----------------------------------|-------------------|----------|----------|---------------|
| fae4ee59 | results_review | 13 | 0/12/1/0 | 0/13 | 0 | 0/9, 4 not measured | 0 |
| a92fd6ae | results_review | 15 | 1/12/1/1 | 0/14 | 0 | 1/8, 7 not measured | 0 |
| 61521e0d (phase-1 live) | results_review | 13 | 0/13/0/0 | 13/0 | 1 | 0/10, 2 not measured | 0 |
| 9d587362 (reassess of fae4ee59) | results_review | 13 | 0/12/1/0 | 13/0 | 0 | 0/8, 5 not measured | 0 (sourceEvidence 0) |

All evaluate runs use `repeats=1`, so one trial equals one situation. None has any human review, so there is nothing to migrate. [VERIFIED: measurement script over `.agent-lab` with `dist/store.js` and `dist/result-view.js`, this session]

## Standard Stack

No new packages. Everything already exists in the repo.

| Library | Version | Purpose |
|---------|---------|---------|
| zod | 4.5.4 (repo) | optional schema fields; `.refine` for the rule «quick needs a metricId» |
| @earendil-works/pi-tui | 0.85.1 [VERIFIED: package.json read] | `matchesKey`, `wrapTextWithAnsi`, `visibleWidth` |
| @earendil-works/pi-coding-agent | 0.85.1 [VERIFIED] | `ctx.ui.editor` for the reason |
| node:crypto via `fingerprint` | built-in | deterministic sample order |

## Package Legitimacy Audit

No external packages are installed in this phase.

**Packages removed due to [SLOP] verdict:** none. **Packages flagged [SUS]:** none.

## Architecture Patterns

### System Architecture Diagram

```
 board results section (↑↓ select trial)
        │ render: agreement block = F1 evidence rows ─► «Судья: <verdict>» ─► key hint ─► «Ваша отметка …»
        │ key y / n / s  (only when reviewable, not searching, help closed, primary metric has pass|fail judge verdict)
        ▼
 BoardAction {type:'agree', answer, trialId, metricId, judgeVerdict, reviewMs}
        ▼
 /agent-lab loop ── answer=disagree? ─► ctx.ui.editor(reason) ── empty/cancel ─► no write, reopen
        ▼
 ExperimentLab.addHumanReview({trialId, metricId, source:'quick', verdict, note, judgeVerdict, durationMs})
        │ checks: metricId === primaryMetricId; judgeVerdict === trial.assessments[metric].result
        │ fills judge = {protocolHash,inputHash} from judgeReceipt ?? judgeAudit
        ▼
 record.humanReviews (JSON, 0600)  ── resultHash changes, measurementHash does not
        ▼
 buildResultView ─► cardVerdict/goalCardOutcome (a disagree flips the headline via agentMetricResult)
                 └► judgeAgreement(record) ─► view.agreement ─► resultViewRows (agreement row)
                                                          └► disagreementRows(view)
        ▼
 CLI summary · Pi payload viewLines + disagreementLines · board overview · board results header
```

### Recommended Structure
```
src/contracts.ts     # + optional source/judgeVerdict/judge on humanReviewInputSchema
src/outcomes.ts      # + primaryMetricId(scenario, trial)
src/agreement.ts     # NEW: agreementSample, judgeAgreement, AGREEMENT constants (imports contracts.js, outcomes.js only)
src/comparison.ts    # awaitingVerdict: decided quick mark on primary metric resolves; humanFindings skips quick agreements
src/experiment.ts    # addHumanReview: validate quick marks, fill snapshot
src/result-view.ts   # ResultView.agreement; agreement row in resultViewRows; disagreementRows
src/explain.ts       # (phase 2) + situationEvidence rows usable for passed trials (neutral title)
src/cli.ts           # summary prints the disagreement section
extensions/cards.ts  # agree action, keys, agreement block, reviewOrder, header/footer/help
extensions/agent-lab.ts # agree branch (editor for disagree), payload disagreementLines
test/agreement.test.ts (new) + updates in contracts/experiment/comparison/result-view/cards/extension tests
.planning/phases/03-soglasie-cheloveka-s-sudey/agreement-check.mts (new, scripted board on a temp copy)
```

### Pattern 1: Schema extension (backward compatible)
```ts
// src/contracts.ts — the fields are added inside the existing strictObject, before the .refine calls
const judgeSnapshotSchema = z.strictObject({ protocolHash: text, inputHash: text });
export const humanReviewInputSchema = z.strictObject({
  trialId: identifier, metricId: identifier.optional(), checkId: identifier.optional(),
  verdict: z.enum(['pass', 'fail', 'unknown', 'invalid']), note: text.max(3000), reviewedDialogue: z.literal(true).optional(),
  durationMs: z.number().int().nonnegative().max(3600000).optional(),
  /** A one-key agreement mark on the situation's primary metric. */
  source: z.literal('quick').optional(),
  /** The recorded judge result the person saw; filled and checked by the lab. */
  judgeVerdict: z.enum(['pass', 'fail', 'unknown']).optional(),
  /** The judgment the person agreed or disagreed with; absent when the trial has no receipt or audit (demo). */
  judge: judgeSnapshotSchema.optional(),
}).refine(/* existing two refinements */)
  .refine(v => v.source !== 'quick' || (!!v.metricId && v.verdict !== 'invalid'), 'Быстрая отметка ставится на одну метрику судьи.');
```
- Old records have none of the new fields, so they parse. `humanReviewSchema = …safeExtend(...)` keeps the refinements. [VERIFIED: current code already uses `safeExtend` on the refined schema]
- `sourceEvidence.humanReviews` uses the same schema, so it gets the new fields too.
- **Reverse compatibility breaks:** a record with the new fields fails the strict schema in an older `dist/`. See Pitfall 6.

### Pattern 2: Primary metric
```ts
// src/outcomes.ts
/** The metric a one-key mark lands on: goal attainment; else the first agent metric the judge failed; else the first one it passed. Stable: reads only recorded assessments. */
export function primaryMetricId(scenario: Scenario | undefined, trial: Trial): string | undefined {
  const agent = (scenario?.metrics ?? []).filter(m => m.subject === 'agent');
  if (agent.some(m => m.id === 'goal_attainment')) return 'goal_attainment';
  const result = (id: string) => trial.assessments?.find(a => a.metricId === id)?.result;
  return agent.find(m => result(m.id) === 'fail')?.id ?? agent.find(m => result(m.id) === 'pass')?.id;
}
```
Use `scenario.metrics` only. The RAG rubrics added by `assessmentRubrics` are diagnostic. The `goal_attainment` literal matches src/contracts.ts:185 (`id: 'goal_attainment'`) [VERIFIED].

Answer → verdict mapping (locked):

| Answer | Stored `verdict` |
|--------|------------------|
| agree | `judgeVerdict` |
| disagree | the opposite of `judgeVerdict` (`pass` ↔ `fail`) |
| unsure | `'unknown'` |

The keys are allowed only when `judgeVerdict` is `pass` or `fail`. With no verdict to agree with, show the notice «Судья не вынес решения по этой ситуации — соглашаться не с чем.»

### Pattern 3: The lab fills and checks the snapshot
```ts
// src/experiment.ts addHumanReview, after the existing metric check
if (input.source === 'quick') {
  const primary = primaryMetricId(scenario, trial);
  if (!primary || input.metricId !== primary) throw new Error('Быструю отметку можно поставить только на главную оценку ситуации.');
  const recorded = trial.assessments?.find(a => a.metricId === primary)?.result;
  if (recorded !== 'pass' && recorded !== 'fail') throw new Error('Судья не вынес решения по этой ситуации — соглашаться не с чем.');
  if (input.judgeVerdict !== undefined && input.judgeVerdict !== recorded) throw new Error('Оценка судьи изменилась. Откройте доску заново.');
  const judged = trial.judgeReceipt ?? trial.judgeAudit;
  input.judgeVerdict = recorded;
  if (judged) input.judge = { protocolHash: judged.protocolHash, inputHash: judged.inputHash }; else delete input.judge;
}
```
Also fill `judgeVerdict` and `judge` for **every** metric review (`v` path, `agent_lab_review` tool) the same way, without `source`, so later analysis can use them. The count itself uses only `source === 'quick'` (Pattern 4).

### Pattern 4: `judgeAgreement(record)`
```ts
// src/agreement.ts — pure; imports ./contracts.js and ./outcomes.js only
export type AgreementGroup = { agreed: number; checked: number };
export interface JudgeAgreement {
  agreed: number; checked: number;            // agree+disagree marks on the current judgment
  failures: AgreementGroup; passes: AgreementGroup;
  unsure: number; stale: number;
  sampledPasses: string[];                    // trial ids from agreementSample
  disagreements: { trialId: string; scenarioId: string; title: string; judge: 'pass' | 'fail'; human: 'pass' | 'fail'; note: string }[];
}
```
Rules:
1. **Records.** Take `observedRecord(record)`; for an evaluate run that is the record itself. Skip the trials of positive-control scenarios, since they never enter the number.
2. **Current marks.** Use `latestHumanReviews(record)` and keep the reviews with `source === 'quick'` whose `metricId === primaryMetricId(scenario, trial)`. If a later non-quick review on the same key supersedes a quick mark, that pair no longer counts.
3. **Base verdict.** Take the recorded `trial.assessments.find(metric).result`, **never** `agentMetricResult`. For receipt-backed trials this value is already the re-aggregation of the receipt votes that the verifier checks (`recordedAggregate` in src/judge.ts:117-121). There is no need to re-read the votes.
4. **Current vs stale.** A mark is current when all of these hold:
   - `review.judgeVerdict === recorded`;
   - `(review.judge?.protocolHash ?? null) === (current?.protocolHash ?? null)`;
   - the same equality holds for `inputHash`, where `current = trial.judgeReceipt ?? trial.judgeAudit`.

   Otherwise the mark goes to `stale`. Inside one record this happens only after a hand edit, because trials are immutable.
5. **Source-run marks.** Quick marks in `record.sourceEvidence?.humanReviews` whose `trialId` is in `record.trials`, and whose key has no own-record mark, count as `stale`. A reassessment is by definition a new judgment, so the old verdict the person agreed with was replaced. This covers the phase-2 v10→v11 change: marks on a v10 run appear in its v11 reassessment only as «устарели после смены судьи». Marks made on a v10 record after the reassessment stay on that record only.
6. **Current marks by answer.**
   - `unknown` goes to `unsure`.
   - `pass`/`fail` goes to `checked`; it also counts as `agreed` when `verdict === recorded`.
   - The group is `failures` when `recorded === 'fail'`, otherwise `passes`.
   - A disagreement adds a row to `disagreements`, in record scenario order.
7. **Unit.** One trial = one situation. Runs have `repeats=1` (measured above). When `settings.repeats * modes > 1`, the word becomes «диалог». Record this as a known limitation.

**Wording** (constants in `result-view.ts`; `SMALL_SAMPLE = 20` is reused from src/result-view.ts:15 [VERIFIED]; add `PERCENT_FROM = 10`):
- `checked === 0` and nothing else: `Согласие с судьёй: ещё не проверено.`
- Otherwise: `Согласие с судьёй: <agreed> из <checked> проверенных` + (`checked >= 10` ? ` — <round%>%` : '') + (`checked < 20` ? ` · мало проверок` : '') + ` (провалы: <a> из <b> · <passesPart>).`
  - `passesPart` is `успехи: <c> из <d>` when `d > 0`.
  - When `d = 0` and the sample is non-empty, it is `успехи ещё не проверены`.
  - When the sample is empty, it is `успехов нет`.
- Tail rows, only when non-zero: `Не смог решить: K.`, `Устарели после смены судьи: K.`.
- Goal row, only when `checked > 0`: `Цель — 9 из 10.`
- Optional Wilson range in `details` only: `wilson(agreed, checked)` from `result-view.ts`, with the same «Мало данных: …» wording as phase 1.
- The UI-SPEC for phase 3 fixes the exact strings.

### Pattern 4b: The queue and the finalize gate
In `awaitingVerdict` (src/comparison.ts:209-230), directly after the `invalid` early return, add:
```ts
const primary = primaryMetricId(scenario, trial);
const quick = primary ? latest.get(`${trial.id}|metric:${primary}`) : undefined;
if (quick?.source === 'quick' && (quick.verdict === 'pass' || quick.verdict === 'fail')) return false;
```
Put it **after** the simulator-pending block: a simulator deviation still needs its own decision. «Не могу сказать» leaves the trial pending, which matches the existing message «неясно оставляет вопрос открытым».

In `humanFindings`, skip quick reviews whose verdict equals the recorded result. They are agreements, not remarks. Disagreements stay in as findings with `disagreement: true`.

### Pattern 5: Deterministic pass sample
```ts
// src/agreement.ts
export const PASS_SAMPLE = 3;
/** Passed situations to double-check: every one when there are at most 3, else 3 chosen by a hash of run id and trial id. Stable across reopen; a new run gets a new draw. */
export function agreementSample(record: Experiment): string[] {
  if (runningPhases.has(record.phase)) return [];
  const controls = new Set(record.positiveControlScenarioIds ?? []);
  const passed = record.trials.filter(t => {
    const scenario = record.scenarios.find(s => s.id === t.scenarioId);
    const metric = primaryMetricId(scenario, t);
    return scenario && !controls.has(scenario.id) && metric && t.assessments?.find(a => a.metricId === metric)?.result === 'pass';
  });
  if (passed.length <= PASS_SAMPLE) return passed.map(t => t.id);
  return passed.map(t => ({ id: t.id, key: fingerprint({ run: record.id, trial: t.id }) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).slice(0, PASS_SAMPLE).map(x => x.id);
}
```
Properties:
- The sample depends only on the run id, the trial ids and the **recorded** judge results. It does not change when a person flips a verdict, and it does not change on reopen.
- A repeat or a reassessment has a new id, so it gets a new draw. That is intended.
- «2–3»: the fixed value 3 satisfies the lock («если успехов 3 или меньше, проверяются все»). On the measured acquiring runs the sample has 0 or 1 trials.
- `fingerprint` is sha256 over sorted JSON [VERIFIED: src/contracts.ts:960-964].

**Queue failures** = non-control trials whose primary-metric recorded result is `fail`, including those on cards that are not measured (their reason is shown). The board list labels a sampled pass `ПРОВЕРЬТЕ И УСПЕХ` and a failure without a mark `ПРОВЕРЬТЕ ПРОВАЛ`.

`reviewOrder` rank:
- 0: in the queue (failure or sampled pass) and without a current quick mark; failures before passes;
- 1: pending;
- 2: flagged;
- 3: failure or invalid;
- 4: the rest.

After any mark, including «не могу сказать», the trial leaves rank 0. The same list position then lands on the next case, which keeps today's «no navigation» behavior (cards.ts:27-30).

### Pattern 6: Keys (recommendation for the phase-3 UI-SPEC)

| Key | Scope | Action |
|-----|-------|--------|
| `y` | section 3, reviewable, not searching, help closed | согласен |
| `n` | same | **remapped** from «не пройдено» to не согласен → reason editor |
| `s` | same | не могу сказать («сложно сказать») |
| `p` | section 3 | **retired** (does nothing). Whole-dialogue verdict: `v` → «Весь диалог» |
| `v` | unchanged | — |

- `n` on the run list (new check) is unaffected: that branch runs only when `!this.record`.
- `y`/`e` in section 2 (phase 2) are unaffected, because the section scope differs.
- Why `n` rather than a fresh letter: `y`/`n` is the universal yes/no pair, and phase 2 reserved `y` as «да». Keeping `n` as «не пройдено» next to `y` = «согласен» would make `n` on a failure mean *agreement*, which is a trap.
- Cost of the remap: the p/n tests in test/cards.test.ts (lines 15-28, 239-268, 315-327) and the extension journey (test/extension.test.ts:421) change deliberately.
- Help row: `y / n / s — согласен / не согласен / не могу сказать с судьёй · v — оценить критерий или весь диалог`.
- Footer (results_review, section 3): `y Согласен · n Не согласен · s Не могу сказать · v Оценка · f Завершить`.
- Optional: Cyrillic-layout aliases (`н`, `т`, `ы` are on the same physical keys). No board key has aliases today, so this is left to the UI-SPEC.

`BoardAction` gets a new variant:
```ts
| { type: 'agree'; answer: 'agree' | 'disagree' | 'unsure'; trialId: string; metricId: string; judgeVerdict: 'pass' | 'fail'; record: Experiment; section: Section; selected: number; query?: string; pendingOnly?: boolean; reviewMs?: number }
```
`finish()` must include `'agree'` in the `reviewMs` condition (cards.ts:327).

### Pattern 7: Evidence before the verdict (board detail pane)
For a selected trial that has a primary metric with a pass/fail recorded result, the detail pane starts with:
```
<title>                                            (text, bold — no ✗/✓ glyph: the glyph would reveal the verdict)
Проверьте провал  |  Проверьте и успех: судья мог ошибочно похвалить.   (muted)
  Должен был: …                                    (phase-2 F1 rows via wrapRows)
  Сказал (реплика #11): «…»
  Правило 7 · …: «…»
  и ещё 1 правило
  Оценено до реплики #11: дальше симулятор отклонился от диалога.
Судья: не справился  |  Судья: справился          (error | success)
y — согласен · n — не согласен · s — не могу сказать           (accent)
Ваша отметка: согласен | не согласен — «причина» | не могу сказать · устарела   (when present)
(blank)
<today's trialLines rows>
```
- `failureExplanation` (phase 2) returns null for a passed trial.
- Phase 3 needs the same rows for a pass. Add `situationEvidence(record, scenario, trial, metricId)` in `explain.ts`, sharing the X/Y/rule builders. For a pass, Y is the first cited agent reply of that metric, else the last reply with «судья не указал реплику». Its title row has no glyph.
- Today's `trialLines` keeps its own verdict rows below. The verdict is repeated there, which is acceptable because the evidence is shown first.
- **Limit:** the list entry text and the sidebar already reveal «НЕ ПРОЙДЕНО». Full blinding is not possible on this board; the lock asks only for the order inside the detail pane.

The loop branch in `extensions/agent-lab.ts`:
```ts
} else if (action.type === 'agree') {
  let note = action.answer === 'agree' ? 'Быстрая отметка: согласен с судьёй.' : 'Быстрая отметка: не могу сказать.';
  const started = performance.now();
  if (action.answer === 'disagree') {
    const reason = await ctx.ui.editor('Почему судья ошибся? Коротко, своими словами.', '');
    if (reason === undefined) continue;                                  // cancelled: nothing saved, no notice
    if (!reason.trim()) { inform('Несогласие не сохранено: напишите причину.', 'error'); continue; }
    if (reason.trim().length > 3000) { inform('Причина длиннее 3000 знаков. Сократите и попробуйте снова.', 'error'); continue; }
    note = reason;
  }
  const opposite = action.judgeVerdict === 'pass' ? 'fail' : 'pass';
  await lab.addHumanReview(action.record.id, { trialId: action.trialId, metricId: action.metricId, source: 'quick',
    verdict: action.answer === 'agree' ? action.judgeVerdict : action.answer === 'disagree' ? opposite : 'unknown',
    judgeVerdict: action.judgeVerdict, note,
    durationMs: Math.min(3600000, Math.round((action.reviewMs ?? 0) + performance.now() - started)) });
  reviewTimes.delete(`${action.record.id}|${action.trialId}`); reportPath = undefined;
  inform(/* e.g. 'Отмечено: согласен. Проверено провалов: 4 из 9.' */);
}
```
- `inform` default kind is `success` after phase 2 (02-08 Pattern-map decision 6 [CITED: 02-08-PLAN.md]).
- The length check uses `.length` on input validation only, not on displayed text. That is allowed; the UI-SPEC ban applies to display.
- On a `complete` run, a mark moves the phase back to `results_review`. Add `· разбор снова открыт: f — завершить` to the notice.

### Pattern 8: Surfaces
- **ResultView.** `agreement: JudgeAgreement` is computed in `buildResultView` from `input` (so `sourceEvidence` is still visible). One `line` row (plus tail rows) goes into `resultViewRows` **after the control line and before coverage**. The CLI, Pi `viewLines`, the collapsed Pi result and the board then print it by construction. `pi-surface-check.mts` compares that block, so parity holds automatically. Update the exact-block test expectations (e.g. `ACQUIRING_BLOCK`) on purpose.
- **Disagreement list.** Keep it **out** of the first block and out of `details`. `pi-surface-check.mts` cuts the CLI block at the first blank line and at `Не измерено по причинам:` [VERIFIED: pi-surface-check.mts lines ~58-61]. Rows placed under `details` would appear in the CLI block but not in the payload, which gives `DIFF`.
  - Export `disagreementRows(view)`: heading `Несогласия с судьёй (<K>):` (CLI/Pi) or `НЕСОГЛАСИЯ С СУДЬЁЙ` (board). One row per disagreement: `  <title> — судья: не справился → вы: справился. Причина: «<note>»`.
  - CLI `summary` prints it after the phase-2 cause section and before `Все провалы`.
  - Pi `summary()` payload adds `disagreementLines`, and the collapsed render prints them after `failureLines`.
  - The board overview (section 1) shows the heading and the rows after the causes.
  - Extend `pi-surface-check.mts` with a section comparison, the same way phase 2 added `sections=`.
- **Board section 3 header.** Replace «Разбор: осталось…» with `Проверено: <x> из <b> провалов · успехи: <y> из <d> · y согласен · n не согласен · s не могу сказать` (warning while anything in the queue is unmarked, muted after).
- **CLI `--json`.** `view.agreement` is included automatically.

### Anti-Patterns to Avoid
- **Counting agreement with `agentMetricResult` or `goalCardOutcome`.** Both already contain the human verdict, so agreement would always be 100%.
- **Trusting `judgeVerdict` or `judge` from the caller.** The lab derives them.
- **Seeding the sample with `Math.random` or with current (overridden) results.** The sample would change on reopen or after a flip.
- **Putting the disagreement list under `details` in `resultViewLines`.** That breaks the surface parity check.
- **Letting the model call a tool that writes quick marks.** `agent_lab_review` already takes only `id` and `trialId`. Do not add `source` or `verdict` parameters to any tool.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Small-sample interval | new CI code | `wilson()` in src/result-view.ts | Same numbers and words as phase 1 |
| Plurals | ad-hoc endings | `pluralForm` (phase 2 moves it to `src/plural.ts`, re-exported) | One rule |
| Hashing | a custom PRNG | `fingerprint` (sha256) | Deterministic, already used |
| Supersession | a second "latest" map | `latestHumanReviews` | Same key format everywhere |
| Wrapping and indent | `.slice` / padding | phase-2 `wrapRows`, `wrapTextWithAnsi`, `visibleWidth` | UI-SPEC width rules |
| Terminal escaping | a custom regex | `safeText` (board, Pi), `safeLine` (CLI) | Human notes are untrusted text |
| Evidence rows | new quote logic | phase-2 `explain.ts` builders | Quotes are already verified there |

## Runtime State Inventory

Not a rename or migration phase; only additive fields.
- **Stored data:** no existing record has a human review (measured). Nothing to migrate.
- **Live service config / OS-registered state / secrets / build artifacts:** none, except `dist/` (see Pitfall 6).

## Common Pitfalls

### Pitfall 1: Agreement that is always 100%
**What goes wrong:** the count uses the overridden result. **Avoid:** read `trial.assessments[].result` only. A test covers disagree on a failure → `agreed 0 / checked 1` while the headline counts a pass.

### Pitfall 2: «Не могу сказать» removes a failure from the number
**What goes wrong:** the locked mapping stores `unknown`, and `agentMetricResult` returns it. The card becomes not measured (`human_unknown`), so the owner can raise the accuracy by pressing `s` on failures. **Avoid:** keep the lock and make the effect visible:
- the not-measured line already reads «человек не смог решить»;
- the agreement line shows «Не смог решить: K»;
- the notice after `s` says «ситуация не входит в число, пока вы не решите».

This is flagged in Open Questions.

### Pitfall 3: Every «согласен» becomes a «замечание человека»
**What goes wrong:** `humanFindings` emits every `fail` review, which inflates `flagged` and relabels list rows. **Avoid:** skip quick agreements in `humanFindings` (Pattern 4b).

### Pitfall 4: The review never finishes
**What goes wrong:** `awaitingVerdict` requires every failed check or metric to be decided. **Avoid:** Pattern 4b. Test it: a card with goal fail and prompt_compliance fail becomes resolved after one `y`.

### Pitfall 5: A mark on a finished run reopens it
**What goes wrong:** `addHumanReview` checkpoints to `results_review` and clears `resultsReviewedAt`. **Avoid:** accept the behavior and say it in the notice. An `export` after a mark shows the new state.

### Pitfall 6: New records are unreadable by the old dist
**What goes wrong:** `strictObject` rejects unknown keys. Once the executor swaps in the phase-3 dist and writes quick marks, rolling `dist/` back makes those records fail to load. **Avoid:** write quick marks only into temporary copies during this phase, and note the rollback caveat in the SUMMARY.

### Pitfall 7: The sample drifts
**What goes wrong:** the sample is computed while trials still arrive, or from overridden results. **Avoid:** return `[]` in running phases and use recorded results only.

### Pitfall 8: Remap regressions
**What goes wrong:** old tests expect `n` → `verdict: 'fail'`. **Avoid:** update them deliberately. Add a test that `p` in section 3 emits nothing, and that `n` on the run list still emits `new`.

### Pitfall 9: The disagree editor steals the board lock
The editor opens after the board has finished; the loop already does this for `annotate`, so no new risk. Cancel (`undefined`) saves nothing and shows no notice.

### Pitfall 10: Phase-2 names may shift
**What goes wrong:** `failureExplanation`, `wrapRows`, `resultViewRows`, `judgedCut` and the notice kind `success` are known from plans only. **Avoid:** plan tasks must `grep` for them first (a precondition that phase 2 SUMMARYs exist).

## Code Examples
See Patterns 1–7 above. All values in them are quoted from files read this session, except the phase-2 symbols, which are marked [CITED: 02-0x-PLAN.md].

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| `p`/`n` whole-dialogue quick verdict (does not move the number) | `y`/`n`/`s` agreement on the primary metric (moves the number on disagree) | The headline reflects the owner's corrections; agreement becomes measurable |
| Judge-human agreement shown only as `disagreements` in `humanQueue` | An explicit «N из M» split by failures and passes | Manager-readable trust signal |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Phase 2 lands `failureExplanation`, `wrapRows`, `resultViewRows`, `disagreement`-free first block, notice kind `success`, `judgedBeforeSeq`/`cutBefore` as its plans say | Patterns 6–8 | Plan tasks reference missing symbols; mitigated by grep preconditions |
| A2 | Remapping `n` is acceptable to the owner (no muscle memory beyond Kikov) | Pattern 6 | Owner presses `n` meaning «провал» and records a disagreement; mitigated by help text, footer and the reason editor (a cancel saves nothing) |
| A3 | A decided quick mark on the primary metric may close the review queue for the whole trial | Pattern 4b | `f` could finish a review whose secondary failed criteria no human looked at; the finalize confirm text should say «главные оценки проверены» |
| A4 | Source-run quick marks in a reassessment are always «устарели» | Pattern 4 rule 5 | A same-version reassessment would under-count; rare |
| A5 | `s` is an acceptable key for «не могу сказать» | Pattern 6 | UI-SPEC may choose another free letter (`b g h i l m t w z`) |

## Open Questions (RESOLVED)

1. **Should a quick «не могу сказать» remove the situation from the number?**
   - What we know: the lock maps it to `unknown`, and the existing counting then gives `human_unknown`.
   - What's unclear: whether the user wants that effect or only a record of the doubt.
   - Recommendation (superseded): keep the lock and make the effect visible (Pitfall 2).
   - RESOLVED (CONTEXT, autonomous decision; UI-SPEC D-17/C-97; plan 03-02): a quick «не могу сказать» does NOT change the headline. It is skipped by the metric override, `trialAssessmentComplete` and `trialReasons`, counted only as «не смог решить», and the trial stays in `awaitingVerdict`. Wherever the Pattern 2 / Pitfall 2 text above contradicts this, follow the plans.
2. **Which record is the demo record?** The v11 reassessment id is known only after 02-03 runs. The check script takes `--id`. Real marks are the owner's job after the freeze (human item).
   - RESOLVED: the check script takes `--id`; 03-07 uses fae4ee59/a92fd6ae copies; the demo id comes from 02-03.
3. **Per-trial vs per-situation with repeats > 1.** Not relevant for the demo (repeats=1). Recommendation: count per trial and switch the word to «диалог». Document it.
   - RESOLVED (03-01): count per trial, documented as a known limitation in the `src/agreement.ts` header; the UI-SPEC strings need no noun change.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | everything | ✓ | v22.22.3 | — |
| tsx | tests, check scripts | ✓ | 4.23.13 | — |
| pi-coding-agent / pi-tui | board, editor | ✓ | 0.85.1 / 0.85.1 | — |
| stored runs in `.agent-lab` | scripted check on a copy | ✓ | fae4ee59, a92fd6ae, 61521e0d, 9d587362 | the demo fixture from `createDemoRuntime` |
| Live human in Pi | real marks, theme screenshot | ✗ (user asleep) | — | the scripted board on a copy; human item recorded |

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` through `tsx --test` (tsx 4.23.13), plus `tsc` and `npm run typecheck` for extensions |
| Config file | `tsconfig.json`; the runner is `.planning/phases/01-odno-chestnoe-chislo/snap-test.sh` |
| Quick run command | `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh test/agreement.test.ts test/result-view.test.ts test/comparison.test.ts` |
| Full suite command | `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh` (working tree) and, before the dist swap, `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh --full` |

Never run `npm test` or `npm run build` in the worktree.

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| JUDGE-04 | Schema accepts old reviews unchanged and new quick fields; rejects `source:'quick'` without `metricId` or with `invalid` | unit | `snap-test.sh test/contracts.test.ts` | ✅ (add cases) |
| JUDGE-04 | `addHumanReview` fills `judgeVerdict`/`judge` from receipt or audit; rejects a wrong metric, an undecided judge, or a mismatched `judgeVerdict`; `measurementHash` unchanged, `resultHash` changed; survives `store.get` reload | unit | `snap-test.sh test/experiment.test.ts test/store.test.ts` | ✅ (add cases) |
| JUDGE-04 | `primaryMetricId`: goal first; else first failed; else first passed; RAG ignored | unit | `snap-test.sh test/outcomes.test.ts` | ✅ |
| JUDGE-04 | Disagree on a failure flips the headline (`cardVerdict` pass); unsure gives `human_unknown` | unit | `snap-test.sh test/comparison.test.ts test/result-view.test.ts` | ✅ |
| JUDGE-04 | Board: `y`/`n`/`s` emit `agree` with trialId, metricId, judgeVerdict, reviewMs; nothing while searching, with help open, outside section 3, or on a trial without a judge verdict; `p` in section 3 emits nothing; `n` on the run list still emits `new`; the detail pane puts the evidence rows before `Судья:` | unit | `snap-test.sh test/cards.test.ts` | ✅ (update + add) |
| JUDGE-04 | Loop: disagree opens the editor; cancel/empty saves nothing; the reason is saved verbatim; reopening shows «Ваша отметка»; the journey `['3','n']` updated | integration | `snap-test.sh test/extension.test.ts` | ✅ (update) |
| JUDGE-05 | `judgeAgreement` uses recorded results; splits failures and passes; counts unsure and stale (tampered snapshot, sourceEvidence marks); a later `v` review supersedes; controls excluded | unit | `snap-test.sh test/agreement.test.ts` | ❌ Wave 0 |
| JUDGE-05 | Wording at checked = 0, 1, 9, 10, 19, 20; passes 0/sample-empty/unchecked; tail rows; goal row; no jargon | unit | `snap-test.sh test/result-view.test.ts` | ✅ (add) |
| JUDGE-05 | CLI summary prints the agreement row in the block and the `Несогласия с судьёй (K):` section; Pi payload `disagreementLines`; `pi-surface-check.mts` OK | integration | `snap-test.sh test/result-view.test.ts test/extension.test.ts` + surface check below | ✅ / script update |
| JUDGE-06 | `agreementSample`: ≤3 passes → all; 7 passes → the same 3 across `structuredClone` and after a disagree flip; different run id → a draw computed from that id; running phase → [] | unit | `snap-test.sh test/agreement.test.ts` | ❌ Wave 0 |
| JUDGE-06 | `reviewOrder`: unmarked failures, then sampled passes, then the rest; after a mark the same index shows the next case; list label `ПРОВЕРЬТЕ И УСПЕХ` | unit | `snap-test.sh test/cards.test.ts` | ✅ (add) |
| All | Scripted board on a **temp copy** of a stored run | e2e (free) | see below | ❌ Wave 0 (`agreement-check.mts`) |

**Scripted e2e on a copy** (`.planning/phases/03-soglasie-cheloveka-s-sudey/agreement-check.mts`, modeled on `pi-surface-check.mts`):
1. Setup:
   - `umask 077`;
   - make a temp dir with `mktemp -d` and `chmod 700`;
   - copy `<id>.json`, `<id>.trace.jsonl` and `<id>.judge/` (if present) for the run **and** its `parentRunId`/`assessmentOf` record into `<tmp>/.agent-lab/`;
   - record the sha256 of the originals.
2. Register the extension from the snapshot root with a fake `pi`, and call the `agent-lab` command handler with `ctx = { cwd: tmp, mode: 'tui', hasUI: true, ui }`. The `ui.custom` stub feeds the scripted keys. `ui.editor` returns the fixed synthetic reason «Проверка: судья не учёл уточнение клиента.»
3. Board steps:
   - `['3','y']` on the first failure;
   - `['3','n']` on the next failure (the reason editor fires);
   - `['3','s']` on the next;
   - on a92fd6ae, also `y` on the sampled pass;
   - `['q']`.
4. Reopen with `['3','q']` and read the rendered cells.
5. Print only: `marks=<n> agree=<n> disagree=<n> unsure=<n> snapshot=<with judge>/<n> measurementHash=same resultHash=changed agreement=<a>/<m> failures=<a>/<b> passes=<c>/<d> sample=<k> reopenShowsMark=<bool> evidenceBeforeVerdict=<bool> originalsUnchanged=<bool> id=<id8>`.
6. Also spawn the snapshot `dist/cli.js summary --id <id> --data-dir <tmp>/.agent-lab` and print `cliAgreementRow=<0|1> cliDisagreementHeading=<0|1>`.
7. `rm -rf` the temp dir. Exit 1 on any false.

Command:
```bash
OUT=$(bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh --keep test/agreement.test.ts) || exit 1; S=${OUT##*SNAP=}; R=$PWD
(cd "$S" && npx tsx .planning/phases/03-soglasie-cheloveka-s-sudey/agreement-check.mts --source "$R/.agent-lab" \
  --id a92fd6ae-8eaa-42ea-8ba0-d804096ce1d4 --id fae4ee59-d6da-4cbf-83b5-574e34405877); rc=$?; rm -rf "$S"; exit $rc
```
Expected on a92fd6ae: `sample=1`, `passes=1/1` after the extra `y`. On fae4ee59: `sample=0` and the wording `успехов нет`.

Regression (free, read-only, with the snapshot dist): run `verify-stored-runs.mjs --dist "$S/dist" --expect …` with the counts phase 2 leaves (fae4ee59 0/9+4 and a92fd6ae 1/8+7 unless 02-03 changed the code path), plus `pi-surface-check.mts --cwd "$R" --id …`. Marks do not exist in real records, so the counts must not move.

### Sampling Rate
- **Per task commit:** the quick run command with that task's test files.
- **Per wave merge:** `snap-test.sh` (no arguments).
- **Phase gate:** `snap-test.sh --full`, then `agreement-check.mts`, `verify-stored-runs.mjs` and `pi-surface-check.mts` green, before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `test/agreement.test.ts` — JUDGE-05 and JUDGE-06 pure logic.
- [ ] `.planning/phases/03-soglasie-cheloveka-s-sudey/agreement-check.mts` — scripted board on a copy.
- [ ] Fixture helper: a reactive trial with a goal assessment and a `judgeReceipt` (reuse the fixtures from test/result-view.test.ts and test/judge.test.ts).
- No framework install needed.

**Human items (end of phase):** the owner puts real marks on the frozen v11 demo record in Pi, and checks a light and a dark theme screenshot of the agreement block.

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | local tool |
| V3 Session Management | no | — |
| V4 Access Control | yes (intent) | A human mark comes only from board keys or native dialogs; no tool accepts `source` or `verdict` |
| V5 Input Validation | yes | zod `humanReviewInputSchema`; the lab re-derives the snapshot; reason ≤3000, non-empty |
| V6 Cryptography | no (integrity hash only) | `fingerprint` (sha256) |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Model writes or forges a mark or snapshot | Spoofing/Tampering | No tool parameter; the lab fills `judgeVerdict`/`judge`; a mismatch is rejected |
| Hand-edited snapshot or judgment | Tampering | Mark becomes `stale`; the phase-2 verifier still checks judgments |
| Terminal escapes in the reason text | Tampering | `safeText`/`safeLine` at every surface; a test with an escape sequence |
| Bank text leaking via check output | Info disclosure | The script prints ids and counts only; the temp copy is 0700 and deleted |
| Gaming the number with «не могу сказать» | Repudiation | Visible «Не смог решить: K» and not-measured reason (Pitfall 2) |

## Sources

### Primary (HIGH confidence)
- Read this session:
  - `src/contracts.ts`: lines 8-9, 170-265, 555-580, 635-680, 735-880, 955-964;
  - `src/outcomes.ts` (whole file);
  - `src/result-view.ts` (whole file);
  - `src/comparison.ts`: lines 140-260, 456-610;
  - `src/experiment.ts`: lines 30-60, 220-262, 770-895;
  - `src/judge.ts`: lines 1-60, 110-200;
  - `src/evaluation.ts`: lines 280-312;
  - `src/demo.ts`: lines 130-160;
  - `src/cli.ts`: lines 85-115;
  - `src/store.ts`: lines 1-80;
  - `extensions/cards.ts` (whole file);
  - `extensions/agent-lab.ts`: lines 1-150, 154-161, 645-690, 715-860;
  - `test/cards.test.ts`: lines 1-40;
  - `test/extension.test.ts`: lines 370-470.
- Pi typings `types.d.ts` (`editor`, `select`, `confirm`, `notify`); package versions.
- Read-only measurement of `.agent-lab` with the existing dist (ids and counts).

### Secondary (MEDIUM confidence)
- Phase 2 plans: 02-CONTEXT, 02-UI-SPEC (key registry, F1, notices), 02-01, 02-02, 02-03, 02-04, 02-05, 02-08, 02-09. These are future code.
- Phase 1: `snap-test.sh`, `pi-surface-check.mts`, `verify-stored-runs.mjs`.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH (no new dependencies).
- Architecture: HIGH for current code, MEDIUM for phase-2 integration points.
- Pitfalls: HIGH (each traced to a line read this session).

**Research date:** 2026-09-17
**Valid until:** end of phase 2 execution. Re-check the phase-2 symbol names before planning tasks that use them.

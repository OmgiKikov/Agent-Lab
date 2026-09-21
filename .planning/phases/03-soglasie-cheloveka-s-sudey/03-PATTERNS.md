# Phase 3: Согласие человека с судьёй - Pattern Map

**Mapped:** 2026-09-17
**Files analyzed:** 15 (11 modified, 4 new)
**Analogs found:** 15 / 15 (one file, `src/explain.ts`, has an analog only after phase 2 has run)

**Stability warning.** Line numbers below were read at HEAD `fde75a2` on 2026-09-17.
- A code fixer is changing phase-1 files right now: `src/comparison.ts`, `src/artifacts.ts`, `src/cli.ts`, `src/evaluation.ts`, `src/report.ts`, `src/experiment.ts`, and maybe `src/result-view.ts`.
- Phase 2 (9 plans, not executed yet) will rewrite parts of `src/result-view.ts`, `extensions/cards.ts`, `extensions/agent-lab.ts` and `src/cli.ts`. It also adds `src/explain.ts` and `src/plural.ts`.

Anchors marked **(may shift; re-read)** must be found again with `grep` before editing. Symbols that only phase 2 creates cite the `02-0x-PLAN.md` that creates them. Each such plan task needs a grep precondition (RESEARCH Pitfall 10).

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/contracts.ts` (modify `humanReviewInputSchema`) | model (zod schema) | validation | same schema, `src/contracts.ts:643-651`; `judgeReceiptSchema` `:256-265` | exact |
| `src/outcomes.ts` (add `primaryMetricId`; change `agentMetricResult`) | utility (pure) | transform | `agentRubricResult` / `agentMetricResult`, `src/outcomes.ts:35-45` | exact |
| `src/agreement.ts` (NEW: `judgeAgreement`, `agreementSample`, `PASS_SAMPLE`) | utility (pure) | transform / aggregate | `src/result-view.ts` `buildResultView` (pure counter over `observedRecord`); `humanFindings` `src/comparison.ts:174-191` | role-match |
| `src/comparison.ts` (`awaitingVerdict`, `humanFindings`, `trialReasons`) | utility (pure) | transform | itself, `:174-191`, `:~209-230`, `:~535-570` | exact **(may shift; re-read)** |
| `src/experiment.ts` (`addHumanReview`) | service (writer) | CRUD (append + checkpoint) | itself, `:856-876` | exact **(may shift; re-read)** |
| `src/result-view.ts` (`ResultView.agreement`, agreement row, `disagreementRows`) | utility (text builder) | transform | `controlLine` + `resultViewLines`, `:170-208`; phase-2 `resultViewRows` / `causeSection` (02-04-PLAN) | exact **(may shift; re-read)** |
| `src/explain.ts` (add `situationEvidence` for passed situations) | utility (text builder) | transform | phase-2 `failureExplanation` (02-04-PLAN; file does not exist yet) | phase-2 only |
| `src/cli.ts` (`summary` prints F7 + F8) | controller (CLI) | request-response | itself, `:90-109` | exact **(may shift; re-read)** |
| `extensions/cards.ts` (agree action, keys, F10 block, F11 header, F12 labels, footer, help) | component (TUI board) | event-driven | itself: `BoardAction` `:40-46`, `finish` `:325-329`, `entries` `:330-344`, `handleInput` `:345-399`, header `:423-431`, help/footer `:497-504` | exact **(may shift; re-read after phase 2)** |
| `extensions/agent-lab.ts` (agree branch, editor, notices, F9, payload `disagreementLines`) | controller (Pi loop) | event-driven + request-response | itself: `verdict` branch `:807-816`, `humanAnnotation` `:116-143`, finalize `:821-836`, `summary()` `:74-92` | exact **(may shift; re-read after phase 2)** |
| `test/agreement.test.ts` (NEW) | test | — | `test/outcomes.test.ts:1-30` (fixtures) + `test/result-view.test.ts:1-80` (`card`/`attempt`/`run`) | exact |
| `test/contracts.test.ts`, `test/experiment.test.ts`, `test/outcomes.test.ts`, `test/comparison.test.ts`, `test/result-view.test.ts` (add cases) | test | — | existing cases in the same files | exact |
| `test/cards.test.ts` (update p/n tests, add agree tests) | test | — | `test/cards.test.ts:15-28`, `:236-268` | exact |
| `test/extension.test.ts` (journey `['3','n']` + editor stub) | test | — | `test/extension.test.ts:380-430`, `:901` | exact |
| `.planning/phases/03-soglasie-cheloveka-s-sudey/agreement-check.mts` (NEW) | test (scripted e2e, read-only on a copy) | batch / file-I/O | `.planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts` (97 lines) + the `ui.custom` stub in `test/extension.test.ts:383` | role-match |

All analog paths were checked with `git ls-files`; all are tracked source. No mirror paths are used.

---

## Pattern Assignments

### `src/contracts.ts` (model, validation)

**Analog:** `src/contracts.ts:643-651` (the schema being extended).

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

- **Add the fields inside the `strictObject`, before the `.refine` chain.** `safeExtend` at `:651` keeps the refinements, and `sourceEvidence.humanReviews` (`:860`) reuses `humanReviewSchema`, so both pick up the new fields automatically.
- **Snapshot shape.** Copy the hash field style from `judgeReceiptSchema` (`:256-257`): `protocolHash: text, inputHash: text`. Copy the vote enum from `:262`: `z.enum(['pass', 'fail', 'unknown'])`.
- **Placeholder notes.** `text` is `z.string().trim().min(1)` (`:9`), so every note must be non-empty. The two fixed notes C-103 satisfy this.
- **New refinement.** Add it last, with a Russian message: `.refine(v => v.source !== 'quick' || (!!v.metricId && v.verdict !== 'invalid'), '…')`.
- **Test analog.** `test/contracts.test.ts:109-111` already does `humanReviewInputSchema.safeParse(legacy).success`. Add cases next to it: an old review parses unchanged; a quick mark without `metricId` is rejected; a quick `invalid` is rejected.

---

### `src/outcomes.ts` (utility, transform)

**Analog:** `src/outcomes.ts` (87 lines, whole file read).

**Imports** (line 1):
```ts
import { metricApplies, simulatorWasUsed, type Experiment, type HumanReview, type Scenario, type Trial } from './contracts.js';
```

**Pattern for `primaryMetricId`.** Copy `agentRubricResult` (`:40-45`): filter `scenario?.metrics` by `m.subject === 'agent'` and read `trial.assessments?.find(a => a.metricId === id)?.result`. The code body is RESEARCH Pattern 2. The `goal_attainment` literal is also used in `goalCardOutcome` (`src/comparison.ts:~505`).

**Required change to the override (a CONTEXT lock the RESEARCH predates).** CONTEXT line 36 and UI-SPEC D-17 say a *quick* `unknown` must **not** replace the judge verdict. Today the override is:
```ts
// src/outcomes.ts:35-38
export function agentMetricResult(trial: Trial, metricId: string, reviews: HumanReview[] = []): 'pass' | 'fail' | 'unknown' | undefined {
  const human = latestHumanReviews({ trials: [trial], humanReviews: reviews }).get(`${trial.id}|metric:${metricId}`)?.verdict;
  return human === 'invalid' ? undefined : human ?? trial.assessments?.find(a => a.metricId === metricId)?.result;
}
```
- Skip a latest review where `source === 'quick' && verdict === 'unknown'` and fall through to `trial.assessments`.
- Apply the same skip in `trialAssessmentComplete` (`:54-61`, `if (human) return human !== 'unknown'`).
- Apply it in `trialReasons` (`src/comparison.ts:~561`, `latest.get(...)?.verdict === 'unknown'` → `human_unknown`), so a quick unsure never produces `human_unknown`.
- A non-quick `unknown` keeps today's behavior.
- RESEARCH Pitfall 2 still describes the old effect («ситуация не входит в число»); the planner must follow CONTEXT and UI-SPEC C-97 instead.

**Supersession key** (`:24-32`): `` `${review.trialId}|${review.metricId ? `metric:${review.metricId}` : …}` ``. Reuse it. Do not build a second latest-map.

**Test analog.** `test/outcomes.test.ts:1-30` defines `rubric()`, `scenario` (goal + prompt_compliance), `trial` and `review(verdict, metricId, at)`. Extend `review` with `source`.

---

### `src/agreement.ts` (NEW, utility, transform)

**Analogs:**
- `src/result-view.ts:1-12`: header comment + imports; a pure module that must not import `experiment.ts`.
- `src/comparison.ts:174-191` (`humanFindings`): iterate `latestHumanReviews(record).values()` and compare with the *recorded* `trial.assessments`.

**Header/imports pattern** (`src/result-view.ts:1-11`):
```ts
import type { Experiment, Scenario, ValidationExclusion } from './contracts.js';
import { observedRecord } from './outcomes.js';
/*
 * The one result every surface shows first: … Pure: no I/O, no escaping (each surface escapes at its own boundary). …
 * It must not import quality.ts or experiment.ts, …
 */
```
For `agreement.ts`, import only `./contracts.js` (`fingerprint`, types) and `./outcomes.js` (`observedRecord`, `latestHumanReviews`, `primaryMetricId`, `runningPhases`). Do **not** import `comparison.ts`: `comparison.ts` will import `primaryMetricId` from `outcomes.ts`, and `result-view.ts` already imports `comparison.ts`.

**Recorded-vs-human comparison** (`src/comparison.ts:176-186`):
```ts
return [...latestHumanReviews(record).values()].flatMap(review => {
  const trial = record.trials.find(t => t.id === review.trialId);
  …
  const automatic = !measured(trial) ? 'unknown' : review.metricId ? trial.assessments?.find(a => a.metricId === review.metricId)?.result ?? 'unknown' …
  const disagreement = automatic !== 'unknown' && review.verdict !== automatic;
```

**Controls exclusion** (`src/result-view.ts:~113`):
```ts
const controlIds = new Set((record.positiveControlScenarioIds ?? []).filter(id => record.scenarios.some(scenario => scenario.id === id)));
```

**Other building blocks:**
- **Running phases:** `runningPhases` (`src/outcomes.ts:8`). `agreementSample` returns `[]` while a run is in progress.
- **Deterministic ordering:** `fingerprint` (`src/contracts.ts:960-964`, sha256 over key-sorted JSON). The sort comparator copies the `a < b ? -1 : a > b ? 1 : 0` style from that function. Do not copy `clusterInterval`'s xorshift (`src/comparison.ts:14-28`); `fingerprint` is enough.
- **Judge snapshot source:** `trial.judgeReceipt ?? trial.judgeAudit`. Both carry `protocolHash` and `inputHash` (`src/contracts.ts:238`, `:256`).
- **Algorithm:** RESEARCH Pattern 4 (rules 1-7) and Pattern 5 give the full rules. The UI-SPEC F6 terms add `Q_fail` (queued failures) and `S` (sample size). `JudgeAgreement` should expose `queueFailures` (or `failureIds`) so F6, F11 and F12 need no second count.

---

### `src/comparison.ts` (utility, transform) **(may shift; re-read — the phase-1 fixer is editing this file)**

**`awaitingVerdict`** (`:~209-230`). Insert the quick-mark early return **after** the simulator-pending block (the `{ … if (pending.some(…)) return true; }` block) and **before** `if (!isAgentFailure(record, trial) …`:
```ts
export function awaitingVerdict(record: Experiment): Set<string> {
  record = observedRecord(record);
  const latest = latestHumanReviews(record);
  const decided = (key: string) => ['pass', 'fail'].includes(latest.get(key)?.verdict ?? '');
  return new Set(record.trials.filter(trial => {
    if (latest.get(`${trial.id}|dialogue`)?.verdict === 'invalid') return false;
    { const pending = [ …simulator checks/metrics… ]; if (pending.some(…)) return true; }
    // ← phase 3: decided quick mark on primaryMetricId → return false
    if (!isAgentFailure(record, trial) || decided(`${trial.id}|dialogue`) || …) return false;
```
- Add `primaryMetricId` to the existing `./outcomes.js` import on line 4.
- Watch the new `agentMetricResult` rule: a quick unsure leaves the judge `fail` in place. `isAgentFailure` then stays true and the trial stays pending, which is what F11 «Не решено» needs.

**`humanFindings`** (`:174-191`). After `disagreement` is computed, add `if (review.source === 'quick' && !disagreement) return [];` (RESEARCH Pitfall 3). Quick unsure marks are already dropped by the `['pass','fail','invalid']` filter on `:178`.

**`trialReasons`** (`:~535-570`). The `human_unknown` branch at `:~561` must ignore quick unsure marks (see `outcomes.ts` above).

---

### `src/experiment.ts` (service, CRUD) **(may shift; re-read — the phase-1 fixer is editing this file)**

**Analog:** `addHumanReview`, `:856-876`:
```ts
async addHumanReview(id: string, raw: HumanReviewInput): Promise<Experiment> {
  return this.change(async () => {
    const record = await this.store.get(id);
    if (record.workflow !== 'evaluate' || !['results_review', 'complete'].includes(record.phase)) throw new Error('Вердикты человека можно ставить только по завершённым диалогам.');
    const input = humanReviewInputSchema.parse(raw);
    const trial = record.trials.find(t => t.id === input.trialId);
    if (!trial) throw new Error('Такого диалога в этом эксперименте нет.');
    …
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    if (input.metricId && (!scenario || !assessmentRubrics(scenario, trial).some(m => m.id === input.metricId))) throw new Error('Такой рубрики в этой карточке нет.');
    // ← phase 3: quick-mark validation + snapshot fill (RESEARCH Pattern 3), error texts C-99 / C-100 / C-101
    (record.humanReviews ??= []).push({ ...input, id: randomUUID(), createdAt: new Date().toISOString() });
    delete record.resultsReviewedAt; delete record.resultsReviewHash;
    await this.checkpoint(record, 'results_review', 'Human annotation saved separately from the original assessment.');
    return structuredClone(record);
  });
}
```
- **Error style:** `throw new Error('<Russian text>')`, one guard per line. Use the exact UI-SPEC strings:
  - C-99: `Оценка судьи изменилась, пока вы смотрели. Проверьте ситуацию ещё раз.` (RESEARCH's shorter text is superseded).
  - C-100 and C-101 as written in the UI-SPEC.
- **Import:** add `primaryMetricId` from `./outcomes.js`. The file imports from `./comparison.js` on line 9, and `comparison.ts` re-exports some outcomes symbols (line 5). Pick one import path and keep it consistent.
- **Hash invariants:** `resultHash` (`:42`) includes `humanReviews`; `measurementHash` does not. Test that a mark keeps `measurementHash` and changes `resultHash`.
- **Test analog:** `test/experiment.test.ts:845-850`:
  ```ts
  await assert.rejects(lab.addHumanReview(result.id, { trialId: originalTrial.id, metricId: 'missing', verdict: 'fail', note: 'Wrong metric.' }), /Такой рубрики/);
  ```
- **Receipt-backed trials** for the snapshot test: `test/experiment.test.ts:1639-1649` (reassess writes `judgeReceipt`), or `test/judge.test.ts:315` (`judgeReceipt: sealJudgeReceipt(lastAudit!, complete)`).

---

### `src/result-view.ts` (utility, text builder) **(may shift; re-read — phase 2 replaces `resultViewLines` with `resultViewRows`)**

**Analogs at HEAD:**
- `controlLine` (`:176-192`): one plain-text row per concern, built from `ResultView` fields only.
- `resultViewLines` (`:195-208`): the order of rows in the first block.

```ts
lines.push(controlLine(view));
if (coverage.text) lines.push(coverage.text);                // ← F6 agreement row + tail rows go between these two
if (options.details && notMeasured.reasons.length > 1) { … } // ← never put F7 under details (parity check)
```

**Other patterns in the file:**
- **Interface field:** add `agreement: JudgeAgreement` to `ResultView` (`:~86-100`). Copy the doc-comment style of `stability?` (`:98-99`).
- **Compute in `buildResultView`** (`:109-162`). Call `judgeAgreement(input)` on `input`, not on `record`: `record = observedRecord(input)` drops nothing for evaluate runs, but `sourceEvidence` is read from `input`.
- **Constants:** `SMALL_SAMPLE = 20` is private at `:15`. Reuse it and add `PERCENT_FROM = 10` next to it.
- **Plurals:** `pluralForm` is at `:29-32` today; phase 2 moves it to `src/plural.ts` and re-exports it (02-04-PLAN, pattern-map decision 1).
- **Verdict words:** `VERDICT_WORD` (`:164`) already maps `pass`/`fail` to `справился`/`не справился`. Reuse it for F7 and C-62.
- **After phase 2:**
  - `resultViewRows(view, options)` returns rows with roles `lead | line | situation | detail`, and `causeSection(view)` / `failureListRows(view)` build the separate sections (02-04-PLAN lines 57-58; 02-05-PLAN line 100).
  - Add the F6 rows to `resultViewRows` (role `line`, tail rows role `detail` with indent 2).
  - Export `disagreementRows(view)` modeled on `failureListRows(view)`, returning `{ role, indent, text }` rows with the UI-SPEC row roles `dis-title | dis-verdicts | dis-reason`.
- **Test analog:** `test/result-view.test.ts:1-80` (fixtures `card`, `vote`, `attempt`, `run`) and `:144-156` (exact block assertion against `ACQUIRING_BLOCK`, `:83-89`). Update `ACQUIRING_BLOCK` on purpose, since F6 is **not printed** when the queue is empty but reads `Согласие с судьёй: ещё не проверено.` when failures exist. The acquiring fixture has failures, so the block gains one row.

---

### `src/explain.ts` (utility, text builder) — phase-2 file

**Analog:** does not exist at HEAD. Phase 2 creates it (02-04-PLAN lines 50-55):
- exports `ruleRegister, ruleText, failureExplanation, exampleRows, rowsToLines, UNVERIFIED`;
- defines `ExplanationRow { role, indent, text }` with roles `title | example | expected | said | rule | more | violated | cut | unverified`;
- `failureExplanation(record, scenario, trial?)` returns `{ kind, said, rules, unverifiedRules, moreRules, violated?, judgedBeforeSeq?, rows }` (02-06-PLAN line 79).

Phase 3 adds `situationEvidence(record, scenario, trial, metricId)`:
- It shares the expected/said/rule/more/cut builders.
- Its title row has no glyph.
- For a pass: `said` is the first agent reply the primary metric cites, otherwise C-05 («судья не указал реплику»), and there is never a `violated` row.

**Constraint (02-04 CTX-24):** `explain.ts` imports neither `experiment.ts` nor `quality.ts`. Precondition for the plan: `test -f src/explain.ts && grep -c "export function failureExplanation" src/explain.ts`.

---

### `src/cli.ts` (controller, request-response) **(may shift; re-read — the phase-1 fixer and 02-05/02-07 both edit `summary`)**

**Analog:** `summary` at `:90-109`:
```ts
const view = buildResultView(record, { before });
if (values.json) { process.stdout.write(`${JSON.stringify({ ...q, view }, null, 2)}\n`); return; }
const text = qualityLines(q);
process.stdout.write([...resultViewLines(view, { details: true }).map(safeLine), '', 'Подробности:', ...text.metrics, '',
  ...(text.causes.length ? ['Почему:', ...text.causes, ''] : []), …].join('\n'));
```
- Every row goes through `safeLine` (`:26`: `safeText(value).replace(/\n+/g, ' ')`), which also escapes human reasons.
- **Where F7 and F8 go.** After phase 2 the order is block → F3 → F2 → `Все провалы`. Insert F7 (`disagreementRows(view)` → text) and F8 (C-64) after F2 and before `Все провалы` (UI-SPEC F7 placement table). Each section is followed by `''`, as the `Почему:` section is today.
- `--json` includes `view.agreement` automatically, because `view` is spread.

---

### `extensions/cards.ts` (component, event-driven) **(may shift; re-read — 02-05 and 02-08 rewrite render, notices and keys)**

**Imports** (`:1-8`). The board imports compiled modules from `../dist/*.js`:
```ts
import { awaitingVerdict, verdictSummary, isAgentFailure, humanFindings, humanFindingText, repeatResultText, plannedTrials, type RunComparison, type VerdictNote } from '../dist/comparison.js';
import { buildResultView, resultViewLines, type ResultView } from '../dist/result-view.js';
```
Add `import { agreementSample, judgeAgreement } from '../dist/agreement.js';` and `primaryMetricId` from `../dist/outcomes.js`. The dist must be built (in the snapshot) before extension tests see them.

**`BoardAction` variant** (`:45-46`). Copy the `verdict` variant shape:
```ts
| { type: 'verdict'; verdict: 'pass' | 'fail'; record: Experiment; section: Section; selected: number; query?: string; pendingOnly?: boolean; trialId?: string; reviewMs?: number };
```
Add `{ type: 'agree'; answer: 'agree' | 'disagree' | 'unsure'; trialId: string; metricId: string; judgeVerdict: 'pass' | 'fail'; …same state fields }`. Decide whether the `verdict` variant is removed (the `p` key is retired) or kept for tests. Phase 2 adds `accept`/`expect` (02-08-PLAN line 137).

**`reviewMs` attach** (`:325-329`):
```ts
if ((action.type === 'verdict' || action.type === 'annotate') && action.trialId) action.reviewMs = Math.round(this.options.reviewTimes?.get(`${action.record.id}|${action.trialId}`) ?? 0);
```
Add `'agree'` to the condition.

**`reviewOrder`** (`:31-36`). The rank function to extend with the queue groups (F12 order):
```ts
const rank = (trial: Trial) => pending.has(trial.id) ? 0 : flagged.has(trial.id) ? 1 : isAgentFailure(record, trial) || trial.outcome === 'invalid' ? 2 : 3;
```

**List labels** (`entries`, `:336-340`). Extend the prefix, label and suffix per F12. Keep the `pendingOnly` filter, but include unmarked queue items (D-22):
```ts
text: `${pending.has(t.id) ? '● ' : ''}${flagged.has(t.id) ? 'ЗАМЕЧАНИЕ ЧЕЛОВЕКА' : isAgentFailure(record, t) ? 'НЕ ПРОЙДЕНО' : verdicts[t.outcome]} · ${…title} · ${t.userMode ?? 'reactive'} #${t.repeat + 1}`,
})).filter(e => !this.pendingOnly || pending.has(e.id));
```

**Key handling** (`:369-386`):
```ts
const reviewable = this.record.workflow === 'evaluate' && this.section === 'results'
  && ['results_review', 'complete'].includes(this.record.phase) && this.entries().length > 0;
…
if (reviewable && (key('p') || key('n'))) return this.finish({ type: 'verdict', verdict: key('p') ? 'pass' : 'fail', ...state });
```
- Replace line 377 with `y`/`n`/`s` → `agree`, gated also on the F10 block being shown for the selected trial.
- `p` does nothing in section 3.
- `n` on the run list stays at `:363` (`!this.record && key('n')`).
- The `searching` and `help` guards already run earlier (`:347-362`), so the keys are inert there.

**Detail pane** (`trialLines`, `:126-170`):
- Build F10 as a separate `agreementBlockLines(...)` returning `Line[]`, and prepend it where `detail = trial ? trialLines(...)` is set (`:466`).
- In `trialLines`, change the `ОТДЕЛЬНАЯ ПРОВЕРКА ЧЕЛОВЕКОМ` loop (`:155-158`) to skip `source === 'quick'` reviews (D-20).
- Replace the p/n muted row (`:159-162`) with C-77 / C-78, omitted when the block is shown.
- Row helper: `line(text, color, bold)` (used throughout). After 02-05, `Line` gains `indent`, and `wrapRows(rows, inner)` replaces the inline wrap at `:498` (02-05-PLAN line 168).

**Section-3 header** (`:423-431`). Replace the «Разбор: осталось…» expression with the F11 tier table. Pick the tier by `inner >= 48`. `inner` is computed at `:407`.

**Help and footer** (`:497`, `:503`):
- Replace the `'p / n — вердикт …'` help row with C-87 and C-88, and add C-89 before the final muted row.
- The footer ternary on `:503` becomes the tier selection from the Key Map Registry, measured with `visibleWidth` (already imported on `:2`).

**Notices.** Today they are `notice?: { message; kind: 'info' | 'error' }` (`:~56`), rendered at `:432`. 02-08 widens this to `'success' | 'info' | 'error'` (02-08-PLAN line 137). C-92 uses `info`; C-95..C-97 use `success`.

**Escaping.** `safeText` (`:11-14`) applies to every rendered string, including the human reason.

**Test analogs:**
- `test/cards.test.ts:15-28`: `LabBoard` with `reviewTimes`, `board.render(120)`, wait 20 ms, `handleInput('n')`, assert `action.type` and `reviewMs >= 115`. Rewrite it for `agree`.
- `test/cards.test.ts:236-268`: order, header text, `p`/`n` actions, running-phase inertness. Update it deliberately.
- Theme stub (`:13`): `const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value };`.

---

### `extensions/agent-lab.ts` (controller, event-driven) **(may shift; re-read — 02-05 and 02-08 edit `summary()`, `renderResult` and `inform`)**

**Branch to copy.** The `verdict` branch (`:807-816`):
```ts
} else if (action.type === 'verdict') {
  const trial = action.trialId ? action.record.trials.find(t => t.id === action.trialId) : reviewOrder(action.record)[action.selected];
  if (!trial) throw new Error('Диалог не выбран.');
  await lab.addHumanReview(action.record.id, {
    trialId: trial.id, verdict: action.verdict,
    note: 'Быстрый вердикт из терминала, без записанного основания.',
    durationMs: action.reviewMs,
  });
  reviewTimes.delete(`${action.record.id}|${trial.id}`);
  reportPath = undefined;
```
- **Editor pattern:** `humanAnnotation` (`:116-143`), `const note = await ctx.ui.editor('…', '')` (`:135`), with `durationMs` built as `Math.min(3600000, Math.round(performance.now() - started + (reviewTimes?.get(...) ?? readingMs)))` (`:143`). Use the C-91 title and prefill it with the current disagreement note (D-18).
- **Cancel and re-show:** `continue` inside the `while (true)` loop re-renders the board with the current `section`, `selected` and `notice` (see the finalize branch, `:822-827`).
- **Notices:** `inform(message, kind)` (`:737-739`) escapes with `safeText`. Its default kind becomes `success` after 02-08 (pattern-map decision 6).
- **Errors:** lab errors fall into `catch (error) { inform(inputError(error), 'error'); }` (`:~850`). C-99..C-101 therefore arrive as the lab's message; check that `inputError` passes it through unchanged.

**Finalize** (`:821-836`):
- Replace the pending notice (`:826`) with C-102.
- In the `ctx.ui.confirm('Завершить человеческий аудит?', …)` body, insert C-65 directly after `Отдельных заметок человека: ${…}.`.

**Payload** (`summary()`, `:74-92`):
```ts
...(block ? { view: block, viewLines: resultViewLines(block) } : {}),
```
- 02-05 adds `failureLines` next to it (02-05-PLAN line 129). Add `disagreementLines` (F7 rows + F8 as plain text) the same way.
- In `renderResult` (`:22-41`), print it after `failureLines` in the `brief`, `proofs` and default branches.
- Do **not** add `source` or `verdict` parameters to any tool (F15).

**Test analog:** `test/extension.test.ts:380-430`:
- the `ctx.ui` stub has `editor: async () => request` (`:380`) and `custom: (factory) => new Promise(...)` (`:383`), which feeds `steps`;
- the journey at `:421-424` is `steps = [['3', 'n'], ['f'], ['q']]` with the assertion `humanReviews.length === 1` and `phase === 'complete'`.

With the remap, `n` opens the editor: the stub must return a reason and the assertion must check `source === 'quick'`. The editor stub with a prefill check at `:901` shows how to assert on the prefill.

---

### `.planning/phases/03-soglasie-cheloveka-s-sudey/agreement-check.mts` (NEW, scripted e2e on a copy)

**Analog:** `.planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts`.

**Header and args** (`:1-22`): a read-only doc comment that says «Prints only ids and counts», `parseArgs` with `multiple: true` ids, and a usage error with `process.exit(2)`.

**Snapshot-relative imports** (`:16`, `:25-29`):
```ts
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const agentLab = (await import(pathToFileURL(resolve(root, 'extensions/agent-lab.ts')).href)).default;
const { ExperimentStore } = await import(pathToFileURL(resolve(root, 'dist/store.js')).href);
```

**Fake `pi` registration** (`:36-42`):
```ts
agentLab({ registerTool: …, registerCommand: () => undefined, on: …, sendMessage: () => undefined, sendUserMessage: () => undefined });
```
Unlike the analog, capture the command handler: `registerCommand: (name, options) => { command = options.handler; }`, as in `test/extension.test.ts:29`. Drive it with a `ui.custom` stub copied from `test/extension.test.ts:383`, and with `ui.editor` returning the synthetic reason.

**CLI spawn** (`:56-57`):
```ts
const cli = spawnSync(process.execPath, [resolve(root, 'dist/cli.js'), 'summary', '--id', id, '--data-dir', dataDir], { encoding: 'utf8' });
```

**Output:** one `key=value` line per id (RESEARCH «Scripted e2e on a copy», steps 1-7). Exit 1 on any false value. Work in a `mktemp -d` copy (mode 0700) and verify the sha256 of the originals. Never print record text.

**Runner:** `.planning/phases/01-odno-chestnoe-chislo/snap-test.sh --keep` (56 lines).

---

## Shared Patterns

### Human-review supersession
**Source:** `src/outcomes.ts:24-32` (`latestHumanReviews`)
**Apply to:** `agreement.ts`, `comparison.ts`, `experiment.ts` (duplicate check is done in the loop, F13), `cards.ts` (mark row, labels)
Key format: `` `${trialId}|metric:${metricId}` ``; the last review in array order wins.

### Recorded judge result (never the overridden one)
**Source:** `trial.assessments?.find(a => a.metricId === id)?.result`, as used in `src/comparison.ts:183` (`humanFindings`)
**Apply to:** `agreement.ts` (base verdict, sample), `experiment.ts` (snapshot), `cards.ts` (`judgeVerdict` in the action, F10 `Судья:` row)
Anti-pattern: `agentMetricResult` / `goalCardOutcome` / `cardVerdict` for agreement (RESEARCH Pitfall 1).

### Pure-module layering
**Source:** `src/outcomes.ts:3-7` comment; `src/result-view.ts:5-11` comment
**Apply to:** `agreement.ts`, `explain.ts`
Leaf order: `contracts` → `outcomes` → `agreement` → `comparison` / `result-view`. No `experiment.ts` or `quality.ts` imports.

### Error handling
**Source:** `src/experiment.ts:859-869`; `extensions/agent-lab.ts` loop `catch (error) { inform(inputError(error), 'error'); }`
**Apply to:** the lab writer and the board loop
`throw new Error('<exact UI-SPEC Russian string>')`; no error classes; the loop turns the error into a board notice and re-shows the board.

### Terminal escaping at the surface boundary
**Source:** `extensions/cards.ts:11-14` (`safeText`); `src/cli.ts:26` (`safeLine`); `inform` at `extensions/agent-lab.ts:737-739`
**Apply to:** every F6, F7, F10, F11 and F12 string and every notice; `result-view.ts` and `explain.ts` return raw text.

### One source of text
**Source:** `src/result-view.ts` `resultViewLines` (after phase 2: `resultViewRows`, `causeSection`, `failureListRows`, per 02-04/02-05 plans)
**Apply to:** CLI `summary`, Pi `summary()` payload / `renderResult`, board section 1
Surfaces print rows unchanged. The parity check `pi-surface-check.mts` cuts the CLI block at the first blank line (`:58-61`), so F6 goes inside the block and F7 goes outside it.

### Width handling (board)
**Source:** `extensions/cards.ts:498` (`wrapTextWithAnsi(row.text, inner)`); phase-2 `wrapRows(rows, inner)` (02-05-PLAN line 168); `visibleWidth` for tier choice
**Apply to:** F10 block, F7 on the board, F11 header, footer tiers
No `.slice`, `.substring`, `padStart` or `.length` on displayed text. `truncateToWidth` is used only by the frame (`:410-411`).

### Tests run from a snapshot
**Source:** `.planning/phases/01-odno-chestnoe-chislo/snap-test.sh`
**Apply to:** every plan's verify step. Never run `npm test` or `npm run build` in the worktree.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/explain.ts` (`situationEvidence`) | utility | transform | The file exists only after phase 2 (02-04-PLAN). Use the phase-2 `failureExplanation` builders once they land; until then, RESEARCH Pattern 7 is the reference. |

No other file lacks an analog. The deterministic sampler (`agreementSample`) has no in-repo counterpart except `fingerprint`; RESEARCH Pattern 5 gives the code.

## Planner Notes (conflicts found while mapping)

1. **Quick «не могу сказать» vs RESEARCH.** CONTEXT (line 36) and UI-SPEC (D-17, C-97) lock that a quick unsure mark does **not** change the headline. RESEARCH Pattern 2, Pitfall 2 and the test map still assume `human_unknown`.
   - Plan the `outcomes.ts` / `comparison.ts` changes from the `src/outcomes.ts` section above.
   - Test that a quick unsure on a failure keeps the card `fail`, keeps the trial in `awaitingVerdict`, and produces no `human_unknown`.
2. **Error text C-99** differs from RESEARCH Pattern 3. Use the UI-SPEC text.
3. **F6 on the acquiring fixture.** `ACQUIRING_BLOCK` (`test/result-view.test.ts:83-89`) and the phase-1/phase-2 verify scripts (`verify-stored-runs.mjs`, `pi-surface-check.mts`) will see one new block row: `Согласие с судьёй: ещё не проверено.` on stored runs with failures. Update the expectations deliberately. Parity still holds by construction.
4. **Import direction.** `comparison.ts` must get `primaryMetricId` from `outcomes.ts`, not from `agreement.ts`. `result-view.ts` may import `agreement.ts`.

## Metadata

**Analog search scope:** `src/`, `extensions/`, `test/`, `.planning/phases/01-odno-chestnoe-chislo/`, `.planning/phases/02-sudya-obyasnyaet-provaly/*-PLAN.md`
**Files scanned:** 20
**Pattern extraction date:** 2026-09-17 (HEAD `fde75a2`, with the phase-1 review fixer active in the worktree)

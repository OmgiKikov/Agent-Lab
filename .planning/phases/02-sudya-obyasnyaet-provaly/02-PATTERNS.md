# Phase 2: Судья объясняет провалы - Pattern Map

**Mapped:** 2026-09-17
**Files analyzed:** 25 (3 new, 12 modified source/script files, 10 modified test files)
**Analogs found:** 25 / 25 (every new file has a close in-repo analog)
**Code state read:** HEAD `e39c9f1` (phase-1 plans 01-01…01-06 landed; 01-07…01-10 still pending).

> **Anchor stability.** Phase 1 plans 01-07…01-10 are still executing in this worktree. Line anchors in
> `src/comparison.ts`, `src/report.ts`, `src/connection.ts`, `src/normalize.ts`, `src/cli.ts`,
> `extensions/agent-lab.ts`, `src/contracts.ts`, `src/experiment.ts` and `src/result-view.ts` are marked **(may shift; re-read)**.
> Pending changes in those files: 01-07 (`comparison.ts`, `report.ts`, `connection.ts`), 01-08 (`normalize.ts`, `cli.ts`, `agent-lab.ts`),
> 01-09 (`contracts.ts` `positiveControlScenarioIds`, `experiment.ts`, `result-view.ts` control block, `cli.ts`, `agent-lab.ts`), 01-10 (`live-check.mjs`).
> Anchors in `src/judge.ts`, `src/outcomes.ts`, `src/quality.ts`, `src/evaluation.ts`, `src/pi.ts`, `extensions/cards.ts` are not touched by pending phase-1 plans.
>
> RESEARCH.md cites anchors at HEAD `1dfb8a0` (before 01-02…01-06). Where they differ, the anchors below are the current ones.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/explain.ts` (NEW) | utility (pure analysis) | transform | `src/result-view.ts` (pure module, import rule) + `src/quality.ts` `groundedScore`/`testPlanLines` (requirement→source→quote chain) | exact (role + flow) |
| `test/explain.test.ts` (NEW) | test | transform | `test/result-view.test.ts` (fixture builders `card`/`attempt`/`run`) | exact |
| `.planning/phases/02-sudya-obyasnyaet-provaly/measure-undecided.mjs` (NEW) | script (read-only) | batch / file-I/O | `.planning/phases/01-odno-chestnoe-chislo/verify-stored-runs.mjs` (tracked) | exact |
| `src/judge.ts` | service (judge protocol) | request-response + verify | itself: `assessRepeated`, `hasCompleteJudgment`, `hasCompleteReceipt`, `sealJudgeReceipt` | exact (self) |
| `src/contracts.ts` | model (zod schemas) | CRUD | `Trial.judgeReceipt` optional field (01-04); `positiveControlScenarioIds` record-level marker (01-09 plan) | exact |
| `src/evaluation.ts` | service | request-response | `assessTrial` receipt sealing (01-06) | exact (self) |
| `src/outcomes.ts` | utility (counting) | transform | `simulatorUsable` / `measurementUsable` | exact (self) |
| `src/comparison.ts` | utility (counting) | transform | `goalCardOutcome`, `trialReasons`, `cardVerdict`, `stabilityAfterReassess` | exact (self) |
| `src/result-view.ts` | utility (view model) | transform | `buildResultView` / `resultViewLines({ details })` | exact (self) |
| `src/quality.ts` | utility (view text) | transform | `testPlanLines` (one-card sheet), `causes` / `qualityLines().causes` | exact (self) |
| `src/experiment.ts` | service (orchestrator, writer) | CRUD | `acceptDraft`, `updateDraft`, `start`, `reassess`, `retainAcceptedTests`, `draftHash` | exact (self) |
| `src/cli.ts` | controller (CLI) | request-response | `summary` and `accept` commands | exact (self) |
| `extensions/cards.ts` | component (TUI board) | event-driven | `handleInput` key → `BoardAction`, `scenarioLines`, `verdictLines` causes block, footer/help | exact (self) |
| `extensions/agent-lab.ts` | controller (Pi tools + command loop) | event-driven / request-response | `agent_lab_accept`, `agent_lab_run`, `humanAnnotation` (select/editor), `/agent-lab` loop `run`/`verdict` branches | exact (self) |
| `test/judge.test.ts` | test | request-response | existing receipt tamper test (324-377), fidelity test (407-426) | exact |
| `test/comparison.test.ts`, `test/outcomes.test.ts` | test | transform | existing `cardVerdict`/`goalCardOutcome` tests | exact |
| `test/result-view.test.ts` | test | transform + CLI spawn | same file, 1-60 fixtures, 158+ CLI spawn | exact |
| `test/quality.test.ts` | test | transform | same file, causes tests 179-240 | exact |
| `test/experiment.test.ts` | test | CRUD | accept tests 600-660 | exact |
| `test/evaluation.test.ts` | test | request-response | receipt tests from 01-06 | exact |
| `test/store.test.ts` | test | file-I/O | receipt/sidecar tests from 01-04 | exact |
| `test/extension.test.ts` | test | event-driven | accept tool test 318-366; validation-set run test ~80-133 | exact |
| `test/cards.test.ts` | test | event-driven | keyboard test 161-183 | exact |

Not modified: `src/pi.ts` (`evaluatorVersion` at `src/pi.ts:77-78` already folds in `JUDGE_PROTOCOL`), `src/prompts.ts` (`SIMULATOR_ROLE` and `ASSESS_ROLE` stay byte-identical).

---

## Pattern Assignments

### `src/explain.ts` (NEW; utility, transform)

**Analog A:** `src/result-view.ts` (the pure-module header and the import rule)

Module header and import rule (`src/result-view.ts:1-12`, may shift; re-read):
```typescript
import type { Experiment, Scenario, ValidationExclusion } from './contracts.js';
import { observedRecord } from './outcomes.js';
import { cardVerdict, judgeModel, NOT_MEASURED_CODES, ... } from './comparison.js';

/*
 * ... Pure: no I/O, no escaping (each surface escapes at its own boundary). Cards are decided by
 * cardVerdict in comparison.ts; this module only counts and words them. It must not import
 * quality.ts or experiment.ts, so quality.ts can reuse pluralForm without a cycle.
 */
```
Copy this header style. `explain.ts` may import only `./contracts.js`, `./outcomes.js`, `./comparison.js`.

**Import graph constraint (must resolve in the plan):** `result-view.ts` will import `explain.ts`, and `quality.ts` already imports `result-view.ts` (`src/quality.ts:5`) and `experiment.ts` (`src/quality.ts:6`). So `explain.ts` must **not** import `result-view.ts`, `quality.ts` or `experiment.ts`. But UI-SPEC requires `pluralForm` (`src/result-view.ts:28-31`) for «и ещё K правило/правила/правил». Recommended fix: move `pluralForm` into a new leaf (e.g. `src/plural.ts`, no imports) and re-export it from `result-view.ts` (`export { pluralForm } from './plural.js';`), so `quality.ts:5` and the tests keep working. The other option is to copy the three-line body into `explain.ts`, which duplicates code.

**Analog B:** `src/quality.ts` `groundedScore` (the requirement → source → verbatim quote → assessment → event chain), `src/quality.ts:302-322`:
```typescript
const requirement = record.requirements.find(item => item.id === scenario.requirementIds[0]);
const source = requirement && record.sources.find(item => item.id === requirement.sourceId);
const quote = source && requirement ? verbatimSpan(source.content, requirement.quote) : undefined;
if (!requirement || !source || !quote) return;
...
const event = assessment.evidence.map(seq => trial.events.find(item => item.seq === seq))
  .find((item): item is TraceEvent => !!item && item.type !== 'user' && item.type !== 'simulator' && !!assessmentEventContent(item).trim());
```
For Y, use `assessment.citations` (`{ seq, quote }`, schema at `src/contracts.ts:229`, may shift) instead of `evidence`. Keep only citations whose event has `type === 'assistant'`. Re-verify with `event.text?.includes(quote)`.

**Analog C:** `src/quality.ts` `testPlanLines` requirement row (`src/quality.ts:115-120`). This is today's `requirement → source name → «quote»` rendering; F1/F5 rule rows replace the `[id]` slug with the register number:
```typescript
const requirements = scenario.requirementIds.map(id => {
  const requirement = record.requirements.find(item => item.id === id);
  if (!requirement) return `- [${id}]`;
  const source = record.sources.find(item => item.id === requirement.sourceId);
  return `- [${id}] ${requirement.text}${source ? ` · ${source.name}: «${requirement.quote}»` : ''}`;
});
```

**Verbatim check helper to reuse** (`src/contracts.ts:939-951`, may shift): `verbatimSpan(content, quote): string | undefined`. It returns the span *as written in the source*. For the offset, use `source.content.indexOf(span)`, as in RESEARCH Pattern 2.

**Prompt-rule filter to reuse** (`src/judge.ts:37`). Use the same `MACHINE_FORMAT` filter as the judge (`MACHINE_FORMAT` is exported from `src/contracts.ts:799`), but never the judge's `i + 1` numbering:
```typescript
const rules = requirements.filter(r => r.sourceId === source.id && !MACHINE_FORMAT.test(r.quote)).map((r, i) => `${i + 1}. «${r.quote}»`);
```

**Failed-card selection to reuse:** `cardVerdict(record, scenario).outcome === 'fail'` (`src/comparison.ts:571`, may shift). Use `agentMetricResult(trial, metricId, record.humanReviews)` (`src/outcomes.ts:35-38`) to tell a goal failure from a prompt-compliance-only failure (UI-SPEC D-16).

**Rationale prefixes** (for Pattern 3 span extraction, strip the agreed prefix first): `AGREED_RATIONALE_PREFIX` at `src/judge.ts:24`. Importing `judge.ts` from `explain.ts` is cycle-free (`comparison.ts:1` already does it).

**Row shape** (UI-SPEC «Recommended row shape»): return `{ role, indent, text }[]` and derive `lines` from it. This matches the board `Line` model (`extensions/cards.ts:65`: `type Line = { text: string; color?: ThemeColor; bold?: boolean }`), where one color applies per row.

**No truncation:** do not use `shorten` (`src/quality.ts:424-429`) or `preview` (`src/quality.ts:299`).

---

### `test/explain.test.ts` (NEW; test)

**Analog:** `test/result-view.test.ts:1-60` (may shift; re-read)

Imports and fixture builders to copy:
```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyUsage, goalAttainment, replyQuality, settingsSchema, simulatorFidelity, type Experiment, type MetricAssessment, type Trial } from '../src/contracts.js';

const world = { records: {}, writableFields: [], transientFailures: 0 };
function card(id: string, overrides: Partial<Card> = {}): Card { return { id, familyId: id, title: `Ситуация ${id}`, requirementIds: [], provenance: 'production', tier: 'regression', goalObservation: 'reply', user: {...}, initialState: world, checks: [], metrics: [{ ...goalAttainment }, { ...replyQuality }, { ...simulatorFidelity }], split: 'dev', ...overrides }; }
function attempt(scenarioId, { goal, fidelity, ...overrides }): Trial { ... events: [{ seq: 0, type: 'user' }, { seq: 1, type: 'assistant', text: 'Ответ агента' }, { seq: 2, type: 'simulator', ... }] ... }
function run(cards, trials, overrides = {}): Experiment { ... sources: [], requirements: [], ... }
```
Extend `run` with `sources` and `requirements`: two one-line knowledge sources plus one multi-line `kind: 'prompt'` source, with requirements in shuffled order (RESEARCH «Wave 0 Gaps»). Add `citations: [{ seq: 1, quote: 'Ответ' }]` to the goal vote. The `vote()` helper at `test/result-view.test.ts:25-26` sets only `evidence`.

Tamper style to copy: the table-driven mutation loop at `test/judge.test.ts:336-352` (`[name, mutate][]` → `structuredClone` → assert). Use it for «tampered quote / unknown requirement → объяснение не подтверждено цитатой».

Jargon backstop (UI-SPEC «UI Considerations»): add one assertion that joined output does not match `/goal_attainment|prompt_compliance|user_fidelity|unknown|рубрик|протокол|кластер|метрик|judge|seq|…/`.

Run with: `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh test/explain.test.ts`.

---

### `.planning/phases/02-sudya-obyasnyaet-provaly/measure-undecided.mjs` (NEW; read-only script)

**Analog:** `.planning/phases/01-odno-chestnoe-chislo/verify-stored-runs.mjs` (git-tracked, 62 lines)

Header, args and dist loading (lines 1-21):
```javascript
#!/usr/bin/env node
// Read-only counts over stored pilot runs through a built dist/. Prints ids and numbers only:
// stored runs hold bank dialogues, so no card names, dialogue turns or judge wording leave this script.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const { values } = parseArgs({ options: {
  dist: { type: 'string', default: resolve(repo, 'dist') },
  data: { type: 'string', default: resolve(repo, '.agent-lab') },
  ...
} });
const load = name => import(pathToFileURL(resolve(values.dist, name)).href);
const [{ ExperimentStore }, { buildResultView }, { hasCompleteJudgment, observableSources }, { measured }] =
  await Promise.all(['store.js', 'result-view.js', 'judge.js', 'outcomes.js'].map(load));
```
Per-run output line (lines 47-49). It prints only ids, counts and codes:
```javascript
const reasons = view.notMeasured.reasons.map(item => `${item.code}:${item.count}`).join(',') || '-';
console.log(`${id.slice(0, 8)} cards=${view.cards.length} passed=${view.headline.passed} decided=${view.headline.decided} notMeasured=${view.notMeasured.total} reasons=${reasons} ...`);
```
Fidelity votes for records that have no inline `judgeAudit`: use `store.readJudgeAudit(id, trialId)` (`src/store.ts:160`; lock-free, `null` if missing). `--cards` takes scenario-id prefixes (print `scenarioId.slice(0, 8)` only). `--explain` prints `X=ok Y=ok N=2+K prompt=ok|-` per failed card, with no text.

---

### `src/judge.ts` (MODIFIED; protocol v11)

**Analog:** itself. Anchors are current and stable (phase-1 pending plans do not touch this file).

**Protocol constant to freeze as V10** (`src/judge.ts:20`). Keep the object byte-for-byte and rename it `JUDGE_PROTOCOL_V10`, then add a v11 object:
```typescript
export const JUDGE_PROTOCOL = fingerprint({ version: 10, promptSources: 'observable-rules', ragEvidence: 'adapter-reported-retrieval-events', goalObservation: 'owner-selected-cited-channel', unobservedActions: 'deterministic-unknown', prompt: JUDGE_PROMPT, responseFormat: JUDGE_RESPONSE_FORMAT, applicability: 'reactive-actor-was-called', repeatsPerMetric: 2, aggregation: 'per-metric-unanimous-exclusive-conditions', repair: false, temperature: '0 for non-reasoning models; otherwise default', thinking: 'medium for reasoning models; otherwise off', maxTokens: 16384 });
```
Do not touch `responseSchema` / `JUDGE_PROMPT` / `JUDGE_RESPONSE_FORMAT` (`src/judge.ts:5-19`): `responseSchema` derives from `metricAssessmentSchema`.

**Protocol wrapping helper to generalize** (`src/judge.ts:113-114`):
```typescript
const expectedProtocol = (configurationHash: string | undefined) => configurationHash
  ? fingerprint({ protocol: JUDGE_PROTOCOL, configuration: configurationHash }) : JUDGE_PROTOCOL;
```
Make it `(protocol, configurationHash)` and accept either `JUDGE_PROTOCOL_V10` or `JUDGE_PROTOCOL`. The writer at `src/judge.ts:199` duplicates this wrapping inline; route it through the helper.

**Judge input scope sentence** goes into `evaluationScope` (`src/judge.ts:46-63`), never into `JUDGE_PROMPT`:
```typescript
const scope = input.trial.userMode === 'static'
  ? 'Opening and first answer ONLY. ...'
  : 'Evaluate only delivered requests, within the rubric stage.';
return { ..., evaluationScope: observationMissing ? `${scope} Agent prose proves only ...` : scope, ... };
```
`judgeInput` currently has no cut parameter. Add an optional `cut?: number` to its input, or derive it from a prefix-trial marker. Whichever is chosen must be applied identically by the writer (`assessRepeated`) and the verifier (`hasCompleteJudgment`).

**Citation bound that rejects post-cut events** (already present, `src/judge.ts:71-75`):
```typescript
const events = new Set(input.trial.events.map(e => e.seq));
...
if (row.evidence.some(seq => !events.has(seq))) throw new Error(`Assessment ${row.metricId} cites a nonexistent trace event`);
```
Passing `{ ...input, trial: prefixTrial(trial, cut) }` to `parseJudgment` is enough.

**Worker pool to split into two stages** (`src/judge.ts:209-248`):
```typescript
const jobs = applicable.flatMap(metric => [metric, metric]);
let next = 0;
let failure: unknown;
const worker = async (): Promise<void> => {
  while (next < jobs.length && failure === undefined) {
    const metric = jobs[next++]!;
    ...
    const attempt = { metricId: metric.id, startedAt: new Date().toISOString(),
      input: JSON.stringify(judgeInput({ ...input, scenario: { ...input.scenario, metrics: [metric] } })) };
    audit.attempts.push(attempt);
    save();
    try { attempt.raw = await respond(JUDGE_PROMPT, attempt.input!, raw => { attempt.raw = raw; save(); }); }
    catch (error) { attempt.error = ...; save(); if (!RAG_METRIC_IDS.has(metric.id)) failure ??= error; continue; }
    save();
    try { attempt.assessments = parseJudgment(attempt.raw, input, [metric]); } catch (error) { attempt.error = ...; }
    save();
  }
};
const settled = await Promise.allSettled(Array.from({ length: Math.min(JUDGE_CONCURRENCY, jobs.length) }, () => worker().catch(...)));
```
Stage 1 runs this loop over the `user_fidelity` jobs only (when applicable). Stage 2 starts only after stage 1 settled without `failure` and has no non-RAG `attempt.error` (Pitfall 5). It then computes `cut = simulatorCut(stage1 assessments, input.trial.events)` and runs the same loop over the remaining jobs with `input` swapped for the prefix input. Keep the single final `save(true)` and the throw order (`src/judge.ts:241-248`). The audit order stays deterministic: the fidelity attempts come first.

**Vote aggregation to keep unchanged** (`src/judge.ts:116-121`, `recordedAggregate`) and the final mapping (`src/judge.ts:249-258`).

**Full-audit verifier to branch by version** (`src/judge.ts:162-188`). The per-attempt input check is the line to parameterize:
```typescript
if (isolated && (requested.length !== 1 || !attempt.input
  || fingerprint(JSON.parse(attempt.input)) !== fingerprint(judgeInput({ ...input, scenario: { ...input.scenario, metrics: requested } })))) return false;
if (fingerprint(parseJudgment(attempt.raw, input, requested)) !== fingerprint(attempt.assessments)) return false;
```
For v11, non-fidelity attempts use `{ ...input, trial: prefixTrial(input.trial, cut) }` in both calls. `cut` is recomputed from the parsed fidelity attempts, and `input.trial.judgedBeforeSeq === cut` is required. `audit.inputHash` (`src/judge.ts:172-173`) stays the full-trial fingerprint.

**Receipt verifier** (`src/judge.ts:150-159`, `hasCompleteReceipt`). Add the version check and the `cutBefore` check next to the existing checks:
```typescript
if (receipt.protocolHash !== expectedProtocol(receipt.configurationHash)) return false;
...
if (receipt.votes.some(v => v.error) || receipt.votes.length !== applicable.length * 2) return false;
```
**Receipt writer** (`src/judge.ts:127-144`, `sealJudgeReceipt`). Add `...(cut !== undefined ? { cutBefore: cut } : {})` next to the conditional `configurationHash`/`transport` spreads. The cut is computed from `audit.attempts` with `simulatorCut`.

**New pure helpers** `simulatorCut` / `prefixTrial`: the code is given in RESEARCH «Code Examples». Place them after `judgeInput` and before `parseJudgment`, so the writer and the verifier share them. Follow the doc-comment style of `observableSources` (`src/judge.ts:29-33`).

---

### `src/contracts.ts` (MODIFIED; may shift, re-read; 01-09 edits this file)

**Analog for an optional trial field** (01-04): the `Trial` interface at `src/contracts.ts:566-574` and `trialSchema` at `src/contracts.ts:765-786`:
```typescript
assessments?: MetricAssessment[]; assessmentError?: string; judgeAudit?: JudgeAudit; judgeReceipt?: JudgeReceipt;
...
  judgeAudit: judgeAuditSchema.optional(),
  judgeReceipt: judgeReceiptSchema.optional(),
});
```
Add `judgedBeforeSeq?: number` / `judgedBeforeSeq: z.number().int().nonnegative().optional()` here. **Not** on `metricAssessmentSchema` (`src/contracts.ts:225-230`, Pitfall 1).

**Analog for the receipt field:** `judgeReceiptSchema` at `src/contracts.ts:256-264`. Add `cutBefore: z.number().int().nonnegative().optional()`.

**Analog for a record-level marker:** 01-09's `positiveControlScenarioIds` (`01-09-PLAN.md:128`). It sits next to `selectedScenarioIds` in `Experiment` (`src/contracts.ts:752`) and in `experimentSchema` (`src/contracts.ts:851`), is added as `z.array(identifier)...refine(unique, ...).optional()`, and has a `superRefine` membership issue. Copy that for `ownerExpectationScenarioIds` (max 40 per RESEARCH V5). Place it after 01-09 lands to avoid a merge conflict on the same lines.

**Helpers used downstream:** `verbatimSpan` (`src/contracts.ts:939`), `fingerprint` (`src/contracts.ts:952`; drops `undefined` keys, so old `draftHash` values are unchanged), `MACHINE_FORMAT` (`src/contracts.ts:799`), `metricApplies` (`src/contracts.ts:233-237`).

---

### `src/evaluation.ts` (MODIFIED)

**Analog:** `assessTrial` (`src/evaluation.ts:291-312`), where 01-06 seals the receipt from the latest audit:
```typescript
if (latest) {
  const complete = hasCompleteJudgment({ scenario, sources: observableSources(sources, requirements), trial: { ...trial, judgeAudit: latest, assessments: mapped } });
  trial.judgeReceipt = sealJudgeReceipt(latest, complete);
}
return mapped;
```
Set `trial.judgedBeforeSeq = simulatorCut(...)` (or delete it when the cut is undefined) **before** computing `complete`, and pass it in the spread `trial`. Otherwise the v11 verifier's `judgedBeforeSeq === cut` check fails at seal time.

---

### `src/outcomes.ts` (MODIFIED; counting `goal-v2`)

**Analog:** `simulatorUsable` (`src/outcomes.ts:62-71`):
```typescript
export function simulatorUsable(scenario: Scenario | undefined, trial: Trial, reviews: HumanReview[] = []): boolean {
  const latest = latestHumanReviews({ trials: [trial], humanReviews: reviews });
  return (simulatorWasUsed(trial) ? trial.simulatorChecks ?? [] : []).every(c => {
    const review = latest.get(`${trial.id}|check:${c.id}`);
    return review?.verdict === 'invalid' || (review ? review.verdict === 'pass' : c.passed);
  }) && (scenario?.metrics ?? []).filter(m => m.subject === 'simulator' && metricApplies(m, trial)).every(m => { ... === 'pass' });
}
```
Add an options bag `{ beforeSeq?: number }`. With `beforeSeq`, skip the fidelity-rubric clause unless a human review exists on it (human reviews keep precedence), and ignore heuristic checks with `c.seq !== undefined && c.seq >= beforeSeq`.
`measurementUsable` (`src/outcomes.ts:73-79`) gets the same pass-through option. **Only** the goal path passes it. `automaticTrialResult` and `isAgentFailure` stay strict.

---

### `src/comparison.ts` (MODIFIED; may shift, re-read; 01-07 edits this file)

**Goal outcome** (`src/comparison.ts:504-517`). The `measurementUsable` call inside the big condition is the one to give `{ beforeSeq: trial.judgedBeforeSeq }`:
```typescript
|| !measurementUsable(scenario, trial, record.humanReviews))) return 'unknown';
```
**Reason codes** (`src/comparison.ts:535-568`, `trialReasons`). The simulator block mirrors `simulatorUsable` and must mirror the cut too:
```typescript
// Mirrors simulatorUsable: a human verdict overrides the check or the fidelity vote.
const checksDeviate = (simulatorWasUsed(trial) ? trial.simulatorChecks ?? [] : []).some(c => { ... });
const fidelity = (scenario.metrics ?? []).filter(m => m.subject === 'simulator' && metricApplies(m, trial)).flatMap(m => { ... });
if (checksDeviate || fidelity.includes('fail')) codes.push('simulator_deviated');
if (fidelity.some(result => result !== 'pass' && result !== 'fail')) codes.push('simulator_unclear');
```
**Split/no-evidence matching** (`src/comparison.ts:563-566`) is reused as is for JUDGE-02:
```typescript
else if (assessment.rationale.startsWith(SPLIT_RATIONALE_PREFIX)) codes.push('judge_split');
else if (assessment.rationale.includes(GOAL_UNSUPPORTED_RATIONALE)) codes.push('no_evidence');
```
**Stability across protocols** (`src/comparison.ts:633`). The gate on `evaluatorVersion` already exists; only the wording changes, to UI-SPEC C-50:
```typescript
if (record.evaluatorVersion !== source.evaluatorVersion) return { ...result, skipped: 'судья или его настройки изменились' };
```
`stabilityLine` (`src/result-view.ts:155-158`) prints it as `Стабильность не проверена: <skipped>.`.

---

### `src/result-view.ts` (MODIFIED; may shift, re-read; 01-09 edits this file)

**Counting rules constant** (`src/result-view.ts:12`): `export const COUNTING_RULES = 'goal-v1';` → `'goal-v2'`.

**View interface to extend** (`src/result-view.ts:72-86`). Add `failures: FailureExplanation[]` and `topCauses: { name; count; example: FailureExplanation | null }[]` beside `cards` and `stability`. Follow the existing optional-field style: `...(stability ? { stability } : {})` (`src/result-view.ts:148`).

**Per-card loop to reuse** (`src/result-view.ts:99-103`); `failureExplanation(record, scenario)` is called for `verdict.outcome === 'fail'` here:
```typescript
const cards: ResultView['cards'] = record.scenarios.map(scenario => {
  const verdict = cardVerdict(record, scenario);
  return { scenarioId: scenario.id, title: scenario.title, outcome: verdict.outcome, ...(verdict.reason ? { reason: verdict.reason } : {}), ... };
});
```
**Reason groups for F3** already carry `scenarioIds` in the right order (`src/result-view.ts:111-116`):
```typescript
const reasons = notStarted ? [] : NOT_MEASURED_CODES.filter(code => code !== 'in_progress').map(code => {
  const scenarioIds = cards.filter(card => card.outcome === 'unknown' && card.reason === code).map(card => card.scenarioId);
  return { code, label: NOT_MEASURED_TEXT[code], count: scenarioIds.length, scenarioIds };
}).filter(reason => reason.count > 0).sort((a, b) => b.count - a.count);
```
**Lines function to extend** (`src/result-view.ts:161-182`). The `options.details` pattern shows the place for the per-situation `? <title> — <label>` rows (F3):
```typescript
if (options.details && notMeasured.reasons.length > 1) {
  lines.push('Не измерено по причинам:', ...notMeasured.reasons.map(reason => `  ${reason.label} — ${reason.count}`));
}
```
UI-SPEC F3 puts the `?` rows directly under the summary row on every surface. Add them as a new exported function (e.g. `notMeasuredLines(view)`) or a new option, so the phase-1 block equality check (`pi-surface-check.mts`, 01-02) stays valid. Update it deliberately if the block changes.

Reason labels stay verbatim (`src/result-view.ts:33-52`): `judge_split: 'судья не уверен: голоса разошлись'`, `no_evidence: 'нет доказательства в ответе'`.

---

### `src/quality.ts` (MODIFIED)

**Analog for `expectationSheet`:** `testPlanLines` (`src/quality.ts:101-179`). Copy its guards, hash and footer:
```typescript
export function testPlanLines(record: Experiment): TestPlanLines {
  if (record.workflow !== 'evaluate') throw new Error('Показать для принятия можно только тест workflow evaluate.');
  if (record.phase !== 'review') throw new Error('Показать для принятия можно только незапущенный черновик.');
  if (record.scenarios.length !== 1) throw new Error('Для принятия нужен ровно один тест.');
  ...
  const hash = draftHash(record);
  ...
  return { draftHash: hash, lines: [ ..., `Версия: ${hash.slice(0, 12)}`, '', 'Этот тест действительно проверяет нужное поведение?' ] };
}
```
`expectationSheet` returns `{ draftHash, lines, rows, cards }` per UI-SPEC F5, with footer `Версия ожиданий: <hash12>`. Keep `testPlanLines` unchanged for the one-card path (extension test 318-366 depends on it).
Multi-line text normalization helper already here: `planText` (`src/quality.ts:93-94`). UI-SPEC wants whitespace inside quotes collapsed to one space for display only.

**Causes to rewire** (`src/quality.ts:443-459`), the `example` built from `firstReason`:
```typescript
return first ? [{ name: mode.name, description: mode.description, stage: mode.stage, dialogues: trials.length, promptQuotes: mode.promptQuotes ?? [],
  example: { trialId: first.id, card: title(first), ...firstReason(record, first) } }] : [];
```
Replace `...firstReason(...)` with the explanation from `explain.ts` for goal failures. Note that `firstReason` (`src/quality.ts:431-441`) quotes a **failed exact check first**, and `test/quality.test.ts:189` asserts that («a failed exact check is quoted before the judge»). Decide in the plan whether check-failed legacy cards keep that path or get an F1 variant, and update `test/quality.test.ts:187-196, 220, 238-240, 535` together.

**Causes line to replace** (`src/quality.ts:548`), the clipped one-liner that UI-SPEC F2 removes:
```typescript
causes: q.causes.slice(0, 3).map((c, i) => `${i + 1}. ${c.name} — ${dialogues(c.dialogues)}${c.example ? `. ${c.example.card}: «${c.example.quote}»` : ''}${c.promptQuotes[0] ? ` · правило промпта: «${c.promptQuotes[0]}»` : ''}`),
```
F2 counts situations (`pluralForm(n, ['ситуация', 'ситуации', 'ситуаций'])`), not dialogues.

---

### `src/experiment.ts` (MODIFIED; may shift, re-read; 01-09 edits this file)

**`acceptDraft` → N cards** (`src/experiment.ts:710-726`):
```typescript
if (record.scenarios.length !== 1) throw new Error('Принять можно ровно один тест.');
const currentHash = draftHash(record);
if (expectedHash !== currentHash) throw new Error('Черновик изменился. Откройте тест заново, прежде чем принимать.');
const scenario = record.scenarios[0]!;
const definitionHash = fingerprint(scenario);
const existing = (record.acceptedTests ?? []).find(test => test.scenarioId === scenario.id && test.definitionHash === definitionHash);
if (record.acceptedDraftHash === currentHash && existing) return structuredClone(record);
record.acceptedTests = [existing ?? { testId: randomUUID(), scenarioId: scenario.id, definitionHash, acceptedAt: new Date().toISOString() }];
record.acceptedDraftHash = currentHash;
await this.store.save(record);
```
Map over all scenarios with the same `existing ?? new` rule. The idempotency check becomes «every scenario has a matching entry». Tests `test/experiment.test.ts:644, 649` match `/ровно один/`; change the message and the tests together (the zero-card case stays rejected, the two-card case becomes accepted).

**`setExpectation`**: copy the `change()` wrapper and the draft guards from `updateDraft` (`src/experiment.ts:660-664`):
```typescript
return this.change(async () => {
  const record = await this.store.get(id);
  if (record.phase !== 'review') throw new Error('Править можно только незапущенный черновик. ...');
  if (draftHash(record) !== expectedHash) throw new Error('Черновик изменился. Откройте карточки заново, прежде чем править.');
```
Then reuse the tail of `updateDraft` (`src/experiment.ts:689-704`: `validatePreparation` → `retainAcceptedTests` → `evaluatorVersion` → `reviewedAt/reviewMode/manifestHash = null` → `checkpoint`) through a small private helper, as RESEARCH Pattern 7 says. Supporting fact: confirmed validate cards must keep `metrics[0].passCriteria === successCriteria` (`src/pi.ts:68-70`), so setting both fields to the owner text keeps that invariant.

**Guard relaxation** (`src/experiment.ts:672-675`):
```typescript
if (before && scenario.successCriteria !== before.successCriteria
  && fingerprint([scenario.checks, scenario.metrics ?? []]) === fingerprint([before.checks, before.metrics ?? []])) {
  throw new Error(`Ожидание «${scenario.title}» изменилось, а исполняемые проверки остались прежними. ...`);
}
```
Skip it when `before.metrics?.some(m => m.subject === 'agent' && m.id === 'goal_attainment')`.

**`draftHash`** (`src/experiment.ts:35-41`). Add `ownerExpectationScenarioIds: record.ownerExpectationScenarioIds` to the fingerprinted object (an `undefined` key is dropped). Keep it out of `measurementHash` (`src/experiment.ts:45-49`). `freshDraft` (`src/experiment.ts:62-83`) keeps it through `structuredClone`. Add filtering when `scenarioIds` is given, next to `record.scenarios = record.scenarios.filter(...)` (line 67).

**`start({ requireAccepted })`** (`src/experiment.ts:880-910`). Copy the style of the existing hash guard:
```typescript
if (record.workflow === 'evaluate' && options.expectedHash !== draftHash(record)) {
  throw new Error('Нужно подтверждение именно этой версии черновика. Откройте свежие тесты и план запуска.');
}
```
Add: `if (options.requireAccepted && record.acceptedDraftHash !== draftHash(record)) throw new Error('Сначала подтвердите ожидания ситуаций: они изменились или ещё не подтверждены.');`. The honest v10→v11 rejection is already at `src/experiment.ts:897`.

**`reassess`** (`src/experiment.ts:811`). Extend the existing delete list:
```typescript
trial.usage = emptyUsage(); delete trial.externalUsage; delete trial.assessments; delete trial.assessmentError; delete trial.judgeAudit; delete trial.judgeReceipt;
```
with `delete trial.judgedBeforeSeq;`.

---

### `src/cli.ts` (MODIFIED; may shift, re-read; 01-08 and 01-09 edit this file)

**`summary`** (`src/cli.ts:89-108`). Copy the escape-and-join style; insert F3 after the block and F2/F4 in place of `Почему:`:
```typescript
process.stdout.write([...resultViewLines(view, { details: true }).map(safeLine), '', 'Подробности:', ...text.metrics, '',
  ...(text.causes.length ? ['Почему:', ...text.causes, ''] : []), ...(text.rag.length ? [...text.rag, ''] : []), text.queue, '', text.scope, text.limits, ''].join('\n'));
```
`safeLine` (`src/cli.ts:25`) collapses newlines. Apply it to each explanation row, not to the joined block.

**`accept`** (`src/cli.ts:272-289`). Branch on `record.scenarios.length > 1`: print `expectationSheet(record).lines`, then C-47 (`Подтвердить все ожидания: agent-lab accept --id <RUN> --yes`), or C-48 after `--yes`. Keep the `values.json` envelope shape (`type: 'test_proposal' | 'next_step' | 'accepted'`) and the one-card path unchanged.

**`reassess`** (`src/cli.ts:332-342`) stays unchanged; the live plan uses it as is.

---

### `extensions/cards.ts` (MODIFIED; board)

**BoardAction union** (`extensions/cards.ts:39-46`). Add two variants in the same style:
```typescript
| { type: 'verdict'; verdict: 'pass' | 'fail'; record: Experiment; section: Section; selected: number; query?: string; pendingOnly?: boolean; trialId?: string; reviewMs?: number };
```
The new variants are `{ type: 'accept'; ...state }` and `{ type: 'expect'; scenarioId: string; ...state }`.

**Key handling** (`extensions/cards.ts:369-386`). `editable` and the key→type mapping already exist:
```typescript
const editable = this.record.workflow === 'evaluate' && this.record.phase === 'review';
...
const type = key('r') && editable && !this.record.questions.length ? 'run'
  : key('r') && finished ? 'repeat'
  ...
if (type) return this.finish({ type, ...state });
```
Add `y`/`e` scoped to `editable && this.section === 'cards' && !this.record.questions.length`. Searching and help are already intercepted earlier (lines 347-353, 361). For `e`, take `scenarioId` from `entry.id` (`entries()` at line 340 provides `id`).

**Sheet rendering** replaces the `cards` detail (`extensions/cards.ts:461-463`):
```typescript
} else if (this.section === 'cards') {
  const scenario = record.scenarios[entries[this.selected]?.index ?? -1];
  detail = scenario ? scenarioLines(scenario, record, this.expanded) : [line(...'Карточки появятся после подготовки.', 'muted')];
```
For `phase === 'review' && workflow === 'evaluate'` and not expanded, map `expectationSheet(record).rows` → `line(text, tokenFor(role), bold)`. `line()` (`extensions/cards.ts:66`) already applies `safeText`. Enter keeps `scenarioLines(…, true)`.

**Wrap step** (`extensions/cards.ts:498`). This is where the hanging indent helper goes:
```typescript
const content = detail.flatMap(row => wrapTextWithAnsi(row.text, inner).map(text => paint({ ...row, text })));
```
Continuation lines get `' '.repeat(indent + 2)`. The `Line` type needs an optional `indent` for this.

**Causes block to replace** (`extensions/cards.ts:203-209`), the clipped example and the `warning` name row:
```typescript
...(q.causes.length ? [line('ЧТО ТРЕБУЕТ ВНИМАНИЯ', 'accent'),
  ...q.causes.slice(0, 3).flatMap((c, i) => [
    line(`${i + 1}. ${c.name} — ${dlg(c.dialogues)}${c.stage ? ` · ${c.stage}` : ''}`, 'warning'),
    ...(c.example ? [line(`   ${c.example.card}: «${c.example.quote}»...`, 'muted')] : []),
    ...c.promptQuotes.slice(0, 1).map(quote => line(`   Правило промпта: «${quote}»`, 'muted')),
  ]), ...]
```
The expanded variant with raw rationale is at `extensions/cards.ts:231-238` (F4 «ВСЕ ПРОВАЛЫ» goes there).

**Header line** (`extensions/cards.ts:432`). Replace the review text `'Проверьте цель, первую реплику и критерии. r — запуск.'` with the C-31/C-32/C-33 states.
**Tab label** (`extensions/cards.ts:421`): `` `2 Карточки ${record.scenarios.length}` `` → `2 Ситуации N`.
**Notice kind** (`extensions/cards.ts:57, 434`). Today `kind: 'info' | 'error'` renders `info` as `success`. UI-SPEC distinguishes success and info notices (C-34 success, C-35 info), so widen the type if both are needed.
**Help** (`extensions/cards.ts:497`): add a row after `r — запустить…`. **Footer** (`extensions/cards.ts:501`): the review tier text, chosen by `inner` with `visibleWidth`.

---

### `extensions/agent-lab.ts` (MODIFIED; may shift, re-read; 01-08 and 01-09 edit this file)

**`runPlan` validation block** (`extensions/agent-lab.ts:48-56`). Replace it with the compact sheet (UI-SPEC D-04):
```typescript
const validation = record.scenarios.length > 1 && record.scenarios.every(scenario => scenario.provenance === 'production');
const scope = validation ? [
  `Validation set: ${record.scenarios.length} реальных диалогов.`, ...
  ...record.scenarios.map((scenario, i) => `${i + 1}. ${safeText(scenario.title)}\n  Ожидается: ... \n  Основание: ...`),
] : ...
```
`test/extension.test.ts:128-132` matches `Validation set:` / `Ожидается:` / `Основание:`; update it in the same task.

**`agent_lab_accept`** (`extensions/agent-lab.ts:490-517`). Keep the one-card path (lines 502-515) unchanged. Add the N-card native loop. The select/editor analog is `humanAnnotation` (`extensions/agent-lab.ts:~118-133`):
```typescript
const choice = await ctx.ui.select('Область вашей оценки', targets.map(t => t.label));
...
const note = await ctx.ui.editor('Пояснение · укажите реплики # и причину согласия или ошибки', '');
```
The tool keeps `parameters: { id }` only (the model never supplies text). Tool text returns the full F5 sheet (UI-SPEC S2 step 5).

**`agent_lab_run`** (`extensions/agent-lab.ts:533-571`). The confirm-then-start pair to extend:
```typescript
if (!await ctx.ui.confirm('Запустить проверку?', runPlan(draft))) { return { ... cancelled: true ... }; }
signal.throwIfAborted();
await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: params.expectedHash, parallel: runParallel(draft) });
```
When `draft.acceptedDraftHash !== draftHash(draft)`, use the C-39 title and C-40 body tail. On yes, call `lab.acceptDraft` then `lab.start({ ..., requireAccepted: true, reviewer: 'human' })`. The test at `test/extension.test.ts:~80-101` stubs `ExperimentLab.prototype.start`; also stub `acceptDraft` (Pitfall 7).

**`/agent-lab` loop** (`extensions/agent-lab.ts:706-845`). The `run` branch (lines ~790-797) is the template for the new `accept`/`expect` branches:
```typescript
} else if (action.type === 'run') {
  const r = action.record;
  if (r.workflow !== 'evaluate') throw new Error('Legacy comparison records cannot run from the evaluation board.');
  const hash = draftHash(r);
  if (await ctx.ui.confirm('Запустить проверку?', runPlan(r))) {
    await lab.start(r.id, { approved: true, reviewer: 'automated', expectedHash: hash, parallel: runParallel(r) }); section = 'results'; selected = 0;
    reportPath = undefined;
  }
}
```
Notices go through `inform(message, kind)` (lines ~727-729); errors are caught by the shared `catch (error) { inform(inputError(error), 'error'); }` (line ~837). The `discuss` branch (lines ~770-781) shows the `ctx.ui.editor(title, prefill)` + `if (!request?.trim()) continue;` cancel pattern for `expect`.

**`summary()` tool payload** (`extensions/agent-lab.ts:72-82`) carries `view` and `viewLines` (01-02). Add F3/F2 lines and the C-19 pointer here, so the collapsed tool render (`extensions/agent-lab.ts:25-39`) shows them.

---

### Tests (MODIFIED)

| Test file | Analog block to copy | What to add/change |
|-----------|---------------------|--------------------|
| `test/judge.test.ts` | Fixture 1-20 (`scenario`, `trial` with `userMode: 'static'`, `row()` helper); tamper table 324-377; fidelity test 407-426 | Reactive fixture with `simulator` events and a failing fidelity `row` citing a post-reply seq; `simulatorCut`/`prefixTrial` vectors; v10 fixture still `true`; v11 tamper (`judgedBeforeSeq`, `cutBefore`, prefix input) → `false`; freeze pins for `JUDGE_PROTOCOL_V10`, `fingerprint(JUDGE_PROMPT)`, `fingerprint(JUDGE_RESPONSE_FORMAT)`. **Update** 422: the request order becomes `[['user_fidelity'], ['user_fidelity'], ['goal'], ['goal']]` under fidelity-first. Also re-check 445-461 («votes requested at once, stable order») |
| `test/comparison.test.ts`, `test/outcomes.test.ts` | Existing `cardVerdict`/`simulatorUsable` cases | `goal-v2`: cut + fidelity fail → decided; heuristic check before the cut still blocks; no field → unchanged |
| `test/result-view.test.ts` | Fixtures 1-60; CLI spawn 158-175 (runs the built dist from a snapshot) | `COUNTING_RULES === 'goal-v2'`; F3 rows; `failures[]`/`topCauses[]`; CLI summary shows F1 lines |
| `test/quality.test.ts` | Causes tests 179-240, 535 | `expectationSheet` rows; causes example from `failureExplanation`; old clipped-quote assertions replaced |
| `test/experiment.test.ts` | Accept tests 600-660 (`setup(t, createDemoRuntime())`, `scenarioCount: 2`) | N-card accept + idempotency; `/ровно один/` expectations change; `setExpectation`; `start({ requireAccepted })`; `reassess` deletes `judgedBeforeSeq` |
| `test/evaluation.test.ts` | 01-06 receipt tests | `assessTrial` sets `judgedBeforeSeq` from the audit |
| `test/store.test.ts` | 01-04 sidecar/receipt tests | Receipt with `cutBefore` round-trips |
| `test/extension.test.ts` | Accept test 318-366 (`ctx.ui.confirm` stub); run test ~80-133 | N-card accept via `confirm`/`select`/`editor` stubs; run on an unaccepted draft accepts then starts; `runPlan` regexes updated |
| `test/cards.test.ts` | Keyboard test 161-183 (`new LabBoard({ record }, theme, a => actions.push(a), ...)`, `handleInput('r')`) | `y` → `{ type: 'accept' }`, `e` → `{ type: 'expect', scenarioId }` only in scope; blocked for compare/questions/complete (copy the loop at 176-182); render widths 36/56/76/106/156 with no row wider than the width and no `…` (copy `visibleWidth` use from imports line 3) |

---

## Shared Patterns

### Pure text, escaped at the surface
**Source:** `src/result-view.ts:5-11` (comment), `extensions/cards.ts:10-13` (`safeText`), `src/cli.ts:25` (`safeLine`)
**Apply to:** `explain.ts`, `expectationSheet`, all F1/F3/F5 rows
```typescript
export function safeText(value: unknown): string {
  return stripTerminalSequences(String(value ?? '')).replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}
```
Pure modules return raw text. S3 escapes via `line()` (`extensions/cards.ts:66`), S2 via `safeText`, and S1 via `safeLine`.

### Errors
**Source:** everywhere (`throw new Error('<Russian message with next step>')`), e.g. `src/experiment.ts:715, 885-888`
**Apply to:** `acceptDraft`, `setExpectation`, `start({ requireAccepted })`, CLI `accept`
No error classes. Messages say what is wrong and what to do. Tests match them with `assert.rejects(..., /regex/i)`.

### Writer-only mutations
**Source:** `ExperimentLab.change()` (`src/experiment.ts:246-251`), `this.checkpoint(record, 'review', message)` in `updateDraft`
**Apply to:** `acceptDraft(N)`, `setExpectation`
Every record write goes through `change()`, re-reads with `this.store.get(id)`, checks `draftHash(record) === expectedHash`, and returns `structuredClone(record)`.

### Human intent only from native UI
**Source:** `agent_lab_accept` (`extensions/agent-lab.ts:490-517`), `humanAnnotation` (`extensions/agent-lab.ts:~118-133`), board `finish()` (`extensions/cards.ts:325-329`)
**Apply to:** confirm-all, set-expectation, accept-and-start
Tool parameters carry ids only. The text comes from `ctx.ui.editor`, and consent comes from `ctx.ui.confirm` / `ctx.ui.select`. The board emits a `BoardAction` and disposes (so a second key press is ignored; `test/cards.test.ts:172-173`).

### Plurals
**Source:** `pluralForm` (`src/result-view.ts:28-31`; see the import-graph note under `src/explain.ts`)
**Apply to:** «и ещё K правило/правила/правил», «N ситуация/ситуации/ситуаций» (F2, F5, C-31, C-34, C-41, C-45, C-48)

### Version-aware verification
**Source:** `hasCompleteJudgment` / `hasCompleteReceipt` (`src/judge.ts:150-188`), `expectedProtocol` (`src/judge.ts:113-114`)
**Apply to:** judge v11, receipt `cutBefore`, freeze test
The verifier re-derives everything from the record, never trusts stored flags, and keeps the old version's path byte-identical.

### Snapshot tests and read-only live checks
**Source:** `.planning/phases/01-odno-chestnoe-chislo/snap-test.sh`, `verify-stored-runs.mjs`, `pi-surface-check.mts` (all git-tracked)
**Apply to:** every task's verification. Never run `npm test` / `npm run build` in the worktree. Scripts print ids, counts and hashes only.

---

## No Analog Found

Every file has an analog. Two design pieces have no in-repo precedent, so the planner should follow RESEARCH.md for them:

| Piece | File | Reason |
|-------|------|--------|
| Two-stage (fidelity-first) vote scheduling | `src/judge.ts` `assessRepeated` | Today there is one flat job queue; the staging and gating rules come from RESEARCH Pattern 4 and Pitfall 5 |
| Hanging-indent wrap helper | `extensions/cards.ts` | The board wraps flat today (`:498`); the rule comes from UI-SPEC «Width, Wrap and Theme Rules» |
| `live-check.mjs budget` | `.planning/phases/01-odno-chestnoe-chislo/live-check.mjs` | Not created yet (01-10). Verify its interface against `01-10-SUMMARY.md` when it lands; if 01-10 is late, copy its logic into a phase-02 script (RESEARCH «Environment Availability») |

## Metadata

**Analog search scope:** `src/`, `extensions/`, `test/`, `.planning/phases/01-odno-chestnoe-chislo/`
**Files scanned:** 22 (full reads: `src/judge.ts`, `src/outcomes.ts`, `src/result-view.ts`, `src/quality.ts`; targeted reads of `src/comparison.ts`, `src/contracts.ts`, `src/experiment.ts`, `src/evaluation.ts`, `src/pi.ts`, `src/cli.ts`, `src/store.ts`, `extensions/cards.ts`, `extensions/agent-lab.ts`, six test files, `verify-stored-runs.mjs`, phase-1 SUMMARY 01-01…01-06 and PLAN 01-07…01-10 frontmatter)
**Tracked-source gate:** all analog paths verified with `git ls-files` (`verify-stored-runs.mjs`, `snap-test.sh`, `pi-surface-check.mts` are tracked); no mirror paths.
**Data safety:** no `.agent-lab` content was read; this file has no dialogue text.
**Pattern extraction date:** 2026-09-17

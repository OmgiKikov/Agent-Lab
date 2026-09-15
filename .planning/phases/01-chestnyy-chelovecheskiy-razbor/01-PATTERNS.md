# Phase 1: Честный человеческий разбор - Pattern Map

**Mapped:** 2026-09-15
**Files analyzed:** 10 new/modified files
**Analogs found:** 10 / 10

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/outcomes.ts` | utility | transform | `src/outcomes.ts` (`simulatorUsable`, `measurementUsable`) | exact |
| `src/quality.ts` | service/presenter | transform | `src/quality.ts` (`metricRows`, `qualitySummary`, `qualityLines`) | exact |
| `src/comparison.ts` | service | transform | `src/comparison.ts` (`verdictSummary` rubric aggregation) | exact |
| `src/contracts.ts` | model/schema | transform | `src/contracts.ts` (`humanReviewInputSchema`, persisted review schema) | exact |
| `extensions/agent-lab.ts` | component/controller | request-response | `extensions/agent-lab.ts` (`humanAnnotation`, `agent_lab_review`) | exact |
| `test/outcomes.test.ts` | test | transform | `test/comparison.test.ts` (small typed records and human-review overrides) | role-match |
| `test/helpers/demo-record.ts` | test utility | file-I/O / request-response | `test/product-flow.test.ts` (temporary real `ExperimentLab` lifecycle) | exact |
| `test/quality.test.ts` | test | transform / file-I/O | `test/quality.test.ts` plus `test/product-flow.test.ts` | exact |
| `test/contracts.test.ts` | test | transform | `test/contracts.test.ts` (schema parse/throw assertions) | exact |
| `test/extension.test.ts` | test | request-response / file-I/O | `test/extension.test.ts` (`agent_lab_review` journey) | exact |

All named analogs were verified as git-tracked with `git ls-files`. No install/runtime mirror is used.

## Pattern Assignments

### `src/outcomes.ts` (utility, transform)

**Analog:** `src/outcomes.ts:23-32,53-69`

**Imports and latest-wins key pattern** (lines 1, 23-32):

```typescript
import { metricApplies, simulatorWasUsed, type Experiment, type HumanReview, type Scenario, type Trial } from './contracts.js';

export function latestHumanReviews(record: Pick<Experiment, 'trials' | 'humanReviews'>): Map<string, HumanReview> {
  const latest = new Map<string, HumanReview>();
  const trials = new Set(record.trials.map(t => t.id));
  for (const review of [...record.humanReviews].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (!trials.has(review.trialId)) continue;
    latest.set(`${review.trialId}|${review.metricId ? `metric:${review.metricId}` : review.checkId ? `check:${review.checkId}` : 'dialogue'}`, review);
  }
  return latest;
}
```

**Core override pattern** (lines 53-61):

```typescript
const latest = latestHumanReviews({ trials: [trial], humanReviews: reviews });
return (simulatorWasUsed(trial) ? trial.simulatorChecks ?? [] : []).every(c => {
  const review = latest.get(`${trial.id}|check:${c.id}`);
  return review ? review.verdict === 'pass' : c.passed;
}) && (scenario?.metrics ?? []).filter(m => m.subject === 'simulator' && metricApplies(m, trial)).every(m => {
  const review = latest.get(`${trial.id}|metric:${m.id}`);
  return (review?.verdict ?? trial.assessments?.find(a => a.metricId === m.id)?.result) === 'pass';
});
```

Copy this immutable-evidence rule into `agentRubricResult`: select the latest target review, drop `invalid`, otherwise prefer the human verdict over the stored assessment. Thread `record.humanReviews` through `isAgentFailure`, `automaticTrialResult`, and every caller that owns a record.

### `src/quality.ts` (service/presenter, transform)

**Analog:** `src/quality.ts:56-78,122-158,161-173`

**Aggregation pattern** (lines 56-78):

```typescript
const rows = new Map<string, QualityMetric>();
const bump = (row: QualityMetric, result: 'pass' | 'fail' | 'unknown') => {
  row.total++;
  if (result === 'pass') row.passed++;
  else if (result === 'fail') row.failed++;
  else row.unknown++;
};
// Only identical rubric definitions share a row.
const key = `rubric:${fingerprint(metric)}`;
```

Keep the existing row identity and `measurementUsable` gate. Add the latest metric verdict immediately before `bump`; `invalid` skips that metric occurrence rather than creating a new row or rewriting the trial.

**Single-derived-summary pattern** (lines 122-156):

```typescript
const record = observedRecord(input);
const v = verdictSummary(record);
const reviews = latestHumanReviews(record);
// ...derive all counters from record...
return { cards, metrics, causes: causes(record, v), judge: { ... }, humanQueue,
  scope: { ... }, cost: { ... }, limits, headline };
```

Derive `human.reviewed` from latest `${trial.id}|dialogue` entries with `reviewedDialogue === true`, and `human.total` from all current trials. Render the counter in the existing headline and render causes through the existing `qualityLines` queue string; no second summary model is needed.

### `src/comparison.ts` (service, transform)

**Analog:** `src/comparison.ts:455-478`

```typescript
for (const trial of completed) {
  const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
  if (scenario?.metrics?.some(m => m.subject === 'agent')) {
    rubric.assessed += 1;
    if (agentRubricResult(scenario, trial) === 'fail') rubric.failed += 1;
    else if (agentRubricResult(scenario, trial) !== 'pass') rubric.unknown += 1;
    else rubric.passed += 1;
  }
}
```

Preserve this aggregation shape and only pass `record.humanReviews` to both calls. This keeps the verdict, first screen, and comparison on the same outcome helper.

### `src/contracts.ts` (model/schema, transform)

**Analog:** `src/contracts.ts:461-467,581-587`

**Input validation pattern** (lines 461-467):

```typescript
export const humanReviewInputSchema = z.strictObject({
  trialId: identifier, metricId: identifier.optional(), checkId: identifier.optional(),
  verdict: z.enum(['pass', 'fail', 'unknown', 'invalid']), note: text.max(3000),
  durationMs: z.number().int().nonnegative().max(3600000).optional(),
}).refine(v => !(v.metricId && v.checkId), 'Review either one metric, one check, or the whole trial');
export type HumanReviewInput = z.infer<typeof humanReviewInputSchema>;
```

Add `reviewedDialogue: z.literal(true).optional()` and chain the whole-dialogue-only refinement. Keep it optional: legacy records must parse without a migration.

**Persistence compatibility pattern** (lines 581-587): the persisted inline `humanReviews` object mirrors every input field and defaults the array to `[]`. Add the same optional literal there; do not introduce a default value.

### `extensions/agent-lab.ts` (component/controller, request-response)

**Analog:** `extensions/agent-lab.ts:85-126,406-432`

**Native form pattern** (lines 85-115):

```typescript
const trial = reviewOrder(record)[selected];
if (!trial) return;
const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
const targets = [
  { label: 'Весь диалог', ids: {} },
  ...(scenario?.metrics ?? []).map(m => ({ label: `Критерий · ${safeText(m.name)} [${m.id}]`, ids: { metricId: m.id } })),
  ...(trial.simulatorChecks ?? []).map(c => ({ label: `Симулятор · ${safeText(c.description)} [${c.id}]`, ids: { checkId: c.id } })),
  ...trial.checks.map(c => ({ label: `Проверка · ${safeText(c.description)} [${c.id}]`, ids: { checkId: c.id } })),
];
const choice = await ctx.ui.select('Область вашей оценки', targets.map(t => t.label));
```

The excerpt shows the intended minimal target list after removing the current `failedCriteria`/`similar` fan-out. Return exactly one input for `trial.id`; add `reviewedDialogue: true` only when both target ids are absent. Keep `safeText`, native `select`/`editor`, cancellation by `undefined`, the one-hour duration cap, and the current `lab.addHumanReview` persistence boundary.

### `test/outcomes.test.ts` (test, transform)

**Analog:** `test/comparison.test.ts:41-47,565-589`

```typescript
const review = (id: string, trialId: string, verdict: HumanReview['verdict'],
  target: { metricId?: string; checkId?: string } = {}, createdAt = '2026-09-08T00:00:00Z'): HumanReview =>
  ({ id, trialId, verdict, note: 'n', createdAt, ...target });

test('human findings surface missed failures and false alarms without rewriting automatic evidence', () => {
  const measured = JSON.stringify(r.trials);
  // mutate only humanReviews, then assert results and unchanged trials
  assert.equal(JSON.stringify(r.trials), measured);
});
```

Use local typed builders, fixed timestamps, and table-like assertions for `invalid/pass/fail/unknown` plus latest timestamp wins. No fixture framework is needed.

### `test/helpers/demo-record.ts` (test utility, file-I/O / request-response)

**Analog:** `test/product-flow.test.ts:1-20`

```typescript
const directory = await mkdtemp(join(tmpdir(), 'agent-lab-product-'));
const lab = new ExperimentLab(join(directory, 'runs'), createDemoRuntime());
t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
await lab.init();
let draft = await lab.create(demoEvaluationInput());
await lab.waitForIdle();
```

The helper should return `{ lab, directory, record }` and leave cleanup to its caller, exactly as the phase contract specifies. Reuse the real demo runtime/store lifecycle rather than constructing a large fake record.

### `test/quality.test.ts` (test, transform / file-I/O)

**Analog:** `test/quality.test.ts:1-83` and the helper lifecycle above.

```typescript
const q = qualitySummary(r);
assert.deepEqual(q.cards, { passed: 1, failed: 1, unknown: 1, total: 3, accuracy: 0.5 });
const text = qualityLines(q);
assert.match(text.queue, /Разметить человеку/);
```

Keep pure summary assertions in this file. For the new persistence-sensitive count, call `demoEvaluateRecord()` inside `try/finally`, add reviews through `lab.addHumanReview`, re-read via `lab.get`, and always close/remove the temporary directory.

### `test/contracts.test.ts` (test, transform)

**Analog:** `test/contracts.test.ts:21-34`

```typescript
assert.ok(targetSchema.safeParse({ kind: 'sandbox' }).success);
assert.equal(targetSchema.safeParse({ kind: 'module', path: 'relative/agent.mjs' }).success, false);
const http = targetSchema.parse({ kind: 'http', url: 'http://127.0.0.1:1/agent', headersEnv: { Authorization: 'AGENT_TOKEN' } });
assert.equal(http.kind === 'http' ? http.timeoutMs : 0, 60000);
```

Add three direct schema cases: legacy omission accepted, marked whole dialogue accepted, and marked metric/check rejected. Exercise both the exported input schema and the persisted experiment parse so their mirrored fields cannot drift.

### `test/extension.test.ts` (test, request-response / file-I/O)

**Analog:** `test/extension.test.ts:396-455`

```typescript
const screens: string[] = [];
let note: string | undefined;
const ctx = { cwd: directory, hasUI: true, mode: 'tui', ui: {
  confirm: async (_title: string, body: string) => { screens.push(body); return true; },
  select: async (_title: string, choices: string[]) => choices[0],
  editor: async (_title: string, initial: string) => initial || note,
} } as ExtensionContext;
const call = async (name: string, params: unknown) =>
  output(await tools.get(name)!.execute('journey', params, undefined, undefined, ctx));
```

Extend this existing journey rather than creating another extension harness. Capture the target choices, assert no group/cause option, choose one criterion and then the whole dialogue, inspect saved reviews after each action, and retain the existing cancellation/abort checks. Use two trials sharing a cause to prove the second trial is untouched.

## Shared Patterns

### Human-review identity and precedence

**Source:** `src/outcomes.ts:23-32`  
**Apply to:** `src/outcomes.ts`, `src/quality.ts`, `src/comparison.ts`

The canonical key is `${trialId}|dialogue`, `${trialId}|metric:${id}`, or `${trialId}|check:${id}`. Sort by `createdAt` and let the last entry replace the earlier value. Never mutate recorded checks or assessments.

### Validation at the storage boundary

**Source:** `src/experiment.ts:349-363`  
**Apply to:** all review inputs, including the native extension form

```typescript
const input = humanReviewInputSchema.parse(raw);
const trial = record.trials.find(t => t.id === input.trialId);
if (!trial) throw new Error('Такого диалога в этом эксперименте нет.');
// validate selected check/metric belongs to this trial/card
(record.humanReviews ??= []).push({ ...input, id: randomUUID(), createdAt: new Date().toISOString() });
```

The schema enforces target shape; `ExperimentLab.addHumanReview` enforces ownership. The extension should not duplicate these checks or write storage directly.

### ESM, language, and test cleanup

- Local imports use `.js` suffixes even in TypeScript.
- Identifiers/comments are English; user-visible text and errors are Russian.
- Tests use `node:test` and `node:assert/strict`; async filesystem tests clean up with `t.after` or `try/finally`.
- No new dependency, helper abstraction, or grouped-review target is needed.

## No Analog Found

None. Every planned file has an exact in-module or same-suite analog. The only new files (`test/outcomes.test.ts`, `test/helpers/demo-record.ts`) directly reuse existing test builders and real-lab lifecycle patterns.

## Metadata

**Analog search scope:** `src/`, `extensions/`, `test/`, canonical tasks 1-3  
**Files scanned:** 10 primary analog files; stopped after strong exact matches  
**Pattern extraction date:** 2026-09-15

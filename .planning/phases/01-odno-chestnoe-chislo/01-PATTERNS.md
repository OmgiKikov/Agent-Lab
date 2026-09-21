# Phase 1: Одно честное число - Pattern Map

**Mapped:** 2026-09-16
**Files analyzed:** 22 (4 new source/test files + 1 phase script + 17 modified)
**Analogs found:** 21 / 22 (all analogs are git-tracked; checked with `git ls-files`)

Line numbers are for HEAD `65a8272`. Their `src/`, `extensions/` and `test/` match `99aa533`, the commit that RESEARCH.md used.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/result-view.ts` (NEW) | view-model / utility | transform (pure) | `src/quality.ts` (`qualitySummary` 482-529, `qualityLines` 532-573) | exact |
| `src/normalize.ts` (NEW) | utility (defaults/identity) | transform (pure) | `src/outcomes.ts` (pure helper module, 1-12) + `extensions/agent-lab.ts:292-293, 359-367` (score settings to move) | role-match |
| `test/result-view.test.ts` (NEW) | test | unit, fixtures | `test/outcomes.test.ts` 1-40, `test/comparison.test.ts` 1-40 | exact |
| `test/normalize.test.ts` (NEW) | test | unit | `test/outcomes.test.ts` | role-match |
| `.planning/phases/01-.../verify-stored-runs.mjs` (NEW) | script (read-only) | file-I/O batch | none (closest `src/cli.ts:88-96` `summary`) | no analog |
| `src/comparison.ts` (MOD) | analysis | transform | self: `cardOutcome` 495-500, `compareRuns` 502-600, `verdictSummary` 351 | exact |
| `src/quality.ts` (MOD) | analysis | transform | self: `goalCardOutcome` 408-421 (move out), coverage 559-561 | exact |
| `src/judge.ts` (MOD) | service (judge) | request-response + verify | self: `hasCompleteJudgment` 110-140, rationale strings 104, 202, 204 | exact |
| `src/store.ts` (MOD) | store | file-I/O | self: `save` 85-96, `get` 97-105, `appendJudgment` 132-138 | exact |
| `src/contracts.ts` (MOD) | model/schema | — | self: `judgeAuditSchema` 238-250, `trialSchema` 748-760, `experimentSchema` 815-839, `Experiment` 715-742 | exact |
| `src/evaluation.ts` (MOD) | service | request-response | self: `assessTrial` 290-305 (audit copy at 296-298) | exact |
| `src/experiment.ts` (MOD) | orchestrator | CRUD + event-driven | self: `freshDraft` 61-86, replay goals 318-345, create 364-371, reassess 804, `onJudgment` 949, `repeat` 722-733 | exact |
| `src/cli.ts` (MOD) | controller (CLI) | request-response | self: `summary` 88-96, `score` 280-310, `repeat` 363-365, `parseArgs` 58-69 | exact |
| `extensions/agent-lab.ts` (MOD) | controller (Pi tools) | request-response | self: `renderResult` 20-38, `summary()` 69-96, score settings 292-293/359-367, `agent_lab_repeat` 513-527 | exact |
| `extensions/cards.ts` (MOD) | component (TUI) | render | self: `verdictLines` collapsed 186-215, `verdictHeadline` 256-259 | exact |
| `src/report.ts` (MOD) | exporter | file-I/O | self: audit dump 89, markdown audit line 244, `jsonReport` 197-200 | exact |
| `src/artifacts.ts` (MOD) | exporter/bundle | async read | self: `EvidenceBundle` 10-20, `evidenceBundle` 42-66, `embeddedBefore` 23-39 | exact |
| `src/connection.ts` (MOD) | utility | transform | self: `suiteEvidence` 128-134 | exact |
| `test/comparison.test.ts`, `test/judge.test.ts`, `test/quality.test.ts`, `test/cards.test.ts` (MOD) | test | unit | self | exact |
| `test/store.test.ts`, `test/evaluation.test.ts`, `test/artifacts.test.ts` (MOD) | test | integration (tmp dir) | `test/store.test.ts:13-17` (`mkdtemp` + `t.after(rm)`) | exact |
| `test/experiment.test.ts` (MOD) | test | integration (injected runtime) | self ~665-728 (validate with injected `goals`) | exact |
| `test/extension.test.ts`, `test/workflow.test.ts` (MOD) | test | integration | self | exact |

---

## Pattern Assignments

### `src/result-view.ts` (view-model, pure transform) — NEW

**Analog:** `src/quality.ts`

**Import rule (hard):** import only `./contracts.js`, `./outcomes.js`, `./comparison.js`. Do NOT import `./quality.js`, because it imports `draftHash` from `./experiment.js` (`quality.ts:5`). Copy `plural` (`quality.ts:370-374`) or move it into `outcomes.ts`. `quality.ts` may import constants from `result-view.ts`; that creates no cycle.

**Imports pattern** (`src/quality.ts:1-4`, type-only imports first, `.js` suffix):
```typescript
import type { Experiment, Requirement, Scenario, Source, TraceEvent, Trial, UserMode } from './contracts.js';
import { agentMetricResult, automaticTrialResult, latestHumanReviews, measured, measurementUsable, observedRecord, simulatorUsable } from './outcomes.js';
import { cardOutcome, humanFindings, isAgentFailure, verdictSummary, type VerdictSummary } from './comparison.js';
```

**Entry pattern** (`src/quality.ts:482-484`). Always narrow the record first:
```typescript
export function qualitySummary(input: Experiment): QualitySummary {
  const record = observedRecord(input);
```

**Card outcome to reuse** (`src/quality.ts:408-421`, to be moved into `comparison.ts` and exported). Build `cardVerdict` on top of it. Do not write a new counter.

**Card-level bucketing to mirror for notMeasured** (`src/quality.ts:423-437`):
```typescript
const reached = new Set(record.trials.filter(measured).map(trial => trial.scenarioId));
const attempted = new Set(record.trials.map(trial => trial.scenarioId));
... unknown: reached && outcome==='unknown', invalid: attempted && !reached, notReached: !attempted
```

**Percent / plural helpers** (`src/quality.ts:366-374`):
```typescript
const rate = (passed: number, failed: number): number | null => passed + failed ? passed / (passed + failed) : null;
export const percent = (value: number | null): string => value === null ? '—' : `${Math.round(value * 100)}%`;
export function plural(n: number, forms: [string, string, string]): string { ... }
```

**Lines pattern** (`src/quality.ts:531-533`). The function returns plain text and every surface escapes it at its own boundary:
```typescript
/** Plain text, one block per surface concern; each surface escapes at its own boundary. */
export function qualityLines(q: QualitySummary): { headline: string; coverage: string; ... } {
```
`resultViewLines(view): string[]` follows the same contract. It must not call `safeText`.

**Vocabulary lookup table pattern** (`src/quality.ts:478-480`, `limitTexts` as a `Record<code, string>`):
```typescript
judge_unknown: 'у судьи есть неясные оценки', simulator_flagged: 'есть пометки симулятора', incomplete_run: 'прогон неполный',
```
Use `Record<NotMeasuredCode, string>` for `NOT_MEASURED_TEXT` and `Record<ValidationExclusion['kind'], string>` for `EXCLUSION_TEXT`. The kinds are in `contracts.ts:215-217`.

**Reason sources to match on** (in the order the code evaluates them; full table in RESEARCH «Not-measured taxonomy»):
- `outcomes.ts:74-79` `measurementUsable`: `assessmentError`, human `invalid`, `resetConfirmed`, `simulatorUsable`
- `outcomes.ts:61-72` `simulatorUsable`: simulator checks, then `user_fidelity` must be `'pass'`
- `judge.ts:104`, the no-evidence rationale. Match with `includes`, because `judge.ts:202` prefixes «Совпало 2/2 …»
- `judge.ts:204`, the split rationale «Судья разошёлся на неизменном входе». Match with `startsWith`

**Wilson / ResultView shape:** copy from RESEARCH.md «Code Examples» (lines 462-511). The formula has no analog in the codebase. The closest statistics helper is `clusterInterval` in `comparison.ts:13-30`, which uses the same style: pure, returns `[number, number] | null`, and returns `null` for too few values.

---

### `src/normalize.ts` (utility, pure) — NEW

**Analog:** `src/outcomes.ts` for module shape: a header comment that says it does no I/O and has no consumer dependency, plus named exports (`outcomes.ts:1-11`):
```typescript
import { metricApplies, simulatorWasUsed, type Experiment, type HumanReview, type Scenario, type Trial } from './contracts.js';
/*
 * Outcome helpers shared by ... Nothing here performs I/O; nothing here depends on either consumer,
 * so both can import it without a cycle.
 */
export const runningPhases = new Set([...]);
```

**Default sites to collapse into `DEFAULT_GOAL_OBSERVATION` / `normalizeScenarioIdentity`:**
- `src/experiment.ts:69-70` (freshDraft):
  ```typescript
  if (record.target.kind !== 'sandbox') record.scenarios = record.scenarios.map(scenario =>
    scenario.goalObservation ? scenario : { ...scenario, goalObservation: 'reply' });
  ```
- `src/experiment.ts:358`, `:369-370`, `:526`, `:605`, and `contracts.ts:431`
- Identity use site: `src/comparison.ts:551`
  ```typescript
  const changed = shared.filter(s => fingerprint(s) !== fingerprint(before.scenarios.find(b => b.id === s.id)));
  ```
  Replace it with `fingerprint(normalizeScenarioIdentity(s, after.target.kind))` on both sides.

**`scoreSettings` source to move** (`extensions/agent-lab.ts:291-293` and `:359-367`):
```typescript
const supplied = (rest.settings ?? {}) as Partial<z.infer<typeof settingsSchema>>;
const scoreMaxCalls = Math.min(3000, Math.max(20, 8 * parsedDialogues.length));
const scoreMaxDurationMs = Math.min(14_400_000, Math.max(180_000, 120_000 * parsedDialogues.length));
...
settings: { ...(mode === 'demo' ? demoInput().settings : {}), repeats: 1,
  maxCalls: operation === 'score' ? scoreMaxCalls : ...,
  ...(mode === 'live' ? { judge: DEFAULT_JUDGE } : {}),
  ...(operation === 'validate' || operation === 'score' ? { timeoutMs: 600_000 } : {}),
  ...supplied,
  ...(operation === 'validate' ? { maxTurns: 6, userModes: ['reactive'] } : {}),
  provider: supplied.provider || ctx.model?.provider || '', model: supplied.model || ctx.model?.id || '' },
```
Add `userModes: ['scripted']` and `repeats: 1` to the helper (defect D2). Use the `Settings` type from `contracts.ts:65` and `DEFAULT_JUDGE` from `contracts.ts:5`. Keep `...supplied` last so the owner's values win. Pi's `provider/model` from `ctx.model` stays at the call site.

---

### `src/comparison.ts` (analysis) — MOD

**D1 fix sites.** Pass the sources the judge actually saw:
- `:351` `verdictSummary`: `hasCompleteJudgment({ scenario: ..., sources: record.sources, trial: t })`
- `:560` `compareRuns`: `hasCompleteJudgment({ scenario: run.scenarios.find(...)!, sources: run.sources, trial })`
Replace with `observableSources(run.sources, run.requirements)`. The import line `:1` becomes `import { hasCompleteJudgment, observableSources } from './judge.js';`. This mirrors `evaluation.ts:295`:
```typescript
scenario: structuredClone({ ...scenario, metrics }), sources: structuredClone(observableSources(sources, requirements)), trial: structuredClone(trial),
```

**Per-pair incomparable pattern** (Pattern 3; move the `:560` check into the loop at `:571-578`):
```typescript
if (a.length !== 1) addIncomparable(row, a.length ? 'Несколько попыток «до» с одним ключом.' : 'Нет попытки «до».', a[0]?.id, b[0]?.id);
else if (!validBefore(a[0]!)) addIncomparable(row, 'Попытка «до» невалидна или не измерена.', a[0]!.id, b[0]?.id);
```
Add a branch in the same style: `addIncomparable(row, 'Судья не завершил оценку этой попытки.', ...)`.

**Judge identity reader** (`:553-556`). It reads `t.judgeAudit`. Change it to `t.judgeAudit ?? t.judgeReceipt`; both carry `protocolHash/provider/model`.

**Where `goalCardOutcome` goes:** next to `cardOutcome` (`:495-500`), exported. Keep the body byte-identical to `quality.ts:408-421`.

**New stability functions**, modelled on `repeatResults` (`:191-206`). That function also starts with `record = observedRecord(record);`, maps scenarios, and returns plain rows with `scenarioId` and `title`. `stabilityAfterReassess` reconstructs the source view with `embeddedBefore` (`artifacts.ts:23-39`). Take `manifestHash` from the source trials (`before.manifestHash = before.trials[0]?.manifestHash ?? null`).

---

### `src/quality.ts` (analysis) — MOD

- `:408-421`: remove `goalCardOutcome` and import it from `./comparison.js` (the import line at `:4` already imports `cardOutcome` from there).
- `:535`: the judge model reader becomes `t.judgeAudit ?? t.judgeReceipt`.
- `:555-557` + `:559-561`: replace the `other` bucket and the «прочее» string with `EXCLUSION_TEXT` per kind:
  ```typescript
  masked: ..., other: exclusions.filter(item => item.kind === 'length' || item.kind === 'unconfirmed').length };
  ...
  q.excluded.other ? `прочее — ${q.excluded.other}` : ''
  ```
  Tests to update: `test/quality.test.ts:589` and `test/experiment.test.ts:716`.
- Keep `QualitySummary.headline` and `qualityLines` unchanged in every other respect. Tests `quality.test.ts:184, 217-218` assert them.

---

### `src/judge.ts` (judge service) — MOD

**Rationale constants.** Export them without changing the text; the three literals are at `:104`, `:202` and `:204`:
```typescript
rationale: 'Достижение цели не подтверждено цитированным доказательством выбранного владельцем типа; слова агента оцениваются отдельно.'
rationale: `Совпало 2/2 оценок этой рубрики в свежих сессиях; это не проверка правильности. ${votes[0]!.rationale}`
rationale: `Судья разошёлся на неизменном входе: ${votes.map(v => v.result).join(' / ')}. Основания каждой оценки сохранены в judgeAudit.`
```
Do not touch `JUDGE_PROMPT`, `JUDGE_RESPONSE_FORMAT` or `JUDGE_PROTOCOL` (`:14-20`).

**Receipt path in `hasCompleteJudgment`** (`:110-140`). Keep the current body as the legacy branch. Its guard and aggregation are the pattern the receipt branch copies:
```typescript
const audit = input.trial.judgeAudit;
if (!audit || input.trial.assessmentError || audit.prompt !== JUDGE_PROMPT) return false;
const expectedProtocol = audit.configurationHash
  ? fingerprint({ protocol: JUDGE_PROTOCOL, configuration: audit.configurationHash }) : JUDGE_PROTOCOL;
if (audit.protocolHash !== expectedProtocol) return false;
const applicable = metrics.filter(m => metricApplies(m, input.trial));
const data = judgeInput({ ...input, scenario: { ...input.scenario, metrics: applicable } });
if (audit.inputHash !== fingerprint(data)) return false;
...
return applicable.every(m => {
  const votes = ...;
  if (votes.length !== 2 || votes.some(v => !v)) return false;
  const result = votes.every(v => v === votes[0]) ? votes[0] : 'unknown';
  return input.trial.assessments?.find(v => v.metricId === m.id)?.result === result;
});
```
Suggested structure: `if (audit) return legacyComplete(...)`, then `if (receipt) return receiptComplete(...)`, else `false`.

**Journal cadence source** (`:157-158`, `:167-187`): `save()` is called at start, per attempt, per partial, after the response and after parsing. Keep calling `ctx.onJudgment` there, because that call feeds the sidecar. Only the journal append moves to "once per finished judgment" (see `experiment.ts:949`).

---

### `src/store.ts` (store, file-I/O) — MOD

**Analog for `writeJudgeAudit`:** `save` (`:85-96`), an atomic tmp + rename write with mode `0600`:
```typescript
async save(record: Experiment): Promise<void> {
  if (!this.lockToken) throw new Error('Для изменения записи откройте лабораторию как писатель.');
  const validated = experimentSchema.parse(record);
  const target = this.path(validated.id);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(validated, null, 2)); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
}
```
**Path-safety guard to copy** (`:132-135`). Check both ids before any `join`:
```typescript
if (!this.lockToken) throw new Error('Для записи оценки откройте лабораторию как писатель.');
this.path(id);
if (!idPattern.test(trialId)) throw new Error('Invalid trial ID');
```
**Directory creation:** `mkdir(..., { recursive: true, mode: 0o700 })` (`:50`). Target path: `join(this.directory, `${id}.judge`, `${trialId}.json`)`.
**Analog for `readJudgeAudit`:** `get` (`:97-105`): `open(..., 'r')`, a size check (`> 50_000_000` → use about 20 MB), `judgeAuditSchema.parse(JSON.parse(...))`, and `finally close`. Treat ENOENT the way `traceJournal` does (`:127-130`): `if (code === 'ENOENT') return null`. Per CLAUDE.md, `null` means "searched but not found".
**Journal:** `appendJudgment` (`:132-138`) stays as it is. Only its caller changes.

---

### `src/contracts.ts` (schema) — MOD

**Optional field pattern on strict schemas.** `trialSchema` (`:748-760`) ends with:
```typescript
  externalUsage: usageSchema.optional(),
  judgeAudit: judgeAuditSchema.optional(),
});
```
Add `judgeReceipt: judgeReceiptSchema.optional()` in the same place. Model `judgeReceiptSchema` on `judgeAuditSchema` (`:238-250`): reuse `text`, `identifier` and the `transport` sub-object verbatim. Add the matching `judgeReceipt?: JudgeReceipt` to the `Trial` interface next to `judgeAudit?: JudgeAudit` (`:554`).

**Experiment-level optional field.** Place it next to `parentRunId`/`selectedScenarioIds` in both the interface (`:733-734`) and the schema (`:834`):
```typescript
parentRunId: identifier.optional(), selectedScenarioIds: z.array(identifier).min(1).max(200).optional(), ...
```
→ `positiveControlScenarioIds: z.array(identifier).max(5).optional()`. Add a JSDoc line in the interface style (`:731`: `/** Recorded dialogues left out of a validation set, ... */`).

**Hash safety:** `fingerprint` (`:933-937`) drops keys whose value is `undefined`, so an absent field leaves old hashes unchanged. Do not bump `VERSION` (`:4`).

---

### `src/evaluation.ts` (assessment write point) — MOD

**Current audit copy to replace** (`:290-298`):
```typescript
const assessments = validateAssessments(metrics, trial.events, await runtime.assess({
  scenario: structuredClone({ ...scenario, metrics }), sources: structuredClone(observableSources(sources, requirements)), trial: structuredClone(trial),
}, { ...ctx, onTargetEvent: undefined, onTrace: undefined, onJudgment: (id, audit) => {
  trial.judgeAudit = structuredClone(audit);
  ctx.onJudgment?.(id, audit);
} }));
```
Change it to `let latest: JudgeAudit | undefined; ... latest = structuredClone(audit)`. After the assessments are computed, set `trial.judgeReceipt`. Compute `complete` with the legacy `hasCompleteJudgment({ scenario, sources: observableSources(...), trial: { ...trial, judgeAudit: latest, assessments } })`. **Error path** (`:280-284`) stays unchanged:
```typescript
trial.assessmentError = (ctx.signal.aborted ? 'Metric assessment cancelled' : error instanceof Error ? error.message : 'Metric assessment failed').slice(0, 4000);
```

---

### `src/experiment.ts` (orchestrator) — MOD

- **TRUST-06 goal id** (`:329-331`):
  ```typescript
  const batch = record.dialogues.slice(index, index + GOAL_BATCH);
  const extracted = (await Promise.all(batch.map(extract))).flat();
  ```
  → `(await Promise.all(batch.map(async d => (await extract(d)).map(g => ({ ...g, id: d.id }))))).flat()`. The throw it prevents is `validateObservedGoals` at `:344`.
- **Sidecar hook** (`:949`):
  ```typescript
  onJudgment: (trialId, audit) => this.store.appendJudgment(record.id, trialId, audit),
  ```
  → write the sidecar on every call; append to the journal once per finished judgment.
- **Reassess cleanup** (`:804`). Add `delete trial.judgeReceipt;` to:
  ```typescript
  trial.usage = emptyUsage(); delete trial.externalUsage; delete trial.assessments; delete trial.assessmentError; delete trial.judgeAudit;
  ```
- **Control marker in `repeat`** (`:722-733`) and `freshDraft` (`:61-68`). `structuredClone(previous)` already carries the field. Filter it in the same block that filters `scenarios` by `scenarioIds`:
  ```typescript
  record.scenarios = record.scenarios.filter(s => scenarioIds.includes(s.id));
  record.selectedScenarioIds = [...scenarioIds];
  ```
  Validate the ids the same way this line does (`:64-65`): `throw new Error('Выберите существующие тесты без повторов.')`.
- **Hashes** (`:34-47`): `draftHash` may add `positiveControlScenarioIds: record.positiveControlScenarioIds`. `measurementHash` must not.

---

### `src/cli.ts` (CLI controller) — MOD

**`summary` to switch** (`:88-96`):
```typescript
if (command === 'summary') {
  if (!values.id) throw new Error('Укажите --id RUN');
  const record = await new ExperimentStore(directory).get(values.id);
  const q = qualitySummary(record);
  if (values.json) { process.stdout.write(`${JSON.stringify(q, null, 2)}\n`); return; }
  const text = qualityLines(q);
  process.stdout.write([text.headline, ...(text.coverage ? [text.coverage] : []), ...text.metrics, '', ...].join('\n'));
  return;
}
```
Print `resultViewLines(view).map(safeLine)` first. `safeText`/`safeLine` are at `:22-24`. `--json` becomes `{ ...q, view }`. Load the stability `before` with `store.get(record.assessmentOf ?? record.parentRunId)` inside try/catch. Do not use `evidenceBundle`, because it reads the whole journal.

**`score` settings** (`:288-289`):
```typescript
input = createInputSchema.parse({ ...raw, mode: raw.mode ?? 'live', ...(connection ? {...} : {}),
  dialogues, scenarioCount: 0 });
```
→ add `settings: scoreSettings(dialogues.length, raw.settings ?? {}, raw.mode ?? 'live')`. Errors go through `scoreInputError` (`:25`).

**`repeat --control`:** add the option to `parseArgs` (`:58-69`) in the same form as `case: { type: 'string', multiple: true }`. The call site is `:363-365`: `lab.repeat(id, values.case)`.

**Error style:** `throw new Error('Укажите --id RUN')` — a Russian instruction, plain `Error`.

---

### `extensions/agent-lab.ts` (Pi tool controller) — MOD

- **`renderResult`** (`:20-38`). The fallback chain to extend at the front:
  ```typescript
  const title = data.error ?? (data.phase === 'review' ? ... : data.quality?.headline ?? data.evidence?.verdict?.headline ?? data.message ?? 'Доказательства прочитаны.');
  ```
  If `data.view?.lines` exists, render those lines through `safeText` first.
- **`summary()` payload** (`:69-96`). Add `view` next to `quality`, in the same conditional-spread style:
  ```typescript
  ...(quality ? { quality: { ...qualityLines(quality), primary: quality.primary, ... } } : {}),
  ```
- **Score settings:** replace `:292-293` and the score branches at `:359-367` with `scoreSettings(...)`. Keep the validate branches, or move them into `validateSettings` (optional).
- **`agent_lab_repeat`** (`:513-527`). Add `controlScenarioIds` to the typebox params in the same form as `scenarioIds`:
  ```typescript
  scenarioIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 40, description: '...' }))
  ```
- **Imports** come from `../dist/*.js` (`:8-17`). A new module must be imported as `../dist/result-view.js`. This requires a coordinated `dist/` rebuild from a snapshot before a Pi restart.

---

### `extensions/cards.ts` (TUI component) — MOD

**Collapsed ИТОГ block** (`:193-199`). Replace the top lines:
```typescript
const q = qualitySummary(record);
const text = qualityLines(q);
...
return [line('ИТОГ', 'accent', true),
  ...(measuredAny ? [line(q.headline, 'text', true), ...(text.coverage ? [line(text.coverage, 'warning')] : []), line(v.headline, 'muted')] : [line(v.headline, 'text', true)]),
```
Use `resultViewLines(view).map((l, i) => line(l, i === 0 ? 'text' : 'muted', i === 0))`. `line()` already passes text through `safeText` (`:10-13`). Also remove the single-trial «НЕ ИЗМЕРЕНО» at `:204`; the view's not-measured line replaces it.
**`verdictHeadline`** (`:256-259`) becomes `Итог: ${view.headline.text} · 1 подробнее`. Update `test/cards.test.ts:308`.
**Imports:** `../dist/...` (`:3-7`).

---

### `src/report.ts` / `src/artifacts.ts` / `src/connection.ts` (TRUST-08 readers) — MOD

- `report.ts:89`: remove `<pre>${escape(JSON.stringify(trial.judgeAudit, null, 2))}</pre>`. Keep the `<summary>` with provider/model/attempt count, and add a receipt fallback.
- `report.ts:244`: markdown line. Use `(t.judgeAudit ?? t.judgeReceipt)` for provider/model/protocol and the vote count.
- `report.ts:197-200` `jsonReport`:
  ```typescript
  const { record, ...evidence } = bundle;
  return JSON.stringify({ experiment: record, ...evidence }, null, 2);
  ```
  → destructure `traceJournal` out as well and emit a path reference instead. `exportArtifacts` already builds `paths.traceJournal` (`artifacts.ts:77`).
- `artifacts.ts:42-44`: add `view: buildResultView(snapshot, { before })` to `EvidenceBundle` (interface at `:10-20`, following the `quality` field and its JSDoc «derived from the same helpers…»).
- `connection.ts:128-134` `suiteEvidence`: `.map(trial => structuredClone(trial))` → strip `judgeAudit` (keep or seal a receipt).

---

### Tests — NEW and MOD

**Pure unit fixture pattern** (`test/outcomes.test.ts:1-26`):
```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyUsage, type HumanReview, type Scenario, type Trial } from '../src/contracts.js';
const rubric = (id: string) => ({ id, name: id, subject: 'agent' as const, description: 'd', passCriteria: 'p', failCriteria: 'f' });
const scenario: Scenario = { id: 'card', familyId: 'card', title: 'Card', split: 'dev', provenance: 'synthetic', requirementIds: [], ... };
const trial: Trial = { id: 't1', ..., userMode: 'static', manifestHash: 'm', outcome: 'ungraded', ..., usage: emptyUsage(), elapsedMs: 1, assessments: [...] };
```
**Record builder with overrides** (`test/comparison.test.ts:18-26`):
```typescript
function record(overrides: Partial<Experiment> = {}): Experiment {
  return { schemaVersion: '1', id: 'exp', ..., settings: settingsSchema.parse({ userModes: [...] }), ..., ...overrides };
}
```
For `result-view.test.ts`, use `settingsSchema.parse({ userModes: ['reactive'], repeats: 1 })`, metrics `goalAttainment`, `replyQuality` and `simulatorFidelity` (exported from contracts, see `test/judge.test.ts:7`), and `mode: 'live'`.

**Judge audit fixture** (`test/judge.test.ts:10-19, 60-85`): `assessRepeated(input, model, { signal, timeoutMs, beforeCall() {}, addUsage() {}, onJudgment(_id, a) { audit = a; } }, async () => outputs[i])`, then `hasCompleteJudgment({ ...input, trial: { ...trial, assessments: result, judgeAudit: audit } })`. Tamper cases mutate `structuredClone(audit)` and assert `false`. The D1 regression needs `sources: [{ id: 'p', name: 'Prompt', content: '...', hash: 'h', kind: 'prompt' }]` and a non-empty `requirements`.

**Tmp-dir integration** (`test/store.test.ts:13-17`):
```typescript
async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-lab-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
```
**Injected runtime for TRUST-06** (`test/experiment.test.ts:670-700`): the `runtime: Runtime = { async prepare(...) {...}, async goals(input) { ... return [{ id: \`goal_${dialogue.id}\`, ... }] } }`. For the new test, return `id: 'same'` for every dialogue and assert `phase === 'review'`.

**Running tests:** only from a snapshot. See the RESEARCH «Validation Architecture» quick/full commands. Never run `npm test` in the worktree.

---

## Shared Patterns

### Rendering safety
**Source:** `extensions/cards.ts:10-13`, `src/cli.ts:22-24`
**Apply to:** every surface that prints `resultViewLines` (CLI summary, tool `renderResult`, board)
```typescript
export function safeText(value: unknown): string {
  return stripTerminalSequences(String(value ?? '')).replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}
```
`result-view.ts` returns raw text; the surfaces escape it.

### Hashing / identity
**Source:** `src/contracts.ts:933-937` `fingerprint`
**Apply to:** receipt `auditHash`, `normalizeScenarioIdentity` comparisons, draftHash addition. Never compare with `JSON.stringify` directly.

### Atomic, private files
**Source:** `src/store.ts:85-96` (file `0600`, tmp+rename), `:50` (dir `0700`), `:132-138` (id guards)
**Apply to:** sidecar `{id}.judge/{trialId}.json`, evidence copies.

### Errors
**Source:** CLAUDE.md conventions and examples at `src/cli.ts:89`, `src/experiment.ts:65`, `src/store.ts:133`
**Apply to:** all new code. Use plain `throw new Error('<what went wrong + what to do>')`: Russian for the user, English for internal invariants (`'Invalid trial ID'`). No error classes.

### Pure analysis boundary
**Source:** `src/comparison.ts:6-12` header comment, `src/outcomes.ts:3-7`
**Apply to:** `result-view.ts`, `normalize.ts`, the stability functions. No I/O and no `experiment.ts` import. Async loading of `before` stays in callers (`cli.ts` summary, `artifacts.ts` `evidenceBundle`).

### Old records open without migration
**Source:** `trialSchema`/`experimentSchema` are `strictObject` (`contracts.ts:748, 815`). Optional fields only; `VERSION` (`contracts.ts:4`) is never bumped.
**Apply to:** `judgeReceipt`, `positiveControlScenarioIds`. Every reader accepts either `judgeAudit` (legacy) or `judgeReceipt`.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `.planning/phases/01-odno-chestnoe-chislo/verify-stored-runs.mjs` | read-only script | batch file-I/O | The repo has no maintenance scripts. The tracked `.mjs` files (`examples/echo-agent.mjs`, `test/fixtures/stdio-agent.mjs`) are target adapters. Import `../../../dist/store.js` + `dist/result-view.js` (ESM), `new ExperimentStore('.agent-lab').get(id)` (no lock needed, `store.ts:47`), and print ids/counts only, never dialogue text. |
| Wilson interval inside `src/result-view.ts` | helper | transform | No existing implementation. Use the RESEARCH formula and its test vectors (RESEARCH lines 462-484). The style analog is `clusterInterval` (`comparison.ts:13`). |

## Metadata

**Analog search scope:** `src/`, `extensions/`, `test/`, `examples/` (tracked files only)
**Files scanned:** 21 (line-ranged reads)
**Pattern extraction date:** 2026-09-16

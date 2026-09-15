# Phase 3: Полезный тест и его принятие - Pattern Map

**Mapped:** 2026-09-15
**Files analyzed:** 13 existing files to modify
**Analogs found:** 13 / 13

Phase 3 is an invariant added through existing modules. Do not create an approval service, presentation framework, editor, cache, or persistence layer. Every named analog below is a Git-tracked source file.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/contracts.ts` | model / validation | serialization + transform | optional compatibility fields and `validatePreparation()` in the same file | exact |
| `src/experiment.ts` | service / aggregate | serialized CRUD + file-I/O | `reviewResults()`, `updateDraft()`, `freshDraft()`, `saveSuite()` | exact |
| `src/pi.ts` | service / model adapter | request-response + bounded repair | generated-card review callback in `prepare()` | exact |
| `src/quality.ts` | utility / reporting | transform | pure `qualityLines()` projection and `metricRows()` grouping | exact |
| `src/cli.ts` | controller | request-response + file-I/O | existing `--yes`, build/run and save-suite branches | exact |
| `extensions/agent-lab.ts` | controller / component | event-driven request-response | `runPlan()`, `agent_lab_edit`, `agent_lab_run`, native `ctx.ui.confirm` | exact |
| `skills/agent-builder/SKILL.md` | config / instruction contract | request-response guidance | current numbered workflow and exact-hash editing rules | exact |
| `test/contracts.test.ts` | test | transform | schema compatibility and synthetic-answer validation tests | exact |
| `test/experiment.test.ts` | test | serialized CRUD + file-I/O | exact-hash lifecycle, mutation-race and repeat tests | exact |
| `test/pi.test.ts` | test | request-response | scripted repair and external-card rubric tests | exact |
| `test/quality.test.ts` | test | transform | metric row identity tests | exact |
| `test/extension.test.ts` | test | event-driven request-response | registered-tool harness and confirm/edit tests | exact |
| `test/workflow.test.ts` | test | batch + subprocess | suite round-trip and real CLI subprocess test | exact |

## Pattern Assignments

### `src/contracts.ts` (model, serialization + validation)

**Analog:** optional experiment metadata plus centralized semantic validation in `src/contracts.ts`.

**Backward-compatible field pattern** (lines 492-516, schema lines 583-602):

```typescript
export interface Experiment {
  // required aggregate state...
  humanReviews: HumanReview[]; resultsReviewedAt?: string; resultsReviewHash?: string;
  failureModes?: FailureMode[];
  parentRunId?: string;
  selectedScenarioIds?: string[];
  targetVersion?: string;
  targetFingerprint?: string;
  evaluatorVersion?: string;
}

export const experimentSchema: z.ZodType<Experiment> = z.strictObject({
  // required fields...
  humanReviews: z.array(humanReviewSchema).default([]),
  resultsReviewedAt: text.optional(), resultsReviewHash: text.optional(),
  targetVersion: text.max(200).optional(), targetFingerprint: text.optional(),
  evaluatorVersion: text.optional(),
});
```

Copy this pattern for exactly one `acceptedDraftHash?: string`: optional in both TypeScript and Zod, so old JSON means “not accepted.” Do not add a timestamp/state machine and do not include the field in `draftHash()`.

**Existing token and semantic-validation pattern** (lines 17-25, 700-773):

```typescript
export function valueTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.match(VALUE_TOKEN) ?? []) {
    const token = raw.replace(/[.,:]+$/, '').toLocaleLowerCase();
    if (token.length >= 3 && /\d/.test(token)) tokens.add(token);
  }
  return tokens;
}

export function validatePreparation(raw: unknown, sources: Source[], workflow = 'compare', profiles: Profile[] = []): Preparation {
  const p = preparationSchema.parse(raw);
  // uniqueness, grounding, checks and rubric invariants are rejected here
  return { ...p, scenarios: p.scenarios.map(/* split assignment */) };
}
```

Extend the shared validation seam; do not invent another tokenizer or validator. Generated-card-only normalization belongs before storage in `src/pi.ts`, while the stored contract remains backward compatible with owner-edited/legacy cards.

---

### `src/experiment.ts` (aggregate service, serialized CRUD + file-I/O)

**Analog:** `draftHash()`, `change()`, `updateDraft()`, `freshDraft()`, `reviewResults()` and `saveSuite()` in the same aggregate.

**Exact semantic identity** (lines 27-32):

```typescript
export function draftHash(record: Experiment): string {
  return fingerprint({ task: record.task, workflow: record.workflow, mode: record.mode, sources: record.sources,
    settings: record.settings, target: record.target, requirements: record.requirements, questions: record.questions,
    goldenCases: record.goldenCases, dialogues: record.dialogues, profiles: record.profiles, notes: record.notes,
    scenarios: record.scenarios, agent: record.revisions[0]?.spec,
    targetVersion: record.targetVersion, targetFingerprint: record.targetFingerprint, evaluatorVersion: record.evaluatorVersion });
}
```

Acceptance records this hash. It must not become another hash input.

**Serialized optimistic mutation** (lines 103-108, 189-194):

```typescript
private async change<T>(work: () => Promise<T>): Promise<T> {
  this.ensureIdle();
  const pending = Promise.resolve().then(work);
  this.mutation = pending;
  try { return await pending; } finally { if (this.mutation === pending) this.mutation = undefined; }
}

async updateDraft(id: string, expectedHash: string, raw: DraftPatch): Promise<Experiment> {
  return this.change(async () => {
    const record = await this.store.get(id);
    if (record.phase !== 'review') throw new Error(/* existing message */);
    if (draftHash(record) !== expectedHash) throw new Error(/* stale message */);
    // validate, mutate, checkpoint
  });
}
```

Implement `acceptDraft(id, expectedHash)` through `change()`: load, require the review/evaluate one-test boundary, compare inside the mutation, set `acceptedDraftHash` to the current full hash, checkpoint, return a clone. Acceptance performs no target/model/judge/simulator call.

**Invalidation by construction** (lines 46-63, 231-234):

```typescript
Object.assign(record, {
  id: randomUUID(), parentRunId: previous.id,
  phase: 'review', trials: [], comparisons: [], iterations: [], humanReviews: [],
  reviewedAt: null, reviewMode: null, manifestHash: null, controlConsumedAt: null, error: null,
});

record.reviewedAt = null; record.reviewMode = null; record.manifestHash = null;
await this.checkpoint(record, 'review', /* edit summary */);
```

Clear `acceptedDraftHash` in `freshDraft()` and after every successful semantic `updateDraft()`. Because `repeat()`, `loadSuite()` and `reassess()` already route through `freshDraft()`, one reset point covers them.

**File boundary guard** (lines 251-260):

```typescript
async saveSuite(id: string, file: string, scenarioIds?: string[]): Promise<string> {
  const previous = await this.get(id);
  if (previous.workflow !== 'evaluate' || !previous.scenarios.length || runningPhases.has(previous.phase)) {
    throw new Error('Сначала дождитесь готовых тестов.');
  }
  const definition = freshDraft(previous, scenarioIds);
  // preserve source evidence
  await writeFile(path, JSON.stringify(/* portable definition */), { flag: 'wx', mode: 0o600 });
  return path;
}
```

Add the equality gate against `previous` before `freshDraft()` and before writing. Preserve `flag: 'wx'` and `mode: 0o600`. The exported fresh definition is intentionally unaccepted.

---

### `src/pi.ts` (model adapter, bounded request-response repair)

**Analog:** generated scenario schema and the semantic review callback in `prepare()`.

**Schema-before-publication pattern** (lines 27-42):

```typescript
const generatedScenarioSchema = (external: boolean, harnessRubrics = 0) =>
  scenarioSchema.required({ successCriteria: true, assumptions: true, metrics: true })
    .extend({ user: scenarioSchema.shape.user.required({ maxFollowUps: true }) })
    .refine(/* observable/evaluable */)
    .refine(/* external state/tool boundary */)
    .refine(/* generated rubric ownership */);
```

Make the pre-harness generated contract exactly one agent-authored `goal_attainment` whose `passCriteria === successCriteria`. Keep prompt/simulator rubrics outside the model-owned tuple and add them only in the existing harness branch.

**Bounded semantic repair pattern** (lines 441-507):

```typescript
const cards = await ask(
  batchLabel,
  cardsRole(/* ... */),
  evidence,
  z.strictObject({ scenarios: z.array(generatedScenarioSchema(external, harnessRubrics)) }),
  ctx,
  value => {
    for (const scenario of value.scenarios) {
      // check IDs, provenance, requirements and literal grounding
      const known = valueTokens([scenario.user.opening, scenario.user.facts, ...(scenario.user.knows ?? [])].join('\n'));
      for (const answer of scenario.user.answers ?? []) {
        const unknown = [...valueTokens(answer.reply)].find(token => !known.has(token));
        if (unknown) return `Card ${scenario.id}: ...`;
      }
    }
    return undefined;
  },
);
for (const scenario of cards.scenarios) {
  if (external) scenario.metrics.push({ ...simulatorFidelity });
  if (external && input.sources.some(s => s.kind === 'prompt')) scenario.metrics.unshift({ ...promptCompliance });
}
```

Reuse this callback, but inspect every answer token, compare it against authoritative owner material plus user-authored dialogue evidence, add only supported missing values, deduplicate case-insensitively, then reject if the final `knows` count exceeds 20. Do not use candidate text, assistant replies, logged outcomes, `.find()` first-error acceptance, or `.splice()`/`.slice()` truncation for semantic content.

---

### `src/quality.ts` (pure projection + reporting transform)

**Analog:** `qualityLines()` separates a pure semantic text projection from surface-specific escaping (lines 169-182).

```typescript
/** Plain text, one block per surface concern; each surface escapes at its own boundary. */
export function qualityLines(q: QualitySummary) {
  return {
    headline: q.headline,
    metrics: q.metrics.map(/* pure text */),
    // ...
  };
}
```

Put the shared compact test projection in this existing utility rather than creating `test-view.ts`: one scenario, `ТЕСТ / СИТУАЦИЯ / ВХОД / УСПЕХ / НАБЛЮДЕНИЕ`, optional non-empty state, and the first 12 hash characters. Return plain text/lines; Pi applies `safeText()` at its boundary and CLI prints the same semantic content.

**Row identity pattern to change** (lines 58-83):

```typescript
for (const metric of (scenario.metrics ?? []).filter(m => m.subject === 'agent')) {
  const key = `rubric:${fingerprint(metric)}`;
  const row = rows.get(key) ?? { id: metric.id, name: metric.name, kind: 'rubric', /* counters */ };
  // ...
}
```

For `goal_attainment`, `prompt_compliance`, and `reply_quality`, key by reserved ID so each is one row per run. Preserve the full fingerprint key for owner-defined rubrics; labels alone remain insufficient.

---

### `src/cli.ts` (CLI controller, request-response)

**Analog:** existing command parsing and explicit `--yes` branches (lines 35-50, 166-203).

```typescript
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  // ...
  yes: { type: 'boolean' },
} });

if (command === 'save-suite') {
  if (!id || !values.output) throw new Error(/* usage */);
  process.stdout.write(`${await lab.saveSuite(id, values.output, values.case)}\n`);
  return;
}

const draft = await lab.get(id);
if (command === 'run' && !values.yes) throw new Error('Для запуска согласованных тестов укажите --yes.');
await lab.start(id, { approved: true, expectedHash: draftHash(draft) });
```

Before any Phase 4 execution, print the same full compact test block and its hash. `--yes` accepts exactly that displayed hash through `acceptDraft`; absence of `--yes` stops after display with a concrete review/retry instruction. Do not add an interactive prompt. The `save-suite` branch relies on the aggregate gate rather than duplicating authorization.

---

### `extensions/agent-lab.ts` (Pi controller/component, event-driven)

**Analog:** safe plan rendering, native confirmation, and thin mutation adapters.

**Safe render and hash** (lines 40-53):

```typescript
function runPlan(record: Experiment): string {
  return [
    ...record.scenarios.map(s => [safeText(s.title),
      `  Запрос: ${safeText(s.user.opening)}`,
      `  Ожидается: ${safeText(s.successCriteria)}`,
      ...s.checks.map(c => `  Проверка: ${safeText(describeCheck(c))}`)
    ].join('\n')),
    `Версия тестов: ${draftHash(record).slice(0, 12)}`,
  ].join('\n');
}
```

Replace the visible semantics with the shared one-test projection, but keep `safeText()` on every external value and keep the full criterion/input visible.

**Thin edit adapter** (lines 239-255):

```typescript
const record = await lab.updateDraft(params.id, params.expectedHash, draftPatchSchema.parse(params.patch));
const output = summary(record, lab.store.directory);
return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
```

Keep `agent_lab_edit` as the only correction path. Its result must show the new version and say acceptance was invalidated.

**Native acceptance seam** (lines 273-308):

```typescript
const draft = await lab.get(params.id);
if (draft.workflow !== 'evaluate' || draftHash(draft) !== params.expectedHash) throw new Error(/* stale */);
if (!await ctx.ui.confirm('Запустить проверку?', runPlan(draft))) {
  return { content: [{ type: 'text', text: JSON.stringify({ id: draft.id, cancelled: true }) }], details: { cancelled: true } };
}
await lab.start(draft.id, { approved: true, expectedHash: params.expectedHash });
```

For Phase 3, the confirm accepts the shown exact test through `acceptDraft()` and returns immediately with “agent not run.” Decline leaves the draft editable. Do not call `start()`, create polling, export artifacts, or save a suite in the acceptance path. Phase 4 can later consume the stored acceptance without a second ceremony.

---

### `skills/agent-builder/SKILL.md` (instruction contract)

**Analog:** exact-hash edit guidance and numbered workflow in the same file (lines 34-38, 54-59).

```markdown
To edit cards, inspect the current draftHash and send only the changed complete cards in patch.scenarios...
A stale hash requires a fresh inspection before retrying.

2. Prepare a simple user model.
3. Run the proposed test.
```

Update by audience: normal conversation says `тест`; serialized/technical contract says `business-scenario card` / `карточка бизнес-сценария`. Teach “show → accept exact hash or edit → re-show after edit,” and state that acceptance does not run the agent or approve a result. Do not blanket replace historical/legacy language and do not restore preview/clarify/editor flows.

## Test Pattern Assignments

### `test/contracts.test.ts`

**Analog:** table-like negative schema assertions and synthetic answer grounding (lines 215-231).

```typescript
assert.throws(() => validatePreparation(preparation([invented]), [source], 'evaluate'), /a999/);
const curated = card({ provenance: 'curated', requirementIds: [], user: { ...user, answers: [...] } });
```

Add the smallest compatibility assertions: old records without `acceptedDraftHash` parse as unaccepted; a record with a valid hash round-trips. Keep generated-only rubric/answer invariants separate from legacy/curated compatibility.

### `test/experiment.test.ts`

**Analog:** exact-hash acceptance/edit lifecycle (lines 301-345), serialized mutation race (348-381), repeat reset (598-620).

```typescript
const originalHash = draftHash(draft);
await assert.rejects(lab.start(draft.id, { approved: true, expectedHash: 'stale' }), /версии/);
const edited = await lab.updateDraft(draft.id, originalHash, { scenarios: cards });
assert.notEqual(draftHash(edited), originalHash);
await assert.rejects(lab.updateDraft(draft.id, originalHash, { scenarios: cards }), /Черновик изменился/);
```

Add one focused lifecycle test: accept exact hash, zero target/model calls, save allowed; stale/missing acceptance rejects; edit clears; `freshDraft` paths clear; loaded legacy JSON is unaccepted. Reuse the existing runtime counters and temporary directories.

### `test/pi.test.ts`

**Analog:** scripted bounded repair and external rubric decoration (lines 505-529, 624-691, 774-785).

```typescript
assert.match(JSON.stringify(f.requests), /not in knows, facts or opening/);
assert.deepEqual(prepared.scenarios[0]!.user.knows, ['Last four digits 4321']);
assert.equal(prepared.scenarios[0]!.metrics!.filter(m => m.subject === 'simulator').length, 1);
```

Extend the existing fixture, not the harness: exact/case-insensitive supported token enrichment, substring collision, multiple unknown tokens, owner/user evidence inclusion, assistant/outcome exclusion, 21-value repair, exactly one pre-harness `goal_attainment`, and conditional harness metrics.

### `test/quality.test.ts`

**Analog:** row identity cases (lines 121-149).

```typescript
test('same metric labels with different pass criteria do not merge', () => {
  // ...
  assert.deepEqual(q.metrics.filter(m => m.kind === 'rubric').map(m => [m.passed, m.failed]), [[1, 0], [0, 1]]);
});
```

Add one test proving reserved IDs merge across generated definitions while two owner rubrics with the same label/ID but different full definitions remain fingerprint-separated.

### `test/extension.test.ts`

**Analog:** registered tool harness and confirm spy (lines 13-57), edit/stale checks (100-175).

```typescript
const plans: string[] = [];
let consent = false;
const ctx = { hasUI: true, ui: { confirm: async (_title, plan) => { plans.push(plan); return consent; } } };
const cancelled = await call('agent_lab_run', { id: draft.id, expectedHash: draft.draftHash });
assert.equal((await call('agent_lab_inspect', { id: draft.id })).trialCount, 0);
```

Reuse this spy to assert the four full fields, concrete observation channel, short version, sanitization, decline/edit state, accepted hash, and zero trials/target calls/suite files. Do not add a TUI fixture framework.

### `test/workflow.test.ts`

**Analog:** real suite round-trip plus CLI subprocess (lines 186-200).

```typescript
const suite = await lab.saveSuite(after.id, join(directory, '.evals', 'regression.json'));
const cli = spawnSync(process.execPath, [resolve('dist/cli.js'), 'evaluate', '--input', stale, '--yes', '--data-dir', join(directory, 'ci')], { encoding: 'utf8' });
assert.equal(cli.status, 0, cli.stderr);
```

Add the narrow CLI contract: without `--yes`, the exact test/hash is printed and no acceptance/run occurs; with `--yes`, that displayed hash is accepted but Phase 3 still does not run the target. Keep actual execution expectations for Phase 4.

## Shared Patterns

### Aggregate owns lifecycle state

**Source:** `src/experiment.ts:98-108`, `src/experiment.ts:189-260`  
**Apply to:** acceptance, edit invalidation, fresh-copy invalidation, suite gate.

All lifecycle mutations go through `ExperimentLab.change()`. Adapters pass an expected hash and display results; they do not own durable approval state.

### Validation rejects; repair rewrites the whole candidate

**Source:** `src/pi.ts:296-339`, `src/pi.ts:441-507`  
**Apply to:** rubric normalization, observation-channel checks, answer-token enrichment, 20-value limit.

Return one precise issue into the existing bounded `ask/jsonResponse` session. Never silently coerce or truncate semantic test content.

### Pure projection, escaped at the surface

**Source:** `src/quality.ts:169-182`, `extensions/agent-lab.ts:40-53`  
**Apply to:** shared compact test block in Pi and CLI.

Generate one plain semantic projection from the record; use `safeText()` at the Pi boundary and ordinary stdout for CLI. No UI kit or presentation subsystem.

### Tests use real seams with tiny fakes

**Source:** `test/experiment.test.ts:301-365`, `test/extension.test.ts:13-57`, `test/workflow.test.ts:186-200`  
**Apply to:** all Phase 3 lifecycle and surface assertions.

Count real runtime/target calls, spy on native confirm, inspect stored JSON, and spawn the compiled CLI where the CLI contract matters.

## No Analog Found

None. Every planned change extends an existing tracked module and test harness. A new approval subsystem, editor, UI surface, or presentation file would be speculative duplication.

## Planner Guardrails

- Phase 3 ends after exact-draft acceptance or an editable decline; no `TargetSession`, simulator, judge, trial, artifact export, or regression write occurs from accept/edit.
- One visible acceptance candidate means exactly one scenario. Reject ambiguity; do not silently select or trim.
- `acceptedDraftHash === draftHash(record)` is the only authorization invariant. Truthiness, `reviewedAt`, `reviewMode`, and timestamps are insufficient.
- Preserve `writeFile(..., { flag: 'wx', mode: 0o600 })` and optimistic stale-hash rejection.
- Do not touch `docs/superpowers/plans/2026-09-15-mvp-cut.md`; it contains user changes and is source-plan history.
- No new dependency and no new source module unless the post-Phase-2 code makes reuse impossible; `src/quality.ts` is the existing neutral projection seam.

## Metadata

**Analog search scope:** `src/`, `extensions/`, `skills/agent-builder/`, `test/`  
**Files scanned:** 13 tracked files plus Phase 3 planning inputs  
**Pattern extraction date:** 2026-09-15

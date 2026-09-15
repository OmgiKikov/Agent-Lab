# Phase 2: Понимание агента и гипотеза — Pattern Map

**Mapped:** 2026-09-15  
**Files analyzed:** 16 existing files to modify  
**Analogs found:** 16 / 16

The minimum-diff implementation extends the files that already own each seam. Add no score service, DTO family, hypothesis store, dashboard, or dependency.

## File Classification

| New/Modified File | Role | Data Flow | Closest tracked analog | Match |
|---|---|---|---|---|
| `src/contracts.ts` | model / utility | transform | `src/contracts.ts:295-346` (`goldenToScenario`, `goalToScenario`) | exact |
| `src/experiment.ts` | application service | batch / event-driven persistence | `src/experiment.ts:281-347` (`reassess`) | exact |
| `src/judge.ts` | utility / adapter | transform / request-response | `src/judge.ts:38-49` (`judgeInput`) | exact |
| `src/pi.ts` | provider | request-response | `src/pi.ts:519-528` (goals request projection) | exact |
| `src/prompts.ts` | config | request-response | `src/prompts.ts:56-64,77-78` | exact |
| `src/cli.ts` | controller | file-I/O / request-response | `src/cli.ts:155-164,182-192` | exact |
| `extensions/agent-lab.ts` | controller / component | request-response / event-driven | `extensions/agent-lab.ts:138-207,374-399` | exact |
| `skills/agent-builder/SKILL.md` | config | conversational | existing working protocol and recorded-dialogue sections | exact |
| `test/contracts.test.ts` | test | transform | existing schema/converter assertions | exact |
| `test/experiment.test.ts` | test | batch / persistence | `test/experiment.test.ts:428-457,521-563` | exact |
| `test/judge.test.ts` | test | transform | `test/judge.test.ts:67-79` | exact |
| `test/pi.test.ts` | test | request-response | `test/pi.test.ts:584-612,655-675` | exact |
| `test/workflow.test.ts` | test | file-I/O / subprocess | `test/workflow.test.ts:203-237,268-278` | exact |
| `test/extension.test.ts` | test | request-response / UI event | `test/extension.test.ts:146-176,370-390` | exact |
| `src/quality.ts` | utility | transform | current `qualitySummary` / `qualityLines` projections | role-match |
| `src/artifacts.ts` | utility | file-I/O | `src/artifacts.ts:24-81` | exact |

All named analogs were verified with `git ls-files`; no `.gsd` mirror path is used.

## Pattern Assignments

### `src/contracts.ts` — reserved rubrics and pure dialogue conversion

**Analog:** `src/contracts.ts:295-346`. Keep conversion beside the schemas it transforms and return plain validated shapes; do not create a mapper class.

```ts
export function goldenToScenario(c: GoldenCase): Omit<Scenario, 'split'> {
  return {
    id: c.id, familyId: c.familyId ?? c.id,
    provenance: 'curated', tier: c.tier,
    user: { goal: c.goal, facts: c.facts, behavior: c.behavior, opening: c.opening },
    initialState: c.initialState, checks: c.checks,
    successCriteria: c.successCriteria, metrics: c.metrics,
  };
}
```

Follow the same shape for `dialogueToScenario(dialogue, goal, successCriteria, ...)` and `dialogueToTrial(...)`. Expected behavior must be explicit arguments, never inferred from assistant messages or `dialogue.outcome`. Build the scripted follow-ups only from user messages after the opening, but preserve the trace separately and exactly:

```ts
const events = dialogue.messages.map((message, seq) => ({
  seq, type: message.role, text: message.content,
}));
```

Use existing literals from `scenarioSchema` and `Trial` (`production`, `scripted`, `missing`, `partial`, `ungraded`) and `emptyUsage()`. Export fixed `goalAttainment` and `replyQuality` `Rubric` values next to `promptCompliance` (`src/contracts.ts:165-182`). Do not attach `simulatorFidelity` or `simulatorChecks` to imported traces. Raise the existing 40-card schema ceilings consistently to the already-public dialogue maximum; never truncate.

### `src/experiment.ts` — seed, then reuse reassessment

**Analog:** `src/experiment.ts:281-347`. `score()` belongs on `ExperimentLab`, because this class already owns locking, schema-valid records, background work, checkpoints, and immutable reassessment.

```ts
const draft = await lab.reassess(id, input);
await lab.waitForIdle();
const record = await lab.get(draft.id);
```

Copy the existing initial `Experiment` literal from `create()` only through the smallest shared helper if both callers can use it unchanged. Score should persist one seed scenario and trial per dialogue, then let adapters invoke `reassess`; it must not enter `runSuite` (`src/experiment.ts:496-559`) or any preflight/open-target/user-turn path. Preserve the current background contract and progress checkpoints.

Reuse reassessment's copied evidence and per-trial error isolation (`src/experiment.ts:310-344`): code-only runs exact checks without a runtime and records that semantic rubrics were not evaluated. In model mode call the existing `nameFailureModes()` after assessment. For imported/reassessed evidence, derive the clustering prompt from saved `record.sources`:

```ts
const savedPrompt = record.sources.find(source => source.kind === 'prompt')?.content;
```

Do not read a mutable `target.promptFile` for historical imported evidence. Preserve `nameFailureModes`' existing catch-to-`limitations` behavior (`src/experiment.ts:607-615`). Clamp computed duration to `settingsSchema`'s 14,400,000 ms maximum.

### `src/judge.ts` and `src/prompts.ts` — unknown means unknown

**Analog:** `src/judge.ts:38-49` plus `src/prompts.ts:56-64`. Keep the trust boundary in the payload projection and evaluator protocol, not in presentation code.

```ts
const finalState = trial.observation?.state === 'missing' ? null : trial.finalState;
```

Bump the judge protocol and explicitly require `goal_attainment=unknown` when completion depends on an action whose effect is not observed. Assistant prose proves only what was said. Keep `reply_quality` independent. Reuse `ASSESS_ROLE`'s citation and partial-observation rules; do not add a second judge prompt.

For `GOALS_ROLE`, retain the existing user-turn-only projection but remove logged outcome as an expectation input. Add owner materials/sources to the request. Extract exactly one goal for each scored dialogue instead of using the general grouping behavior.

### `src/pi.ts` — grounded goal request

**Analog:** current goals call at `src/pi.ts:519-528`. Keep the provider invocation in the existing runtime role and pass a minimal projection: sources/materials plus the current dialogue's user turns and ID. Assistant turns and saved outcome may remain stored evidence but must not enter goal/success-criterion generation. Validate returned IDs/opening with `validateObservedGoals` rather than duplicating checks.

### `src/cli.ts` — thin `score` command

**Analog:** build import at `src/cli.ts:182-192` and reassess/export at `src/cli.ts:155-164`.

```ts
const dialogues = await readData(values.input, 'dialogues');
const seed = await lab.score(input);
await lab.waitForIdle();
const draft = await lab.reassess(seed.id, { codeOnly: values['code-only'] });
await lab.waitForIdle();
const bundle = await evidenceBundle(await lab.get(draft.id), lab.store);
const artifacts = await exportArtifacts(bundle, directory);
```

Add `score` to the existing command dispatch and help text. Require `--input`, `--task`, and `--yes` for model scoring; allow `--code-only` without confirmation. Reuse `readData`, `qualityLines`/`qualitySummary`, `evidenceBundle`, and `exportArtifacts`. On read/validation failure, fail the whole command and state that the agent was not run. No score-specific renderer.

### `extensions/agent-lab.ts` — one tool, one native confirmation

**Analog:** build parameter/reader pattern at `extensions/agent-lab.ts:138-207` and reassess confirmation at `extensions/agent-lab.ts:374-399`.

```ts
if (!input.codeOnly) {
  if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Оценка моделью требует native Pi confirmation.');
  if (!await ctx.ui.confirm(
    'Оценить записанные диалоги?',
    safeText(`Агент и симулятор не запускаются. До ${count} модельных вызовов.`),
  )) return cancelledResult;
}
```

Extend `agent_lab_build`'s mode union with `score`; reuse its `dialoguesFile` reader, `safeText`, abort handling, single updating progress callback, lab lifecycle, and artifact output. Confirmation occurs immediately before judge spending. Code-only makes zero runtime/model calls and says clusters were not built. Use the fixed four-block order from UI-SPEC; at most three bullets in each evidence section, one hypothesis, then `Проверим?`. Do not add a board view, modal, hotkey, or hypothesis entity.

### `skills/agent-builder/SKILL.md` and conversation prompt

**Analog:** existing conversation protocol in the same skill and the injected system prompt at `extensions/agent-lab.ts:133-136`. Add a short mandatory pre-test gate:

```text
ТРЕБОВАНИЯ
• <owner-backed expectation + source>

НАБЛЮДАЕМОЕ
• <repository/log fact + file or dialogue/event>

НЕИЗВЕСТНО
• <missing evidence>

ГИПОТЕЗА
<one requirement-backed failure mechanism>

Проверим?
```

Require sufficient owner-backed expectation plus a concrete observation; otherwise use the UI-SPEC empty state. A yes hands the accepted hypothesis to Phase 3; it does not persist or build a test in this phase.

### `src/quality.ts` and `src/artifacts.ts` — reuse projections

**Analog:** `src/artifacts.ts:24-81`. Continue producing every format from one cloned `EvidenceBundle`, and use `exportArtifacts`' create-new files plus cleanup-on-error behavior. If compact score copy needs a helper, add the smallest pure projection to `quality.ts`; do not fork reports or artifact formats.

### Existing test files — extend, do not scaffold

Use `node:test` and existing fixtures. Keep each requirement at the closest seam:

- `test/contracts.test.ts`: exact one-to-one scenario/trial mapping, zero-user-turn rejection/handling, all event tuples in source order, reserved metrics.
- `test/experiment.test.ts`: no target/simulator calls (inject throwers), 40/41/public-max boundary, seed then reassess, saved prompt for clusters, code-only zero model calls.
- `test/judge.test.ts`: mirror `test/judge.test.ts:67-79`; missing state plus claimed action stays unknown under protocol 8, while reply quality is separately assessable.
- `test/pi.test.ts`: mirror the observed-goals request tests at `test/pi.test.ts:584-612`; vary assistant replies and `outcome` while asserting identical expectation payload, and assert sources/user turns are present.
- `test/workflow.test.ts`: mirror JSONL diagnostics at `test/workflow.test.ts:268-278` and reassessment at `203-237`; add CLI score success, malformed-file failure, and code-only subprocess cases.
- `test/extension.test.ts`: mirror tool registry/intake tests at `146-176,370-390`; cover `mode:'score'`, native confirm/cancel, no-UI refusal, progress replacement, fixed four-block copy, and skill/system prompt contract.

## Shared Patterns

### Validation and file input

**Source:** `src/imports.ts:1-13`

```ts
export async function readData(path: string, kind: 'golden' | 'dialogues') {
  const raw = await readFile(path, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 5_000_000) throw new Error('Файл больше 5 МБ.');
  // JSON or ordered JSONL, then z.array(schema).max(200).parse(...)
}
```

Apply to both CLI and Pi. Keep strict Zod schemas at all external/persisted boundaries.

### Application ownership and errors

All mutations route through `ExperimentLab`; adapters open/init/wait/get/close. Per-dialogue assessment errors remain attached to trials, but import validation is all-or-nothing. `nameFailureModes` failure becomes a limitation; cancellation/abort uses the existing listener/finally cleanup.

### Safe terminal rendering

**Source:** `extensions/agent-lab.ts` existing `safeText` usage (`191-192`, `388`). Apply it to every external source, event quote, validation reason, progress line, and confirmation. Keep source links beside truncated 240-character previews. Status always has literal text, not color alone.

### Evidence and artifacts

**Source:** `src/artifacts.ts:24-81`. Clone persisted evidence, preserve trace journals, and export from the same bundle used by both surfaces. Existing artifact paths are supporting evidence; the conversational four-block summary is primary.

## No Analog Found

None. Every proposed change has a live tracked owner and a close pattern. This is a strong signal not to add any new runtime or test file.

## Explicitly Skipped

- New score service/repository/DTOs: existing contracts + `ExperimentLab` already own the flow.
- Persisted hypothesis workflow: locked out of scope until owner confirmation.
- Dashboard or new Pi screen: existing conversation, native confirmation, and artifacts cover the product surface.
- New dependency: Node, Zod, Pi/TypeBox, and `node:test` already cover the work.
- `docs/superpowers/plans/2026-09-15-mvp-cut.md`: explicitly excluded and already user-modified.

## Metadata

**Analog search scope:** `src/`, `extensions/`, `skills/`, `test/`  
**Tracked-source gate:** passed for every analog  
**Files scanned:** 44 candidate files; 16 owners/analogs inspected  
**Pattern extraction date:** 2026-09-15

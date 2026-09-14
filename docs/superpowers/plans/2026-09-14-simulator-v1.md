# Simulator v1 and Prompt MVP Hooks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the user simulator the measured centre of Agent Lab: structured user state in cards, code-checked simulator failure modes, a per-run simulator scorecard, mode-value and paired-family statistics, external world state per card, and the release/prompt hooks needed to run the prompt-improvement loop against the real AIGW agent.

**Architecture:** No new seams. Cards carry `knows`/`cannotKnow`/`answers` and `initialState.external`; `evaluation.ts` computes `trial.simulatorChecks` after the dialogue loop with pure functions from a new `src/simulator.ts`; shared outcome helpers move from `comparison.ts` into `src/outcomes.ts` so `simulator.ts` (checks + scorecard + mode value) and `comparison.ts` (verdict, evidence, run delta) import them without a cycle; `experiment.ts` runs an optional release hook before the suite, clusters from one failure and validates prompt quotes; reports, board and CLI render the new blocks from the single `evidenceSummary` snapshot.

**Tech Stack:** TypeScript 5.9 strict, Node 22 (`node:test` via `tsx`), zod 4, `@earendil-works/pi-coding-agent` 0.85.1, Python 3.12 for the AIGW local layer.

**Spec:** `docs/superpowers/specs/2026-09-14-simulator-v1-design.md` (read it first; every task below cites its section).

## Global Constraints

- Node `>=22.19.0`; no new runtime dependencies (`package.json` dependencies stay exactly: pi-coding-agent, pi-tui, typebox, zod).
- Pi is the only interface: no web app, no server. Nested model sessions keep no filesystem/shell tools.
- Methodology lives in code, schemas and prompts. Links only in docs for humans.
- Human approves drafts and reviews results; a model can never record a human verdict. Code checks never change `trial.outcome`.
- Every number is labelled observed/confirmed and synthetic/production; heuristic checks say "подозрение".
- Language: user-facing strings and thrown errors in Russian; code identifiers, comments and model prompts in English.
- `npm test` green after every task; commit after every task with the message given in the task. Never `git stash`.
- Compiled extensions import from `../dist/*.js`: run `npm run build` before tests that touch `extensions/` (`npm test` builds first).
- Run tests with `npm test` (full) or `npx tsx --test test/<file>.test.ts` (one file, after `npm run build`).
- Files stay under 1000 lines; `comparison.ts` must not grow past its current 894 lines, which is why Task 6 extracts `src/outcomes.ts`.

---

## File Structure

| File | Responsibility after this plan |
|---|---|
| `src/contracts.ts` (modify) | Schemas: user state fields, `initialState.external`, `SimulatorCheck` + `trial.simulatorChecks`, `target.release`, `releaseLog`, `promptQuotes`, `valueTokens`, answers rule in `validatePreparation`, prompt-aware `validateFailureModes` |
| `src/simulator.ts` (create) | Pure simulator code checks (`simulatorChecks`), scorecard (`simulatorSummary`), mode value (`modeValue`) |
| `src/outcomes.ts` (create) | Helpers moved out of `comparison.ts`: `observedRecord`, `latestHumanReviews`, `graded`, `measured`, `agentRubricResult`, `simulatorUsable`, `automaticTrialResult`, `trialAssessmentComplete`, `isAgentFailure`, `runningPhases`, `mean` |
| `src/comparison.ts` (modify) | Re-exports from outcomes; `verdictSummary` counts code-flagged simulator; `evidenceSummary` adds `simulator` and `modeValue`; `compareRuns` adds `delta` |
| `src/evaluation.ts` (modify) | Computes `trial.simulatorChecks`; reason suffix when `external` not confirmed |
| `src/prompts.ts` (modify) | `USER_STATE_CLAUSE`, simulator rules for knows/answers/cannotKnow, prompt quotes in `FAILURE_MODES_ROLE`, external line in `EXTERNAL_CARDS_CLAUSE` |
| `src/pi.ts` (modify) | Simulator input gets user state; cards review checks answers; `failureModes` accepts `prompt` and validates quotes |
| `src/demo.ts` (modify) | Demo cards carry `knows`/`answers`; demo simulator answers from `answers` |
| `src/experiment.ts` (modify) | Release hook before suite, single-failure clustering with prompt, reassess recomputes simulator checks, human verdicts on simulator checks, external-state limitation |
| `src/targets.ts` (modify) | `ensureExecutable` helper, preflight of `release`, `runRelease` |
| `src/connection.ts` (modify) | `resolveTarget`/`portableTarget` handle `release.cwd`/`release.command` |
| `src/report.ts`, `extensions/cards.ts`, `extensions/editor.ts`, `extensions/agent-lab.ts`, `src/cli.ts` (modify) | Render simulator checks, scorecard, mode value, delta; edit new card fields; annotate simulator checks |
| `test/simulator.test.ts` (create), other `test/*.test.ts` (modify), `test/fixtures/stdio-agent.mjs` (modify) | Regressions listed per task |
| `docs/REFERENCE.md`, `docs/WORKFLOWS.md`, `docs/EVALS-METHOD.md`, `CONTEXT.md`, `README.md`, `skills/agent-builder/SKILL.md`, `examples/echo-agent.py` (modify) | Contract and method docs |
| `~/Desktop/aigw-local/local/{mocks/server.py, agent_lab_target.py, test_agent_lab_target.py, release.sh}`, `LOCAL.md` (separate repo) | Per-trace SBE overrides, adapter metadata, release script |

---

### Task 1: Contracts — user state, external world, simulator checks, release, prompt quotes

**Files:**
- Modify: `src/contracts.ts` (userSchema ~164, worldSchema ~87, targetSchema ~60-79, goldenCaseSchema ~230-251, Trial ~344-352, trialSchema ~456-467, failureModeSchema ~484-498, Experiment ~430-453, experimentSchema ~500-522, Runtime ~550-559, validatePreparation ~568-636)
- Test: `test/contracts.test.ts`

**Interfaces:**
- Produces (used by every later task):
  - `userSchema` fields `knows?: string[]`, `cannotKnow?: string[]`, `answers?: { ifAsked: string; reply: string }[]`
  - `worldSchema.external?: Record<string, unknown>` (serialized ≤ 20000 chars)
  - `export const SIMULATOR_CHECK_IDS = ['simulator_leak', 'simulator_fabrication', 'simulator_loop'] as const; export type SimulatorCheckId; export interface SimulatorCheck { id: SimulatorCheckId; description: string; passed: boolean; evidence: string; seq?: number; heuristic: boolean }`
  - `Trial.simulatorChecks?: SimulatorCheck[]` (+ `trialSchema`)
  - `export interface ReleaseLog { command: string; exitCode: number | null; signal: string | null; stdout: string; stderr: string; startedAt: string; durationMs: number }`, `Experiment.releaseLog?: ReleaseLog` (+ schema)
  - `target.release?: { command: string; args: string[]; cwd?: string; timeoutMs: number }` on http/module/command; `export type ReleaseHook = NonNullable<Extract<Target, { kind: 'command' }>['release']>`
  - `failureModeSchema.promptQuotes?: string[]`; `validateFailureModes(modes, trials, prompt?: string)`
  - `Runtime.failureModes?(input: { task: string; failures: [...]; prompt?: string }, ctx)`
  - `export function valueTokens(text: string): Set<string>`
  - `goldenCaseSchema` accepts `knows`, `cannotKnow`, `answers`; `goldenToScenario` copies them

- [ ] **Step 1: Write the failing tests** — append to `test/contracts.test.ts`:

```ts
import { SIMULATOR_CHECK_IDS, trialSchema, valueTokens, worldSchema } from '../src/contracts.js';

test('user state fields are optional, unique and travel through golden cases', () => {
  const parsed = validatePreparation(preparation([card({ user: { ...user, knows: ['Card ends with 4321', 'Two cards'], cannotKnow: ['Backend error reason'],
    answers: [{ ifAsked: 'last four digits', reply: 'It ends with 4321.' }] } })]), [source], 'evaluate').scenarios[0]!;
  assert.deepEqual(parsed.user.knows, ['Card ends with 4321', 'Two cards']);
  assert.deepEqual(parsed.user.answers, [{ ifAsked: 'last four digits', reply: 'It ends with 4321.' }]);
  assert.throws(() => validatePreparation(preparation([card({ user: { ...user, knows: ['A101', 'a101'] } })]), [source], 'evaluate'), /Duplicate known facts/);
  const golden = goldenCaseSchema.parse({ id: 'g', goal: 'Block a lost card', opening: 'I lost my card', successCriteria: 'blocked',
    knows: ['Last four digits 4321'], cannotKnow: ['Why the backend refused'], answers: [{ ifAsked: 'digits', reply: '4321' }] });
  const scenario = goldenToScenario(golden);
  assert.deepEqual([scenario.user.knows, scenario.user.cannotKnow, scenario.user.answers], [['Last four digits 4321'], ['Why the backend refused'], [{ ifAsked: 'digits', reply: '4321' }]]);
});

test('synthetic answers may only reveal values the user already knows', () => {
  const known = card({ user: { ...user, opening: 'Move my appointment', facts: 'Appointment A103', answers: [{ ifAsked: 'ID', reply: 'It is A103.' }] } });
  assert.doesNotThrow(() => validatePreparation(preparation([known]), [source], 'evaluate'));
  const invented = card({ user: { ...user, answers: [{ ifAsked: 'ID', reply: 'It is A999.' }] } });
  assert.throws(() => validatePreparation(preparation([invented]), [source], 'evaluate'), /a999/);
  const curated = card({ provenance: 'curated', requirementIds: [], user: { ...user, answers: [{ ifAsked: 'ID', reply: 'It is A999.' }] } });
  assert.doesNotThrow(() => validatePreparation(preparation([curated]), [source], 'evaluate'));
  assert.deepEqual([...valueTokens('Card 4321, time 14:00. Code 202-7 and A103.')].sort(), ['14:00', '202-7', '4321', 'a103']);
  assert.deepEqual([...valueTokens('two cards, no digits here')], []);
});

test('external world state is opaque, size-bounded and never part of the sandbox contract', () => {
  const world = worldSchema.parse({ records: {}, writableFields: [], transientFailures: 0, external: { cards: [{ id: 'c1', status: 'active' }] } });
  assert.deepEqual(world.external, { cards: [{ id: 'c1', status: 'active' }] });
  assert.equal(worldSchema.safeParse({ records: {}, writableFields: [], transientFailures: 0, external: { blob: 'x'.repeat(20001) } }).success, false);
  assert.equal(worldSchema.parse({ records: {}, writableFields: [], transientFailures: 0 }).external, undefined);
});

test('simulator checks, release hooks, release logs and prompt quotes have schemas', () => {
  assert.deepEqual([...SIMULATOR_CHECK_IDS], ['simulator_leak', 'simulator_fabrication', 'simulator_loop']);
  const trial = trialSchema.parse({ id: 't', revisionId: 'r', scenarioId: 's', familyId: 'f', repeat: 0, split: 'dev', manifestHash: 'h', outcome: 'ungraded', reason: '', checks: [], events: [],
    initialState: { records: {}, writableFields: [], transientFailures: 0 }, finalState: { records: {}, writableFields: [], transientFailures: 0 }, usage: emptyUsage(), elapsedMs: 1,
    simulatorChecks: [{ id: 'simulator_leak', description: 'd', passed: false, evidence: 'e', seq: 3, heuristic: false }] });
  assert.equal(trial.simulatorChecks![0]!.seq, 3);
  assert.equal(trialSchema.safeParse({ ...trial, simulatorChecks: [{ id: 'other', description: 'd', passed: true, evidence: 'e', heuristic: false }] }).success, false);
  const target = targetSchema.parse({ kind: 'command', command: 'python3', args: ['/abs/agent.py'], release: { command: './release.sh', args: ['candidate'] } });
  assert.deepEqual(target.kind === 'command' ? target.release : undefined, { command: './release.sh', args: ['candidate'], timeoutMs: 120000 });
  assert.equal(targetSchema.safeParse({ kind: 'http', url: 'http://127.0.0.1:1/a', release: { command: 'x', cwd: 'relative' } }).success, false);
  assert.equal(targetSchema.safeParse({ kind: 'sandbox', release: { command: 'x' } }).success, false);
  const record = experimentSchema.parse({ ...legacyRecord(), releaseLog: { command: './release.sh', exitCode: 0, signal: null, stdout: 'ok', stderr: '', startedAt: 'now', durationMs: 12 } });
  assert.equal(record.releaseLog?.exitCode, 0);
  const trials = [{ id: 't1', outcome: 'fail' } as unknown as Parameters<typeof validateFailureModes>[1][number]];
  const mode = { id: 'm', name: 'Нашёл статью и отправил на линию', description: 'd', trialIds: ['t1'], promptQuotes: ['always hand off to the hotline'] };
  validateFailureModes([mode], trials, 'You must always hand off to the hotline when unsure.');
  assert.throws(() => validateFailureModes([mode], trials), /промпт не передавался/);
  assert.throws(() => validateFailureModes([mode], trials, 'A different prompt.'), /дословно/);
});
```

Also add `trialSchema, valueTokens, worldSchema, SIMULATOR_CHECK_IDS` to the existing import list at the top of the file (merge with the first import statement; do not create a second import of `../src/contracts.js` if lint complains — either form compiles).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && npx tsx --test test/contracts.test.ts`
Expected: FAIL — `valueTokens`/`SIMULATOR_CHECK_IDS` not exported; `unrecognized_keys` for `knows`, `external`, `release`, `promptQuotes`.

- [ ] **Step 3: Implement the schemas** in `src/contracts.ts`:

Add after `const unique = ...` (line 10):

```ts
/**
 * Value-like tokens: runs of letters/digits/`:./-` that contain a digit and are at least three
 * characters long after trailing punctuation is trimmed, lower-cased. `4321`, `A103`, `14:00`,
 * `202-7` and `11.03.2024` are tokens; `two cards` has none. Used by the answers rule and by
 * the fabrication heuristic, so both sides of the simulator agree on what a "value" is.
 */
const VALUE_TOKEN = /[A-Za-zА-Яа-яЁё0-9:./-]+/g;
export function valueTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.match(VALUE_TOKEN) ?? []) {
    const token = raw.replace(/[.,:]+$/, '').toLocaleLowerCase();
    if (token.length >= 3 && /\d/.test(token)) tokens.add(token);
  }
  return tokens;
}
```

Replace `worldSchema`:

```ts
export const worldSchema = z.strictObject({
  records: z.record(identifier, z.record(identifier, scalarSchema)).refine(v => Object.keys(v).length <= 30, 'Too many records'),
  writableFields: z.array(identifier).max(16),
  transientFailures: z.number().int().min(0).max(2).default(0),
  /** Opaque state for the agent's own test environment (cards, contracts, tool fixtures). The sandbox ignores it; adapters must apply and confirm it. */
  external: z.record(z.string().max(120), z.unknown()).optional(),
}).superRefine((v, ctx) => {
  if (v.external !== undefined && JSON.stringify(v.external).length > 20000) ctx.addIssue({ code: 'custom', message: 'External state exceeds 20,000 characters', path: ['external'] });
});
```

Add the release schema before `targetSchema` and attach it to the three external variants:

```ts
const absolutePath = z.string().min(1).max(4000).refine(p => p.startsWith('/'), 'Absolute path required');
/** Deploys the version under test before a run. Identity still comes from the adapter's `version`; the hook only performs the rollout. */
const releaseSchema = z.strictObject({
  command: z.string().min(1).max(4000), args: z.array(z.string().max(4000)).max(50).default([]),
  cwd: absolutePath.optional(), timeoutMs: z.number().int().min(1000).max(600000).default(120000),
}).optional();
```

and inside each of the `http`, `module`, `command` objects add `release: releaseSchema,` (the `sandbox` object stays `{ kind: z.literal('sandbox') }`). After `export type Target`, add:

```ts
export type ReleaseHook = NonNullable<Extract<Target, { kind: 'command' }>['release']>;
export interface ReleaseLog { command: string; exitCode: number | null; signal: string | null; stdout: string; stderr: string; startedAt: string; durationMs: number }
const releaseLogSchema = z.strictObject({ command: z.string().max(8000), exitCode: z.number().int().nullable(), signal: z.string().max(40).nullable(), stdout: z.string().max(4000), stderr: z.string().max(4000), startedAt: text, durationMs: z.number().nonnegative() });
```

Replace `userSchema`:

```ts
export const userSchema = z.strictObject({
  goal: text.max(3000), facts: text.max(5000), behavior: text.max(2000), opening: text.max(3000),
  maxFollowUps: z.number().int().min(0).max(15).optional(),
  persona: text.max(2000).optional(), characteristics: z.array(text.max(300)).max(12).optional(),
  script: z.array(z.string().min(1).max(3000).refine(v => !!v.trim(), 'Empty user message')).max(15).optional()
    .describe('Follow-up messages AFTER opening, never include opening itself. [] means opening only. Every line must fit maxFollowUps and maxTurns.'),
  /** Atomic facts the user can state, with their exact values. */
  knows: z.array(text.max(300)).max(20).refine(v => unique(v.map(x => x.toLocaleLowerCase())), 'Duplicate known facts').optional(),
  /** What the user cannot know, in words: backend reasons, correct business answers, hidden state. */
  cannotKnow: z.array(text.max(300)).max(20).optional(),
  /** Complete replies to clarifications the agent is likely to ask; the simulator uses them verbatim. */
  answers: z.array(z.strictObject({ ifAsked: text.max(300), reply: text.max(1000) })).max(20).optional(),
});
```

In `goldenCaseSchema` add `knows: userSchema.shape.knows, cannotKnow: userSchema.shape.cannotKnow, answers: userSchema.shape.answers,` and in `goldenToScenario` add to `user`: `...(c.knows ? { knows: c.knows } : {}), ...(c.cannotKnow ? { cannotKnow: c.cannotKnow } : {}), ...(c.answers ? { answers: c.answers } : {}),`.

Add the simulator check types after `CheckResult`:

```ts
export const SIMULATOR_CHECK_IDS = ['simulator_leak', 'simulator_fabrication', 'simulator_loop'] as const;
export type SimulatorCheckId = typeof SIMULATOR_CHECK_IDS[number];
/** A code predicate over the simulated user's own replies. Never an agent grade; never shown to the judge. */
export interface SimulatorCheck { id: SimulatorCheckId; description: string; passed: boolean; evidence: string; seq?: number; heuristic: boolean }
```

In `interface Trial` add `simulatorChecks?: SimulatorCheck[];` after `checks: CheckResult[];`. In `trialSchema` add:

```ts
  simulatorChecks: z.array(z.strictObject({ id: z.enum(SIMULATOR_CHECK_IDS), description: z.string(), passed: z.boolean(), evidence: z.string(), seq: z.number().int().nonnegative().optional(), heuristic: z.boolean() })).max(12).optional(),
```

In `interface Experiment` add `releaseLog?: ReleaseLog;` and in `experimentSchema` add `releaseLog: releaseLogSchema.optional(),`.

Replace `failureModeSchema` and `validateFailureModes`:

```ts
export const failureModeSchema = z.strictObject({
  id: identifier, name: text.max(160), description: text.max(2000),
  stage: text.max(80).optional(), trialIds: z.array(identifier).min(1).max(200),
  /** Verbatim fragments of the agent's prompt that govern the broken behaviour; empty when no fragment does. */
  promptQuotes: z.array(text.max(300)).max(5).optional(),
});
export type FailureMode = z.infer<typeof failureModeSchema>;
export function validateFailureModes(modes: FailureMode[], trials: Trial[], prompt?: string): void {
  const failed = new Set(trials.filter(t => t.outcome === 'fail' || t.outcome === 'ungraded'
    || t.outcome === 'pass' && t.assessments?.some(a => a.result === 'fail')).map(t => t.id));
  if (!unique(modes.map(m => m.id))) throw new Error('Названия провалов повторяются.');
  for (const mode of modes) {
    if (!unique(mode.trialIds)) throw new Error(`Кластер ${mode.id} ссылается на один диалог дважды.`);
    const unknown = mode.trialIds.filter(id => !failed.has(id));
    if (unknown.length) throw new Error(`Кластер ${mode.id} ссылается на диалоги, которые не проваливались: ${unknown.join(', ')}`);
    for (const quote of mode.promptQuotes ?? []) {
      if (prompt === undefined) throw new Error(`Кластер ${mode.id} цитирует промпт, но промпт не передавался.`);
      if (!prompt.includes(quote)) throw new Error(`Кластер ${mode.id} цитирует фрагмент, которого нет дословно в промпте: «${quote.slice(0, 80)}»`);
    }
  }
}
```

In `interface Runtime` change the `failureModes` signature to `failureModes?(input: { task: string; failures: { trialId: string; card: string; reason: string; failed: string[]; trace: string }[]; prompt?: string }, ctx: CallContext): Promise<FailureMode[]>;`.

In `validatePreparation`, inside the `for (const s of p.scenarios)` loop right after the `synthetic && !s.requirementIds.length` check, add:

```ts
    if (synthetic) for (const answer of s.user.answers ?? []) {
      const known = valueTokens([s.user.opening, s.user.facts, ...(s.user.knows ?? [])].join('\n'));
      const unknown = [...valueTokens(answer.reply)].filter(token => !known.has(token));
      if (unknown.length) throw new Error(`Scenario ${s.id}: the reply to "${answer.ifAsked}" reveals a value the user does not know: ${unknown[0]}`);
    }
```

- [ ] **Step 4: Run the tests**

Run: `npm run build && npx tsx --test test/contracts.test.ts`
Expected: PASS (all tests in the file, including the four new ones).

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. If `extensions/*.ts` fail typecheck because `FailureMode` literals now need `promptQuotes`, nothing should — the field is optional.

- [ ] **Step 6: Commit**

```bash
git add src/contracts.ts test/contracts.test.ts
git commit -m "feat(contracts): user state, external world, simulator checks, release hook and prompt quotes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `src/simulator.ts` — leak, fabrication and loop checks

**Files:**
- Create: `src/simulator.ts`
- Test: `test/simulator.test.ts` (create)

**Interfaces:**
- Consumes: `valueTokens`, `simulatorWasUsed`, `SimulatorCheck`, `Scenario`, `Trial` from `./contracts.js`
- Produces: `export function simulatorChecks(scenario: Scenario, trial: Trial): SimulatorCheck[]` (empty array unless `simulatorWasUsed(trial)` and at least one user message after the opening); `export function hiddenLiterals(scenario: Scenario): string[]` (lower-cased, deduplicated)

- [ ] **Step 1: Write the failing tests** — create `test/simulator.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hiddenLiterals, simulatorChecks } from '../src/simulator.js';
import { emptyUsage, type Scenario, type TraceEvent, type Trial } from '../src/contracts.js';

const world = { records: { card_1: { last4: '4321', status: 'active', reason: 'FRAUD_HOLD_77' } }, writableFields: ['status'], transientFailures: 0, external: { sbe: { tools: { cards: { tid: '12345678' } } } } };
function scenario(user: Partial<Scenario['user']> = {}): Scenario {
  return { id: 's', familyId: 's', title: 's', requirementIds: [], provenance: 'curated', split: 'dev', initialState: world, checks: [],
    user: { goal: 'Block the lost card', facts: 'The card ends with 4321.', behavior: 'Answer once', opening: 'I lost my card, please block it', maxFollowUps: 2,
      knows: ['Last four digits 4321'], cannotKnow: ['Why the backend holds the card'], answers: [{ ifAsked: 'last four digits', reply: 'It ends with 4321.' }], ...user } };
}
/** opening → assistant → (simulator decision → user → assistant)* ; texts alternate exactly as evaluation.ts records them. */
function trial(turns: string[], userMode: Trial['userMode'] = 'reactive'): Trial {
  const events: TraceEvent[] = [];
  turns.forEach((text, i) => {
    if (i % 2 === 0) { if (i > 0) events.push({ seq: events.length, type: 'simulator', result: { message: text, done: false } }); events.push({ seq: events.length, type: 'user', text }); }
    else events.push({ seq: events.length, type: 'assistant', text });
  });
  return { id: 't', revisionId: 'r', scenarioId: 's', familyId: 's', repeat: 0, userMode, split: 'dev', manifestHash: 'h', outcome: 'ungraded', reason: '', checks: [], events,
    initialState: world, finalState: world, usage: emptyUsage(), elapsedMs: 1 };
}
const check = (checks: ReturnType<typeof simulatorChecks>, id: string) => checks.find(c => c.id === id);

test('hidden literals are initial-state leaves the user was not told', () => {
  assert.deepEqual(hiddenLiterals(scenario()).sort(), ['12345678', 'active', 'fraud_hold_77']);
  assert.deepEqual(hiddenLiterals(scenario({ knows: ['Last four digits 4321', 'Card status active'] })).sort(), ['12345678', 'fraud_hold_77']);
});

test('a leak is the user saying a hidden value before the agent did; saying it after the agent is fine', () => {
  const leaked = simulatorChecks(scenario(), trial(['I lost my card, please block it', 'Which card?', 'The one on hold FRAUD_HOLD_77', 'Done']));
  assert.equal(check(leaked, 'simulator_leak')?.passed, false);
  assert.equal(check(leaked, 'simulator_leak')?.seq, 3);
  assert.match(check(leaked, 'simulator_leak')!.evidence, /fraud_hold_77/i);
  const revealed = simulatorChecks(scenario(), trial(['I lost my card, please block it', 'It is on hold: FRAUD_HOLD_77. Confirm?', 'Yes, FRAUD_HOLD_77, block it', 'Done']));
  assert.equal(check(revealed, 'simulator_leak')?.passed, true);
  assert.equal(check(revealed, 'simulator_leak')?.heuristic, false);
  const nothingHidden = simulatorChecks({ ...scenario(), initialState: { records: {}, writableFields: [], transientFailures: 0 } }, trial(['hi', 'Which card?', '4321', 'ok']));
  assert.equal(check(nothingHidden, 'simulator_leak'), undefined, 'no hidden literals means no leak check');
});

test('fabrication flags values absent from the card and prior replies, as a heuristic', () => {
  const invented = simulatorChecks(scenario(), trial(['I lost my card, please block it', 'Which card?', 'Card 9999, expiry 12/28', 'Done']));
  assert.equal(check(invented, 'simulator_fabrication')?.passed, false);
  assert.equal(check(invented, 'simulator_fabrication')?.heuristic, true);
  assert.match(check(invented, 'simulator_fabrication')!.evidence, /9999/);
  assert.match(check(invented, 'simulator_fabrication')!.description, /эвристика/i);
  const known = simulatorChecks(scenario(), trial(['I lost my card, please block it', 'Which card?', 'It ends with 4321.', 'Done']));
  assert.equal(check(known, 'simulator_fabrication')?.passed, true);
  const echoed = simulatorChecks(scenario(), trial(['I lost my card, please block it', 'Is it request 555123?', 'Yes, 555123', 'Done']));
  assert.equal(check(echoed, 'simulator_fabrication')?.passed, true, 'values the agent said first are not fabricated');
});

test('a loop is a repeated user message; the opening itself never counts', () => {
  const looped = simulatorChecks(scenario(), trial(['I lost my card, please block it', 'Which card?', 'Please block it!', 'Which card?', 'please block it', 'Which card?']));
  assert.equal(check(looped, 'simulator_loop')?.passed, false);
  assert.equal(check(looped, 'simulator_loop')?.seq, 6, 'events: #0 user, #1 assistant, #2 simulator, #3 user, #4 assistant, #5 simulator, #6 user');
  assert.match(check(looped, 'simulator_loop')!.evidence, /#3/);
  const fine = simulatorChecks(scenario(), trial(['I lost my card, please block it', 'Which card?', 'It ends with 4321.', 'Done']));
  assert.equal(check(fine, 'simulator_loop')?.passed, true);
});

test('static, scripted and opening-only dialogues get no simulator checks', () => {
  assert.deepEqual(simulatorChecks(scenario(), trial(['I lost my card, please block it', 'Which card?', 'It ends with 4321.', 'Done'], 'scripted')), []);
  assert.deepEqual(simulatorChecks(scenario(), trial(['I lost my card, please block it', 'Done'])), []);
  const stoppedAtOnce = trial(['I lost my card, please block it', 'Done']);
  stoppedAtOnce.events.push({ seq: 2, type: 'simulator', result: { message: '', done: true } });
  assert.deepEqual(simulatorChecks(scenario(), stoppedAtOnce), []);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test test/simulator.test.ts`
Expected: FAIL with "Cannot find module '../src/simulator.js'".

- [ ] **Step 3: Implement `src/simulator.ts`**

```ts
import { simulatorWasUsed, valueTokens, type Scenario, type SimulatorCheck, type Trial } from './contracts.js';

/*
 * Code checks over the simulated user's own replies. They answer three questions the judge is
 * bad at and code is good at: did the user say a value only the backend knows (leak), did it
 * say a value that exists nowhere in its card or the conversation (fabrication, a heuristic),
 * did it repeat itself (loop). Results describe the simulator, never the agent, and are never
 * shown to the judge so that they cannot bias its verdict.
 */
function knownText(user: Scenario['user']): string {
  return [user.opening, user.facts, user.goal, user.behavior, user.persona ?? '', ...(user.characteristics ?? []), ...(user.script ?? []),
    ...(user.knows ?? []), ...(user.answers ?? []).flatMap(a => [a.ifAsked, a.reply])].join('\n');
}
function leaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string' || typeof value === 'number') { const s = String(value).trim(); if (s.length >= 3) out.push(s); }
  else if (Array.isArray(value)) for (const item of value) leaves(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) leaves(item, out);
  return out;
}
/** Scalar leaves of the initial world the card did not disclose to the user, lower-cased. */
export function hiddenLiterals(scenario: Scenario): string[] {
  const known = knownText(scenario.user).toLocaleLowerCase();
  const values = [...leaves(scenario.initialState.records), ...leaves(scenario.initialState.external)].map(v => v.toLocaleLowerCase());
  return [...new Set(values.filter(v => !known.includes(v)))];
}
const normalize = (text: string) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function simulatorChecks(scenario: Scenario, trial: Trial): SimulatorCheck[] {
  if (!simulatorWasUsed(trial)) return [];
  const users = trial.events.filter(e => e.type === 'user');
  const simulated = users.slice(1);
  if (!simulated.length) return [];
  const textBefore = (seq: number, types: string[]) => trial.events.filter(e => types.includes(e.type) && e.seq < seq).map(e => e.text ?? '').join('\n');
  const checks: SimulatorCheck[] = [];

  const hidden = hiddenLiterals(scenario);
  if (hidden.length) {
    let leak: { seq: number; value: string } | undefined;
    for (const message of simulated) {
      const said = (message.text ?? '').toLocaleLowerCase();
      const revealed = textBefore(message.seq, ['assistant']).toLocaleLowerCase();
      const value = hidden.find(h => said.includes(h) && !revealed.includes(h));
      if (value) { leak = { seq: message.seq, value }; break; }
    }
    checks.push({ id: 'simulator_leak', heuristic: false, passed: !leak, ...(leak ? { seq: leak.seq } : {}),
      description: 'Пользователь не называет скрытые значения тестового мира раньше агента',
      evidence: leak ? `Реплика #${leak.seq} содержит скрытое значение «${leak.value}», которого агент ещё не называл.` : `Скрытых значений: ${hidden.length}; ни одно не прозвучало раньше агента.` });
  }

  const known = valueTokens(knownText(scenario.user));
  let fabricated: { seq: number; token: string } | undefined;
  for (const message of simulated) {
    const allowed = new Set([...known, ...valueTokens(textBefore(message.seq, ['assistant', 'user']))]);
    const token = [...valueTokens(message.text ?? '')].find(t => !allowed.has(t));
    if (token) { fabricated = { seq: message.seq, token }; break; }
  }
  checks.push({ id: 'simulator_fabrication', heuristic: true, passed: !fabricated, ...(fabricated ? { seq: fabricated.seq } : {}),
    description: 'Пользователь не называет значения, которых нет ни в карточке, ни в предыдущих репликах (эвристика по токенам)',
    evidence: fabricated ? `Подозрение: реплика #${fabricated.seq} содержит значение «${fabricated.token}», которого нет в известных пользователю фактах и предыдущих репликах.` : 'Все значения в репликах пользователя прослеживаются к карточке или предыдущим репликам.' });

  const seen = new Map<string, number>();
  let loop: { seq: number; earlier: number } | undefined;
  for (const message of users) {
    const key = normalize(message.text ?? '');
    if (key.length < 3) continue;
    const earlier = seen.get(key);
    if (earlier !== undefined && message.seq !== users[0]!.seq) { loop = { seq: message.seq, earlier }; break; }
    seen.set(key, message.seq);
  }
  checks.push({ id: 'simulator_loop', heuristic: false, passed: !loop, ...(loop ? { seq: loop.seq } : {}),
    description: 'Пользователь не повторяет одну и ту же реплику',
    evidence: loop ? `Реплика #${loop.seq} повторяет реплику #${loop.earlier}.` : 'Повторов реплик нет.' });
  return checks;
}
```

- [ ] **Step 4: Run the test**

Run: `npx tsx --test test/simulator.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/simulator.ts test/simulator.test.ts
git commit -m "feat(simulator): code checks for leaks, fabricated values and loops

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `evaluation.ts` — record simulator checks and the unconfirmed external state

**Files:**
- Modify: `src/evaluation.ts` (imports line 2-8; after the dialogue loop at ~236; reason suffix block ~244-248)
- Test: `test/evaluation.test.ts`

**Interfaces:**
- Consumes: `simulatorChecks` from `./simulator.js` (Task 2)
- Produces: every trial returned by `evaluateTrial` has `simulatorChecks` set (`[]` unless reactive with follow-ups); `trial.reason` ends with ` Внешнее состояние карточки не подтверждено адаптером (resetConfirmed).` when the card has `initialState.external`, the target is external and the first reply did not confirm the reset.

- [ ] **Step 1: Write the failing tests** — append to `test/evaluation.test.ts` (the file already imports `evaluateTrial`, `fixture`, `context`, `Runtime`, `Scenario`, `mkdtemp`, `writeFile`, `join`, `tmpdir`, `resolve`):

```ts
test('reactive dialogues record simulator checks that never change the objective outcome', async () => {
  const f = await fixture();
  const clarify = f.preparation.scenarios.find(s => s.id === 'c_clarify')!;
  const inventing: Runtime = { ...f.runtime, async userTurn() { return { message: 'My appointment ID is A999.', done: false }; } };
  const trial = await f.evaluate(clarify, f.candidate, inventing);
  const fabrication = trial.simulatorChecks!.find(c => c.id === 'simulator_fabrication')!;
  assert.equal(fabrication.passed, false);
  assert.match(fabrication.evidence, /a999/);
  assert.equal(trial.simulatorChecks!.find(c => c.id === 'simulator_leak')!.passed, true);
  assert.equal(trial.outcome, 'fail', 'the agent could not find A999; the simulator check does not decide that');
  assert.doesNotMatch(trial.reason, /симулятор/i);
  const honest = await f.evaluate(clarify, f.candidate);
  assert.ok(honest.simulatorChecks!.every(c => c.passed), JSON.stringify(honest.simulatorChecks));
  assert.equal(honest.outcome, 'pass');
  const opening = await f.evaluate(f.preparation.scenarios[0]!, f.candidate);
  assert.deepEqual(opening.simulatorChecks, [], 'a dialogue that stops after the opening has nothing to check');
});

test('an unconfirmed external world is named in the reason without inventing an agent failure', async t => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-external-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(directory, { recursive: true, force: true }); });
  const silent = join(directory, 'no-reset.mjs');
  await writeFile(silent, 'export function createSession({ initialState }) { return { async respond() { return { reply: `cards: ${initialState.external.cards.length}`, records: initialState.records }; } }; }\n');
  const confirming = join(directory, 'reset.mjs');
  await writeFile(confirming, 'export function createSession({ initialState }) { return { async respond() { return { reply: `cards: ${initialState.external.cards.length}`, records: initialState.records, resetConfirmed: true }; } }; }\n');
  const scenario: Scenario = { ...f.preparation.scenarios[0]!, checks: [], metrics: undefined, initialState: { records: {}, writableFields: [], transientFailures: 0, external: { cards: [{ id: 'c1', status: 'blocked' }] } } };
  const run = (path: string) => evaluateTrial({ runtime: { ...f.runtime, openTarget: async () => { throw new Error('sandbox must not open'); } }, revision: f.baseline, scenario, repeat: 0, manifestHash: 'frozen',
    sources: f.sources, settings: f.input.settings, ctx: context(), userMode: 'static', target: { kind: 'module', path, exportName: 'createSession' } });
  const unconfirmed = await run(silent);
  assert.equal(unconfirmed.outcome, 'ungraded');
  assert.match(unconfirmed.reason, /Внешнее состояние карточки не подтверждено адаптером/);
  assert.equal(unconfirmed.events.find(e => e.type === 'assistant')?.text, 'cards: 1', 'the external world reached the adapter');
  const confirmed = await run(confirming);
  assert.doesNotMatch(confirmed.reason, /не подтверждено адаптером/);
  assert.equal(confirmed.observation?.resetConfirmed, true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx tsx --test test/evaluation.test.ts`
Expected: FAIL — `trial.simulatorChecks` is undefined; the reason has no suffix.

- [ ] **Step 3: Implement**

In `src/evaluation.ts` add `import { simulatorChecks } from './simulator.js';` after the `openExternalTarget` import. Replace the two lines starting at `trial.finalState = structuredClone(state);` / `stage = 'проверка наблюдений';` (inside the `try`, right after the `for` loop) with:

```ts
    trial.finalState = structuredClone(state);
    // Simulator checks describe the user side only; they are computed before grading and never touch the outcome.
    trial.simulatorChecks = simulatorChecks(scenario, trial);
    stage = 'проверка наблюдений';
```

Then extend the external-target reason block so it reads:

```ts
    if (target.kind !== 'sandbox') {
      trial.reason += reportedState
        ? ' Состояние сообщил сам агент, доверенный код его не наблюдал.'
        : ' Состояние внешний агент не сообщил.';
      if (scenario.initialState.external && trial.observation?.resetConfirmed !== true) trial.reason += ' Внешнее состояние карточки не подтверждено адаптером (resetConfirmed).';
    }
```

Note `module-worker.mjs` already passes the whole `initialState` (including `external`) to `createSession`, and http/command send it in every request; nothing else changes.

- [ ] **Step 4: Run the tests**

Run: `npm run build && npx tsx --test test/evaluation.test.ts test/simulator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evaluation.ts test/evaluation.test.ts
git commit -m "feat(evaluation): record simulator checks and unconfirmed external state

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Prompts and Pi runtime — user state for the simulator, answers rule for the generator, prompt quotes for clusters

**Files:**
- Modify: `src/prompts.ts` (SIMULATOR_ROLE, cardsRole, EXTERNAL_CARDS_CLAUSE, FAILURE_MODES_ROLE), `src/pi.ts` (userTurn ~499-512, cards review ~374-392, failureModes ~422-441)
- Test: `test/pi.test.ts`

**Interfaces:**
- Consumes: `valueTokens` (Task 1)
- Produces: `USER_STATE_CLAUSE` exported from `prompts.ts`; `Runtime.userTurn` sends `knows`, `cannotKnow`, `answers`; `Runtime.failureModes` accepts `prompt` and returns validated `promptQuotes`.

- [ ] **Step 1: Write the failing tests** — append to `test/pi.test.ts` (helpers `fixture`, `callContext`, `scripted`, `plainCard`, `reviewFields` already exist in the file):

```ts
test('the simulator receives knows, answers and cannotKnow but never the external world', async () => {
  const f = await fixture(() => JSON.stringify({ message: 'It ends with 4321.', done: false }));
  try {
    const { ctx } = callContext();
    const reply = await f.adapter.userTurn({ user: { goal: 'Block the lost card', facts: 'Card ends with 4321', behavior: 'Answer once', opening: 'Block my card', maxFollowUps: 1,
      knows: ['Last four digits 4321'], cannotKnow: ['Why the hold exists'], answers: [{ ifAsked: 'digits', reply: 'It ends with 4321.' }],
      initialState: { external: { secret: 'EXTERNAL_WORLD_SENTINEL' } } } as never, messages: [{ role: 'assistant', content: 'Which card?' }], turn: 1 }, ctx);
    assert.equal(reply.message, 'It ends with 4321.');
    const wire = JSON.stringify(f.requests);
    assert.match(wire, /Last four digits 4321/);
    assert.match(wire, /Why the hold exists/);
    assert.match(wire, /"ifAsked":"digits"/);
    assert.doesNotMatch(wire, /EXTERNAL_WORLD_SENTINEL/);
    assert.match(wire, /never invent a value/);
  } finally { await f.close(); }
});

test('card generation rejects an answer that reveals an unknown value and accepts the repaired batch', async () => {
  const requirements = { requirements: [{ id: 'req_1', text: 'Block a lost card on request', sourceId: 'source_1', quote: 'Block a lost card', critical: true }], questions: [] };
  const batch = (reply: string) => ({ scenarios: [{ ...plainCard(1), requirementIds: ['req_1'], checks: [], metrics: [reviewFields.metrics[0]!],
    user: { ...plainCard(1).user, opening: 'I lost my card', facts: 'The card ends with 4321', knows: ['Last four digits 4321'], cannotKnow: ['Why the backend refused'], answers: [{ ifAsked: 'last four digits', reply }] } }] });
  const f = await fixture((_request, index) => JSON.stringify(index === 0 ? requirements : index === 1 ? batch('It ends with 9999.') : batch('It ends with 4321.')));
  try {
    const { ctx } = callContext();
    const prepared = await f.adapter.prepare({ task: 'Card support', sources: [{ id: 'source_1', name: 'policy', content: 'Block a lost card', hash: 'h' }], workflow: 'evaluate', scenarioCount: 1, targetKind: 'command' }, ctx);
    assert.deepEqual(prepared.scenarios[0]!.user.answers, [{ ifAsked: 'last four digits', reply: 'It ends with 4321.' }]);
    assert.deepEqual(prepared.scenarios[0]!.user.knows, ['Last four digits 4321']);
    assert.match(JSON.stringify(f.requests), /not in knows, facts or opening/);
    assert.match(JSON.stringify(f.requests), /user\.answers/);
  } finally { await f.close(); }
});

test('failure clusters may quote only a supplied prompt, verbatim', async () => {
  const cluster = (promptQuotes: string[]) => ({ modes: [{ id: 'hotline', name: 'Нашёл статью и всё равно отправил на линию', description: 'd', trialIds: ['t1'], promptQuotes }] });
  const failures = [{ trialId: 't1', card: 'c', reason: 'r', failed: ['x'], trace: '#1 user: hi' }];
  const f = await fixture((_request, index) => JSON.stringify(index === 0 ? cluster(['not in the prompt']) : cluster(['hand off to the hotline'])));
  try {
    const modes = await f.adapter.failureModes!({ task: 't', failures, prompt: 'When unsure, hand off to the hotline.' }, callContext().ctx);
    assert.deepEqual(modes[0]!.promptQuotes, ['hand off to the hotline']);
    assert.match(JSON.stringify(f.requests), /verbatim substring of the supplied prompt/);
    assert.match(JSON.stringify(f.requests[0]), /When unsure, hand off to the hotline/);
  } finally { await f.close(); }
  const g = await fixture((_request, index) => JSON.stringify(index === 0 ? cluster(['anything']) : cluster([])));
  try {
    const modes = await g.adapter.failureModes!({ task: 't', failures }, callContext().ctx);
    assert.deepEqual(modes[0]!.promptQuotes, []);
    assert.match(JSON.stringify(g.requests), /No prompt was supplied/);
  } finally { await g.close(); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx tsx --test test/pi.test.ts`
Expected: the three new tests FAIL (sentinel checks for `Last four digits 4321` and `never invent a value` fail; the batch with `9999` is accepted; quotes are not validated).

- [ ] **Step 3: Implement the prompts** in `src/prompts.ts`:

Add after `PERIMETER_CLAUSE`:

```ts
export const USER_STATE_CLAUSE = `user.knows lists atomic facts the user can state, each with its exact value (an ID, the last four digits, a time). user.cannotKnow lists, in words, what this user cannot know: backend reasons, the correct business answer, hidden state. user.answers lists, for each clarification the agent will plausibly ask, ifAsked (the question in words) and reply (the user's complete reply). Every value in a reply must already appear in knows, facts or opening. Keep facts as short context; put exact values into knows and answers.`;
```

In `cardsRole`, prepend the clause: change the template start from `` `${OWNER_NOTES_CLAUSE}\n${PERIMETER_CLAUSE}\n` `` to `` `${OWNER_NOTES_CLAUSE}\n${PERIMETER_CLAUSE}\n${USER_STATE_CLAUSE}\n` ``.

Append to `EXTERNAL_CARDS_CLAUSE` (inside the template literal, at the end): ` initialState.external stays absent unless the materials describe the test-environment data the agent must see for this card; never invent it.`

Append to `SIMULATOR_ROLE` a final paragraph (inside the template literal):

```
Known values: user.knows lists facts you may state and user.answers lists replies to expected clarifications; when the assistant asks about an ifAsked topic, answer with that reply verbatim. If the assistant asks something not covered by knows, facts or answers, say you do not know or ask back; never invent a value, an ID, a date or an amount. user.cannotKnow lists what you cannot know: never state, guess or hint at it, even if the assistant asks.
```

Append to `FAILURE_MODES_ROLE`:

```
When a prompt is supplied, put in promptQuotes the exact fragments of that prompt that govern the broken behaviour: verbatim substring of the supplied prompt, at most five, each under 300 characters. If no fragment governs it, leave promptQuotes empty and say so in description. Never quote a prompt that was not supplied.
```

- [ ] **Step 4: Implement the runtime** in `src/pi.ts`:

Add `valueTokens` to the `./contracts.js` import list. In `userTurn`, extend the `user` object:

```ts
          user: {
            goal: input.user.goal, persona: input.user.persona, characteristics: input.user.characteristics,
            facts: input.user.facts, behavior: input.user.behavior, opening: input.user.opening, maxFollowUps: input.user.maxFollowUps,
            knows: input.user.knows ?? [], cannotKnow: input.user.cannotKnow ?? [], answers: input.user.answers ?? [],
          },
```

In the cards `review` callback, after the `missing` requirements check and before `seen.add(scenario.familyId)`, add:

```ts
              const known = valueTokens([scenario.user.opening, scenario.user.facts, ...(scenario.user.knows ?? [])].join('\n'));
              for (const answer of scenario.user.answers ?? []) {
                const unknown = [...valueTokens(answer.reply)].find(token => !known.has(token));
                if (unknown) return `Card ${scenario.id}: the reply to "${answer.ifAsked}" contains "${unknown}", which is not in knows, facts or opening. Put every value the user can say into user.knows.`;
              }
```

Replace `failureModes`:

```ts
    async failureModes(input, ctx) {
      const known = new Set(input.failures.map(f => f.trialId));
      const result = await ask(
        'Разбор провалов',
        FAILURE_MODES_ROLE,
        { task: input.task, failures: input.failures, ...(input.prompt !== undefined ? { prompt: input.prompt } : {}) },
        z.strictObject({ modes: z.array(failureModeSchema).min(1).max(12) }), ctx,
        value => {
          for (const mode of value.modes) {
            const unknown = mode.trialIds.filter(id => !known.has(id));
            if (unknown.length) return `Cluster ${mode.id} cites dialogues that are not in the supplied failures: ${unknown.join(', ')}.`;
            if (/^(bad|poor|wrong|incorrect|quality|agent failed|плохой|неверный)/i.test(mode.name.trim())) {
              return `Cluster ${mode.id} is named "${mode.name}", which does not say what went wrong. Name the specific behaviour visible in the traces.`;
            }
            for (const quote of mode.promptQuotes ?? []) {
              if (input.prompt === undefined) return `No prompt was supplied; promptQuotes must be empty for cluster ${mode.id}.`;
              if (!input.prompt.includes(quote)) return `Cluster ${mode.id} quotes "${quote.slice(0, 60)}", which is not a verbatim substring of the supplied prompt. Copy the exact characters.`;
            }
          }
          return undefined;
        },
      );
      return result.modes;
    },
```

- [ ] **Step 5: Run the tests**

Run: `npm run build && npx tsx --test test/pi.test.ts`
Expected: PASS. If the assertion `/user\.answers/` fails, the cards prompt does not include `USER_STATE_CLAUSE`; check `cardsRole`.

- [ ] **Step 6: Commit**

```bash
git add src/prompts.ts src/pi.ts test/pi.test.ts
git commit -m "feat(pi): user state reaches the simulator, answers are grounded, clusters quote the prompt

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Demo runtime — cards with `knows`/`answers`, simulator answers from the table

**Files:**
- Modify: `src/demo.ts` (sampleScenarios ~60-78, userTurn ~218-227)
- Test: `test/evaluation.test.ts`

**Interfaces:**
- Produces: demo cards carry `user.knows` (appointment ID and desired time) and, for clarification cards, `user.answers`; demo `userTurn` answers clarifications from `answers` when present.

- [ ] **Step 1: Write the failing test** — append to `test/evaluation.test.ts`:

```ts
test('demo cards carry knows and answers, and the demo simulator answers from that table', async () => {
  const f = await fixture();
  const clarify = f.preparation.scenarios.find(s => s.id === 'c_clarify')!;
  assert.deepEqual(clarify.user.knows, ['Appointment ID A103', 'Desired time 11:30']);
  assert.deepEqual(clarify.user.answers, [{ ifAsked: 'appointment ID', reply: 'My appointment ID is A103.' }]);
  const trial = await f.evaluate(clarify, f.candidate);
  assert.equal(trial.events.filter(e => e.type === 'user')[1]?.text, 'My appointment ID is A103.');
  assert.ok(trial.simulatorChecks!.every(c => c.passed));
  const time = f.preparation.scenarios.find(s => s.id === 'd_clarify_control')!;
  assert.deepEqual(time.user.answers, [{ ifAsked: 'desired time', reply: 'My desired time is 17:00.' }]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx tsx --test test/evaluation.test.ts`
Expected: FAIL — `clarify.user.knows` is undefined.

- [ ] **Step 3: Implement** in `src/demo.ts`. In `sampleScenarios`, extend the `user` object:

```ts
    user: { goal: v.requirementIds.includes('read') ? `Learn the time of appointment ${v.id} without changing it.` : `Move appointment ${v.id} to ${v.time}.`, facts: `Your appointment ID is ${v.id}. Your desired time is ${v.time}.`, behavior: v.behavior, opening: v.opening,
      maxFollowUps: v.requirementIds.includes('clarify') || v.requirementIds.includes('preference') ? 1 : 0,
      knows: [`Appointment ID ${v.id}`, `Desired time ${v.time}`],
      cannotKnow: ['Whether the backend will accept the change before it answers'],
      ...(v.requirementIds.includes('clarify') ? { answers: [v.opening.includes('my appointment') ? { ifAsked: 'appointment ID', reply: `My appointment ID is ${v.id}.` } : { ifAsked: 'desired time', reply: `My desired time is ${v.time}.` }] } : {}),
      // Scripted-mode lines mirror what the reactive simulator would say; direct and read-only cards have no follow-up to script.
      ...(v.requirementIds.includes('clarify') ? { script: [v.opening.includes('my appointment') ? `My appointment ID is ${v.id}.` : `My desired time is ${v.time}.`] }
        : v.requirementIds.includes('preference') ? { script: [`Actually, please move it to ${v.time} instead.`] } : {}) },
```

Replace `userTurn`:

```ts
    async userTurn({ user, messages, turn }, ctx) {
      call(ctx);
      const answer = messages.at(-1)?.content ?? '';
      const reply = (topic: RegExp, fallback: string) => user.answers?.find(a => topic.test(a.ifAsked))?.reply ?? fallback;
      if (/what is your appointment id/i.test(answer)) return { message: reply(/appointment id/i, `My appointment ID is ${user.facts.match(/\bA\d{3}\b/)?.[0] ?? 'unknown'}.`), done: false };
      if (/what is your desired time/i.test(answer)) return { message: reply(/desired time/i, `My desired time is ${user.facts.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/)?.[0] ?? 'unknown'}.`), done: false };
      if (turn === 0 && /change preference once/i.test(user.behavior)) {
        return { message: `Actually, please move it to ${user.behavior.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/)?.[0]} instead.`, done: false };
      }
      return { message: '', done: true };
    },
```

- [ ] **Step 4: Run the full suite** (the demo feeds many fixtures: cards, extension, artifacts, product-flow)

Run: `npm test`
Expected: PASS. A `cards.test.ts` or `extension.test.ts` failure that mentions width or wrapping means a new card line pushed the 80×24 layout; that is not expected, since `knows` renders only in Task 8.

- [ ] **Step 5: Commit**

```bash
git add src/demo.ts test/evaluation.test.ts
git commit -m "feat(demo): sample cards carry knows and answers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Outcome helpers module, simulator scorecard, mode value, paired family delta

**Files:**
- Create: `src/outcomes.ts`
- Modify: `src/comparison.ts` (remove moved helpers ~14-42 `mean/graded/runningPhases/observedRecord`, ~207-215 `latestHumanReviews`, ~354-384 `agentRubricResult/isAgentFailure/trialAssessmentComplete/simulatorUsable/automaticTrialResult`, ~700-701 `attemptKey`/`measured` stays except `measured`; verdictSummary ~503-519, 579, 600-622; EvidenceSummary ~639-672; RunComparison ~680-693, 757-767, 815-843), `src/simulator.ts`
- Test: `test/simulator.test.ts`, `test/comparison.test.ts`

**Interfaces:**
- Produces `src/outcomes.ts`: `export const runningPhases`, `export const mean`, `export const graded`, `export const measured`, `export function observedRecord`, `export function latestHumanReviews`, `export function agentRubricResult`, `export function isAgentFailure`, `export function trialAssessmentComplete`, `export function simulatorUsable`, `export function automaticTrialResult` — bodies moved verbatim from `comparison.ts`.
- `comparison.ts` keeps its public API by re-exporting: `export { observedRecord, agentRubricResult, isAgentFailure, trialAssessmentComplete, automaticTrialResult } from './outcomes.js';`
- `src/simulator.ts` produces:
  ```ts
  export interface SimulatorSummary { reactiveDialogues: number; checks: { id: SimulatorCheckId; dialogues: number; flagged: number; heuristic: boolean; examples: { trialId: string; seq?: number; evidence: string }[] }[];
    judge: { applicable: number; pass: number; fail: number; unknown: number; missing: number }; human: { reviewed: number; confirmed: number; rejected: number };
    clarifications: { dialogues: number; answered: number }; disengaged: number; notes: string[] }
  export function simulatorSummary(record: Experiment): SimulatorSummary
  export interface ModeValue { cards: { scenarioId: string; title: string; familyId: string; outcomes: Partial<Record<UserMode, 'pass' | 'fail' | 'unknown' | 'missing'>>; clarification: boolean }[];
    reactiveOnlyCompleted: string[]; reactiveOnlyFailed: string[]; humanConfirmed: { completed: number; failed: number }; measuredModes: UserMode[]; notes: string[] }
  export function modeValue(record: Experiment): ModeValue
  ```
- `comparison.ts` produces: `EvidenceSummary.simulator: SimulatorSummary`, `EvidenceSummary.modeValue: ModeValue`, `RunComparison.delta: { families: number; mean: number | null; interval: [number, number] | null; note: string } | null`, `VerdictSummary.simulatorFlagged` now includes code-flagged dialogues, new `nextSteps` code `inspect_simulator`.

- [ ] **Step 1: Write the failing tests**

Append to `test/simulator.test.ts` (extend the import line with `modeValue, simulatorSummary` and add `settingsSchema, type Experiment, type HumanReview, type MetricAssessment, type Outcome, type UserMode` from contracts):

```ts
const metrics = [
  { id: 'goal', name: 'Goal', subject: 'agent' as const, description: 'd', passCriteria: 'p', failCriteria: 'f' },
  { id: 'user_fidelity', name: 'Fidelity', subject: 'simulator' as const, description: 'd', passCriteria: 'p', failCriteria: 'f' },
];
function card(id: string): Scenario {
  return { ...scenario(), id, familyId: id, title: `Card ${id}`, metrics, user: { ...scenario().user, script: ['It ends with 4321.'] },
    checks: [{ id: 'time', kind: 'state_equals', description: 'time', recordId: 'card_1', field: 'status', value: 'blocked' }] };
}
/** user → assistant (→ simulator → user → assistant)*; `firstReply` lets the agent ask a question; `ended` appends a terminal simulator decision. */
function exchange(userMessages: string[], firstReply = 'ok', ended?: 'done' | 'continue'): TraceEvent[] {
  const events: TraceEvent[] = [];
  userMessages.forEach((text, i) => {
    if (i > 0) events.push({ seq: events.length, type: 'simulator', result: { message: text, done: false } });
    events.push({ seq: events.length, type: 'user', text });
    events.push({ seq: events.length, type: 'assistant', text: i === 0 ? firstReply : 'ok' });
  });
  if (ended) events.push({ seq: events.length, type: 'simulator', result: { message: '', done: ended === 'done' } });
  return events;
}
function attempt(id: string, scenarioId: string, userMode: UserMode, outcome: Outcome, options: { events?: TraceEvent[]; fidelity?: 'pass' | 'fail'; goal?: 'pass' | 'fail'; simulatorChecks?: Trial['simulatorChecks'] } = {}): Trial {
  const assessments: MetricAssessment[] = [{ metricId: 'goal', result: options.goal ?? (outcome === 'fail' ? 'fail' : 'pass'), rationale: 'r', evidence: [1] },
    { metricId: 'user_fidelity', result: options.fidelity ?? 'pass', rationale: 'r', evidence: [1] }];
  return { id, revisionId: 'rev', scenarioId, familyId: scenarioId, repeat: 0, userMode, split: 'dev', manifestHash: 'h', outcome, reason: '',
    checks: [{ id: 'time', description: 'time', passed: outcome === 'pass', evidence: '' }], events: options.events ?? exchange(['hello']),
    initialState: world, finalState: world, usage: emptyUsage(), elapsedMs: 1, assessments, ...(options.simulatorChecks ? { simulatorChecks: options.simulatorChecks } : {}) };
}
function experiment(trials: Trial[], userModes: UserMode[], humanReviews: HumanReview[] = []): Experiment {
  return { schemaVersion: '1', id: 'exp', task: 't', mode: 'demo', workflow: 'evaluate', createdAt: 'now', updatedAt: 'now', phase: 'results_review', message: '',
    sources: [], settings: settingsSchema.parse({ userModes, repeats: 1 }), target: { kind: 'sandbox' }, requirements: [], questions: [], goldenCases: [], dialogues: [], profiles: [],
    scenarios: [card('s1'), card('s2')], revisions: [], selectedRevisionId: null, manifestHash: 'h', reviewedAt: null, reviewMode: 'human', controlConsumedAt: null,
    trials, comparisons: [], iterations: [], usage: emptyUsage(), error: null, limitations: [], humanReviews };
}
const leak: NonNullable<Trial['simulatorChecks']> = [{ id: 'simulator_leak', description: 'd', passed: false, evidence: 'Реплика #3 содержит скрытое значение «fraud_hold_77»', seq: 3, heuristic: false },
  { id: 'simulator_fabrication', description: 'd', passed: true, evidence: 'ok', heuristic: true }, { id: 'simulator_loop', description: 'd', passed: true, evidence: 'ok', heuristic: false }];
const clean: NonNullable<Trial['simulatorChecks']> = leak.map(c => ({ ...c, passed: true, seq: undefined, evidence: 'ok' }));

test('the simulator scorecard counts code checks, judge fidelity, human verdicts, clarifications and disengagement', () => {
  const asked = attempt('t1', 's1', 'reactive', 'pass', { events: exchange(['hello', 'It ends with 4321.'], 'Which card?'), simulatorChecks: leak });
  const left = attempt('t2', 's2', 'reactive', 'fail', { events: exchange(['hello'], 'ok', 'done'), fidelity: 'fail', simulatorChecks: clean.filter(c => c.id !== 'simulator_leak') });
  const record = experiment([asked, left, attempt('t3', 's1', 'static', 'pass')], ['static', 'reactive'], [
    { id: 'r1', trialId: 't1', checkId: 'simulator_leak', verdict: 'fail', note: 'confirmed', createdAt: '2026-09-14T00:00:00Z' },
    { id: 'r2', trialId: 't2', metricId: 'user_fidelity', verdict: 'pass', note: 'the judge was wrong', createdAt: '2026-09-14T00:00:01Z' },
  ]);
  const summary = simulatorSummary(record);
  assert.equal(summary.reactiveDialogues, 2);
  assert.deepEqual(summary.checks.map(c => [c.id, c.dialogues, c.flagged, c.heuristic]), [['simulator_leak', 1, 1, false], ['simulator_fabrication', 2, 0, true], ['simulator_loop', 2, 0, false]]);
  assert.deepEqual(summary.checks[0]!.examples, [{ trialId: 't1', seq: 3, evidence: 'Реплика #3 содержит скрытое значение «fraud_hold_77»' }]);
  assert.deepEqual(summary.judge, { applicable: 2, pass: 1, fail: 1, unknown: 0, missing: 0 });
  assert.deepEqual(summary.human, { reviewed: 2, confirmed: 1, rejected: 1 });
  assert.deepEqual(summary.clarifications, { dialogues: 1, answered: 1 });
  assert.equal(summary.disengaged, 1);
  assert.deepEqual(simulatorSummary(experiment([attempt('t3', 's1', 'static', 'pass')], ['static'])).notes, ['Реактивных диалогов нет: симулятор не участвовал.']);
});

test('mode value names the cards only the reactive user completed or failed, with human confirmation', () => {
  const record = experiment([
    attempt('a', 's1', 'static', 'fail'), attempt('b', 's1', 'scripted', 'fail'), attempt('c', 's1', 'reactive', 'pass', { events: exchange(['hello', 'It ends with 4321.'], 'Which card?') }),
    attempt('d', 's2', 'static', 'pass'), attempt('e', 's2', 'scripted', 'pass'), attempt('f', 's2', 'reactive', 'fail'),
  ], ['static', 'scripted', 'reactive'], [{ id: 'r', trialId: 'f', verdict: 'fail', note: 'agent failed', createdAt: '2026-09-14T00:00:00Z' }]);
  const value = modeValue(record);
  assert.deepEqual(value.cards.map(c => [c.scenarioId, c.outcomes, c.clarification]), [
    ['s1', { static: 'fail', scripted: 'fail', reactive: 'pass' }, true], ['s2', { static: 'pass', scripted: 'pass', reactive: 'fail' }, false]]);
  assert.deepEqual([value.reactiveOnlyCompleted, value.reactiveOnlyFailed], [['s1'], ['s2']]);
  assert.deepEqual(value.humanConfirmed, { completed: 0, failed: 1 });
  assert.deepEqual(value.measuredModes, ['static', 'scripted', 'reactive']);
  const single = modeValue(experiment([attempt('c', 's1', 'reactive', 'pass')], ['reactive']));
  assert.deepEqual([single.reactiveOnlyCompleted, single.reactiveOnlyFailed], [[], []]);
  assert.deepEqual(single.cards[1]!.outcomes, { reactive: 'missing' });
  assert.match(single.notes.join(' '), /один режим/);
});
```

Append to `test/comparison.test.ts` (its builders `record`, `scenario`, `trial`, `dialogue` exist; import `evidenceSummary`, `verdictSummary`, `compareRuns` are already imported):

```ts
test('code-flagged simulator dialogues count as flagged, lower confidence and reach the evidence summary', () => {
  const flagged = { ...trial('a', 's1', 'reactive', 'pass', { events: dialogue(['hello', 'again']) }),
    simulatorChecks: [{ id: 'simulator_loop' as const, description: 'd', passed: false, evidence: 'Реплика #3 повторяет реплику #0.', seq: 3, heuristic: false }] };
  const r = record({ settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1 }), trials: [flagged] });
  const v = verdictSummary(r);
  assert.equal(v.simulatorFlagged, 1);
  assert.notEqual(v.confidence, 'high');
  assert.ok(v.confidenceReasons.some(n => n.code === 'simulator_flagged' && /кодовым проверкам/.test(n.text)));
  assert.ok(v.nextSteps.some(n => n.code === 'inspect_simulator'));
  const e = evidenceSummary(r);
  assert.equal(e.simulator.reactiveDialogues, 1);
  assert.equal(e.simulator.checks.find(c => c.id === 'simulator_loop')?.flagged, 1);
  assert.deepEqual(e.modeValue.measuredModes, ['reactive']);
  assert.match(e.notes.join(' '), /один режим/);
});

test('run comparison adds a descriptive paired family delta with a bootstrap interval', () => {
  // Cards without agent rubrics: the builder's default assessments cover only the simulator metric, and a missing agent rubric would make every card outcome unknown.
  const cards = ['f1', 'f2', 'f3'].map(id => ({ ...scenario(id), metrics: [] }));
  const settings = settingsSchema.parse({ userModes: ['static'], repeats: 1 });
  const before = record({ id: 'before', scenarios: cards, settings, trials: [trial('b1', 'f1', 'static', 'fail', { failed: ['time'] }), trial('b2', 'f2', 'static', 'pass'), trial('b3', 'f3', 'static', 'fail', { failed: ['time'] })] });
  const after = record({ id: 'after', scenarios: cards, settings, parentRunId: 'before', trials: [trial('a1', 'f1', 'static', 'pass'), trial('a2', 'f2', 'static', 'pass'), trial('a3', 'f3', 'static', 'fail', { failed: ['time'] })] });
  const diff = compareRuns(before, after);
  assert.equal(diff.comparable, true);
  assert.equal(diff.delta?.families, 3);
  assert.ok(Math.abs((diff.delta?.mean ?? 0) - 1 / 3) < 1e-9);
  assert.ok(diff.delta?.interval && diff.delta.interval[0] <= diff.delta.mean! && diff.delta.mean! <= diff.delta.interval[1]);
  assert.match(diff.delta!.note, /Описательная/);
  const one = compareRuns({ ...before, scenarios: cards.slice(0, 1), trials: before.trials.slice(0, 1) }, { ...after, scenarios: cards.slice(0, 1), trials: after.trials.slice(0, 1) });
  assert.deepEqual([one.delta?.families, one.delta?.interval], [1, null]);
  assert.equal(compareRuns(before, { ...after, mode: 'live' }).delta, null);
});
```

Also update the existing expectation on the old wording: in `test/comparison.test.ts`, any `assert.match(..., /Модель отметила/)` becomes `/кодовым проверкам или рубрике верности/` (search the file for `Модель отметила` and `simulator_flagged`; keep the codes, change only the text regexes).

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx tsx --test test/simulator.test.ts test/comparison.test.ts`
Expected: FAIL — `simulatorSummary`/`modeValue` not exported; `e.simulator` undefined; `diff.delta` undefined.

- [ ] **Step 3: Create `src/outcomes.ts`** by moving code verbatim from `comparison.ts`:

```ts
import { fingerprint, metricApplies, simulatorWasUsed, type Experiment, type HumanReview, type Scenario, type Trial } from './contracts.js';

/*
 * Outcome helpers shared by comparison.ts (verdict, evidence, run delta) and simulator.ts
 * (scorecard, mode value). Nothing here performs I/O; nothing here depends on either consumer.
 */
export const runningPhases = new Set(['preparing', 'evaluating', 'baseline', 'improving', 'control']);
export const mean = (values: number[]): number | null => values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
export const graded = (trial: Trial) => trial.outcome === 'pass' || trial.outcome === 'fail';
export const measured = (trial: Trial) => graded(trial) || trial.outcome === 'ungraded';
// … then the exact bodies of observedRecord, latestHumanReviews, agentRubricResult, isAgentFailure,
// trialAssessmentComplete, simulatorUsable, automaticTrialResult, each prefixed with `export`.
```

Copy the seven function bodies from `comparison.ts` unchanged (they reference only `fingerprint`, `metricApplies`, `simulatorWasUsed`, `runningPhases`, `graded`, `measured` and each other). Delete them from `comparison.ts` together with `mean`, `graded`, `runningPhases`, `measured` and add at the top of `comparison.ts`:

```ts
import { agentRubricResult, automaticTrialResult, graded, isAgentFailure, latestHumanReviews, mean, measured, observedRecord, runningPhases, simulatorUsable, trialAssessmentComplete } from './outcomes.js';
import { modeValue, simulatorSummary, type ModeValue, type SimulatorSummary } from './simulator.js';
export { observedRecord, agentRubricResult, isAgentFailure, trialAssessmentComplete, automaticTrialResult } from './outcomes.js';
```

`hasCompleteJudgment` stays imported from `./judge.js`. Run `npm run typecheck` here: unresolved names show exactly what still needs importing.

- [ ] **Step 4: Add the scorecard and mode value to `src/simulator.ts`**

Extend the import: `import { metricApplies, simulatorWasUsed, valueTokens, SIMULATOR_CHECK_IDS, type Experiment, type Scenario, type SimulatorCheck, type SimulatorCheckId, type Trial, type UserMode } from './contracts.js'; import { automaticTrialResult, latestHumanReviews, measured, observedRecord } from './outcomes.js';` and append:

```ts
export interface SimulatorSummary {
  reactiveDialogues: number;
  checks: { id: SimulatorCheckId; dialogues: number; flagged: number; heuristic: boolean; examples: { trialId: string; seq?: number; evidence: string }[] }[];
  judge: { applicable: number; pass: number; fail: number; unknown: number; missing: number };
  human: { reviewed: number; confirmed: number; rejected: number };
  clarifications: { dialogues: number; answered: number };
  disengaged: number; notes: string[];
}
/** Everything the run recorded about the simulated user: code checks, judge fidelity, human verdicts, and how often the agent's question got an answer. */
export function simulatorSummary(record: Experiment): SimulatorSummary {
  record = observedRecord(record);
  const reviews = latestHumanReviews(record);
  const reactive = record.trials.filter(t => simulatorWasUsed(t) && measured(t));
  const scenarioOf = (t: Trial) => record.scenarios.find(s => s.id === t.scenarioId);
  const checks = SIMULATOR_CHECK_IDS.map(id => {
    const withCheck = reactive.filter(t => t.simulatorChecks?.some(c => c.id === id));
    const flagged = withCheck.filter(t => t.simulatorChecks!.some(c => c.id === id && !c.passed));
    return { id, dialogues: withCheck.length, flagged: flagged.length, heuristic: id === 'simulator_fabrication',
      examples: flagged.slice(0, 3).map(t => { const c = t.simulatorChecks!.find(c => c.id === id && !c.passed)!; return { trialId: t.id, ...(c.seq !== undefined ? { seq: c.seq } : {}), evidence: c.evidence }; }) };
  });
  const judge = { applicable: 0, pass: 0, fail: 0, unknown: 0, missing: 0 };
  for (const t of reactive) {
    const metric = scenarioOf(t)?.metrics?.find(m => m.subject === 'simulator' && metricApplies(m, t));
    if (!metric) continue;
    judge.applicable++;
    const result = t.assessments?.find(a => a.metricId === metric.id)?.result;
    if (!result) judge.missing++; else judge[result]++;
  }
  const human = { reviewed: 0, confirmed: 0, rejected: 0 };
  for (const t of reactive) for (const review of reviews.values()) {
    if (review.trialId !== t.id || !(review.verdict === 'pass' || review.verdict === 'fail')) continue;
    const onSimulatorMetric = !!review.metricId && !!scenarioOf(t)?.metrics?.some(m => m.id === review.metricId && m.subject === 'simulator');
    const onSimulatorCheck = !!review.checkId && (SIMULATOR_CHECK_IDS as readonly string[]).includes(review.checkId);
    if (!onSimulatorMetric && !onSimulatorCheck) continue;
    human.reviewed++;
    if (review.verdict === 'fail') human.confirmed++; else human.rejected++;
  }
  const asked = (t: Trial) => !!t.events.find(e => e.type === 'assistant')?.text?.includes('?');
  const clarifications = { dialogues: reactive.filter(asked).length, answered: reactive.filter(t => asked(t) && t.events.filter(e => e.type === 'user').length > 1).length };
  const disengaged = reactive.filter(t => {
    const last = t.events.filter(e => e.type === 'simulator').at(-1)?.result as { done?: boolean; message?: string } | undefined;
    return !!last?.done && !(last.message ?? '').trim() && automaticTrialResult(scenarioOf(t), t) !== 'pass';
  }).length;
  const notes: string[] = [];
  if (!reactive.length) notes.push('Реактивных диалогов нет: симулятор не участвовал.');
  else if (!judge.applicable) notes.push('Рубрика верности симулятора не применялась.');
  if (checks.some(c => c.flagged && c.heuristic)) notes.push('Подозрение на выдуманное значение — эвристика по токенам; опровергается ручным вердиктом по этой проверке.');
  return { reactiveDialogues: reactive.length, checks, judge, human, clarifications, disengaged, notes };
}

export interface ModeValue {
  cards: { scenarioId: string; title: string; familyId: string; outcomes: Partial<Record<UserMode, 'pass' | 'fail' | 'unknown' | 'missing'>>; clarification: boolean }[];
  reactiveOnlyCompleted: string[]; reactiveOnlyFailed: string[];
  humanConfirmed: { completed: number; failed: number }; measuredModes: UserMode[]; notes: string[];
}
/** Per card: what each user side achieved. The value of the reactive user is the cards only it completed or only it failed. */
export function modeValue(record: Experiment): ModeValue {
  record = observedRecord(record);
  const reviews = latestHumanReviews(record);
  const measuredModes = [...record.settings.userModes];
  const cards = record.scenarios.map(scenario => {
    const outcomes: ModeValue['cards'][number]['outcomes'] = {};
    for (const mode of measuredModes) {
      if (mode === 'scripted' && scenario.user.script === undefined) continue;
      const trials = record.trials.filter(t => t.scenarioId === scenario.id && t.userMode === mode);
      if (!trials.length) { outcomes[mode] = 'missing'; continue; }
      const results = trials.map(t => automaticTrialResult(scenario, t));
      outcomes[mode] = results.includes('fail') ? 'fail' : results.includes('unknown') ? 'unknown' : 'pass';
    }
    const clarification = record.trials.some(t => t.scenarioId === scenario.id && t.userMode === 'reactive' && t.events.filter(e => e.type === 'user').length > 1);
    return { scenarioId: scenario.id, title: scenario.title, familyId: scenario.familyId, outcomes, clarification };
  });
  const others = (card: ModeValue['cards'][number]) => Object.entries(card.outcomes).filter(([mode]) => mode !== 'reactive').map(([, outcome]) => outcome);
  const reactiveOnlyCompleted = cards.filter(c => c.outcomes.reactive === 'pass' && others(c).length > 0 && others(c).every(o => o === 'fail')).map(c => c.scenarioId);
  const reactiveOnlyFailed = cards.filter(c => c.outcomes.reactive === 'fail' && others(c).length > 0 && others(c).every(o => o === 'pass')).map(c => c.scenarioId);
  const confirmed = (ids: string[], verdict: 'pass' | 'fail') => ids.filter(id => record.trials.some(t => t.scenarioId === id && t.userMode === 'reactive' && reviews.get(`${t.id}|dialogue`)?.verdict === verdict)).length;
  const notes: string[] = [];
  if (measuredModes.length < 2) notes.push('Измерен один режим пользователя: ценность симулятора сравнивать не с чем.');
  if (cards.some(c => Object.values(c.outcomes).includes('unknown'))) notes.push('Карточки с неопределённым исходом не входят в списки «только реактивный».');
  return { cards, reactiveOnlyCompleted, reactiveOnlyFailed, humanConfirmed: { completed: confirmed(reactiveOnlyCompleted, 'pass'), failed: confirmed(reactiveOnlyFailed, 'fail') }, measuredModes, notes };
}
```

- [ ] **Step 5: Wire `comparison.ts`**

In `verdictSummary`, replace `if (!simulatorUsable(scenario, trial)) simulatorFlagged += 1;` with `if (!simulatorUsable(scenario, trial) || trial.simulatorChecks?.some(c => !c.passed)) simulatorFlagged += 1;`. Replace the `simulator_flagged` reason with:

```ts
  if (simulatorFlagged) reasons.push({ code: 'simulator_flagged', text: `Симулятор нарушил карточку в ${simulatorFlagged} диалог(ах) по кодовым проверкам или рубрике верности; оценки агента в них требуют проверки.`, count: simulatorFlagged });
```

After the `inspect_repeats` next step add:

```ts
  if (hasResults && simulatorFlagged) nextSteps.push({ code: 'inspect_simulator', text: `Откройте ${simulatorFlagged} диалог(ов) с пометкой симулятора: утечка, выдуманное значение, повтор или нарушение роли. Оценки агента в них ненадёжны; опровергнуть пометку можно вердиктом по проверке.`, count: simulatorFlagged });
```

In `EvidenceSummary` add `simulator: SimulatorSummary; modeValue: ModeValue;`. In `evidenceSummary`, before `return`, add:

```ts
  const simulator = simulatorSummary(record);
  const value = modeValue(record);
  notes.push(...simulator.notes, ...value.notes);
  if (value.reactiveOnlyCompleted.length) notes.push(`Только реактивный пользователь довёл до завершения: ${value.reactiveOnlyCompleted.join(', ')}. Это наблюдение на измеренных карточках, не доказательство пользы.`);
```

and return `{ verdict: verdictSummary(record), comparison, modes, calibration, fidelity, notes, pilot: pilotSummary(record), simulator, modeValue: value }`.

In `RunComparison` add `delta: { families: number; mean: number | null; interval: [number, number] | null; note: string } | null;` and `delta: null,` in the `result` literal. After the `for (const scenario of shared)` cards loop (before `const bv = verdictSummary(before);`) add:

```ts
  // Paired difference per family (Anthropic: cluster by the unit of randomization, pair the same questions). Descriptive only.
  const familyScores = (run: Experiment) => {
    const scores = new Map<string, number[]>();
    for (const scenario of shared) {
      if (result.pairs.some(p => p.scenarioId === scenario.id && p.reviewNote)) continue;
      const outcome = cardOutcome(run, scenario);
      if (outcome === 'unknown') continue;
      scores.set(scenario.familyId, [...scores.get(scenario.familyId) ?? [], outcome === 'pass' ? 1 : 0]);
    }
    return scores;
  };
  const beforeScores = familyScores(before), afterScores = familyScores(after);
  const familyDeltas = [...beforeScores].filter(([family]) => afterScores.has(family)).map(([family, was]) => mean(afterScores.get(family)!)! - mean(was)!);
  result.delta = familyDeltas.length ? { families: familyDeltas.length, mean: mean(familyDeltas), interval: clusterInterval(familyDeltas, `${before.id}|${after.id}`),
    note: 'Описательная парная дельта доли пройденных карточек по семействам; вердикт определяют списки карточек, а не среднее.' } : null;
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. `wc -l src/comparison.ts` must print fewer than 894.

- [ ] **Step 7: Commit**

```bash
git add src/outcomes.ts src/simulator.ts src/comparison.ts test/simulator.test.ts test/comparison.test.ts
git commit -m "feat(stats): simulator scorecard, mode value and paired family delta

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Release hook, single-failure clustering with prompt, simulator verdicts, external-state limitation

**Files:**
- Modify: `src/targets.ts` (preflightTarget ~22-69, new `runRelease`), `src/connection.ts` (resolveTarget ~19-29, portableTarget ~31-40), `src/experiment.ts` (freshDraft ~61, addHumanReview ~354, reassess loop ~323, runSuite ~512, evaluateReviewed ~529-540, nameFailureModes ~547-569), `test/fixtures/stdio-agent.mjs`
- Test: `test/targets.test.ts`, `test/experiment.test.ts`

**Interfaces:**
- Consumes: `ReleaseHook`, `ReleaseLog`, `simulatorChecks`, `readPrompt`
- Produces: `export async function runRelease(release: ReleaseHook, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<ReleaseLog>` in `targets.ts`; `preflightTarget` validates `release`; `resolveTarget`/`portableTarget` map `release.cwd` and `release.command`; `ExperimentLab` runs the hook before the first dialogue, clusters from one failure with `prompt`, recomputes simulator checks on reassess, accepts `checkId` of simulator checks, records the limitation `Внешнее состояние карточек не подтверждено адаптером (resetConfirmed): проверки состояния не измерены.`; fixture mode `external` replies `cards: <ids>` with `resetConfirmed: true`.

- [ ] **Step 1: Write the failing tests**

Add mode `external` to `test/fixtures/stdio-agent.mjs` — in the `rl.on('line', …)` handler, before the `time` regex line:

```js
  if (mode === 'external') {
    const cards = (request.initialState.external?.cards ?? []).map(card => card.id).join(', ');
    process.stdout.write(`${JSON.stringify({ reply: `cards: ${cards}`, events: [], records: request.initialState.records, resetConfirmed: true, eventsComplete: true, version: 'fixture-external-1' })}\n`);
    return;
  }
```

Append to `test/targets.test.ts` (import `runRelease` next to `openExternalTarget, preflightTarget`):

```ts
test('preflight checks the release hook executable without running it, and runRelease captures exit code, output and timeout', async () => {
  await assert.rejects(preflightTarget({ kind: 'command', command: process.execPath, args: [stdioFixture], timeoutMs: 1000, release: { command: '/nonexistent/release.sh', args: [], timeoutMs: 1000 } }), /хука выпуска/);
  await preflightTarget({ kind: 'command', command: process.execPath, args: [stdioFixture], timeoutMs: 1000, release: { command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 1000 } });
  const signal = new AbortController().signal;
  const ok = await runRelease({ command: process.execPath, args: ['-e', 'console.log("deployed " + process.env.AGENT_LAB_RUN_ID)'], timeoutMs: 5000 }, { ...process.env, AGENT_LAB_RUN_ID: 'run-1' }, signal);
  assert.equal(ok.exitCode, 0); assert.match(ok.stdout, /deployed run-1/); assert.equal(ok.signal, null);
  const failed = await runRelease({ command: process.execPath, args: ['-e', 'console.error("deploy failed"); process.exit(3)'], timeoutMs: 5000 }, process.env, signal);
  assert.equal(failed.exitCode, 3); assert.match(failed.stderr, /deploy failed/);
  const started = performance.now();
  const slow = await runRelease({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'], timeoutMs: 1000 }, process.env, signal);
  assert.equal(slow.exitCode, null); assert.match(slow.stderr, /exceeded 1000 ms/); assert.ok(performance.now() - started < 4000);
  await assert.rejects(runRelease({ command: '/nonexistent/release.sh', args: [], timeoutMs: 1000 }, process.env, signal), /Cannot start release hook/);
});

test('command adapters receive the external world and the fixture confirms the reset', async () => {
  const replies: unknown[] = [];
  const state = { ...world(), external: { cards: [{ id: 'c1', status: 'active' }, { id: 'c2', status: 'blocked' }] } };
  const session = await openExternalTarget({ target: { kind: 'command', command: process.execPath, args: [stdioFixture, 'external'], timeoutMs: 5000 },
    sessionId: 't', scenarioId: 's', state, history: () => [], ctx: context().ctx, onReply: reply => replies.push(reply) });
  assert.equal(await session.respond('hi'), 'cards: c1, c2');
  assert.equal((replies[0] as { resetConfirmed?: boolean }).resetConfirmed, true);
  await session.close();
});
```

Append to `test/experiment.test.ts` (imports available: `setup`, `createDemoRuntime`, `demoInput`, `createInputSchema`, `draftHash`, `ExperimentLab`; add `import { demoEvaluationInput } from '../src/demo.js';` if missing, `import { fileURLToPath } from 'node:url';` and `import { existsSync, readFileSync } from 'node:fs';`):

```ts
const stdioFixture = fileURLToPath(new URL('./fixtures/stdio-agent.mjs', import.meta.url));
function externalInput(release?: { command: string; args: string[] }, mode: 'ok' | 'external' = 'ok') {
  const base = demoEvaluationInput();
  return createInputSchema.parse({ ...base, scenarioCount: 1, settings: { ...base.settings, userModes: ['static'], repeats: 1 },
    target: { kind: 'command', command: process.execPath, args: [stdioFixture, mode], timeoutMs: 5000, ...(release ? { release } : {}) } });
}

test('the release hook runs once before the first dialogue with the run identity, and a failing hook stops the run', async t => {
  const { lab, directory } = await setup(t, createDemoRuntime());
  const marker = join(directory, 'deployed.txt');
  process.env.AGENT_LAB_MARKER = marker;
  t.after(() => { delete process.env.AGENT_LAB_MARKER; });
  const created = await lab.create(externalInput({ command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.env.AGENT_LAB_MARKER, process.env.AGENT_LAB_RUN_ID)'] }));
  await lab.waitForIdle();
  const draft = await lab.get(created.id);
  assert.equal(existsSync(marker), false, 'preparation and preflight never run the hook');
  await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const record = await lab.get(draft.id);
  assert.equal(record.phase, 'results_review', record.error ?? '');
  assert.equal(readFileSync(marker, 'utf8'), record.id);
  assert.equal(record.releaseLog?.exitCode, 0);
  const broken = await lab.create(externalInput({ command: process.execPath, args: ['-e', 'console.error("deploy failed"); process.exit(2)'] }));
  await lab.waitForIdle();
  const draft2 = await lab.get(broken.id);
  await lab.start(draft2.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft2) }); await lab.waitForIdle();
  const failed = await lab.get(draft2.id);
  assert.equal(failed.phase, 'error');
  assert.match(failed.error ?? '', /Хук выпуска завершился с кодом 2/); assert.match(failed.error ?? '', /deploy failed/);
  assert.equal(failed.trials.length, 0, 'no dialogue runs against an undeployed version');
  assert.equal(failed.releaseLog?.exitCode, 2);
});

test('a single failed dialogue is clustered, and a cluster may quote only the agent instructions it was given', async t => {
  const runtime = createDemoRuntime();
  const prompts: (string | undefined)[] = [];
  let quotes = ['Read the appointment before changing it.'];
  runtime.failureModes = async input => { prompts.push(input.prompt); return [{ id: 'no_update', name: 'Прочитал запись, но не изменил её', description: 'd', trialIds: [input.failures[0]!.trialId], promptQuotes: quotes }]; };
  const { lab } = await setup(t, runtime);
  const run = async () => {
    const base = demoEvaluationInput();
    const created = await lab.create(createInputSchema.parse({ ...base, scenarioCount: 1, settings: { ...base.settings, userModes: ['static'], repeats: 1 } }));
    await lab.waitForIdle();
    const draft = await lab.get(created.id);
    await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) }); await lab.waitForIdle();
    return lab.get(draft.id);
  };
  const named = await run();
  assert.equal(named.trials.length, 1); assert.equal(named.trials[0]!.outcome, 'fail');
  assert.deepEqual(named.failureModes?.map(m => [m.name, m.promptQuotes]), [['Прочитал запись, но не изменил её', ['Read the appointment before changing it.']]]);
  assert.equal(prompts[0], named.revisions[0]!.spec.instructions, 'sandbox clusters see the agent instructions as the prompt');
  quotes = ['this sentence is not in the instructions'];
  const rejected = await run();
  assert.equal(rejected.phase, 'results_review');
  assert.equal(rejected.failureModes, undefined);
  assert.ok(rejected.limitations.some(l => /Не удалось назвать типы провалов/.test(l) && /дословно/.test(l)));
});

test('human verdicts may target simulator checks, reassessment recomputes them, and an unconfirmed external world is a run limitation', async t => {
  const { lab } = await setup(t, createDemoRuntime());
  const base = demoEvaluationInput();
  const created = await lab.create(createInputSchema.parse({ ...base, scenarioCount: 3, settings: { ...base.settings, userModes: ['reactive'], repeats: 1 } }));
  await lab.waitForIdle();
  const draft = await lab.get(created.id);
  await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const record = await lab.get(draft.id);
  const clarified = record.trials.find(t => t.events.filter(e => e.type === 'user').length > 1)!;
  assert.ok(clarified.simulatorChecks!.length >= 2);
  await lab.addHumanReview(record.id, { trialId: clarified.id, checkId: 'simulator_loop', verdict: 'fail', note: 'looked like a loop to me' });
  await assert.rejects(lab.addHumanReview(record.id, { trialId: clarified.id, checkId: 'simulator_missing', verdict: 'fail', note: 'x' }), /проверки симулятора/);
  const reassessed = await lab.reassess(record.id, { codeOnly: true }); await lab.waitForIdle();
  const again = (await lab.get(reassessed.id)).trials.find(t => t.id === clarified.id)!;
  assert.deepEqual(again.simulatorChecks, clarified.simulatorChecks);
  const external = await lab.create(createInputSchema.parse({ ...externalInput(undefined, 'ok'), scenarioCount: 0,
    goldenCases: [{ id: 'gold_cards', goal: 'List my cards', opening: 'Which cards do I have?', successCriteria: 'Two cards are listed', maxFollowUps: 0, metrics: [{ id: 'goal', name: 'Goal', subject: 'agent', description: 'd', passCriteria: 'p', failCriteria: 'f' }],
      initialState: { records: {}, writableFields: [], transientFailures: 0, external: { cards: [{ id: 'c1' }, { id: 'c2' }] } } }] }));
  await lab.waitForIdle();
  const draft2 = await lab.get(external.id);
  await lab.start(draft2.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft2) }); await lab.waitForIdle();
  const unconfirmed = await lab.get(draft2.id);
  assert.ok(unconfirmed.limitations.includes('Внешнее состояние карточек не подтверждено адаптером (resetConfirmed): проверки состояния не измерены.'), unconfirmed.limitations.join('\n'));
  assert.match(unconfirmed.trials[0]!.reason, /не подтверждено адаптером/);
  const repeated = await lab.repeat(unconfirmed.id);
  assert.ok(!repeated.limitations.some(l => l.startsWith('Внешнее состояние карточек')));
});
```

If the demo runtime rejects `scenarioCount: 0` with owner cards, the demo `prepare` guard `count < 1` is the reason: pass `scenarioCount: 1` instead and pick the golden trial with `record.trials.find(t => t.scenarioId === 'gold_cards')`.

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx tsx --test test/targets.test.ts test/experiment.test.ts`
Expected: FAIL — `runRelease` missing; preflight accepts a missing hook; the hook never runs; `promptQuotes` rejected because no prompt is passed; `simulator_loop` rejected; no limitation.

- [ ] **Step 3: Implement `targets.ts`**

Extract the PATH search from `preflightTarget` into a helper placed above it:

```ts
async function ensureExecutable(command: string, cwd: string, label: string): Promise<void> {
  const windows = process.platform === 'win32';
  const hasPath = command.includes('/') || windows && command.includes('\\');
  const path = windows ? Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] : process.env.PATH;
  const directories = hasPath ? [''] : (path ?? (windows ? '' : '/usr/bin:/bin')).split(delimiter);
  const suffixes = windows && !extname(command) ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  let denied: string | undefined;
  for (const directory of directories) for (const suffix of suffixes) {
    const candidate = resolve(cwd, directory, command + suffix);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') denied ??= candidate;
      else if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
  }
  if (denied) throw new Error(`Нет права запуска ${label}: ${denied}. Проверьте права или выберите другой исполняемый файл.`);
  throw new Error(`Не найдена ${label}: ${command}. Укажите полный путь к исполняемому файлу или добавьте его папку в PATH.`);
}
```

In `preflightTarget`, after the `http` early return (`if (target.kind === 'http') { httpHeaders(target); ... }` — restructure so the release check runs for every external kind):

```ts
export async function preflightTarget(target: Target): Promise<void> {
  if (target.kind === 'sandbox') return;
  if (target.promptFile) await readPrompt(target.promptFile);
  if (target.release) {
    const cwd = target.release.cwd ?? process.cwd();
    try { if (!(await stat(cwd)).isDirectory()) throw new Error(`Рабочая папка хука выпуска не является папкой: ${cwd}.`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Не найдена рабочая папка хука выпуска: ${cwd}.`); throw error; }
    await ensureExecutable(target.release.command, cwd, 'команда хука выпуска');
  }
  if (target.kind === 'http') { httpHeaders(target); return; }
  // …existing entry-file and cwd checks unchanged…
  await ensureExecutable(target.command, cwd, 'команда агента');
}
```

Keep the existing error texts for the agent command (`Нет права запуска команды агента` / `Не найдена команда агента`) by passing the label `'команда агента'` and adjusting the two messages to `Нет права запуска ${label}` → for the label `команда агента` the text reads `Нет права запуска команда агента` — wrong case. Use labels in the genitive: `'команды агента'` and `'команды хука выпуска'`, and the messages `Нет права запуска ${label}: …` / `Не найдена ${label}: …` become `Не найдена команды агента` — also wrong. Resolve it by passing two forms: `ensureExecutable(command, cwd, { missing: 'Не найдена команда агента', denied: 'Нет права запуска команды агента' })` and `{ missing: 'Не найдена команда хука выпуска', denied: 'Нет права запуска команды хука выпуска' }`; the helper builds `${labels.denied}: ${denied}. …` and `${labels.missing}: ${command}. …`. The existing test regexes `/Не найдена команда агента/` keep passing.

Append `runRelease`:

```ts
/** Deploys the version under test. Output tails are kept for the record; the adapter's `version` remains the identity. */
export async function runRelease(release: ReleaseHook, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<ReleaseLog> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  return new Promise((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(release.command, release.args, { cwd: release.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { reject(new Error(`Cannot start release hook ${release.command}: ${error instanceof Error ? error.message : String(error)}`)); return; }
    let stdout = '', stderr = '', timedOut = false;
    child.stdout?.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-4000); });
    child.stderr?.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, release.timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', error => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(new Error(`Cannot start release hook ${release.command}: ${error.message}`)); });
    child.once('close', (code, sig) => {
      clearTimeout(timer); signal.removeEventListener('abort', onAbort);
      if (timedOut) stderr = `${stderr}\nRelease hook exceeded ${release.timeoutMs} ms`.slice(-4000);
      resolvePromise({ command: [release.command, ...release.args].join(' '), exitCode: code, signal: sig, stdout, stderr, startedAt, durationMs: Math.round(performance.now() - started) });
    });
  });
}
```

Add `type ReleaseHook, type ReleaseLog` to the contracts import.

- [ ] **Step 4: Implement `connection.ts`**

In `resolveTarget`, before `return targetSchema.parse(target);`:

```ts
  if (target.kind !== 'sandbox' && target.release && typeof target.release === 'object') {
    const release = { ...(target.release as Record<string, unknown>) };
    if (typeof release.cwd === 'string') release.cwd = resolve(base, release.cwd);
    if (typeof release.command === 'string' && release.command.includes('/')) release.command = resolve(typeof release.cwd === 'string' ? release.cwd : base, release.command);
    target.release = release;
  }
```

In `portableTarget`, compute a portable release and spread it into every external return:

```ts
  const release = target.kind !== 'sandbox' && target.release ? { release: { ...target.release, ...(target.release.cwd ? { cwd: path(target.release.cwd) } : {}),
    command: isAbsolute(target.release.command) ? executable(target.release.cwd ?? base, target.release.command) : target.release.command } } : {};
```

and use `{ ...target, ...prompt, ...release, path: path(target.path) }`, `{ ...target, ...prompt, ...release }` and `{ ...target, ...prompt, ...release, cwd: …, command: …, args: … }`.

- [ ] **Step 5: Implement `experiment.ts`**

Imports: add `readPrompt, runRelease` to the `./targets.js` import and `import { simulatorChecks } from './simulator.js';`.

In `freshDraft`, extend the limitations filter: `record.limitations = previous.limitations.filter(note => !note.startsWith('Scripted mode skipped') && !note.startsWith('Не удалось назвать типы провалов:') && !note.startsWith('Внешнее состояние карточек не подтверждено'));` and `delete record.releaseLog;` next to the other deletes.

In `reassess`, right after `trial.checks = grade(scenario, trial);` add `trial.simulatorChecks = simulatorChecks(scenario, trial);`.

In `addHumanReview`, replace the checkId line with:

```ts
      if (input.checkId && !trial.checks.some(c => c.id === input.checkId) && !trial.simulatorChecks?.some(c => c.id === input.checkId)) throw new Error('Такой объективной проверки или проверки симулятора в этом диалоге нет.');
```

In `runSuite`, after `record.trials.push(trial);` add:

```ts
          if (record.target.kind !== 'sandbox' && scenario.initialState.external && trial.observation?.resetConfirmed !== true) {
            const note = 'Внешнее состояние карточек не подтверждено адаптером (resetConfirmed): проверки состояния не измерены.';
            if (!record.limitations.includes(note)) record.limitations.push(note);
          }
```

Add the hook and call it first in `evaluateReviewed`:

```ts
  /** The rollout of the version under test. The adapter's reported `version` remains the identity; this only performs the deployment. */
  private async release(record: Experiment, ctx: CallContext): Promise<void> {
    const target = record.target;
    if (target.kind === 'sandbox' || !target.release) return;
    const env: NodeJS.ProcessEnv = { ...process.env, AGENT_LAB_RUN_ID: record.id,
      ...(record.targetVersion ? { AGENT_LAB_TARGET_VERSION: record.targetVersion } : {}),
      ...(target.promptFile ? { AGENT_LAB_PROMPT_FILE: target.promptFile, AGENT_LAB_PROMPT_HASH: fingerprint(await readPrompt(target.promptFile)) } : {}) };
    record.message = 'Разворачиваю проверяемую версию агента (хук выпуска).';
    await this.checkpoint(record, record.phase, record.message);
    record.releaseLog = await runRelease(target.release, env, ctx.signal);
    ctx.signal.throwIfAborted();
    if (record.releaseLog.exitCode !== 0) throw new Error(`Хук выпуска завершился с кодом ${record.releaseLog.exitCode ?? record.releaseLog.signal ?? 'unknown'}: ${record.releaseLog.stderr.trim().slice(-500) || 'без вывода'}`);
  }
  private async evaluateReviewed(record: Experiment, ctx: CallContext): Promise<void> {
    const runtime = await this.runtime(record);
    const agent = record.revisions[0];
    if (!agent || !record.manifestHash) throw new Error('Missing reviewed agent or measurement manifest.');
    await this.release(record, ctx);
    await this.runSuite(record, runtime, agent, 'dev', '', ctx);
    // …rest unchanged…
```

Replace `nameFailureModes` (and its doc comment):

```ts
  /**
   * Naming the failure precisely is what turns an evaluation into an improvement loop, so the
   * failed dialogues of a finished run are clustered and named — a single failure gets a name
   * too, because one named failure is already a fix to try. When the prompt of the agent is
   * known (a promptFile, or the sandbox instructions), the cluster may quote the fragment that
   * governed the broken behaviour; quotes are checked verbatim. A failed clustering must not
   * lose a completed run: it is recorded as a limitation instead.
   */
  private async nameFailureModes(record: Experiment, runtime: Runtime, ctx: CallContext): Promise<void> {
    const failed = record.trials.filter(t => isAgentFailure(record, t));
    if (!runtime.failureModes || !failed.length) return;
    const prompt = record.target.kind !== 'sandbox' ? (record.target.promptFile ? await readPrompt(record.target.promptFile) : undefined)
      : record.revisions.find(r => r.id === record.selectedRevisionId)?.spec.instructions;
    const failures = failed.map(trial => ({ /* unchanged mapping */ }));
    try {
      const modes = await runtime.failureModes({ task: record.task, failures, ...(prompt !== undefined ? { prompt } : {}) }, ctx);
      validateFailureModes(modes, failed, prompt);
      record.failureModes = modes;
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      record.limitations.push(`Не удалось назвать типы провалов: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
```

(`readPrompt` may throw for a missing prompt file; that is already caught by preflight before the run.)

- [ ] **Step 6: Run the tests**

Run: `npm test && npm run typecheck`
Expected: PASS. The existing test `провалы прогона получают имена, а сорванная кластеризация не теряет прогон` may have asserted that one failure is *not* clustered; if it does, change that assertion to expect a cluster (the spec lowered the threshold on purpose) and keep its "broken clustering keeps the run" half.

- [ ] **Step 7: Commit**

```bash
git add src/targets.ts src/connection.ts src/experiment.ts test/fixtures/stdio-agent.mjs test/targets.test.ts test/experiment.test.ts
git commit -m "feat(experiment): release hook, single-failure clusters with prompt quotes, simulator verdicts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Surfaces — reports, board, editor fields, annotation targets, CLI

**Files:**
- Modify: `src/report.ts` (trialHTML ~81-103, comparisonHTML ~114-118, limits section ~175, markdown ~187-249), `extensions/cards.ts` (trialLines ~131-134, statsLines ~255-259, comparisonLines ~284-288, scenarioLines ~87-89), `extensions/editor.ts` (fields ~182-193, ~246-258), `extensions/agent-lab.ts` (humanAnnotation targets ~91-96), `src/cli.ts` (diff ~104-114, pilot ~71-75)
- Test: `test/cards.test.ts`, `test/artifacts.test.ts`, `test/editor.test.ts`

**Interfaces:**
- Consumes: `EvidenceSummary.simulator`, `EvidenceSummary.modeValue`, `RunComparison.delta`, `Trial.simulatorChecks` (Tasks 1, 6)
- Produces: HTML/Markdown/board blocks named exactly `Симулированный пользователь · кодовые проверки` (per trial), `Симулятор · кодовые проверки` (scorecard), `Ценность режимов`, `Парная дельта по семействам`; editor labels `Что знает пользователь · по одному в строке`, `Чего пользователь не может знать · по одному в строке`, `Ответы на уточнения · JSON`, `Внешнее состояние · JSON`; annotation target label prefix `Симулятор ·`.

- [ ] **Step 1: Write the failing tests**

Append to `test/cards.test.ts` (uses its `fixture()`, `theme`, `LabBoard`, `visibleWidth`, `stripTerminalSequences`, `emptyUsage`, `evidenceBundle`, `htmlReport`, `markdownReport`):

```ts
test('the board shows simulator checks on a dialogue, the scorecard and mode value in statistics, and the family delta in comparison', async () => {
  const record = await fixture(); record.phase = 'results_review'; record.reviewedAt = '2026-09-14T00:00:00.000Z';
  record.settings.userModes = ['static', 'reactive']; record.settings.repeats = 1;
  const card = record.scenarios[0]!;
  const events = [{ seq: 0, type: 'user' as const, text: card.user.opening }, { seq: 1, type: 'assistant' as const, text: 'Which appointment?' },
    { seq: 2, type: 'simulator' as const, result: { message: 'Appointment A777', done: false } }, { seq: 3, type: 'user' as const, text: 'Appointment A777' }, { seq: 4, type: 'assistant' as const, text: 'Done.' }];
  const base = { revisionId: 'revision-1', scenarioId: card.id, familyId: card.familyId, repeat: 0, split: 'dev' as const, manifestHash: 'hash', reason: '', initialState: card.initialState, finalState: card.initialState, usage: emptyUsage(), elapsedMs: 1 };
  record.trials = [
    { ...base, id: 'reactive', userMode: 'reactive', outcome: 'fail', checks: card.checks.map(c => ({ id: c.id, description: c.description, passed: false, evidence: 'e' })), events,
      simulatorChecks: [{ id: 'simulator_fabrication', description: 'Пользователь не называет значения, которых нет в карточке (эвристика)', passed: false, evidence: 'Подозрение: реплика #3 содержит значение «a777»', seq: 3, heuristic: true }] },
    { ...base, id: 'static', userMode: 'static', outcome: 'pass', checks: card.checks.map(c => ({ id: c.id, description: c.description, passed: true, evidence: 'e' })), events: events.slice(0, 2) },
  ];
  const results = new LabBoard({ record, section: 'results' }, theme, () => {}, () => {}, () => 60);
  const stats = new LabBoard({ record, section: 'stats' }, theme, () => {}, () => {}, () => 80);
  try {
    for (const width of [80, 132]) for (const board of [results, stats]) for (const row of board.render(width)) assert.ok(visibleWidth(row) <= width);
    const dialogue = stripTerminalSequences(results.render(132).join('\n'));
    assert.match(dialogue, /ПРОВЕРКИ СИМУЛЯТОРА/); assert.match(dialogue, /× .*эвристика/); assert.match(dialogue, /Подозрение: реплика #3/);
    const statistics = stripTerminalSequences(stats.render(132).join('\n'));
    assert.match(statistics, /Симулятор · кодовые проверки/); assert.match(statistics, /реактивных диалогов 1/);
    assert.match(statistics, /Ценность режимов/); assert.match(statistics, /только реактивный провалил: .*Move an appointment/);
  } finally { results.dispose(); stats.dispose(); }
  const before = structuredClone(record); before.id = 'before'; before.settings.userModes = ['static']; before.trials = [before.trials[1]!];
  before.trials[0]!.outcome = 'fail'; before.trials[0]!.checks = before.trials[0]!.checks.map(c => ({ ...c, passed: false }));
  const after = structuredClone(before); after.id = 'after'; after.parentRunId = 'before'; after.trials[0]!.id = 'after_static'; after.trials[0]!.outcome = 'pass'; after.trials[0]!.checks = after.trials[0]!.checks.map(c => ({ ...c, passed: true }));
  const bundle = await evidenceBundle(after, { get: async () => before, traceJournal: async () => '' });
  assert.equal(bundle.comparison?.delta?.families, 1);
  const comparison = new LabBoard({ record: after, before, comparison: bundle.comparison, section: 'comparison' }, theme, () => {}, () => {}, () => 40);
  try {
    const text = stripTerminalSequences(comparison.render(120).join('\n'));
    assert.match(text, /Парная дельта по семействам: \+1\.00 · семейств 1 · интервал недоступен/);
    for (const output of [htmlReport(bundle), markdownReport(bundle)]) assert.match(output, /Парная дельта по семействам/);
  } finally { comparison.dispose(); }
});
```

Append to `test/artifacts.test.ts` (uses `twoRuns`, `evidenceBundle`, `htmlReport`, `markdownReport`, `jsonReport`):

```ts
test('every export renders simulator checks, the scorecard and mode value from the shared snapshot', async t => {
  const { lab, after } = await twoRuns(t);
  const trial = after.trials[0]!;
  trial.events = [...trial.events, { seq: trial.events.length, type: 'simulator', result: { message: 'again', done: false } }, { seq: trial.events.length + 1, type: 'user', text: 'again' }, { seq: trial.events.length + 2, type: 'assistant', text: 'ok' }];
  trial.simulatorChecks = [{ id: 'simulator_loop', description: 'Пользователь не повторяет одну и ту же реплику', passed: false, evidence: 'Реплика #7 повторяет реплику #0 <script>', seq: 7, heuristic: false }];
  const bundle = await evidenceBundle(after, lab.store);
  const html = htmlReport(bundle);
  assert.match(html, /Симулированный пользователь · кодовые проверки/);
  assert.match(html, /Реплика #7 повторяет реплику #0 &lt;script&gt;/); assert.doesNotMatch(html, /#0 <script>/);
  assert.match(html, /Симулятор · кодовые проверки/); assert.match(html, /Ценность режимов/);
  const markdown = markdownReport(bundle);
  assert.match(markdown, /## Симулятор/); assert.match(markdown, /simulator_loop/); assert.match(markdown, /Ценность режимов/);
  const json = JSON.parse(jsonReport(bundle));
  assert.equal(json.evidence.simulator.reactiveDialogues, 1);
  assert.equal(json.evidence.simulator.checks.find((c: { id: string }) => c.id === 'simulator_loop').flagged, 1);
  assert.ok(Array.isArray(json.evidence.modeValue.cards));
});
```

Append to `test/editor.test.ts`:

```ts
test('user state and the external world are editable as plain fields without touching other card fields', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-user-state-'));
  const lab = new ExperimentLab(directory); await lab.init();
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  const created = await lab.create(demoEvaluationInput()); await lab.waitForIdle();
  let record = await lab.get(created.id);
  const original = structuredClone(record.scenarios[0]!);
  const edit = async (label: string, text: string) => {
    const choices = ['Расширенные настройки', label];
    const ctx = { ui: { select: async () => choices.shift(), editor: async () => text } } as unknown as ExtensionContext;
    const patch = await editDraft(ctx, { type: 'edit', record, section: 'cards', selected: 0 });
    record = await lab.updateDraft(record.id, draftHash(record), patch!);
    return record.scenarios[0]!;
  };
  assert.deepEqual((await edit('Что знает пользователь · по одному в строке', 'Appointment ID A101\nDesired time 14:00\n')).user.knows, ['Appointment ID A101', 'Desired time 14:00']);
  assert.deepEqual((await edit('Чего пользователь не может знать · по одному в строке', 'Backend reason')).user.cannotKnow, ['Backend reason']);
  assert.deepEqual((await edit('Ответы на уточнения · JSON', '[{"ifAsked":"ID","reply":"A101"}]')).user.answers, [{ ifAsked: 'ID', reply: 'A101' }]);
  assert.deepEqual((await edit('Внешнее состояние · JSON', '{"cards":[{"id":"c1"}]}')).initialState.external, { cards: [{ id: 'c1' }] });
  const cleared = await edit('Внешнее состояние · JSON', '');
  assert.equal(cleared.initialState.external, undefined);
  assert.deepEqual(cleared.checks, original.checks); assert.equal(cleared.user.opening, original.user.opening);
  const rejected = ['Расширенные настройки', 'Ответы на уточнения · JSON'];
  const attempts = ['not json', '[{"ifAsked":"ID","reply":"A101"}]']; const titles: string[] = [];
  const ctx = { ui: { select: async () => rejected.shift(), editor: async (title: string) => { titles.push(title); return attempts.shift(); } } } as unknown as ExtensionContext;
  await editDraft(ctx, { type: 'edit', record, section: 'cards', selected: 0 });
  assert.match(titles[1]!, /Некорректный JSON/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx tsx --test test/cards.test.ts test/artifacts.test.ts test/editor.test.ts`
Expected: FAIL on the new tests (missing blocks and labels).

- [ ] **Step 3: Implement `src/report.ts`**

Add two helpers after `originalChecks`:

```ts
const simulatorNames: Record<string, string> = { simulator_leak: 'утечка скрытого значения', simulator_fabrication: 'выдуманное значение (эвристика)', simulator_loop: 'повтор реплики' };
function simulatorChecksHTML(trial: Trial): string {
  if (trial.userMode !== 'reactive') return '';
  const checks = trial.simulatorChecks ?? [];
  return `<h3>Симулированный пользователь · кодовые проверки</h3>${checks.length ? list(checks.map(c => `${c.passed ? 'Пройдено' : 'Не пройдено'} · ${c.description}: ${c.evidence}`)) : '<p class="muted">Не применялись: симулятор не отправил ни одной реплики после первой.</p>'}`;
}
function simulatorSectionHTML(bundle: EvidenceBundle): string {
  const s = bundle.evidence.simulator, v = bundle.evidence.modeValue;
  const row = (c: typeof s.checks[number]) => `<tr><td>${escape(simulatorNames[c.id] ?? c.id)}</td><td>${c.flagged} / ${c.dialogues}</td><td>${c.examples.map(e => `${escape(e.trialId.slice(0, 8))}${e.seq === undefined ? '' : ` #${e.seq}`}: ${escape(e.evidence)}`).join('<br>') || '—'}</td></tr>`;
  const card = (c: typeof v.cards[number]) => `<tr><td>${escape(c.title)}</td>${v.measuredModes.map(m => `<td>${escape(c.outcomes[m] ? outcomes[c.outcomes[m]!] ?? c.outcomes[m]! : '—')}</td>`).join('')}<td>${c.clarification ? 'да' : 'нет'}</td></tr>`;
  return `<section id="simulator"><h2>Симулятор · кодовые проверки</h2><p class="basis">Реактивных диалогов ${s.reactiveDialogues}. Кодовые проверки описывают реплики пользователя и не меняют исход диалога; подозрение по эвристике опровергается вердиктом по проверке.</p>
<table><thead><tr><th>Проверка</th><th>Отмечено / проверено</th><th>Примеры</th></tr></thead><tbody>${s.checks.map(row).join('')}</tbody></table>
<p>Судья по рубрике верности: применимо ${s.judge.applicable}, пройдено ${s.judge.pass}, не пройдено ${s.judge.fail}, неясно ${s.judge.unknown}, без оценки ${s.judge.missing}. Человек: ${s.human.reviewed} вердиктов, подтверждено ${s.human.confirmed}, опровергнуто ${s.human.rejected}. Уточнения агента получили ответ в ${s.clarifications.answered} из ${s.clarifications.dialogues} диалогов; пользователь ушёл, не достигнув цели, в ${s.disengaged}.</p>${list(s.notes)}
<h3>Ценность режимов</h3><table><thead><tr><th>Карточка</th>${v.measuredModes.map(m => `<th>${escape(modes[m])}</th>`).join('')}<th>Уточнение</th></tr></thead><tbody>${v.cards.map(card).join('')}</tbody></table>
<p>Только реактивный завершил: ${v.reactiveOnlyCompleted.length} (подтверждено человеком ${v.humanConfirmed.completed}). Только реактивный провалил: ${v.reactiveOnlyFailed.length} (подтверждено человеком ${v.humanConfirmed.failed}).</p>${list(v.notes)}</section>`;
}
```

In `trialHTML`, insert `${simulatorChecksHTML(trial)}` right after the `<h3>Пройдено по точным проверкам</h3>…` line. In `htmlReport`, insert `${simulatorSectionHTML(bundle)}` right before the `<section id="limits">` line and add `<a href="#simulator">Симулятор</a>` to the `nav`. In `comparisonHTML`, after the `<p class="basis">Сопоставлено …</p>` line add:

```ts
${comparison.delta ? `<p>Парная дельта по семействам: ${comparison.delta.mean === null ? 'нет данных' : `${comparison.delta.mean >= 0 ? '+' : ''}${comparison.delta.mean.toFixed(2)}`} · семейств ${comparison.delta.families} · ${comparison.delta.interval ? `95% интервал ${comparison.delta.interval[0].toFixed(2)}…${comparison.delta.interval[1].toFixed(2)}` : 'интервал недоступен'}. ${escape(comparison.delta.note)}</p>` : ''}
```

In `markdownReport`, after the `'## Режимы пользователя'` table rows, add:

```ts
    '## Симулятор', '', `Реактивных диалогов: ${e.simulator.reactiveDialogues}. Кодовые проверки описывают реплики пользователя и не меняют исход диалога.`, '',
    '| Проверка | Отмечено / проверено | Эвристика |', '|---|---|---|',
    ...e.simulator.checks.map(c => `| ${md(c.id)} | ${c.flagged}/${c.dialogues} | ${c.heuristic ? 'да' : 'нет'} |`), '',
    `Судья по верности: ${e.simulator.judge.pass} пройдено, ${e.simulator.judge.fail} не пройдено, ${e.simulator.judge.unknown} неясно из ${e.simulator.judge.applicable}. Человек: подтверждено ${e.simulator.human.confirmed}, опровергнуто ${e.simulator.human.rejected}. Уточнения с ответом: ${e.simulator.clarifications.answered}/${e.simulator.clarifications.dialogues}. Ушли без цели: ${e.simulator.disengaged}.`, '',
    ...e.simulator.notes.map(n => `- ${md(n)}`), '',
    '### Ценность режимов', '', ...e.modeValue.cards.map(c => `- ${md(c.title)}: ${e.modeValue.measuredModes.map(m => `${m} ${c.outcomes[m] ?? '—'}`).join(', ')}${c.clarification ? ' · уточнение' : ''}`), '',
    `Только реактивный завершил: ${e.modeValue.reactiveOnlyCompleted.length}; только реактивный провалил: ${e.modeValue.reactiveOnlyFailed.length}; подтверждено человеком ${e.modeValue.humanConfirmed.completed}/${e.modeValue.humanConfirmed.failed}.`, '',
```

and in the comparison branch after `md(comparison.headline), ''` add `...(comparison.delta ? [`Парная дельта по семействам: ${comparison.delta.mean === null ? 'нет данных' : comparison.delta.mean.toFixed(2)} (семейств ${comparison.delta.families}${comparison.delta.interval ? `, 95% ${comparison.delta.interval[0].toFixed(2)}…${comparison.delta.interval[1].toFixed(2)}` : ''}). ${md(comparison.delta.note)}`, ''] : [])`. In the per-trial markdown block, after `...originalChecks(record, t).map(c => \`- ${md(c)}\`)` add `...(t.simulatorChecks ?? []).map(c => \`- Симулятор · ${c.passed ? 'пройдено' : 'не пройдено'} · ${md(c.id)}: ${md(c.evidence)}\`)`.

- [ ] **Step 4: Implement `extensions/cards.ts`**

In `trialLines`, after the deterministic checks block (the `line(''), line('ДЕТЕРМИНИРОВАННЫЕ ПРОВЕРКИ', 'accent'), ...` entry) add:

```ts
    ...(trial.userMode === 'reactive' ? [line(''), line('ПРОВЕРКИ СИМУЛЯТОРА', 'accent'),
      ...(trial.simulatorChecks?.length ? trial.simulatorChecks.flatMap(c => [
        line(`${c.passed ? '✓' : '×'} ${c.description} [${c.id}]`, c.passed ? 'success' : 'error'), line(c.evidence, 'muted'),
      ]) : [line('Не применялись: симулятор не отправил реплик после первой.', 'muted')])] : []),
```

In `scenarioLines` expanded rows, after `line(\`Знает: ${scenario.user.facts}\`)` add:

```ts
    ...(scenario.user.knows?.length ? [line(`Знает точно: ${scenario.user.knows.join('; ')}`)] : []),
    ...(scenario.user.cannotKnow?.length ? [line(`Не может знать: ${scenario.user.cannotKnow.join('; ')}`, 'muted')] : []),
    ...(scenario.user.answers ?? []).map(a => line(`Если спросят «${a.ifAsked}»: «${a.reply}»`)),
```

and in the expanded `НАЧАЛЬНОЕ СОСТОЯНИЕ` block nothing changes (`json(scenario.initialState)` already prints `external`).

In `statsLines`, after the `Режимы пользователя` loop add:

```ts
  const s = e.simulator;
  rows.push(line(''), line('Симулятор · кодовые проверки', 'accent'),
    line(`реактивных диалогов ${s.reactiveDialogues} · уточнения агента получили ответ ${s.clarifications.answered}/${s.clarifications.dialogues} · ушли без цели ${s.disengaged}`, 'muted'));
  for (const c of s.checks) rows.push(line(`${simulatorNames[c.id] ?? c.id}: отмечено ${c.flagged} из ${c.dialogues}${c.examples[0] ? ` · ${c.examples[0].evidence}` : ''}`, c.flagged ? 'warning' : 'text'));
  rows.push(line(`судья по верности: ${s.judge.pass} пройдено · ${s.judge.fail} не пройдено · ${s.judge.unknown} неясно из ${s.judge.applicable} · человек: подтверждено ${s.human.confirmed}, опровергнуто ${s.human.rejected}`, 'muted'));
  rows.push(...s.notes.map(n => line(`• ${n}`, 'muted')));
  const v = e.modeValue;
  rows.push(line(''), line('Ценность режимов', 'accent'));
  for (const c of v.cards) rows.push(line(`${c.title}: ${v.measuredModes.map(m => `${m} ${c.outcomes[m] ?? '—'}`).join(' · ')}${c.clarification ? ' · уточнение' : ''}`));
  rows.push(line(`только реактивный завершил: ${v.reactiveOnlyCompleted.map(id => record.scenarios.find(s => s.id === id)?.title ?? id).join(', ') || 'нет'} (человек подтвердил ${v.humanConfirmed.completed})`, v.reactiveOnlyCompleted.length ? 'success' : 'muted'));
  rows.push(line(`только реактивный провалил: ${v.reactiveOnlyFailed.map(id => record.scenarios.find(s => s.id === id)?.title ?? id).join(', ') || 'нет'} (человек подтвердил ${v.humanConfirmed.failed})`, v.reactiveOnlyFailed.length ? 'warning' : 'muted'));
  rows.push(...v.notes.map(n => line(`• ${n}`, 'muted')));
```

with `const simulatorNames: Record<string, string> = { simulator_leak: 'утечка скрытого значения', simulator_fabrication: 'выдуманное значение (эвристика)', simulator_loop: 'повтор реплики' };` defined near `tierLabels`.

In `comparisonLines`, after the `ПО ЭТАПАМ` block add:

```ts
    ...(comparison.delta ? [line(''), line(`Парная дельта по семействам: ${comparison.delta.mean === null ? 'нет данных' : `${comparison.delta.mean >= 0 ? '+' : ''}${comparison.delta.mean.toFixed(2)}`} · семейств ${comparison.delta.families} · ${comparison.delta.interval ? `95% ${comparison.delta.interval[0].toFixed(2)}…${comparison.delta.interval[1].toFixed(2)}` : 'интервал недоступен'}`), line(comparison.delta.note, 'muted')] : []),
```

- [ ] **Step 5: Implement `extensions/editor.ts` and `extensions/agent-lab.ts`**

In `editDraft`, extend `fields` (append before `['metrics', 'Метрики · JSON']`):

```ts
      ['knows', 'Что знает пользователь · по одному в строке'], ['cannotKnow', 'Чего пользователь не может знать · по одному в строке'],
      ['answers', 'Ответы на уточнения · JSON'], ['external', 'Внешнее состояние · JSON'],
```

and update the generic editor at the end of the cards branch:

```ts
    const userFields = new Set(['persona', 'characteristics', 'goal', 'behavior', 'facts', 'opening', 'maxFollowUps', 'script', 'knows', 'cannotKnow', 'answers']);
    const object = (field === 'external' ? scenario.initialState : userFields.has(field) ? scenario.user : scenario) as unknown as Record<string, unknown>;
    const json = ['metrics', 'checks', 'initialState', 'answers', 'external'].includes(field);
    const array = ['characteristics', 'assumptions', 'script', 'knows', 'cannotKnow'].includes(field);
    const initial = object[field];
    return editPatch(title, json ? (field === 'external' && initial === undefined ? '' : JSON.stringify(initial ?? [], null, 2))
      : array ? (initial as string[] | undefined)?.join('\n') ?? '' : String(initial ?? ''), changed => {
      if (field === 'maxFollowUps' && !/^\d+$/.test(changed.trim())) throw new Error('Введите целое число от 0 до 15.');
      if (field === 'external' && !changed.trim()) { delete object[field]; return { scenarios: [scenario] }; }
      object[field] = json ? JSON.parse(changed) : field === 'script' ? changed === '' ? [] : changed.split('\n')
        : array ? changed.split('\n').map(v => v.trim()).filter(Boolean) : field === 'maxFollowUps' ? Number(changed) : changed;
      if (field === 'persona' && !changed.trim()) delete object[field];
      if ((field === 'knows' || field === 'cannotKnow') && !(object[field] as string[]).length) delete object[field];
      return { scenarios: [scenario] };
    });
```

In `agent-lab.ts` `humanAnnotation`, extend `targets` after the checks entry:

```ts
    ...(trial.simulatorChecks ?? []).map(c => ({ label: `Симулятор · ${safeText(c.description)} [${c.id}]`, ids: { checkId: c.id }, trialIds: [trial.id] })),
```

- [ ] **Step 6: Implement `src/cli.ts`**

In the `diff` text output, after the tiers block add:

```ts
        ...(diff.delta ? [`Парная дельта по семействам: ${diff.delta.mean === null ? 'нет данных' : diff.delta.mean.toFixed(2)} · семейств ${diff.delta.families}${diff.delta.interval ? ` · 95% ${diff.delta.interval[0].toFixed(2)}…${diff.delta.interval[1].toFixed(2)}` : ' · интервал недоступен'}`, `  ${diff.delta.note}`, ''] : []),
```

In `pilot`, print both blocks: `process.stdout.write(JSON.stringify({ pilot: evidenceSummary(record).pilot, simulator: evidenceSummary(record).simulator, modeValue: evidenceSummary(record).modeValue }, null, 2) + '\n');` (call `evidenceSummary` once into a const).

- [ ] **Step 7: Run the suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. Board width assertions in the new test guard the wrapping; if `visibleWidth` fails at 80, shorten the offending `line(...)` text rather than the test.

- [ ] **Step 8: Commit**

```bash
git add src/report.ts src/cli.ts extensions/cards.ts extensions/editor.ts extensions/agent-lab.ts test/cards.test.ts test/artifacts.test.ts test/editor.test.ts
git commit -m "feat(ui): simulator checks, scorecard, mode value and family delta on every surface

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Documentation, glossary and skill

**Files:**
- Modify: `docs/REFERENCE.md`, `docs/WORKFLOWS.md`, `docs/EVALS-METHOD.md`, `CONTEXT.md`, `README.md`, `skills/agent-builder/SKILL.md`, `examples/echo-agent.py`

**Interfaces:** none (prose only). The skill is loaded by `test/extension.test.ts` through the real resource loader; keep the frontmatter intact.

- [ ] **Step 1: `docs/REFERENCE.md`** — after the "Подключение своего агента" section add a subsection `## Состояние пользователя и внешний мир` with this content:

```markdown
## Состояние пользователя и внешний мир

Карточка описывает пользователя пятью полями. `goal`, `facts`, `behavior` и `opening` остались прежними. Новые поля необязательны:

- `knows` — атомарные факты, которые пользователь может назвать, с точными значениями: `["Последние четыре цифры 4321", "Две карты"]`.
- `cannotKnow` — чего пользователь знать не может, словами: `["Причина отказа на стороне банка"]`. Симулятор не утверждает и не угадывает это.
- `answers` — ответы на ожидаемые уточнения: `[{"ifAsked": "последние четыре цифры", "reply": "Заканчивается на 4321."}]`. Симулятор отвечает дословно; на вопрос, которого нет ни в `knows`, ни в `facts`, ни в `answers`, он говорит, что не знает. Для сгенерированных карточек каждое значение в `reply` обязано встречаться в `knows`, `facts` или `opening`; иначе генератор переписывает карточку.
- `initialState.external` — произвольный JSON для тестового контура агента: карты, договоры, фикстуры инструментов, до 20 000 символов. Симулятор его не видит. Адаптер получает его в `initialState` каждого запроса (`createSession` у модуля), применяет и подтверждает `resetConfirmed: true` в первой реплике. Без подтверждения проверки состояния невалидны, а в причине диалога и в ограничениях прогона появляется запись «внешнее состояние карточки не подтверждено адаптером».

Кодовые проверки симулятора считаются для каждого реактивного диалога с хотя бы одной репликой после первой и хранятся в `trial.simulatorChecks`; они никогда не меняют исход диалога и не показываются судье:

| Проверка | Что считается провалом | Эвристика |
|---|---|---|
| `simulator_leak` | Пользователь назвал скалярное значение из `initialState.records` или `initialState.external`, которого нет в известных ему полях и которое агент ещё не называл | нет |
| `simulator_fabrication` | Реплика содержит токен-значение (три и более символов с цифрой: `4321`, `A103`, `14:00`, `202-7`), которого нет ни в карточке, ни в предыдущих репликах | да |
| `simulator_loop` | Реплика после нормализации совпадает с более ранней репликой того же диалога | нет |

Вердикт человека можно поставить на проверку симулятора через `checkId` с этими идентификаторами; он опровергает или подтверждает пометку, не меняя кодовый результат.

### Хук выпуска версии

У внешнего подключения может быть `release`: `{"command": "./release.sh", "args": ["candidate"], "cwd": "/abs/dir", "timeoutMs": 120000}`. Agent Lab выполняет его один раз перед первым диалогом прогона с переменными `AGENT_LAB_RUN_ID`, `AGENT_LAB_TARGET_VERSION` и, если задан `promptFile`, `AGENT_LAB_PROMPT_FILE` и `AGENT_LAB_PROMPT_HASH`. Ненулевой код завершения останавливает прогон до первого запроса; хвосты вывода сохраняются в `releaseLog`. Идентичность версии по-прежнему сообщает адаптер в `version`; хук её не подменяет. `doctor` хук не выполняет. Относительные `cwd` и путь команды в `connection.json` разрешаются относительно файла.
```

- [ ] **Step 2: `docs/WORKFLOWS.md`** — add a section `## Симулятор: что показывает прогон` before `## CI и проверка пользы режимов`:

```markdown
## Симулятор: что показывает прогон

Карточка симулятора в разделе «Статистика», в HTML и в `pilot`: сколько реактивных диалогов, сколько отмечено каждой кодовой проверкой с примерами, что сказал судья по рубрике верности, что сказал человек, в скольких диалогах уточнение агента получило ответ, сколько пользователей ушли без цели. Прогон, где симулятор отмечен более чем в четверти реактивных диалогов, получает доверие не выше среднего с названной причиной.

Ценность режимов считается по карточкам: исход в каждом режиме, карточки, которые завершил только реактивный пользователь, и карточки, которые провалил только он, с числом подтверждений человека. При одном режиме списки пусты. Это наблюдение на измеренных карточках, не доказательство пользы симулятора; бюджет по режимам показывается отдельно.

Сравнение двух прогонов дополнено парной дельтой по семействам: доля пройденных карточек семейства «после» минус «до», среднее по семействам и bootstrap-интервал при двух и более семействах. `agent-lab diff` печатает её после списков «сломалось/исправлено». Дельта описательна и не меняет вердикт по карточкам.

Для AIGW хук выпуска и промпт из MLS: `local/release.sh` в aigw-local копирует `AGENT_LAB_PROMPT_FILE` в каталог MLS-кэша и перезапускает сервис; адаптер возвращает `promptHash` файла, который сервис действительно загрузил. Цикл: `prompt-propose` → `prompt-apply` → `run` с `release` в подключении → `diff`.
```

- [ ] **Step 3: `docs/EVALS-METHOD.md`** — append a section `## Заветы Anthropic в этой версии` containing the table from spec section 2 verbatim (principle → implementation), introduced by one sentence: «Таблица связывает рекомендации Anthropic по эвалам агентов и статистике с конкретными механизмами; ссылки в README предназначены для человека и не используются во время выполнения.»

- [ ] **Step 4: `CONTEXT.md`** — add glossary entries after **User mode**:

```markdown
**User state**: The structured part of a card's user: `knows` (facts the user can state), `cannotKnow` (what the user cannot know) and `answers` (complete replies to expected clarifications). Complements `facts` and `behavior`.

**External state**: `initialState.external`, opaque JSON for the agent's own test environment. The simulator never sees it; the adapter must apply it and confirm the reset.

**Hidden literal**: A scalar value of the initial world the card did not disclose to the user. A simulated user who says it before the agent did has leaked it.

**Simulator check**: A code predicate over the simulated user's own replies: leak, fabrication (heuristic) or loop. Stored per trial, never an agent grade, never shown to the judge.

**Simulator scorecard**: Per run: reactive dialogues, checks flagged with examples, judge fidelity results, human verdicts on the simulator, clarifications answered, disengagements.

**Clarification**: A reactive dialogue whose first agent reply asked a question; answered when the simulator sent a follow-up.

**Mode value**: Per card, the outcome under each user mode; the cards only the reactive user completed or only it failed, with human confirmations.

**Paired family delta**: For two comparable runs, the share of passing cards per family after minus before, averaged over families with a bootstrap interval. Descriptive; the card lists decide the verdict.

**Release hook**: A command in the connection that Agent Lab runs before the first dialogue to deploy the version under test. The adapter's `version` remains the identity.

**Prompt quote**: A verbatim fragment of the agent's prompt that a failure cluster names as governing the broken behaviour.
```

- [ ] **Step 5: `README.md`** — after the paragraph that starts «Подтверждение запуска разрешает выполнение…» add:

```markdown
Симулированный пользователь проверяется кодом на каждом реактивном диалоге: утечка скрытого значения, выдуманное значение (эвристика, помечается как подозрение) и повтор реплики. Итог показывает, в скольких диалогах симулятор нарушил карточку, и не считает их оценки агента надёжными. Карточка задаёт пользователя точнее: что он знает, чего знать не может и что ответит на уточнение; внешнее состояние тестового контура передаётся адаптеру и должно быть подтверждено.
```

- [ ] **Step 6: `skills/agent-builder/SKILL.md`** — in «Working protocol» step 2 after the sentence «A card contains goal, known facts, behavior, opening, follow-up limit, assumptions, applicable initial state/checks and explicit metric rubrics;» insert: `Fill user.knows with the exact values the user can state, user.cannotKnow with what it cannot know, and user.answers with complete replies to the clarifications the agent will plausibly ask; every value in a reply must already be in knows, facts or opening. Put the test-environment data the agent must see into initialState.external only when the materials describe it; the adapter must confirm it with resetConfirmed.` In step 4 after «Bring user modes, calibration and fidelity only when they explain the finding or the user asks.» insert: `Read the simulator scorecard before trusting a reactive result: a dialogue flagged by simulator_leak, simulator_fabrication (a heuristic, refutable by a human verdict on that check) or simulator_loop has unreliable agent grades; say so and open it. Mode value lists the cards only the reactive user completed or only it failed; report them as observations with the human confirmation count.` In «External prompt-only improvement» add: `A failure cluster may cite promptQuotes, verbatim fragments of the prompt that governed the broken behaviour; cite them in the hypothesis of agent_lab_prompt propose instead of paraphrasing. A connection may carry a release hook that deploys the candidate before the run; the adapter's version and promptHash still attest what actually ran.`

- [ ] **Step 7: `examples/echo-agent.py`** — extend the docstring with: `initialState may carry "external": opaque data for your test environment (cards, contracts, tool fixtures). Apply it before the first reply and keep resetConfirmed=True only if you did; Agent Lab treats an unconfirmed external state as unmeasured.`

- [ ] **Step 8: Verify and commit**

Run: `npm test && npm run typecheck && npm pack --dry-run`
Expected: PASS; the pack list still contains `docs/`, `skills/`, `examples/`.

```bash
git add docs/REFERENCE.md docs/WORKFLOWS.md docs/EVALS-METHOD.md CONTEXT.md README.md skills/agent-builder/SKILL.md examples/echo-agent.py
git commit -m "docs: user state, simulator checks, mode value, family delta and release hook

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: aigw-local — per-request SBE overrides, adapter metadata, release script

**Files (repo `~/Desktop/aigw-local`, its own git):**
- Modify: `local/mocks/server.py` (SBE section ~789-831; add override store and endpoints), `local/agent_lab_target.py` (`ask`, `run_protocol`), `local/test_agent_lab_target.py`, `LOCAL.md`
- Create: `local/release.sh`

**Interfaces:**
- Mock: `POST /mock/overrides` body `{"trace_id": "<uuid>", "sbe": {"tools": {"<tool>": {"responseType": "JSON", "text": {...}}}}}` → `{"stored": n}`; `GET /mock/overrides` → `{"count": n}`; `DELETE /mock/overrides` → `{"cleared": n}`; `sbe_execute` prefers an override for the request's `x-trace-id`; journal entries gain `"override": true|false`. At most 1000 entries, oldest evicted.
- Adapter reply gains `resetConfirmed` (first turn), `eventsComplete: true`, `eventScope: ["idp_search", "sbe_*", "agent_outcome"]`, `sessionId`, `turn`, `version`, and `promptHash` when the service loaded `agent_doc_type_prompt.json` from its MLS cache. On override registration failure it returns `measurementError`.
- `local/release.sh <prompt-file>` copies the file into `local/mls_prompts/<repo>/<project>/<model>/<version>/agent_doc_type_prompt.json`, restarts the service with `MLS_CLIENT_ENABLED=True`, waits for `GET /health`; exit 0 only when healthy.

- [ ] **Step 1: Write the failing tests** — append to `local/test_agent_lab_target.py`:

```python
    def test_sbe_override_applies_only_to_its_trace(self):
        self.api.delete("/mock/overrides")
        stored = self.api.post("/mock/overrides", json={"trace_id": "trace-A", "sbe": {"tools": {"cardsByEpk": {"responseType": "JSON", "text": {"cards": [{"id": "c1", "status": "blocked"}]}}}}})
        self.assertEqual(stored.status_code, 200)
        overridden = self.api.post(server.SBE_ENDPOINT, headers={"x-trace-id": "trace-A"}, json={"name": "cardsByEpk", "arguments": {}}).json()
        self.assertIn("blocked", overridden["text"])
        plain = self.api.post(server.SBE_ENDPOINT, headers={"x-trace-id": "trace-B"}, json={"name": "cardsByEpk", "arguments": {}}).json()
        self.assertNotIn("blocked", plain["text"])
        calls = self.api.get("/mock/calls", params={"limit": 2}).json()["calls"]
        self.assertEqual([c.get("override") for c in calls], [True, False])

    def test_adapter_registers_external_state_and_reports_observation_metadata(self):
        self.api.delete("/mock/overrides")
        registered = []

        def transport(request):
            if str(request.url).startswith(adapter.MOCK_URL):
                if request.url.path == "/mock/overrides" and request.method == "POST":
                    registered.append(json.loads(request.content))
                return self.api.request(request.method, str(request.url), content=request.content, headers=request.headers)
            return httpx.Response(200, json={"message": {"content": {"result": "reply", "status_code": "200"}}})

        with httpx.Client(transport=httpx.MockTransport(transport)) as client:
            first = adapter.respond(client, {"sessionId": "s1", "message": "hi", "initialState": {"records": {}, "external": {"sbe": {"tools": {"cardsByEpk": {"text": {"cards": []}}}}}}, "messages": []}, turn=1)
            second = adapter.respond(client, {"sessionId": "s1", "message": "more", "initialState": {"records": {}}, "messages": []}, turn=2)
        self.assertEqual(registered[0]["sbe"]["tools"]["cardsByEpk"]["text"], {"cards": []})
        self.assertEqual(first["resetConfirmed"], True)
        self.assertNotIn("resetConfirmed", second)
        self.assertEqual(first["eventsComplete"], True)
        self.assertEqual(first["eventScope"], ["idp_search", "sbe_*", "agent_outcome"])
        self.assertEqual([first["sessionId"], first["turn"], second["turn"]], ["s1", 1, 2])
        self.assertTrue(first["version"])
        self.assertEqual(first["version"], second["version"])
```

(add `import json` at the top; `adapter.respond(client, request, turn)` is the new pure function extracted from `run_protocol`, see Step 3.)

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/Desktop/aigw-local && PYTHONPATH=local/stubs:src .venv/bin/python -m unittest local.test_agent_lab_target -q`
Expected: FAIL — 404 on `/mock/overrides`, `adapter.respond` missing.

- [ ] **Step 3: Implement**

`local/mocks/server.py` — before `@app.post(SBE_ENDPOINT)`:

```python
OVERRIDES: "collections.OrderedDict[str, dict]" = collections.OrderedDict()
MAX_OVERRIDES = 1000


@app.post("/mock/overrides")
async def set_override(request: Request) -> dict:
    body = await request.json()
    trace_id = body.get("trace_id")
    sbe = body.get("sbe") or {}
    if not isinstance(trace_id, str) or not trace_id or not isinstance(sbe.get("tools"), dict):
        return JSONResponse({"error": "trace_id and sbe.tools are required"}, status_code=422)
    OVERRIDES[trace_id] = {"tools": sbe["tools"]}
    while len(OVERRIDES) > MAX_OVERRIDES:
        OVERRIDES.popitem(last=False)
    return {"stored": len(OVERRIDES)}


@app.get("/mock/overrides")
async def list_overrides() -> dict:
    return {"count": len(OVERRIDES)}


@app.delete("/mock/overrides")
async def clear_overrides() -> dict:
    count = len(OVERRIDES)
    OVERRIDES.clear()
    return {"cleared": count}
```

(add `import collections` to the imports) and in `sbe_execute` replace the world lookup with:

```python
    trace_id = request.headers.get("x-trace-id")
    override = OVERRIDES.get(trace_id or "")
    tools = (override or _load("sbe.json")).get("tools", {})
    entry = tools.get(tool_name)

    _log("sbe", {"trace_id": trace_id, "tool": tool_name, "arguments": arguments, "known": entry is not None, "override": override is not None and tool_name in tools})
```

`local/agent_lab_target.py` — add after `_headers()`:

```python
def _version(client: httpx.Client) -> str:
    """Short git HEAD of this checkout plus the GigaChat stub mode, so a run can tell releases apart."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        head = subprocess.run(["git", "rev-parse", "--short=12", "HEAD"], cwd=root, capture_output=True, text=True, timeout=5, check=True).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        head = "unknown"
    try:
        mode = client.get(f"{MOCK_URL}/mock/health", timeout=5).json().get("gigachat_mode", "unknown")
    except (httpx.HTTPError, ValueError):
        mode = "unknown"
    return f"aigw-local@{head}+gigachat:{mode}"


def _prompt_hash() -> Optional[str]:
    """sha256(JSON string) of the prompt file the service actually loaded from its MLS cache; None when MLS is off."""
    if os.environ.get("MLS_CLIENT_ENABLED", "False").lower() != "true":
        return None
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(root, "src", "aigw_service", "ml_storage", os.environ.get("MLS_CLIENT_PROJECT", "").strip('"'),
                        os.environ.get("MLS_CLIENT_MODEL", "").strip('"'), os.environ.get("MLS_CLIENT_PROMPTS_VERSION", "").strip('"'), "agent_doc_type_prompt.json")
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        return None
    return hashlib.sha256(json.dumps(text, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def _register_external(client: httpx.Client, trace_id: str, external: dict) -> None:
    sbe = external.get("sbe") if isinstance(external, dict) else None
    if not sbe:
        return
    response = client.post(f"{MOCK_URL}/mock/overrides", json={"trace_id": trace_id, "sbe": sbe}, timeout=5)
    response.raise_for_status()
```

Change `ask` to accept `external: Optional[dict] = None`, generate `headers = _headers()` first, call `_register_external(client, headers["x-trace-id"], external or {})` before the POST, and keep the rest. Extract the body of the `for line in sys.stdin` loop into:

```python
def respond(client: httpx.Client, request: dict, turn: int, seen: Optional[dict] = None) -> dict:
    seen = {} if seen is None else seen
    session_id = request.get("sessionId") or str(uuid.uuid4())
    initial = request.get("initialState") or {}
    try:
        answer = ask(client, session_id, request.get("message", ""), external=initial.get("external"))
    except httpx.HTTPStatusError as error:
        if error.request.url.path == "/mock/overrides":
            return {"reply": "", "events": [], "measurementError": f"Не удалось применить внешнее состояние в заглушке SBE: {error.response.status_code}"}
        raise
    reply = {"reply": answer["reply"], "events": answer["events"], "eventsComplete": True, "eventScope": ["idp_search", "sbe_*", "agent_outcome"],
             "sessionId": session_id, "turn": turn, "version": _version_cached(client)}
    if turn == 1:
        reply["resetConfirmed"] = True  # a fresh conversation_id and the SBE override registered for this trace
    prompt_hash = _prompt_hash()
    if prompt_hash:
        reply["promptHash"] = prompt_hash
    records = initial.get("records")
    if records:
        observed = _observed(answer["outcome"], answer["events"], seen)
        records = json.loads(json.dumps(records))
        for record in records.values():
            for field, value in observed.items():
                if field in record:
                    record[field] = value
        reply["records"] = records
    return reply
```

with `_version_cached` memoising `_version(client)` in a module-level variable, and `run_protocol` reduced to the stdin loop that counts `turn` and calls `respond`. Add `import hashlib, subprocess` to the imports.

`local/release.sh`:

```bash
#!/usr/bin/env bash
# Agent Lab release hook: deploy a candidate prompt into the MLS cache and restart the service.
# Usage: AGENT_LAB_PROMPT_FILE=/abs/candidate.json local/release.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
: "${AGENT_LAB_PROMPT_FILE:?AGENT_LAB_PROMPT_FILE is required}"
set -a; . ./local/env.local; set +a
TARGET="local/mls_prompts/${MLS_CLIENT_REPOSITORY//\"/}/${MLS_CLIENT_PROJECT//\"/}/${MLS_CLIENT_MODEL//\"/}/${MLS_CLIENT_PROMPTS_VERSION//\"/}"
mkdir -p "$TARGET"
cp "$AGENT_LAB_PROMPT_FILE" "$TARGET/agent_doc_type_prompt.json"
rm -rf "src/aigw_service/ml_storage/${MLS_CLIENT_PROJECT//\"/}"
pkill -f "python -m aigw_service" || true
sleep 1
MLS_CLIENT_ENABLED=True MLS_LOCAL_PROMPTS_DIR="$ROOT/local/mls_prompts" nohup ./local/run-app.sh > local/logs/app.log 2>&1 &
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then echo "deployed $(sha256sum "$TARGET/agent_doc_type_prompt.json" | cut -c1-12)"; exit 0; fi
  sleep 1
done
echo "service did not become healthy" >&2
exit 1
```

(`chmod +x local/release.sh`.) The service must also run with `MLS_CLIENT_ENABLED=True` so the adapter's `_prompt_hash()` sees it: `run-app.sh` inherits the environment, and `.env` values do not override exported variables in pydantic-settings.

`LOCAL.md` — add a subsection «Внешнее состояние и хук выпуска» describing the three endpoints, the adapter fields, the `release.sh` contract and the Agent Lab connection JSON with `release`.

- [ ] **Step 4: Run the tests**

Run: `cd ~/Desktop/aigw-local && PYTHONPATH=local/stubs:src .venv/bin/python -m unittest local.test_agent_lab_target -q`
Expected: PASS (existing 2 + new 2).

- [ ] **Step 5: Commit in aigw-local**

```bash
cd ~/Desktop/aigw-local && git add local/mocks/server.py local/agent_lab_target.py local/test_agent_lab_target.py local/release.sh LOCAL.md && git commit -m "feat(local): per-request SBE overrides, adapter observation metadata and release hook"
```

---

### Task 11: Live check on AIGW (bounded)

**Files:**
- Create (outside the repo, gitignored): `~/Desktop/aigw-local/local/evidence/2026-09-14-simulator-v1/` with `task.json`, `connection.json`, exported reports
- Modify: `docs/IMPLEMENTATION.md` (append a dated section with what was actually measured)

- [ ] **Step 1: Start the pilot agent**

```bash
cd ~/Desktop/aigw-local && ./local/pg.sh start && (./local/run-mocks.sh > local/logs/mocks.log 2>&1 &) && sleep 2 && (./local/run-app.sh > local/logs/app.log 2>&1 &) && sleep 8 && curl -fsS http://127.0.0.1:8080/health && curl -fsS http://127.0.0.1:8090/mock/health
```

If `/mock/health` reports GigaChat mode `canned`, stop: canned answers do not measure the agent (record this in IMPLEMENTATION.md and skip Steps 3-5).

- [ ] **Step 2: Write three golden cards** into `task.json` (materials: the IDP fixture articles the pilot used, from `local/mocks/fixtures/idp.json`, as `materials`), `scenarioCount: 0`, `settings: { userModes: ['static', 'scripted', 'reactive'], repeats: 1, maxCalls: 60, maxDurationMs: 1500000, judge: DEFAULT_JUDGE }`, `target` from `connection.json` (`command` → `.venv/bin/python local/agent_lab_target.py`, `timeoutMs: 180000`). Cards: terminal unblock (knows: TID `12345678`; answers: the TID when asked; cannotKnow: why the terminal is blocked in SBE), refund after close (knows: contract creation date and RRN; answers: payment method «картой»; external.sbe with the pilot's `organizationInfoByEpkId` fixture entry copied from `sbe.json` so the override path is exercised), tariff location (knows: nothing beyond the question; maxFollowUps 1). Each with an agent `goal_attainment` rubric copied from `goalToScenario` wording and `tier: regression`.

- [ ] **Step 3: Run**

```bash
node dist/cli.js build --input task.json --connection connection.json --data-dir ~/Desktop/aigw-local/local/evidence/2026-09-14-simulator-v1/.agent-lab
node dist/cli.js run --id <ID> --yes --data-dir <same>
node dist/cli.js pilot --id <ID> --data-dir <same>
node dist/cli.js export --id <ID> --format html --output <dir>/report.html --data-dir <same>
```

- [ ] **Step 4: Record what was measured** in `docs/IMPLEMENTATION.md` under a new heading `## Симулятор v1 · живая проверка 2026-09-14`: the run id, dialogues completed per mode, the simulator scorecard numbers, the mode-value lists, lab cost, whether `resetConfirmed`/`eventsComplete`/`version` arrived from the adapter, and the explicit statement that no human verdicts exist yet and that all three cards are hand-written from the 12 September pilot, not production data. If any step failed, say which and why.

- [ ] **Step 5: Commit**

```bash
git add docs/IMPLEMENTATION.md
git commit -m "docs: simulator v1 live check on the AIGW pilot agent

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec §5 (card fields, simulator input, generator rules, editor) → Tasks 1, 4, 5, 8. Spec §6 (checks, algorithms, verdict effect, human review) → Tasks 2, 3, 6, 7. Spec §7 (scorecard, mode value, delta, surfaces) → Tasks 6, 8. Spec §8 (external world contract, aigw-local) → Tasks 1, 3, 7, 9, 10. Spec §9 (release hook, clustering, prompt quotes) → Tasks 1, 4, 7, 9, 10. Spec §10-12 → Tasks 8, 9, 11. Spec §13 non-goals: nothing here generates a budget-matched basket or applies a prompt automatically; the release hook runs only inside a human-approved run.
- Names used consistently across tasks: `simulatorChecks`, `simulatorSummary`, `modeValue`, `runRelease`, `ReleaseHook`, `ReleaseLog`, `valueTokens`, `hiddenLiterals`, check ids `simulator_leak`/`simulator_fabrication`/`simulator_loop`, limitation text `Внешнее состояние карточек не подтверждено адаптером (resetConfirmed): проверки состояния не измерены.`, block titles listed in Task 8.
- Known judgement calls: `userSchema` new fields are optional (not defaulted) so existing typed fixtures compile; `outcomes.ts` extraction is the cost of keeping `simulator.ts` cycle-free; the fabrication heuristic is labelled and refutable rather than tuned.

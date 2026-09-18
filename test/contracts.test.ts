import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  createInputSchema, dialogueSchema, dialogueToScenario, dialogueToTrial, discoverInputSchema, draftPatchSchema, emptyUsage, fingerprint, goalAttainment, humanReviewInputSchema, MACHINE_FORMAT, validateFailureModes, experimentSchema, goalToScenario, goldenCaseSchema, goldenToScenario, observedGoalSchema, profileSchema, replyQuality, scenarioSchema, settingsSchema, SIMULATOR_CHECK_IDS, targetSchema, trialSchema, validateObservedGoals, validatePreparation, valueTokens, verbatimSpan, worldSchema,
  type Profile,
} from '../src/contracts.js';
import { selectValidationDialogues } from '../src/imports.js';

const source = { id: 'source-1', name: 'policy', content: 'Rule one: read before update.', hash: 'h' };
const requirement = { id: 'req_1', text: 'Read before update', sourceId: 'source-1', quote: 'read before update', critical: true };
const agent = { name: 'A', instructions: 'Do the thing.', tools: ['lookup_record' as const] };
const metric = { id: 'm', name: 'M', subject: 'agent' as const, description: 'd', passCriteria: 'p', failCriteria: 'f' };
const user = { goal: 'g', facts: 'f', behavior: 'b', opening: 'o', maxFollowUps: 0, persona: 'P', characteristics: ['c'] };

test('discovery accepts 1..300 dialogues without weakening the ordinary 200-dialogue input', () => {
  const base = { task: 'Find a test', materials: [{ name: 'policy', content: 'Rule.' }], mode: 'live' as const };
  const dialogues = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `d${index}`, messages: [{ role: 'user' as const, content: 'Question' }] }));
  assert.equal(discoverInputSchema.safeParse({ ...base, dialogues: [] }).success, false);
  assert.equal(discoverInputSchema.safeParse({ ...base, dialogues: dialogues(1) }).success, true);
  assert.equal(discoverInputSchema.safeParse({ ...base, dialogues: dialogues(300) }).success, true);
  assert.equal(discoverInputSchema.safeParse({ ...base, dialogues: dialogues(301) }).success, false);
  assert.equal(createInputSchema.safeParse({ ...base, dialogues: dialogues(201), scenarioCount: 0 }).success, false);
});

test('validation sampling is stable, outcome-blind and keeps only replayable dialogues', () => {
  const dialogues = Array.from({ length: 30 }, (_, index) => dialogueSchema.parse({ id: `sample_${index}`, outcome: index % 2 ? 'success' : 'failure',
    messages: [{ role: 'user', content: `Вопрос ${index}` }, { role: 'assistant', content: `Ответ ${index}` }] }));
  const first = selectValidationDialogues(dialogues).map(dialogue => dialogue.id);
  const relabelled = selectValidationDialogues(dialogues.map(dialogue => ({ ...dialogue, outcome: dialogue.outcome === 'success' ? 'failure' as const : 'success' as const }))).map(dialogue => dialogue.id);
  assert.equal(first.length, 15);
  assert.deepEqual(relabelled, first);
  assert.deepEqual(selectValidationDialogues([...dialogues].reverse()).map(dialogue => dialogue.id), first);
  const tooLong = dialogueSchema.parse({ id: 'too_long', messages: Array.from({ length: 17 }, (_, index) => ({ role: 'user' as const, content: `m${index}` })) });
  assert.deepEqual(selectValidationDialogues([tooLong]), []);
  const base = { task: 'validate', materials: [{ name: 'policy', content: 'Rule.' }], mode: 'live' as const, dialogues: dialogues.slice(0, 15), scenarioCount: 0 };
  assert.equal(createInputSchema.safeParse({ ...base, validationCount: 15, settings: { userModes: ['scripted'] } }).success, true);
  assert.equal(createInputSchema.safeParse({ ...base, validationCount: 15, settings: { userModes: ['reactive'] } }).success, true);
  const masked = (content: string) => dialogueSchema.parse({ id: 'masked', messages: [{ role: 'user', content }] });
  assert.deepEqual(selectValidationDialogues([masked('*** # # ...')]), []);
  assert.equal(selectValidationDialogues([masked('Терминал **** не работает')]).length, 1);
});
function card(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1', familyId: 'f1', title: 'Card', requirementIds: ['req_1'], provenance: 'synthetic' as const, successCriteria: 'ok',
    user, initialState: { records: {}, writableFields: [], transientFailures: 0 }, checks: [], metrics: [metric], ...overrides,
  };
}
const preparation = (scenarios: unknown[]) => ({ requirements: [requirement], questions: [], agent, scenarios });

test('target schema accepts sandbox, absolute module paths and env-var header names only', () => {
  assert.ok(targetSchema.safeParse({ kind: 'sandbox' }).success);
  assert.equal(targetSchema.safeParse({ kind: 'module', path: 'relative/agent.mjs' }).success, false);
  assert.ok(targetSchema.safeParse({ kind: 'module', path: '/abs/agent.mjs' }).success);
  assert.equal(targetSchema.safeParse({ kind: 'http', url: 'http://127.0.0.1:1/agent', headersEnv: { Authorization: 'not a var' } }).success, false);
  const http = targetSchema.parse({ kind: 'http', url: 'http://127.0.0.1:1/agent', headersEnv: { Authorization: 'AGENT_TOKEN' } });
  assert.equal(http.kind === 'http' ? http.timeoutMs : 0, 60000);
  assert.equal(targetSchema.safeParse({ kind: 'http', url: 'http://127.0.0.1:1/agent', headers: { Authorization: 'secret' } }).success, false);
});

test('golden cases become curated scenarios that keep their checks, metrics and script', () => {
  const golden = goldenCaseSchema.parse({
    id: 'gold_1', goal: 'Block a lost card', opening: 'I lost my card', successCriteria: 'The card is blocked',
    script: ['The last four digits are 1234.'],
    initialState: { records: { card_1: { status: 'active' } }, writableFields: ['status'], transientFailures: 0 },
    checks: [{ id: 'blocked', kind: 'state_equals', description: 'Card blocked', recordId: 'card_1', field: 'status', value: 'blocked' }],
  });
  const scenario = goldenToScenario(golden);
  assert.equal(scenario.provenance, 'curated');
  assert.equal(scenario.id, 'gold_1');
  assert.equal(scenario.title, 'Block a lost card');
  assert.deepEqual(scenario.requirementIds, []);
  assert.equal(scenario.checks.length, 1);
  assert.deepEqual(scenario.user.script, ['The last four digits are 1234.']);
  assert.equal(scenario.user.maxFollowUps, 1);
  assert.equal(scenario.successCriteria, 'The card is blocked');
  assert.equal(golden.behavior.length > 0, true);
});

test('old experiment files load with defaults for workflow, human reviews, target, imports and trial user mode', () => {
  const settings = settingsSchema.parse({});
  const legacy = {
    schemaVersion: '1', id: 'legacy', task: 'task', mode: 'demo', createdAt: 'now', updatedAt: 'now', phase: 'complete', message: 'm',
    sources: [], settings: { ...settings, userModes: undefined }, requirements: [], questions: [], scenarios: [], revisions: [], selectedRevisionId: null,
    manifestHash: null, reviewedAt: null, controlConsumedAt: null, comparisons: [], iterations: [], usage: emptyUsage(), error: null, limitations: [],
    trials: [{ id: 't1', revisionId: 'r', scenarioId: 's', familyId: 'f', repeat: 0, split: 'dev', manifestHash: 'h', outcome: 'pass', reason: '', checks: [], events: [],
      initialState: { records: {}, writableFields: [], transientFailures: 0 }, finalState: { records: {}, writableFields: [], transientFailures: 0 }, usage: emptyUsage(), elapsedMs: 1 }],
  };
  delete (legacy.settings as { userModes?: unknown }).userModes;
  const parsed = experimentSchema.parse(legacy);
  assert.equal(parsed.workflow, 'compare');
  assert.deepEqual(parsed.humanReviews, []);
  assert.deepEqual(parsed.target, { kind: 'sandbox' });
  assert.deepEqual([parsed.goldenCases, parsed.dialogues, parsed.profiles], [[], [], []]);
  assert.deepEqual(parsed.settings.userModes, ['reactive']);
  assert.equal(parsed.trials[0]!.userMode, 'reactive');
  assert.equal(parsed.acceptedDraftHash, undefined);
  assert.deepEqual(parsed.acceptedTests, []);
  assert.equal(experimentSchema.parse({ ...legacy, acceptedDraftHash: fingerprint('draft') }).acceptedDraftHash, fingerprint('draft'));
  assert.equal(experimentSchema.safeParse({ ...legacy, acceptedDraftHash: 'not-a-draft-hash' }).success, false);
  const accepted = { testId: 'test_1', scenarioId: 'scenario_1', definitionHash: fingerprint('scenario'), acceptedAt: '2026-09-16T10:00:00.000Z' };
  assert.deepEqual(experimentSchema.parse({ ...legacy, acceptedTests: [accepted] }).acceptedTests, [accepted]);
  assert.equal(experimentSchema.safeParse({ ...legacy, acceptedTests: [{ ...accepted, definitionHash: 'not-a-hash' }] }).success, false);
  assert.equal(experimentSchema.safeParse({ ...legacy, acceptedTests: [accepted, { ...accepted, scenarioId: 'scenario_2' }] }).success, false);
});

test('only a whole-dialogue verdict can mark an explicit complete review', () => {
  const legacy = { trialId: 't1', verdict: 'unknown' as const, note: '#1: legacy review' };
  const complete = { ...legacy, reviewedDialogue: true as const };
  assert.ok(humanReviewInputSchema.safeParse(legacy).success);
  assert.ok(humanReviewInputSchema.safeParse(complete).success);
  assert.equal(humanReviewInputSchema.safeParse({ ...complete, metricId: 'goal' }).success, false);
  assert.equal(humanReviewInputSchema.safeParse({ ...complete, checkId: 'state' }).success, false);

  const trial = { id: 't1', revisionId: 'r', scenarioId: 's', familyId: 'f', repeat: 0, split: 'dev', manifestHash: 'h', outcome: 'pass', reason: '', checks: [], events: [{ seq: 1, type: 'assistant', text: 'ok' }],
    initialState: { records: {}, writableFields: [], transientFailures: 0 }, finalState: { records: {}, writableFields: [], transientFailures: 0 }, usage: emptyUsage(), elapsedMs: 1 };
  const persisted = { ...complete, id: 'h1', createdAt: '2026-09-15T10:00:00Z' };
  const record = { ...legacyRecord(), trials: [trial] };
  assert.ok(experimentSchema.safeParse({ ...record, humanReviews: [persisted] }).success);
  assert.equal(experimentSchema.safeParse({ ...record, humanReviews: [{ ...persisted, note: 'без ссылки' }] }).success, false);
  assert.equal(experimentSchema.safeParse({ ...record, humanReviews: [{ ...persisted, note: '#999: чужое событие' }] }).success, false);
  assert.equal(experimentSchema.safeParse({ ...record, humanReviews: [{ ...persisted, trialId: 'missing' }] }).success, false);
  assert.equal(experimentSchema.safeParse({ ...record, humanReviews: [{ ...persisted, metricId: 'goal' }] }).success, false);
  assert.equal(experimentSchema.safeParse({ ...record, humanReviews: [{ ...persisted, checkId: 'state' }] }).success, false);

  const sourceEvidence = { runId: 'source', trials: [trial], humanReviews: [persisted] };
  assert.ok(experimentSchema.safeParse({ ...record, sourceEvidence }).success);
  assert.equal(experimentSchema.safeParse({ ...record, sourceEvidence: { ...sourceEvidence, humanReviews: [{ ...persisted, note: 'без ссылки' }] } }).success, false);
  assert.equal(experimentSchema.safeParse({ ...record, sourceEvidence: { ...sourceEvidence, humanReviews: [{ ...persisted, note: '#999: чужое событие' }] } }).success, false);
  assert.equal(experimentSchema.safeParse({ ...record, sourceEvidence: { ...sourceEvidence, humanReviews: [{ ...persisted, trialId: 'missing' }] } }).success, false);
  const attempts = Array.from({ length: 600 }, (_, index) => ({ ...trial, id: `source-${index}`, repeat: index % 5 }));
  assert.ok(experimentSchema.safeParse({ ...record, sourceEvidence: { runId: 'source', trials: attempts, humanReviews: [] } }).success);
  assert.equal(experimentSchema.safeParse({ ...record, sourceEvidence: { runId: 'source', trials: [...attempts, { ...trial, id: 'source-600' }], humanReviews: [] } }).success, false);
});

test('input and persisted human review schemas both reject two targets', () => {
  const review = { trialId: 't1', metricId: 'goal', checkId: 'state', verdict: 'fail' as const, note: 'ambiguous target' };
  assert.equal(humanReviewInputSchema.safeParse(review).success, false);
  assert.equal(experimentSchema.safeParse({ ...legacyRecord(), humanReviews: [{ ...review, id: 'h1', createdAt: '2026-09-15T10:00:00Z' }] }).success, false);
});

test('synthetic cards need grounded requirements; curated and production cards do not', () => {
  assert.throws(() => validatePreparation(preparation([card({ requirementIds: [] })]), [source], 'evaluate'), /requirement/i);
  const curated = validatePreparation(preparation([card({ requirementIds: [], provenance: 'curated', user: { ...user, persona: undefined, characteristics: undefined } })]), [source], 'evaluate');
  assert.equal(curated.scenarios[0]!.provenance, 'curated');
  const production = validatePreparation(preparation([card({ requirementIds: [], provenance: 'production' })]), [source], 'evaluate');
  assert.equal(production.scenarios[0]!.provenance, 'production');
});

test('linked profiles supply persona text while unlinked cards need no persona', () => {
  const profiles: Profile[] = [{ id: 'observed_1', persona: 'Observed customer', characteristics: ['Short messages'], observedStyle: '12 chars avg', evidenceDialogueIds: ['d1'] }];
  const plain = validatePreparation(preparation([card({ user: { ...user, persona: undefined, characteristics: undefined } })]), [source], 'evaluate', profiles);
  assert.equal(plain.scenarios[0]!.user.persona, undefined);
  assert.throws(() => validatePreparation(preparation([card({ profileId: 'missing' })]), [source], 'evaluate', profiles), /profileId/);
  const prepared = validatePreparation(preparation([card({ profileId: 'observed_1', user: { ...user, persona: 'Invented dramatic persona', characteristics: ['Shouts'] } })]), [source], 'evaluate', profiles);
  assert.equal(prepared.scenarios[0]!.user.persona, 'Observed customer');
  assert.deepEqual(prepared.scenarios[0]!.user.characteristics, ['Short messages']);
  const curated = validatePreparation(preparation([card({ provenance: 'curated', requirementIds: [] })]), [source], 'evaluate', profiles);
  assert.equal(curated.scenarios[0]!.user.persona, 'P');
});

test('user modes default to reactive and reject duplicates; imports reject duplicate ids and oversized dialogues', () => {
  assert.deepEqual(settingsSchema.parse({}).userModes, ['reactive']);
  assert.equal(settingsSchema.safeParse({ userModes: ['static', 'static'] }).success, false);
  assert.deepEqual(settingsSchema.parse({ userModes: ['static', 'scripted', 'reactive'] }).userModes, ['static', 'scripted', 'reactive']);
  const base = { task: 'task', materials: [{ name: 'm', content: 'c' }], mode: 'demo' as const };
  const dialogue = (id: string, content = 'hello') => ({ id, messages: [{ role: 'user' as const, content }] });
  assert.equal(createInputSchema.safeParse({ ...base, dialogues: [dialogue('d1'), dialogue('d1')] }).success, false);
  assert.equal(createInputSchema.safeParse({ ...base, goldenCases: [{ id: 'g', goal: 'x', opening: 'y', successCriteria: 'z' }, { id: 'g', goal: 'x', opening: 'y', successCriteria: 'z' }] }).success, false);
  const parsed = createInputSchema.parse({ ...base, dialogues: [dialogue('d1')], goldenCases: [{ id: 'g', goal: 'x', opening: 'y', successCriteria: 'z' }] });
  assert.equal(parsed.dialogues[0]!.outcome, 'unknown');
  assert.deepEqual(parsed.target, { kind: 'sandbox' });
  const huge = Array.from({ length: 200 }, (_, i) => ({ id: `d${i}`, messages: Array.from({ length: 2 }, () => ({ role: 'user' as const, content: 'x'.repeat(8000) })) }));
  assert.equal(createInputSchema.safeParse({ ...base, dialogues: huge }).success, false);
});

test('confirmed hypotheses require an owner-selected goal observation while legacy scenarios remain readable', () => {
  const base = {
    task: 'Check the accepted hypothesis', materials: [{ name: 'Policy', content: 'Known rule.' }], mode: 'live' as const,
    workflow: 'evaluate' as const, scenarioCount: 1, confirmedHypothesis: 'The agent may omit the answer.',
  };
  assert.equal(createInputSchema.safeParse(base).success, false);
  for (const goalObservation of ['reply', 'tool', 'state'] as const) {
    assert.equal(createInputSchema.parse({ ...base, goalObservation }).goalObservation, goalObservation);
  }
  assert.ok(scenarioSchema.safeParse(card()).success, 'legacy scenarios without goalObservation stay readable');
});

test('owner-supplied profiles need no evidence, legacy observed ones do, and owner notes travel with the input', () => {
  assert.equal(profileSchema.safeParse({ id: 'p', persona: 'Busy parent', characteristics: ['Terse'] }).success, false);
  const owner = profileSchema.parse({ id: 'p', persona: 'Busy parent', characteristics: ['Terse'], source: 'owner' });
  assert.deepEqual([owner.source, owner.evidenceDialogueIds, owner.observedStyle], ['owner', [], undefined]);
  const observed = profileSchema.parse({ id: 'o', persona: 'Observed', characteristics: ['Short'], evidenceDialogueIds: ['d1'] });
  assert.equal(observed.source, 'observed');
  const base = { task: 'task', materials: [{ name: 'm', content: 'c' }], mode: 'demo' as const };
  const parsed = createInputSchema.parse({ ...base, notes: 'Users are often angry and rarely know their appointment ID.', profiles: [{ id: 'p', persona: 'Busy parent', characteristics: ['Terse'] }] });
  assert.equal(parsed.notes, 'Users are often angry and rarely know their appointment ID.');
  assert.equal(parsed.profiles[0]!.source, 'owner');
  assert.equal(createInputSchema.safeParse({ ...base, profiles: [{ id: 'p', persona: 'A', characteristics: ['x'] }, { id: 'p', persona: 'B', characteristics: ['y'] }] }).success, false);
  assert.equal(experimentSchema.parse({ ...legacyRecord(), profiles: [{ id: 'p', persona: 'Busy parent', characteristics: ['Terse'], source: 'owner' }] }).notes, '');
});

function legacyRecord() {
  return {
    schemaVersion: '1', id: 'legacy', task: 'task', mode: 'demo', createdAt: 'now', updatedAt: 'now', phase: 'complete', message: 'm',
    sources: [], settings: settingsSchema.parse({}), requirements: [], questions: [], scenarios: [], revisions: [], selectedRevisionId: null,
    manifestHash: null, reviewedAt: null, controlConsumedAt: null, comparisons: [], iterations: [], usage: emptyUsage(), error: null, limitations: [], trials: [],
  };
}

test('command targets run a local process: executable plus arguments, optional absolute cwd', () => {
  const parsed = targetSchema.parse({ kind: 'command', command: 'python3', args: ['/abs/agent.py'] });
  assert.deepEqual(parsed, { kind: 'command', command: 'python3', args: ['/abs/agent.py'], timeoutMs: 60000 });
  assert.equal(targetSchema.safeParse({ kind: 'command', command: '' }).success, false);
  assert.equal(targetSchema.safeParse({ kind: 'command', command: 'python3', cwd: 'relative/dir' }).success, false);
  assert.ok(targetSchema.safeParse({ kind: 'command', command: 'python3', cwd: '/abs/dir' }).success);
});

test('observed goals become production cards with a verbatim real opening and the matching profile', () => {
  const profile: Profile = { id: 'observed_1', persona: 'Observed customer', characteristics: ['Short messages'], observedStyle: 's', evidenceDialogueIds: ['d1'], source: 'observed' };
  const goal = observedGoalSchema.parse({ id: 'goal_move', goal: 'Move appointment A101 to 14:00', opening: 'move A101 to 14:00 pls', profileId: 'observed_1', evidenceDialogueIds: ['d1'], successCriteria: 'The appointment is moved to 14:00 or the user is told why not' });
  const scenario = goalToScenario(goal, profile);
  assert.equal(scenario.provenance, 'production');
  assert.equal(scenario.profileId, 'observed_1');
  assert.equal(scenario.user.opening, 'move A101 to 14:00 pls');
  assert.equal(scenario.user.persona, 'Observed customer');
  assert.deepEqual(scenario.user.characteristics, ['Short messages']);
  assert.equal(scenario.user.maxFollowUps, 2);
  assert.deepEqual(scenario.requirementIds, []);
  assert.ok(scenario.metrics!.some(m => m.subject === 'agent') && scenario.metrics!.some(m => m.subject === 'simulator'));
  assert.ok(scenario.assumptions!.some(a => /real dialogue/i.test(a)));
  assert.equal(goal.outcome, 'unknown');
});

test('recorded dialogues map one-to-one to grounded production cards and immutable scripted evidence', () => {
  const dialogue = {
    id: 'dialogue_1', goal: 'Получить точную инструкцию', outcome: 'failure' as const,
    messages: [
      { role: 'user' as const, content: 'Где посмотреть тариф «Бизнес»?' },
      { role: 'assistant' as const, content: 'Уточните терминал.' },
      { role: 'user' as const, content: 'Терминал 4321.' },
      { role: 'user' as const, content: 'И без звонка в поддержку.' },
      { role: 'assistant' as const, content: 'Откройте Эквайринг → Мои точки продаж.' },
    ],
  };
  const scenario = dialogueToScenario(dialogue, {
    goal: 'Найти тариф терминала', successCriteria: 'Путь к тарифу указан по материалам владельца.', requirementIds: ['tariff_rule'],
  });
  assert.equal(scenario.provenance, 'production');
  assert.equal(scenario.user.opening, dialogue.messages[0]!.content);
  assert.deepEqual(scenario.user.script, ['Терминал 4321.', 'И без звонка в поддержку.']);
  assert.equal(scenario.user.maxFollowUps, 2);
  assert.deepEqual(scenario.requirementIds, ['tariff_rule']);
  assert.equal(scenario.goalObservation, 'reply');
  assert.deepEqual(scenario.metrics, [goalAttainment, replyQuality]);

  const stateScenario = dialogueToScenario(dialogue, { goal: 'Найти тариф терминала', goalObservation: 'state' });
  assert.equal(stateScenario.goalObservation, 'state', 'an explicit owner channel is preserved');

  const trial = dialogueToTrial(dialogue, { ...scenario, split: 'dev' }, 'revision_1');
  assert.deepEqual(trial.events, dialogue.messages.map((message, seq) => ({ seq, type: message.role, text: message.content })));
  assert.equal(trial.id, dialogue.id);
  assert.equal(trial.userMode, 'scripted');
  assert.equal(trial.outcome, 'ungraded');
  assert.deepEqual(trial.observation, { state: 'missing', tools: 'partial' });
  assert.deepEqual(trial.initialState, { records: {}, writableFields: [], transientFailures: 0 });
  assert.deepEqual(trial.finalState, trial.initialState);
  assert.deepEqual(trial.usage, emptyUsage());
  assert.equal(trial.simulatorChecks, undefined);
  assert.throws(() => dialogueToScenario({ ...dialogue, messages: [{ role: 'assistant', content: 'Готово.' }] }, {
    goal: 'g', successCriteria: 'c',
  }), /нет реплики пользователя/i);

  const spaced = dialogueSchema.parse({ id: 'exact_reply', messages: [
    { role: 'user', content: '  reply exactly READY\n' }, { role: 'assistant', content: ' READY ' },
  ] });
  assert.deepEqual(dialogueToTrial(spaced, { ...scenario, id: 'exact_reply', split: 'dev' }, 'revision_1').events.map(event => event.text),
    ['  reply exactly READY\n', ' READY '], 'score preserves original message whitespace as evidence');
  assert.deepEqual(dialogueToScenario({ id: 'opening_only', messages: [{ role: 'user', content: 'Один вопрос' }] }, {
    goal: 'Получить ответ', successCriteria: 'Ответ соответствует требованиям.',
  }).user.script, [], 'opening-only production cards are runnable scripted conversations');
  assert.throws(() => dialogueSchema.parse({ id: 'blank', messages: [{ role: 'user', content: ' \n ' }] }), /Empty dialogue content/);

  const long = dialogueSchema.parse({ id: 'long', messages: Array.from({ length: 33 }, (_, index) => ({
    role: index % 2 ? 'assistant' as const : 'user' as const, content: `message ${index}`,
  })) });
  const longScenario = dialogueToScenario(long, { goal: 'Разобрать длинный диалог', successCriteria: 'Ответ соответствует требованиям.' });
  assert.doesNotThrow(() => scenarioSchema.parse(longScenario));
  assert.equal(longScenario.user.script, undefined, 'long evidence is not truncated into a runnable script');
  assert.equal(dialogueToTrial(long, { ...longScenario, split: 'dev' }, 'revision_1').events.length, 33, 'the full evidence remains one-to-one');
});

test('observed goal requirement ids are optional, unique and preserved by production cards', () => {
  const dialogue = { id: 'd_req', messages: [{ role: 'user' as const, content: 'Покажите тариф' }] };
  const goal = observedGoalSchema.parse({ id: 'g_req', goal: 'Показать тариф', opening: 'Покажите тариф', evidenceDialogueIds: ['d_req'],
    successCriteria: 'Путь указан', requirementIds: ['tariff_rule'] });
  validateObservedGoals([goal], [dialogue], []);
  assert.deepEqual(goalToScenario(goal).requirementIds, ['tariff_rule']);
  assert.equal(observedGoalSchema.safeParse({ ...goal, requirementIds: ['tariff_rule', 'tariff_rule'] }).success, false);
  assert.equal(observedGoalSchema.parse({ ...goal, requirementIds: undefined }).requirementIds, undefined);
});

test('кластер провалов обязан ссылаться на диалоги, которые действительно провалились', () => {
  const trial = (id: string, outcome: 'fail' | 'pass') => ({ id, outcome } as unknown as Parameters<typeof validateFailureModes>[1][number]);
  const trials = [trial('t1', 'fail'), trial('t2', 'fail'), trial('t3', 'pass')];
  const mode = { id: 'hotline', name: 'Нашёл статью и всё равно отправил на горячую линию', description: 'd', trialIds: ['t1', 't2'] };
  validateFailureModes([mode], trials);
  assert.throws(() => validateFailureModes([{ ...mode, trialIds: ['t1', 't9'] }], trials), /не проваливались/);
  assert.throws(() => validateFailureModes([{ ...mode, trialIds: ['t1', 't3'] }], trials), /не проваливались/);
  assert.throws(() => validateFailureModes([{ ...mode, trialIds: ['t1', 't1'] }], trials), /дважды/);
  assert.throws(() => validateFailureModes([mode, mode], trials), /повторяются/);
});

test('draft card operations name removals and reject duplicate or conflicting ids', () => {
  assert.ok(draftPatchSchema.safeParse({ scenarios: [card()] }).success);
  assert.deepEqual(draftPatchSchema.parse({ removeScenarioIds: ['c1'] }), { removeScenarioIds: ['c1'] });
  for (const patch of [
    { scenarios: [card(), card()] }, { removeScenarioIds: ['c1', 'c1'] },
    { scenarios: [card()], removeScenarioIds: ['c1'] }, { removeScenarioIds: ['../c1'] }, {},
  ]) assert.equal(draftPatchSchema.safeParse(patch).success, false);
});

test('exact final-answer checks reject impossible combinations without constraining earlier replies', () => {
  const exact = { id: 'exact', kind: 'answer_equals', description: 'Final answer', value: 'Thank you.' };
  const validate = (checks: unknown[]) => validatePreparation(preparation([card({ checks })]), [source], 'evaluate');
  assert.throws(() => validate([exact, { ...exact, id: 'different', value: 'thank you.' }]), /Contradictory exact answer/);
  const forbidden = { id: 'forbidden', kind: 'answer_omits', description: 'Forbidden wording', value: 'THANK' };
  assert.throws(() => validate([exact, forbidden]), /Exact answer contains forbidden/);
  assert.throws(() => validate([forbidden, exact]), /Exact answer contains forbidden/);
  assert.doesNotThrow(() => validate([exact, { ...exact, id: 'same' }, { id: 'earlier', kind: 'answer_contains', description: 'Earlier clarification', value: 'What is your name?' }]));
});

test('the shipped agent_oc end2end card passes preparation validation', async () => {
  // Карточку в примере правят руками, а её ошибки видны только в живом прогоне: проверка
  // state_equals требует, чтобы запись и поле уже существовали в initialState, а меняющееся
  // поле было объявлено writableFields. Без этого теста ошибка находится на рабочем стенде.
  const template = JSON.parse(await readFile(new URL('../examples/agent-oc-e2e/task.json', import.meta.url), 'utf8'));
  const input = createInputSchema.parse(template);
  const sources = input.materials.map((m, i) => ({ id: `s${i}`, name: m.name, content: m.content, hash: 'hash' }));
  validatePreparation({
    requirements: [{ id: 'r1', text: 'Агент отвечает клиенту', sourceId: sources[0]!.id, quote: sources[0]!.content.slice(0, 40), critical: false }],
    questions: [], agent: { name: 'agent_oc', instructions: 'Прод-путь ветки B', tools: [] },
    scenarios: input.goldenCases.map(goldenToScenario),
  }, sources, 'evaluate');
});

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
  assert.deepEqual([...valueTokens('E-2047 e-2047 E-20470 A103 103 СЧЁТ-77 счёт-77')].sort(), ['103', 'a103', 'e-2047', 'e-20470', 'счёт-77']);
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
  const reserved = { id: 'simulator_leak', kind: 'answer_contains', description: 'collision', value: 'ok' };
  assert.throws(() => validatePreparation(preparation([card({ checks: [reserved] })]), [source], 'evaluate'), /reserved for simulator checks/);
  assert.equal(experimentSchema.safeParse({ ...legacyRecord(), scenarios: [{ ...card({ checks: [reserved] }), split: 'dev' }] }).success, false);
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

test('an evaluation may ask for up to twenty generated cards', () => {
  const base = { task: 'Check the agent', materials: [{ name: 'policy.md', content: 'Rule one.' }], mode: 'live' as const };
  assert.equal(createInputSchema.parse({ ...base, scenarioCount: 20 }).scenarioCount, 20);
  assert.throws(() => createInputSchema.parse({ ...base, scenarioCount: 21 }), /scenarioCount/);
});

test('a quote that differs from its source only in typography is still that source, returned in the source\'s own characters', () => {
  const content = 'Раздел «Эквайринг» → «Мои точки продаж» → карточка точки → «Тариф»: показана действующая ставка и дата начала её действия.\n\nИзменить тариф можно только через заявку — оператор этого сделать не может.';
  assert.equal(verbatimSpan(content, 'карточка точки → «Тариф»'), 'карточка точки → «Тариф»');
  assert.equal(verbatimSpan(content, 'Раздел "Эквайринг" -> "Мои точки продаж"'), 'Раздел «Эквайринг» → «Мои точки продаж»');
  assert.equal(verbatimSpan(content, ' дата начала ее действия.  Изменить тариф '), 'дата начала её действия.\n\nИзменить тариф');
  assert.equal(verbatimSpan(content, 'через заявку - оператор'), 'через заявку — оператор');
  assert.equal(verbatimSpan(content, 'Раздел Эквайринг показывает тариф'), undefined);
  assert.equal(verbatimSpan(content, 'ОПЕРАТОР этого сделать не может'), undefined);
  // A quote that starts mid-sentence is capitalised by the model; only its first letter may differ in case.
  assert.equal(verbatimSpan(content, 'Оператор этого сделать не может'), 'оператор этого сделать не может');
  assert.equal(verbatimSpan(content, 'оператор Этого сделать не может'), undefined);
});

test('a quote that skips the list markers of its source is still that source', () => {
  const content = 'Для заявок на установку терминала сообщай:\n- номер заявки, статус заявки, срок исполнения заявки\n- дату визита\n\nШаги:\n1. Открой раздел.\n2. Нажми «Тариф».';
  assert.equal(verbatimSpan(content, 'сообщай: номер заявки, статус заявки'), 'сообщай:\n- номер заявки, статус заявки');
  assert.equal(verbatimSpan(content, 'срок исполнения заявки дату визита'), 'срок исполнения заявки\n- дату визита');
  assert.equal(verbatimSpan(content, 'Шаги: Открой раздел. Нажми "Тариф".'), 'Шаги:\n1. Открой раздел.\n2. Нажми «Тариф».');
  assert.equal(verbatimSpan(content, 'сообщай: - номер заявки, статус заявки, срок исполнения заявки - дату визита'), 'сообщай:\n- номер заявки, статус заявки, срок исполнения заявки\n- дату визита');
  assert.equal(verbatimSpan(content, 'номер заявки - статус заявки'), undefined);
});

test('a run may be given hours, and a single model call minutes: thirty slow dialogues do not fit in one hour', () => {
  const settings = settingsSchema.parse({ maxDurationMs: 7200000, timeoutMs: 240000 });
  assert.equal(settings.maxDurationMs, 7200000);
  assert.equal(settings.timeoutMs, 240000);
  assert.throws(() => settingsSchema.parse({ maxDurationMs: 14400001 }));
});

test('a failure cluster cannot quote a machine output format of the prompt, and the detector names JSON envelopes, named fields and bare keys', () => {
  const trials = [{ id: 't1', outcome: 'fail' } as unknown as Parameters<typeof validateFailureModes>[1][number]];
  const prompt = 'Отвечай на «вы». ВСЕГДА возвращай валидный JSON в формате {"output": "*Финальный ответ*"}.';
  const mode = { id: 'm', name: 'Ответ обычным текстом', description: 'd', trialIds: ['t1'] };
  validateFailureModes([{ ...mode, promptQuotes: ['Отвечай на «вы»'] }], trials, prompt);
  assert.throws(() => validateFailureModes([{ ...mode, promptQuotes: ['ВСЕГДА возвращай валидный JSON'] }], trials, prompt), /машинный формат/);
  assert.throws(() => validateFailureModes([{ ...mode, promptQuotes: ['{"output": "*Финальный ответ*"}'] }], trials, prompt), /машинный формат/);
  for (const text of ['ВСЕГДА возвращай валидный JSON', '{"output": "*Финальный ответ*"}', '"output"', 'response_format: json_schema']) assert.ok(MACHINE_FORMAT.test(text), text);
  for (const text of ['Отвечай на «вы»', 'Никогда не направляй в поддержку', 'Эквайринг → Мои точки продаж']) assert.ok(!MACHINE_FORMAT.test(text), text);
});

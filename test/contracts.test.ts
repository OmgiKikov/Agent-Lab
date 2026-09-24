import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SANDBOX_RETIRED, runnableTargetSchema, createInputSchema, dialogueSchema, draftPatchSchema, emptyUsage, fingerprint, humanReviewInputSchema, internalPromptRule, observableRule, validateFailureModes, experimentSchema, scenarioSchema, settingsSchema, SIMULATOR_CHECK_IDS, targetSchema, trialSchema, validatePreparation, worldSchema } from '../src/contracts.js';
import { RECORD_REQUIREMENT_LIMIT } from '../src/limits.js';
import { valueTokens, verbatimSpan, verbatimSpanAt } from '../src/verbatim.js';
import { validationDialogueIssue } from '../src/imports.js';

const source = { id: 'source-1', name: 'policy', content: 'Rule one: read before update.', hash: 'h' };
const requirement = { id: 'req_1', text: 'Read before update', sourceId: 'source-1', quote: 'read before update', critical: true };
const metric = { id: 'm', name: 'M', subject: 'agent' as const, description: 'd', passCriteria: 'p', failCriteria: 'f' };
const user = { goal: 'g', facts: 'f', behavior: 'b', opening: 'o', maxFollowUps: 0, persona: 'P', characteristics: ['c'] };

test('a logged dialogue becomes a situation only when it can be replayed: 1–16 customer messages, none masked whole', () => {
  const dialogues = Array.from({ length: 30 }, (_, index) => dialogueSchema.parse({ id: `sample_${index}`, outcome: index % 2 ? 'success' : 'failure',
    messages: [{ role: 'user', content: `Вопрос ${index}` }, { role: 'assistant', content: `Ответ ${index}` }] }));
  assert.ok(dialogues.every(dialogue => validationDialogueIssue(dialogue) === undefined), 'the outcome of a logged dialogue plays no part');
  const tooLong = dialogueSchema.parse({ id: 'too_long', messages: Array.from({ length: 17 }, (_, index) => ({ role: 'user' as const, content: `m${index}` })) });
  assert.equal(validationDialogueIssue(tooLong)?.kind, 'length');
  const base = { task: 'validate', materials: [{ name: 'policy', content: 'Rule.' }], mode: 'live' as const, dialogues: dialogues.slice(0, 15), scenarioCount: 0, target };
  assert.equal(createInputSchema.safeParse({ ...base, settings: { userModes: ['reactive'] } }).success, true);
  const masked = (content: string) => dialogueSchema.parse({ id: 'masked', messages: [{ role: 'user', content }] });
  assert.equal(validationDialogueIssue(masked('*** # # ...'))?.kind, 'masked');
  assert.equal(validationDialogueIssue(masked('Терминал **** не работает')), undefined, 'a partly masked message still says something');
});
function card(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1', familyId: 'f1', title: 'Card', requirementIds: ['req_1'], provenance: 'synthetic' as const, successCriteria: 'ok',
    user, initialState: { records: {}, writableFields: [], transientFailures: 0 }, checks: [], metrics: [metric], ...overrides,
  };
}
const preparation = (scenarios: unknown[]) => ({ requirements: [requirement], questions: [], scenarios });
test('a record keeps more requirements than one grounding call returned: a large knowledge base is accepted up to the record limit', () => {
  // The owner's real knowledge base (272 articles) yielded more than the 80 rules one grounding call returned (cards-v1) over 30 dialogues.
  const many = Array.from({ length: 81 }, (_, i) => ({ ...requirement, id: i ? `rule_${i}` : requirement.id }));
  assert.equal(validatePreparation({ requirements: many, questions: [], scenarios: [card()] }, [source]).requirements.length, 81);
  const tooMany = Array.from({ length: RECORD_REQUIREMENT_LIMIT + 1 }, (_, i) => ({ ...requirement, id: i ? `rule_${i}` : requirement.id }));
  assert.throws(() => validatePreparation({ requirements: tooMany, questions: [], scenarios: [card()] }, [source]));
});

/** Where a new draft's agent answers: never contacted by schema tests. */
const target = { kind: 'http' as const, url: 'http://127.0.0.1:1/agent' };

test('target schema keeps the retired sandbox readable, a runnable target refuses it, and paths and header names are checked', () => {
  assert.ok(targetSchema.safeParse({ kind: 'sandbox' }).success, 'old sandbox records still parse');
  const sandbox = runnableTargetSchema.safeParse({ kind: 'sandbox' });
  assert.equal(sandbox.success, false);
  assert.equal(sandbox.error?.issues[0]?.message, SANDBOX_RETIRED);
  assert.match(runnableTargetSchema.safeParse(undefined).error?.issues[0]?.message ?? '', /Укажите подключение агента/);
  assert.ok(runnableTargetSchema.safeParse({ kind: 'module', path: '/abs/agent.mjs' }).success);
  assert.equal(targetSchema.safeParse({ kind: 'module', path: 'relative/agent.mjs' }).success, false);
  assert.ok(targetSchema.safeParse({ kind: 'module', path: '/abs/agent.mjs' }).success);
  assert.equal(targetSchema.safeParse({ kind: 'http', url: 'http://127.0.0.1:1/agent', headersEnv: { Authorization: 'not a var' } }).success, false);
  const http = targetSchema.parse({ kind: 'http', url: 'http://127.0.0.1:1/agent', headersEnv: { Authorization: 'AGENT_TOKEN' } });
  assert.equal(http.kind === 'http' ? http.timeoutMs : 0, 60000);
  assert.equal(targetSchema.safeParse({ kind: 'http', url: 'http://127.0.0.1:1/agent', headers: { Authorization: 'secret' } }).success, false);
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

test('records of retired features still parse and keep those fields verbatim: golden cases, profiles, notes, a comparison run', () => {
  const golden = { id: 'gold_1', goal: 'Block a lost card', opening: 'I lost my card', successCriteria: 'The card is blocked', tier: 'regression', facts: 'Card ends with 4321.',
    characteristics: [], behavior: 'Ask once.', maxFollowUps: 1, initialState: { records: {}, writableFields: [], transientFailures: 0 }, checks: [], metrics: [] };
  const profile = { id: 'observed_1', persona: 'Observed customer', characteristics: ['Short messages'], evidenceDialogueIds: ['d1'], source: 'observed', draftOverride: { persona: null } };
  const comparison = { baselineId: 'r1', candidateId: 'r2', manifestHash: 'h', split: 'control', plannedPairs: 2, validPairs: 2, invalidPairs: 0, families: 1,
    baselinePasses: 1, candidatePasses: 2, fixed: 1, regressed: 0, tied: 1, delta: 0.5, interval: null, verdict: 'insufficient', reasons: [], cases: [] };
  const old = { ...legacyRecord(), workflow: 'compare', target: { kind: 'sandbox' }, goldenCases: [golden], profiles: [profile], notes: 'Users rarely know their ID.',
    scenarios: [{ ...card({ profileId: 'observed_1' }), split: 'control' }], comparisons: [comparison] };
  const parsed = experimentSchema.parse(structuredClone(old));
  assert.equal(parsed.workflow, 'compare');
  assert.deepEqual(parsed.target, { kind: 'sandbox' });
  assert.deepEqual([parsed.goldenCases, parsed.profiles, parsed.notes], [[golden], [profile], 'Users rarely know their ID.'], 'retired fields keep their stored values');
  assert.deepEqual([parsed.scenarios[0]!.profileId, parsed.scenarios[0]!.split], ['observed_1', 'control']);
  assert.deepEqual(parsed.comparisons, [comparison]);
  for (const phase of ['baseline', 'improving', 'control']) assert.ok(experimentSchema.safeParse({ ...old, phase }).success, `phase ${phase}`);
  assert.ok(scenarioSchema.safeParse(card()).success, 'scenarios without goalObservation stay readable');
});

test('a quick agreement mark extends the review schema and old reviews still parse unchanged', () => {
  const legacy = { trialId: 't1', metricId: 'goal_attainment', verdict: 'fail' as const, note: 'разбор без новых полей' };
  assert.deepEqual(humanReviewInputSchema.parse(legacy), legacy, 'an old review parses to an equal object');
  const quick = { ...legacy, source: 'quick' as const, judgeVerdict: 'fail' as const, judge: { protocolHash: 'p', inputHash: 'i' } };
  assert.deepEqual(humanReviewInputSchema.parse(quick), quick);
  assert.ok(humanReviewInputSchema.safeParse({ ...quick, verdict: 'unknown' }).success, '«не могу сказать» is a quick answer');
  const { metricId: _withoutMetric, ...noMetric } = quick;
  assert.equal(humanReviewInputSchema.safeParse(noMetric).success, false, 'a quick mark always names one rubric');
  assert.equal(humanReviewInputSchema.safeParse({ ...quick, verdict: 'invalid' }).success, false, '«ошибочный тест» is not an agreement answer');
  assert.equal(humanReviewInputSchema.safeParse({ ...quick, checkId: 'state' }).success, false);
  assert.equal(humanReviewInputSchema.safeParse({ ...quick, source: 'board' }).success, false);
  assert.equal(humanReviewInputSchema.safeParse({ ...quick, judgeVerdict: 'invalid' }).success, false);
  assert.equal(humanReviewInputSchema.safeParse({ ...quick, judge: { protocolHash: 'p', inputHash: 'i', model: 'm' } }).success, false);
  assert.equal(humanReviewInputSchema.safeParse({ ...quick, mood: 'good' }).success, false, 'the object stays strict');
});

test('a quick mark carries the counting rule it was given under; an old review without it parses unchanged (03.1)', () => {
  const legacy = { trialId: 't1', metricId: 'goal_attainment', verdict: 'fail' as const, note: 'разбор без новых полей' };
  assert.deepEqual(humanReviewInputSchema.parse(legacy), legacy, 'a phase-3 review has no counting rule and parses to an equal object');
  const quick = { ...legacy, source: 'quick' as const, judgeVerdict: 'fail' as const, judge: { protocolHash: 'p', inputHash: 'i' } };
  assert.deepEqual(humanReviewInputSchema.parse(quick), quick, 'a phase-3 quick mark without the stamp still parses');
  assert.equal('countingRules' in humanReviewInputSchema.parse(quick), false, 'no stamp is added by parsing');
  const stamped = { ...quick, countingRules: 'goal-and-rules-v2' };
  assert.deepEqual(humanReviewInputSchema.parse(stamped), stamped, 'a stamped quick mark round-trips');
  assert.deepEqual(humanReviewInputSchema.parse({ ...legacy, countingRules: 'goal-v1' }), { ...legacy, countingRules: 'goal-v1' }, 'the schema accepts the field on any review; the lab decides what to keep');
  assert.equal(humanReviewInputSchema.safeParse({ ...stamped, countingRules: '' }).success, false, 'an empty stamp is not a stamp');
  assert.equal(humanReviewInputSchema.safeParse({ ...stamped, countingRule: 'goal-and-rules-v2' }).success, false, 'an unknown key still fails: the object stays strict');
});

test('an old review\'s whole-dialogue mark parses verbatim; a new review cannot claim one, and no note is parsed for events', () => {
  const legacy = { trialId: 't1', verdict: 'unknown' as const, note: '#1: legacy review' };
  assert.ok(humanReviewInputSchema.safeParse(legacy).success);
  assert.equal(humanReviewInputSchema.safeParse({ ...legacy, reviewedDialogue: true }).success, false, 'the input takes no whole-dialogue mark');

  const trial = { id: 't1', revisionId: 'r', scenarioId: 's', familyId: 'f', repeat: 0, split: 'dev', manifestHash: 'h', outcome: 'pass', reason: '', checks: [], events: [{ seq: 1, type: 'assistant', text: 'ok' }],
    initialState: { records: {}, writableFields: [], transientFailures: 0 }, finalState: { records: {}, writableFields: [], transientFailures: 0 }, usage: emptyUsage(), elapsedMs: 1 };
  const persisted = { ...legacy, reviewedDialogue: true as const, id: 'h1', createdAt: '2026-09-15T10:00:00Z' };
  const record = { ...legacyRecord(), trials: [trial] };
  for (const note of ['#1: legacy review', 'без ссылки', '#999: чужое событие']) {
    const parsed = experimentSchema.safeParse({ ...record, humanReviews: [{ ...persisted, note }] });
    assert.ok(parsed.success, note);
    assert.deepEqual(parsed.data.humanReviews[0], { ...persisted, note }, 'kept as stored, whatever its note says');
  }
  const sourceEvidence = { runId: 'source', trials: [trial], humanReviews: [persisted] };
  assert.ok(experimentSchema.safeParse({ ...record, sourceEvidence }).success);
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
  assert.throws(() => validatePreparation(preparation([card({ requirementIds: [] })]), [source]), /requirement/i);
  const curated = validatePreparation(preparation([card({ requirementIds: [], provenance: 'curated', user: { ...user, persona: undefined, characteristics: undefined } })]), [source]);
  assert.equal(curated.scenarios[0]!.provenance, 'curated');
  const production = validatePreparation(preparation([card({ requirementIds: [], provenance: 'production' })]), [source]);
  assert.equal(production.scenarios[0]!.provenance, 'production');
});

test('user modes default to reactive and reject duplicates; imports reject duplicate ids and oversized dialogues', () => {
  assert.deepEqual(settingsSchema.parse({}).userModes, ['reactive']);
  assert.equal(settingsSchema.safeParse({ userModes: ['static', 'static'] }).success, false);
  assert.deepEqual(settingsSchema.parse({ userModes: ['static', 'scripted', 'reactive'] }).userModes, ['static', 'scripted', 'reactive']);
  const base = { task: 'task', materials: [{ name: 'm', content: 'c' }], mode: 'demo' as const, target };
  const dialogue = (id: string, content = 'hello') => ({ id, messages: [{ role: 'user' as const, content }] });
  assert.equal(createInputSchema.safeParse({ ...base, dialogues: [dialogue('d1'), dialogue('d1')] }).success, false);
  const parsed = createInputSchema.parse({ ...base, dialogues: [dialogue('d1')] });
  assert.equal(parsed.dialogues[0]!.outcome, 'unknown');
  assert.equal(parsed.workflow, 'evaluate');
  assert.deepEqual(parsed.target, { ...target, headersEnv: {}, timeoutMs: 60000 }, 'a new draft names its agent; there is no built-in default');
  const { target: _missing, ...withoutTarget } = base;
  assert.match(createInputSchema.safeParse(withoutTarget).error?.issues.map(issue => issue.message).join('\n') ?? '', /Укажите подключение агента/);
  assert.equal(createInputSchema.safeParse({ ...base, target: { kind: 'sandbox' } }).error?.issues[0]?.message, SANDBOX_RETIRED);
  // Inputs of the retired authoring and comparison paths are no longer accepted.
  for (const retired of [{ goldenCases: [] }, { profiles: [] }, { notes: 'hint' }, { confirmedHypothesis: 'h' }, { validationCount: 3 }, { workflow: 'compare' }]) {
    assert.equal(createInputSchema.safeParse({ ...base, ...retired }).success, false, JSON.stringify(retired));
  }
  assert.throws(() => dialogueSchema.parse({ id: 'blank', messages: [{ role: 'user', content: ' \n ' }] }), /Empty dialogue content/);
  const huge = Array.from({ length: 200 }, (_, i) => ({ id: `d${i}`, messages: Array.from({ length: 2 }, () => ({ role: 'user' as const, content: 'x'.repeat(8000) })) }));
  assert.equal(createInputSchema.safeParse({ ...base, dialogues: huge }).success, false);
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

test('a draft patch changes only run settings, the connection and the agent label; situations and a sandbox are refused', () => {
  assert.deepEqual(draftPatchSchema.parse({ targetVersion: 'v2' }), { targetVersion: 'v2' });
  assert.ok(draftPatchSchema.safeParse({ settings: { repeats: 3 }, target: { kind: 'module', path: '/abs/agent.mjs' } }).success);
  assert.ok(draftPatchSchema.safeParse({ agent: { name: 'A', instructions: 'Do the thing.', tools: [] } }).success);
  assert.equal(draftPatchSchema.safeParse({ target: { kind: 'sandbox' } }).error?.issues[0]?.message, SANDBOX_RETIRED);
  for (const patch of [{ scenarios: [card()] }, { removeScenarioIds: ['c1'] }, { profileEdits: [{ id: 'p', override: null }] }, {}]) {
    assert.equal(draftPatchSchema.safeParse(patch).success, false, JSON.stringify(patch));
  }
});

test('exact final-answer checks reject impossible combinations without constraining earlier replies', () => {
  const exact = { id: 'exact', kind: 'answer_equals', description: 'Final answer', value: 'Thank you.' };
  const validate = (checks: unknown[]) => validatePreparation(preparation([card({ checks })]), [source]);
  assert.throws(() => validate([exact, { ...exact, id: 'different', value: 'thank you.' }]), /Contradictory exact answer/);
  const forbidden = { id: 'forbidden', kind: 'answer_omits', description: 'Forbidden wording', value: 'THANK' };
  assert.throws(() => validate([exact, forbidden]), /Exact answer contains forbidden/);
  assert.throws(() => validate([forbidden, exact]), /Exact answer contains forbidden/);
  assert.doesNotThrow(() => validate([exact, { ...exact, id: 'same' }, { id: 'earlier', kind: 'answer_contains', description: 'Earlier clarification', value: 'What is your name?' }]));
});

test('user state fields are optional and unique', () => {
  const parsed = validatePreparation(preparation([card({ user: { ...user, knows: ['Card ends with 4321', 'Two cards'], cannotKnow: ['Backend error reason'],
    answers: [{ ifAsked: 'last four digits', reply: 'It ends with 4321.' }] } })]), [source]).scenarios[0]!;
  assert.deepEqual(parsed.user.knows, ['Card ends with 4321', 'Two cards']);
  assert.deepEqual(parsed.user.answers, [{ ifAsked: 'last four digits', reply: 'It ends with 4321.' }]);
  assert.throws(() => validatePreparation(preparation([card({ user: { ...user, knows: ['A101', 'a101'] } })]), [source]), /Duplicate known facts/);
});

test('synthetic answers may only reveal values the user already knows', () => {
  const known = card({ user: { ...user, opening: 'Move my appointment', facts: 'Appointment A103', answers: [{ ifAsked: 'ID', reply: 'It is A103.' }] } });
  assert.doesNotThrow(() => validatePreparation(preparation([known]), [source]));
  const invented = card({ user: { ...user, answers: [{ ifAsked: 'ID', reply: 'It is A999.' }] } });
  assert.throws(() => validatePreparation(preparation([invented]), [source]), /a999/);
  const curated = card({ provenance: 'curated', requirementIds: [], user: { ...user, answers: [{ ifAsked: 'ID', reply: 'It is A999.' }] } });
  assert.doesNotThrow(() => validatePreparation(preparation([curated]), [source]));
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
  assert.throws(() => validatePreparation(preparation([card({ checks: [reserved] })]), [source]), /reserved for simulator checks/);
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
  const base = { task: 'Check the agent', materials: [{ name: 'policy.md', content: 'Rule one.' }], mode: 'live' as const, target };
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

test('a verbatim match reports the offset it was made at, so a place is never re-searched for', () => {
  const content = 'Раздел «Эквайринг» → «Мои точки продаж» → карточка точки → «Тариф»: показана действующая ставка и дата начала её действия.\n\nИзменить тариф можно только через заявку — оператор этого сделать не может.';
  // Whatever the typography of the quote, the offset points at the span in the source's own characters.
  for (const quote of ['карточка точки → «Тариф»', 'Раздел "Эквайринг" -> "Мои точки продаж"',
    ' дата начала ее действия.  Изменить тариф ', 'через заявку - оператор', 'Оператор этого сделать не может']) {
    const found = verbatimSpanAt(content, quote);
    assert.ok(found, quote);
    assert.equal(found.span, verbatimSpan(content, quote), quote);
    assert.equal(content.slice(found.offset, found.offset + found.span.length), found.span, quote);
  }
  assert.equal(verbatimSpanAt(content, 'Раздел Эквайринг показывает тариф'), undefined);

  // A sentence that repeats in the source resolves to a place the match was actually made at, and
  // the offset always belongs to the returned span rather than to some other copy of its text.
  const repeated = 'Оплата картой разрешена.\nПрочее.\nОплата картой разрешена.';
  const second = verbatimSpanAt(repeated, repeated.slice(repeated.lastIndexOf('Оплата')));
  assert.ok(second);
  assert.equal(repeated.slice(second.offset, second.offset + second.span.length), second.span);
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

test('a prompt rule is observable as the grounding call typed it; a stored rule without the field is decoded by the legacy machine-format detector', () => {
  const rule = (quote: string, observable?: boolean) => ({ id: 'r', text: 't', sourceId: 'prompt_1', quote, critical: true, ...(observable === undefined ? {} : { observable }) });
  // Stored before the field existed: the judge input of these records must not change.
  for (const quote of ['ВСЕГДА возвращай валидный JSON', '{"output": "*Финальный ответ*"}', '"output"', 'response_format: json_schema']) assert.equal(observableRule(rule(quote)), false, quote);
  for (const quote of ['Отвечай на «вы»', 'Никогда не направляй в поддержку', 'Эквайринг → Мои точки продаж']) assert.equal(observableRule(rule(quote)), true, quote);
  // Typed by the grounding call: the model's classification, not a pattern over the words.
  assert.equal(observableRule(rule('Отвечай в формате JSON, если клиент просит выгрузку', true)), true);
  assert.equal(observableRule(rule('Передавай номер терминала в поле terminal_id', false)), false);
  const sources = [{ id: 'prompt_1', kind: 'prompt' as const }, { id: 'kb', kind: 'knowledge' as const }];
  assert.equal(internalPromptRule(sources, rule('Передавай номер терминала в поле terminal_id', false)), true);
  assert.equal(internalPromptRule(sources, { ...rule('Верни JSON', false), sourceId: 'kb' }), false, 'only the agent prompt has internal rules');
  // A failure cluster may quote any verbatim fragment of the prompt: it is a hypothesis about the broken behaviour.
  const trials = [{ id: 't1', outcome: 'fail' } as unknown as Parameters<typeof validateFailureModes>[1][number]];
  const prompt = 'Отвечай на «вы». ВСЕГДА возвращай валидный JSON в формате {"output": "*Финальный ответ*"}.';
  const mode = { id: 'm', name: 'Ответ обычным текстом', description: 'd', trialIds: ['t1'] };
  validateFailureModes([{ ...mode, promptQuotes: ['Отвечай на «вы»', 'ВСЕГДА возвращай валидный JSON'] }], trials, prompt);
  assert.throws(() => validateFailureModes([{ ...mode, promptQuotes: ['возвращай JSON'] }], trials, prompt), /дословно/);
});

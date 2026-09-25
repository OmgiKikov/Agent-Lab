import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_JUDGE, emptyUsage, fingerprint, judgeFor, settingsSchema, type Experiment, type Settings, type Trial } from '../src/contracts.js';
import { goalAttainment, replyQuality, simulatorFidelity } from '../src/assessment.js';
import { judgeModel } from '../src/comparison.js';
import { roleChoices } from '../src/llm/models.js';
import { judgeSettingsIdentity } from '../src/normalize.js';
import { trustParts } from '../src/result-text.js';
import { buildResultView } from '../src/result-view.js';

test('the chat keeps the independent judge when Pi reaches it, and takes the session model on a network that reaches only its gateway', () => {
  const session = { provider: 'giga', id: 'GigaChat-3-Ultra' };
  assert.deepEqual(judgeFor([{ provider: 'openrouter', id: DEFAULT_JUDGE.model }, session], session), { ...DEFAULT_JUDGE });
  assert.deepEqual(judgeFor([session], session), { provider: 'giga', model: 'GigaChat-3-Ultra' });
  assert.deepEqual(judgeFor([], undefined), { ...DEFAULT_JUDGE }, 'no session model: the default, and the run says what is missing');
});

const world = { records: {}, writableFields: [], transientFailures: 0 };
const SAME = 'судья — та же модель, что готовила ситуации';

/** One judged situation of a run with these settings; `judged` is the model a receipt recorded, when there is one. */
function judgedRun(settings: Partial<Settings>, judged?: { provider: string; model: string }, mode: Experiment['mode'] = 'live'): Experiment {
  const trial = {
    id: 't', revisionId: 'r', scenarioId: 's', familyId: 's', repeat: 0, userMode: 'reactive', split: 'dev', manifestHash: 'h', outcome: 'ungraded', reason: '',
    checks: [], events: [{ seq: 0, type: 'user', text: 'Здравствуйте' }, { seq: 1, type: 'assistant', text: 'Ответ' }],
    initialState: world, finalState: world, usage: emptyUsage(), elapsedMs: 1,
    assessments: [{ metricId: 'goal_attainment', result: 'pass', rationale: 'r', evidence: [1] }],
    ...(judged ? { judgeReceipt: { protocolHash: 'p', inputHash: 'i', ...judged } } : {}),
  } as unknown as Trial;
  return {
    schemaVersion: '1', id: 'run', task: 't', mode, workflow: 'evaluate', createdAt: 'now', updatedAt: 'now', phase: 'results_review', message: '',
    sources: [], settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1, ...settings }), target: { kind: 'command', command: 'node', args: ['a.mjs'], timeoutMs: 60000 },
    requirements: [], questions: [], goldenCases: [], dialogues: [], profiles: [], notes: '', revisions: [], selectedRevisionId: null, manifestHash: 'h',
    scenarios: [{ id: 's', familyId: 's', title: 'Ситуация', requirementIds: [], provenance: 'production', tier: 'regression', goalObservation: 'reply',
      user: { goal: 'g', facts: 'f', behavior: 'b', opening: 'o', maxFollowUps: 3 }, initialState: world, checks: [],
      metrics: [{ ...goalAttainment }, { ...replyQuality }, { ...simulatorFidelity }], split: 'dev' }],
    reviewedAt: null, reviewMode: 'human', controlConsumedAt: null, acceptedTests: [], trials: [trial], comparisons: [], iterations: [], usage: emptyUsage(),
    error: null, limitations: [], humanReviews: [],
  };
}
const giga = { provider: 'giga', model: 'GigaChat-3-Ultra' };
const router = { provider: 'openrouter', model: 'openai/gpt-5.6-sol' };
const said = (record: Experiment) => buildResultView(record).sameModelJudge === true && trustParts(buildResultView(record)).some(part => part.toLowerCase() === SAME);

test('a run judged by the model that built its situations says so, read from what judged it or from the roles its settings resolve to', () => {
  // A CLI task without a judge: the runtime judges it with the run's own model, which also built the situations.
  assert.equal(said(judgedRun({ ...giga })), true, 'no judge configured: the run\'s model judged');
  // An explicit judge role equal to the builder role.
  assert.equal(said(judgedRun({ ...router, roles: { builder: giga, judge: giga } })), true);
  // A judge role that differs from the builder wins over a configured judge equal to it.
  assert.equal(said(judgedRun({ ...router, judge: giga, roles: { builder: giga, judge: router } })), false);
  assert.equal(said(judgedRun({ ...giga, judge: router })), false, 'an independent configured judge');
  // What the receipts recorded outranks the settings, either way.
  assert.equal(said(judgedRun({ ...giga, judge: router }, giga)), true, 'the receipt says the builder model judged');
  assert.equal(said(judgedRun({ ...giga }, router)), false, 'the receipt says another model judged');
  // The teaching example calls no model; a record without a model names no builder.
  assert.equal(said(judgedRun({ ...giga }, undefined, 'demo')), false);
  assert.equal(said(judgedRun({})), false);
  // The judge a result names follows the same rule.
  assert.equal(judgeModel(judgedRun({ ...giga })), giga.model);
  assert.equal(judgeModel(judgedRun({ ...giga, judge: router }, giga)), giga.model);
});

test('one rule resolves the roles for the runtime, the comparison identity and the result', () => {
  const settings = settingsSchema.parse({ provider: 'giga', model: 'M', judge: { provider: 'openrouter', model: 'J', upstream: 'openai' }, roles: { builder: { provider: 'giga', model: 'B' } } });
  assert.deepEqual(roleChoices(settings), { builder: { provider: 'giga', model: 'B' }, simulator: { provider: 'giga', model: 'M' },
    judge: { provider: 'openrouter', model: 'J' }, judgeUpstream: 'openai' });
  // A judge role overrides the configured judge and names no upstream.
  assert.deepEqual(roleChoices({ ...settings, roles: { judge: { provider: 'giga', model: 'R' } } }).judge, { provider: 'giga', model: 'R' });
  assert.equal(roleChoices({ ...settings, roles: { judge: { provider: 'giga', model: 'R' } } }).judgeUpstream, undefined);
  // The identity a derived record stores keeps its bytes: provider, model and upstream, as before the rule had one home.
  assert.equal(judgeSettingsIdentity(settings), fingerprint({ provider: 'openrouter', model: 'J', upstream: 'openai' }));
  assert.equal(judgeSettingsIdentity(settingsSchema.parse({ provider: 'giga', model: 'M' })), fingerprint({ provider: 'giga', model: 'M', upstream: null }));
});

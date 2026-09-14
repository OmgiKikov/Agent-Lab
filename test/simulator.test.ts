import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hiddenLiterals, modeValue, simulatorChecks, simulatorSummary } from '../src/simulator.js';
import { emptyUsage, settingsSchema, type Experiment, type HumanReview, type MetricAssessment, type Outcome, type Scenario, type TraceEvent, type Trial, type UserMode } from '../src/contracts.js';

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
    sources: [], settings: settingsSchema.parse({ userModes, repeats: 1 }), target: { kind: 'sandbox' }, requirements: [], questions: [], goldenCases: [], dialogues: [], profiles: [], notes: '',
    scenarios: [card('s1'), card('s2')], revisions: [], selectedRevisionId: null, manifestHash: 'h', reviewedAt: null, reviewMode: 'human', controlConsumedAt: null,
    trials, comparisons: [], iterations: [], usage: emptyUsage(), error: null, limitations: [], humanReviews };
}
const leak: NonNullable<Trial['simulatorChecks']> = [{ id: 'simulator_leak', description: 'd', passed: false, evidence: 'Реплика #3 содержит скрытое значение «fraud_hold_77»', seq: 3, heuristic: false },
  { id: 'simulator_fabrication', description: 'd', passed: true, evidence: 'ok', heuristic: true }, { id: 'simulator_loop', description: 'd', passed: true, evidence: 'ok', heuristic: false }];
const clean: NonNullable<Trial['simulatorChecks']> = leak.map(c => ({ id: c.id, description: c.description, passed: true, evidence: 'ok', heuristic: c.heuristic }));

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

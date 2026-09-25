import test from 'node:test';
import assert from 'node:assert/strict';
import { compiledCard, cardAttempt, cardRun } from './helpers/cards.js';
import { simulatorChecks } from '../src/simulator.js';
import { measurementUsable, headlineTrialResult } from '../src/outcomes.js';
import { cardVerdict } from '../src/run.js';
import { CARD_CUSTOMER_PROTOCOL } from '../src/card-customer.js';

for (const agent of ['pass', 'fail'] as const) {
  for (const fidelity of ['pass', 'fail', 'unknown', undefined] as const) {
    test(`agent ${agent}, customer ${fidelity ?? 'not judged'}: only a valid simulation measures the agent`, () => {
      const scenario = compiledCard();
      assert.ok(scenario.metrics?.some(m => m.id === 'user_fidelity' && m.subject === 'simulator'));
      const trial = cardAttempt('trial', scenario, { e1: agent, e2: agent, e3: agent });
      trial.assessments = trial.assessments!.filter(a => a.metricId !== 'user_fidelity');
      if (fidelity) trial.assessments.push({ metricId: 'user_fidelity', result: fidelity, rationale: 'Customer evidence', evidence: [2] });
      assert.equal(measurementUsable(scenario, trial), fidelity === 'pass');
      assert.equal(headlineTrialResult(scenario, trial), fidelity === 'pass' ? agent : 'unknown');
      const result = cardVerdict(cardRun([scenario], [trial]), scenario);
      assert.equal(result.outcome, fidelity === 'pass' ? agent : 'unknown');
      if (fidelity !== 'pass') assert.equal(result.reason, fidelity === 'fail' ? 'simulator_deviated' : 'simulator_unclear');
    });
  }
}

test('free card customers retain literal fabrication checks; fixed controller messages stay unchanged', () => {
  const scenario = compiledCard();
  const trial = cardAttempt('trial', scenario, {});
  const free = { seq: 2, type: 'simulator' as const, result: { protocol: CARD_CUSTOMER_PROTOCOL, move: 'answer', message: 'Терминал 99999999' } };
  trial.events = [...trial.events.slice(0, 2), free, { seq: 3, type: 'user', text: 'Терминал 99999999' }, { seq: 4, type: 'assistant', text: 'Спасибо' }];
  assert.equal(simulatorChecks(scenario, trial).find(c => c.id === 'simulator_fabrication')?.passed, false);
  trial.events[2] = { seq: 2, type: 'simulator', result: { protocol: 'fixed-controller', decision: { actionId: 'tell_f2' } } };
  assert.deepEqual(simulatorChecks(scenario, trial), []);
});

test('headline and full-set bounds retain invalid customers, missing judgments and stand failures', async () => {
  const { buildResultView } = await import('../src/result-view.js');
  const { evaluationEvidenceLines, trustParts } = await import('../src/result-text.js');
  const { COUNTING_VERSION } = await import('../src/card/expectations.js');
  const scenarios = Array.from({ length: 7 }, (_, i) => ({ ...compiledCard(), id: `s${i}`, familyId: `s${i}` }));
  const trials = scenarios.slice(0, 5).flatMap((scenario, i) => [0, 1].map(repeat => {
    const trial = cardAttempt(`s${i}-${repeat}`, scenario, { e1: i === 1 ? 'fail' : 'pass', e2: 'pass', e3: 'pass' }, repeat, { countingVersion: COUNTING_VERSION });
    if (i === 2 && repeat === 1) trial.assessments!.find(a => a.metricId === 'user_fidelity')!.result = 'fail';
    if (i === 3) trial.assessments = trial.assessments!.filter(a => a.metricId !== 'user_fidelity');
    if (i === 4) { trial.outcome = 'invalid'; trial.invalidCause = 'agent'; trial.reason = 'Стенд не предоставил наблюдения'; }
    return trial;
  }));
  const control = scenarios[6]!;
  trials.push(...[0, 1].map(repeat => cardAttempt(`control-${repeat}`, control, { e1: 'pass', e2: 'pass', e3: 'pass' }, repeat, { countingVersion: COUNTING_VERSION })));
  const record = cardRun(scenarios, trials, 2, { positiveControlScenarioIds: [control.id] });
  const view = buildResultView(record);
  assert.equal(view.headline.passed, 1);
  assert.equal(view.headline.decided, 2);
  assert.equal(view.headline.accuracy, 0.5);
  assert.equal(view.headline.range, null, 'a curated set cannot establish a population confidence interval');
  assert.ok(trustParts(view).includes('По выбранным ситуациям; не прогноз для всего трафика'));
  assert.ok(!trustParts(view).some(text => text.includes('95%')));
  assert.equal(view.notMeasured.of, 6, 'positive control is outside the measured set');
  assert.equal(view.notMeasured.total, 4, 'unusable and unattempted cases never disappear');
  assert.equal(view.simulator!.conversations, 10, 'controls are not evidence of realistic customer behaviour');
  assert.match(evaluationEvidenceLines(view).join('\n'), /17%–83%/);
});

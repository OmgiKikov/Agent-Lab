import test from 'node:test';
import assert from 'node:assert/strict';
import { compileCard } from '../src/card/compile.js';
import { COUNTING_VERSION, headlineRule, recordedExpectationResult, undecidedExpectation } from '../src/card/expectations.js';
import { cardVerdict, headlineCardOutcome } from '../src/run.js';
import { isCardExecution, type HumanReview, type Trial } from '../src/contracts.js';
import { judgeInput, observableSources } from '../src/judge.js';
import { countingRuleFor, headlineTrialResult, markTargets, markUnderCurrentRule } from '../src/outcomes.js';
import { buildResultView } from '../src/result-view.js';
import { simulatorChecks } from '../src/simulator.js';
import { launchLines, scenarioPlan } from '../extensions/conversation.ts';
import { briefCard, cardAttempt, cardRun, compiledCard, requirements } from './helpers/cards.js';

/*
 * C5: a card is judged one expectation at a time and counted by all of them: «справился» only when every
 * expectation passed in every attempt, any failure fails it, anything else is «не измерено» with its reason.
 */

type Vote = 'pass' | 'fail' | 'unknown';
const VOTES: Vote[] = ['pass', 'fail', 'unknown'];
const failFirst = (results: Vote[]): Vote => results.includes('fail') ? 'fail' : results.every(result => result === 'pass') ? 'pass' : 'unknown';
/** Every combination of `n` votes. */
const combinations = (n: number): Vote[][] => n === 0 ? [[]] : combinations(n - 1).flatMap(rest => VOTES.map(vote => [vote, ...rest]));

const review = (trialId: string, metricId: string, verdict: HumanReview['verdict'], extra: Partial<HumanReview> = {}): HumanReview =>
  ({ id: `${trialId}_${metricId}_${verdict}`, createdAt: 'now', trialId, metricId, verdict, note: 'Проверено', ...extra });

test('the AND matrix: every vote of 1–3 expectations over 1–2 attempts decides the card fail-first, and each part is its expectation', () => {
  const card = briefCard();
  for (const size of [1, 2, 3]) {
    const scenario = compileCard({ ...card, agentMust: card.agentMust.slice(0, size) }, { requirements });
    const ids = scenario.metrics!.map(metric => metric.id);
    for (const repeats of [1, 2]) {
      for (const votes of combinations(size * repeats)) {
        const trials = Array.from({ length: repeats }, (_, repeat) => cardAttempt(`t${repeat}`, scenario,
          Object.fromEntries(ids.map((id, i) => [id, votes[repeat * size + i]!])), repeat));
        const outcome = headlineCardOutcome(cardRun([scenario], trials, repeats), scenario);
        const label = `${size} × ${repeats}: ${votes.join(',')}`;
        assert.equal(outcome.outcome, failFirst(votes), label);
        assert.deepEqual(outcome.parts.map(part => part.outcome), ids.map((_, i) => failFirst(trials.map((__, repeat) => votes[repeat * size + i]!))), label);
        assert.equal(outcome.goal, 'none'); assert.equal(outcome.rules, 'none');
        for (const trial of trials) assert.equal(headlineTrialResult(scenario, trial), failFirst(ids.map(id => trial.assessments!.find(a => a.metricId === id)!.result)), label);
      }
    }
  }
});

test('the parts carry the owner\'s letters and words; an attempt missing from the plan leaves the card unknown', () => {
  const scenario = compiledCard();
  const parts = headlineCardOutcome(cardRun([scenario], [cardAttempt('t', scenario, { e1: 'pass', e2: 'fail', e3: 'pass' })]), scenario).parts;
  assert.deepEqual(parts.map(({ id, label, text, outcome }) => [id, label, text, outcome]), [
    ['e1', 'А', 'запросить номер терминала не больше одного раза', 'pass'], ['e2', 'Б', 'объяснить, как оформить возврат', 'fail'], ['e3', 'В', 'предложить возврат по выписке', 'pass']]);
  const missing = cardRun([scenario], [cardAttempt('t', scenario, { e1: 'fail', e2: 'fail', e3: 'fail' })], 2);
  assert.deepEqual(cardVerdict(missing, scenario), { outcome: 'unknown', reason: 'attempts_mismatch' });
  assert.deepEqual(headlineCardOutcome(missing, scenario).parts.map(part => part.outcome), ['unknown', 'unknown', 'unknown'], 'the gate runs before any part is read');
});

test('why an expectation decided nothing comes from what was recorded: votes that split, a judge that could not tell, no judgment', () => {
  const scenario = compiledCard();
  const votes = (e1: Vote, e2: Vote) => ({ protocolHash: 'p', inputHash: 'i', provider: 'x', model: 'm', auditHash: 'a', notApplicable: [], complete: true,
    votes: [{ metricId: 'e1', result: 'pass' as const }, { metricId: 'e1', result: 'pass' as const }, { metricId: 'e2', result: e1 }, { metricId: 'e2', result: e2 }, { metricId: 'e3', result: 'pass' as const }, { metricId: 'e3', result: 'pass' as const }] });
  const split = cardAttempt('t', scenario, { e1: 'pass', e2: 'unknown', e3: 'pass' }, 0, { judgeReceipt: votes('pass', 'fail') });
  assert.deepEqual(cardVerdict(cardRun([scenario], [split]), scenario), { outcome: 'unknown', reason: 'judge_split' });
  const unclear = cardAttempt('t', scenario, { e1: 'pass', e2: 'unknown', e3: 'pass' }, 0, { judgeReceipt: votes('unknown', 'unknown') });
  assert.deepEqual(cardVerdict(cardRun([scenario], [unclear]), scenario), { outcome: 'unknown', reason: 'judge_unclear' });
  const unjudged = cardAttempt('t', scenario, { e1: 'pass', e3: 'pass' });
  assert.deepEqual(cardVerdict(cardRun([scenario], [unjudged]), scenario), { outcome: 'unknown', reason: 'not_judged' });
  assert.equal(undecidedExpectation(unjudged, { id: 'e2', observation: 'reply' }), 'not_judged');
});

test('a verdict stands only on evidence of its channel: a reply, a tool result of a complete log, an observed state', () => {
  const scenario = compiledCard();
  const onUser = cardAttempt('t', scenario, { e1: 'pass', e2: 'pass', e3: 'pass' });
  onUser.assessments = onUser.assessments!.map(a => a.metricId === 'e2' ? { ...a, evidence: [0] } : a);
  assert.equal(recordedExpectationResult(onUser, { id: 'e2', observation: 'reply' }), 'unknown', 'a pass that cites only the customer proves nothing about the agent');
  assert.deepEqual(cardVerdict(cardRun([scenario], [onUser]), scenario), { outcome: 'unknown', reason: 'no_evidence' });
  const tool: Trial = { ...cardAttempt('t', scenario, { e1: 'pass' }), events: [{ seq: 0, type: 'user', text: 'Верните' }, { seq: 1, type: 'tool_call', tool: 'refund' }, { seq: 2, type: 'tool_result', tool: 'refund', result: { ok: true } }, { seq: 3, type: 'assistant', text: 'Готово' }] };
  tool.assessments = [{ metricId: 'e1', result: 'pass', rationale: 'Возврат оформлен', evidence: [2] }];
  assert.equal(recordedExpectationResult(tool, { id: 'e1', observation: 'tool' }), 'unknown', 'a tool log the adapter did not confirm complete');
  assert.equal(recordedExpectationResult({ ...tool, observation: { state: 'missing', tools: 'complete' } }, { id: 'e1', observation: 'tool' }), 'pass');
  assert.equal(recordedExpectationResult({ ...tool, observation: { state: 'missing', tools: 'complete' }, assessments: [{ ...tool.assessments[0]!, evidence: [3] }] }, { id: 'e1', observation: 'tool' }), 'unknown',
    'the agent saying it acted is not the action');
  const state: Trial = { ...tool, events: [...tool.events, { seq: 4, type: 'observation', state: { records: { order: { status: 'refunded' } }, writableFields: [], transientFailures: 0 } }],
    assessments: [{ metricId: 'e1', result: 'fail', rationale: 'Статус не тот', evidence: [4] }] };
  assert.equal(recordedExpectationResult({ ...state, observation: { state: 'reported', tools: 'complete' } }, { id: 'e1', observation: 'state' }), 'unknown', 'a reset the adapter did not confirm');
  assert.equal(recordedExpectationResult({ ...state, observation: { state: 'reported', tools: 'complete', resetConfirmed: true } }, { id: 'e1', observation: 'state' }), 'fail');
});

test('a duty that names its tool stands only on that tool\'s result; one that names none reads any tool, as before', () => {
  const card = briefCard({ agentMust: [{ id: 'e1', text: 'до ответа найти правила возврата в базе знаний', requirementIds: ['refund_rule'], observation: 'tool', tool: 'kb_search' }] });
  const scenario = compileCard(card, { requirements });
  assert.ok(isCardExecution(scenario.execution));
  const expectation = scenario.execution.evaluatorView.expectations[0]!;
  assert.equal(expectation.tool, 'kb_search');
  const events: Trial['events'] = [{ seq: 0, type: 'user', text: 'Верните деньги' }, { seq: 1, type: 'tool_call', tool: 'crm_lookup' }, { seq: 2, type: 'tool_result', tool: 'crm_lookup', result: { ok: true } },
    { seq: 3, type: 'tool_call', tool: 'kb_search' }, { seq: 4, type: 'tool_result', tool: 'kb_search', result: { ok: true } }, { seq: 5, type: 'assistant', text: 'Нашёл правила возврата.' }];
  const attempt = (result: 'pass' | 'fail', evidence: number[], extra: Partial<Trial> = {}): Trial => ({ ...cardAttempt('t', scenario, {}), events,
    observation: { state: 'missing', tools: 'complete' }, assessments: [{ metricId: 'e1', result, rationale: 'Оценка', evidence }], ...extra });
  assert.equal(recordedExpectationResult(attempt('pass', [2]), expectation), 'unknown', 'another tool\'s result proves nothing about this duty');
  assert.equal(recordedExpectationResult(attempt('fail', [2]), expectation), 'unknown');
  assert.equal(recordedExpectationResult(attempt('pass', [2, 4]), expectation), 'pass', 'the named tool\'s result among the cited ones decides');
  assert.equal(recordedExpectationResult(attempt('pass', [2]), { id: 'e1', observation: 'tool' }), 'pass', 'a card without the field: any tool\'s result, as before');
  assert.equal(recordedExpectationResult(attempt('fail', [5], { countingVersion: COUNTING_VERSION }), expectation), 'fail', 'edition 2: a failure stands on the complete log');
  assert.deepEqual(cardVerdict(cardRun([scenario], [attempt('pass', [2])]), scenario), { outcome: 'unknown', reason: 'no_evidence' });
  const input = judgeInput({ scenario, sources: observableSources(cardRun([scenario], []).sources, requirements), trial: attempt('pass', [4]) });
  assert.match(JSON.stringify(input.scenario), /"observation":"tool","tool":"kb_search"/, 'the judge reads which tool proves the duty');
});

test('a human verdict on an expectation overrides the judge; a quick «не могу сказать» leaves it; «ошибка теста» takes it out', () => {
  const scenario = compiledCard();
  const failed = cardAttempt('t', scenario, { e1: 'pass', e2: 'fail', e3: 'pass' });
  const verdict = (reviews: HumanReview[]) => cardVerdict(cardRun([scenario], [failed], 1, { humanReviews: reviews }), scenario);
  assert.deepEqual(verdict([]), { outcome: 'fail' });
  assert.deepEqual(verdict([review('t', 'e2', 'pass')]), { outcome: 'pass' });
  assert.deepEqual(verdict([review('t', 'e2', 'unknown', { source: 'quick', judgeVerdict: 'fail' })]), { outcome: 'fail' });
  assert.deepEqual(verdict([review('t', 'e2', 'unknown')]), { outcome: 'unknown', reason: 'human_unknown' });
  assert.deepEqual(verdict([review('t', 'e2', 'invalid')]), { outcome: 'unknown', reason: 'human_invalid' });
});

test('a one-key mark lands on the failed expectations, or on all of them for a pass, stamped with the card\'s rule', () => {
  const scenario = compiledCard();
  const failed = cardAttempt('t', scenario, { e1: 'fail', e2: 'pass', e3: 'fail' });
  assert.deepEqual(markTargets(scenario, failed), { verdict: 'fail', metricIds: ['e1', 'e3'] });
  assert.deepEqual(markTargets(scenario, cardAttempt('t', scenario, { e1: 'pass', e2: 'pass', e3: 'pass' })), { verdict: 'pass', metricIds: ['e1', 'e2', 'e3'] });
  assert.equal(markTargets(scenario, cardAttempt('t', scenario, { e1: 'pass', e2: 'unknown', e3: 'pass' })), undefined, 'nothing decided, nothing to agree with');
  assert.equal(countingRuleFor(scenario, failed), 'all-expectations-v1');
  assert.equal(headlineRule(scenario, [failed]).kind, 'expectations');
  const mark = (countingRules?: string) => review('t', 'e1', 'fail', { source: 'quick', judgeVerdict: 'fail', ...(countingRules ? { countingRules } : {}) });
  assert.equal(markUnderCurrentRule(scenario, failed, mark('all-expectations-v1'), ['e1', 'e3']), true);
  assert.equal(markUnderCurrentRule(scenario, failed, mark('goal-and-rules-v2'), ['e1', 'e3']), false, 'a mark under another rule answered another question');
  assert.equal(markUnderCurrentRule(scenario, failed, mark(), ['e1']), false);
});

test('the judge reads one expectation and the rules it cites: no success criteria, no other expectation', () => {
  const scenario = compiledCard();
  const trial = cardAttempt('t', scenario, {});
  const input = judgeInput({ scenario: { ...scenario, metrics: [scenario.metrics![1]!] }, sources: observableSources(cardRun([scenario], []).sources, requirements), trial });
  assert.deepEqual(input.scenario, { execution: { evaluation: 'expectations-v1', expectations: [briefCard().agentMust[1]], requirements: [requirements[0]] },
    metrics: [scenario.metrics![1]], user: scenario.user });
  assert.doesNotMatch(JSON.stringify(input), /receipt_rule|предложить возврат по выписке|successCriteria/, 'the other expectation and its rule are withheld');
  assert.deepEqual(simulatorChecks(scenario, { ...trial, events: [...trial.events, { seq: 3, type: 'user', text: 'Номер терминала: 9999' }] }), [],
    'every word of a compiled card\'s customer is harness text: no heuristics');
});

test('the result names the parts of every card and says which expectation failed', () => {
  const scenario = compiledCard();
  const view = buildResultView(cardRun([scenario], [cardAttempt('t', scenario, { e1: 'pass', e2: 'fail', e3: 'pass' })]));
  assert.deepEqual({ passed: view.headline.passed, decided: view.headline.decided }, { passed: 0, decided: 1 });
  assert.deepEqual(view.cards[0]!.parts.map(part => `${part.label}:${part.outcome}`), ['А:pass', 'Б:fail', 'В:pass']);
  assert.deepEqual([view.breakdown.goal.decided, view.breakdown.rules.decided], [0, 0], 'no goal and prompt-rule row for a card');
  assert.equal(view.countingRules, 'all-expectations-v1', 'the view names the rule its situations are counted by');
  const [failure] = view.failures;
  assert.ok(failure);
  assert.equal(failure.expected, 'Б — объяснить, как оформить возврат');
  assert.ok(failure.rules.some(rule => rule.quote.includes('Если номер терминала уже указан')), 'the owner rule of the failed expectation');
  assert.ok(!failure.rules.some(rule => rule.quote.includes('Без чека возврат')), 'not the rule of an expectation that passed');
});

test('the run plan states the judge\'s ceiling: two votes on every expectation of every attempt', () => {
  const card = briefCard();
  const two = compileCard({ ...card, id: `card_${'d'.repeat(64)}`, number: 4, agentMust: card.agentMust.slice(0, 2) }, { requirements });
  const record = cardRun([compiledCard(card), two], [], 2, { settings: { ...cardRun([], []).settings, repeats: 2, provider: 'openrouter', model: 'm' } });
  const plan = launchLines(record, scenarioPlan(record));
  assert.ok(plan.includes('Судья: по 2 голоса на каждое ожидание — до 6 вызовов на попытку, всего до 20.'), plan.join('\n'));
});

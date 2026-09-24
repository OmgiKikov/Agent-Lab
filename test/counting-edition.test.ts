import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { compileCard } from '../src/card/compile.js';
import { COUNTING_RULE_TEXT, COUNTING_VERSION, countingRuleOf, countingRuleText, headlineRule, recordedExpectationResult, type CountingRule } from '../src/card/expectations.js';
import { experimentSchema, trialSchema, type Trial } from '../src/contracts.js';
import { demoTarget } from '../src/demo.js';
import { draftHash } from '../src/lab/record.js';
import { countingRuleFor, markTargets } from '../src/outcomes.js';
import { buildResultView, exitCodeOf } from '../src/result-view.js';
import { deriveRun } from '../src/run.js';
import { dialogueFeed } from '../extensions/conversation.ts';
import { briefCard, cardAttempt, cardRun, compiledCard, requirements } from './helpers/cards.js';
import { libraryV1Run } from './helpers/library-v1.js';

/*
 * The counting rules have editions (card/expectations.ts). Edition 2 stops hiding the agent's failures: a usable
 * failure in any attempt fails the situation even when another attempt could not be measured, and a complete tool log
 * proves a missing call. Every attempt a run or a re-assessment records carries the edition, so a stored run is read
 * exactly as it was counted.
 */

/** An attempt as a run records it today. */
const current = (trial: Trial): Trial => ({ ...trial, countingVersion: COUNTING_VERSION });
/** An attempt of the agent whose connection failed: nothing was measured in it. */
const broken = (id: string, scenario: ReturnType<typeof compiledCard>, repeat: number): Trial =>
  ({ ...cardAttempt(id, scenario, {}, repeat), outcome: 'invalid', invalidCause: 'agent', reason: 'ответ испытуемого: HTTP 500', assessments: undefined });

test('a failure in one attempt fails the situation even when the other attempt broke; a stored run keeps it «не измерено»', () => {
  const scenario = compiledCard();
  const failed = cardAttempt('t0', scenario, { e1: 'fail', e2: 'pass', e3: 'pass' }, 0);
  const record = cardRun([scenario], [failed, broken('t1', scenario, 1)].map(current), 2);
  const view = buildResultView(record);
  assert.deepEqual([view.cards[0]!.outcome, view.cards[0]!.reason], ['fail', undefined]);
  assert.deepEqual(view.cards[0]!.parts.map(part => `${part.label}:${part.outcome}`), ['А:fail', 'Б:unknown', 'В:unknown'], 'a pass needs every attempt');
  assert.deepEqual([view.headline.passed, view.headline.decided], [0, 1]);
  assert.deepEqual(view.failures.map(failure => failure.trialId), ['t0'], 'the failure is in «Все ошибки»');
  assert.deepEqual(deriveRun(record).failedAttempts.map(trial => trial.id), ['t0']);
  assert.deepEqual(view.agreement.queueFailures, ['t0'], 'the judge\'s queue asks about exactly the failure the number counts');
  assert.equal(exitCodeOf(view), 1, 'an agent failure, not an incomplete measurement');
  assert.equal(view.countingRules, 'all-expectations-v2');
  // The same attempts as a run stored them before the edition: the result it was counted with.
  const stored = buildResultView(cardRun([scenario], [failed, broken('t1', scenario, 1)], 2));
  assert.deepEqual([stored.cards[0]!.outcome, stored.cards[0]!.reason, stored.headline.decided, stored.failures.length], ['unknown', 'agent_error', 0, 0]);
  assert.equal(stored.countingRules, 'all-expectations-v1');
});

test('usability still guards «справился»: a pass with a broken attempt is «не измерено» and is not asked about', () => {
  const scenario = compiledCard();
  const passed = cardAttempt('p0', scenario, { e1: 'pass', e2: 'pass', e3: 'pass' }, 0);
  const view = buildResultView(cardRun([scenario], [passed, broken('p1', scenario, 1)].map(current), 2));
  assert.deepEqual([view.cards[0]!.outcome, view.cards[0]!.reason], ['unknown', 'agent_error']);
  assert.deepEqual([view.agreement.queueFailures, view.agreement.sampledPasses], [[], []], 'an unmeasured situation is neither queued nor sampled');
  // A run stopped before the second attempt: the failure it saw still counts, a pass would not.
  const stopped = (trial: Trial) => buildResultView(cardRun([scenario], [current(trial)], 2, { phase: 'cancelled' })).cards[0]!;
  assert.equal(stopped(cardAttempt('t0', scenario, { e1: 'fail', e2: 'pass', e3: 'pass' }, 0)).outcome, 'fail');
  assert.deepEqual([stopped(passed).outcome, stopped(passed).reason], ['unknown', 'attempts_mismatch']);
});

test('a tool expectation fails on a complete log without the call; a partial log or a stored attempt leaves it «не измерено»', () => {
  const scenario = compileCard(briefCard({ agentMust: [{ id: 'e1', text: 'найти заказ в базе до ответа', requirementIds: ['refund_rule'], observation: 'tool' }] }), { requirements });
  const tool = { id: 'e1', observation: 'tool' } as const;
  const noCall = (extra: Partial<Trial> = {}): Trial => ({ ...cardAttempt('f', scenario, {}),
    events: [{ seq: 0, type: 'user', text: 'Где мой возврат?' }, { seq: 1, type: 'assistant', text: 'Возврат уже оформлен.' }],
    observation: { state: 'missing', tools: 'complete' }, assessments: [{ metricId: 'e1', result: 'fail', rationale: 'Агент ответил, не поискав заказ.', evidence: [1] }], ...extra });
  assert.equal(recordedExpectationResult(current(noCall()), tool), 'fail', 'a complete log holds every call, so the one it lacks was never made');
  assert.equal(recordedExpectationResult(current(noCall({ observation: { state: 'missing', tools: 'partial' } })), tool), 'unknown', 'a partial log proves no absence');
  assert.equal(recordedExpectationResult(noCall(), tool), 'unknown', 'a stored attempt keeps the reading it was counted with');
  const said = current(noCall({ assessments: [{ metricId: 'e1', result: 'pass', rationale: 'Агент сказал, что нашёл заказ.', evidence: [1] }] }));
  assert.equal(recordedExpectationResult(said, tool), 'unknown', 'the agent saying it acted is still not the action');
  const other = { ...scenario, id: 'card_other', familyId: 'card_other', title: 'Заказ найден' };
  const called = (trial: Trial): Trial => ({ ...trial, events: [{ seq: 0, type: 'user', text: 'Где мой возврат?' }, { seq: 1, type: 'tool_call', tool: 'lookup_order' },
    { seq: 2, type: 'tool_result', tool: 'lookup_order', result: { ok: true } }, { seq: 3, type: 'assistant', text: 'Нашёл заказ, возврат оформлен.' }],
    observation: { state: 'missing', tools: 'complete' }, assessments: [{ metricId: 'e1', result: 'pass', rationale: 'Заказ найден.', evidence: [2] }] });
  const handled = called(cardAttempt('p', other, {}));
  assert.equal(recordedExpectationResult(current(handled), tool), 'pass');
  // One situation handled, the other without the call: 50%, not «100% — 1 из 1».
  const view = buildResultView(cardRun([scenario, other], [current(noCall()), current(handled)]));
  assert.deepEqual([view.headline.passed, view.headline.decided, view.cards.map(card => card.outcome)], [1, 2, ['fail', 'pass']]);
  assert.deepEqual(view.failures.map(failure => failure.trialId), ['f']);
  assert.deepEqual(markTargets(scenario, current(noCall())), { verdict: 'fail', metricIds: ['e1'] }, 'the owner is asked about the failure the number counts');
  assert.equal(countingRuleFor(scenario, current(noCall())), 'all-expectations-v2');
  const partial = buildResultView(cardRun([scenario], [current(noCall({ observation: { state: 'missing', tools: 'partial' } }))]));
  assert.deepEqual([partial.cards[0]!.outcome, partial.cards[0]!.reason], ['unknown', 'no_evidence']);
  const stored = buildResultView(cardRun([scenario, other], [noCall(), handled]));
  assert.deepEqual([stored.headline.passed, stored.headline.decided, stored.cards.map(card => [card.outcome, card.reason ?? null])], [1, 1, [['unknown', 'no_evidence'], ['pass', null]]]);
});

test('the details of a conversation show an expectation as the result counts it, not the judge\'s raw word', () => {
  const scenario = compileCard(briefCard({ agentMust: [{ id: 'e1', text: 'найти заказ в базе до ответа', requirementIds: ['refund_rule'], observation: 'tool' }] }), { requirements });
  const trial = (result: 'pass' | 'fail'): Trial => current({ ...cardAttempt('t', scenario, {}),
    events: [{ seq: 0, type: 'user', text: 'Где мой возврат?' }, { seq: 1, type: 'assistant', text: 'Нашёл ваш заказ, возврат оформлен.' }],
    observation: { state: 'missing', tools: 'complete' }, assessments: [{ metricId: 'e1', result, rationale: 'Агент сообщил, что нашёл заказ.', evidence: [1] }] });
  const rows = (attempt: Trial) => dialogueFeed(cardRun([scenario], [attempt]), attempt).more!.map(row => row.text);
  const said = rows(trial('pass'));
  assert.ok(said.includes('найти заказ в базе до ответа: не измерено — нет подтверждения в журнале инструментов'), said.join('\n'));
  assert.ok(!said.some(text => text.startsWith('найти заказ в базе до ответа: справился')), 'the agent\'s words are not shown as a handled duty');
  assert.equal(buildResultView(cardRun([scenario], [trial('pass')])).cards[0]!.outcome, 'unknown', 'the same verdict the result counts');
  assert.ok(rows(trial('fail')).includes('найти заказ в базе до ответа: не справился'));
});

test('every counting rule has one line in the owner\'s words, and the edition of the attempts names the rule', () => {
  const rules: CountingRule[] = ['all-expectations-v1', 'all-expectations-v2', 'goal-and-rules-v2', 'goal-and-rules-v3', 'library-v1'];
  assert.deepEqual(Object.keys(COUNTING_RULE_TEXT).sort(), [...rules].sort());
  for (const text of Object.values(COUNTING_RULE_TEXT)) assert.doesNotMatch(text, /[A-Za-z_]|\n/, 'no ids, one line');
  for (const rule of rules) assert.equal(countingRuleText(rule), COUNTING_RULE_TEXT[rule]);
  assert.equal(countingRuleText('constructor'), undefined, 'only a rule a result can name has a line');
  const scenario = compiledCard();
  const attempt = cardAttempt('t', scenario, { e1: 'pass', e2: 'pass', e3: 'pass' });
  assert.equal(countingRuleOf(scenario, headlineRule(scenario, [current(attempt)])), 'all-expectations-v2');
  assert.equal(countingRuleOf(scenario, headlineRule(scenario, [attempt])), 'all-expectations-v1');
  assert.equal(countingRuleOf(scenario, headlineRule(scenario, [current(attempt), { ...attempt, repeat: 1 }])), 'all-expectations-v1', 'one older attempt keeps the card on the older rule');
  assert.equal(countingRuleOf(scenario, headlineRule(scenario, [])), 'all-expectations-v2', 'a situation not yet run waits for attempts of today\'s edition');
  assert.equal(trialSchema.safeParse({ ...attempt, countingVersion: 3 }).success, false, 'only a known edition is stored');
  // The result names the rules its situations were counted by: a situation the run never reached is counted by none.
  const unreached = { ...scenario, id: 'card_unreached', familyId: 'card_unreached', title: 'Не дошли' };
  assert.equal(buildResultView(cardRun([scenario, unreached], [attempt], 1, { phase: 'cancelled' })).countingRules, 'all-expectations-v1');
  assert.equal(buildResultView(cardRun([scenario, unreached], [current(attempt)], 1, { phase: 'cancelled' })).countingRules, 'all-expectations-v2');
  assert.equal(buildResultView(cardRun([scenario], [], 1, { phase: 'review' })).countingRules, 'all-expectations-v2', 'a draft names the rule it will be counted by');
});

test('stored runs of every older format keep the result they were counted with', async () => {
  const fixture = async (name: string) => experimentSchema.parse(JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')));
  const summary = (name: string, record: Awaited<ReturnType<typeof fixture>>) => {
    assert.ok(record.trials.every(trial => trial.countingVersion === undefined), `${name}: written before editions`);
    const view = buildResultView(record);
    return [view.countingRules, view.headline.passed, view.headline.decided, view.cards.map(card => [card.scenarioId, card.outcome, card.reason ?? null])];
  };
  // The values these runs showed before editions existed.
  assert.deepEqual(summary('library-v1', await fixture('library-v1/run.json')), ['library-v1', 0, 1, [['known_number', 'fail', null], ['late_number', 'unknown', 'judge_unclear']]]);
  assert.deepEqual(summary('legacy-demo', await fixture('legacy-demo-run.json')), ['goal-and-rules-v2', 0, 2, [['a_direct', 'fail', null], ['i_preference', 'fail', null]]]);
  assert.deepEqual(summary('recorded', await fixture('recorded-run.json')), ['goal-and-rules-v2', 0, 0, [['d0', 'unknown', 'attempts_mismatch'], ['d1', 'unknown', 'attempts_mismatch']]]);
});

test('a re-assessment and a repeat of a stored run are new results, counted by today\'s edition; the stored run keeps its own', async t => {
  const { lab, directory, record } = await libraryV1Run();
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  const reassessed = await lab.reassess(record.id); await lab.waitForIdle();
  const again = await lab.get(reassessed.id);
  assert.ok(again.trials.length && again.trials.every(trial => trial.countingVersion === COUNTING_VERSION));
  assert.equal(buildResultView(again).countingRules, 'all-expectations-v2');
  const source = await lab.get(record.id);
  assert.ok(source.trials.every(trial => trial.countingVersion === undefined), 'the stored run is never rewritten');
  assert.equal(buildResultView(source).countingRules, 'library-v1');
  const repeated = await lab.repeat(record.id);
  const draft = await lab.updateDraft(repeated.id, draftHash(repeated), { target: demoTarget(true) });
  await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const run = await lab.get(draft.id);
  assert.ok(run.trials.length && run.trials.every(trial => trial.countingVersion === COUNTING_VERSION));
  assert.equal(buildResultView(run).countingRules, 'all-expectations-v2');
});

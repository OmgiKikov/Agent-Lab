import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostGrant } from '../src/card/commands.js';
import type { LogJudgeRequest, LogJudgmentReceipt } from '../src/card/calibration.js';
import { acceptLibraryV2 } from '../src/card/library.js';
import { calibrationKey, logJudgeInputV1, logJudgmentComplete, logProtocolHash, logRubric, notExercised } from '../src/card/log-judge.js';
import { fingerprint, type CallContext, type Experiment, type JudgeAudit, type Runtime, type Scenario } from '../src/contracts.js';
import { Stopped } from '../src/errors.js';
import { draftHash, ExperimentLab } from '../src/experiment.js';
import { assessRepeated, hasCompleteJudgment, judgeInput, JUDGE_PROTOCOL, observableSources } from '../src/judge.js';
import { buildResultView } from '../src/result-view.js';
import { importBatch, libraryHash } from '../src/scenario-library.js';
import { cardDraft, cardNumbered } from './helpers/card-library.js';
import { cardInput, cardRuntime, dialogues } from './helpers/card-prep.js';
import { cardAttempt } from './helpers/cards.js';
import { logAnswer, refundReading, scriptedLogJudge, type LogVoteInput } from './helpers/calibration.js';
import { libraryV1Run, libraryV1Runtime } from './helpers/library-v1.js';

/*
 * C15: each expectation of a situation from a log is judged a second time, on the recorded conversation — its own
 * frozen input, its own protocol hash, its own receipt and sidecar, so neither judgment can stand in for the other.
 * What the log cannot show costs nothing, a key is paid for once, and a calibration the run cannot afford is
 * skipped whole while the synthetic result stands.
 */

const ctx = (audits: Map<string, JudgeAudit> = new Map()): CallContext => ({ signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {},
  onJudgment: (key, audit) => { audits.set(key, audit); } });

/** The draft of card-library.ts accepted as it is: card №1 «late», card №2 «known», compiled once. */
function accepted() {
  const draft = cardDraft();
  const { scenarios } = acceptLibraryV2(draft.library, libraryHash(draft.library), draft.library.cards.map(card => card.id), { evidence: draft.evidence, maxTurns: 3 });
  const scenarioOf = (number: number) => scenarios.find(item => item.id === cardNumbered(draft.library, number).id)!;
  return { ...draft, scenarios, scenarioOf };
}

/** The request of expectation `id` of card `number` on its logged conversation, as the calibration builds it. */
function requestFor(fixture: ReturnType<typeof accepted>, number: number, id: string, dialogue = fixture.batch.dialogues.find(item => item.id === (number === 1 ? 'late' : 'known'))!): LogJudgeRequest {
  const scenario = fixture.scenarioOf(number);
  const execution = scenario.execution as Extract<Scenario['execution'], { evaluation: string }>;
  const expectation = execution.evaluatorView.expectations.find(item => item.id === id)!;
  const key = calibrationKey({ definitionHash: fingerprint(scenario), expectationId: id, importContentHash: fixture.batch.contentHash, dialogueId: dialogue.id, protocolHash: logProtocolHash() });
  return { key, expectation, letter: id === 'e1' ? 'А' : 'Б', card: `карточки №${number}`, requirements: execution.evaluatorView.requirements,
    sources: observableSources(fixture.library.sources, fixture.library.requirements), importContentHash: fixture.batch.contentHash, dialogue };
}

test('the log judge reads the recorded conversation alone: no brief, no simulator, no stand state, and a rubric of its own', () => {
  const fixture = accepted();
  const data = logJudgeInputV1(requestFor(fixture, 1, 'e2'));
  assert.deepEqual(Object.keys(data).sort(), ['dialogue', 'evaluationScope', 'importContentHash', 'mode', 'scenario', 'sources']);
  assert.deepEqual(Object.keys(data.scenario).sort(), ['execution', 'metrics'], 'no customer brief: the log is the situation');
  assert.equal(data.mode, 'logged-v1');
  assert.equal(data.importContentHash, fixture.batch.contentHash);
  assert.deepEqual(data.dialogue.events.map(event => [event.seq, event.type]), [[0, 'user'], [1, 'assistant'], [2, 'user'], [3, 'assistant'], [4, 'user']], 'seq is the index in the import');
  const text = JSON.stringify(data);
  for (const absent of ['simulator', 'finalState', 'initialState', 'Получить инструкцию по возврату оплаты']) assert.equal(text.includes(absent), false, absent);
  assert.match(data.evaluationScope, /оба условия not_met/);
  assert.deepEqual(data.scenario.metrics, [logRubric(data.scenario.execution.expectations[0]!, 'Б', 'карточки №1')]);
  const rubric = data.scenario.metrics[0]!;
  assert.equal(rubric.passCriteria, 'Условие «клиент назвал номер терминала» возникло, и выполнено: объяснить, как оформить возврат.');
  assert.equal(rubric.failCriteria, 'Условие «клиент назвал номер терминала» возникло, но не выполнено: объяснить, как оформить возврат.');
  const synthetic = fixture.scenarioOf(1).metrics!.find(metric => metric.id === 'e2')!;
  assert.match(synthetic.passCriteria, /ожидание не нарушено/, 'the synthetic rubric forgives a path never taken');
  assert.doesNotMatch(rubric.passCriteria, /не нарушено/, 'the log rubric does not: a log that never got there is not measured');
  assert.equal(logRubric({ id: 'e1', text: 'не переспрашивать номер.', requirementIds: ['refund_rule'] }, 'А', 'карточки №2').passCriteria, 'Ожидание наступило, и выполнено: не переспрашивать номер.');

  const logged = fixture.batch.dialogues[0]!;
  const withTools = { ...logged, events: [...logged.events, { index: 5, type: 'tool' as const, content: 'lookup_record', data: {} }] };
  assert.deepEqual(logJudgeInputV1({ ...requestFor(fixture, 1, 'e2'), dialogue: withTools }).dialogue.events.map(event => event.type).includes('tool'), false, 'a partial log shows no tool events');
  assert.deepEqual(logJudgeInputV1({ ...requestFor(fixture, 1, 'e2'), dialogue: { ...withTools, observation: 'complete' } }).dialogue.events.at(-1), { seq: 5, type: 'tool', content: 'lookup_record' });
});

test('the log judge\'s input is frozen: version 1 renders exactly this, and any change is a new mode', () => {
  const expectation = { id: 'e2', text: 'объяснить, как оформить возврат.', requirementIds: ['refund_rule'], appliesWhen: 'клиент назвал номер терминала', observation: 'reply' as const };
  const cited = { id: 'refund_rule', sourceId: 'rules', text: 'Возврат объясняется.', quote: 'объясните, как оформить возврат', critical: true };
  const request: LogJudgeRequest = { key: 'a'.repeat(64), expectation, letter: 'Б', card: 'карточки №1', importContentHash: 'b'.repeat(64),
    requirements: [cited, { id: 'other_rule', sourceId: 'rules', text: 'Другое.', quote: 'другое правило', critical: false }],
    sources: [{ id: 'rules', name: 'Правила', content: 'объясните, как оформить возврат; другое правило', hash: 'h1', kind: 'knowledge' }, { id: 'prompt', name: 'Промпт', content: 'Наблюдаемые правила.', hash: 'h2', kind: 'prompt' }],
    dialogue: { observation: 'partial', events: [
      { index: 0, type: 'message', role: 'system', content: 'Служебное', data: {} }, { index: 1, type: 'message', role: 'user', content: 'Помогите с возвратом.', data: {} },
      { index: 2, type: 'message', role: 'assistant', content: 'Уточните номер терминала.', data: {} }, { index: 3, type: 'tool', content: 'lookup', data: {} },
      { index: 4, type: 'message', role: 'user', content: 'Номер терминала: 5678', data: {} }] } };
  assert.deepEqual(logJudgeInputV1(request), {
    mode: 'logged-v1', importContentHash: 'b'.repeat(64),
    scenario: { execution: { evaluation: 'expectations-v1', expectations: [expectation], requirements: [cited] },
      metrics: [{ id: 'e2', subject: 'agent', name: 'объяснить, как оформить возврат.', description: 'Ожидание Б карточки №1. Основание — требования refund_rule (см. requirements).',
        passCriteria: 'Условие «клиент назвал номер терминала» возникло, и выполнено: объяснить, как оформить возврат.',
        failCriteria: 'Условие «клиент назвал номер терминала» возникло, но не выполнено: объяснить, как оформить возврат.' }] },
    evaluationScope: 'Записанный разговор реального клиента с агентом прода: ни агент, ни клиент не запускались, реплики взяты из лога как есть. '
      + 'Оценивайте только записанное. Ожидание наступает в тот момент разговора, когда агент уже должен был его выполнить. '
      + 'Если разговор до этого момента не дошёл — клиент ушёл, разговор оборвался или перешёл к оператору, — оба условия not_met. '
      + 'Слова агента доказывают только то, что сказано; действия агента видны только в записанных событиях инструментов и состояния.',
    sources: [{ id: 'rules', name: 'Правила', content: 'объясните, как оформить возврат; другое правило', hash: fingerprint('объясните, как оформить возврат; другое правило') },
      { id: 'prompt', name: 'Промпт (промпт агента)', content: 'Наблюдаемые правила.', hash: fingerprint('Наблюдаемые правила.') }],
    dialogue: { observation: 'partial', events: [{ seq: 1, type: 'user', content: 'Помогите с возвратом.' }, { seq: 2, type: 'assistant', content: 'Уточните номер терминала.' },
      { seq: 4, type: 'user', content: 'Номер терминала: 5678' }] },
  });
});

test('the two judgments never meet: another input hash, another protocol hash, another place and another receipt', async () => {
  const fixture = accepted();
  const scenario = fixture.scenarioOf(2);
  const request = requestFor(fixture, 2, 'e1');
  const audits = new Map<string, JudgeAudit>();
  const judge = scriptedLogJudge(refundReading);
  const judgment = await judge.assess(request, ctx(audits));
  const audit = audits.get(request.key)!;
  assert.deepEqual([judgment.result, judgment.complete, judgment.votes.map(vote => vote.result)], ['fail', true, ['fail', 'fail']], 'the agent asked again for the number it had been given');
  assert.notEqual(logProtocolHash(), JUDGE_PROTOCOL);
  assert.notEqual(logProtocolHash('configuration'), fingerprint({ protocol: JUDGE_PROTOCOL, configuration: 'configuration' }));

  const record = { acceptedTests: fixture.scenarios.map(item => ({ testId: `t_${item.id.slice(5, 15)}`, scenarioId: item.id, definitionHash: fingerprint(item), acceptedAt: 'now' })) } as Pick<Experiment, 'acceptedTests'>;
  const receipt: LogJudgmentReceipt = { mode: 'logged-v1', key: request.key, cardId: scenario.id, expectationId: 'e1', definitionHash: fingerprint(scenario),
    importId: fixture.batch.id, importContentHash: fixture.batch.contentHash, dialogueId: 'known', ...judgment };
  assert.equal(logJudgmentComplete(receipt, record, { audit }), true);
  assert.equal(logJudgmentComplete({ ...receipt, result: 'pass' }, record), false, 'votes that do not give the result');
  assert.equal(logJudgmentComplete({ ...receipt, dialogueId: 'late' }, record), false, 'a key that is not its own');
  assert.equal(logJudgmentComplete(receipt, { acceptedTests: [] }), false, 'a definition this run did not accept');
  assert.equal(logJudgmentComplete(receipt, record, { audit: null }), false, 'the sidecar it seals is gone');
  assert.equal(logJudgmentComplete(receipt, record, { audit: { ...audit, input: audit.input.replace('Уточните', 'Назовите') } }), false, 'an audit changed after sealing');

  // A synthetic attempt of the same card, judged by the synthetic protocol.
  const trial = cardAttempt('attempt_1', scenario, {});
  delete trial.assessments;
  const sources = observableSources(fixture.library.sources, fixture.library.requirements);
  const synthetic = new Map<string, JudgeAudit>();
  trial.assessments = await assessRepeated({ scenario, sources, trial }, { provider: 'fixture', id: 'judge' }, { ...ctx(synthetic), onJudgment: (id, item) => { synthetic.set(id, item); } },
    async (_prompt, input) => logAnswer({ scenario: JSON.parse(input).scenario, dialogue: { observation: 'partial', events: [{ seq: 1, type: 'assistant', content: 'Уточните номер терминала.' }] } } as LogVoteInput, 'fail'));
  trial.judgeAudit = synthetic.get(trial.id)!;
  assert.equal(hasCompleteJudgment({ scenario, sources, trial }), true, 'the synthetic judgment stands on its own');
  assert.notEqual(fingerprint(judgeInput({ scenario: { ...scenario, metrics: scenario.metrics!.slice(0, 1) }, sources, trial })), receipt.inputHash);
  assert.equal(hasCompleteJudgment({ scenario, sources, trial: { ...trial, judgeAudit: audit } }), false, 'the log audit never passes as an attempt\'s judgment');
  const { judgeAudit: _full, ...withoutAudit } = trial;
  const sealed = { ...withoutAudit, judgeReceipt: { protocolHash: audit.protocolHash, inputHash: audit.inputHash, provider: 'fixture', model: 'log-judge', auditHash: fingerprint(audit),
    votes: judgment.votes.map(vote => ({ metricId: 'e1', ...(vote.result ? { result: vote.result } : {}) })), notApplicable: [], complete: true } };
  assert.equal(hasCompleteJudgment({ scenario, sources, trial: sealed }), false, 'nor does its receipt');
  assert.equal(logJudgmentComplete(synthetic.get(trial.id), record), false, 'and the attempt\'s judgment never closes a key of the log');
  assert.equal(logJudgmentComplete({ ...sealed.judgeReceipt, mode: 'logged-v1', key: request.key }, record), false);
});

test('both votes find the conversation never got there: the log does not measure it; a malformed vote is asked once more', async () => {
  const fixture = accepted();
  const late = importBatch(dialogues.map(item => item.id === 'late' ? { ...item, messages: item.messages.slice(0, 3) } : item)).dialogues.find(item => item.id === 'late')!;
  const cut = await scriptedLogJudge(refundReading).assess(requestFor(fixture, 1, 'e2', late), ctx());
  assert.deepEqual([cut.result, cut.complete, notExercised(cut.votes)], ['unknown', true, true], 'the log ended when the customer named the number: not_met / not_met');
  const split = await scriptedLogJudge((_data, vote) => vote ? 'fail' : 'pass').assess(requestFor(fixture, 1, 'e1'), ctx());
  assert.deepEqual([split.result, split.complete, notExercised(split.votes)], ['unknown', true, false], 'two votes that disagree are a split, not a log that stopped early');

  const calls = { count: 0 };
  const once = await scriptedLogJudge((data, vote) => vote === 0 ? 'malformed' : refundReading(data), calls).assess(requestFor(fixture, 2, 'e1'), ctx());
  assert.deepEqual([once.result, once.complete, once.votes.map(vote => vote.error ? 'error' : vote.result), calls.count], ['fail', true, ['error', 'fail', 'fail'], 3],
    'the malformed answer stays on record and is asked once more');
  const broken = await scriptedLogJudge(() => 'malformed').assess(requestFor(fixture, 2, 'e1'), ctx());
  assert.deepEqual([broken.result, broken.complete, broken.votes.length], ['unknown', false, 4], 'asked once more per vote, and no more');
});

async function withLab(runtime: Runtime, work: (lab: ExperimentLab) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-calibration-'));
  const lab = new ExperimentLab(directory, runtime);
  try { await lab.init(); await work(lab); } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
}

/** A card run of card-prep.ts accepted and started; the draft may first be changed by `before`. */
async function finishedRun(lab: ExperimentLab, input = cardInput(), before?: (id: string) => Promise<void>): Promise<Experiment> {
  const draft = await lab.create(input, { cards: true });
  await lab.waitForIdle();
  await before?.(draft.id);
  const { library } = await lab.readCards(draft.id);
  const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
  await lab.start(draft.id, { approved: true, expectedHash: draftHash(accepted.experiment), requireAccepted: true });
  await lab.waitForIdle();
  return lab.get(draft.id);
}

test('a run calibrates its situations from logs: two votes per expectation, receipts and sidecars; a repeat and a reassessment pay nothing', async () => {
  const calls = { count: 0 };
  await withLab({ ...cardRuntime(), logJudge: scriptedLogJudge(refundReading, calls) }, async lab => {
    const run = await finishedRun(lab, cardInput(), async id => {
      const importId = (await lab.get(id)).originalImport!.id;
      const prepared = await lab.prepareLogVersion({ kind: 'declare_log_version', importId, version: 'demo-baseline-v1' }, { via: 'pi-confirm' });
      await lab.applyLogVersion(prepared, hostGrant(prepared, 'confirmed'));
    });
    assert.equal(run.phase, 'results_review', run.error ?? '');
    const calibration = run.calibration!;
    assert.deepEqual([calibration.protocol, calibration.testedVersion, calibration.logVersions.map(row => [row.importId, row.version]), calibration.unfinished],
      ['sim-to-real-v1', 'demo-baseline-v1', [[run.originalImport!.id, 'demo-baseline-v1']], undefined]);
    assert.deepEqual(calibration.entries.map(entry => [entry.dialogueId, entry.expectationId, entry.result, entry.complete]),
      [['late', 'e1', 'pass', true], ['late', 'e2', 'pass', true], ['known', 'e1', 'fail', true], ['known', 'e2', 'fail', true]]);
    assert.equal(calls.count, 8, 'two votes per expectation; no agent, no simulator');
    for (const entry of calibration.entries) assert.equal(logJudgmentComplete(entry, run, { audit: await lab.store.readCalibrationAudit(run.id, entry.key) }), true, entry.key);
    assert.deepEqual([buildResultView(run).headline.passed, buildResultView(run).headline.decided], [1, 2], 'the number is the synthetic one, as always');

    const later = await lab.prepareLogVersion({ kind: 'declare_log_version', importId: run.originalImport!.id, version: 'agent-v8' }, { via: 'pi-confirm' });
    await lab.applyLogVersion(later, hostGrant(later, 'confirmed'));
    assert.deepEqual((await lab.get(run.id)).calibration!.logVersions.map(row => row.version), ['demo-baseline-v1'], 'a finished run keeps the declaration it used');

    const repeat = await lab.repeat(run.id);
    assert.equal(repeat.calibration, undefined, 'a draft starts without the calibration of its source');
    await lab.start(repeat.id, { approved: true, expectedHash: draftHash(repeat) });
    await lab.waitForIdle();
    const repeated = await lab.get(repeat.id);
    assert.equal(calls.count, 8, 'the same cards, logs and judge: every key reused');
    assert.deepEqual(repeated.calibration!.entries, calibration.entries);
    assert.deepEqual(repeated.calibration!.logVersions.map(row => row.version), ['agent-v8'], 'the repeat snapshots the declaration of its own time');
    for (const entry of repeated.calibration!.entries) assert.equal(logJudgmentComplete(entry, repeated, { audit: await lab.store.readCalibrationAudit(repeated.id, entry.key) }), true, 'its sidecar was copied');

    const reassessed = await lab.reassess(run.id);
    await lab.waitForIdle();
    assert.equal((await lab.get(reassessed.id)).calibration!.entries.length, 4);
    assert.equal(calls.count, 8, 'a reassessment with the same judge reuses them too');
  });
});

test('what the log cannot show costs nothing: an unanswered customer is skipped without a call', async () => {
  const calls = { count: 0 };
  const silent = dialogues.map(item => item.id === 'known' ? { ...item, messages: item.messages.slice(0, 1) } : item);
  await withLab({ ...cardRuntime(), logJudge: scriptedLogJudge(refundReading, calls) }, async lab => {
    const run = await finishedRun(lab, cardInput({ dialogues: silent }));
    assert.equal(run.phase, 'results_review', run.error ?? '');
    assert.deepEqual(run.calibration!.entries.map(entry => [entry.dialogueId, entry.expectationId, entry.skipped ?? entry.result, entry.votes.length]),
      [['late', 'e1', 'pass', 2], ['late', 'e2', 'pass', 2], ['known', 'e1', 'no_agent_reply', 0], ['known', 'e2', 'no_agent_reply', 0]]);
    assert.equal(calls.count, 4, 'only the answered conversation was judged');
  });
});

test('a calibration the run\'s limit cannot cover is skipped whole with the reason; the synthetic result is complete', async () => {
  const calls = { count: 0 };
  await withLab({ ...cardRuntime(), logJudge: scriptedLogJudge(refundReading, calls) }, async lab => {
    const run = await finishedRun(lab, cardInput(), async id => { await lab.updateDraft(id, draftHash(await lab.get(id)), { settings: { maxCalls: 10 } }); });
    assert.equal(run.phase, 'results_review', run.error ?? '');
    assert.deepEqual([run.calibration!.unfinished, run.calibration!.entries.length, calls.count], ['budget', 0, 0], '8 judge calls do not fit in the 5 left: none is made');
    assert.deepEqual([buildResultView(run).headline.passed, buildResultView(run).headline.decided], [1, 2]);
  });
});

test('whatever stops the calibration, the run keeps its result: a stop, or a judge that breaks', async () => {
  const stopping = { ...scriptedLogJudge(refundReading), assess: async () => { throw new Stopped('time', 'Experiment time limit reached.'); } };
  const breaking = { ...scriptedLogJudge(refundReading), assess: async () => { throw new Error('провайдер сломался'); } };
  for (const [logJudge, reason] of [[stopping, 'stopped'], [breaking, 'stopped']] as const) {
    await withLab({ ...cardRuntime(), logJudge }, async lab => {
      const run = await finishedRun(lab);
      assert.equal(run.phase, 'results_review', run.error ?? '');
      assert.deepEqual([run.calibration!.unfinished, run.calibration!.entries.length], [reason, 0]);
      assert.deepEqual([buildResultView(run).headline.passed, buildResultView(run).headline.decided], [1, 2]);
    });
  }
  await withLab({ ...cardRuntime(), logJudge: scriptedLogJudge(refundReading) }, async lab => {
    const run = await finishedRun(lab, cardInput({ settings: { ...cardInput().settings, calibration: 'off' } }));
    assert.equal(run.calibration, undefined, 'the owner turned it off');
  });
});

test('a first-format run is calibrated through its projection when it is judged again; an edited situation is left out', async () => {
  const calls = { count: 0 };
  const runtime = { ...libraryV1Runtime(), logJudge: scriptedLogJudge(refundReading, calls) };
  const { lab, directory, record } = await libraryV1Run(runtime);
  try {
    const reassessed = await lab.reassess(record.id);
    await lab.waitForIdle();
    const run = await lab.get(reassessed.id);
    assert.equal(run.phase, 'results_review', run.error ?? '');
    assert.deepEqual(run.calibration!.entries.map(entry => [entry.cardId, entry.expectationId, entry.dialogueId, entry.result]),
      [['known_number', 'ask_once', 'known', 'fail'], ['known_number', 'refund_explanation', 'known', 'fail']], 'late_number was edited by its owner: not the situation of its log');
    assert.equal(calls.count, 4);
    const audit = await lab.store.readCalibrationAudit(run.id, run.calibration!.entries[0]!.key);
    assert.match(JSON.parse(audit!.input).scenario.metrics[0].description, new RegExp(`ситуации «${run.scenarios[0]!.title}»`), 'named as its synthetic rubric names it');

    // Had the log said the agent kept duty А: the disagreement reads the variant's program and its account of the log.
    const flipped = structuredClone(run);
    const first = flipped.calibration!.entries[0]!;
    first.votes = first.votes.map(() => ({ pass: 'met' as const, fail: 'not_met' as const, result: 'pass' as const }));
    first.result = 'pass';
    const [disagreement] = buildResultView(flipped).calibration!.disagreements;
    assert.deepEqual([disagreement!.number, disagreement!.expectations.map(row => `${row.letter} ${row.synthetic}→${row.log}`), disagreement!.log.number], [1, ['А fail→pass'], 1],
      'numbered by its place in the run; its dialogue by its place in the import the old library carries');
    assert.deepEqual(disagreement!.path, { synthetic: ['ушёл'], log: [], same: true }, 'the customer only left in both');
    assert.equal(disagreement!.hint, 'Клиент тот же — вероятно, изменился агент (версии различаются или неизвестны).', 'no version was declared: only a comparison');
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('the key follows the definition, the expectation, the import, the dialogue and the judge — and nothing else', () => {
  const parts = { definitionHash: 'a'.repeat(64), expectationId: 'e1', importContentHash: 'b'.repeat(64), dialogueId: 'late', protocolHash: logProtocolHash() };
  const key = calibrationKey(parts);
  for (const change of [{ definitionHash: 'c'.repeat(64) }, { expectationId: 'e2' }, { importContentHash: 'c'.repeat(64) }, { dialogueId: 'known' }, { protocolHash: logProtocolHash('other') }]) {
    assert.notEqual(calibrationKey({ ...parts, ...change }), key, JSON.stringify(change));
  }
  assert.equal(calibrationKey({ ...parts }), key);
});

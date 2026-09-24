import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessRepeated, hasCompleteJudgment, judgeInput, observableSources, scenarioSources, sealJudgeReceipt, JUDGE_PROTOCOL } from '../src/judge.js';
import { emptyUsage, fingerprint, type Requirement, type Scenario, type Source, type Trial } from '../src/contracts.js';
import { goalAttainment, RAG_METRIC_IDS, RAG_RUBRICS, ragEvidenceComplete, replyQuality, simulatorFidelity, validateAssessments, type JudgeAudit } from '../src/assessment.js';
import { ExperimentStore } from '../src/store.js';

const scenario: Scenario = { id: 'card', familyId: 'family', title: 'A fixed input', split: 'dev', provenance: 'synthetic', tier: 'regression', requirementIds: [],
  user: { goal: 'Receive an instruction', facts: 'Known facts', behavior: 'Stop after the instruction', opening: 'Help', maxFollowUps: 0 },
  checks: [], initialState: { records: {}, writableFields: [], transientFailures: 0 },
  metrics: [{ id: 'goal', name: 'Goal', subject: 'agent', description: 'Original task', passCriteria: 'Instruction supplied', failCriteria: 'A refusal is supplied' }, simulatorFidelity] };
const trial: Trial = { id: 'trial', revisionId: 'revision', scenarioId: 'card', familyId: 'family', repeat: 0, split: 'dev', userMode: 'static', manifestHash: 'manifest',
  outcome: 'ungraded', reason: 'PRIOR_VERDICT_SECRET', checks: [], events: [{ seq: 0, type: 'user', text: 'Help' }, { seq: 1, type: 'assistant', text: 'Do this.' }],
  initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 1 };
const input = { scenario, sources: [], trial };
const model = { provider: 'offline', id: 'test' };
const row = (passCondition: string, failCondition: string, evidence = [1]) => JSON.stringify({ assessments: [{ metricId: 'goal', passCondition, failCondition, rationale: 'Explicit evidence for both conditions.', evidence, citations: evidence.map(seq => ({ seq, quote: 'Do this.' })) }] });

test('retrieval citations accept exact decoded paragraphs but cannot invent text or join different chunks', () => {
  const content = 'Шаг 1.\nНажмите «Отозвать».\nВыберите причину.';
  const events = [{ seq: 1, type: 'retrieval' as const, result: { chunks: [{ source: 'article', content }, { source: 'other', content: 'Другой фрагмент.' }], complete: true } }];
  const metric = RAG_RUBRICS[0];
  const assessment = (quote: string) => [{ metricId: metric.id, result: 'fail', rationale: 'Exact text', evidence: [1], citations: [{ seq: 1, quote }] }];
  assert.equal(validateAssessments([metric], events, assessment(content))[0]!.result, 'fail');
  assert.throws(() => validateAssessments([metric], events, assessment('Нажмите «Отозвать». Выберите причину.')), /verbatim/);
  assert.throws(() => validateAssessments([metric], events, assessment('Выберите причину.\nДругой фрагмент.')), /verbatim/);
});

test('search-only evidence supports retrieval diagnostics but never proves the answering model context', async () => {
  const targetTrial = structuredClone(trial);
  targetTrial.events.splice(1, 0, { seq: 2, type: 'retrieval', result: { chunks: [{ source: 'kb', content: 'Do this.' }], complete: true, stage: 'retrieved' } });
  const judged = { scenario: { ...scenario, metrics: [] }, sources: [{ id: 'kb', name: 'Article', content: 'Do this.', hash: 'h' }], trial: targetTrial };
  const calls: string[] = []; let audit: JudgeAudit | undefined;
  const assessments = await assessRepeated(judged, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, value) { audit = value; } },
    async (_prompt, data) => {
      const parsed = JSON.parse(data), metricId = parsed.scenario.metrics[0].id;
      calls.push(metricId); assert.match(data, /retrieved/);
      return JSON.stringify({ assessments: [{ metricId, passCondition: 'met', failCondition: 'not_met', rationale: 'Search returned the applicable text.',
        evidence: [0, 2], citations: [{ seq: 0, quote: 'Help' }, { seq: 2, quote: 'Do this.' }] }] });
    });
  assert.equal(calls.length, 4);
  assert.ok(!calls.includes('rag_context_faithfulness'));
  assert.equal(assessments.find(a => a.metricId === 'rag_context_faithfulness')!.result, 'unknown');
  assert.equal(ragEvidenceComplete(targetTrial), false);
  assert.equal(ragEvidenceComplete(targetTrial, 'retrieval'), true);
  assert.equal(hasCompleteJudgment({ ...judged, trial: { ...targetTrial, assessments, judgeAudit: audit } }), true);
});

test('RAG judgment uses per-reply evidence, leaves missing context unknown and preserves business results on diagnostic errors', async () => {
  for (const mode of ['complete', 'empty', 'partial', 'no_owner_knowledge', 'no_retrieval_quote', 'diagnostic_error'] as const) {
    const targetTrial = structuredClone(trial);
    targetTrial.events.splice(1, 0, { seq: 2, type: 'retrieval', result: {
      chunks: mode === 'empty' ? [] : [{ source: 'kb#instruction', content: 'Do this.' }], complete: mode !== 'partial',
    } });
    const judged = { ...input, trial: targetTrial, sources: mode === 'no_owner_knowledge' ? [] : [{ id: 'kb', name: 'Knowledge', content: 'Do this.', hash: 'h' }] };
    let calls = 0, audit: JudgeAudit | undefined;
    const assessments = await assessRepeated(judged, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, value) { audit = value; } },
      async (_prompt, data) => {
        calls++;
        const metricId = JSON.parse(data).scenario.metrics[0].id as string;
        if (!RAG_METRIC_IDS.has(metricId)) return row('met', 'not_met');
        if (mode === 'diagnostic_error') throw new Error('Diagnostic budget exhausted');
        const citations = [metricId === 'rag_context_faithfulness' ? { seq: 1, quote: 'Do this.' } : { seq: 0, quote: 'Help' },
          ...(mode === 'no_retrieval_quote' ? [] : [{ seq: 2, quote: '"chunks":' }])];
        return JSON.stringify({ assessments: [{ metricId, passCondition: mode === 'empty' ? 'not_met' : 'met', failCondition: mode === 'empty' ? 'met' : 'not_met', rationale: 'Cited evidence.', evidence: citations.map(c => c.seq), citations }] });
      });
    assert.equal(assessments.find(a => a.metricId === 'goal')!.result, 'pass');
    const diagnostics = assessments.filter(a => RAG_METRIC_IDS.has(a.metricId));
    assert.equal(diagnostics.length, 3);
    assert.equal(calls, mode === 'partial' ? 2 : 8);
    if (['partial', 'diagnostic_error', 'no_retrieval_quote'].includes(mode)) assert.ok(diagnostics.every(a => a.result === 'unknown'));
    if (mode === 'no_owner_knowledge') assert.equal(diagnostics.find(a => a.metricId === 'rag_context_recall')!.result, 'unknown');
    if (mode === 'complete' || mode === 'empty') {
      assert.ok(diagnostics.every(a => a.result === (mode === 'empty' ? 'fail' : 'pass')), 'this fake judge tests evidence plumbing, not model quality');
      assert.equal(hasCompleteJudgment({ ...judged, trial: { ...targetTrial, assessments, judgeAudit: audit } }), true);
    }
    assert.equal(ragEvidenceComplete(targetTrial), mode !== 'partial');
    targetTrial.events.push({ seq: 3, type: 'user', text: 'Another question' }, { seq: 4, type: 'assistant', text: 'Another answer' });
    assert.equal(ragEvidenceComplete(targetTrial), false, 'an earlier retrieval cannot justify a later answer');
  }
});

test('each RAG vote excludes reference leaks through sources, expected answers, user plans, fixtures and hidden trace events', async () => {
  const secret = 'OWNER_ONLY_EXPECTED_ANSWER';
  const targetTrial = structuredClone(trial);
  targetTrial.events.splice(1, 0,
    { seq: 2, type: 'retrieval', result: { chunks: [{ source: 'actual', content: 'Unrelated article.' }], complete: true } },
    { seq: 3, type: 'tool_result', tool: 'hidden-fixture', result: { secret } });
  const hiddenScenario = { ...scenario, successCriteria: secret,
    user: { ...scenario.user, goal: secret, facts: secret, answers: [{ ifAsked: 'When?', reply: secret }] },
    initialState: { ...scenario.initialState, records: { record: { secret } } },
    checks: [{ kind: 'answer_contains' as const, id: 'secret', description: secret, value: secret }] };
  const judged = { scenario: hiddenScenario, trial: { ...targetTrial, initialState: hiddenScenario.initialState, finalState: hiddenScenario.initialState },
    sources: [{ id: 'reference', name: 'Reference', content: secret, hash: 'old' }] };
  const seen = new Map<string, string>();
  let audit: JudgeAudit | undefined;
  const assessments = await assessRepeated(judged, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, a) { audit = a; } },
    async (_prompt, data) => {
      const value = JSON.parse(data), metricId = value.scenario.metrics[0].id;
      seen.set(metricId, data);
      if (!RAG_METRIC_IDS.has(metricId)) return row('met', 'not_met');
      const faithfulness = metricId === 'rag_context_faithfulness';
      const citations = [faithfulness ? { seq: 1, quote: 'Do this.' } : { seq: 0, quote: 'Help' }, { seq: 2, quote: 'Unrelated article.' }];
      return JSON.stringify({ assessments: [{ metricId, passCondition: faithfulness && !data.includes(secret) ? 'not_met' : 'met',
        failCondition: faithfulness && !data.includes(secret) ? 'met' : 'not_met', rationale: 'Deterministic boundary probe, not a semantic judge.', evidence: citations.map(c => c.seq), citations }] });
    });
  assert.match(seen.get('goal')!, new RegExp(secret));
  assert.match(seen.get('rag_context_recall')!, new RegExp(secret));
  for (const id of ['rag_context_faithfulness', 'rag_context_relevance']) {
    assert.doesNotMatch(seen.get(id)!, new RegExp(secret));
    const request = JSON.parse(seen.get(id)!);
    assert.deepEqual(request.sources, []);
    assert.deepEqual(Object.keys(request.scenario), ['metrics']);
    assert.deepEqual(request.replyContexts, [{ userSeqs: [0], retrievalSeq: 2, answerSeq: 1 }]);
  }
  for (const id of ['rag_context_relevance', 'rag_context_recall']) assert.doesNotMatch(seen.get(id)!, /Do this\./, 'the target answer cannot bias retrieval grading');
  assert.equal(assessments.find(a => a.metricId === 'rag_context_faithfulness')!.result, 'fail');
  assert.equal(hasCompleteJudgment({ ...judged, trial: { ...judged.trial, assessments, judgeAudit: audit } }), true);
  const forged = structuredClone(audit!);
  forged.attempts.find(a => a.metricId === 'rag_context_faithfulness')!.input = seen.get('goal');
  assert.equal(hasCompleteJudgment({ ...judged, trial: { ...judged.trial, assessments, judgeAudit: forged } }), false);
  const poisonedMetric = { ...RAG_RUBRICS[2], description: secret, passCriteria: secret };
  assert.doesNotMatch(JSON.stringify(judgeInput({ ...judged, scenario: { ...hiddenScenario, metrics: [poisonedMetric] } })), new RegExp(secret));
});

test('faithfulness cannot pass by citing only a later answer or using a later context for an earlier answer', async () => {
  const events: Trial['events'] = [
    { seq: 0, type: 'user', text: 'First question' },
    { seq: 1, type: 'retrieval', result: { chunks: [{ source: 'first', content: 'First fact.' }], complete: true } },
    { seq: 2, type: 'assistant', text: 'First fact.' },
    { seq: 3, type: 'user', text: 'Second question' },
    { seq: 4, type: 'retrieval', result: { chunks: [{ source: 'second', content: 'Second fact.' }], complete: true } },
    { seq: 5, type: 'assistant', text: 'Second fact.' },
  ];
  for (const [evidence, expected] of [[[2, 4], 'unknown'], [[4, 5], 'unknown'], [[1, 2, 4, 5], 'pass']] as const) {
    const targetTrial = { ...trial, events };
    const assessments = await assessRepeated({ scenario: { ...scenario, metrics: [] }, trial: targetTrial, sources: [] }, model,
      { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, async (_prompt, raw) => {
        const data = JSON.parse(raw), metricId = data.scenario.metrics[0].id;
        const faithfulness = metricId === 'rag_context_faithfulness';
        const selected = faithfulness ? evidence : [0, 1];
        return JSON.stringify({ assessments: [{ metricId, passCondition: faithfulness ? 'met' : 'unclear', failCondition: faithfulness ? 'not_met' : 'unclear',
          rationale: 'Deterministic citation binding probe.', evidence: selected, citations: selected.map(seq => ({ seq,
            quote: seq === 0 ? 'First question' : seq === 1 || seq === 2 ? 'First fact.' : 'Second fact.' })) }] });
      });
    assert.equal(assessments.find(a => a.metricId === 'rag_context_faithfulness')!.result, expected);
  }
  assert.equal(ragEvidenceComplete({ events: [...events, { seq: 6, type: 'assistant', text: 'Another reply without its own context' }] }), false);
});

test('all 16 supported replies can carry their own context citations without exceeding the judgment schema', async () => {
  const events: Trial['events'] = Array.from({ length: 16 }, (_, index) => [
    { seq: index * 3, type: 'user' as const, text: 'Question' },
    { seq: index * 3 + 1, type: 'retrieval' as const, result: { chunks: [{ source: 'kb', content: 'Supported fact.' }], complete: true } },
    { seq: index * 3 + 2, type: 'assistant' as const, text: 'Supported fact.' },
  ]).flat();
  const judgments = await assessRepeated({ ...input, scenario: { ...scenario, metrics: [] }, trial: { ...trial, events } }, model,
    { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, async (_prompt, raw) => {
      const metricId = JSON.parse(raw).scenario.metrics[0].id;
      const evidence = events.filter(event => event.type === 'retrieval' || event.type === (metricId === 'rag_context_faithfulness' ? 'assistant' : 'user'));
      return JSON.stringify({ assessments: [{ metricId, passCondition: 'met', failCondition: 'not_met', rationale: 'Evidence boundary probe.',
        evidence: evidence.map(event => event.seq), citations: evidence.map(event => ({ seq: event.seq, quote: event.type === 'user' ? 'Question' : 'Supported fact.' })) }] });
    });
  assert.equal(judgments.find(row => row.metricId === 'rag_context_faithfulness')!.result, 'pass');
  assert.equal(judgments.find(row => row.metricId === 'rag_context_faithfulness')!.evidence.length, 32);
});

test('RAG votes cannot cite withheld tool results even when that quote exists in the original trace', async () => {
  const targetTrial = { ...trial, events: [trial.events[0]!,
    { seq: 2, type: 'retrieval' as const, result: { chunks: [], complete: true } },
    { seq: 3, type: 'tool_result' as const, tool: 'private', result: 'HIDDEN_TOOL_FACT' }, trial.events[1]!] };
  let audit: JudgeAudit | undefined;
  const assessments = await assessRepeated({ ...input, scenario: { ...scenario, metrics: [] }, trial: targetTrial }, model,
    { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, a) { audit = a; } },
    async (_prompt, data) => JSON.stringify({ assessments: [{ metricId: JSON.parse(data).scenario.metrics[0].id, passCondition: 'met', failCondition: 'not_met',
      rationale: 'Forged evidence.', evidence: [2, 3], citations: [{ seq: 2, quote: '"chunks":' }, { seq: 3, quote: 'HIDDEN_TOOL_FACT' }] }] }));
  assert.ok(assessments.every(a => a.result === 'unknown'));
  assert.ok(audit!.attempts.every(a => a.error?.includes('withheld')));
});

test('judgment retains raw independent votes, rejects conflicting criteria, and never treats nonreactive fidelity as a pass', async () => {
  for (const [outputs, expected] of [
    [[row('met', 'not_met'), row('met', 'not_met')], 'pass'],
    [[row('not_met', 'met'), row('not_met', 'met')], 'fail'],
    [[row('met', 'met'), row('met', 'met')], 'unknown'],
    [[row('not_met', 'not_met'), row('not_met', 'not_met')], 'unknown'],
    [[row('met', 'not_met'), row('not_met', 'met')], 'unknown'],
  ] as const) {
    let audit: JudgeAudit | undefined;
    const requests: string[] = [];
    const original = structuredClone(input);
    const result = await assessRepeated(input, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, a) { audit = a; } },
      async (prompt, data) => { assert.doesNotMatch(data, /PRIOR_VERDICT_SECRET/); requests.push(prompt + data); return outputs[requests.length - 1]!; });
    assert.equal(result[0]!.result, expected);
    assert.equal(result[1]!.result, 'unknown'); assert.match(result[1]!.rationale, /Не применяется/);
    assert.equal(requests[0], requests[1]); assert.equal(audit!.protocolHash, JUDGE_PROTOCOL);
    assert.deepEqual(audit!.attempts.map(a => a.raw), outputs);
    assert.deepEqual(audit!.notApplicable, ['user_fidelity']); assert.deepEqual(input, original);
    const recorded = { ...input, trial: { ...trial, assessments: result, judgeAudit: audit } };
    assert.equal(hasCompleteJudgment(recorded), true);
    assert.equal(hasCompleteJudgment({ ...recorded, scenario: { ...scenario, goalObservation: 'reply' } }), false,
      'changing the owner-selected evidence channel invalidates the prior input fingerprint');
    recorded.trial.judgeAudit = structuredClone(audit);
    recorded.trial.judgeAudit!.attempts[0]!.raw = 'not the saved model response';
    assert.equal(hasCompleteJudgment(recorded), false, 'cached verdicts cannot replace the original model output');
    recorded.trial.judgeAudit = structuredClone(audit);
    recorded.trial.judgeAudit!.attempts[0]!.assessments![0]!.evidence = [999];
    assert.equal(hasCompleteJudgment(recorded), false, 'a cached vote cannot introduce evidence absent from the original response');
    recorded.trial.judgeAudit = structuredClone(audit);
    recorded.trial.judgeAudit!.attempts[0]!.input = '{}';
    assert.equal(hasCompleteJudgment(recorded), false, 'each rubric request is checked against the frozen evidence');
    recorded.trial.judgeAudit = structuredClone(audit);
    for (const attempt of recorded.trial.judgeAudit!.attempts) { delete attempt.metricId; delete attempt.input; }
    assert.equal(hasCompleteJudgment(recorded), true, 'legacy two-vote receipts remain inspectable');
  }
});

test('malformed, unsupported and invented judgments cannot escape validation or be repaired silently', async () => {
  for (const raw of ['not json', row('met', 'not_met', [999]), row('met', 'not_met', []),
    row('met', 'not_met').replace('Do this.', 'Fabricated quotation.'), '{"assessments":[]}']) {
    let audit: JudgeAudit | undefined;
    let calls = 0;
    await assert.rejects(assessRepeated(input, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, a) { audit = a; } }, async () => { calls++; return raw; }), /Judge response rejected/);
    assert.equal(calls, 4, 'each malformed vote is asked once more, then given up'); assert.equal(audit!.attempts[0]!.raw, raw); assert.ok(audit!.attempts.every(a => a.error));
    assert.equal(audit!.attempts.filter(a => a.superseded).length, 2);
  }
});

test('a vote the model returned malformed is asked once more; the original answer stays in the audit as superseded and the judgment still verifies', async () => {
  let audit: JudgeAudit | undefined;
  let calls = 0;
  const outputs = ['not json', row('met', 'not_met'), row('met', 'not_met')];
  const result = await assessRepeated(input, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, a) { audit = a; } }, async () => outputs[calls++]!);
  assert.equal(result[0]!.result, 'pass');
  assert.equal(calls, 3);
  assert.equal(audit!.attempts.length, 3);
  const superseded = audit!.attempts.filter(a => a.superseded);
  assert.equal(superseded.length, 1); assert.equal(superseded[0]!.raw, 'not json'); assert.ok(superseded[0]!.error, 'the malformed answer keeps its error');
  assert.ok(audit!.attempts.filter(a => !a.superseded).every(a => !a.error && a.assessments?.length === 1));
  const recorded = { ...input, trial: { ...trial, assessments: result, judgeAudit: audit } };
  assert.equal(hasCompleteJudgment(recorded), true, 'a superseded attempt is not a missing vote');
  const receipt = sealJudgeReceipt(audit!, true);
  assert.deepEqual(receipt.votes, [{ metricId: 'goal', result: 'pass' }, { metricId: 'goal', result: 'pass' }], 'the receipt carries the counted votes only');
  assert.equal(hasCompleteJudgment({ ...input, trial: { ...trial, assessments: result, judgeReceipt: receipt } }), true);
});

test('judge input withholds case labels, prior grades, unobserved state and undelivered static follow-ups', () => {
  const data = judgeInput({ ...input, scenario: { ...scenario, id: 'EXPECTED_FAIL', title: 'EXPECTED_FAIL',
    user: { ...scenario.user, script: ['UNDELIVERED'], maxFollowUps: 1 } },
    trial: { ...trial, outcome: 'fail', finalState: { ...trial.finalState, records: { SECRET_STATE: { time: '11:00' } } } } });
  assert.doesNotMatch(JSON.stringify(data), /EXPECTED_FAIL|PRIOR_VERDICT_SECRET|UNDELIVERED|SECRET_STATE/);
  assert.equal('finalState' in data.trial ? data.trial.finalState : 'absent', null);
  assert.match(data.evaluationScope, /action-dependent.*unclear/i);
  assert.deepEqual('user' in data.scenario ? data.scenario.user.script : 'absent', []);
  const observed = judgeInput({ ...input, trial: { ...trial, events: [{ seq: 2, type: 'tool_result', text: 'Update succeeded',
    tool: 'update_record', result: { ok: false, error: 'Write rejected' } }] } });
  assert.deepEqual(JSON.parse(observed.trial.events[0]!.content), {
    text: 'Update succeeded', tool: 'update_record', result: { ok: false, error: 'Write rejected' },
  }, 'a textual tool summary must not hide the structured result');
});

test('missing action evidence cannot be replaced by agent self-attestation while reply quality stays assessable', async () => {
  const actionScenario: Scenario = { ...scenario, successCriteria: 'Заявка существует в наблюдаемом состоянии.',
    metrics: [{ ...goalAttainment }, { ...replyQuality }],
  };
  const actionTrial: Trial = { ...trial,
    events: [{ seq: 0, type: 'user', text: 'Создай заявку' }, { seq: 1, type: 'assistant', text: 'Готово ✅, заявка создана' }],
    observation: { state: 'missing', tools: 'partial' },
  };
  const missing = judgeInput({ ...input, scenario: actionScenario, trial: { ...trial,
    ...actionTrial,
  } });
  assert.equal('finalState' in missing.trial ? missing.trial.finalState : 'absent', null);
  assert.match(missing.evaluationScope, /agent prose proves only what was said/i);
  assert.match(missing.evaluationScope, /action-dependent.*unclear/i);
  assert.deepEqual(missing.scenario.metrics?.map(metric => metric.id), ['goal_attainment', 'reply_quality']);
  assert.match(JSON.stringify(missing.trial.events), /Готово ✅, заявка создана/);

  let audit: JudgeAudit | undefined;
  const assessments = await assessRepeated({ ...input, scenario: actionScenario, trial: actionTrial }, model,
    { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, value) { audit = value; } },
    async (_prompt, data) => {
      const metricId = JSON.parse(data).scenario.metrics[0].id;
      return JSON.stringify({ assessments: [{ metricId, passCondition: 'met', failCondition: 'not_met',
        rationale: 'Агент утверждает, что заявка создана.', evidence: [1], citations: [{ seq: 1, quote: 'заявка создана' }] }] });
    });
  assert.equal(assessments.find(value => value.metricId === 'goal_attainment')!.result, 'unknown');
  assert.match(assessments.find(value => value.metricId === 'goal_attainment')!.rationale, /не подтверждено/i);
  assert.equal(assessments.find(value => value.metricId === 'reply_quality')!.result, 'pass');
  assert.deepEqual(audit!.attempts.filter(value => value.metricId === 'goal_attainment').map(value => value.assessments![0]!.result), ['unknown', 'unknown']);
  assert.equal(hasCompleteJudgment({ scenario: actionScenario, sources: [], trial: { ...actionTrial, assessments, judgeAudit: audit } }), true);

  const stale = structuredClone(audit!);
  for (const attempt of stale.attempts.filter(value => value.metricId === 'goal_attainment')) attempt.assessments![0]!.result = 'pass';
  assert.equal(hasCompleteJudgment({ scenario: actionScenario, sources: [], trial: { ...actionTrial,
    assessments: assessments.map(value => value.metricId === 'goal_attainment' ? { ...value, result: 'pass' as const } : value), judgeAudit: stale,
  } }), false, 'a legacy self-attested pass is stale under the current protocol');
  const staleProtocol = structuredClone(audit!);
  staleProtocol.prompt += ' old';
  assert.equal(hasCompleteJudgment({ scenario: actionScenario, sources: [], trial: { ...actionTrial, assessments, judgeAudit: staleProtocol } }), false,
    'an otherwise consistent receipt from an old judge prompt is incomplete');

  const informationalScenario: Scenario = { ...actionScenario, goalObservation: 'reply', successCriteria: 'Пользователь получает корректный адрес поддержки.' };
  const informational = await assessRepeated({ ...input, scenario: informationalScenario, trial: actionTrial }, model,
    { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, async (_prompt, data) => {
      const metricId = JSON.parse(data).scenario.metrics[0].id;
      return JSON.stringify({ assessments: [{ metricId, passCondition: 'met', failCondition: 'not_met',
        rationale: 'Ответ содержит запрошенный адрес.', evidence: [1], citations: [{ seq: 1, quote: 'Готово' }] }] });
    });
  assert.equal(informational.find(value => value.metricId === 'goal_attainment')!.result, 'pass', 'an owner-selected reply goal can be proven by the cited assistant answer');
  assert.equal(informational.find(value => value.metricId === 'reply_quality')!.result, 'pass', 'reply quality remains independently assessable');

  const unsupportedFailure = await assessRepeated({ ...input, scenario: { ...actionScenario, metrics: [{ ...goalAttainment }] }, trial: actionTrial }, model,
    { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, async () => JSON.stringify({ assessments: [{
      metricId: 'goal_attainment', passCondition: 'not_met', failCondition: 'met', rationale: 'Агент отказался выполнять запрос.', evidence: [1], citations: [{ seq: 1, quote: 'Готово' }],
    }] }));
  assert.equal(unsupportedFailure[0]!.result, 'unknown', 'assistant prose cannot prove action failure either');

  const toolScenario: Scenario = { ...actionScenario, goalObservation: 'tool', checks: [{ id: 'created', kind: 'tool_called', tool: 'create_ticket', description: 'Создание заявки вызвано' }], metrics: [{ ...goalAttainment }] };
  const failedTool = await assessRepeated({ ...input, scenario: toolScenario, trial: { ...actionTrial,
    events: [...actionTrial.events, { seq: 2, type: 'tool_result', tool: 'create_ticket', text: 'Write rejected', result: { ok: false, error: 'Write rejected' } }],
  } }, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, async () => JSON.stringify({ assessments: [{
    metricId: 'goal_attainment', passCondition: 'met', failCondition: 'not_met', rationale: 'Вызов инструмента был.', evidence: [2], citations: [{ seq: 2, quote: 'Write rejected' }],
  }] }));
  assert.equal(failedTool[0]!.result, 'unknown', 'a failed tool result cannot prove action success');

  const implicitFailure = await assessRepeated({ ...input, scenario: toolScenario, trial: { ...actionTrial,
    events: [...actionTrial.events, { seq: 2, type: 'tool_result', tool: 'create_ticket', text: 'permission denied', result: { status: 'error', message: 'permission denied' } }],
  } }, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, async () => JSON.stringify({ assessments: [{
    metricId: 'goal_attainment', passCondition: 'met', failCondition: 'not_met', rationale: 'Вызов инструмента был.', evidence: [2], citations: [{ seq: 2, quote: 'permission denied' }],
  }] }));
  assert.equal(implicitFailure[0]!.result, 'unknown', 'only explicit tool success can prove action completion');

  for (const tool of ['weather', 'create_ticket']) {
    const linked = await assessRepeated({ ...input, scenario: toolScenario, trial: { ...actionTrial,
      events: [...actionTrial.events, { seq: 2, type: 'tool_call', tool, args: {} }, { seq: 3, type: 'tool_result', tool, text: 'ok', result: { ok: true } }],
      checks: [{ id: 'created', description: 'Создание заявки вызвано', passed: tool === 'create_ticket', evidence: `${tool} was attempted` }],
    } }, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, async () => JSON.stringify({ assessments: [{
      metricId: 'goal_attainment', passCondition: 'met', failCondition: 'not_met', rationale: 'Инструмент подтвердил результат.', evidence: [3], citations: [{ seq: 3, quote: 'ok' }],
    }] }));
    assert.equal(linked[0]!.result, tool === 'create_ticket' ? 'pass' : 'unknown', 'only a scenario-linked tool result can confirm the action');
  }

  const multiCheckTool = await assessRepeated({ ...input, scenario: { ...toolScenario, checks: [...toolScenario.checks,
    { id: 'bounded', kind: 'tool_count', tool: 'create_ticket', min: 1, max: 1, description: 'Один вызов' }] }, trial: { ...actionTrial,
    events: [...actionTrial.events, { seq: 2, type: 'tool_call', tool: 'create_ticket', args: {} }, { seq: 3, type: 'tool_result', tool: 'create_ticket', result: { ok: true } }],
    checks: [
      { id: 'created', description: 'Создание заявки вызвано', passed: true, evidence: 'create_ticket was attempted' },
      { id: 'bounded', description: 'Один вызов', passed: false, evidence: 'separate failed constraint' },
    ],
  } }, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, async () => JSON.stringify({ assessments: [{
    metricId: 'goal_attainment', passCondition: 'met', failCondition: 'not_met', rationale: 'Инструмент подтвердил результат.', evidence: [3], citations: [{ seq: 3, quote: 'true' }],
  }] }));
  assert.equal(multiCheckTool[0]!.result, 'pass', 'one matching passed positive check is enough when the same tool has several checks');

  const forbiddenToolScenario: Scenario = { ...actionScenario,
    goalObservation: 'tool',
    checks: [{ id: 'never_create', kind: 'tool_count', tool: 'create_ticket', min: 0, max: 0, description: 'Не создавать заявку' }], metrics: [{ ...goalAttainment }],
  };
  const forbiddenTool = await assessRepeated({ ...input, scenario: forbiddenToolScenario, trial: { ...actionTrial,
    events: [...actionTrial.events, { seq: 2, type: 'tool_result', tool: 'create_ticket', text: 'ok', result: { ok: true } }],
  } }, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, async () => JSON.stringify({ assessments: [{
    metricId: 'goal_attainment', passCondition: 'met', failCondition: 'not_met', rationale: 'Инструмент успешно вызван.', evidence: [2], citations: [{ seq: 2, quote: 'ok' }],
  }] }));
  assert.equal(forbiddenTool[0]!.result, 'unknown', 'a tool forbidden by a zero-count check cannot prove goal success');

  for (const state of ['reported', 'sandbox'] as const) {
    const observedTrial: Trial = { ...trial,
      observation: { state, tools: state === 'sandbox' ? 'sandbox' : 'complete' },
      finalState: { records: { request: { status: 'created' } }, writableFields: [], transientFailures: 0 },
    };
    const observed = judgeInput({ ...input, scenario: actionScenario, trial: observedTrial });
    assert.notEqual('finalState' in observed.trial ? observed.trial.finalState : null, null);
    assert.doesNotMatch(observed.evaluationScope, /action-dependent.*unclear/i);
    const unsupported = await assessRepeated({ ...input, scenario: { ...actionScenario, metrics: [{ ...goalAttainment }] }, trial: observedTrial }, model,
      { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, async () => JSON.stringify({ assessments: [{
        metricId: 'goal_attainment', passCondition: 'met', failCondition: 'not_met', rationale: 'Агент сказал, что заявка создана.', evidence: [1], citations: [{ seq: 1, quote: 'Do this.' }],
      }] }));
    assert.equal(unsupported[0]!.result, 'unknown', 'observed state still needs a matching deterministic effect, not assistant prose');
  }

  const stateScenario: Scenario = { ...actionScenario, goalObservation: 'state',
    checks: [{ id: 'created', kind: 'state_equals', recordId: 'request', field: 'status', value: 'created', description: 'Заявка существует' }],
    metrics: [{ ...goalAttainment }],
  };
  const stateTrial: Trial = { ...actionTrial, observation: { state: 'sandbox', tools: 'sandbox' },
    finalState: { records: { request: { status: 'created' } }, writableFields: [], transientFailures: 0 },
    events: [...actionTrial.events, { seq: 2, type: 'tool_result', tool: 'create_ticket', result: { ok: true }, state: { records: { request: { status: 'created' } }, writableFields: [], transientFailures: 0 } }],
    checks: [{ id: 'created', description: 'Заявка существует', passed: true, evidence: 'request.status = created' }],
  };
  const stateBacked = await assessRepeated({ ...input, scenario: stateScenario, trial: stateTrial }, model,
    { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, async () => JSON.stringify({ assessments: [{
      metricId: 'goal_attainment', passCondition: 'met', failCondition: 'not_met', rationale: 'Состояние подтверждено.', evidence: [2], citations: [{ seq: 2, quote: 'created' }],
    }] }));
  assert.equal(stateBacked[0]!.result, 'pass', 'a passed state predicate can prove action completion');

  const conflictingStateScenario: Scenario = { ...stateScenario, checks: [...stateScenario.checks,
    { id: 'owner', kind: 'state_equals', recordId: 'request', field: 'owner', value: 'user', description: 'Заявка принадлежит пользователю' }],
  };
  const conflictingStateTrial: Trial = { ...stateTrial, checks: [...stateTrial.checks,
    { id: 'owner', description: 'Заявка принадлежит пользователю', passed: false, evidence: 'request.owner = other' }],
  };
  const conflictingState = await assessRepeated({ ...input, scenario: conflictingStateScenario, trial: conflictingStateTrial }, model,
    { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, async () => JSON.stringify({ assessments: [{
      metricId: 'goal_attainment', passCondition: 'met', failCondition: 'not_met', rationale: 'Часть состояния подтверждена.', evidence: [1], citations: [{ seq: 1, quote: 'заявка создана' }],
    }] }));
  assert.equal(conflictingState[0]!.result, 'unknown', 'one passed state predicate cannot hide another required predicate failure');

  const wrongReplyEvidence = await assessRepeated({ ...input, scenario: { ...informationalScenario, metrics: [{ ...goalAttainment }] }, trial: { ...actionTrial,
    events: [...actionTrial.events, { seq: 2, type: 'tool_call', tool: 'create_ticket', args: {} }, { seq: 3, type: 'tool_result', tool: 'create_ticket', result: { ok: true } }],
    checks: [{ id: 'created', description: 'Создание заявки вызвано', passed: true, evidence: 'create_ticket was attempted' }],
  } }, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, async () => JSON.stringify({ assessments: [{
    metricId: 'goal_attainment', passCondition: 'met', failCondition: 'not_met', rationale: 'Цель подтверждена инструментом.', evidence: [3], citations: [{ seq: 3, quote: 'true' }],
  }] }));
  assert.equal(wrongReplyEvidence.find(value => value.metricId === 'goal_attainment')!.result, 'unknown', 'reply goals require a cited assistant reply');

  const wrongStateEvidence = await assessRepeated({ ...input, scenario: stateScenario, trial: stateTrial }, model,
    { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, async () => JSON.stringify({ assessments: [{
      metricId: 'goal_attainment', passCondition: 'met', failCondition: 'not_met', rationale: 'Агент заявил об успехе.', evidence: [1], citations: [{ seq: 1, quote: 'заявка создана' }],
    }] }));
  assert.equal(wrongStateEvidence[0]!.result, 'unknown', 'state goals require cited observed state, not assistant prose');

  const legacyTool = await assessRepeated({ ...input, scenario: { ...toolScenario, goalObservation: undefined }, trial: { ...actionTrial,
    events: [...actionTrial.events, { seq: 2, type: 'tool_call', tool: 'create_ticket', args: {} }, { seq: 3, type: 'tool_result', tool: 'create_ticket', result: { ok: true } }],
    checks: [{ id: 'created', description: 'Создание заявки вызвано', passed: true, evidence: 'create_ticket was attempted' }],
  } }, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, async () => JSON.stringify({ assessments: [{
    metricId: 'goal_attainment', passCondition: 'met', failCondition: 'not_met', rationale: 'Инструмент подтвердил результат.', evidence: [3], citations: [{ seq: 3, quote: 'true' }],
  }] }));
  assert.equal(legacyTool[0]!.result, 'unknown', 'legacy scenarios never guess a goal observation channel');
});

test('journal failure stops judgment before another request and original replies survive store reopening', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'judge-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ExperimentStore(directory); await store.init();
  let calls = 0;
  try {
    await assert.rejects(assessRepeated(input, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(id, a) {
      store.appendJudgment('run', id, a);
      if (a.attempts.some(v => v.raw)) throw new Error('disk failed');
    } }, async () => { calls++; return row('met', 'not_met'); }), /disk failed/);
    assert.equal(calls, 2, 'both votes were already in flight; nothing new starts after the failure');
  } finally { await store.close(); }
  const journal = await new ExperimentStore(directory).traceJournal('run');
  assert.equal(JSON.parse(journal.trim().split('\n').at(-1)!).judgeAudit.attempts[0].raw, row('met', 'not_met'));
});

test('a judgment lives in the private sidecar, the trial keeps a verifiable receipt and the journal gets it once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'judge-sidecar-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ExperimentStore(directory); await store.init();
  try {
    let lastAudit: JudgeAudit | undefined;
    const result = await assessRepeated(input, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(id, a, final) {
      lastAudit = a;
      store.writeJudgeAudit('run', id, a);
      if (final) store.appendJudgment('run', id, a);
    } }, async () => row('met', 'not_met'));
    const complete = hasCompleteJudgment({ ...input, trial: { ...input.trial, assessments: result, judgeAudit: lastAudit } });
    assert.equal(complete, true);
    const judged: Trial = { ...input.trial, assessments: result, judgeReceipt: sealJudgeReceipt(lastAudit!, complete) };
    assert.equal(judged.judgeAudit, undefined);
    assert.equal(hasCompleteJudgment({ ...input, trial: judged }), true);
    assert.equal(fingerprint(await store.readJudgeAudit('run', 'trial')), judged.judgeReceipt!.auditHash);
    const lines = (await store.traceJournal('run')).trim().split('\n').filter(line => 'judgeAudit' in JSON.parse(line));
    assert.equal(lines.length, 1, 'the journal gets the audit once per finished judgment');
  } finally { await store.close(); }
});

test('a receipt verifies only against the record it came from and never outranks a full audit', async () => {
  const judge = async (outputs: string[]) => {
    let audit: JudgeAudit | undefined, calls = 0;
    const result = await assessRepeated(input, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, a) { audit = a; } },
      async () => outputs[calls++]!);
    const complete = hasCompleteJudgment({ ...input, trial: { ...trial, assessments: result, judgeAudit: audit } });
    return { audit: audit!, result, receipt: sealJudgeReceipt(audit!, complete) };
  };
  const { audit, result, receipt } = await judge([row('met', 'not_met'), row('met', 'not_met')]);
  const base = { ...input, trial: { ...trial, assessments: result, judgeReceipt: receipt } };
  assert.equal(hasCompleteJudgment(base), true);
  const tampered: [string, (value: typeof base) => void][] = [
    ['event text', value => { value.trial.events[1]!.text = 'Do something else.'; }],
    ['scenario criterion', value => { value.scenario.successCriteria = 'A different outcome'; }],
    ['recorded assessment', value => { value.trial.assessments![0]!.result = 'fail'; }],
    ['receipt vote', value => { value.trial.judgeReceipt!.votes[0]!.result = 'fail'; }],
    ['vote error', value => { value.trial.judgeReceipt!.votes[1]!.error = true; }],
    ['incomplete receipt', value => { value.trial.judgeReceipt!.complete = false; }],
    ['protocol', value => { value.trial.judgeReceipt!.protocolHash = 'another-protocol'; }],
    ['missing vote', value => { value.trial.judgeReceipt!.votes.pop(); }],
    ['assessment error', value => { value.trial.assessmentError = 'Judge failed'; }],
    ['not applicable list', value => { value.trial.judgeReceipt!.notApplicable = []; }],
  ];
  for (const [name, mutate] of tampered) {
    const value = structuredClone(base);
    mutate(value);
    assert.equal(hasCompleteJudgment(value), false, `receipt must fail after changing the ${name}`);
  }
  assert.equal(hasCompleteJudgment(structuredClone(base)), true, 'tampering never touched the original');
  assert.equal(sealJudgeReceipt(audit, true).auditHash, fingerprint(audit));

  const split = await judge([row('met', 'not_met'), row('not_met', 'met')]);
  assert.equal(split.result[0]!.result, 'unknown');
  const splitTrial = { ...input, trial: { ...trial, assessments: split.result, judgeReceipt: split.receipt } };
  assert.equal(hasCompleteJudgment(splitTrial), true, 'a split vote set verifies only as unknown');
  for (const forged of ['pass', 'fail'] as const) {
    const value = structuredClone(splitTrial);
    value.trial.assessments[0]!.result = forged;
    assert.equal(hasCompleteJudgment(value), false, `a split vote set cannot back ${forged}`);
  }

  const both = structuredClone({ ...base, trial: { ...base.trial, judgeAudit: audit } });
  assert.equal(hasCompleteJudgment(both), true);
  both.trial.judgeAudit!.attempts[0]!.raw = 'not the saved model response';
  assert.equal(hasCompleteJudgment(both), false, 'a full audit is always the judge, even beside a valid receipt');

  const legacy = structuredClone(audit);
  for (const attempt of legacy.attempts) { delete attempt.metricId; delete attempt.input; }
  const legacyReceipt = sealJudgeReceipt(legacy, true);
  assert.equal(legacyReceipt.votes.length, 2);
  assert.equal(hasCompleteJudgment({ ...base, trial: { ...base.trial, judgeReceipt: legacyReceipt } }), true);
  legacy.attempts[0]!.error = 'Invalid judgment';
  assert.equal(sealJudgeReceipt(legacy, true).complete, false, 'a failed legacy attempt never seals as complete');
});

test('every judgment reports exactly one final audit, and a failing final save never hides the original error', async () => {
  const cases: [string, () => Promise<string>, RegExp | null, number][] = [
    ['two passing votes', async () => row('met', 'not_met'), null, 2],
    ['malformed response', async () => 'not json', /Judge response rejected/, 4],
    ['thrown request', async () => { throw new Error('network down'); }, /network down/, 2],
  ];
  for (const [name, respond, rejection, attempts] of cases) {
    const finals: boolean[] = [];
    let last: JudgeAudit | undefined;
    const run = assessRepeated(input, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, a, final) {
      if (final) { finals.push(final); last = a; }
    } }, respond);
    if (rejection) await assert.rejects(run, rejection); else await run;
    assert.equal(finals.length, 1, `${name}: one final judgment`);
    assert.equal(last!.attempts.length, attempts, `${name}: the final audit holds every settled vote, including the ones asked again`);
  }
  await assert.rejects(assessRepeated(input, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, _a, final) {
    if (final) throw new Error('final save failed');
  } }, async () => { throw new Error('network down'); }), /network down/);
  await assert.rejects(assessRepeated(input, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, _a, final) {
    if (final) throw new Error('final save failed');
  } }, async () => row('met', 'not_met')), /final save failed/, 'a lost final save is never a silent success');
  let finals = 0;
  const none = await assessRepeated({ ...input, scenario: { ...scenario, metrics: [] } }, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {},
    onJudgment() { finals++; } }, async () => row('met', 'not_met'));
  assert.equal(none.length + finals, 0, 'no rubrics, no judgment, nothing to report');
});

test('reactive fidelity applies to actual simulator decisions, including a decision to stop, not to the fixed opening', async () => {
  for (const invoked of [false, true]) {
    let audit: JudgeAudit | undefined;
    const requests: string[][] = [];
    const value = { ...input, trial: { ...trial, userMode: 'reactive' as const,
      events: invoked ? [...trial.events, { seq: 2, type: 'simulator' as const, result: { done: true, message: '' } }] : trial.events } };
    const result = await assessRepeated(value, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, a) { audit = a; } }, async (_prompt, data) => {
      const ids = JSON.parse(data).scenario.metrics.map((m: { id: string }) => m.id);
      assert.equal(ids.length, 1, 'each model call assesses exactly one rubric'); requests.push(ids);
      const answer = JSON.parse(row('met', 'not_met'));
      if (ids[0] === 'user_fidelity') answer.assessments[0] = { ...answer.assessments[0], metricId: 'user_fidelity', evidence: [2], citations: [{ seq: 2, quote: '"done":true' }] };
      return JSON.stringify(answer);
    });
    assert.deepEqual(requests, invoked ? [['goal'], ['goal'], ['user_fidelity'], ['user_fidelity']] : [['goal'], ['goal']]);
    assert.equal(result[1]!.result, invoked ? 'pass' : 'unknown');
    assert.deepEqual(audit!.notApplicable, invoked ? [] : ['user_fidelity']);
    assert.equal(hasCompleteJudgment({ ...value, trial: { ...value.trial, judgeAudit: audit, assessments: result } }), true);
  }
});

test('the judge sees the agent prompt as its observable rules only, never as raw text with machine formats', () => {
  const prompt = { id: 'prompt_1', name: 'prompt.md', hash: 'h', kind: 'prompt' as const,
    content: 'Отвечай на «вы». ВСЕГДА возвращай валидный JSON в формате {"output": "*Финальный ответ*"}. Никогда не направляй в поддержку.' };
  const policy = { id: 'policy_1', name: 'policy.md', hash: 'h2', content: 'Возврат делается на ту же карту.' };
  const rule = (id: string, sourceId: string, quote: string) => ({ id, text: id, sourceId, quote, critical: true });
  const requirements = [rule('formal', 'prompt_1', 'Отвечай на «вы»'), rule('json', 'prompt_1', 'ВСЕГДА возвращай валидный JSON в формате {"output": "*Финальный ответ*"}'),
    rule('no_support', 'prompt_1', 'Никогда не направляй в поддержку'), rule('refund', 'policy_1', 'Возврат делается на ту же карту.')];
  const seen = observableSources([prompt, policy], requirements);
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.content, policy.content, 'a policy source reaches the judge unchanged');
  assert.equal(seen[0]!.id, 'prompt_1'); assert.equal(seen[0]!.kind, 'prompt');
  assert.match(seen[0]!.content, /1\. «Отвечай на «вы»»\n2\. «Никогда не направляй в поддержку»/);
  assert.doesNotMatch(seen[0]!.content, /JSON|output/);
  assert.match(observableSources([prompt], [])[0]!.content, /не извлечено/);
  assert.doesNotMatch(observableSources([prompt], [])[0]!.content, /JSON/);
  assert.match(JSON.stringify(judgeInput({ ...input, sources: seen })), /промпт агента/);
});

test('all votes of one dialogue are requested at once and the audit keeps a stable order', async () => {
  const second = { ...scenario.metrics![0]!, id: 'tone', name: 'Tone' };
  const both = { ...input, scenario: { ...scenario, metrics: [scenario.metrics![0]!, second] } };
  let active = 0, peak = 0;
  let audit: JudgeAudit | undefined;
  const result = await assessRepeated(both, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, a) { audit = a; } },
    async (_prompt, data) => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 20)); active--;
      const metricId = JSON.parse(data).scenario.metrics[0].id;
      return JSON.stringify({ assessments: [{ metricId, passCondition: 'met', failCondition: 'not_met', rationale: 'Explicit evidence for both conditions.', evidence: [1], citations: [{ seq: 1, quote: 'Do this.' }] }] });
    });
  assert.equal(peak, 4, 'two rubrics times two votes run concurrently');
  assert.deepEqual(result.map(r => [r.metricId, r.result]), [['goal', 'pass'], ['tone', 'pass']]);
  assert.deepEqual(audit!.attempts.map(a => a.metricId), ['goal', 'goal', 'tone', 'tone']);
});

test('a judgment made on observable prompt rules is complete against the same sources, not the raw prompt', async () => {
  const sources = [{ id: 'p', name: 'Prompt', content: 'Always cite the tariff page.', hash: 'h', kind: 'prompt' as const }];
  const requirements = [{ id: 'cite', text: 'Cite the tariff page', sourceId: 'p', quote: 'Always cite the tariff page.', critical: false }];
  const seen = observableSources(sources, requirements);
  let audit: JudgeAudit | undefined;
  const assessments = await assessRepeated({ ...input, sources: seen }, model,
    { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, value) { audit = value; } },
    async () => row('met', 'not_met'));
  const recorded = { ...trial, assessments, judgeAudit: audit };
  assert.equal(hasCompleteJudgment({ scenario, sources: observableSources(sources, requirements), trial: recorded }), true);
  assert.equal(hasCompleteJudgment({ scenario, sources, trial: recorded }), false, 'the raw prompt is not what the judge saw');
});

test('in a large knowledge base the judge reads the prompt rules and only the articles the card cites; older records keep every source', () => {
  const article = (id: string): Source => ({ id, name: id, content: `Статья ${id}`, hash: id });
  const sources: Source[] = [{ id: 'source-1', name: 'prompt', content: 'Отвечайте вежливо.', hash: 'p', kind: 'prompt' }, article('source-2'), article('source-3'), article('source-4')];
  const requirement = (id: string, sourceId: string): Requirement => ({ id, sourceId, text: 'Правило', quote: 'Статья', critical: true });
  const requirements = [requirement('p1', 'source-1'), requirement('r2', 'source-2'), requirement('r4', 'source-4')];
  const card = { ...scenario, requirementIds: ['r2'], execution: { evaluatorView: { requirements: [requirement('r4', 'source-4')] } } } as unknown as Scenario;
  const legacy = { sources, requirements };
  assert.deepEqual(scenarioSources(legacy, card).map(s => s.id), ['source-1', 'source-2', 'source-3', 'source-4'], 'a record prepared from a few materials keeps the judge input it was verified with');
  const large = { sources, requirements, preparationProgress: { sourceSelection: [] } };
  assert.deepEqual(scenarioSources(large, card).map(s => s.id), ['source-1', 'source-2', 'source-4']);
  assert.equal(scenarioSources(large, card)[1], sources[1], 'the same objects, in record order');
});

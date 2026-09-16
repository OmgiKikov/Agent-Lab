import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessRepeated, hasCompleteJudgment, judgeInput, observableSources, JUDGE_PROTOCOL } from '../src/judge.js';
import { emptyUsage, goalAttainment, RAG_METRIC_IDS, ragEvidenceComplete, replyQuality, simulatorFidelity, type JudgeAudit, type Scenario, type Trial } from '../src/contracts.js';
import { ExperimentStore } from '../src/store.js';

const scenario: Scenario = { id: 'card', familyId: 'family', title: 'A fixed input', split: 'dev', provenance: 'synthetic', requirementIds: [],
  user: { goal: 'Receive an instruction', facts: 'Known facts', behavior: 'Stop after the instruction', opening: 'Help', maxFollowUps: 0 },
  checks: [], initialState: { records: {}, writableFields: [], transientFailures: 0 },
  metrics: [{ id: 'goal', name: 'Goal', subject: 'agent', description: 'Original task', passCriteria: 'Instruction supplied', failCriteria: 'A refusal is supplied' }, simulatorFidelity] };
const trial: Trial = { id: 'trial', revisionId: 'revision', scenarioId: 'card', familyId: 'family', repeat: 0, split: 'dev', userMode: 'static', manifestHash: 'manifest',
  outcome: 'ungraded', reason: 'PRIOR_VERDICT_SECRET', checks: [], events: [{ seq: 0, type: 'user', text: 'Help' }, { seq: 1, type: 'assistant', text: 'Do this.' }],
  initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 1 };
const input = { scenario, sources: [], trial };
const model = { provider: 'offline', id: 'test' };
const row = (passCondition: string, failCondition: string, evidence = [1]) => JSON.stringify({ assessments: [{ metricId: 'goal', passCondition, failCondition, rationale: 'Explicit evidence for both conditions.', evidence, citations: evidence.map(seq => ({ seq, quote: 'Do this.' })) }] });

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
        const citations = [{ seq: 1, quote: 'Do this.' }, ...(mode === 'no_retrieval_quote' ? [] : [{ seq: 2, quote: '"chunks":' }])];
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
    assert.equal(calls, 2); assert.equal(audit!.attempts[0]!.raw, raw); assert.ok(audit!.attempts.every(a => a.error));
  }
});

test('judge input withholds case labels, prior grades, unobserved state and undelivered static follow-ups', () => {
  const data = judgeInput({ ...input, scenario: { ...scenario, id: 'EXPECTED_FAIL', title: 'EXPECTED_FAIL',
    user: { ...scenario.user, script: ['UNDELIVERED'], maxFollowUps: 1 } },
    trial: { ...trial, outcome: 'fail', finalState: { ...trial.finalState, records: { SECRET_STATE: { time: '11:00' } } } } });
  assert.doesNotMatch(JSON.stringify(data), /EXPECTED_FAIL|PRIOR_VERDICT_SECRET|UNDELIVERED|SECRET_STATE/);
  assert.equal(data.trial.finalState, null);
  assert.match(data.evaluationScope, /action-dependent.*unclear/i);
  assert.deepEqual(data.scenario.user.script, []);
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
  assert.equal(missing.trial.finalState, null);
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
    const observedTrial = { ...trial,
      observation: { state, tools: state === 'sandbox' ? 'sandbox' : 'complete' },
      finalState: { records: { request: { status: 'created' } }, writableFields: [], transientFailures: 0 },
    };
    const observed = judgeInput({ ...input, scenario: actionScenario, trial: observedTrial });
    assert.notEqual(observed.trial.finalState, null);
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

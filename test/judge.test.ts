import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessRepeated, auditCut, hasCompleteJudgment, judgeInput, observableSources, prefixTrial, JUDGE_PROMPT, JUDGE_RESPONSE_FORMAT, sealJudgeReceipt, simulatorCut, JUDGE_PROTOCOL, JUDGE_PROTOCOL_V10 } from '../src/judge.js';
import { assessmentEventContent, emptyUsage, fingerprint, goalAttainment, RAG_METRIC_IDS, ragEvidenceComplete, replyQuality, simulatorFidelity, type JudgeAudit, type Scenario, type Trial } from '../src/contracts.js';
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
  const cases: [string, () => Promise<string>, RegExp | null][] = [
    ['two passing votes', async () => row('met', 'not_met'), null],
    ['malformed response', async () => 'not json', /Judge response rejected/],
    ['thrown request', async () => { throw new Error('network down'); }, /network down/],
  ];
  for (const [name, respond, rejection] of cases) {
    const finals: boolean[] = [];
    let last: JudgeAudit | undefined;
    const run = assessRepeated(input, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, a, final) {
      if (final) { finals.push(final); last = a; }
    } }, respond);
    if (rejection) await assert.rejects(run, rejection); else await run;
    assert.equal(finals.length, 1, `${name}: one final judgment`);
    assert.equal(last!.attempts.length, 2, `${name}: the final audit holds every settled vote`);
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
    assert.deepEqual(requests, invoked ? [['user_fidelity'], ['user_fidelity'], ['goal'], ['goal']] : [['goal'], ['goal']]);
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

/** A reactive dialogue whose simulated user asks about something off the card at event #3. */
const reactiveTrial: Trial = { ...trial, userMode: 'reactive', events: [
  { seq: 0, type: 'user', text: 'Help' }, { seq: 1, type: 'assistant', text: 'Do this.' },
  { seq: 2, type: 'simulator', result: { done: false, message: 'What about a refund?' } },
  { seq: 3, type: 'user', text: 'What about a refund?' }, { seq: 4, type: 'assistant', text: 'A refund goes to the card.' },
  { seq: 5, type: 'simulator', result: { done: true, message: '' } },
] };
const reactive = { ...input, trial: reactiveTrial };
const DEVIATION = 'The simulated user deviated from the card at event #3';
const quiet = () => ({ signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} });
const fidelityRow = (result: 'pass' | 'fail', evidence: number[]) => JSON.stringify({ assessments: [{ metricId: 'user_fidelity',
  passCondition: result === 'pass' ? 'met' : 'not_met', failCondition: result === 'pass' ? 'not_met' : 'met',
  rationale: 'The simulated user compared with the card.', evidence,
  citations: evidence.map(seq => ({ seq, quote: assessmentEventContent(reactiveTrial.events.find(event => event.seq === seq)!) })) }] });
type FidelityVote = 'pass' | 'fail' | 'error';
/** Fidelity votes as given, citing `fidelityEvidence`; every agent vote passes citing `goalEvidence`. */
function reactiveJudge(fidelity: [FidelityVote | 'malformed', FidelityVote | 'malformed'], goalEvidence = [1], fidelityEvidence = [3]) {
  const requests: { ids: string[]; data: string }[] = [];
  let audit: JudgeAudit | undefined;
  let fidelityCalls = 0;
  const run = assessRepeated(reactive, model, { ...quiet(), onJudgment(_id, value) { audit = value; } }, async (_prompt, data) => {
    const ids = (JSON.parse(data).scenario.metrics as { id: string }[]).map(metric => metric.id);
    requests.push({ ids, data });
    if (ids[0] !== 'user_fidelity') return row('met', 'not_met', goalEvidence);
    const vote = fidelity[fidelityCalls++]!;
    if (vote === 'error') throw new Error('fidelity request failed');
    if (vote === 'malformed') return 'not json';
    return fidelityRow(vote, fidelityEvidence);
  });
  return { run, requests, audit: () => audit! };
}
const seqs = (data: string) => (JSON.parse(data).trial.events as { seq: number }[]).map(event => event.seq);

test('the cut is the earliest user or simulator event a failing fidelity vote cites after the first agent reply', () => {
  const events = reactiveTrial.events;
  assert.equal(simulatorCut([{ result: 'fail', evidence: [4, 3] }], events), 3);
  assert.equal(simulatorCut([{ result: 'pass', evidence: [3] }, { result: 'unknown', evidence: [2] }], events), undefined, 'only failing votes cut');
  assert.equal(simulatorCut([{ result: 'fail', evidence: [0, 1] }], events), undefined, 'the opening belongs to the card and agent replies never cut');
  assert.equal(simulatorCut([{ result: 'fail', evidence: [5] }, { result: 'fail', evidence: [3, 2] }], events), 2, 'the minimum over the failing votes');
  assert.equal(simulatorCut([{ result: 'fail', evidence: [0, 1] }], [{ seq: 0, type: 'user' }, { seq: 1, type: 'simulator' }]), undefined, 'no agent reply, no cut');
  // The stored-data shape: tool and retrieval events before the first reply at #11.
  const stored: Trial['events'] = [{ seq: 0, type: 'user' }, { seq: 1, type: 'tool_call' }, { seq: 2, type: 'tool_result' },
    ...Array.from({ length: 8 }, (_, i) => ({ seq: 3 + i, type: 'retrieval' as const })), { seq: 11, type: 'assistant' },
    { seq: 12, type: 'simulator' }, { seq: 13, type: 'user' }, { seq: 14, type: 'retrieval' }, { seq: 15, type: 'assistant' },
    { seq: 16, type: 'simulator' }, { seq: 17, type: 'user' }, { seq: 18, type: 'simulator' }, { seq: 19, type: 'user' }];
  assert.equal(simulatorCut([{ result: 'fail', evidence: [11, 12, 18, 19] }], stored), 12);
  assert.equal(simulatorCut([{ result: 'fail', evidence: [0, 5] }], stored), undefined);
  assert.deepEqual(prefixTrial({ ...reactiveTrial, events: stored }, 16).events.map(event => event.seq), Array.from({ length: 16 }, (_, i) => i),
    'retrieval for the last reply stays in the prefix');
});

test('the prefix keeps the dialogue up to the last agent reply before the cut and withholds what was observed after it', () => {
  const observed: Trial = { ...reactiveTrial, observation: { state: 'reported', tools: 'complete' }, checks: [{ id: 'saved', description: 'Saved', passed: true, evidence: 'yes' }] };
  const prefix = prefixTrial(observed, 3);
  assert.deepEqual(prefix.events.map(event => event.seq), [0, 1]);
  assert.deepEqual(prefix.observation, { state: 'missing', tools: 'partial' });
  assert.deepEqual(prefix.checks, []);
  assert.equal(prefix.id, observed.id);
  assert.equal(observed.events.length, 6, 'the recorded trial is untouched');
  assert.equal(prefixTrial(observed, 5).events.at(-1)!.seq, 4);
  assert.ok(!JSON.stringify(judgeInput(reactive)).includes('deviated'));
  assert.ok(judgeInput({ ...reactive, trial: prefix }, 3).evaluationScope.includes(DEVIATION));
});

test('a deviated reactive dialogue: fidelity is judged first on the whole dialogue, the agent on the faithful prefix', async () => {
  const judge = reactiveJudge(['fail', 'fail']);
  const result = await judge.run;
  assert.deepEqual(judge.requests.map(r => r.ids), [['user_fidelity'], ['user_fidelity'], ['goal'], ['goal']]);
  for (const request of judge.requests.slice(0, 2)) {
    assert.deepEqual(seqs(request.data), [0, 1, 2, 3, 4, 5]);
    assert.ok(!request.data.includes('deviated'));
  }
  for (const request of judge.requests.slice(2)) {
    assert.deepEqual(seqs(request.data), [0, 1], 'the agent is judged before the deviation');
    assert.ok(JSON.parse(request.data).evaluationScope.includes(DEVIATION));
  }
  assert.deepEqual(result.map(r => [r.metricId, r.result]), [['goal', 'pass'], ['user_fidelity', 'fail']]);
  const audit = judge.audit();
  assert.equal(audit.protocolHash, JUDGE_PROTOCOL);
  assert.equal(audit.attempts.length, 4, 'still two calls per applicable rubric');
  assert.deepEqual(seqs(audit.input), [0, 1, 2, 3, 4, 5], 'the audit input stays the whole dialogue');
  assert.equal(auditCut(audit, reactiveTrial.events), 3);
  const judged = { ...reactive, trial: { ...reactiveTrial, assessments: result, judgeAudit: audit } };
  assert.equal(hasCompleteJudgment(judged), false, 'a cut the trial does not carry is not verifiable');
  assert.equal(hasCompleteJudgment({ ...judged, trial: { ...judged.trial, judgedBeforeSeq: 3 } }), true);
});

test('an agent vote on the prefix that cites an event after it is rejected with every raw reply kept', async () => {
  const judge = reactiveJudge(['fail', 'fail'], [4]);
  await assert.rejects(judge.run, /Judge response rejected/);
  const audit = judge.audit();
  assert.equal(audit.attempts.length, 4);
  assert.ok(audit.attempts.every(attempt => attempt.raw), 'every raw reply is preserved');
  assert.ok(audit.attempts.filter(a => a.metricId === 'goal').every(a => /nonexistent trace event/.test(a.error ?? '')));
});

test('without a failing fidelity vote the agent is judged on the whole dialogue; one failing vote is enough to cut', async () => {
  const faithful = reactiveJudge(['pass', 'pass'], [1], [2]);
  const result = await faithful.run;
  for (const request of faithful.requests.filter(r => r.ids[0] === 'goal')) {
    assert.deepEqual(seqs(request.data), [0, 1, 2, 3, 4, 5]);
    assert.ok(!request.data.includes('deviated'));
  }
  const audit = faithful.audit();
  assert.equal(auditCut(audit, reactiveTrial.events), undefined);
  const judged = { ...reactive, trial: { ...reactiveTrial, assessments: result, judgeAudit: audit } };
  assert.equal(hasCompleteJudgment(judged), true);
  assert.equal(hasCompleteJudgment({ ...judged, trial: { ...judged.trial, judgedBeforeSeq: 3 } }), false, 'an invented cut is rejected');

  const split = reactiveJudge(['fail', 'pass']);
  const splitResult = await split.run;
  assert.equal(splitResult.find(r => r.metricId === 'user_fidelity')!.result, 'unknown');
  for (const request of split.requests.filter(r => r.ids[0] === 'goal')) assert.deepEqual(seqs(request.data), [0, 1]);
  assert.equal(auditCut(split.audit(), reactiveTrial.events), 3);
});

test('an erred or rejected fidelity vote stops the judgment before any agent vote is requested', async () => {
  for (const [votes, rejection] of [[['error', 'pass'], /fidelity request failed/], [['malformed', 'pass'], /Judge response rejected/]] as const) {
    const judge = reactiveJudge([votes[0], votes[1]]);
    await assert.rejects(judge.run, rejection);
    assert.deepEqual(judge.requests.map(r => r.ids), [['user_fidelity'], ['user_fidelity']], 'no agent vote without a known cut');
    assert.equal(judge.audit().attempts.length, 2);
  }
});

test('v11 judgments verify only with an untouched cut and v10 judgments stay verifiable as before', async () => {
  const cutJudge = reactiveJudge(['fail', 'fail']);
  const cutResult = await cutJudge.run;
  const cutAudit = cutJudge.audit();
  const whole = reactiveJudge(['pass', 'pass'], [1], [2]);
  const wholeResult = await whole.run;
  const wholeAudit = whole.audit();
  const seal = (audit: JudgeAudit, trialValue: Trial, cut?: number) => sealJudgeReceipt(audit, hasCompleteJudgment({ ...reactive, trial: { ...trialValue, judgeAudit: audit } }), cut);

  // v11 with a cut: full audit and receipt.
  const cutTrial: Trial = { ...reactiveTrial, assessments: cutResult, judgedBeforeSeq: 3 };
  const cutReceipt = seal(cutAudit, cutTrial, 3);
  assert.equal(cutReceipt.complete, true);
  assert.equal(cutReceipt.cutBefore, 3);
  const withAudit = { ...reactive, trial: { ...cutTrial, judgeAudit: cutAudit } };
  const withReceipt = { ...reactive, trial: { ...cutTrial, judgeReceipt: cutReceipt } };
  assert.equal(hasCompleteJudgment(withAudit), true);
  assert.equal(hasCompleteJudgment(withReceipt), true);
  const both: [string, (value: typeof withAudit) => void][] = [
    ['judgedBeforeSeq removed', value => { delete value.trial.judgedBeforeSeq; }],
    ['judgedBeforeSeq changed', value => { value.trial.judgedBeforeSeq = 2; }],
  ];
  for (const [name, mutate] of both) {
    for (const base of [withAudit, withReceipt]) {
      const value = structuredClone(base);
      mutate(value);
      assert.equal(hasCompleteJudgment(value), false, `${name} must fail (${base.trial.judgeAudit ? 'audit' : 'receipt'})`);
    }
  }
  const audited: [string, (value: typeof withAudit) => void][] = [
    ['prefix vote input replaced by the whole dialogue', value => {
      value.trial.judgeAudit!.attempts.find(a => a.metricId === 'goal')!.input = wholeAudit.attempts.find(a => a.metricId === 'goal')!.input; }],
    ['protocol relabelled v10', value => { value.trial.judgeAudit!.protocolHash = JUDGE_PROTOCOL_V10; }],
  ];
  for (const [name, mutate] of audited) {
    const value = structuredClone(withAudit);
    mutate(value);
    assert.equal(hasCompleteJudgment(value), false, `${name} must fail (audit)`);
  }
  const receipted: [string, (value: typeof withReceipt) => void][] = [
    ['cutBefore changed', value => { value.trial.judgeReceipt!.cutBefore = 2; }],
    ['cutBefore removed', value => { delete value.trial.judgeReceipt!.cutBefore; }],
    ['protocol relabelled v10', value => { value.trial.judgeReceipt!.protocolHash = JUDGE_PROTOCOL_V10; }],
  ];
  for (const [name, mutate] of receipted) {
    const value = structuredClone(withReceipt);
    mutate(value);
    assert.equal(hasCompleteJudgment(value), false, `${name} must fail (receipt)`);
  }
  assert.equal(hasCompleteJudgment(structuredClone(withReceipt)), true, 'tampering never touched the original');

  // A cut without any failing fidelity vote cannot hide in a receipt.
  const wholeTrial: Trial = { ...reactiveTrial, assessments: wholeResult };
  const wholeReceipt = seal(wholeAudit, wholeTrial);
  assert.equal(wholeReceipt.cutBefore, undefined);
  assert.equal(hasCompleteJudgment({ ...reactive, trial: { ...wholeTrial, judgeReceipt: wholeReceipt } }), true);
  assert.equal(hasCompleteJudgment({ ...reactive, trial: { ...wholeTrial, judgedBeforeSeq: 3, judgeReceipt: { ...wholeReceipt, cutBefore: 3 } } }), false);

  // The same judgment without a cut, relabelled v10, verifies in both paths; v10 never carries a cut.
  const v10Audit = { ...structuredClone(wholeAudit), protocolHash: JUDGE_PROTOCOL_V10 };
  assert.equal(hasCompleteJudgment({ ...reactive, trial: { ...wholeTrial, judgeAudit: v10Audit } }), true);
  const v10Receipt = seal(v10Audit, wholeTrial);
  assert.equal(v10Receipt.complete, true);
  assert.equal(hasCompleteJudgment({ ...reactive, trial: { ...wholeTrial, judgeReceipt: v10Receipt } }), true);
  assert.equal(hasCompleteJudgment({ ...reactive, trial: { ...wholeTrial, judgeReceipt: { ...v10Receipt, cutBefore: 3 } } }), false);
  assert.equal(hasCompleteJudgment({ ...reactive, trial: { ...wholeTrial, judgedBeforeSeq: 3, judgeReceipt: v10Receipt } }), false);
  assert.equal(hasCompleteJudgment({ ...reactive, trial: { ...wholeTrial, judgedBeforeSeq: 3, judgeAudit: v10Audit } }), false);

  // A v10 writer judged every rubric on the whole dialogue even when fidelity failed.
  const v10Failing: JudgeAudit = { ...structuredClone(wholeAudit), protocolHash: JUDGE_PROTOCOL_V10, attempts: [
    ...structuredClone(cutAudit.attempts.filter(a => a.metricId === 'user_fidelity')),
    ...structuredClone(wholeAudit.attempts.filter(a => a.metricId === 'goal')),
  ] };
  const failingTrial: Trial = { ...reactiveTrial, assessments: cutResult };
  assert.equal(hasCompleteJudgment({ ...reactive, trial: { ...failingTrial, judgeAudit: v10Failing } }), true, 'a v10 audit never gets prefix semantics');
  assert.equal(auditCut(v10Failing, reactiveTrial.events), undefined);
  const relabelled = { ...v10Failing, protocolHash: JUDGE_PROTOCOL };
  assert.equal(hasCompleteJudgment({ ...reactive, trial: { ...failingTrial, judgeAudit: relabelled } }), false, 'labelled v11 it needs a cut');
  assert.equal(hasCompleteJudgment({ ...reactive, trial: { ...failingTrial, judgedBeforeSeq: 3, judgeAudit: relabelled } }), false, 'and its agent votes on the prefix');
});

test('judge protocol v10 is frozen and v11 is pinned', () => {
  assert.equal(JUDGE_PROTOCOL_V10, '32c413cf3a12121a697981a18b5e5c4a1d05934150ab3032800b6fa4934d5736');
  assert.equal(fingerprint(JUDGE_PROMPT), '891c8c65226e2f6cb3eab30638da3c288fd6d488d833faa5811d9b91ab58d210');
  assert.equal(fingerprint(JUDGE_RESPONSE_FORMAT), 'd367899779956e5fa0ac227dfe9905e89e3ff459a0afe4e43886bd26602854de');
  assert.equal(JUDGE_PROTOCOL, '9b08dc89e9fd8b042c244cc95c716a9d7ae7ced30416fde7e30656f3b07889ee');
});

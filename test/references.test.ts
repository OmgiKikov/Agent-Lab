import assert from 'node:assert/strict';
import { test } from 'node:test';
import { grade } from '../src/evaluation.js';
import { describeCheck, emptyUsage, referenceSchema, REFERENCE_METRIC_ID, scenarioSchema, unconfirmedReferences, validatePreparation, withReferenceCriteria, type Check, type Scenario, type TraceEvent, type Trial } from '../src/contracts.js';

const baseCard = {
  id: 'card_1', familyId: 'card_1', title: 'Возврат', requirementIds: [], provenance: 'production' as const,
  user: { goal: 'g', facts: 'f', behavior: 'b', opening: 'Сколько ждать возврат?', maxFollowUps: 0 },
  initialState: { records: {}, writableFields: [], transientFailures: 0 }, checks: [],
};

test('reference needs a source or a text', () => {
  assert.equal(referenceSchema.safeParse({ id: 'r1', origin: 'owner', confirmed: true }).success, false);
  assert.equal(referenceSchema.safeParse({ id: 'r1', origin: 'owner', confirmed: true, text: 'До 5 рабочих дней' }).success, true);
  assert.equal(referenceSchema.safeParse({ id: 'r1', origin: 'assessor', confirmed: true, source: { doc: 'ACQ-123', chunk: 'c7' } }).success, true);
});

test('only a model proposal may stay unconfirmed', () => {
  assert.equal(referenceSchema.safeParse({ id: 'r1', origin: 'assessor', confirmed: false, text: 'x 5' }).success, false);
  assert.equal(referenceSchema.safeParse({ id: 'r1', origin: 'proposed', confirmed: false, text: 'x 5' }).success, true);
});

test('a card without references parses exactly as before', () => {
  const parsed = scenarioSchema.parse(baseCard);
  assert.equal('references' in parsed, false);
});

test('a card holds at most four references with unique ids', () => {
  const reference = (id: string) => ({ id, origin: 'owner', confirmed: true, text: 'До 5 дней' });
  assert.equal(scenarioSchema.safeParse({ ...baseCard, references: ['a', 'b', 'c', 'd'].map(reference) }).success, true);
  assert.equal(scenarioSchema.safeParse({ ...baseCard, references: ['a', 'b', 'c', 'd', 'e'].map(reference) }).success, false);
  assert.equal(scenarioSchema.safeParse({ ...baseCard, references: ['a', 'a'].map(reference) }).success, false);
});

test('derived checks describe themselves to the owner', () => {
  assert.equal(describeCheck({ id: 'x', description: 'd', kind: 'source_retrieved', doc: 'ACQ-123', chunk: 'c7' }), 'Найдена статья ACQ-123, фрагмент c7');
  assert.equal(describeCheck({ id: 'x', description: 'd', kind: 'answer_reference_tokens', value: 'До 5 рабочих дней, комиссия 1.5%' }), 'В ответах есть значения эталона: 1.5');
});

const source = { id: 'source-1', name: 'policy', content: 'Rule one: read before update.', hash: 'h' };
const requirement = { id: 'req_1', text: 'Read before update', sourceId: 'source-1', quote: 'read before update', critical: true };
const prepare = (scenario: unknown) => validatePreparation({ requirements: [requirement], questions: [], scenarios: [scenario] }, [source]);

const card = (references: unknown[], extra: Partial<Scenario> = {}) =>
  scenarioSchema.parse({ ...baseCard, metrics: [{ id: 'm', name: 'M', subject: 'agent', description: 'd', passCriteria: 'p', failCriteria: 'f' }], references, ...extra });

test('a source reference becomes a retrieval check at the search stage', () => {
  const { checks } = withReferenceCriteria(card([{ id: 'r1', origin: 'assessor', confirmed: true, source: { doc: 'ACQ-123' } }]));
  assert.deepEqual(checks.map(c => [c.id, c.kind, c.stage]), [['ref_r1_source', 'source_retrieved', 'поиск']]);
});

test('a text reference with values becomes a token check and a judge rubric', () => {
  const { checks, metrics } = withReferenceCriteria(card([{ id: 'r1', origin: 'owner', confirmed: true, text: 'Возврат до 5 рабочих дней, до 15:00' }]));
  assert.deepEqual(checks.map(c => c.kind), ['answer_reference_tokens']);
  assert.ok(metrics?.some(m => m.id === REFERENCE_METRIC_ID && m.passCriteria.includes('Возврат до 5 рабочих дней')));
});

test('a text reference without values gets only the judge rubric', () => {
  const { checks, metrics } = withReferenceCriteria(card([{ id: 'r1', origin: 'owner', confirmed: true, text: 'Нужно обратиться в отделение' }]));
  assert.equal(checks.length, 0);
  assert.ok(metrics?.some(m => m.id === REFERENCE_METRIC_ID));
});

test('derivation replaces stale derived criteria instead of accumulating them', () => {
  const once = card([{ id: 'r1', origin: 'owner', confirmed: true, source: { doc: 'A-1' }, text: 'Срок 5 дней до 15:00' }]);
  const twice = { ...once, ...withReferenceCriteria(once) };
  const edited = { ...twice, references: [{ id: 'r1', origin: 'owner' as const, confirmed: true, source: { doc: 'B-2' } }] };
  const { checks, metrics } = withReferenceCriteria(edited);
  assert.deepEqual(checks.map(c => c.kind === 'source_retrieved' ? c.doc : c.kind), ['B-2']);
  assert.equal(metrics?.some(m => m.id === REFERENCE_METRIC_ID), false);
});

test('a card without references keeps its criteria object-identical', () => {
  const plain = scenarioSchema.parse({ ...baseCard, checks: [{ id: 'c', kind: 'answer_contains', description: 'd', value: 'x' }] });
  const derived = withReferenceCriteria(plain);
  assert.equal(derived.checks, plain.checks);
  assert.equal(derived.metrics, plain.metrics);
});

test('unconfirmed proposals are listed as card/reference', () => {
  const scenarios = [card([{ id: 'r1', origin: 'proposed', confirmed: false, text: 'Срок 5 дней' }]), card([])];
  assert.deepEqual(unconfirmedReferences(scenarios), ['card_1/r1']);
});

test('validation materialises reference criteria into the card', () => {
  const prepared = prepare({ ...card([{ id: 'r1', origin: 'owner', confirmed: true, source: { doc: 'ACQ-1' } }]), successCriteria: 's' });
  assert.ok(prepared.scenarios[0]!.checks.some(c => c.kind === 'source_retrieved'));
});

test('validation leaves a card without references byte-identical', () => {
  const plain = { ...scenarioSchema.parse({ ...baseCard, checks: [{ id: 'c', kind: 'answer_contains', description: 'd', value: 'x' }] }), successCriteria: 's' };
  const prepared = prepare(structuredClone(plain));
  const { split: _, ...card } = prepared.scenarios[0]!;
  assert.equal(JSON.stringify(card), JSON.stringify(plain));
});

const world = { records: {}, writableFields: [], transientFailures: 0 };
const gradedCard = (checks: Check[]): Scenario => ({ ...scenarioSchema.parse({ ...baseCard, checks }), split: 'dev' });
const trialWith = (events: TraceEvent[]): Trial => ({ id: 't', revisionId: 'r', scenarioId: 'card_1', familyId: 'card_1', repeat: 0,
  userMode: 'static', split: 'dev', manifestHash: 'h', outcome: 'ungraded', reason: '', checks: [], events,
  initialState: world, finalState: world, usage: emptyUsage(), elapsedMs: 0, observation: { state: 'missing', tools: 'complete' } });
const retrieval = (chunks: unknown[], complete: boolean): TraceEvent => ({ seq: 2, type: 'retrieval', result: { chunks, complete } });
const dialogue = (middle: TraceEvent, answer = 'Возврат займёт до 5 рабочих дней.'): TraceEvent[] =>
  [{ seq: 1, type: 'user', text: 'Сколько ждать?' }, middle, { seq: 3, type: 'assistant', text: answer }];
const sourceCheck = (chunk?: string): Check => ({ id: 's', kind: 'source_retrieved', description: 'd', doc: 'ACQ-123', ...(chunk ? { chunk } : {}) });

test('retrieved article passes', () => {
  const [result] = grade(gradedCard([sourceCheck()]), trialWith(dialogue(retrieval([{ source: 'ACQ-123', content: 'x' }], true))));
  assert.equal(result!.passed, true);
});

test('missing article fails when the adapter confirmed the full context', () => {
  const [result] = grade(gradedCard([sourceCheck()]), trialWith(dialogue(retrieval([{ source: 'OTHER', content: 'x' }], true))));
  assert.equal(result!.passed, false);
});

test('missing article without confirmed context is not measured', () => {
  assert.throws(() => grade(gradedCard([sourceCheck()]), trialWith(dialogue(retrieval([{ source: 'OTHER', content: 'x' }], false)))), /retrievalsComplete/);
});

test('chunk-level reference needs the same chunk', () => {
  const trial = trialWith(dialogue(retrieval([{ source: 'ACQ-123', chunkId: 'c1', content: 'x' }], true)));
  assert.equal(grade(gradedCard([sourceCheck('c7')]), trial)[0]!.passed, false);
  assert.equal(grade(gradedCard([sourceCheck('c1')]), trial)[0]!.passed, true);
});

test('reference tokens pass only when every value is in the replies', () => {
  const check: Check = { id: 'v', kind: 'answer_reference_tokens', description: 'd', value: 'до 15:00, комиссия 1.5%' };
  const noValue: TraceEvent = { seq: 2, type: 'observation' };
  assert.equal(grade(gradedCard([check]), trialWith(dialogue(noValue, 'Комиссия 1.5%, приём до 15:00.')))[0]!.passed, true);
  assert.equal(grade(gradedCard([check]), trialWith(dialogue(noValue, 'Комиссия 2%, приём до 15:00.')))[0]!.passed, false);
});

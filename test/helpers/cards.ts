import { settingsSchema, type Experiment, type MetricAssessment, type Requirement, type Scenario, type Trial } from '../../src/contracts.js';
import { compileCard } from '../../src/card/compile.js';
import { cardSchema, type Card } from '../../src/card/schema.js';

/*
 * A card of the brief format and the runs of its compiled definition, for the compiler and the counting
 * tests. Invented refund example; no owner data.
 */

export const requirements: Requirement[] = [
  { id: 'refund_rule', sourceId: 'rules', text: 'Номер терминала запрашивается один раз; затем объясняется возврат.', quote: 'Если номер терминала уже указан, не запрашивайте его повторно', critical: true },
  { id: 'receipt_rule', sourceId: 'rules', text: 'Без чека возврат оформляется по выписке.', quote: 'Без чека возврат оформляется по выписке', critical: false },
];

const event = (eventIndex: number) => ({ batchId: 'batch_1', dialogueId: 'late', eventIndex });

/** A card with every kind of fact: named at once, named on request (two), and not known. */
export function briefCard(overrides: { turn?: Card['client']['turn'] | null; agentMust?: Card['agentMust'] } = {}): Card {
  const turn = overrides.turn === undefined
    ? { kind: 'change_intent' as const, after: 'агент объяснил, как оформить возврат', says: 'Тогда лучше отмените покупку.', source: { kind: 'dialogue' as const, event: event(4) } }
    : overrides.turn;
  return cardSchema.parse({
    id: `card_${'c'.repeat(64)}`, number: 3, title: 'Возврат без номера в первой реплике', topic: 'Возврат оплаты',
    origin: { kind: 'dialogue', batchId: 'batch_1', dialogueId: 'late' },
    client: {
      wants: 'Получить инструкцию по возврату', writes: 'Помогите с возвратом, я Анна.', writesSource: { kind: 'dialogue', event: event(0) },
      knows: [
        { id: 'f1', label: 'Имя', value: 'Анна', disclosure: 'initial', source: { kind: 'dialogue', event: event(0) } },
        { id: 'f2', label: 'Номер терминала', value: '5678', disclosure: 'on_request', askedAs: 'номер терминала', source: { kind: 'dialogue', event: event(2) } },
        { id: 'f3', label: 'Сумма', value: 1200, disclosure: 'on_request', source: { kind: 'dialogue', event: event(2) } },
        { id: 'f4', label: 'Дата покупки', value: '12.03.2026', disclosure: 'unknown', source: { kind: 'unconfirmed' } },
      ],
      leaves: 'получил инструкцию по возврату или понял, что агент не поможет',
      ...(turn ? { turn } : {}),
    },
    agentMust: overrides.agentMust ?? [
      { id: 'e1', text: 'запросить номер терминала не больше одного раза', requirementIds: ['refund_rule'], observation: 'reply' },
      { id: 'e2', text: 'объяснить, как оформить возврат', requirementIds: ['refund_rule'], appliesWhen: 'клиент назвал номер терминала', observation: 'reply' },
      { id: 'e3', text: 'предложить возврат по выписке', requirementIds: ['receipt_rule'], observation: 'reply' },
    ],
    coverage: [{ event: event(2), as: 'fact' }, ...(turn ? [{ event: event(4), as: 'turn' }] : [])],
    revision: 1,
  });
}

export const compiledCard = (card: Card = briefCard()): Scenario => compileCard(card, { requirements });

/** One attempt: the opening, the agent's reply (seq 1) and the controller closing the dialogue; a vote per expectation. */
export function cardAttempt(id: string, scenario: Scenario, results: Record<string, 'pass' | 'fail' | 'unknown'>, repeat = 0, extra: Partial<Trial> = {}): Trial {
  const assessments: MetricAssessment[] = Object.entries(results).map(([metricId, result]) => ({ metricId, result, rationale: 'Оценка', evidence: result === 'unknown' ? [] : [1] }));
  return { id, revisionId: 'r', scenarioId: scenario.id, familyId: scenario.familyId, userMode: 'reactive', repeat, split: 'dev', manifestHash: 'h', outcome: 'ungraded', reason: '',
    checks: [], events: [{ seq: 0, type: 'user', text: scenario.user.opening }, { seq: 1, type: 'assistant', text: 'Уточните номер терминала.' },
      { seq: 2, type: 'simulator', result: { decision: { actionId: 'leave' }, accepted: true } }],
    initialState: scenario.initialState, finalState: scenario.initialState, usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, elapsedMs: 1,
    observation: { state: 'missing', tools: 'partial' }, assessments, ...extra };
}

/** A finished run of compiled cards: `repeats` attempts per card, reactive client. */
export function cardRun(scenarios: Scenario[], trials: Trial[], repeats = 1, overrides: Partial<Experiment> = {}): Experiment {
  return { schemaVersion: '1', id: 'card_run', task: 'Возвраты', mode: 'live', workflow: 'evaluate', createdAt: 'now', updatedAt: 'now', phase: 'results_review', message: '',
    sources: [{ id: 'rules', name: 'Правила', content: `${requirements[0]!.quote}. ${requirements[1]!.quote}.`, hash: 'h' }],
    settings: settingsSchema.parse({ userModes: ['reactive'], repeats }), target: { kind: 'command', command: 'node', args: ['agent.mjs'] },
    requirements, questions: [], goldenCases: [], dialogues: [], profiles: [], scenarios, revisions: [], selectedRevisionId: null, manifestHash: 'h',
    reviewedAt: 'now', reviewMode: 'human', controlConsumedAt: null, trials, comparisons: [], iterations: [], usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    error: null, limitations: [], humanReviews: [], ...overrides } as Experiment;
}

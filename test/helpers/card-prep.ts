import type { z } from 'zod';
import { createInputSchema, type CreateInput, type Requirement } from '../../src/contracts.js';
import type { MetricAssessment } from '../../src/assessment.js';
import type { Runtime } from '../../src/runtime.js';
import { demoTarget } from '../../src/demo.js';
import type { CardProposal, CardProposalRequest, DialogueProposal, RulesProposal } from '../../src/card/proposal.js';
import type { CardReviewRequest, ReviewVerdict } from '../../src/card/review.js';

/*
 * Invented refund dialogues, one owner rule and a deterministic runtime for preparing cards: grounding, proposals,
 * the reviewer, the controlled customer and the judge all answer by fixed rules. No model is called; no owner data.
 */

export const policy = 'Если номер терминала уже указан, не запрашивайте его повторно; объясните, как оформить возврат. Если номера нет, уточните номер терминала.';
export const refundRule: Omit<Requirement, 'sourceId'> = { id: 'refund_rule', text: 'Номер терминала запрашивается один раз, затем объясняется возврат.',
  quote: 'Если номер терминала уже указан, не запрашивайте его повторно; объясните, как оформить возврат.', critical: true };

export const dialogues = [
  { id: 'late', messages: [
    { role: 'user' as const, content: 'Помогите с возвратом.' },
    { role: 'assistant' as const, content: 'Уточните номер терминала.' },
    { role: 'user' as const, content: 'Номер терминала: 5678' },
    { role: 'assistant' as const, content: 'Возврат возможен. Подайте заявление в поддержку.' },
    { role: 'user' as const, content: 'Спасибо!' },
  ] },
  { id: 'known', messages: [
    { role: 'user' as const, content: 'Номер терминала: 1234. Помогите с возвратом.' },
    { role: 'assistant' as const, content: 'Уточните номер терминала.' },
  ] },
];

const duties = (appliesWhen: string | null): DialogueProposal['agentMust'] => [
  { text: 'не запрашивать номер терминала повторно, если клиент его уже назвал', requirementIds: ['refund_rule'], appliesWhen: null, observation: 'reply' },
  { text: 'объяснить, как оформить возврат', requirementIds: ['refund_rule'], appliesWhen, observation: 'reply' },
];
const leaves = 'получил инструкцию по возврату или понял, что агент не поможет';

/** What a careful model proposes for each dialogue. */
export const proposals: Record<'late' | 'known', DialogueProposal> = {
  late: { title: 'Возврат оплаты — номер по просьбе', topic: 'Возврат оплаты', wants: 'Получить инструкцию по возврату оплаты', writesEvent: 0,
    knows: [{ label: 'Номер терминала', value: '5678', disclosure: 'on_request', from: 2, askedAs: 'номер терминала' }],
    leaves, turn: null, agentMust: duties('клиент назвал номер терминала'),
    coverage: { 2: { as: 'fact', reason: null }, 4: { as: 'stop', reason: null } } },
  known: { title: 'Возврат оплаты — номер назван сразу', topic: 'Возврат оплаты', wants: 'Получить инструкцию по возврату оплаты', writesEvent: 0,
    knows: [{ label: 'Номер терминала', value: '1234', disclosure: 'initial', from: 0, askedAs: 'номер терминала' }],
    leaves, turn: null, agentMust: duties(null), coverage: {} },
};

/** A situation from the owner's rules alone: each one opens differently. */
export const rulesProposal = (index: number): RulesProposal => ({ title: `Возврат без логов ${index}`, topic: 'Возврат оплаты', wants: 'Узнать, как вернуть оплату',
  writes: index === 1 ? 'Как вернуть оплату за покупку?' : 'Хочу вернуть деньги за покупку, что делать?', leaves: 'получил инструкцию по возврату', agentMust: [duties(null)[1]!] });

/** The fixture task; `overrides` are schema input, so a dialogue without an outcome takes the schema's default. */
export function cardInput(overrides: Partial<z.input<typeof createInputSchema>> = {}): CreateInput {
  return createInputSchema.parse({ task: 'Проверить возвраты', mode: 'live', target: demoTarget(), scenarioCount: 0,
    materials: [{ name: 'Правила возвратов', content: policy }], dialogues,
    settings: { provider: 'deterministic', model: 'fixture', repeats: 1, maxTurns: 3, maxCalls: 60, userModes: ['reactive'] }, ...overrides });
}

const ready: ReviewVerdict = { status: 'ready', reason: 'Подтверждено разговором и правилом владельца.' };

/** The requests each role received, in order. */
export interface Received { proposals: CardProposalRequest[]; reviews: CardReviewRequest[]; grounding: number }

/**
 * Grounds the one rule, proposes the careful card of each dialogue (or of the rules), accepts every claim, plays a
 * customer who names what the agent asks for and leaves otherwise, and judges the two duties from the dialogue.
 */
export function cardRuntime(received: Received = { proposals: [], reviews: [], grounding: 0 }): Runtime {
  return {
    async groundRequirements(input, ctx) {
      ctx.beforeCall(); received.grounding++;
      return { requirements: [{ ...refundRule, sourceId: input.sources[0]!.id }], questions: [] };
    },
    async proposeCard(request, ctx): Promise<CardProposal> {
      ctx.beforeCall(); received.proposals.push(structuredClone(request));
      const { source } = request.call;
      return source.kind === 'dialogue' ? proposals[source.dialogueId as 'late' | 'known'] : rulesProposal(request.written.length + 1);
    },
    async reviewCard(request, ctx) {
      ctx.beforeCall(); received.reviews.push(structuredClone(request));
      return { verdicts: Object.fromEntries(request.aliases.map(alias => [alias, ready])), model: 'fixture/reviewer' };
    },
    async selectUserAction(input) {
      const asked = (input.messages.at(-1)?.content ?? '').includes('номер терминала');
      const tell = input.actions.find(action => action.id.startsWith('tell_'));
      return { actionId: asked && tell ? tell.id : 'leave' };
    },
    /** Duty А fails when the agent asks for a number it was already given; duty Б passes when it explains how to apply. */
    async assess({ scenario, trial }) {
      let given = false, repeated = false;
      for (const event of trial.events) {
        if (event.type === 'user' && (event.text ?? '').includes('терминала: ')) given = true;
        if (event.type === 'assistant' && given && (event.text ?? '').includes('номер терминала')) repeated = true;
      }
      const replies = trial.events.filter(event => event.type === 'assistant');
      const explained = replies.some(event => (event.text ?? '').includes('Подайте заявление'));
      return (scenario.metrics ?? []).map((metric): MetricAssessment => {
        const pass = metric.id === 'e1' ? !repeated : explained;
        return { metricId: metric.id, result: pass ? 'pass' : 'fail', evidence: [replies.at(-1)!.seq], rationale: pass ? 'Выполнено.' : 'Не выполнено.' };
      });
    },
  };
}

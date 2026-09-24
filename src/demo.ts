import { fileURLToPath } from 'node:url';
import { createInputSchema, type CreateInput, type RunnableTarget } from './contracts.js';
import type { MetricAssessment } from './assessment.js';
import type { Runtime } from './runtime.js';
import type { DialogueProposal } from './card/proposal.js';
import type { ReviewVerdict } from './card/review.js';
import { buildTopicMap, type TopicTaskRunner } from './miner/topic-map.js';

/*
 * The built-in teaching example: two invented refund dialogues, one owner rule and a small module
 * agent with a deliberate defect (it asks again for a terminal number it was already given).
 * Preparation, the reviewer, the user controller and the judge are deterministic stand-ins, so the
 * example goes through the real card path — two situations, one question for the owner, acceptance,
 * run — without a model. It is never evidence of model quality. Runs of the old example, made in the
 * first library format, still open and repeat: the controller knows their `disclose` move and the
 * judge their two checkpoints, which a repeat judges as expectations (card/legacy-v1.ts).
 */
const demoPolicy = 'Если номер терминала уже указан, не запрашивайте его повторно; объясните возврат. Если номера нет, уточните номер терминала.';
const demoDialogues = [
  { id: 'known', messages: [{ role: 'user' as const, content: 'Номер терминала: 1234. Помогите с возвратом.' }, { role: 'assistant' as const, content: 'Уточните номер терминала.' }] },
  { id: 'late', messages: [{ role: 'user' as const, content: 'Помогите с возвратом.' }, { role: 'assistant' as const, content: 'Уточните номер терминала.' }, { role: 'user' as const, content: 'Номер терминала: 5678' }] },
];

/** The teaching agent; `fixed` is the corrected version that no longer asks for a number it already has. Resolved from src and from dist alike. */
export function demoTarget(fixed = false): RunnableTarget {
  return { kind: 'module', path: fileURLToPath(new URL('../examples/scenario-lab-target.mjs', import.meta.url)), exportName: fixed ? 'createFixedSession' : 'createSession' };
}

/** A two-dialogue library prepared by the deterministic demo runtime against the teaching agent. */
export function demoInput(): CreateInput {
  return createInputSchema.parse({
    task: 'Учебная проверка возвратов: два вымышленных диалога', mode: 'demo', target: demoTarget(),
    materials: [{ name: 'Учебное правило владельца', content: demoPolicy }], dialogues: demoDialogues, scenarioCount: 0,
    existingAgent: { name: 'Учебный агент возвратов', instructions: demoPolicy, tools: [] },
    settings: { repeats: 2, maxCalls: 60, maxTurns: 3, maxDurationMs: 300000, timeoutMs: 60000, userModes: ['reactive'] },
  });
}

/** Every duty of the example rests on the owner's one rule, cited whole from the example's one material (materialSources numbers it source-1). */
const DEMO_BASIS: DialogueProposal['agentMust'][number]['basis'] = [{ sourceId: 'source-1', quote: demoPolicy,
  rule: 'Номер терминала не запрашивается повторно; затем объясняется возврат.', kind: 'behavior' }];
/** What a careful model proposes for each example dialogue: the number named at once, and the number named only when asked. */
const DEMO_CARDS: Record<'known' | 'late', DialogueProposal> = {
  known: { title: 'Возврат оплаты — номер назван сразу', topic: 'Возврат оплаты', wants: 'Получить инструкцию по возврату оплаты', writesEvent: 0,
    knows: [{ label: 'Номер терминала', value: '1234', disclosure: 'initial', from: 0, askedAs: 'номер терминала' }], plausibleKnows: [],
    leaves: 'получил инструкцию по возврату или понял, что агент не поможет', turn: null, coverage: {},
    agentMust: [{ text: 'не спрашивать номер терминала ещё раз, если клиент его уже назвал', basis: DEMO_BASIS, appliesWhen: null, observation: 'reply' },
      { text: 'объяснить, как оформить возврат', basis: DEMO_BASIS, appliesWhen: null, observation: 'reply' }] },
  late: { title: 'Возврат оплаты — номер только по просьбе', topic: 'Возврат оплаты', wants: 'Получить инструкцию по возврату оплаты', writesEvent: 0,
    knows: [{ label: 'Номер терминала', value: '5678', disclosure: 'on_request', from: 2, askedAs: 'номер терминала' }], plausibleKnows: [],
    leaves: 'получил инструкцию по возврату или понял, что агент не поможет', turn: null, coverage: { 2: { as: 'fact', reason: null } },
    agentMust: [{ text: 'спросить номер терминала один раз, до инструкции', basis: DEMO_BASIS, appliesWhen: null, observation: 'reply' },
      { text: 'объяснить, как оформить возврат', basis: DEMO_BASIS, appliesWhen: 'клиент назвал номер терминала', observation: 'reply' }] },
};
/** The example's one question for the owner: the number the customer named only after the agent asked — did they know it before? */
const DEMO_DOUBT: ReviewVerdict = { status: 'needs_owner', reason: 'В исходном разговоре клиент назвал номер только после вопроса агента.' };
const DEMO_READY: ReviewVerdict = { status: 'ready', reason: 'Учебный пример проверен по заранее заданным правилам; это не оценка модели.' };
/** The judge's reading of each duty: the stored example's checkpoints and a card's expectations name the same two duties. */
const DUTY: Record<string, 'ask' | 'explain'> = { ask_once: 'ask', refund_explanation: 'explain', e1: 'ask', e2: 'explain' };

/**
 * The teaching judge and customer play a model reading the replies — a repeated question in other words still counts —
 * over the example's own invented dialogues; they never read an owner's data and measure nothing.
 */
const asksNumber = (text: string) => /(?:уточните|сообщите|назовите|укажите|какой|номер.*\?).*номер|номер.*терминал.*\?/i.test(text);
const DEMO_ONLY = 'Учебный пример поддерживает только свои два диалога и правило владельца. Для своих материалов выберите живой режим с моделью.';

/** The example's topic map is fixed, so its builder names no model: nothing is called and nothing is spent. */
const DEMO_BUILDER = { provider: 'agent-lab', id: 'demo' };
/** Both teaching dialogues ask for a refund: one topic. The answers pass the output contract a model's answer passes. */
const demoTopics: TopicTaskRunner = async (task, input) => {
  const conversations = task.id === 'topic-classification' ? (input as { conversations: { dialogueId: string }[] }).conversations : [];
  if (conversations.some(item => !demoDialogues.some(dialogue => dialogue.id === item.dialogueId))) throw new Error(DEMO_ONLY);
  const value = task.output.parse(task.id === 'topic-proposal'
    ? { topics: [{ title: 'Возврат оплаты', description: 'Клиент просит вернуть оплату за покупку.' }] }
    : { assignments: conversations.map(({ dialogueId }) => ({ dialogueId, topicId: 't1' })) });
  const problem = task.check?.(value);
  if (problem) throw new Error(problem);
  return value;
};

/** Explicit deterministic teaching runtime: no model is called, and nothing here is evidence of model quality. */
export function createDemoRuntime(): Runtime {
  return {
    topicMap: { builder: DEMO_BUILDER, build: (plan, ctx, onProgress) => buildTopicMap(plan, { builder: DEMO_BUILDER, run: demoTopics, ctx, onProgress }) },
    async proposeCard(input) {
      const { source, sources } = input.call;
      if (sources.length !== 1 || sources[0].content !== demoPolicy || source.kind !== 'dialogue' || (source.dialogueId !== 'known' && source.dialogueId !== 'late')) throw new Error(DEMO_ONLY);
      return DEMO_CARDS[source.dialogueId];
    },
    /** Every claim holds except the one the example teaches with: a number named after the agent's question, while no one has vouched for it. */
    async reviewCard(input) {
      const fact = input.payload.card.knows[0];
      const doubted = (alias: string) => alias === 'fact_f1' && fact?.from === 2 && !fact.owner;
      return { verdicts: Object.fromEntries(input.aliases.map(alias => [alias, doubted(alias) ? DEMO_DOUBT : DEMO_READY])), model: 'demo/reviewer' };
    },
    /** The customer names the number when the agent asks for it (a card's `tell_…`, the old example's `disclose`) and leaves otherwise. */
    async selectUserAction(input) {
      const reply = input.messages.filter(m => m.role === 'assistant').at(-1)?.content ?? '';
      const tell = input.actions.find(a => a.id === 'disclose' || a.id.startsWith('tell_'));
      return { actionId: tell && asksNumber(reply) ? tell.id : input.actions.some(a => a.id === 'finish') ? 'finish' : 'leave' };
    },
    /** The teaching judge: each duty of the example — a card's expectation or the old example's checkpoint — by a fixed reading of the dialogue. */
    async assess({ scenario, trial }) {
      let hasNumber = false, repeated = false, asked = false;
      for (const event of trial.events) {
        if (event.type === 'user' && /терминала:\s*\d+/i.test(event.text ?? '')) hasNumber = true;
        if (event.type === 'assistant' && asksNumber(event.text ?? '')) { repeated ||= hasNumber; asked = true; }
      }
      const openingHasNumber = /терминала:\s*\d+/i.test(trial.events.find(e => e.type === 'user')?.text ?? '');
      const replies = trial.events.filter(e => e.type === 'assistant');
      const explained = replies.some(e => /Подайте заявление в поддержку/i.test(e.text ?? ''));
      return (scenario.metrics ?? []).map((metric): MetricAssessment => {
        const duty = DUTY[metric.id];
        const pass = duty === 'ask' ? !repeated && (openingHasNumber || asked) : duty === 'explain' ? hasNumber && explained : undefined;
        return pass === undefined
          ? { metricId: metric.id, result: 'unknown', evidence: [], rationale: 'Учебный судья оценивает только ожидания учебной карточки.' }
          : { metricId: metric.id, result: pass ? 'pass' : 'fail', evidence: replies.map(e => e.seq),
            rationale: duty === 'ask' ? `Учебная проверка: номер запрошен=${asked}, повтор после раскрытия=${repeated}` : 'Учебная проверка наличия конкретной инструкции; не оценка произвольных модельных формулировок' };
      });
    },
  };
}

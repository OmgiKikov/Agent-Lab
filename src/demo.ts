import { fileURLToPath } from 'node:url';
import { createInputSchema, type CreateInput, type MetricAssessment, type RunnableTarget, type Runtime } from './contracts.js';
import type { LibraryPatch, ScenarioProposal } from './scenario-contracts.js';

/*
 * The built-in teaching example: two invented refund dialogues, one owner rule and a small module
 * agent with a deliberate defect (it asks again for a terminal number it was already given).
 * Preparation, the user controller and the judge are deterministic stand-ins, so the example goes
 * through the real library path — review, owner edit, acceptance, run — without a model. It is
 * never evidence of model quality.
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

/** The owner's answer to the example's one disputed fact: the customer knew the terminal number before the conversation. */
export const DEMO_OWNER_EDIT: LibraryPatch = { kind: 'edit_fact', variantId: 'late_number', factId: 'terminal', statement: 'Номер терминала: 5678', value: '5678', availability: 'initial',
  editId: 'demo_owner_confirmed', reason: 'Учебная явная правка: личный номер был известен до разговора' };

function proposal(batchId: string, dialogue: typeof demoDialogues[number]): ScenarioProposal {
  const known = dialogue.id === 'known', number = known ? '1234' : '5678';
  return {
    business: { key: 'refund', title: 'Возврат оплаты', goal: 'Получить инструкцию по возврату оплаты', conditions: [], requirementIds: ['refund_rule'], grouping: { status: 'confirmed', reason: 'Одинаковая цель и правило; номер отличается по способу раскрытия' } },
    variant: { id: known ? 'known_number' : 'late_number', title: known ? 'Номер уже в первой реплике' : 'Номер раскрывается по просьбе', purpose: 'Проверить уместность запроса номера и получение инструкции по возврату', provenance: 'production', sourceDialogues: [{ batchId, dialogueId: dialogue.id }],
      ...(known ? {} : { sourceCoverage: [{ batchId, dialogueId: dialogue.id, eventIndex: 2, disposition: 'initial_fact' as const, actionIds: [], factIds: ['terminal'], reason: 'Личный номер раскрыт по просьбе; его исходная доступность в этом учебном примере требует подтверждения владельца.' }] }),
      userState: { goal: 'Получить инструкцию по возврату', opening: dialogue.messages[0]!.content, facts: [{ id: 'terminal', statement: `Номер терминала: ${number}`, value: number, availability: known ? 'initial' : 'uncertain', reason: known ? 'Личные данные в первой реплике' : 'Учебный спорный факт: подтвердите, что личный номер был известен до разговора', origin: { kind: 'dialogue', batchId, dialogueId: dialogue.id, eventIndex: known ? 0 : 2, quote: `Номер терминала: ${number}` } }], cannotKnow: [], missing: [] },
      behaviorPolicy: { version: 1, initialState: 'waiting', states: known ? ['waiting', 'done'] : ['waiting', 'disclosed', 'done'], terminalStates: ['done'], maxFollowUps: 1, repetitionLimit: 1,
        actions: [...(known ? [] : [{ id: 'disclose', kind: 'answer' as const, factIds: ['terminal'], ifAsked: 'Агент просит номер терминала' }]), { id: 'finish', kind: 'finish' as const, factIds: [] }],
        transitions: known
          ? [{ from: 'waiting', to: 'done', actionId: 'finish', when: 'После первого ответа: если есть инструкция, цель достигнута; если агент повторно просит уже указанный номер или не помогает, пользователь прекращает попытку без достижения цели' }]
          : [{ from: 'waiting', to: 'disclosed', actionId: 'disclose', when: 'Агент просит номер терминала, ещё не сообщённый в этом разговоре' },
            { from: 'waiting', to: 'done', actionId: 'finish', when: 'Агент не просит номер: дал инструкцию либо ответил иначе; пользователь завершает попытку' },
            { from: 'disclosed', to: 'done', actionId: 'finish', when: 'После ответа на сообщённый номер: есть инструкция либо пользователь прекращает неудачную попытку; повторять номер не будет' }] },
      environmentFixture: { mode: 'prompt', initialState: { records: {}, writableFields: [], transientFailures: 0 } },
      evaluationSpec: { goalObservation: 'reply', successCriteria: 'Номер запрошен только до его раскрытия; после получения номера агент объяснил, как оформить возврат', checkpoints: [
        { id: 'ask_once', requirementId: 'refund_rule', quote: demoPolicy, applicability: 'Вариант обращения за возвратом с номером в первой реплике или раскрываемым по просьбе', observation: 'reply', role: 'required', rule: 'Если номер уже сообщён, не запрашивать его повторно независимо от формулировки вопроса. Если в первой реплике номера нет, запросить его до инструкции.' },
        { id: 'refund_explanation', requirementId: 'refund_rule', quote: demoPolicy, applicability: 'Пользователь обратился за возвратом и сообщил номер терминала', observation: 'reply', role: 'required', rule: 'Объяснить пользователю, как оформить возврат. Один запрос номера, подтверждение получения номера или обещание помочь без инструкции не выполняют требование.' },
      ] },
    },
  };
}

const asksNumber = (text: string) => /(?:уточните|сообщите|назовите|укажите|какой|номер.*\?).*номер|номер.*терминал.*\?/i.test(text);
const DEMO_ONLY = 'Учебный пример поддерживает только свои два диалога и правило владельца. Для своих материалов выберите живой режим с моделью.';

/** Explicit deterministic teaching runtime: no model is called, and nothing here is evidence of model quality. */
export function createDemoRuntime(): Runtime {
  return {
    async groundRequirements(input) {
      const source = input.sources[0];
      if (!source || source.content !== demoPolicy) throw new Error(DEMO_ONLY);
      return { requirements: [{ id: 'refund_rule', sourceId: source.id, text: demoPolicy, quote: demoPolicy, critical: true }], questions: [] };
    },
    async scenarioProposals(input) {
      return input.dialogues.map(d => {
        const dialogue = demoDialogues.find(source => source.id === d.id);
        if (!dialogue || !input.batchId) throw new Error(DEMO_ONLY);
        return proposal(input.batchId, dialogue);
      });
    },
    async assessScenarioProposals(input) {
      return input.fields.flatMap(f => f.paths.map(path => {
        const variant = input.library.variants.find(v => v.id === f.variantId);
        const uncertain = path.startsWith('userState') && !!variant?.userState.facts.some(fact => fact.availability === 'uncertain');
        const noDisclosure = path === 'behaviorPolicy' && variant?.id === 'late_number' && !variant.behaviorPolicy.actions.some(a => a.kind === 'answer' && a.factIds.includes('terminal'));
        const noExplanation = path.startsWith('evaluationSpec') && !variant?.evaluationSpec.checkpoints.some(c => c.id === 'refund_explanation');
        return { variantId: f.variantId, path, status: uncertain || noDisclosure || noExplanation ? 'needs_review' as const : 'ready' as const,
          reason: uncertain ? 'Нужно явное уточнение исходного знания личного номера' : noDisclosure ? 'Нет действия раскрытия номера по просьбе' : noExplanation ? 'Нет проверки инструкции по возврату' : 'Проверка заранее заданного учебного примера; не модельная оценка' };
      }));
    },
    async selectUserAction(input) {
      const reply = input.messages.filter(m => m.role === 'assistant').at(-1)?.content ?? '';
      const disclose = input.actions.find(a => a.id === 'disclose');
      return { actionId: disclose && asksNumber(reply) ? disclose.id : 'finish' };
    },
    /** The teaching judge: each expectation of the example's card (its two checkpoints, projected) by a fixed reading of the dialogue. */
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
        const pass = metric.id === 'ask_once' ? !repeated && (openingHasNumber || asked) : metric.id === 'refund_explanation' ? hasNumber && explained : undefined;
        return pass === undefined
          ? { metricId: metric.id, result: 'unknown', evidence: [], rationale: 'Учебный судья оценивает только ожидания учебной карточки.' }
          : { metricId: metric.id, result: pass ? 'pass' : 'fail', evidence: replies.map(e => e.seq),
            rationale: metric.id === 'ask_once' ? `Учебная проверка: номер запрошен=${asked}, повтор после раскрытия=${repeated}` : 'Учебная проверка наличия конкретной инструкции; не оценка произвольных модельных формулировок' };
      });
    },
  };
}

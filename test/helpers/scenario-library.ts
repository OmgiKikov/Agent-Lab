import { importBatch, createLibrary } from '../../src/scenario-library.js';

export const rawDialogues = [
  { id: 'terminal', messages: [{ role: 'user', content: 'Нужна помощь. Номер терминала: 1234' }] },
  { id: 'repeated', messages: [
    { role: 'user', content: 'Когда будет возврат?' },
    { role: 'assistant', content: 'Возврат займёт три дня' },
    { role: 'user', content: 'Значит через три дня?' },
  ] },
];
export const sources = [{ id: 'policy', name: 'Правило', content: 'Уточните номер терминала', hash: 'source-hash' }];
export const requirements = [{ id: 'terminal_rule', sourceId: 'policy', text: 'Уточните номер терминала', quote: 'Уточните номер терминала', critical: true }];

/** Explicit structured model output; tests never derive expectations using the compiler. */
export function proposals(batchId: string) {
  return rawDialogues.map((dialogue, index) => ({
    business: { key: 'refund', title: 'Возврат', goal: 'Узнать условия возврата', conditions: [], requirementIds: ['terminal_rule'], grouping: { status: 'confirmed', reason: 'Одинаковая цель и применимое правило' } },
    variant: {
      id: `variant_${index + 1}`, title: `Возврат ${index + 1}`, purpose: 'Проверить уточнение терминала', provenance: 'production',
      sourceDialogues: [{ batchId, dialogueId: dialogue.id }],
      userState: {
        goal: 'Получить помощь с возвратом', opening: index ? 'Когда будет возврат?' : 'Помогите с возвратом',
        facts: [{ id: index ? 'duration' : 'terminal_number', statement: index ? 'Срок: три дня' : 'Номер терминала: 1234', value: index ? 'три дня' : '1234', availability: index ? 'learned_in_source' : 'initial', reason: index ? 'Повтор ответа старого агента' : 'Личные данные пользователя', origin: { kind: 'dialogue', batchId, dialogueId: dialogue.id, eventIndex: index ? 2 : 0, quote: index ? 'Значит через три дня?' : 'Номер терминала: 1234' } }],
        cannotKnow: ['Внутреннее состояние обработки'], missing: [],
      },
      behaviorPolicy: { version: 1, initialState: 'waiting', states: ['waiting', 'done'], terminalStates: ['done'], maxFollowUps: 2, repetitionLimit: 1,
        actions: [{ id: 'finish', kind: 'finish', factIds: [] }],
        transitions: [{ from: 'waiting', to: 'done', actionId: 'finish', when: 'Получена достаточная инструкция' }],
      },
      environmentFixture: { mode: 'prompt', initialState: { records: {}, writableFields: [] } },
      evaluationSpec: { successCriteria: 'Уточнён номер терминала', goalObservation: 'reply', checkpoints: [{ id: 'ask_terminal', requirementId: 'terminal_rule', quote: 'Уточните номер терминала', applicability: 'При запросе возврата', observation: 'reply', role: 'required', rule: 'Агент уточнил номер терминала' }] },
    },
  }));
}

export function libraryFixture() {
  const batch = importBatch(rawDialogues);
  return createLibrary({ id: 'library', batch, sources, requirements, proposals: proposals(batch.id), createdAt: '2026-09-20T00:00:00.000Z' });
}

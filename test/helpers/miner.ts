import { createHash } from 'node:crypto';
import type { ValidationExclusion } from '../../src/contracts.js';
import { importDialogues } from '../../src/imports.js';
import { ProviderFailure } from '../../src/llm/model-call.js';
import { StructuredTaskError } from '../../src/llm/structured.js';
import { OTHER, TOPIC_MAP_PROMPT_VERSION, topicMapSchema, type Topic, type TopicMap, type TopicTaskRunner } from '../../src/miner/topic-map.js';

/*
 * A synthetic import with its answer key: every logged conversation carries the topic it truly belongs
 * to, and a deterministic runner answers the miner's two tasks from that key through the output contract
 * the harness enforces (the per-call schema, then the check). No model and no network.
 */

export const BUILDER = { provider: 'agent-lab-test', id: 'test-model' };
export const AGENT_REPLY = 'Понимаю, сейчас помогу.';

export const TOPICS = [
  { title: 'Возврат оплаты', description: 'Клиент хочет вернуть деньги за покупку или отменить списание.', says: 'Хочу вернуть деньги за покупку', count: 40 },
  { title: 'Статус заявки', description: 'Клиент спрашивает, на каком этапе его заявка.', says: 'Какой статус моей заявки?', count: 25 },
  { title: 'Смена тарифа', description: 'Клиент хочет перейти на другой тариф.', says: 'Как сменить тариф?', count: 15 },
  { title: 'Подключение терминала', description: 'Клиент не может подключить или настроить терминал.', says: 'Не могу подключить терминал', count: 10 },
  { title: 'Жалоба на сотрудника', description: 'Клиент жалуется на работу сотрудника.', says: 'Хочу пожаловаться на сотрудника', count: 4 },
];
/** A conversation of the synthetic import: its customer's messages and its true topic, a title of TOPICS or OTHER. */
export interface Logged { id: string; customer: string[]; topic: string }

/** 100 usable conversations — 40, 25, 15, 10 and 4 over TOPICS and 6 that fit none — interleaved like real traffic. */
export function world(): Logged[] {
  const queues = [...TOPICS.map(topic => Array.from({ length: topic.count }, () => ({ says: topic.says, topic: topic.title }))),
    Array.from({ length: 6 }, () => ({ says: 'Где ближайшее отделение?', topic: OTHER }))];
  const logged: Logged[] = [];
  while (queues.some(queue => queue.length)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next) logged.push({ id: `d${String(logged.length + 1).padStart(3, '0')}`, customer: ['Здравствуйте!', `${next.says} Обращение ${logged.length + 1}.`], topic: next.topic });
    }
  }
  return logged;
}
/** A customer message fully hidden by de-identification: the import keeps the conversation, the usability check refuses it. */
export const MASKED: Logged = { id: 'd101', customer: ['Здравствуйте!', '*** ***'], topic: OTHER };
/** Seventeen customer messages, one more than a situation can hold. */
export const TOO_LONG: Logged = { id: 'd102', customer: Array.from({ length: 17 }, (_, i) => `Вопрос про лимиты, часть ${i + 1}.`), topic: OTHER };

/** The import batch of `logged`, every customer message answered by the agent as a log holds it. */
export function importOf(logged: readonly Logged[]) {
  return importDialogues(logged.map(item => ({ id: item.id, messages: item.customer.flatMap(content => [{ role: 'user', content }, { role: 'assistant', content: AGENT_REPLY }]) }))).originalImport;
}

export interface Call { id: string; label: string; input: unknown }
type ClassificationInput = { topics: Topic[]; conversations: { dialogueId: string }[] };
/** Sorts each supplied conversation by its known topic, through the ids of the topics the map proposed. */
export function sortedByTruth(input: ClassificationInput, truth: ReadonlyMap<string, string>) {
  return { assignments: input.conversations.map(({ dialogueId }) => ({ dialogueId, topicId: input.topics.find(topic => topic.title === truth.get(dialogueId))?.id ?? OTHER })) };
}

/** Proposes TOPICS and sorts by the answer key; with `failAt`, that call fails the way a provider does, after it was charged. */
export function scriptedRunner(logged: readonly Logged[], options: { failAt?: number } = {}) {
  const truth = new Map(logged.map(item => [item.id, item.topic]));
  const calls: Call[] = [];
  const run: TopicTaskRunner = async (task, input, ctx) => {
    ctx.beforeCall();
    calls.push({ id: task.id, label: task.label, input });
    if (calls.length === options.failAt) throw new ProviderFailure('rate limit', 'Pi provider response incomplete: rate limit');
    const raw = task.id === 'topic-proposal' ? { topics: TOPICS.map(({ title, description }) => ({ title, description })) } : sortedByTruth(input as ClassificationInput, truth);
    const parsed = task.output.safeParse(raw);
    if (!parsed.success) throw new StructuredTaskError(`${task.label}: ${parsed.error.message}`);
    const problem = task.check?.(parsed.data);
    if (problem) throw new StructuredTaskError(`${task.label}: ${problem}`);
    return parsed.data;
  };
  return { run, calls };
}

export const hashOf = (value: string): string => createHash('sha256').update(value).digest('hex');
/** A finished map with `sizes[i]` conversations in topic t(i+1), `other` in «Другое», ids c001… grouped by topic. */
export function mapOf(sizes: readonly number[], options: { other?: number; contentHash?: string; excluded?: ValidationExclusion[] } = {}): TopicMap {
  const topics = sizes.map((_, index) => ({ id: `t${index + 1}`, title: TOPICS[index]?.title ?? `Тема ${index + 1}`, description: TOPICS[index]?.description ?? `Обращения темы ${index + 1}.` }));
  const assignments: Record<string, string> = {};
  const add = (ref: string) => { assignments[`c${String(Object.keys(assignments).length + 1).padStart(3, '0')}`] = ref; };
  sizes.forEach((size, index) => { for (let k = 0; k < size; k++) add(`t${index + 1}`); });
  for (let k = 0; k < (options.other ?? 0); k++) add(OTHER);
  return topicMapSchema.parse({ formatVersion: 1, importId: 'import_synthetic', contentHash: options.contentHash ?? hashOf('synthetic'), model: 'agent-lab-test/test-model',
    promptVersion: TOPIC_MAP_PROMPT_VERSION, topics, assignments, excluded: options.excluded ?? [] });
}

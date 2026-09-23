import { z } from 'zod';
import { identifierSchema as id, sha256Schema as hash, text, uniqueIdsSchema as ids } from '../ids.js';
import { IMPORT_DIALOGUE_LIMIT } from '../limits.js';

/*
 * What the rest of Lab stores of the logs' topic map (topic-map.ts). A card library keeps the traffic of each map
 * it was sampled from, and each card the topic it stands for, so a run's result, repeat or reassessment reads its
 * topics from the record alone — never from the map, the import or the store. A preparation keeps the sample it
 * draws from. A leaf module (zod and field shapes only), so the card schemas can import it without a cycle. Every
 * schema here is stored: a new field is `.optional()`, and parsing stored data returns it unchanged.
 */

/** The conversations that fit no proposed topic: one more topic of the traffic, named «Другое» wherever it is shown. */
export const OTHER = 'other';
export const OTHER_TITLE = 'Другое';
/** Topics one map holds: a business's recurring requests fit, and their rows still fit one screen. */
export const TOPIC_LIMIT = 15;
/** A topic title in the owner's words. */
export const TITLE_CHARS = 60;

/** A topic of one map: t1…t15, numbered by the harness in the order the model proposed them, or «Другое». */
export const topicIdSchema = z.enum([...Array.from({ length: TOPIC_LIMIT }, (_, index) => `t${index + 1}`), OTHER]);

/**
 * The traffic of one import's topic map: the map's identity (it is reused only under the same one) and every topic
 * with conversations — its title and how many conversations it has. `labeled` counts the conversations sorted into
 * a topic, `logged` every conversation of the import, the excluded ones included. Shares are derived, never stored.
 */
export const trafficSchema = z.strictObject({
  importId: id, contentHash: hash, model: z.string().min(1).max(200), promptVersion: hash,
  topics: z.array(z.strictObject({ id: topicIdSchema, title: text(TITLE_CHARS), dialogues: z.number().int().positive() })).min(1).max(TOPIC_LIMIT + 1),
  labeled: z.number().int().positive(), logged: z.number().int().positive(),
}).refine(traffic => new Set(traffic.topics.map(topic => topic.id)).size === traffic.topics.length
  && traffic.labeled === traffic.topics.reduce((sum, topic) => sum + topic.dialogues, 0) && traffic.logged >= traffic.labeled,
'A topic repeats, or the conversations do not add up');
export type Traffic = z.infer<typeof trafficSchema>;

/** The topic of the logs a card stands for: topic `id` of the traffic of import `batchId` in the card's library. */
export const cardTopicSchema = z.strictObject({ batchId: id, id: topicIdSchema });
export type CardTopic = z.infer<typeof cardTopicSchema>;

/** Every topic a card names is a topic of its library's traffic. */
export function topicsKnown(library: { traffic?: readonly Traffic[]; cards: readonly { trafficTopic?: CardTopic }[] }): boolean {
  return library.cards.every(({ trafficTopic: topic }) => !topic || !!library.traffic?.some(traffic => traffic.importId === topic.batchId
    && traffic.topics.some(item => item.id === topic.id)));
}

/**
 * The logs' sample a preparation draws from: per topic of the import's map, its conversations in pick order — one
 * list without topics when the runtime cannot map them. The first conversations of each list are the picks; a pick
 * that makes no situation gives its seat to the next untried conversation of its list.
 */
export const sampleSchema = z.array(z.strictObject({ topicId: topicIdSchema.optional(), dialogueIds: ids(IMPORT_DIALOGUE_LIMIT).min(1) }))
  .min(1).max(TOPIC_LIMIT + 1)
  .refine(strata => new Set(strata.flatMap(stratum => stratum.dialogueIds)).size === strata.reduce((sum, stratum) => sum + stratum.dialogueIds.length, 0),
    'A conversation belongs to one topic');
export type SampleStrata = z.infer<typeof sampleSchema>;

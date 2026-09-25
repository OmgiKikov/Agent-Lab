import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ValidationExclusion } from '../contracts.js';
import type { CallContext } from '../runtime.js';
import { identifierSchema, sha256Schema } from '../ids.js';
import { IMPORT_DIALOGUE_LIMIT } from '../limits.js';
import type { Model } from '../llm/model-call.js';
import type { StructuredTask } from '../llm/structured.js';
import type { ImportBatch, LeftOutIssue } from '../scenario-contracts.js';
import { situationIssue } from '../scenario-library.js';
import { oneLine, safeLine } from '../text.js';
import { OTHER, OTHER_TITLE, TITLE_CHARS, TOPIC_LIMIT } from './schema.js';

export { OTHER, OTHER_TITLE, TOPIC_LIMIT } from './schema.js';

/*
 * The topic map of one import batch (E1): what the customers in these logs contact the business about,
 * and which topic each logged conversation belongs to. Situations are sampled by it (sample.ts) and
 * their coverage of real traffic is measured against it (coverage.ts).
 *
 *   batch ─► every conversation is sorted; the ones no situation can be made of (scenario-library.ts situationIssue)
 *            are marked unsuitable, so the sample never picks them, and still count in their topic's traffic
 *         ─► seeded sample of customer openings ─► 1 call: ≤15 topics; the harness numbers them t1…tN
 *         ─► import order, batches of ≤40 ─► 1 call each: dialogue-id enum × topic enum + other, each id exactly once
 *         ─► TopicMap, bound to importId + contentHash + builder model + prompt version
 *
 * The model reads only the customers' own words: the old agent's replies say nothing about what was
 * asked, and outcomes are never sent. The map so far reaches `onProgress` after the proposal and after
 * every batch, so an interrupted build continues where it stopped instead of paying again.
 */

/** A topic id (`t1`…`tN`, numbered by the harness in the order the model proposed them) or OTHER. */
export type TopicRef = string;

/** Conversations sorted by one call: the answer stays small, and a rejected answer is repaired cheaply. */
export const CLASSIFY_BATCH = 40;
const DESCRIPTION_CHARS = 240;
/**
 * The proposal reads a seeded sample of customer openings: each the customer's first messages up to
 * OPENING_BYTES (≈150 Cyrillic characters — a greeting and the request after it), PROPOSAL_SAMPLE_BYTES in
 * all, about 150 openings. A topic with 2% of the traffic is in such a sample with ≈95% probability; rarer
 * requests are sorted into «Другое» anyway, so a larger sample would cost more without changing the map.
 * Sizes are request bytes (see `footprint`).
 */
const OPENING_BYTES = 300;
const PROPOSAL_SAMPLE_BYTES = 48_000;
/** A sorted conversation shows its customer's messages up to this size (≈500 Cyrillic characters): the request and its first clarifications. */
const EXCERPT_BYTES = 1_000;
/**
 * At their largest — full sample or 40 full excerpts under 80-character ids, 15 full topics, quote-heavy text,
 * a repair carrying the rejected draft — the proposal is ≈60 KB and a batch ≈65 KB (tested). The 120 KB cap
 * (≈35K tokens) leaves room for a rejected draft of any shape.
 */
const PROPOSAL_BOUNDS = { requestBytes: 120_000 };
const CLASSIFY_BOUNDS = { requestBytes: 120_000 };

const TOPIC_PROPOSAL_ROLE = `You name the topics customers contact a business about. conversations holds a sample of logged conversations with the business's support agent: each entry is one customer's first messages, in order. Propose at most ${TOPIC_LIMIT} topics that together cover the requests in the sample. A topic is one kind of customer need, named the way the business owner would name it in a report, in the customers' language: a short noun phrase of two to six plain words, at most ${TITLE_CHARS} characters, without numbering, ids or quotes. Its description says in one sentence which requests belong to it, so that any conversation can be sorted into exactly one topic. Topics must not overlap. Prefer fewer, clearly distinct topics to fine splits, and merge rare requests into the closest topic. Do not propose a catch-all topic: conversations that fit no topic are sorted into «${OTHER_TITLE}», which the harness adds itself. Greetings and small talk are not topics. List the topics from the most to the least frequent in the sample.`;
const TOPIC_CLASSIFICATION_ROLE = `You sort logged customer conversations into topics. topics lists the topics of one import, each with a description of the requests that belong to it; conversations holds conversations of that import, each with its dialogueId and only the customer's own messages. Return exactly one assignment for every supplied conversation: its dialogueId and the topicId of the topic its main request belongs to, judged by the descriptions. Use "${OTHER}" when no topic fits. Never skip a conversation or assign one twice, and use only the supplied ids.`;

/**
 * Everything besides the import and the model that decides a map: both prompts and the limits that shape
 * what the model reads and may answer. Changing any of them is a new version, so an older map is rebuilt.
 */
export const TOPIC_MAP_PROMPT_VERSION = createHash('sha256').update(JSON.stringify({
  proposal: TOPIC_PROPOSAL_ROLE, classification: TOPIC_CLASSIFICATION_ROLE, topics: TOPIC_LIMIT, batch: CLASSIFY_BATCH,
  title: TITLE_CHARS, description: DESCRIPTION_CHARS, opening: OPENING_BYTES, sample: PROPOSAL_SAMPLE_BYTES, excerpt: EXCERPT_BYTES,
})).digest('hex');

/**
 * Model calls of a whole map over `dialogues` usable conversations: the proposal and one per batch, none
 * without a conversation. That is the spending when every answer passes; a rejected answer is repaired
 * within its step, up to TASK_ATTEMPTS calls, under the run's call budget.
 */
export const topicMapCalls = (dialogues: number): number => dialogues > 0 ? 1 + Math.ceil(dialogues / CLASSIFY_BATCH) : 0;

/** One plain line: single spaces, no control or bidi characters. Titles are stored so every surface prints them as they are; customers' words are sent so. */
const plain = (value: string): string => oneLine(safeLine(value));
/** Stored text is checked, never rewritten, so a parsed map is the stored map. */
const plainText = (max: number) => z.string().min(1).max(max).refine(value => plain(value) === value, 'Expected one plain line');
const numbered = (index: number): string => `t${index + 1}`;

export const topicSchema = z.strictObject({ id: z.string(), title: plainText(TITLE_CHARS), description: plainText(DESCRIPTION_CHARS) });
export type Topic = z.infer<typeof topicSchema>;
/** The shape of `Experiment.validationExclusions`, so an excluded conversation reads the same in a map and in a run. */
const exclusionSchema = z.strictObject({
  dialogueId: identifierSchema, kind: z.enum(['customer_data', 'masked', 'length', 'unconfirmed']), reason: z.string().min(1).max(1000),
}) satisfies z.ZodType<ValidationExclusion>;
/** What a map is bound to: it is reused only when all of them match. */
const keyShape = { formatVersion: z.literal(1), importId: identifierSchema, contentHash: sha256Schema, model: z.string().min(1).max(200), promptVersion: sha256Schema };
export interface TopicMapKey { importId: string; contentHash: string; model: string; promptVersion: string }

/** Topics numbered in order; every assignment names one of them or other; a conversation is assigned or excluded, once. */
function consistent(map: { topics: Topic[]; assignments: Record<string, TopicRef>; excluded?: ValidationExclusion[] }, ctx: z.RefinementCtx): void {
  map.topics.forEach((topic, index) => {
    if (topic.id !== numbered(index)) ctx.addIssue({ code: 'custom', path: ['topics', index, 'id'], message: `Expected ${numbered(index)}: topics are numbered in order` });
  });
  const refs = new Set([...map.topics.map(topic => topic.id), OTHER]);
  for (const [dialogueId, ref] of Object.entries(map.assignments)) {
    if (!refs.has(ref)) ctx.addIssue({ code: 'custom', path: ['assignments', dialogueId], message: 'Not a topic of this map' });
  }
  const seen = new Set(Object.keys(map.assignments));
  map.excluded?.forEach((exclusion, index) => {
    if (seen.has(exclusion.dialogueId)) ctx.addIssue({ code: 'custom', path: ['excluded', index, 'dialogueId'], message: 'A conversation is either assigned or excluded, once' });
    seen.add(exclusion.dialogueId);
  });
  if (seen.size > IMPORT_DIALOGUE_LIMIT) ctx.addIssue({ code: 'custom', path: ['assignments'], message: `An import holds at most ${IMPORT_DIALOGUE_LIMIT} conversations` });
}

/** A finished map: immutable, reused only under the same key. */
export const topicMapSchema = z.strictObject({
  ...keyShape,
  topics: z.array(topicSchema).max(TOPIC_LIMIT),
  assignments: z.record(identifierSchema, z.string()),
  excluded: z.array(exclusionSchema).max(IMPORT_DIALOGUE_LIMIT),
}).superRefine(consistent);
export type TopicMap = z.infer<typeof topicMapSchema>;
/** A map being built: the proposed topics and the assignments of the batches sorted so far. */
export const topicMapProgressSchema = z.strictObject({
  ...keyShape,
  topics: z.array(topicSchema).min(1).max(TOPIC_LIMIT),
  assignments: z.record(identifierSchema, z.string()),
}).superRefine(consistent);
export type TopicMapProgress = z.infer<typeof topicMapProgressSchema>;

/** The part of an import batch a map reads: its identity, its conversations and the table of masks they were read by. */
export type MinerImport = Pick<ImportBatch, 'id' | 'contentHash' | 'dialogues' | 'maskVersion'>;
/** The model that answers a map's calls: a map is bound to it. */
export type BuilderModel = Pick<Model, 'provider' | 'id'>;
/** A conversation as the miner reads it: only the customer's own messages. */
interface Conversation { dialogueId: string; customer: string[] }

const modelName = (model: BuilderModel): string => `${model.provider}/${model.id}`;
/** What a map of `batch` built by `builder` is bound to: where it is stored, and when it can be reused. */
export const topicMapKey = (batch: MinerImport, builder: BuilderModel): TopicMapKey =>
  ({ importId: batch.id, contentHash: batch.contentHash, model: modelName(builder), promptVersion: TOPIC_MAP_PROMPT_VERSION });
const sameKey = (a: TopicMapKey, b: TopicMapKey): boolean =>
  a.importId === b.importId && a.contentHash === b.contentHash && a.model === b.model && a.promptVersion === b.promptVersion;

/** A reproducible, outcome-blind order of `items`: by the hash of each key under `seed` (an import's content hash), never Math.random. */
export function seededOrder<T>(items: readonly T[], seed: string, key: (item: T) => string): T[] {
  return items.map(item => ({ item, rank: createHash('sha256').update(`${seed}\n${key(item)}`).digest('hex') }))
    .sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0).map(entry => entry.item);
}

/**
 * The bytes a value adds to a request. The input travels as JSON inside the request's own JSON, so a quote or
 * a backslash costs four bytes: caps counted this way hold for any text a log may contain.
 */
const footprint = (value: unknown): number => Buffer.byteLength(JSON.stringify(JSON.stringify(value)), 'utf8') - 2;
/** `text` cut to at most `bytes` of request footprint (its quotes aside), never inside a character. */
function clipBytes(text: string, bytes: number): string {
  // A character costs at least its UTF-8 bytes, so that cut bounds the answer; escaped characters may shorten it further.
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(Math.max(bytes, 0)));
  const points = [...text.slice(0, read)];
  const fits = (length: number) => footprint(points.slice(0, length).join('')) - 4 <= bytes;
  if (fits(points.length)) return points.join('');
  let low = 0, high = points.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle; else high = middle - 1;
  }
  return points.slice(0, low).join('');
}
/** A customer's messages in order, each one plain line, up to `bytes` of request footprint in all. */
function excerpt(messages: readonly string[], bytes: number): string[] {
  const turns: string[] = [];
  let left = bytes;
  for (const message of messages) {
    const line = plain(message);
    if (!line) continue;
    const turn = clipBytes(line, left);
    if (!turn) break;
    turns.push(turn);
    left -= footprint(turn) - 4;
  }
  return turns;
}
/** `items` in ceil(n/size) consecutive batches whose sizes differ by at most one. */
function batched<T>(items: readonly T[], size: number): T[][] {
  const count = Math.ceil(items.length / size);
  const batches: T[][] = [];
  for (let index = 0, start = 0; index < count; index++) {
    const length = Math.floor(items.length / count) + (index < items.length % count ? 1 : 0);
    batches.push(items.slice(start, start + length));
    start += length;
  }
  return batches;
}

/** A conversation of the import no situation can be made of, and why; it is still sorted into its topic. */
export interface Unsuitable { dialogueId: string; issue: LeftOutIssue }

/**
 * The conversations of an import the map sorts — every one, with every customer message: the traffic of a topic counts
 * the long conversations too, since they are where agents lose customers — and, apart, those no situation can be made
 * of, with the reason (scenario-library.ts situationIssue).
 */
function partition(batch: MinerImport): { sorted: Conversation[]; unsuitable: Unsuitable[] } {
  const sorted: Conversation[] = [], unsuitable: Unsuitable[] = [];
  for (const dialogue of batch.dialogues) {
    sorted.push({ dialogueId: dialogue.id, customer: dialogue.events.flatMap(event => event.type === 'message' && event.role === 'user' && event.content !== undefined ? [event.content] : []) });
    // An import stored before the table of masks keeps its first reading.
    const issue = situationIssue(dialogue, batch.maskVersion ?? 1);
    if (issue) unsuitable.push({ dialogueId: dialogue.id, issue });
  }
  return { sorted, unsuitable };
}
/** The conversations of an import a situation can be made from, in import order, and those no situation can be made of, with the reason. */
export function usableConversations(batch: MinerImport): { dialogueIds: string[]; unsuitable: Unsuitable[] } {
  const { sorted, unsuitable } = partition(batch);
  const left = new Set(unsuitable.map(item => item.dialogueId));
  return { dialogueIds: sorted.flatMap(conversation => left.has(conversation.dialogueId) ? [] : [conversation.dialogueId]), unsuitable };
}

const sorted = (batch: readonly Conversation[], assignments: TopicMapProgress['assignments']): boolean =>
  batch.every(conversation => Object.hasOwn(assignments, conversation.dialogueId));
/** A stored map-in-progress continues a plan only under the same key and when it holds whole batches of exactly this plan's conversations. */
function continuation(stored: unknown, key: TopicMapKey, batches: readonly (readonly Conversation[])[]): TopicMapProgress | undefined {
  if (stored === undefined) return undefined;
  const parsed = topicMapProgressSchema.safeParse(stored);
  if (!parsed.success || !sameKey(parsed.data, key)) return undefined;
  const progress = parsed.data;
  const planned = new Set(batches.flat().map(conversation => conversation.dialogueId));
  if (Object.keys(progress.assignments).some(dialogueId => !planned.has(dialogueId))) return undefined;
  return batches.every(batch => sorted(batch, progress.assignments) || batch.every(conversation => !Object.hasOwn(progress.assignments, conversation.dialogueId)))
    ? progress : undefined;
}

export interface TopicMapPlan {
  readonly key: TopicMapKey;
  /** Conversations the map sorts: every conversation of the import. */
  readonly dialogues: number;
  /** Sorted conversations no situation can be made of, in import order, with the reason: the sample never picks them. */
  readonly unsuitable: readonly Unsuitable[];
  /** Model calls this plan still makes: the proposal unless the continuation has it, and each batch not yet sorted. */
  readonly calls: number;
  /** What the proposal reads: a seeded sample of customer openings, without ids. */
  readonly openings: readonly (readonly string[])[];
  /** What each classification call reads, in import order. */
  readonly batches: readonly (readonly Conversation[])[];
  /** The stored map-in-progress this plan continues; a continuation that does not match exactly is started afresh. */
  readonly resume: TopicMapProgress | undefined;
}

/**
 * What building the map of `batch` with this builder model involves, before any call: the conversations it
 * sorts, the ones it excludes and why, and the calls still to make — the number the confirmation shows is
 * the number the build spends when every answer passes. `resume` is whatever was stored by `onProgress`.
 */
export function planTopicMap(batch: MinerImport, builder: BuilderModel, resume?: unknown): TopicMapPlan {
  const key = topicMapKey(batch, builder);
  const { sorted: usable, unsuitable } = partition(batch);
  const openings: string[][] = [];
  let bytes = 0;
  for (const { customer } of seededOrder(usable, key.contentHash, conversation => `opening:${conversation.dialogueId}`)) {
    const opening = excerpt(customer, OPENING_BYTES);
    const size = footprint(opening);
    if (bytes + size > PROPOSAL_SAMPLE_BYTES) break;
    openings.push(opening);
    bytes += size;
  }
  const batches = batched(usable.map(({ dialogueId, customer }) => ({ dialogueId, customer: excerpt(customer, EXCERPT_BYTES) })), CLASSIFY_BATCH);
  const continued = continuation(resume, key, batches);
  const left = batches.filter(batch => !continued || !sorted(batch, continued.assignments)).length;
  return { key, dialogues: usable.length, unsuitable, calls: (continued || !usable.length ? 0 : 1) + left, openings, batches, resume: continued };
}

/**
 * A stored map this import can use without a call: the same import, content, builder model and prompt
 * version, accounting for exactly this import's conversations. Anything else — another model, an older
 * prompt, a damaged file — is not reused and gets rebuilt.
 */
export function reusableTopicMap(stored: unknown, batch: MinerImport, builder: BuilderModel): TopicMap | undefined {
  const parsed = topicMapSchema.safeParse(stored);
  if (!parsed.success || !sameKey(parsed.data, topicMapKey(batch, builder))) return undefined;
  const map = parsed.data;
  const { sorted } = partition(batch);
  // A map that left conversations out — as maps did before every conversation was sorted — is built again.
  const assigned = Object.keys(map.assignments);
  return assigned.length === sorted.length && sorted.every(item => Object.hasOwn(map.assignments, item.dialogueId)) && !map.excluded.length
    ? map : undefined;
}

const proposalOutput = z.strictObject({
  topics: z.array(z.strictObject({ title: z.string().trim().min(1).max(TITLE_CHARS), description: z.string().trim().min(1).max(DESCRIPTION_CHARS) }))
    .min(1).max(TOPIC_LIMIT, { error: `Return at most ${TOPIC_LIMIT} topics: merge the rarest requests into the closest topic.` }),
});
type Proposal = z.infer<typeof proposalOutput>;
/** Titles name topics apart on every screen, and «Другое» is the harness's own. */
function proposalProblem(value: Proposal): string | undefined {
  const fold = (title: string) => title.toLocaleLowerCase('ru');
  const taken = new Map<string, number>([[fold(OTHER_TITLE), 0]]);
  for (const [index, topic] of value.topics.entries()) {
    const title = plain(topic.title);
    if (!title || !plain(topic.description)) return `Topic ${index + 1} has no visible title or description: write both in plain words.`;
    const earlier = taken.get(fold(title));
    if (earlier === 0) return `Topic ${index + 1} is titled «${title}», the catch-all the harness adds itself: sort its requests into the other topics or name the need they share.`;
    if (earlier !== undefined) return `Topics ${earlier} and ${index + 1} are both titled «${title}»: merge them or name them apart.`;
    taken.set(fold(title), index + 1);
  }
  return undefined;
}
const PROPOSAL_TASK: StructuredTask<Proposal> = {
  id: 'topic-proposal', label: 'Темы разговоров', role: 'builder', instructions: TOPIC_PROPOSAL_ROLE,
  output: proposalOutput, check: proposalProblem, bounded: PROPOSAL_BOUNDS,
};

type Classification = { assignments: { dialogueId: string; topicId: string }[] };
/** Every supplied id answered exactly once; the reason names the ids, so a repair changes only them. */
function onceEach(expected: readonly string[], answered: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const id of answered) counts.set(id, (counts.get(id) ?? 0) + 1);
  const missing = expected.filter(id => !counts.has(id));
  const repeated = expected.filter(id => (counts.get(id) ?? 0) > 1);
  if (!missing.length && !repeated.length) return undefined;
  return ['Return exactly one assignment for every supplied conversation and keep the others as they are.',
    ...missing.length ? [`Missing: ${missing.join(', ')}.`] : [], ...repeated.length ? [`Assigned more than once: ${repeated.join(', ')}.`] : []].join(' ');
}
/** The answer's schema names exactly this call's conversations and this map's topics, so an invented id is rejected before any check. */
function classificationTask(topics: readonly Topic[], batch: readonly Conversation[], position: string): StructuredTask<Classification> {
  const ids = batch.map(conversation => conversation.dialogueId);
  return {
    id: 'topic-classification', label: `Темы разговоров, часть ${position}`, role: 'builder', instructions: TOPIC_CLASSIFICATION_ROLE,
    output: z.strictObject({ assignments: z.array(z.strictObject({
      dialogueId: z.enum(ids, { error: 'Not a conversation of this call: use only the supplied dialogueIds.' }),
      topicId: z.enum([...topics.map(topic => topic.id), OTHER], { error: `Not a topic id: use a supplied topic id, or "${OTHER}" when none fits.` }),
    })) }),
    check: value => onceEach(ids, value.assignments.map(assignment => assignment.dialogueId)),
    bounded: CLASSIFY_BOUNDS,
  };
}

/** One structured task answered by the builder: runStructured bound to the Pi runtime and its model table, or the demo's and the tests' deterministic stand-in. */
export type TopicTaskRunner = <O>(task: StructuredTask<O>, input: unknown, ctx: CallContext) => Promise<O>;
export interface TopicMapBuild {
  /** The model `run` asks: the plan must have been made for it. */
  builder: BuilderModel;
  run: TopicTaskRunner;
  ctx: CallContext;
  /** The map so far, after the proposal and after every sorted batch: store it and pass it to planTopicMap to continue. */
  onProgress?(progress: TopicMapProgress): void | Promise<void>;
}

/**
 * Builds the map a plan describes, one call at a time. A failed call throws its typed error (the batch is
 * named in the message); everything finished before it has already reached `onProgress`.
 */
export async function buildTopicMap(plan: TopicMapPlan, build: TopicMapBuild): Promise<TopicMap> {
  const { builder, run, ctx } = build;
  if (modelName(builder) !== plan.key.model) throw new Error('План карты тем составлен для другой модели: составьте его заново.');
  const header = { formatVersion: 1 as const, ...plan.key };
  let progress = plan.resume;
  if (!progress) {
    if (!plan.batches.length) return topicMapSchema.parse({ ...header, topics: [], assignments: {}, excluded: [] });
    const proposal = await run(PROPOSAL_TASK, { conversations: plan.openings }, ctx);
    const topics = proposal.topics.map((topic, index) => ({ id: numbered(index), title: plain(topic.title), description: plain(topic.description) }));
    progress = { ...header, topics, assignments: {} };
    await build.onProgress?.(progress);
  }
  // The topics are fixed once proposed; only the assignments grow, a whole batch at a time.
  const { topics } = progress;
  let { assignments } = progress;
  for (const [index, batch] of plan.batches.entries()) {
    if (sorted(batch, assignments)) continue;
    const answer = await run(classificationTask(topics, batch, `${index + 1} из ${plan.batches.length}`), { topics, conversations: batch }, ctx);
    assignments = { ...assignments, ...Object.fromEntries(answer.assignments.map(({ dialogueId, topicId }) => [dialogueId, topicId])) };
    await build.onProgress?.({ ...header, topics, assignments });
  }
  return topicMapSchema.parse({ ...header, topics, assignments, excluded: [] });
}

/** The topic of a logged conversation: undefined when the conversation was excluded or belongs to another import. */
export function topicOfDialogue(map: TopicMap, source: { batchId: string; dialogueId: string }): TopicRef | undefined {
  // An id such as `toString` is a valid identifier: only the map's own keys are assignments.
  return source.batchId === map.importId && Object.hasOwn(map.assignments, source.dialogueId) ? map.assignments[source.dialogueId] : undefined;
}
/** The owner's name of a topic of this map, «Другое» for other; undefined for a ref the map does not have. */
export function topicTitle(map: TopicMap, ref: TopicRef): string | undefined {
  return ref === OTHER ? OTHER_TITLE : map.topics.find(topic => topic.id === ref)?.title;
}
/** The conversations of every topic that has any, in the map's topic order with «Другое» last. */
export function topicDialogues(map: TopicMap): Map<TopicRef, string[]> {
  const groups = new Map<TopicRef, string[]>([...map.topics.map(topic => topic.id), OTHER].map(ref => [ref, []]));
  for (const [dialogueId, ref] of Object.entries(map.assignments)) groups.get(ref)?.push(dialogueId);
  return new Map([...groups].filter(([, dialogueIds]) => dialogueIds.length > 0));
}

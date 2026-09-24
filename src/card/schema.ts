import { z } from 'zod';
import { identifierSchema as id, sha256Schema as hash, text, uniqueIdsSchema as ids } from '../ids.js';
import { AGENT_RULES_PER_DIALOGUE, FOCUSED_REQUIREMENT_LIMIT, MATERIAL_LIMIT, RECORD_REQUIREMENT_LIMIT } from '../limits.js';
import { cardTopicSchema, sampleSchema, topicsKnown, trafficSchema } from '../miner/schema.js';
import { libraryRequirementsSchema, librarySourcesSchema, libraryV1Schema, preparationProgressSchema as variantPreparationSchema, requirementKindSchema } from '../scenario-contracts.js';

/*
 * The card: a brief of what the customer wants, writes, knows and when they leave, and what the agent
 * must do. Structure belongs to the harness: it assigns ids, numbers, sources, quotes and hashes; the
 * model only proposes content. Every schema here is stored, so the stored-schema rule holds: a new
 * field is `.optional()`, never `.default()`, and parsing saved data returns it unchanged
 * (`fingerprint(parse(raw)) === fingerprint(raw)`), which the acceptance hashes rely on.
 */

/** A message of an immutable import. The card keeps the reference; the text is read from the import. */
const eventRefSchema = z.strictObject({ batchId: id, dialogueId: id, eventIndex: z.number().int().nonnegative() });
export type EventRef = z.infer<typeof eventRefSchema>;

/**
 * How the customer shares a fact: `initial` — already in the first message; `on_request` — names it
 * only when the agent asks; `unknown` — does not know it and says so.
 */
export const disclosureSchema = z.enum(['initial', 'on_request', 'unknown']);

const dialogueSource = z.strictObject({ kind: z.literal('dialogue'), event: eventRefSchema });
const ownerSource = z.strictObject({ kind: z.literal('owner'), receiptId: id });

/**
 * A plausible profile fact: written in no message of the log — what this customer would plausibly know about their
 * own business (the kind of equipment, the stage of an application, the kind of account, the channel). Never a
 * secret or a value the agent must look up. The owner decides it by its label for every card at once
 * (`decide_plausible`); `receiptId` names that decision, and until it exists the card waits for the owner.
 */
const plausibleSource = z.strictObject({ kind: z.literal('plausible'), receiptId: id.optional() });

/** Who vouches for a fact: a message of the source dialogue, an owner decision, the owner's word on a plausible fact, or no one yet. */
const factSourceSchema = z.discriminatedUnion('kind', [dialogueSource, ownerSource, z.strictObject({ kind: z.literal('unconfirmed') }), plausibleSource]);

const factSchema = z.strictObject({
  id,                                                     // f1…; never reused within a card
  label: text(120),                                       // «Номер терминала» | «Платил картой»
  value: z.union([text(120), z.number().finite(), z.boolean()]).optional(), // «5678»; a qualitative fact has none
  disclosure: disclosureSchema,
  askedAs: text(200).optional(),                          // how the agent's question is recognised; the label by default
  source: factSourceSchema,
});

/** A late move of the customer: a new wish, or a report of what they see after the agent's step. */
export const turnSchema = z.strictObject({
  kind: z.enum(['change_intent', 'report']),
  after: text(300),                                       // the agent's action that triggers it, in plain words
  says: text(1000),                                       // the customer's words: verbatim from the message or the owner's
  source: z.discriminatedUnion('kind', [dialogueSource, ownerSource]),
});

export const expectationSchema = z.strictObject({
  id,                                                     // e1…e3
  text: text(300),                                        // an infinitive: «объяснить, где найти номер терминала»
  requirementIds: z.array(id).min(1).max(3),              // the quote is requirement.quote, drawn by the harness
  appliesWhen: text(300).optional(),                      // only for a duty that depends on the agent's path
  observation: z.enum(['reply', 'tool', 'state']),        // tool/state only where the connection confirmed it
});

/** The one difference of a similar card from its parent. */
const similarChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('disclosure'), factId: id, disclosure: disclosureSchema, writes: text(3000).optional() }),
  z.strictObject({ kind: z.literal('opening'), writes: text(3000) }),
  z.strictObject({ kind: z.literal('turn'), turn: turnSchema.omit({ source: true }).nullable() }), // null removes the turn
]);

const cardOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('dialogue'), batchId: id, dialogueId: id }),                   // «из диалога №17»
  z.strictObject({ kind: z.literal('owner'), receiptId: id }),                                     // «добавлена вами»
  z.strictObject({ kind: z.literal('similar'), parentId: id, change: similarChangeSchema }),       // «похожая на №3»
  z.strictObject({ kind: z.literal('rules'), requirementIds: z.array(id).min(1).max(10) }),         // «по вашим правилам»: no logs
]);

/** How the card accounts for one later customer message of its source dialogue; `changed` — replaced by a similar card's change. */
const coverageEntrySchema = z.strictObject({
  event: eventRefSchema,
  as: z.enum(['fact', 'turn', 'stop', 'ignored', 'changed']),
  reason: text(300).optional(),
}).refine(entry => entry.reason !== undefined || (entry.as !== 'ignored' && entry.as !== 'changed'), 'An ignored or changed message needs a reason');

const distinctIds = (items: { id: string }[]) => new Set(items.map(item => item.id)).size === items.length;

export const cardSchema = z.strictObject({
  id,                                  // card_<digest>
  number: z.number().int().positive(), // «№3»; assigned once, never reused
  title: text(160),
  topic: text(120),                    // a plain label; there are no groups
  // The topic of the logs it stands for (miner/schema.ts), `topic` being its title; a card from the owner's rules has none.
  trafficTopic: cardTopicSchema.optional(),
  origin: cardOriginSchema,
  client: z.strictObject({
    wants: text(300),                  // Хочет
    writes: text(3000),                // Пишет — the exact first message
    writesSource: z.discriminatedUnion('kind', [dialogueSource, ownerSource, z.strictObject({ kind: z.literal('model') })]),
    knows: z.array(factSchema).max(8), // Знает
    leaves: text(300),                 // Уходит
    turn: turnSchema.optional(),
  }),
  agentMust: z.array(expectationSchema).min(1).max(3), // АГЕНТ ДОЛЖЕН
  coverage: z.array(coverageEntrySchema).max(60),
  revision: z.number().int().positive(),
}).refine(card => distinctIds(card.client.knows) && distinctIds(card.agentMust), 'Fact and expectation ids repeat')
  // Only a card written from the owner's rules, with no dialogue behind it, opens with the model's words.
  .refine(card => card.client.writesSource.kind !== 'model' || card.origin.kind === 'rules', 'Model-written opening outside a rules card');
export type Card = z.infer<typeof cardSchema>;

/**
 * «Свод правил»: which requirements may back what the agent must do. `kinds` bind as a whole; `included` are single rules
 * of another kind the owner said the bot must follow («бот обязан так делать»). A library without it binds behaviour and
 * knowledge (card/rulebook.ts); a requirement without a kind always binds, as it did before kinds existed.
 */
export const rulebookSchema = z.strictObject({
  kinds: z.array(requirementKindSchema).min(1).max(3).refine(kinds => new Set(kinds).size === kinds.length, 'A kind repeats'),
  included: ids(800),
});
export type Rulebook = z.infer<typeof rulebookSchema>;

/** What the owner can do to a card. Every applied command is kept verbatim in an owner receipt, so this union is part of the stored format. */
export const cardCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('set_fact_disclosure'), cardId: id, factId: id, disclosure: disclosureSchema }),
  // A new fact when factId is absent; the owner vouches for it.
  z.strictObject({ kind: z.literal('set_fact'), cardId: id, factId: id.optional(), label: text(120), value: factSchema.shape.value,
    disclosure: disclosureSchema, askedAs: text(200).optional() }),
  z.strictObject({ kind: z.literal('remove_fact'), cardId: id, factId: id }),
  z.strictObject({ kind: z.literal('edit_expectation'), cardId: id, expectationId: id, text: text(300).optional(),
    requirementIds: z.array(id).min(1).max(3).optional(), appliesWhen: text(300).nullable().optional() }),
  z.strictObject({ kind: z.literal('remove_expectation'), cardId: id, expectationId: id }),
  z.strictObject({ kind: z.literal('edit_client'), cardId: id, wants: text(300).optional(), writes: text(3000).optional(), leaves: text(300).optional() }),
  // `event` present: the turn is that later message of the source dialogue, `says` its exact text; absent: the owner's words. null removes it.
  z.strictObject({ kind: z.literal('set_turn'), cardId: id, turn: turnSchema.omit({ source: true }).extend({ event: eventRefSchema.optional() }).nullable() }),
  // Only offered as a choice of a question: the owner settles the doubt behind that exact key.
  z.strictObject({ kind: z.literal('settle_claim'), cardId: id, key: hash }),
  z.strictObject({ kind: z.literal('answer_question'), cardId: id, questionId: hash, choice: z.enum(['a', 'b', 'c']), text: text(1000).optional() }),
  z.strictObject({ kind: z.literal('add_similar'), parentId: id, change: similarChangeSchema, title: text(160).optional() }),
  z.strictObject({ kind: z.literal('remove_card'), cardId: id }),
  // The owner's one word on a plausible fact's label for the whole draft: `known` keeps every listed fact (the customer
  // names it when asked), otherwise every one is removed. The facts are listed so the receipt says exactly what it decided.
  z.strictObject({ kind: z.literal('decide_plausible'), label: text(120), known: z.boolean(),
    facts: z.array(z.strictObject({ cardId: id, factId: id })).min(1).max(200) }),
  // The whole rulebook as it will be: a library-wide change, whose receipt names no card.
  z.strictObject({ kind: z.literal('set_rulebook'), rulebook: rulebookSchema }),
]);
export type CardCommand = z.infer<typeof cardCommandSchema>;

/** The reviewer's answer on one semantic claim, addressed by content: key = digest(kind, subject, basisHash). */
const claimReceiptSchema = z.strictObject({
  key: hash, kind: z.enum(['goal', 'fact', 'expectation', 'coverage', 'leak']), subject: z.string().max(20),
  basisHash: hash, status: z.enum(['ready', 'needs_owner', 'blocked']), reason: text(240),
  reviewer: z.strictObject({ protocol: z.literal('card-review-v1'), model: text(200) }),
});
export type ClaimReceipt = z.infer<typeof claimReceiptSchema>;

/** An owner decision or edit: the exact command the owner confirmed. Receipts are only ever appended. */
const ownerReceiptSchema = z.strictObject({
  id, at: z.iso.datetime(), via: z.enum(['pi-confirm', 'board', 'cli-yes']),
  command: cardCommandSchema,
  basisHash: hash.optional(),                   // answers and settlements: the basis of the question
  ownerWords: text(1000).optional(),            // the owner's verbatim text when the wording is theirs
});

/** Acceptance of a card library: the accepted cards and each compiled definition's hash, fixed once at acceptance. */
const cardAcceptanceSchema = z.strictObject({
  revision: z.number().int().positive(), libraryHash: hash, cardIds: ids(200).min(1), snapshotHash: hash,
  definitions: z.array(z.strictObject({ cardId: id, definitionHash: hash })).min(1).max(200),
}).refine(acceptance => acceptance.definitions.length === acceptance.cardIds.length
  && acceptance.definitions.every((definition, index) => definition.cardId === acceptance.cardIds[index]), 'Every accepted card has exactly one definition, in order');

export const libraryV2Schema = z.strictObject({
  formatVersion: z.literal(2), id, revision: z.number().int().positive(), createdAt: z.iso.datetime(),
  imports: z.array(z.strictObject({ id, contentHash: hash })).max(30),     // references; the batches live in the store's imports
  sources: librarySourcesSchema, requirements: libraryRequirementsSchema,
  readingManifest: z.array(z.strictObject({ dialogueId: id, batchId: id.optional(), sourceIds: ids(MATERIAL_LIMIT), cardIds: ids(200) })).max(300),
  cards: z.array(cardSchema).max(200).refine(distinctIds, 'Card ids repeat'),
  nextNumber: z.number().int().positive(),
  claims: z.array(claimReceiptSchema).max(5000),  // library-wide: a similar card reuses receipts with the same key
  receipts: z.array(ownerReceiptSchema).max(2000),
  acceptance: cardAcceptanceSchema.optional(),
  /** The topic traffic of each import whose logs the cards were sampled from: what a result reads of the logs' topics. */
  traffic: z.array(trafficSchema).max(30).optional(),
  /** The owner's rulebook; absent until the owner changes it (card/rulebook.ts reads the default). */
  rulebook: rulebookSchema.optional(),
}).refine(library => new Set(library.cards.map(card => card.number)).size === library.cards.length
  && library.cards.every(card => card.number < library.nextNumber), 'A card number repeats or is not below nextNumber: a number is never given twice')
  .refine(topicsKnown, 'A card stands for a topic its library has no traffic of');
export type LibraryV2 = z.infer<typeof libraryV2Schema>;

/** Every stored library, told apart by format. Old libraries are read as they are: no file is ever migrated. */
export const scenarioLibrarySchema = z.discriminatedUnion('formatVersion', [libraryV1Schema, libraryV2Schema]);
export type ScenarioLibrary = z.infer<typeof scenarioLibrarySchema>;

/**
 * The checkpoint of a card preparation (card/prepare.ts), saved with the draft after every step. A unit of work
 * is one dialogue of the import (its id), or `rules_N` for a situation from the owner's rules alone. What a unit
 * finished is kept, so a resume continues it from the next step: the articles chosen for it, the rules grounded
 * for it and the card made from it. A paid call names its unit and step before it is sent and clears them when
 * it returns, so a crash leaves them behind and a resume never repeats a call whose cost is unknown. The owner
 * reads the same counts as in the first format (processed, pending, excluded).
 */
const cardPreparationSchema = z.strictObject({
  protocol: z.literal('cards-v1'),
  /** What the plan was made from: a resume on changed inputs is refused. */
  inputHash: hash,
  status: z.enum(['preparing', 'complete', 'partial', 'cancelled']),
  pending: ids(300), processed: ids(300),
  excluded: z.array(z.strictObject({ dialogueId: text(200), reason: text(2000) })).max(300),
  /** The whole policy was grounded in one call (a knowledge base small enough to read at once). */
  groundingComplete: z.boolean(),
  /** Situations asked for — from the owner's rules alone, or from the logs' sample: never more are made. */
  requestedCount: z.number().int().min(1).max(200).optional(),
  /** The logs' sample the units are drawn from: a unit that makes no situation gives its seat to the next one of its topic. */
  sample: sampleSchema.optional(),
  /**
   * A large knowledge base with the agent's prompts: the prompts alone, grounded once before the dialogues in `chunks`
   * calls, `done` of them finished; the rules they yielded, offered to every dialogue; a prompt too large for one call, with why.
   */
  promptGrounding: z.strictObject({
    chunks: z.number().int().nonnegative().max(MATERIAL_LIMIT), done: z.number().int().nonnegative().max(MATERIAL_LIMIT),
    requirementIds: ids(RECORD_REQUIREMENT_LIMIT),
    skipped: z.array(z.strictObject({ sourceId: id, reason: text(2000) })).max(MATERIAL_LIMIT).optional(),
  }).refine(value => value.done <= value.chunks, 'More prompt groundings done than planned').optional(),
  /** A call in flight; a stage without a unit is the grounding of the whole policy, or of one chunk of the agent's prompts. */
  activeDialogueId: id.optional(),
  activeStage: z.enum(['select', 'ground', 'propose', 'review']).optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  /** Proposal calls spent per unit, repairs included; the allowance survives a resume. */
  generationAttempts: z.array(z.strictObject({ dialogueId: id, calls: z.number().int().nonnegative() })).max(300).optional(),
  /** A large knowledge base: the articles chosen for each dialogue from the table of contents. */
  sourceSelection: z.array(z.strictObject({ dialogueId: id, sourceIds: ids(40) })).max(300).optional(),
  /** A large knowledge base: the rules grounded for each dialogue, by requirement id, and the agent's rules (promptGrounding) chosen as deciding it. */
  focus: z.array(z.strictObject({ dialogueId: id, requirementIds: ids(FOCUSED_REQUIREMENT_LIMIT), agentRuleIds: ids(AGENT_RULES_PER_DIALOGUE).optional() })).max(300).optional(),
  /** The card each unit made. */
  cards: z.array(z.strictObject({ dialogueId: id, cardId: id })).max(300).optional(),
});
export type CardPreparation = z.infer<typeof cardPreparationSchema>;

/** A preparation's checkpoint in either format; the first format's is read as it was stored. */
export const preparationProgressSchema = z.discriminatedUnion('protocol', [variantPreparationSchema, cardPreparationSchema]);
export type PreparationProgress = z.infer<typeof preparationProgressSchema>;

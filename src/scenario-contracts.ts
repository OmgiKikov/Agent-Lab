import { z } from 'zod';
import { identifierSchema as id, sha256Schema as hash, text, uniqueIdsSchema as ids } from './ids.js';
import { MATERIAL_CHARS, MATERIAL_LIMIT, RECORD_REQUIREMENT_LIMIT } from './limits.js';

/*
 * Stored shapes Lab reads: an import of logs, kept verbatim, and the first library format — business groups of variants —
 * which is only ever read now: card/legacy-v1.ts reads it, and card/convert.ts carries a draft of it over into cards. The
 * card format is card/schema.ts; the materials and rules of a library keep one shape in both formats.
 */

const json = z.json().refine(v => JSON.stringify(v).length <= 500_000, 'JSON exceeds 500000 characters');
const timestamp = z.iso.datetime();

const sourceDialogueSchema = z.strictObject({ batchId: id, dialogueId: id });
const importedEventSchema = z.strictObject({
  index: z.number().int().nonnegative(), type: z.enum(['message', 'tool', 'retrieval', 'state']),
  role: z.enum(['user', 'assistant', 'tool', 'system']).optional(), content: z.string().min(1).max(8000).refine(v => !!v.trim(), 'Empty content').optional(), data: json,
});
export const importBatchSchema = z.strictObject({
  formatVersion: z.literal(1), id, contentHash: hash, createdAt: timestamp,
  /** The table of masking marks the rows were read by (masking.ts); absent in batches read by the first, frozen readings. */
  maskVersion: z.literal(2).optional(),
  /** A log longer than one batch: the conversations it held and the usable ones; `dialogues` are a sample of those (scenario-library.ts logImport). */
  sample: z.strictObject({ dialogues: z.number().int().positive(), usable: z.number().int().nonnegative() }).optional(),
  dialogues:z.array(z.strictObject({ id, events: z.array(importedEventSchema).min(1).max(120), observation: z.enum(['complete', 'partial', 'unknown']), original: json })).max(300),
  rejected: z.array(z.strictObject({ index: z.number().int().nonnegative(), id: z.string().max(200).optional(), reasons: z.array(text(2000)).min(1).max(20), original: json })).max(300),
});
export type ImportBatch = z.infer<typeof importBatchSchema>;

const userFactSchema = z.strictObject({
  id, statement: text(300), value: z.union([text(300), z.number().finite(), z.boolean()]).optional(),
  availability: z.enum(['initial', 'learned_in_source', 'uncertain']), reason: text(1000),
  origin: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('dialogue'), batchId: id, dialogueId: id, eventIndex: z.number().int().nonnegative(), quote: text(3000) }),
    z.strictObject({ kind: z.literal('owner'), editId: id, text: text(2000) }),
    z.strictObject({ kind: z.literal('synthetic'), parentVariantId: id, operation: text(200), reason: text(1000) }),
  ]),
});

export const behaviorPolicySchema = z.strictObject({
  version: z.literal(1), initialState: id, states: ids(30).min(1), terminalStates: ids(30).min(1),
  maxFollowUps: z.number().int().min(0).max(15), repetitionLimit: z.number().int().min(1).max(15),
  actions: z.array(z.strictObject({
    id, kind: z.enum(['answer', 'missing', 'clarify', 'correct', 'change_intent', 'finish', 'observe']), factIds: ids(20),
    payload: text(1000).optional(), ifAsked: text(300).optional(),
  })).min(1).max(30),
  transitions: z.array(z.strictObject({ from: id, to: id, actionId: id, when: text(300) })).max(60),
});
export type BehaviorPolicy = z.infer<typeof behaviorPolicySchema>;
export const checkpointSchema = z.strictObject({
  id, requirementId: id, quote: text(3000), applicability: text(1000),
  observation: z.enum(['reply', 'tool', 'state']), role: z.enum(['required', 'diagnostic']), rule: text(1000),
  // Parsed with the real checkSchema where it is read (checkpoints.ts), avoiding a contracts.ts runtime cycle.
  check: json.optional(),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;

const businessDefinitionSchema = z.strictObject({
  key: text(200), title: text(200), goal: text(3000), conditions: z.array(text(1000)).max(20), requirementIds: ids(20),
  grouping: z.strictObject({ status: z.enum(['confirmed', 'uncertain']), reason: text(1000) }),
});
const businessScenarioSchema = businessDefinitionSchema.extend({ id, sourceDialogues: z.array(sourceDialogueSchema).max(300) });
const libraryQualityIssueSchema = z.strictObject({
  code: text(80), severity: z.enum(['needs_review', 'blocked']), path: text(400), message: text(2000), variantId: id.optional(),
});

/** What a variant says, as the old preparation wrote it; a stored variant adds its group, review and history. */
const variantDefinitionSchema = z.strictObject({
  id, title: text(200), purpose: text(1000), provenance: z.enum(['production', 'curated', 'synthetic']),
  sourceDialogues: z.array(sourceDialogueSchema).max(300), parentVariantId: id.optional(), mutationReason: text(1000).optional(),
  // Set where the preparation required a disposition for every later customer turn; absent in older snapshots.
  sourceCoverageRequired: z.literal(true).optional(),
  // Stamped from the preparation request, never inferred from the model's editable sourceDialogues.
  sourceCoverageBasis: z.array(z.strictObject({ batchId: id, dialogueId: id, eventIndex: z.number().int().nonnegative() })).min(1).max(120).optional(),
  sourceCoverage: z.array(z.strictObject({
    batchId: id, dialogueId: id, eventIndex: z.number().int().nonnegative(),
    disposition: z.enum(['conditional_action', 'initial_fact', 'omitted']),
    actionIds: ids(30), factIds: ids(20), reason: text(1000),
  })).max(120).optional(),
  userState: z.strictObject({
    goal: text(3000), opening: text(3000), facts: z.array(userFactSchema).max(20),
    cannotKnow: z.array(text(300)).max(20), missing: z.array(text(300)).max(20),
    persona: z.strictObject({ text: text(2000), ownerEditId: id }).optional(),
  }),
  behaviorPolicy: behaviorPolicySchema,
  environmentFixture: z.strictObject({
    mode: z.enum(['prompt', 'managed']), initialState: json,
    contract: z.strictObject({ operations: z.array(text(200)).max(30), reset: z.boolean(), observations: z.array(z.enum(['reply', 'tool', 'state'])).max(3), confirmed: z.boolean() }).optional(),
  }),
  evaluationSpec: z.strictObject({
    successCriteria: text(3000), goalObservation: z.enum(['reply', 'tool', 'state']), checkpoints: z.array(checkpointSchema).min(1).max(12),
  }),
});
export const scenarioVariantSchema = variantDefinitionSchema.extend({
  businessScenarioId: id, familyId: id, revision: z.number().int().positive(),
  quality: z.enum(['ready', 'needs_review', 'blocked']), issues: z.array(libraryQualityIssueSchema).max(500),
  ownerDecision: z.enum(['pending', 'accepted', 'excluded']),
  semanticReviewRequired: z.literal(true).optional(),
  history: z.array(z.strictObject({
    previousHash: hash.optional(), author: z.enum(['owner', 'generator', 'assistant']), reason: text(1000), revision: z.number().int().positive(),
    factEdit: z.strictObject({ factId: id, editId: id, factHash: hash }).optional(),
    personaEdit: z.strictObject({ editId: id, personaHash: hash }).optional(),
    textEdit: z.strictObject({ editId: id, field: z.enum(['opening', 'goal', 'successCriteria', 'checkpointRule']), valueHash: hash }).optional(),
  })).max(1000),
});
export type ScenarioVariant = z.infer<typeof scenarioVariantSchema>;

const semanticFindingSchema = z.strictObject({
  variantId: id, path: text(400), status: z.enum(['ready', 'needs_review', 'blocked']), reason: text(2000),
});
/** A first-format preparation's checkpoint as it was stored; nothing continues one now. */
export const preparationProgressSchema = z.strictObject({
  protocol: z.literal('chronological-scenarios-v1'),
  processed: ids(300), pending: ids(300),
  excluded: z.array(z.strictObject({ dialogueId: text(200), reason: text(2000) })).max(300),
  status: z.enum(['preparing', 'complete', 'partial', 'cancelled']),
  /** Set before a paid call and cleared when that call returns. A crash leaves it, so resume will not repeat an unknown charge. */
  activeDialogueId: id.optional(),
  activeStage: z.enum(['select', 'ground', 'extract', 'repair']).optional(),
  checkpointVersion: z.literal(1).optional(),
  requestedCount: z.number().int().min(0).max(200).optional(),
  inputHash: hash.optional(),
  groundingComplete: z.boolean().optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  generationAttempts: z.array(z.strictObject({ dialogueId: text(200), calls: z.number().int().nonnegative() })).max(300).optional(),
  /** Large knowledge base: which articles the model chose for each dialogue from the table of contents. */
  sourceSelection: z.array(z.strictObject({ dialogueId: text(200), sourceIds: ids(40) })).max(300).optional(),
});
/** A library's materials and requirements; both library formats keep them in this shape. */
export const librarySourcesSchema = z.array(z.strictObject({ id, name: text(180), content: text(MATERIAL_CHARS), hash: text(200), kind: z.enum(['knowledge', 'prompt']).optional() })).max(MATERIAL_LIMIT);
/**
 * What kind of rule a requirement is, as the preparation typed it: `behavior` — how the bot must act or speak, usually
 * from its own prompts; `knowledge` — a fact about the product or its terms that the bot's answer must get right;
 * `operator_procedure` — steps a human operator performs, or a script written for operators. Which kinds bind the bot
 * is the owner's rulebook (card/rulebook.ts). Requirements grounded before the field existed lack it and bind as before.
 */
export const requirementKindSchema = z.enum(['behavior', 'knowledge', 'operator_procedure']);
export type RequirementKind = z.infer<typeof requirementKindSchema>;
// The record's requirements, field for field (contracts.ts requirementSchema, which this module cannot import).
export const libraryRequirementsSchema = z.array(z.strictObject({ id, text: text(2000), sourceId: id, quote: text(3000), critical: z.boolean(), observable: z.boolean().optional(),
  kind: requirementKindSchema.optional() })).max(RECORD_REQUIREMENT_LIMIT);
/** The first library format: business groups of variants, each compiled into a runnable card when it was accepted. Read only. */
export const libraryV1Schema = z.strictObject({
  checkpointContext:z.literal('observed-tools-v1').optional(),
  formatVersion: z.literal(1), id, revision: z.number().int().positive(), createdAt: timestamp,
  imports: z.array(importBatchSchema).max(30),
  sources: librarySourcesSchema,
  requirements: libraryRequirementsSchema,
  businessScenarios: z.array(businessScenarioSchema).max(200), variants: z.array(scenarioVariantSchema).max(200),
  /** Articles chosen for a dialogue before the model wrote the card. Edits of the card do not shrink this list. */
  readingManifest: z.array(z.strictObject({ dialogueId: text(200), batchId: id.optional(), sourceIds: ids(MATERIAL_LIMIT),
    variantIds: ids(200).optional(), requestHash: hash.optional() })).max(300).optional(),
  semanticRequired: z.literal(true).optional(),
  semanticAssessment: z.strictObject({ contextVersion: z.number().int().positive().optional(), contentHash: hash, findings: z.array(semanticFindingSchema).max(10000), complete: z.literal(true).optional(),
    workReceipts: z.array(z.strictObject({ workHash: hash, findings: z.array(semanticFindingSchema).max(6) })).max(20000).optional(),
  }).optional(),
  acceptance: z.strictObject({ revision: z.number().int().positive(), libraryHash: hash, variantIds: ids(200).min(1), snapshotHash: hash }).optional(),
  /**
   * Disputes the owner settled in their own name: «да, это моё правило». Bound to the exact remark of the scenario checker, so a
   * different remark on the same field opens the question again. Not part of the assessed content; a blocking remark cannot be settled.
   */
  ownerResolutions: z.array(z.strictObject({ variantId: id, path: text(400), findingHash: hash, businessHash: hash.optional(), editId: id, reason: text(1000) })).max(400).optional(),
});
export type LibraryV1 = z.infer<typeof libraryV1Schema>;

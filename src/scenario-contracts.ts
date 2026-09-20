import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).refine(v => !['__proto__', 'prototype', 'constructor'].includes(v), 'Reserved identifier');
const text = (max: number) => z.string().trim().min(1).max(max);
const ids = (max: number) => z.array(id).max(max).refine(v => new Set(v).size === v.length, 'Duplicate identifiers');
const json = z.json().refine(v => JSON.stringify(v).length <= 500_000, 'JSON exceeds 500000 characters');
const timestamp = z.iso.datetime();
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const sourceDialogueSchema = z.strictObject({ batchId: id, dialogueId: id });
export type SourceDialogue = z.infer<typeof sourceDialogueSchema>;
export const importedEventSchema = z.strictObject({
  index: z.number().int().nonnegative(), type: z.enum(['message', 'tool', 'retrieval', 'state']),
  role: z.enum(['user', 'assistant', 'tool', 'system']).optional(), content: z.string().min(1).max(8000).refine(v => !!v.trim(), 'Empty content').optional(), data: json,
});
export const importBatchSchema = z.strictObject({
  formatVersion: z.literal(1), id, contentHash: hash, createdAt: timestamp,
  dialogues: z.array(z.strictObject({ id, events: z.array(importedEventSchema).min(1).max(120), observation: z.enum(['complete', 'partial', 'unknown']), original: json })).max(300),
  rejected: z.array(z.strictObject({ index: z.number().int().nonnegative(), id: z.string().max(200).optional(), reasons: z.array(text(2000)).min(1).max(20), original: json })).max(300),
});
export type ImportBatch = z.infer<typeof importBatchSchema>;

export const userFactSchema = z.strictObject({
  id, statement: text(300), value: z.union([text(300), z.number().finite(), z.boolean()]).optional(),
  availability: z.enum(['initial', 'learned_in_source', 'uncertain']), reason: text(1000),
  origin: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('dialogue'), batchId: id, dialogueId: id, eventIndex: z.number().int().nonnegative(), quote: text(3000) }),
    z.strictObject({ kind: z.literal('owner'), editId: id, text: text(2000) }),
    z.strictObject({ kind: z.literal('synthetic'), parentVariantId: id, operation: text(200), reason: text(1000) }),
  ]),
});
export type UserFact = z.infer<typeof userFactSchema>;

export const behaviorPolicySchema = z.strictObject({
  version: z.literal(1), initialState: id, states: ids(30).min(1), terminalStates: ids(30).min(1),
  maxFollowUps: z.number().int().min(0).max(15), repetitionLimit: z.number().int().min(1).max(15),
  actions: z.array(z.strictObject({
    id, kind: z.enum(['answer', 'missing', 'clarify', 'correct', 'change_intent', 'finish']), factIds: ids(20),
    payload: text(1000).optional(), ifAsked: text(300).optional(),
  })).min(1).max(30),
  transitions: z.array(z.strictObject({ from: id, to: id, actionId: id, when: text(300) })).max(60),
});
export type BehaviorPolicy = z.infer<typeof behaviorPolicySchema>;
export const checkpointSchema = z.strictObject({
  id, requirementId: id, quote: text(3000), applicability: text(1000),
  observation: z.enum(['reply', 'tool', 'state']), role: z.enum(['required', 'diagnostic']), rule: text(1000),
  // Parsed with the real checkSchema at the compiler boundary, avoiding a contracts.ts runtime cycle.
  check: json.optional(),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;

export const businessProposalSchema = z.strictObject({
  key: text(200), title: text(200), goal: text(3000), conditions: z.array(text(1000)).max(20), requirementIds: ids(20),
  grouping: z.strictObject({ status: z.enum(['confirmed', 'uncertain']), reason: text(1000) }),
});
export const businessScenarioSchema = businessProposalSchema.extend({ id, sourceDialogues: z.array(sourceDialogueSchema).max(300) });
export type BusinessScenario = z.infer<typeof businessScenarioSchema>;
export const libraryQualityIssueSchema = z.strictObject({
  code: text(80), severity: z.enum(['needs_review', 'blocked']), path: text(400), message: text(2000), variantId: id.optional(),
});
export type LibraryQualityIssue = z.infer<typeof libraryQualityIssueSchema>;

export const variantProposalSchema = z.strictObject({
  id, title: text(200), purpose: text(1000), provenance: z.enum(['production', 'curated', 'synthetic']),
  sourceDialogues: z.array(sourceDialogueSchema).max(300), parentVariantId: id.optional(), mutationReason: text(1000).optional(),
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
export const scenarioProposalSchema = z.strictObject({ business: businessProposalSchema, variant: variantProposalSchema });
export type ScenarioProposal = z.infer<typeof scenarioProposalSchema>;
export const scenarioVariantSchema = variantProposalSchema.extend({
  businessScenarioId: id, familyId: id, revision: z.number().int().positive(),
  quality: z.enum(['ready', 'needs_review', 'blocked']), issues: z.array(libraryQualityIssueSchema).max(500),
  ownerDecision: z.enum(['pending', 'accepted', 'excluded']),
  semanticReviewRequired: z.literal(true).optional(),
  history: z.array(z.strictObject({
    previousHash: hash.optional(), author: z.enum(['owner', 'generator']), reason: text(1000), revision: z.number().int().positive(),
    factEdit: z.strictObject({ factId: id, editId: id, factHash: hash }).optional(),
    personaEdit: z.strictObject({ editId: id, personaHash: hash }).optional(),
    textEdit: z.strictObject({ editId: id, field: z.enum(['opening', 'goal', 'successCriteria', 'checkpointRule']), valueHash: hash }).optional(),
  })).max(1000),
});
export type ScenarioVariant = z.infer<typeof scenarioVariantSchema>;

export const semanticFindingSchema = z.strictObject({
  variantId: id, path: text(400), status: z.enum(['ready', 'needs_review', 'blocked']), reason: text(2000),
});
export type SemanticFinding = z.infer<typeof semanticFindingSchema>;
export const preparationProgressSchema = z.strictObject({
  protocol: z.literal('chronological-scenarios-v1'),
  processed: ids(300), pending: ids(300),
  excluded: z.array(z.strictObject({ dialogueId: text(200), reason: text(2000) })).max(300),
  status: z.enum(['preparing', 'complete', 'partial', 'cancelled']),
});
export type PreparationProgress = z.infer<typeof preparationProgressSchema>;
export const scenarioLibrarySchema = z.strictObject({
  checkpointContext:z.literal('observed-tools-v1').optional(),
  formatVersion: z.literal(1), id, revision: z.number().int().positive(), createdAt: timestamp,
  imports: z.array(importBatchSchema).max(30),
  sources: z.array(z.strictObject({ id, name: text(180), content: text(120000), hash: text(200), kind: z.enum(['knowledge', 'prompt']).optional() })).max(12),
  requirements: z.array(z.strictObject({ id, text: text(2000), sourceId: id, quote: text(3000), critical: z.boolean() })).max(80),
  businessScenarios: z.array(businessScenarioSchema).max(200), variants: z.array(scenarioVariantSchema).max(200),
  semanticRequired: z.literal(true).optional(),
  semanticAssessment: z.strictObject({ contentHash: hash, findings: z.array(semanticFindingSchema).max(10000),
    workReceipts: z.array(z.strictObject({ workHash: hash, findings: z.array(semanticFindingSchema).max(6) })).max(20000).optional(),
  }).optional(),
  acceptance: z.strictObject({ revision: z.number().int().positive(), libraryHash: hash, variantIds: ids(200).min(1), snapshotHash: hash }).optional(),
});
export type ScenarioLibrary = z.infer<typeof scenarioLibrarySchema>;

const reason = { reason: text(1000) };
export const libraryPatchSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('upsert_variant'), variant: scenarioVariantSchema, ...reason }),
  z.strictObject({ kind: z.literal('remove_variant'), variantId: id, ...reason }),
  z.strictObject({ kind: z.literal('merge_business'), targetId: id, sourceIds: ids(200).min(1), ...reason }),
  z.strictObject({ kind: z.literal('split_business'), businessScenarioId: id, newBusiness: businessProposalSchema, variantIds: ids(200).min(1), ...reason }),
  z.strictObject({ kind: z.literal('edit_fact'), variantId: id, factId: id, statement: text(300), value: userFactSchema.shape.value, availability: userFactSchema.shape.availability, editId: id, ...reason }),
  z.strictObject({ kind: z.literal('add_fact'), variantId: id, factId: id, statement: text(300), value: userFactSchema.shape.value, availability: userFactSchema.shape.availability, editId: id, ...reason }),
  z.strictObject({ kind: z.literal('edit_variant_text'), variantId: id, field: z.enum(['opening', 'goal', 'successCriteria', 'checkpointRule']),
    checkpointId: id.optional(), value: text(3000), editId: id, ...reason }),
]);
export type LibraryPatch = z.infer<typeof libraryPatchSchema>;

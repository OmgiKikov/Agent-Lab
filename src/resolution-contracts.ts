import { z } from 'zod';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const resolutionRequestSchema = z.strictObject({
  issueId: id, baselineRunId: id, candidateRunId: id,
  reproducerIds: z.array(id).min(1), regressionIds: z.array(id).min(1),
  stability: z.strictObject({ kind: z.literal('all-pass'), repeats: z.number().int().min(2, 'Нужно минимум 2 повтора').max(100) }),
});
export type ResolutionRequest = z.infer<typeof resolutionRequestSchema>;
const suite = z.strictObject({ ids: z.array(id).min(1), hash, protocolHash: hash, revision: z.string(), repeats: z.number().int().min(2) });
export const resolutionPolicySchema = resolutionRequestSchema.extend({
  formatVersion: z.literal('1'), id, declaredAt: z.string(), baselineIdentity: hash, candidateIdentity: hash,
  baselineRevisionId: id, candidateRevisionId: id,
  baselineEvidenceHash: hash, candidateDraftHash: hash,
  reproducer: suite, regression: suite, ruleHash: hash,
});
export type ResolutionPolicy = z.infer<typeof resolutionPolicySchema>;
export const resolutionResultSchema = z.strictObject({
  defectReproduced: z.boolean().nullable(), defectNoLongerReproduced: z.boolean().nullable(), candidateAcceptable: z.boolean().nullable(),
  reasons: z.array(z.string()), beforeRunId: id, afterRunId: id,
  reproducer: z.array(z.strictObject({ scenarioId:id,before:z.enum(['pass','fail','unknown']),after:z.enum(['pass','fail','unknown']) })),
  regression: z.array(z.strictObject({ scenarioId:id,before:z.enum(['pass','fail','unknown']),after:z.enum(['pass','fail','unknown']) })),
  trialIds: z.array(id), scope: z.string(),
});
export type ResolutionResult = z.infer<typeof resolutionResultSchema>;
export const resolutionFileSchema = z.strictObject({ policy: resolutionPolicySchema, startedAt: z.string().optional(), completedAt: z.string().optional(), result: resolutionResultSchema.optional() });
export type ResolutionFile = z.infer<typeof resolutionFileSchema>;

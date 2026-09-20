import { z } from 'zod';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const diagnosticCapabilitiesSchema = z.strictObject({ protocol: z.literal('paired-intervention-v1'), toolResponse: z.boolean(), ragFragment: z.boolean() });
export const interventionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('tool-response'), tool: z.enum(['search_materials', 'lookup_record', 'update_record']), call: z.number().int().min(1).max(100), response: z.json().refine(v => JSON.stringify(v).length <= 12000), hypothesis: z.string().trim().min(1).max(2000) }),
  z.strictObject({ kind: z.literal('rag-fragment'), sourceId: z.string().min(1), sourceHash: hash, content: z.string().trim().min(1).max(12000), hypothesis: z.string().trim().min(1).max(2000) }),
]);
export type Intervention = z.infer<typeof interventionSchema>;
export const diagnosticRequestSchema = z.strictObject({ protocol: z.literal('paired-intervention-v1'), planId: z.string(), arm: z.enum(['baseline', 'intervention']), factorHash: hash, intervention: interventionSchema, requestHash: hash });
export type DiagnosticRequest = z.infer<typeof diagnosticRequestSchema>;
export const diagnosticReceiptSchema = z.strictObject({ protocol: z.literal('paired-intervention-v1'), requestHash: hash, arm: z.enum(['baseline', 'intervention']), factorHash: hash, appliedCount: z.number().int().min(0).max(1) });
export type DiagnosticReceipt = z.infer<typeof diagnosticReceiptSchema>;
export const SANDBOX_DIAGNOSTIC_CAPABILITIES = { protocol: 'paired-intervention-v1', toolResponse: true, ragFragment: true } as const;

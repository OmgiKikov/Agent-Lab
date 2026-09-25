import { z } from 'zod';

/*
 * The expected result of a card: the knowledge-base article the agent must retrieve and/or the fact it
 * must convey. The origin says who vouches for it; a model proposal counts only once a person confirms it.
 * Stored on both the pre-library scenario and the library card, so it lives apart from either.
 */
const text = z.string().trim().min(1);
/** The judge reads every expected text inside one rubric, whose criteria hold 2000 characters. */
export const REFERENCE_TEXT_TOTAL = 1500;

export const referenceSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
  origin: z.enum(['assessor', 'log', 'proposed', 'owner']),
  source: z.strictObject({ doc: text.max(500), chunk: text.max(500).optional() }).optional(),
  text: text.max(1000).optional(),
  confirmed: z.boolean(),
}).refine(r => r.source !== undefined || r.text !== undefined, 'Эталон должен содержать source или text.')
  .refine(r => r.origin === 'proposed' || r.confirmed, 'Неподтверждённым может быть только эталон, предложенный моделью.');
export type Reference = z.infer<typeof referenceSchema>;

export const referencesSchema = z.array(referenceSchema).max(4)
  .refine(v => new Set(v.map(r => r.id)).size === v.length, 'Повторяются идентификаторы эталонов.')
  .refine(v => v.reduce((sum, r) => sum + (r.text?.length ?? 0), 0) <= REFERENCE_TEXT_TOTAL, `Тексты эталонов карточки длиннее ${REFERENCE_TEXT_TOTAL} символов.`);

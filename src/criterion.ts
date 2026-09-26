import { criterionSchema, fingerprint, type Criterion, type Requirement } from './contracts.js';

/*
 * The criterion: the kernel every product of Lab judges by. DISCOVER puts it to logged conversations, VERIFY to
 * conversations with a customer Lab plays, PROTECT runs VERIFY's situations again; all three read the same thing.
 *
 *   sources / rules ─► criterion ─► evidence and judgment ─► a person's review
 *   (the owner's        (what the agent must or must not do, its rules — verbatim quotes —, the other ways that also
 *    materials)          fulfil it, what breaks it, the channel it is seen on)
 *
 * A plan's expectation (card/plan.ts) and a card's duty (card/schema.ts) are both criteria in their own clothes: the one
 * a log analysis judged and the one a situation judges are the same exactly when their hashes are. The hash is over the
 * criterion's own fields — never the materials whole, a conversation, a card, a plan or an id of either — so it survives
 * the move from a log analysis into a check. Pure: nothing here reads a store or calls a model.
 */

export type { Criterion } from './contracts.js';

/** The hash's own protocol: a change of what it covers is a new protocol, never an edit of this one. */
export const CRITERION_PROTOCOL = 'criterion-v1';

/** Anything that is a criterion in the clothes of a plan or a card: its words, rules, strength, ways and channel. */
export interface CriterionLike {
  text: string; requirementIds: readonly string[];
  strength?: 'must_not' | undefined; acceptable?: string | undefined; violation?: string | undefined;
  /** Absent on a plan's expectation made before plans named a channel: the agent's reply, as it always was. */
  observation?: 'reply' | 'tool' | 'state' | undefined; tool?: string | undefined;
}

/** The criterion an expectation stands for, with the rules it cites; undefined when one of them is not among `requirements`. */
export function criterionOf(expectation: CriterionLike, requirements: readonly Requirement[]): Criterion | undefined {
  const cited = expectation.requirementIds.map(id => requirements.find(requirement => requirement.id === id));
  if (!cited.length || cited.some(requirement => !requirement)) return undefined;
  const observation = expectation.observation ?? 'reply';
  const parsed = criterionSchema.safeParse({ text: expectation.text,
    requirements: (cited as Requirement[]).map(({ id, text, quote, sourceId }) => ({ id, text, quote, sourceId })),
    ...(expectation.strength === 'must_not' ? { strength: 'must_not' } : {}),
    ...(expectation.acceptable !== undefined ? { acceptable: expectation.acceptable } : {}), ...(expectation.violation !== undefined ? { violation: expectation.violation } : {}),
    observation, ...(observation === 'tool' && expectation.tool !== undefined ? { tool: expectation.tool } : {}) });
  return parsed.success ? parsed.data : undefined;
}

/**
 * The criterion's identity: its words exactly, its strength, the other ways and the violation, the channel and the tool,
 * and every rule it cites — the id, the sentence, the quote and the source —, in the order of their ids. Absent fields
 * hash as null, so a criterion written before a field existed and one that states it empty are the same.
 */
export function criterionHash(criterion: Criterion): string {
  return fingerprint({ protocol: CRITERION_PROTOCOL, text: criterion.text, strength: criterion.strength ?? 'must',
    acceptable: criterion.acceptable ?? null, violation: criterion.violation ?? null, observation: criterion.observation, tool: criterion.tool ?? null,
    requirements: [...criterion.requirements].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(({ id, text, quote, sourceId }) => ({ id, text, quote, sourceId })) });
}

/** The hash of the criterion an expectation stands for; undefined when a rule it cites is missing. */
export function expectationCriterionHash(expectation: CriterionLike, requirements: readonly Requirement[]): string | undefined {
  const criterion = criterionOf(expectation, requirements);
  return criterion && criterionHash(criterion);
}

/**
 * The rules of a criterion as a library keeps them: each one the sentence its quote stands in, a rule that binds and that
 * a user can see kept or broken — as a plan binds the rules it cites (card/plan.ts bindPlan).
 */
export function criterionRequirements(criterion: Criterion): Requirement[] {
  return criterion.requirements.map(({ id, text, quote, sourceId }) => ({ id, text, sourceId, quote, critical: true, observable: true }));
}

import { z } from 'zod';
import { fingerprint, type Requirement } from '../contracts.js';
import { text } from '../ids.js';
import type { CardTopic } from '../miner/schema.js';
import { countText } from '../plural.js';
import { basisProposal, citationId, located, type CallSource, type ProposalCall } from './proposal.js';
import type { BusinessScenario, LibraryV2 } from './schema.js';

/*
 * The business scenario of one topic of the logs: what a preparation checks before any card is written. Cards made
 * one by one each wrote their own duties, and nothing made two cards of one topic check the same thing; the plan
 * fixes it once — the question the customers of the topic come with, the variations of their circumstances that
 * change what the agent must do, and the expectations every card of the scenario shares — and the cards become its
 * examples (card/prepare.ts, proposal.ts).
 *
 *   topic ─► its sampled conversations' openings + every prompt + the articles ──one call──► question · variations ·
 *            expectations, each resting on a sentence of the sources, copied verbatim
 *        ─► harness: every quote found verbatim, every kind of rule in the owner's rulebook, every example one of the
 *            topic's own conversations, each at most once ─► library.plan, the rules it cites ─► library.requirements
 *
 * The logs give the examples: a variation names the conversations it stands for. A variation no conversation shows is
 * the builder's addition from the rules (`rules`), never presented as traffic. The builder proposes; the owner reads the
 * plan before anything is run on it.
 */

/** Everything one plan call is bound against. */
export interface PlanCall {
  topic: { title: string; key?: CardTopic };
  /** The topic's sampled conversations: each one's id and the customer's own words — never the old agent's replies. */
  examples: { dialogueId: string; customer: string[] }[];
  /** What the builder reads, the agent's prompts first: every expectation cites one of them, its quote verbatim. */
  sources: [CallSource, ...CallSource[]];
  /** What the owner's rulebook binds: whole kinds, and single rules of another kind by their source and quote. */
  binds: ProposalCall['binds'];
}
export interface PlanRequest { task: string; call: PlanCall }

/** At most so many variations and shared expectations: a scenario the owner reads on one screen. */
export const PLAN_VARIATIONS = 6;
export const PLAN_EXPECTATIONS = 6;

/** The plan as the builder proposes it: content only; the ids, the origins and the rules are the harness's. */
export function planProposalSchema(call: PlanCall) {
  const examples = call.examples.map(example => example.dialogueId);
  const example = examples.length ? z.enum(examples as [string, ...string[]], { error: 'Not a conversation of this topic: name only ids from examples.' }) : z.never();
  return z.strictObject({
    question: text(300),
    variations: z.array(z.strictObject({ title: text(160), examples: z.array(example).max(examples.length) })).min(1).max(PLAN_VARIATIONS),
    expectations: z.array(z.strictObject({
      text: text(300), strength: z.enum(['must', 'must_not']), acceptable: text(600).nullable(), violation: text(600).nullable(),
      basis: z.array(basisProposal(call)).min(1).max(3),
      // The places of the variations it applies to in `variations`; null — all of them.
      variations: z.array(z.number().int().nonnegative()).min(1).max(PLAN_VARIATIONS).nullable(),
    })).min(1).max(PLAN_EXPECTATIONS),
  });
}
export type PlanProposal = z.infer<ReturnType<typeof planProposalSchema>>;

/** What the builder reads: the task, the topic, the customers' words of its conversations, the sources, the rulebook. */
export function planPayload(request: PlanRequest) {
  const { call } = request;
  return { task: request.task, topic: call.topic.title, examples: call.examples,
    sources: call.sources.map(({ id, name, content, kind }) => ({ id, name: kind === 'prompt' ? `${name} (промпт агента)` : name, content })),
    rulebook: { binds: call.binds.kinds } };
}

/** Why a proposed plan cannot be bound, in the builder's words, or undefined: the structured task's check sends it back verbatim. */
export function planProblem(proposal: PlanProposal, call: PlanCall): string | undefined {
  const slips: string[] = [];
  const seen = new Map<string, number>();
  proposal.variations.forEach((variation, i) => variation.examples.forEach(dialogueId => {
    const earlier = seen.get(dialogueId);
    if (earlier !== undefined && earlier !== i) slips.push(`variations[${i}] and variations[${earlier}] both name conversation ${dialogueId}: every conversation is an example of one variation at most.`);
    seen.set(dialogueId, i);
  }));
  proposal.expectations.forEach((expectation, i) => {
    for (const index of expectation.variations ?? []) if (index >= proposal.variations.length) slips.push(`expectations[${i}].variations names ${index}, and there are ${proposal.variations.length} variations: use their places from 0, or null for all.`);
    expectation.basis.forEach((basis, j) => {
      const name = `expectations[${i}].basis[${j}]`;
      const at = located(basis, call);
      if (!at) slips.push(`${name}: the quote is not a verbatim substring of its source. Copy the exact characters instead of paraphrasing; a shorter contiguous fragment is safer.`);
      else if (!call.binds.kinds.includes(basis.kind) && !call.binds.rules.some(rule => rule.sourceId === at.sourceId && rule.quote === at.quote)) {
        slips.push(`${name} is a rule of kind ${basis.kind}, and the owner's rulebook binds the agent only by ${call.binds.kinds.join(', ')}: cite a rule of those kinds, or drop this expectation.`);
      }
    });
  });
  return slips.length ? slips.join('\n') : undefined;
}

/** The scenario a checked proposal makes and the rules it cites, as the library stores them. */
export function bindPlan(proposal: PlanProposal, call: PlanCall): { scenario: BusinessScenario; requirements: Requirement[] } {
  const rules = new Map<string, Requirement>();
  const variations = proposal.variations.map((variation, index) => ({ id: `v${index + 1}`, title: variation.title,
    origin: variation.examples.length ? 'logs' as const : 'rules' as const, examples: [...new Set(variation.examples)] }));
  const expectations = proposal.expectations.map((expectation, index) => {
    const requirementIds = expectation.basis.map(basis => {
      const at = located(basis, call);
      if (!at) throw new Error('Основание ожидания сценария не найдено дословно в материалах.');
      const id = citationId(at.sourceId, at.quote);
      if (!rules.has(id)) rules.set(id, { id, text: basis.rule, sourceId: at.sourceId, quote: at.quote, critical: true, observable: true, kind: basis.kind });
      return id;
    });
    return { id: `s${index + 1}`, text: expectation.text, requirementIds: [...new Set(requirementIds)],
      ...(expectation.strength === 'must_not' ? { strength: 'must_not' as const } : {}),
      ...(expectation.acceptable !== null ? { acceptable: expectation.acceptable } : {}), ...(expectation.violation !== null ? { violation: expectation.violation } : {}),
      ...(expectation.variations ? { variationIds: [...new Set(expectation.variations)].map(place => `v${place + 1}`) } : {}) };
  });
  const scenario: BusinessScenario = { id: `scenario_${fingerprint({ topic: call.topic.title, proposal }).slice(0, 24)}`, topic: call.topic.title,
    ...(call.topic.key ? { trafficTopic: call.topic.key } : {}), question: proposal.question, variations, expectations };
  return { scenario, requirements: [...rules.values()] };
}

/** The scenario of a topic in a library's plan: the one whose topic title it is. */
export const scenarioOfTopic = (plan: readonly BusinessScenario[] | undefined, topic: string): BusinessScenario | undefined =>
  plan?.find(scenario => scenario.topic === topic);

/** The expectations of a scenario that apply to one of its variations. */
export const variationExpectations = (scenario: BusinessScenario, variationId: string): BusinessScenario['expectations'] =>
  scenario.expectations.filter(expectation => !expectation.variationIds || expectation.variationIds.includes(variationId));

/**
 * The plan in the owner's words: each scenario's question, its variations — from the logs with their conversations, or
 * added from the rules and never traffic — and the expectations every card of it shares, with where they apply and the
 * ways and the violation the judge reads. Pure: each surface makes the lines safe and lays them out.
 */
export function planLines(library: Pick<LibraryV2, 'plan' | 'cards'>): string[] {
  const plan = library.plan ?? [];
  if (!plan.length) return [];
  const conversations = ['разговор', 'разговора', 'разговоров'] as const;
  return [`Что проверяем — ${countText(plan.length, ['сценарий', 'сценария', 'сценариев'])}:`, ...plan.flatMap(scenario => {
    const place = (id: string) => scenario.variations.findIndex(variation => variation.id === id) + 1;
    const cards = (variationId: string) => library.cards.filter(card => card.scenarioRef?.scenarioId === scenario.id && card.scenarioRef.variationId === variationId).length;
    return [
      `«${scenario.question}» — тема «${scenario.topic}»`,
      '  Варианты:',
      ...scenario.variations.map((variation, index) => `    ${index + 1}) ${variation.title} — ${variation.origin === 'logs'
        ? `из логов, ${countText(variation.examples.length, [...conversations])}` : 'добавлен по правилам, не из трафика'}${cards(variation.id) ? `; ситуаций: ${cards(variation.id)}` : ''}`),
      '  Ожидания:',
      ...scenario.expectations.map((expectation, index) => `    ${index + 1}. ${expectation.strength === 'must_not' ? 'нельзя: ' : ''}${expectation.text} — ${expectation.variationIds
        ? `для ${expectation.variationIds.length === 1 ? 'варианта' : 'вариантов'} ${expectation.variationIds.map(place).join(', ')}` : 'для всех вариантов'}${
        expectation.acceptable ? `; допустимо: ${expectation.acceptable}` : ''}${expectation.violation ? `; нарушение: ${expectation.violation}` : ''}`),
    ];
  })];
}

/** The title of the variation a card is an example of, or undefined for a card of no plan. */
export function variationOf(library: Pick<LibraryV2, 'plan'>, card: { scenarioRef?: { scenarioId: string; variationId: string } }): string | undefined {
  const ref = card.scenarioRef;
  return ref && library.plan?.find(scenario => scenario.id === ref.scenarioId)?.variations.find(variation => variation.id === ref.variationId)?.title;
}

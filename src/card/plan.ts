import { z } from 'zod';
import { fingerprint, type Requirement } from '../contracts.js';
import { text } from '../ids.js';
import type { CardTopic } from '../miner/schema.js';
import { countText } from '../plural.js';
import { basisProposal, citationId, groundingSlip, located, type CallSource, type ProposalCall } from './proposal.js';
import { dutyLine, dutyNotes, dutySections } from './duty-words.js';
import type { BusinessScenario, Card, LibraryV2 } from './schema.js';

/*
 * The business scenario of one topic of the logs: what a preparation checks before any card is written. Cards made
 * one by one each wrote their own duties, and nothing made two cards of one topic check the same thing; the plan
 * fixes it once — the question the customers of the topic come with, the variations of their circumstances that
 * change what the agent must do, and the expectations every card of the scenario shares — and the cards become its
 * examples (card/prepare.ts, proposal.ts).
 *
 *   topic ─► its sampled conversations' openings + every prompt + the articles ──one call──► question · variations ·
 *            expectations, each resting on a sentence of the sources, copied verbatim
 *        ─► harness: every quote found verbatim as a whole clause, every kind of rule in the owner's rulebook, every
 *            example one of the topic's own conversations, each at most once ─► library.plan, the rules it cites (each
 *            the sentence its quote stands in) ─► library.requirements
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
  // A variation is a circumstance that changes what the agent must do: one no expectation applies to would leave its
  // conversations with nothing to check, and the builder would report them as a gap in the owner's rules.
  proposal.variations.forEach((variation, i) => {
    if (!proposal.expectations.some(expectation => !expectation.variations || expectation.variations.includes(i))) {
      slips.push(`variations[${i}] «${variation.title}»: no expectation applies to it. A variation is a circumstance that changes what the agent must do: give it the expectations that apply to it (list its place in their variations, or null for all), or drop the variation and move its examples to the variation they belong to.`);
    }
  });
  proposal.expectations.forEach((expectation, i) => {
    for (const index of expectation.variations ?? []) if (index >= proposal.variations.length) slips.push(`expectations[${i}].variations names ${index}, and there are ${proposal.variations.length} variations: use their places from 0, or null for all.`);
    expectation.basis.forEach((basis, j) => {
      const name = `expectations[${i}].basis[${j}]`;
      const at = located(basis, call);
      const grounding = at && groundingSlip(name, at);
      if (!at) slips.push(`${name}: the quote is not a verbatim substring of its source. Copy the exact characters of a whole sentence or clause instead of paraphrasing.`);
      else if (grounding) slips.push(grounding);
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
      // What the judge reads as the rule is the sentence the quote stands in, as the owner wrote it (card/proposal.ts).
      if (!rules.has(id)) rules.set(id, { id, text: at.clause.sentence, sourceId: at.sourceId, quote: at.quote, critical: true, observable: true, kind: basis.kind });
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

/** Where an expectation of a scenario applies, in the owner's words: «для вариантов 1, 3» or «для всех вариантов». */
function appliesText(scenario: BusinessScenario, expectation: BusinessScenario['expectations'][number]): string {
  const place = (id: string) => scenario.variations.findIndex(variation => variation.id === id) + 1;
  return expectation.variationIds ? `для ${expectation.variationIds.length === 1 ? 'варианта' : 'вариантов'} ${expectation.variationIds.map(place).join(', ')}` : 'для всех вариантов';
}

/** A plan expectation as a duty is listed (card/duty-words.ts). */
const listed = (expectation: BusinessScenario['expectations'][number]) => ({ text: expectation.text, forbidden: expectation.strength === 'must_not',
  ...(expectation.acceptable ? { acceptable: expectation.acceptable } : {}), ...(expectation.violation ? { violation: expectation.violation } : {}) });

/** One expectation of a scenario in a line: what the agent must (not) do, where it applies, the other ways and the violation the judge reads. */
export function expectationLine(scenario: BusinessScenario, expectation: BusinessScenario['expectations'][number]): string {
  return [`${dutyLine(listed(expectation))} — ${appliesText(scenario, expectation)}`, ...dutyNotes(listed(expectation))].join('; ');
}

/** The cards of a library that are examples of a scenario, of one of its variations when named. */
const examplesOf = (library: Pick<LibraryV2, 'cards'>, scenarioId: string, variationId?: string) =>
  library.cards.filter(card => card.scenarioRef?.scenarioId === scenarioId && (variationId === undefined || card.scenarioRef.variationId === variationId));

/** The cards that check an expectation of a scenario — whose duty it is —, among `running` when named. */
const checking = (library: Pick<LibraryV2, 'cards'>, scenario: BusinessScenario, expectation: BusinessScenario['expectations'][number], running?: ReadonlySet<string>) =>
  examplesOf(library, scenario.id).filter(card => (!running || running.has(card.id)) && card.agentMust.some(duty => duty.planExpectationId === expectation.id));

const SCENARIOS = ['сценарий', 'сценария', 'сценариев'] as const;
const SITUATIONS = ['ситуация', 'ситуации', 'ситуаций'] as const;
/** How many situations check an expectation, as the plan says it: «проверяют 2 ситуации», or that none does. */
const checkedText = (count: number): string => count ? `${count === 1 ? 'проверяет' : 'проверяют'} ${countText(count, [...SITUATIONS])}` : 'ни одна ситуация не проверяет';
/** Where a variation no conversation shows comes from: never presented as traffic. */
const ORIGIN_TEXT = { rules: 'добавлен по правилам, не из трафика', owner: 'добавлен вами, не из трафика' } as const;

/** One variation in a line, as the owner confirms it: its title, where it comes from, and the expectations that apply to it. */
export function variationLine(scenario: BusinessScenario, variation: BusinessScenario['variations'][number]): string {
  const applies = dutySections(variationExpectations(scenario, variation.id).map(listed)).map(({ heading, items }) => `${heading}: ${items.map(item => item.duty.text).join('; ')}`);
  return `«${variation.title}» — ${variation.origin === 'logs' ? 'из логов' : ORIGIN_TEXT[variation.origin]}; ${applies.join(' · ') || 'ожиданий нет'}`;
}

/** The variations of a library's plan no situation is an example of yet, and no conversation shows: the ones a situation is written for from the rules. */
export function variationsWithout(library: Pick<LibraryV2, 'plan' | 'cards'>): { scenario: BusinessScenario; variation: BusinessScenario['variations'][number] }[] {
  return (library.plan ?? []).flatMap(scenario => scenario.variations.filter(variation => variation.origin !== 'logs'
    && !examplesOf(library, scenario.id, variation.id).length).map(variation => ({ scenario, variation })));
}

/**
 * The plan in the owner's words: each scenario's question, its variations — from the logs with their conversations, or
 * added from the rules and never traffic — and the expectations every card of it shares, with where they apply, the
 * ways and the violation the judge reads, and how many situations check each: an expectation none checks says so, so it
 * never reads as checked. Pure: each surface makes the lines safe and lays them out.
 */
export function planLines(library: Pick<LibraryV2, 'plan' | 'cards'>): string[] {
  const plan = library.plan ?? [];
  if (!plan.length) return [];
  const conversations = ['разговор', 'разговора', 'разговоров'] as const;
  return [`Что проверяем — ${countText(plan.length, [...SCENARIOS])}:`, ...plan.flatMap(scenario => {
    const cards = (variationId: string) => examplesOf(library, scenario.id, variationId).length;
    return [
      `«${scenario.question}» — тема «${scenario.topic}»`,
      '  Варианты:',
      ...scenario.variations.map((variation, index) => `    ${index + 1}) ${variation.title} — ${variation.origin === 'logs'
        ? `из логов, ${countText(variation.examples.length, [...conversations])}` : ORIGIN_TEXT[variation.origin]}${cards(variation.id) ? `; ситуаций: ${cards(variation.id)}` : '; ситуаций нет'}`),
      '  Ожидания:',
      ...scenario.expectations.map((expectation, index) => `    ${index + 1}. ${expectationLine(scenario, expectation)}; ${checkedText(checking(library, scenario, expectation).length)}`),
    ];
  })];
}

/**
 * What a run of `cardIds` checks, for the dialog that starts it: a line a scenario — the question, how many variations,
 * how many of the situations are its examples, and how many of its shared expectations they check —, then the shared
 * expectations no situation of the run checks, by name; the situations of no scenario counted apart. Empty for a
 * library without a plan.
 */
export function planSummary(library: Pick<LibraryV2, 'plan' | 'cards'>, cardIds: readonly string[]): string[] {
  const plan = library.plan ?? [];
  if (!plan.length) return [];
  const running = new Set(cardIds);
  const outside = library.cards.filter(card => running.has(card.id) && !plan.some(scenario => scenario.id === card.scenarioRef?.scenarioId)).length;
  return [`Что проверяем — ${countText(plan.length, [...SCENARIOS])}:`, ...plan.flatMap(scenario => {
    const unchecked = scenario.expectations.filter(expectation => !checking(library, scenario, expectation, running).length);
    const checked = scenario.expectations.length - unchecked.length;
    return [`  «${scenario.question}» — ${countText(scenario.variations.length, ['вариант', 'варианта', 'вариантов'])}; в прогоне ${
      countText(examplesOf(library, scenario.id).filter(card => running.has(card.id)).length, [...SITUATIONS])}; проверяется ${checked} из ${
      countText(scenario.expectations.length, ['общего ожидания', 'общих ожиданий', 'общих ожиданий'])}`,
    ...(unchecked.length ? [`    ни одна ситуация не проверяет: ${unchecked.map(expectation => `«${dutyLine(listed(expectation))}»`).join('; ')}`] : [])];
  }),
  ...(outside ? [`  Вне плана: ${countText(outside, [...SITUATIONS])}.`] : [])];
}

/**
 * The plan for a machine reader (the chat's model): each scenario by its place, which a change names, with the ids of its
 * variations and expectations and how many situations each variation has. The owner reads `planLines`.
 */
export function planData(library: Pick<LibraryV2, 'plan' | 'cards'>) {
  return (library.plan ?? []).map((scenario, index) => ({
    scenario: index + 1, question: scenario.question, topic: scenario.topic,
    variations: scenario.variations.map(variation => ({ id: variation.id, title: variation.title, origin: variation.origin, conversations: variation.examples.length,
      situations: examplesOf(library, scenario.id, variation.id).length })),
    expectations: scenario.expectations.map(expectation => ({ id: expectation.id, text: expectation.text, ...(expectation.strength ? { mustNot: true } : {}),
      ...(expectation.acceptable ? { acceptable: expectation.acceptable } : {}), ...(expectation.violation ? { violation: expectation.violation } : {}),
      ...(expectation.variationIds ? { variations: expectation.variationIds } : {}), situations: checking(library, scenario, expectation).length })),
  }));
}

/** Where a card's duty stands in the plan: its scenario's place and the plan expectation it is; undefined for a duty of its own. */
export function planPlace(library: Pick<LibraryV2, 'plan'>, card: Pick<Card, 'scenarioRef'>, duty: Pick<Card['agentMust'][number], 'planExpectationId'>): { scenario: number; expectation: string } | undefined {
  const index = card.scenarioRef && duty.planExpectationId ? (library.plan ?? []).findIndex(scenario => scenario.id === card.scenarioRef!.scenarioId) : -1;
  return index < 0 ? undefined : { scenario: index + 1, expectation: duty.planExpectationId! };
}

/** The title of the variation a card is an example of, or undefined for a card of no plan. */
export function variationOf(library: Pick<LibraryV2, 'plan'>, card: { scenarioRef?: { scenarioId: string; variationId: string } }): string | undefined {
  const ref = card.scenarioRef;
  return ref && library.plan?.find(scenario => scenario.id === ref.scenarioId)?.variations.find(variation => variation.id === ref.variationId)?.title;
}

/** A situation of a run as the plan counts it: its verdict and each duty's (e1…), over every attempt (run.ts). */
export interface PlannedSituation { scenarioId: string; outcome: 'pass' | 'fail' | 'unknown'; parts: readonly { id: string; outcome: 'pass' | 'fail' | 'unknown' }[] }

/**
 * One business scenario in a run's result: its situations handled of those decided and those not measured — over the
 * scenario and over each variation — and the expectations of the plan the agent broke, most often first, each of the
 * decided situations it was judged in. The answer to the owner's question in the plan's own words.
 */
export interface ScenarioOutcome {
  question: string;
  passed: number; decided: number; unmeasured: number;
  variations: { title: string; origin: BusinessScenario['variations'][number]['origin']; passed: number; decided: number; unmeasured: number }[];
  broken: { text: string; mustNot: boolean; count: number; of: number }[];
}

/**
 * The run's counted situations by the scenarios of the accepted plan; a scenario none of them is an example of is not
 * listed, and neither are situations of no scenario. Pure: the verdicts are the run's own (run.ts), never decided here.
 */
export function planOutcomes(library: Pick<LibraryV2, 'plan' | 'cards'>, situations: readonly PlannedSituation[]): ScenarioOutcome[] {
  const cards = new Map(library.cards.map(card => [card.id, card]));
  return (library.plan ?? []).flatMap(scenario => {
    const mine = situations.flatMap(situation => {
      const card = cards.get(situation.scenarioId);
      return card?.scenarioRef?.scenarioId === scenario.id ? [{ situation, card }] : [];
    });
    if (!mine.length) return [];
    const count = (items: typeof mine) => ({ passed: items.filter(item => item.situation.outcome === 'pass').length,
      decided: items.filter(item => item.situation.outcome !== 'unknown').length, unmeasured: items.filter(item => item.situation.outcome === 'unknown').length });
    const variations = scenario.variations.map(variation => ({ title: variation.title, origin: variation.origin,
      ...count(mine.filter(item => item.card.scenarioRef?.variationId === variation.id)) }));
    const broken = scenario.expectations.map(expectation => {
      const judged = mine.flatMap(({ situation, card }) => situation.outcome === 'unknown' ? []
        : card.agentMust.filter(duty => duty.planExpectationId === expectation.id).map(duty => situation.parts.find(part => part.id === duty.id)?.outcome ?? 'unknown'));
      return { text: expectation.text, mustNot: expectation.strength === 'must_not', count: judged.filter(outcome => outcome === 'fail').length,
        of: judged.filter(outcome => outcome !== 'unknown').length };
    }).filter(item => item.count > 0).sort((a, b) => b.count - a.count);
    return [{ question: scenario.question, ...count(mine), variations, broken }];
  });
}

import { z } from 'zod';
import { fingerprint, type Requirement, type Source } from '../contracts.js';
import { text } from '../ids.js';
import { MODEL_REQUEST_BYTES } from '../limits.js';
import { requirementKindSchema, type RequirementKind } from '../scenario-contracts.js';
import { clip } from '../text.js';
import { enoughWords, quotedClause, type QuotedClause } from '../verbatim.js';
import { cardFindings, filledMessage, normalizeText, PLAUSIBLE_VALUE_WORDS, type CardEvidence, type CheckFinding, type LoggedMessage } from './checks.js';
import { cardSchema, disclosureSchema, toolNameSchema, turnSchema, type BusinessScenario, type Card, type EventRef } from './schema.js';
import { fillSlip, maskSlots, slotAnswersSchema, slotFills, slotPayload, type FillAnswer, type MaskSlot } from './unmask.js';

/*
 * A card as the model proposes it and as the harness binds it (docs/design/card-v2-spec.md §2.1–2.3). The model returns content only;
 * every reference in its answer is an enum built for this one call — a customer message by its index, a source by
 * its id, a channel the connection offers, a tool it named — so an unknown reference cannot even be written. Each duty cites its basis
 * directly: a sentence of the agent's prompt or of an article, copied from a source of this call, and the kind of rule
 * it is. The harness finds every quote verbatim, holds its kind to the owner's rulebook and turns each cited sentence
 * into a library requirement whose id is a digest of the source and the sentence, so two cards citing one sentence
 * share one rule. It copies the opening and the turn from the messages word for word and gives the ids, the number and
 * the account of the later messages. A binding slip goes back to the model with its exact reason (the structured
 * task's check), inside the per-source allowance of the preparation.
 */

export type Observation = 'reply' | 'tool' | 'state';

/** Everything one proposal call is bound against. */
export interface ProposalCall {
  source: { kind: 'dialogue'; batchId: string; dialogueId: string } | { kind: 'rules'; unit: string };
  /** The dialogue's messages; none for a card from the owner's rules. */
  messages: LoggedMessage[];
  /** The customer's messages: the opening and every fact point at one of them. */
  customerEvents: number[];
  /** The customer's messages after the first one, each accounted for once. */
  laterEvents: number[];
  /** What the model reads for this situation, the agent's prompts first: every basis cites one of them, its quote verbatim. */
  sources: [CallSource, ...CallSource[]];
  /** What the owner's rulebook binds: whole kinds, and single rules of another kind by their source and quote. */
  binds: { kinds: RequirementKind[]; rules: { sourceId: string; quote: string }[] };
  /** Always the reply; a tool log or the state only where the connection confirmed it can be observed. */
  observations: ['reply', ...Observation[]];
  /** The agent's tools the connection named, offered with the tool channel: a duty observed on the tools names its tool among them (an enum of the call). */
  tools?: string[];
  /** The run's limit on the customer's messages: the card's required way must fit it. */
  maxTurns: number;
  /** The masking marks of the customer's messages (card/unmask.ts): the proposal answers each with a plausible value. */
  masked: MaskSlot[];
  /**
   * The business scenario of the unit's topic (card/plan.ts), when the preparation planned one: the card is an example of
   * one of its variations, and its duties are the plan's expectations for it — its words, rules, strength and ways.
   */
  plan?: { scenario: BusinessScenario; requirements: Requirement[];
    /**
     * The variation the plan decided for this situation — one written from the rules for a variation no conversation shows,
     * or a conversation the plan names as an example of one —: the builder is told it and does not choose.
     */
    variationId?: string };
}

export type CallSource = Pick<Source, 'id' | 'name' | 'content' | 'kind'>;

/** Behaviour and knowledge bind the bot unless the owner said otherwise (card/rulebook.ts DEFAULT_RULEBOOK). */
const DEFAULT_BINDS: ProposalCall['binds'] = { kinds: ['behavior', 'knowledge'], rules: [] };

export function proposalCall(input: { source: ProposalCall['source']; messages: LoggedMessage[]; sources: readonly CallSource[];
  binds?: ProposalCall['binds']; confirmedObservations?: ('tool' | 'state')[]; tools?: string[]; maxTurns: number; plan?: ProposalCall['plan'] }): ProposalCall {
  const [first, ...rest] = input.sources.map(({ id, name, content, kind }): CallSource => ({ id, name, content, ...(kind ? { kind } : {}) }));
  if (first === undefined) throw new Error('Ситуация строится только на материалах владельца, а их для неё нет.');
  const customer = input.messages.filter(message => message.role === 'user').map(message => message.index);
  const { source } = input;
  const masked = source.kind === 'dialogue' ? maskSlots(input.messages.filter(message => message.role === 'user')
    .map(message => ({ event: { batchId: source.batchId, dialogueId: source.dialogueId, eventIndex: message.index }, content: message.content }))) : [];
  return { source, messages: input.messages, customerEvents: customer, laterEvents: customer.slice(1),
    sources: [first, ...rest], binds: input.binds ?? DEFAULT_BINDS, observations: ['reply', ...(input.confirmedObservations ?? [])],
    ...(input.tools?.length ? { tools: [...input.tools] } : {}), maxTurns: input.maxTurns, masked, ...(input.plan ? { plan: input.plan } : {}) };
}

/** Plausible profile facts one card may add, and the card's facts in all: the brief stays one screen. */
export const PLAUSIBLE_LIMIT = 4;
export const KNOWS_LIMIT = 8;

const coverageAnswer = z.strictObject({ as: z.enum(['fact', 'turn', 'stop', 'ignored']), reason: text(200).nullable() });

/**
 * A duty's basis: a sentence of a source of this call, or a whole clause of one, and the kind of rule it is. What the rule
 * says is that sentence itself, as the owner wrote it (located): the builder never words a rule of its own.
 */
export function basisProposal(call: Pick<ProposalCall, 'sources'>) {
  const ids = call.sources.map(source => source.id) as [string, ...string[]];
  return z.strictObject({ sourceId: z.enum(ids, { error: 'Not a supplied source: cite only ids from sources.' }), quote: text(1500),
    kind: requirementKindSchema });
}

/**
 * A duty as the model proposes it. `tool` is asked only where the call offers the tool channel: the tool whose result
 * proves a duty observed on the tools, or null — for any other duty, and for one no single tool proves.
 */
export interface DutyProposal {
  text: string; basis: z.infer<ReturnType<typeof basisProposal>>[]; appliesWhen: string | null; observation: Observation;
  tool?: string | null;
  strength: 'must' | 'must_not'; acceptable: string | null; violation: string | null;
}

/** The tool of a duty: one the connection listed — an enum of this call — or, where it listed none, a name of its own. An answer without the field names none. */
function toolProposal(call: ProposalCall): z.ZodType<string | null> {
  const [first, ...rest] = call.tools ?? [];
  const name: z.ZodType<string> = first === undefined ? toolNameSchema : z.enum([first, ...rest], { error: 'Not a tool of this connection: name one of target.tools, or null.' });
  return name.nullable().default(null);
}

function expectationProposal(call: ProposalCall): z.ZodType<DutyProposal> {
  // An answer written before strength, acceptable and violation existed reads as a plain duty, as every card before them.
  const duty = { text: text(300), basis: z.array(basisProposal(call)).min(1).max(3), appliesWhen: text(300).nullable(), observation: z.enum(call.observations),
    strength: z.enum(['must', 'must_not']).default('must'), acceptable: text(600).nullable().default(null), violation: text(600).nullable().default(null) };
  return call.observations.includes('tool') ? z.strictObject({ ...duty, tool: toolProposal(call) }) : z.strictObject(duty);
}

/** A card from one dialogue. Absent values are null, never missing, so the schema also serves a provider's strict structured output. */
function dialogueProposalSchema(call: ProposalCall) {
  const message = z.literal(call.customerEvents);
  return z.strictObject({
    title: text(160), topic: text(120), wants: text(300),
    // Whether the customer's messages state a request; an answer written before the field existed reads as a clear one.
    clarity: z.enum(['clear', 'vague']).default('clear'),
    writesEvent: message,
    knows: z.array(z.strictObject({ label: text(120), value: z.union([text(120), z.number(), z.boolean()]).nullable(), disclosure: disclosureSchema,
      from: message.nullable(), askedAs: text(200).nullable() })).max(KNOWS_LIMIT),
    // Kept apart from `knows`: a plausible fact points at no message and is always named on request, so its binding
    // has no `from` and no disclosure to get wrong; a value is text or yes/no, never a number.
    plausibleKnows: z.array(z.strictObject({ label: text(120), value: z.union([text(120), z.boolean()]).nullable(), askedAs: text(200).nullable() })).max(PLAUSIBLE_LIMIT),
    leaves: text(300),
    turn: call.laterEvents.length ? z.strictObject({ kind: turnSchema.shape.kind, after: text(300), from: z.literal(call.laterEvents) }).nullable() : z.null(),
    // Empty only with `uncovered`: what the customer asks that no sentence of the sources — or no expectation of the plan — covers.
    agentMust: z.array(expectationProposal(call)).max(3),
    // A gap in the owner's rules, never a card: the owner is told of it. An answer written before the field existed covered its request.
    uncovered: text(300).nullable().default(null),
    // One key per later customer message: the schema, not a check after the answer, makes the account complete.
    coverage: z.strictObject(Object.fromEntries(call.laterEvents.map(index => [String(index), coverageAnswer]))),
    // One value per masking mark of the customer's messages, asked only when the dialogue has any.
    ...(call.masked.length ? { masked: slotAnswersSchema(call.masked) } : {}),
    // The variation of the business scenario this conversation is, asked only where the preparation planned one.
    ...(call.plan ? { variation: variationProposal(call.plan.scenario) } : {}),
  });
}

/** The variation of the scenario a card is an example of: an enum of the plan's own. */
function variationProposal(scenario: BusinessScenario) {
  const ids = scenario.variations.map(variation => variation.id) as [string, ...string[]];
  return z.enum(ids, { error: 'Not a variation of the plan: name one of plan.variations by id.' });
}

/** A card from the owner's rules alone: the model writes a typical opening; no personal facts, no turn, no logged messages. */
function rulesProposalSchema(call: ProposalCall) {
  return z.strictObject({ title: text(160), topic: text(120), wants: text(300), writes: text(3000), leaves: text(300),
    agentMust: z.array(expectationProposal(call)).min(1).max(3) });
}

export type DialogueProposal = Omit<z.infer<ReturnType<typeof dialogueProposalSchema>>, 'masked'> & { masked?: Record<string, FillAnswer> };
export type RulesProposal = z.infer<ReturnType<typeof rulesProposalSchema>>;
export type CardProposal = DialogueProposal | RulesProposal;

export function cardProposalSchema(call: ProposalCall): z.ZodType<CardProposal> {
  return call.source.kind === 'rules' ? rulesProposalSchema(call) : dialogueProposalSchema(call) as z.ZodType<DialogueProposal>;
}

/** Room for the whole evidence and the latest rejected proposal in a repair request. */
export const proposalBounds = (call: ProposalCall) => ({
  requestBytes: MODEL_REQUEST_BYTES + 16_000 + 500 * call.laterEvents.length + 150 * call.masked.length,
});

const said = (call: ProposalCall, index: number): string => call.messages.find(message => message.index === index)?.content ?? '';

type Basis = z.infer<ReturnType<typeof basisProposal>>;

/** Where a basis quote stands: the source that holds it, the source's own characters, and the clause of the source it is. */
export interface Located { sourceId: string; quote: string; clause: QuotedClause }

/**
 * Where a basis quote is verbatim, in the source's own characters: its cited source, or else exactly one other source of
 * the call, which then owns it — the sentence was copied right and the source named wrong.
 */
export function located(basis: Pick<Basis, 'sourceId' | 'quote'>, call: Pick<ProposalCall, 'sources'>): Located | undefined {
  const within = (source: CallSource): Located | undefined => {
    const clause = quotedClause(source.content, basis.quote);
    return clause && { sourceId: source.id, quote: clause.span, clause };
  };
  const cited = call.sources.find(source => source.id === basis.sourceId);
  const own = cited && within(cited);
  if (own) return own;
  const found = call.sources.flatMap(source => source.id === basis.sourceId ? [] : within(source) ?? []);
  return found.length === 1 ? found[0] : undefined;
}

/**
 * Why a verbatim quote cannot back a rule, in the builder's terms: it is not a whole clause of its sentence — a quote that
 * starts after «Не» or stops before «, только если…» says what the source does not —, or it is too short to state a rule.
 * The judge reads the whole sentence either way (dutyRequirements); this keeps what the owner reads as the rule honest too.
 */
export function groundingSlip(name: string, at: Located): string | undefined {
  const { clause } = at;
  const quote = `«${clip(clause.span, 120)}»`, sentence = `its sentence reads «${clip(clause.sentence, 300)}»`;
  if (!clause.opens) return `${name}: ${quote} starts in the middle of a clause — ${sentence}. Quote a whole sentence, or a whole clause of it from its first word: a quote that leaves out the words before it (a negation such as «Не», a condition) says what the source does not.`;
  if (!clause.closes) return `${name}: ${quote} stops in the middle of a clause — ${sentence}. Quote on to the end of the clause or of the sentence: a quote that leaves out the words after it (an exception, a condition) says what the source does not.`;
  if (!enoughWords(clause)) return `${name}: ${quote} is too short to state a rule — ${sentence}. Quote the whole clause or sentence the duty rests on.`;
  return undefined;
}

/** The id of the rule one cited sentence stands for: the same sentence of the same source is the same rule in every card. */
export const citationId = (sourceId: string, quote: string): string => `rule_${fingerprint({ sourceId, quote }).slice(0, 24)}`;

/** The variation of the plan whose examples name a conversation: the plan decided that conversation's variation. */
export const namedVariation = (scenario: BusinessScenario, source: ProposalCall['source']): BusinessScenario['variations'][number] | undefined =>
  source.kind === 'dialogue' ? scenario.variations.find(item => item.examples.includes(source.dialogueId)) : undefined;

/** The variation a card is an example of: the one the plan decided for it (plan.variationId), else the one the builder chose. */
const variationOfProposal = (proposal: CardProposal, call: ProposalCall): string | undefined =>
  call.plan?.variationId ?? ('variation' in proposal && typeof proposal.variation === 'string' ? proposal.variation : undefined);

/** The plan's expectation a duty is, by its words up to case and spacing; undefined without a plan or when it is none of them. */
function plannedOf(duty: Pick<DutyProposal, 'text'>, call: ProposalCall): BusinessScenario['expectations'][number] | undefined {
  const said = normalizeText(duty.text);
  return call.plan?.scenario.expectations.find(expectation => normalizeText(expectation.text) === said);
}

/**
 * Why the card of a planned scenario is not what the plan makes it: of another variation than the one the plan names its
 * conversation an example of, or with duties that are not the plan's expectations of its variation.
 */
function planSlips(proposal: CardProposal, call: ProposalCall): string[] {
  const plan = call.plan;
  if (!plan) return [];
  const variation = variationOfProposal(proposal, call);
  const slips: string[] = [];
  const named = namedVariation(plan.scenario, call.source);
  const answered = 'variation' in proposal && typeof proposal.variation === 'string' ? proposal.variation : undefined;
  if (named && answered !== undefined && answered !== named.id) {
    slips.push(`variation is ${answered}, but the plan names this conversation as an example of ${named.id} («${named.title}»): answer ${named.id} and take agentMust from the expectations of ${named.id}.`);
  }
  const seen = new Set<string>();
  proposal.agentMust.forEach((duty, i) => {
    const expectation = plannedOf(duty, call);
    if (!expectation) slips.push(`agentMust[${i}] is not an expectation of the plan: copy the text of one of plan.expectations exactly; never write a duty of your own.`);
    else if (variation && expectation.variationIds && !expectation.variationIds.includes(variation)) slips.push(`agentMust[${i}] is expectation ${expectation.id}, which applies to ${expectation.variationIds.join(', ')}, not to variation ${variation}: choose the expectations of this variation.`);
    else if (seen.has(expectation.id)) slips.push(`agentMust[${i}] repeats expectation ${expectation.id}: each expectation once.`);
    if (expectation) seen.add(expectation.id);
  });
  return slips;
}

/**
 * The rules each duty of a proposal rests on, as the library stores them. The rule's text — what the judge reads as the
 * rule — is the sentence of the source the quote stands in, never the builder's own words. A cited sentence is a rule a
 * user can see kept or broken in a reply — the proposal may cite nothing else (CARD_ROLE) — so `observable` is stated,
 * never guessed. A duty that is an expectation of the plan rests on the plan's rules, already in the library.
 */
function dutyRequirements(proposal: CardProposal, call: ProposalCall): Requirement[][] {
  return proposal.agentMust.map(duty => {
    const planned = plannedOf(duty, call);
    if (planned) return planned.requirementIds.map(id => call.plan!.requirements.find(requirement => requirement.id === id)
      ?? (() => { throw new Error(`Правило ${id} плана сценария не найдено в наборе.`); })());
    return duty.basis.map(basis => {
    const at = located(basis, call);
    if (!at) throw new Error('Основание ожидания не найдено дословно в материалах.');
    return { id: citationId(at.sourceId, at.quote), text: at.clause.sentence, sourceId: at.sourceId, quote: at.quote, critical: true, observable: true, kind: basis.kind };
    });
  });
}

/** The rules a proposal cites, once each: what a preparation adds to the library beside its card. */
export function proposalRequirements(proposal: CardProposal, call: ProposalCall): Requirement[] {
  const unique = new Map<string, Requirement>();
  for (const requirement of dutyRequirements(proposal, call).flat()) if (!unique.has(requirement.id)) unique.set(requirement.id, requirement);
  return [...unique.values()];
}

/** Why a basis cannot back a duty: its quote is not in the sources or not a whole clause there, or its kind of rule is outside the owner's rulebook. */
function basisSlips(proposal: CardProposal, call: ProposalCall): string[] {
  const slips: string[] = [];
  // A duty that is an expectation of the plan rests on the plan's rules: its own citations are not read.
  proposal.agentMust.forEach((duty, i) => plannedOf(duty, call) ? undefined : duty.basis.forEach((basis, j) => {
    const at = located(basis, call);
    const name = `agentMust[${i}].basis[${j}]`;
    const grounding = at && groundingSlip(name, at);
    if (!at) {
      const source = call.sources.find(item => item.id === basis.sourceId);
      slips.push(`${name}: the quote is not a verbatim substring of "${source?.name ?? basis.sourceId}". Copy the exact characters of a whole sentence or clause from the source instead of paraphrasing.`);
    } else if (grounding) slips.push(grounding);
    else if (!call.binds.kinds.includes(basis.kind) && !call.binds.rules.some(rule => rule.sourceId === at.sourceId && rule.quote === at.quote)) {
      slips.push(`${name} is a rule of kind ${basis.kind}, and the owner's rulebook binds the agent only by ${call.binds.kinds.join(', ')}: cite a rule of those kinds, or drop this duty.`);
    }
  }));
  return slips;
}

/**
 * The messages a dialogue card reads — its opening, its turn, its facts' — as the card holds them: the values the proposal
 * wrote over their masking marks in place, every other character as logged. The binding and its checks read the same.
 */
function readMessages(proposal: DialogueProposal, call: ProposalCall) {
  if (call.source.kind !== 'dialogue') throw new Error('Предложение по диалогу пришло на ситуацию из правил.');
  const { batchId, dialogueId } = call.source;
  const event = (eventIndex: number): EventRef => ({ batchId, dialogueId, eventIndex });
  const read = new Set([proposal.writesEvent, ...(proposal.turn ? [proposal.turn.from] : []), ...proposal.knows.flatMap(fact => fact.from === null ? [] : [fact.from])]);
  const filled = slotFills(call.masked.filter(slot => read.has(slot.event.eventIndex)), proposal.masked ?? {});
  return { origin: { batchId, dialogueId }, event, filled, says: (index: number) => filledMessage(said(call, index), filled, event(index)) };
}

/**
 * The card a proposal stands for: ids e1…, f1…; the opening and the turn copied from their messages; a fact with
 * no message behind it `unconfirmed` (the owner is asked); the plausible profile facts after the logged ones, named on
 * request and `plausible` until the owner decides their label; the account of every later customer message but the
 * opening itself; a duty observed on the tools with the tool it named. The id is a digest of the source and the
 * proposal — a card is bound once and keeps its id, so nothing ever derives it again; the number is the library's next one.
 */
export function bindProposal(proposal: CardProposal, call: ProposalCall, number: number): Card {
  const cited = dutyRequirements(proposal, call);
  const agentMust = proposal.agentMust.map((item, index) => {
    // A duty of the plan takes the plan's words, strength and ways; the card keeps only where it applies and how it is seen.
    const planned = plannedOf(item, call);
    const own = planned ?? { text: item.text, ...(item.strength === 'must_not' ? { strength: 'must_not' as const } : {}),
      ...(item.acceptable !== null ? { acceptable: item.acceptable } : {}), ...(item.violation !== null ? { violation: item.violation } : {}) };
    return { id: `e${index + 1}`, text: own.text, requirementIds: [...new Set(cited[index]!.map(requirement => requirement.id))],
      ...(item.appliesWhen !== null ? { appliesWhen: item.appliesWhen } : {}), observation: item.observation,
      ...(item.observation === 'tool' && typeof item.tool === 'string' ? { tool: item.tool } : {}),
      ...(own.strength === 'must_not' ? { strength: 'must_not' as const } : {}),
      ...(own.acceptable !== undefined ? { acceptable: own.acceptable } : {}), ...(own.violation !== undefined ? { violation: own.violation } : {}),
      ...(planned ? { planExpectationId: planned.id } : {}) };
  });
  const variation = variationOfProposal(proposal, call);
  const common = { id: `card_${fingerprint({ source: call.source, proposal })}`, number, title: proposal.title, topic: proposal.topic, agentMust, revision: 1,
    ...(call.plan && variation ? { scenarioRef: { scenarioId: call.plan.scenario.id, variationId: variation } } : {}) };
  if ('writes' in proposal) {
    if (call.source.kind !== 'rules') throw new Error('Предложение без реплик клиента пришло на диалог.');
    return cardSchema.parse({ ...common, origin: { kind: 'rules', requirementIds: [...new Set(agentMust.flatMap(item => item.requirementIds))] },
      client: { wants: proposal.wants, writes: proposal.writes, writesSource: { kind: 'model' }, knows: [], leaves: proposal.leaves }, coverage: [] });
  }
  const { origin, event, filled, says } = readMessages(proposal, call);
  const logged = proposal.knows.map((fact, index) => ({ id: `f${index + 1}`, label: fact.label, ...(fact.value !== null ? { value: fact.value } : {}),
    disclosure: fact.disclosure, ...(fact.askedAs !== null ? { askedAs: fact.askedAs } : {}),
    source: fact.from === null ? { kind: 'unconfirmed' } : { kind: 'dialogue', event: event(fact.from) } }));
  const plausible = proposal.plausibleKnows.map((fact, index) => ({ id: `f${logged.length + index + 1}`, label: fact.label, ...(fact.value !== null ? { value: fact.value } : {}),
    disclosure: 'on_request', ...(fact.askedAs !== null ? { askedAs: fact.askedAs } : {}), source: { kind: 'plausible' } }));
  const knows = [...logged, ...plausible];
  const turn = proposal.turn && { kind: proposal.turn.kind, after: proposal.turn.after, says: says(proposal.turn.from),
    source: { kind: 'dialogue', event: event(proposal.turn.from) } };
  const coverage = call.laterEvents.filter(index => index !== proposal.writesEvent).map(index => {
    const answer = proposal.coverage[String(index)];
    if (!answer) throw new Error(`Нет учёта реплики клиента ${index}.`);
    return { event: event(index), as: answer.as, ...(answer.reason !== null ? { reason: answer.reason } : {}) };
  });
  return cardSchema.parse({ ...common, origin: { kind: 'dialogue', ...origin },
    client: { wants: proposal.wants, writes: says(proposal.writesEvent), writesSource: { kind: 'dialogue', event: event(proposal.writesEvent) },
      knows, leaves: proposal.leaves, ...(turn ? { turn } : {}) }, coverage, ...(proposal.clarity === 'vague' ? { clarity: 'vague' } : {}),
    ...(filled.length ? { filled } : {}) });
}

/** The call's own messages as the evidence of the checks. */
const callEvidence = (call: ProposalCall): CardEvidence => ({
  messages: (batchId, dialogueId) => call.source.kind === 'dialogue' && call.source.batchId === batchId && call.source.dialogueId === dialogueId ? call.messages : undefined,
});

/** The characters a card's opening and its turn hold at most (schema.ts `client.writes`, `turn.says`). */
const OPENING_CHARS = 3000;
const TURN_CHARS = 1000;

/**
 * What the binding itself cannot hold: an ignored message without a reason, or a message too long for its field as the
 * card reads it — with the proposal's values over its masking marks in place, so a length is never first found by the
 * card's schema, which would stop the step instead of asking for a repair.
 */
function bindingSlips(proposal: DialogueProposal, call: ProposalCall): string[] {
  const slips: string[] = [];
  if (proposal.knows.length + proposal.plausibleKnows.length > KNOWS_LIMIT) slips.push(`knows and plausibleKnows hold ${proposal.knows.length + proposal.plausibleKnows.length} facts together; at most ${KNOWS_LIMIT}: drop the least useful plausible ones.`);
  const { says } = readMessages(proposal, call);
  const tooLong = (index: number, limit: number, field: string, instead: string): string | undefined => {
    const read = says(index).trim().length;
    if (read <= limit) return undefined;
    return said(call, index).trim().length > limit ? `Customer message ${index} is longer than ${limit} characters and cannot be ${field}: ${instead}.`
      : `Customer message ${index} reads ${read} characters with your values for its masking marks in place, and ${field} holds at most ${limit}: write shorter values for its marks in "masked", or ${instead}.`;
  };
  const opening = tooLong(proposal.writesEvent, OPENING_CHARS, 'the opening', 'choose another writesEvent');
  if (opening) slips.push(opening);
  const turn = proposal.turn && tooLong(proposal.turn.from, TURN_CHARS, 'the turn', 'set "turn" to null or choose another message');
  if (turn) slips.push(turn);
  for (const index of call.laterEvents) {
    const answer = proposal.coverage[String(index)];
    if (index !== proposal.writesEvent && answer?.as === 'ignored' && answer.reason === null) slips.push(`coverage["${index}"] is "ignored": give a short reason.`);
  }
  for (const [id, fill] of Object.entries(proposal.masked ?? {})) {
    const slip = fillSlip(`masked["${id}"]`, fill);
    if (slip) slips.push(slip);
  }
  return slips;
}

/** A tool is named only by a duty observed on the tools: the harness checks it there alone. */
function toolSlips(proposal: CardProposal): string[] {
  return proposal.agentMust.flatMap((duty, i) => typeof duty.tool === 'string' && duty.observation !== 'tool'
    ? [`agentMust[${i}] is observed on "${duty.observation}" and names the tool "${duty.tool}": set "tool" to null, or observe the duty on "tool" when only the tool log proves it.`] : []);
}

/** A finding in the words of the proposal the model wrote: its fields, indexes and message numbers. */
function repairText(finding: CheckFinding, card: Card, call: ProposalCall): string {
  const opening = card.client.writesSource.kind === 'dialogue' ? card.client.writesSource.event.eventIndex : undefined;
  // Plausible facts are bound after the logged ones, so a card's fact index past `knows` is its place in `plausibleKnows`.
  const logged = card.client.knows.filter(item => item.source.kind !== 'plausible').length;
  const fact = (factId: string) => {
    const index = card.client.knows.findIndex(item => item.id === factId);
    const item = card.client.knows[index]!;
    const name = index < logged ? `knows[${index}] "${item.label}"` : `plausibleKnows[${index - logged}] "${item.label}"`;
    return { name, value: JSON.stringify(item.value), from: item.source.kind === 'dialogue' ? item.source.event.eventIndex : null, plausible: index >= logged };
  };
  switch (finding.check) {
    // The harness writes the masked values in; a mark is left only past the slots one call offers, which no repair changes.
    case 'masked-opening': case 'masked-turn': return '';
    case 'masked-fact': return `${fact(finding.factId).name}: the value ${fact(finding.factId).value} is a masking mark. Write the value you gave for its mark in "masked", as the message reads with it, or null.`;
    case 'fact-from-event': {
      const { name, value, from } = fact(finding.factId);
      return `${name}: the value ${value} is not in customer message ${from} as whole words. Copy the value exactly as the customer wrote it, never a piece of a longer word or number, and point "from" at a message that contains it, or set "from" to null.`;
    }
    case 'initial-in-opening': return `${fact(finding.factId).name} is "initial", so it is said in the opening: its "from" must be writesEvent ${opening}. Otherwise choose "on_request" or "unknown".`;
    case 'hidden-not-in-opening': {
      const { name, value, from, plausible } = fact(finding.factId);
      // The same words may stand in the opening for something else: the model is offered the true way out first, never pushed to «initial».
      if (plausible) return `${name}: its value ${value} stands in the opening (message ${opening}). If the opening states this very fact, it is a knows item ("initial", "from": ${opening}); otherwise drop it.`;
      return `${name} is not "initial", but its value ${value} stands as whole words in the opening (message ${opening}). If those words there mean something else, write the value together with the words that make it this fact, exactly as the customer wrote them${from === null ? '' : ` in message ${from}`} (e.g. "3 покупки", not "3"). Only if the opening itself states this fact, mark it "initial" with "from": ${opening}.`;
    }
    case 'unknown-never-said': {
      const { name, value } = fact(finding.factId);
      return `${name} is "unknown", yet its value ${value} appears in ${finding.where === 'turn' ? 'the turn message' : '"leaves"'}: the customer never says a value they do not know.`;
    }
    case 'plausible-value': {
      const { name, value } = fact(finding.factId);
      return `${name}: the value ${value} is a number, a code or a long text. A plausible fact is a quality the customer knows about their own business, from a small closed set of at most ${PLAUSIBLE_VALUE_WORDS} words without digits ("POS-терминал", "заявка подана", true), or null; never a number, an amount, a date or an identifier the agent must look up.`;
    }
    case 'coverage-refs': {
      const key = `coverage["${finding.eventIndex}"]`;
      return {
        no_fact: `${key} is "fact", but no knows item has "from": ${finding.eventIndex}.`,
        no_turn: `${key} is "turn", but "turn.from" is not ${finding.eventIndex}.`,
        turn_uncovered: `"turn.from" is ${finding.eventIndex}: it must be a customer message after the opening, and ${key} must be "turn".`,
        second_stop: `${key}: only one customer message can be "stop".`,
        ignored_source: `${key} is "ignored", but a fact or the turn comes from message ${finding.eventIndex}: mark it "fact" or "turn".`,
        before_opening: `${key}: message ${finding.eventIndex} comes before the opening (writesEvent ${opening}), so it is "ignored" with a reason, or "fact".`,
      }[finding.problem];
    }
    case 'requirements-grounded': return `The quote of rule ${finding.requirementId} is not in its source: copy the exact characters of the source.`;
    case 'controller-compiles': return finding.needed === null ? 'The customer\'s facts, turn and exit do not form a finite conversation: simplify the turn and the facts.'
      : `The customer needs ${finding.needed} messages to finish this situation, but a run allows ${call.maxTurns}: drop the turn or merge facts.`;
  }
}

/**
 * The structured task's domain check of a proposal: undefined when it binds into a card that passes every
 * deterministic check, otherwise every reason at once, so one repair fixes them all.
 */
/**
 * What the customer of a dialogue asks that the owner's rules leave open, when the builder found no duty for it: a gap
 * in the rules the owner is told of, never a card. Undefined for a proposal with duties, or one from the rules.
 */
export const uncoveredOf = (proposal: CardProposal): string | undefined =>
  'writes' in proposal || proposal.agentMust.length ? undefined : proposal.uncovered ?? undefined;

/**
 * Why «no expectation of the plan fits» cannot be the answer: the plan names this conversation as an example of a
 * variation, and every variation has expectations that apply to it (card/plan.ts planProblem).
 */
function coveredByPlan(call: ProposalCall): string | undefined {
  const named = call.plan && namedVariation(call.plan.scenario, call.source);
  // An expectation without variations applies to all of them (card/plan.ts variationExpectations).
  if (!call.plan || !named || !call.plan.scenario.expectations.some(expectation => !expectation.variationIds || expectation.variationIds.includes(named.id))) return undefined;
  return `uncovered is set, but the plan names this conversation as an example of ${named.id} («${named.title}»), whose expectations apply to it: answer variation ${named.id}, take agentMust from its expectations (their text exactly) and set uncovered to null.`;
}

/** Duties or a gap, never both and never neither. */
function gapSlips(proposal: CardProposal): string[] {
  if ('writes' in proposal) return [];
  if (!proposal.agentMust.length && proposal.uncovered === null) return ['agentMust is empty and uncovered is null: name the duties the quoted rules give the agent here, or — only when no sentence of the sources says what the agent must do for this request — say in uncovered what the customer asks.'];
  if (proposal.agentMust.length && proposal.uncovered !== null) return ['uncovered is set while agentMust names duties: when a rule covers the request, uncovered is null.'];
  return [];
}

export function cardProposalProblem(proposal: CardProposal, call: ProposalCall): string | undefined {
  const gap = gapSlips(proposal);
  if (gap.length) return gap.join(' ');
  // A gap is an answer, not a card: nothing of it is bound or kept, so nothing else of it is held to the card's checks —
  // but a conversation the plan names as an example of a variation is covered by that variation's expectations.
  if (uncoveredOf(proposal)) return coveredByPlan(call);
  const slips = [...planSlips(proposal, call), ...basisSlips(proposal, call), ...toolSlips(proposal), ...'writes' in proposal ? [] : bindingSlips(proposal, call)];
  if (slips.length) return slips.join(' ');
  // Every bound of the stored card an answer can break is a slip above: binding never stops the step with a schema error.
  const card = bindProposal(proposal, call, 1);
  // A mark left past the call's slots is not the model's slip: the card's check shows it, and the owner or a later fill settles it.
  const findings = cardFindings(card, { evidence: callEvidence(call), maxTurns: call.maxTurns }).filter(finding => finding.check !== 'masked-opening' && finding.check !== 'masked-turn');
  return findings.length ? findings.map(finding => repairText(finding, card, call)).join(' ') : undefined;
}

/** One proposal call: what the harness binds against — its sources among it — and what the model reads. */
export interface CardProposalRequest {
  task: string;
  call: ProposalCall;
  /** Topics the library already has: the same topic is written the same way. */
  topics: string[];
  /** Titles of the situations already written from the owner's rules: the next one is a different situation. */
  written: string[];
  /** The one revision of a card the reviewer blocked: that card as the reviewer read it, and the reviewer's reason for each blocked claim. */
  revision?: { previous: unknown; blocked: { claim: string; reason: string }[] };
}

/** What the model reads: the request without the harness's bookkeeping. */
export function proposalPayload(request: CardProposalRequest) {
  const { call } = request;
  return {
    task: request.task, mode: call.source.kind,
    ...(call.source.kind === 'dialogue' ? { dialogue: { messages: call.messages } } : {}),
    ...(call.masked.length ? { masked: slotPayload(call.masked) } : {}),
    // A source that is the agent's own prompt is labelled; the rulebook says which kinds of rule may back a duty.
    sources: call.sources.map(({ id, name, content, kind }) => ({ id, name: kind === 'prompt' ? `${name} (промпт агента)` : name, content })),
    rulebook: { binds: call.binds.kinds },
    topics: request.topics, ...(request.written.length ? { written: request.written } : {}),
    target: { observations: call.observations, ...(call.tools ? { tools: call.tools } : {}) },
    ...(request.revision ? { revise: request.revision } : {}),
    ...(call.plan ? { plan: planView(call.plan) } : {}),
  };
}

/** The plan as the card writer reads it: the scenario's variations and its expectations with their rules, quoted; the variation a situation from the rules is written for. */
function planView(plan: NonNullable<ProposalCall['plan']>) {
  const { scenario, requirements } = plan;
  return { question: scenario.question, variations: scenario.variations.map(({ id, title }) => ({ id, title })), ...(plan.variationId ? { variation: plan.variationId } : {}),
    expectations: scenario.expectations.map(expectation => ({ id: expectation.id, text: expectation.text, strength: expectation.strength ?? 'must',
      acceptable: expectation.acceptable ?? null, violation: expectation.violation ?? null, variations: expectation.variationIds ?? null,
      rules: expectation.requirementIds.flatMap(id => requirements.filter(requirement => requirement.id === id).map(({ quote, text }) => ({ quote, rule: text }))) })) };
}

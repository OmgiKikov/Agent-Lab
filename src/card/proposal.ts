import { z } from 'zod';
import { fingerprint, type Requirement, type Source } from '../contracts.js';
import { text } from '../ids.js';
import { MODEL_REQUEST_BYTES } from '../limits.js';
import { requirementKindSchema, type RequirementKind } from '../scenario-contracts.js';
import { verbatimSpan } from '../verbatim.js';
import { cardFindings, filledMessage, PLAUSIBLE_VALUE_WORDS, type CardEvidence, type CheckFinding, type LoggedMessage } from './checks.js';
import { cardSchema, disclosureSchema, turnSchema, type Card } from './schema.js';
import { fillSlip, maskSlots, slotAnswersSchema, slotFills, slotPayload, type FillAnswer, type MaskSlot } from './unmask.js';

/*
 * A card as the model proposes it and as the harness binds it (docs/design/card-v2-spec.md §2.1–2.3). The model returns content only;
 * every reference in its answer is an enum built for this one call — a customer message by its index, a source by
 * its id, a channel the connection offers — so an unknown reference cannot even be written. Each duty cites its basis
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
  /** The agent's tools the connection named, offered with the tool channel: a tool expectation names one of them in plain words. */
  tools?: string[];
  /** The run's limit on the customer's messages: the card's required way must fit it. */
  maxTurns: number;
  /** The masking marks of the customer's messages (card/unmask.ts): the proposal answers each with a plausible value. */
  masked: MaskSlot[];
}

export type CallSource = Pick<Source, 'id' | 'name' | 'content' | 'kind'>;

/** Behaviour and knowledge bind the bot unless the owner said otherwise (card/rulebook.ts DEFAULT_RULEBOOK). */
const DEFAULT_BINDS: ProposalCall['binds'] = { kinds: ['behavior', 'knowledge'], rules: [] };

export function proposalCall(input: { source: ProposalCall['source']; messages: LoggedMessage[]; sources: readonly CallSource[];
  binds?: ProposalCall['binds']; confirmedObservations?: ('tool' | 'state')[]; tools?: string[]; maxTurns: number }): ProposalCall {
  const [first, ...rest] = input.sources.map(({ id, name, content, kind }): CallSource => ({ id, name, content, ...(kind ? { kind } : {}) }));
  if (first === undefined) throw new Error('Ситуация строится только на материалах владельца, а их для неё нет.');
  const customer = input.messages.filter(message => message.role === 'user').map(message => message.index);
  const { source } = input;
  const masked = source.kind === 'dialogue' ? maskSlots(input.messages.filter(message => message.role === 'user')
    .map(message => ({ event: { batchId: source.batchId, dialogueId: source.dialogueId, eventIndex: message.index }, content: message.content }))) : [];
  return { source, messages: input.messages, customerEvents: customer, laterEvents: customer.slice(1),
    sources: [first, ...rest], binds: input.binds ?? DEFAULT_BINDS, observations: ['reply', ...(input.confirmedObservations ?? [])],
    ...(input.tools?.length ? { tools: [...input.tools] } : {}), maxTurns: input.maxTurns, masked };
}

/** Plausible profile facts one card may add, and the card's facts in all: the brief stays one screen. */
export const PLAUSIBLE_LIMIT = 4;
export const KNOWS_LIMIT = 8;

const coverageAnswer = z.strictObject({ as: z.enum(['fact', 'turn', 'stop', 'ignored']), reason: text(200).nullable() });

/** A duty's basis: a sentence of a source of this call, the rule it states in one line, and the kind of that rule. */
function basisProposal(call: ProposalCall) {
  const ids = call.sources.map(source => source.id) as [string, ...string[]];
  return z.strictObject({ sourceId: z.enum(ids, { error: 'Not a supplied source: cite only ids from sources.' }), quote: text(1500),
    rule: text(300), kind: requirementKindSchema });
}

function expectationProposal(call: ProposalCall) {
  return z.strictObject({ text: text(300), basis: z.array(basisProposal(call)).min(1).max(3),
    appliesWhen: text(300).nullable(), observation: z.enum(call.observations) });
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
    agentMust: z.array(expectationProposal(call)).min(1).max(3),
    // One key per later customer message: the schema, not a check after the answer, makes the account complete.
    coverage: z.strictObject(Object.fromEntries(call.laterEvents.map(index => [String(index), coverageAnswer]))),
    // One value per masking mark of the customer's messages, asked only when the dialogue has any.
    ...(call.masked.length ? { masked: slotAnswersSchema(call.masked) } : {}),
  });
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

/** The answer and the whole request of one proposal call, in UTF-8 bytes: each later message adds one bounded coverage answer. */
export const proposalBounds = (call: ProposalCall) => {
  const outputBytes = 16_000 + 500 * call.laterEvents.length + 150 * call.masked.length;
  return { outputBytes, requestBytes: MODEL_REQUEST_BYTES + outputBytes };
};

const said = (call: ProposalCall, index: number): string => call.messages.find(message => message.index === index)?.content ?? '';

type Basis = CardProposal['agentMust'][number]['basis'][number];

/**
 * Where a basis quote is verbatim, in the source's own characters: its cited source, or else exactly one other source of
 * the call, which then owns it — the sentence was copied right and the source named wrong.
 */
function located(basis: Basis, call: ProposalCall): { sourceId: string; quote: string } | undefined {
  const cited = call.sources.find(source => source.id === basis.sourceId);
  const exact = cited && verbatimSpan(cited.content, basis.quote);
  if (cited && exact) return { sourceId: cited.id, quote: exact };
  const found = call.sources.flatMap(source => {
    const span = source.id === basis.sourceId ? undefined : verbatimSpan(source.content, basis.quote);
    return span ? [{ sourceId: source.id, quote: span }] : [];
  });
  return found.length === 1 ? found[0] : undefined;
}

/** The id of the rule one cited sentence stands for: the same sentence of the same source is the same rule in every card. */
export const citationId = (sourceId: string, quote: string): string => `rule_${fingerprint({ sourceId, quote }).slice(0, 24)}`;

/**
 * The rules each duty of a proposal rests on, as the library stores them. A cited sentence is a rule a user can see kept
 * or broken in a reply — the proposal may cite nothing else (CARD_ROLE) — so `observable` is stated, never guessed.
 */
function dutyRequirements(proposal: CardProposal, call: ProposalCall): Requirement[][] {
  return proposal.agentMust.map(duty => duty.basis.map(basis => {
    const at = located(basis, call);
    if (!at) throw new Error('Основание ожидания не найдено дословно в материалах.');
    return { id: citationId(at.sourceId, at.quote), text: basis.rule, sourceId: at.sourceId, quote: at.quote, critical: true, observable: true, kind: basis.kind };
  }));
}

/** The rules a proposal cites, once each: what a preparation adds to the library beside its card. */
export function proposalRequirements(proposal: CardProposal, call: ProposalCall): Requirement[] {
  const unique = new Map<string, Requirement>();
  for (const requirement of dutyRequirements(proposal, call).flat()) if (!unique.has(requirement.id)) unique.set(requirement.id, requirement);
  return [...unique.values()];
}

/** Why a basis cannot back a duty: its quote is not in the sources, or its kind of rule is outside the owner's rulebook. */
function basisSlips(proposal: CardProposal, call: ProposalCall): string[] {
  const slips: string[] = [];
  proposal.agentMust.forEach((duty, i) => duty.basis.forEach((basis, j) => {
    const at = located(basis, call);
    const name = `agentMust[${i}].basis[${j}]`;
    if (!at) {
      const source = call.sources.find(item => item.id === basis.sourceId);
      slips.push(`${name}: the quote is not a verbatim substring of "${source?.name ?? basis.sourceId}". Copy the exact characters from the source instead of paraphrasing; a shorter contiguous fragment is safer than a long one.`);
    } else if (!call.binds.kinds.includes(basis.kind) && !call.binds.rules.some(rule => rule.sourceId === at.sourceId && rule.quote === at.quote)) {
      slips.push(`${name} is a rule of kind ${basis.kind}, and the owner's rulebook binds the agent only by ${call.binds.kinds.join(', ')}: cite a rule of those kinds, or drop this duty.`);
    }
  }));
  return slips;
}

/**
 * What a card's id digests: a proposal without plausible facts, or with a clear request, reads as one written before
 * those fields existed, so the same answer is the same card.
 */
function proposalIdentity(proposal: CardProposal): object {
  if (!('plausibleKnows' in proposal)) return proposal;
  const { plausibleKnows, clarity, masked, ...earlier } = proposal;
  return { ...earlier, ...(plausibleKnows.length ? { plausibleKnows } : {}), ...(clarity === 'vague' ? { clarity } : {}), ...(masked ? { masked } : {}) };
}

/**
 * The card a proposal stands for: ids e1…, f1…; the opening and the turn copied from their messages; a fact with
 * no message behind it `unconfirmed` (the owner is asked); the plausible profile facts after the logged ones, named on
 * request and `plausible` until the owner decides their label; the account of every later customer message but the
 * opening itself. The id is a digest of the source and the proposal; the number is the library's next one.
 */
export function bindProposal(proposal: CardProposal, call: ProposalCall, number: number): Card {
  const cited = dutyRequirements(proposal, call);
  const agentMust = proposal.agentMust.map((item, index) => ({ id: `e${index + 1}`, text: item.text, requirementIds: [...new Set(cited[index]!.map(requirement => requirement.id))],
    ...(item.appliesWhen !== null ? { appliesWhen: item.appliesWhen } : {}), observation: item.observation }));
  const common = { id: `card_${fingerprint({ source: call.source, proposal: proposalIdentity(proposal) })}`, number, title: proposal.title, topic: proposal.topic, agentMust, revision: 1 };
  if ('writes' in proposal) {
    if (call.source.kind !== 'rules') throw new Error('Предложение без реплик клиента пришло на диалог.');
    return cardSchema.parse({ ...common, origin: { kind: 'rules', requirementIds: [...new Set(agentMust.flatMap(item => item.requirementIds))] },
      client: { wants: proposal.wants, writes: proposal.writes, writesSource: { kind: 'model' }, knows: [], leaves: proposal.leaves }, coverage: [] });
  }
  if (call.source.kind !== 'dialogue') throw new Error('Предложение по диалогу пришло на ситуацию из правил.');
  const { batchId, dialogueId } = call.source;
  const event = (eventIndex: number) => ({ batchId, dialogueId, eventIndex });
  // The values written over the marks of the messages the card reads — its opening, its turn, its facts' — and those messages as they then read.
  const read = new Set([proposal.writesEvent, ...(proposal.turn ? [proposal.turn.from] : []), ...proposal.knows.flatMap(fact => fact.from === null ? [] : [fact.from])]);
  const filled = slotFills(call.masked.filter(slot => read.has(slot.event.eventIndex)), proposal.masked ?? {});
  const says = (index: number) => filledMessage(said(call, index), filled, event(index));
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
  return cardSchema.parse({ ...common, origin: { kind: 'dialogue', batchId, dialogueId },
    client: { wants: proposal.wants, writes: says(proposal.writesEvent), writesSource: { kind: 'dialogue', event: event(proposal.writesEvent) },
      knows, leaves: proposal.leaves, ...(turn ? { turn } : {}) }, coverage, ...(proposal.clarity === 'vague' ? { clarity: 'vague' } : {}),
    ...(filled.length ? { filled } : {}) });
}

/** The call's own messages as the evidence of the checks. */
const callEvidence = (call: ProposalCall): CardEvidence => ({
  messages: (batchId, dialogueId) => call.source.kind === 'dialogue' && call.source.batchId === batchId && call.source.dialogueId === dialogueId ? call.messages : undefined,
});

/** What the binding itself cannot hold: a message too long for its field, an ignored message without a reason. */
function bindingSlips(proposal: DialogueProposal, call: ProposalCall): string[] {
  const slips: string[] = [];
  if (proposal.knows.length + proposal.plausibleKnows.length > KNOWS_LIMIT) slips.push(`knows and plausibleKnows hold ${proposal.knows.length + proposal.plausibleKnows.length} facts together; at most ${KNOWS_LIMIT}: drop the least useful plausible ones.`);
  if (said(call, proposal.writesEvent).trim().length > 3000) slips.push(`Customer message ${proposal.writesEvent} is longer than 3000 characters and cannot be the opening: choose another writesEvent.`);
  if (proposal.turn && said(call, proposal.turn.from).trim().length > 1000) slips.push(`Customer message ${proposal.turn.from} is longer than 1000 characters and cannot be the turn: set "turn" to null or choose another message.`);
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

/** A finding in the words of the proposal the model wrote: its fields, indexes and message numbers. */
function repairText(finding: CheckFinding, card: Card, call: ProposalCall): string {
  const opening = card.client.writesSource.kind === 'dialogue' ? card.client.writesSource.event.eventIndex : undefined;
  // Plausible facts are bound after the logged ones, so a card's fact index past `knows` is its place in `plausibleKnows`.
  const logged = card.client.knows.filter(item => item.source.kind !== 'plausible').length;
  const fact = (factId: string) => {
    const index = card.client.knows.findIndex(item => item.id === factId);
    const item = card.client.knows[index]!;
    const name = index < logged ? `knows[${index}] "${item.label}"` : `plausibleKnows[${index - logged}] "${item.label}"`;
    return { name, value: JSON.stringify(item.value), from: item.source.kind === 'dialogue' ? item.source.event.eventIndex : null };
  };
  switch (finding.check) {
    // The harness writes the masked values in; a mark is left only past the slots one call offers, which no repair changes.
    case 'masked-opening': case 'masked-turn': return '';
    case 'masked-fact': return `${fact(finding.factId).name}: the value ${fact(finding.factId).value} is a masking mark. Write the value you gave for its mark in "masked", as the message reads with it, or null.`;
    case 'fact-from-event': {
      const { name, value, from } = fact(finding.factId);
      return `${name}: the value ${value} is not in customer message ${from}. Copy the value exactly as the customer wrote it and point "from" at a message that contains it, or set "from" to null.`;
    }
    case 'initial-in-opening': return `${fact(finding.factId).name} is "initial", so it is said in the opening: its "from" must be writesEvent ${opening}. Otherwise choose "on_request" or "unknown".`;
    case 'hidden-not-in-opening': {
      const { name, value } = fact(finding.factId);
      return `${name} is not "initial", but its value ${value} is already in the opening (message ${opening}): mark it "initial", or choose an opening without it.`;
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
export function cardProposalProblem(proposal: CardProposal, call: ProposalCall): string | undefined {
  const slips = [...basisSlips(proposal, call), ...'writes' in proposal ? [] : bindingSlips(proposal, call)];
  if (slips.length) return slips.join(' ');
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
  };
}

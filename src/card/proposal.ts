import { z } from 'zod';
import { fingerprint, type Requirement, type Source } from '../contracts.js';
import { text } from '../ids.js';
import { MODEL_REQUEST_BYTES } from '../limits.js';
import { cardFindings, PLAUSIBLE_VALUE_WORDS, type CardEvidence, type CheckFinding, type LoggedMessage } from './checks.js';
import { cardSchema, disclosureSchema, turnSchema, type Card } from './schema.js';

/*
 * A card as the model proposes it and as the harness binds it (docs/design/card-v2-spec.md §2.1–2.3). The model returns content only;
 * every reference in its answer is an enum built for this one call — a customer message by its index, a rule by
 * its id, a channel the connection offers — so an unknown reference cannot even be written. The harness copies
 * the opening and the turn from the messages word for word and gives the ids, the number, the sources and the
 * account of the later messages. A binding slip goes back to the model with its exact reason (the structured
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
  requirementIds: [string, ...string[]];
  /** Always the reply; a tool log or the state only where the connection confirmed it can be observed. */
  observations: ['reply', ...Observation[]];
  /** The run's limit on the customer's messages: the card's required way must fit it. */
  maxTurns: number;
}

export function proposalCall(input: { source: ProposalCall['source']; messages: LoggedMessage[]; requirements: readonly Pick<Requirement, 'id'>[];
  confirmedObservations?: ('tool' | 'state')[]; maxTurns: number }): ProposalCall {
  const [first, ...rest] = input.requirements.map(requirement => requirement.id);
  if (first === undefined) throw new Error('Ситуация строится только на правилах владельца, а их для неё нет.');
  const customer = input.messages.filter(message => message.role === 'user').map(message => message.index);
  return { source: input.source, messages: input.messages, customerEvents: customer, laterEvents: customer.slice(1),
    requirementIds: [first, ...rest], observations: ['reply', ...(input.confirmedObservations ?? [])], maxTurns: input.maxTurns };
}

/** Plausible profile facts one card may add, and the card's facts in all: the brief stays one screen. */
export const PLAUSIBLE_LIMIT = 4;
export const KNOWS_LIMIT = 8;

const coverageAnswer = z.strictObject({ as: z.enum(['fact', 'turn', 'stop', 'ignored']), reason: text(200).nullable() });

function expectationProposal(call: ProposalCall) {
  return z.strictObject({ text: text(300), requirementIds: z.array(z.enum(call.requirementIds)).min(1).max(3),
    appliesWhen: text(300).nullable(), observation: z.enum(call.observations) });
}

/** A card from one dialogue. Absent values are null, never missing, so the schema also serves a provider's strict structured output. */
function dialogueProposalSchema(call: ProposalCall) {
  const message = z.literal(call.customerEvents);
  return z.strictObject({
    title: text(160), topic: text(120), wants: text(300),
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
  });
}

/** A card from the owner's rules alone: the model writes a typical opening; no personal facts, no turn, no logged messages. */
function rulesProposalSchema(call: ProposalCall) {
  return z.strictObject({ title: text(160), topic: text(120), wants: text(300), writes: text(3000), leaves: text(300),
    agentMust: z.array(expectationProposal(call)).min(1).max(3) });
}

export type DialogueProposal = z.infer<ReturnType<typeof dialogueProposalSchema>>;
export type RulesProposal = z.infer<ReturnType<typeof rulesProposalSchema>>;
export type CardProposal = DialogueProposal | RulesProposal;

export function cardProposalSchema(call: ProposalCall): z.ZodType<CardProposal> {
  return call.source.kind === 'rules' ? rulesProposalSchema(call) : dialogueProposalSchema(call);
}

/** The answer and the whole request of one proposal call, in UTF-8 bytes: each later message adds one bounded coverage answer. */
export const proposalBounds = (call: ProposalCall) => {
  const outputBytes = 16_000 + 500 * call.laterEvents.length;
  return { outputBytes, requestBytes: MODEL_REQUEST_BYTES + outputBytes };
};

const said = (call: ProposalCall, index: number): string => call.messages.find(message => message.index === index)?.content ?? '';

/** What a card's id digests: a proposal without plausible facts reads as one written before they existed, so the same answer is the same card. */
function proposalIdentity(proposal: CardProposal): object {
  if (!('plausibleKnows' in proposal) || proposal.plausibleKnows.length) return proposal;
  const { plausibleKnows: _none, ...earlier } = proposal;
  return earlier;
}

/**
 * The card a proposal stands for: ids e1…, f1…; the opening and the turn copied from their messages; a fact with
 * no message behind it `unconfirmed` (the owner is asked); the plausible profile facts after the logged ones, named on
 * request and `plausible` until the owner decides their label; the account of every later customer message but the
 * opening itself. The id is a digest of the source and the proposal; the number is the library's next one.
 */
export function bindProposal(proposal: CardProposal, call: ProposalCall, number: number): Card {
  const agentMust = proposal.agentMust.map((item, index) => ({ id: `e${index + 1}`, text: item.text, requirementIds: [...new Set(item.requirementIds)],
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
  const logged = proposal.knows.map((fact, index) => ({ id: `f${index + 1}`, label: fact.label, ...(fact.value !== null ? { value: fact.value } : {}),
    disclosure: fact.disclosure, ...(fact.askedAs !== null ? { askedAs: fact.askedAs } : {}),
    source: fact.from === null ? { kind: 'unconfirmed' } : { kind: 'dialogue', event: event(fact.from) } }));
  const plausible = proposal.plausibleKnows.map((fact, index) => ({ id: `f${logged.length + index + 1}`, label: fact.label, ...(fact.value !== null ? { value: fact.value } : {}),
    disclosure: 'on_request', ...(fact.askedAs !== null ? { askedAs: fact.askedAs } : {}), source: { kind: 'plausible' } }));
  const knows = [...logged, ...plausible];
  const turn = proposal.turn && { kind: proposal.turn.kind, after: proposal.turn.after, says: said(call, proposal.turn.from),
    source: { kind: 'dialogue', event: event(proposal.turn.from) } };
  const coverage = call.laterEvents.filter(index => index !== proposal.writesEvent).map(index => {
    const answer = proposal.coverage[String(index)];
    if (!answer) throw new Error(`Нет учёта реплики клиента ${index}.`);
    return { event: event(index), as: answer.as, ...(answer.reason !== null ? { reason: answer.reason } : {}) };
  });
  return cardSchema.parse({ ...common, origin: { kind: 'dialogue', batchId, dialogueId },
    client: { wants: proposal.wants, writes: said(call, proposal.writesEvent), writesSource: { kind: 'dialogue', event: event(proposal.writesEvent) },
      knows, leaves: proposal.leaves, ...(turn ? { turn } : {}) }, coverage });
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
    case 'requirements-grounded': return `Requirement ${finding.requirementId} is not grounded in the supplied materials: cite another requirement.`;
    case 'controller-compiles': return finding.needed === null ? 'The customer\'s facts, turn and exit do not form a finite conversation: simplify the turn and the facts.'
      : `The customer needs ${finding.needed} messages to finish this situation, but a run allows ${call.maxTurns}: drop the turn or merge facts.`;
  }
}

/**
 * The structured task's domain check of a proposal: undefined when it binds into a card that passes every
 * deterministic check, otherwise every reason at once, so one repair fixes them all.
 */
export function cardProposalProblem(proposal: CardProposal, call: ProposalCall): string | undefined {
  if (!('writes' in proposal)) {
    const slips = bindingSlips(proposal, call);
    if (slips.length) return slips.join(' ');
  }
  const card = bindProposal(proposal, call, 1);
  const findings = cardFindings(card, { evidence: callEvidence(call), maxTurns: call.maxTurns });
  return findings.length ? findings.map(finding => repairText(finding, card, call)).join(' ') : undefined;
}

/** One proposal call: what the harness binds against and what the model reads. */
export interface CardProposalRequest {
  task: string;
  call: ProposalCall;
  /** The owner's rules this situation is read against, quotes verbatim. */
  requirements: Pick<Requirement, 'id' | 'text' | 'quote'>[];
  /** The articles read for it; a source that is the agent's own prompt is labelled. */
  articles: Pick<Source, 'id' | 'name' | 'content' | 'kind'>[];
  /** Topics the library already has: the same topic is written the same way. */
  topics: string[];
  /** Titles of the situations already written from the owner's rules: the next one is a different situation. */
  written: string[];
}

/** What the model reads: the request without the harness's bookkeeping. */
export function proposalPayload(request: CardProposalRequest) {
  const { call } = request;
  return {
    task: request.task, mode: call.source.kind,
    ...(call.source.kind === 'dialogue' ? { dialogue: { messages: call.messages } } : {}),
    requirements: request.requirements,
    articles: request.articles.map(({ id, name, content, kind }) => ({ id, name: kind === 'prompt' ? `${name} (промпт агента)` : name, content })),
    topics: request.topics, ...(request.written.length ? { written: request.written } : {}),
    target: { observations: call.observations },
  };
}

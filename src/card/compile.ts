import { EXPECTATIONS_PROTOCOL, scenarioSchema, type CardExecution, type Requirement, type Scenario } from '../contracts.js';
import type { Rubric } from '../assessment.js';
import type { BehaviorPolicy } from '../scenario-contracts.js';
import type { CustomerProfile } from '../target-schema.js';
import { clip } from '../text.js';
import { normalizeText } from './checks.js';
import { USER_CONTROLLER_PROTOCOL, type UserView } from '../user-controller.js';
import type { Card } from './schema.js';

/*
 * A card is compiled once, at acceptance, into the runnable definition whose hash the acceptance seals.
 * The brief becomes the controller's policy: a small graph in which every customer message is harness
 * text (a fact's statement, «не знаю», the turn's recorded words), so the model that drives the customer
 * only picks a move and can never invent a value. Each expectation becomes its own rubric with its own
 * verdict. Runs, repeats and reassessments read the sealed definition; nothing here runs again for them.
 *
 *   talk ──(answers, «не знаю»: loops)──► talk ──turn──► turned ──(answers: loops)──► turned
 *     └──────────────────────── leave ──────────────► done ◄──────────── leave ─────────┘
 */

type Fact = Card['client']['knows'][number];
/** A fact as the customer tells it: a card's own, or one of the stand's test customer. */
type Told = Pick<Fact, 'id' | 'label' | 'value' | 'disclosure' | 'askedAs'>;
type Expectation = Card['agentMust'][number];
type Action = BehaviorPolicy['actions'][number];

const TALK = 'talk', TURNED = 'turned', DONE = 'done';
/** The owner's letters of a card's expectations: «А», «Б», «В»… (a first-format card may have up to twelve). */
export const EXPECTATION_LETTERS = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З', 'И', 'К', 'Л', 'М'] as const;
/** The letter of a card expectation, from its id: e1 → А, e2 → Б, e3 → В. Ids are never reused, so the letter never moves. */
export const expectationLetter = (id: string): string => EXPECTATION_LETTERS[Number(id.slice(1)) - 1] ?? id;

/** What the customer says when naming a fact. */
const statement = (fact: Told): string => fact.value === undefined ? fact.label : `${fact.label}: ${fact.value}`;

interface CompiledPolicy { policy: BehaviorPolicy; facts: UserView['facts']; missing: string[] }

/** The most messages a customer writes after the first one, whatever the source dialogue: a run stays bounded. */
const FOLLOW_UP_CEILING = 15;

/**
 * How many messages the customer may write after the first one. The brief's own need — a message per fact, one for
 * the turn and two to spare — and, for a card of a logged dialogue, as long as the real customer talked plus two:
 * the account of the later messages holds one entry per later customer message, so its length is the real
 * conversation's length without its opening (derived, not stored). Both are bounded by the ceiling and, when they are
 * known, by the run's messages after the opening: a customer never plans a message the run cannot deliver. The way the
 * card requires — a change of intent, when it has one — always stays in its budget, so a card too long for the run is
 * found by its checks (card/checks.ts) instead of being compiled into a customer who cannot finish; a card that fits
 * the run is never cut below that way.
 */
function followUps(card: Card, facts: number, maxTurns: number | undefined): number {
  const own = Math.min(FOLLOW_UP_CEILING, facts + (card.client.turn ? 1 : 0) + 2);
  const logged = Math.min(FOLLOW_UP_CEILING, card.coverage.length + 2);
  const required = card.client.turn?.kind === 'change_intent' ? 1 : 0;
  return Math.min(Math.max(own, logged), ...(maxTurns === undefined ? [] : [Math.max(maxTurns - 1, required)]));
}

/**
 * The customer's policy. A known fact is told only when asked (an `initial` one is already in the first
 * message and is repeated as it stands if the agent asks again); two or more facts named on request can be
 * told at once; an unknown fact and any other question get «не знаю» — a template, so an unknown value is in
 * no message at all. A plausible fact counts only once the owner decided its label; before that the customer
 * does not know it. A `change_intent` turn must happen before the customer may leave (the controller's
 * finite search removes `leave` until then); a `report` turn may be skipped. `maxTurns` is the run's limit on
 * the customer's messages, when the caller knows it.
 */
export function compilePolicy(card: Card, maxTurns?: number, profile: CustomerProfile = []): CompiledPolicy {
  const { turn } = card.client;
  const own = card.client.knows.filter(fact => fact.source.kind !== 'plausible' || fact.source.receiptId !== undefined);
  const knows = [...own, ...profileFacts(own, profile)];
  const leaves = profile.length ? `${card.client.leaves}; или агент передаёт вопрос оператору либо прямо говорит, что помочь не может` : card.client.leaves;
  const known = knows.filter(fact => fact.disclosure !== 'unknown');
  const unknown = knows.filter(fact => fact.disclosure === 'unknown');
  const onRequest = known.filter(fact => fact.disclosure === 'on_request');
  const asked = (fact: Told) => fact.askedAs ?? fact.label;
  const actions: Action[] = [
    // No payload: the controller says the fact's statement, which the harness rendered.
    ...known.map((fact): Action => ({ id: `tell_${fact.id}`, kind: 'answer', factIds: [fact.id], ifAsked: asked(fact) })),
    ...(onRequest.length >= 2 ? [{ id: 'tell_all', kind: 'answer', factIds: onRequest.map(fact => fact.id), ifAsked: 'агент просит сразу несколько данных' } satisfies Action] : []),
    ...unknown.map((fact): Action => ({ id: `dunno_${fact.id}`, kind: 'missing', factIds: [], ifAsked: asked(fact), payload: `${fact.label} — не знаю.` })),
    { id: 'dunno_other', kind: 'missing', factIds: [], ifAsked: 'вопрос, на который в карточке нет ответа', payload: 'Этого я не знаю.' },
    ...(turn ? [{ id: 'turn', kind: turn.kind === 'change_intent' ? 'change_intent' : 'observe', factIds: [], payload: turn.says } satisfies Action] : []),
    { id: 'leave', kind: 'finish', factIds: [] },
  ];
  const talking = turn ? [TALK, TURNED] : [TALK];
  const replies = actions.filter(action => action.kind === 'answer' || action.kind === 'missing');
  const transitions: BehaviorPolicy['transitions'] = [
    ...talking.flatMap(state => replies.map(action => ({ from: state, to: state, actionId: action.id, when: `агент спрашивает: ${action.ifAsked}` }))),
    ...(turn ? [{ from: TALK, to: TURNED, actionId: 'turn', when: turn.after }] : []),
    ...talking.map(state => ({ from: state, to: DONE, actionId: 'leave', when: leaves })),
  ];
  return {
    policy: { version: 1, initialState: TALK, states: [...talking, DONE], terminalStates: [DONE], repetitionLimit: 2,
      maxFollowUps: followUps(card, knows.length, maxTurns), actions, transitions },
    facts: known.map(fact => ({ id: fact.id, statement: statement(fact), ...(fact.value !== undefined ? { value: fact.value } : {}) })),
    missing: unknown.map(fact => fact.label),
  };
}

/**
 * The stand's test customer (the connection's `customerProfile`) as facts the customer names on request, after the
 * card's own: what any real customer knows about their own account. A label the card already holds stays the card's.
 */
function profileFacts(own: readonly Told[], profile: CustomerProfile): Told[] {
  return profile.filter(item => !own.some(fact => normalizeText(fact.label) === normalizeText(item.label))).map((item, index): Told => ({
    id: `p${index + 1}`, label: item.label, value: item.value, disclosure: 'on_request', ...(item.askedAs !== undefined ? { askedAs: item.askedAs } : {}),
  }));
}

/** A text that the rubric templates end with their own full stop. */
const withoutStop = (text: string): string => text.endsWith('.') ? text.slice(0, -1) : text;

/**
 * How the judge decides an expectation observed on the agent's tools. Only in definitions compiled with it: an
 * accepted definition is sealed as it was, and a first-format card's projection never carries it.
 */
const TOOL_LOG_RULE = 'Проверяется по журналу инструментов агента: решайте по событиям tool_call и tool_result и цитируйте tool_result; слова агента о том, что он что-то сделал, действие не доказывают.';

/**
 * One expectation as a rubric of its own — the renderer of every expectation the judge reads, of a card
 * and of a first-format checkpoint alike. `card` names where it comes from («карточки №3»). A duty that
 * depends on the agent's path is not broken when that path never happened.
 */
export function expectationRubric(expectation: Pick<Expectation, 'id' | 'text' | 'requirementIds' | 'appliesWhen'>, letter: string, card: string,
  options: { toolLog?: boolean } = {}): Rubric {
  const duty = withoutStop(expectation.text);
  const when = expectation.appliesWhen === undefined ? undefined : withoutStop(expectation.appliesWhen);
  return { id: expectation.id, subject: 'agent', name: clip(expectation.text, 120),
    description: `Ожидание ${letter} ${card}. Основание — требования ${expectation.requirementIds.join(', ')} (см. requirements).${options.toolLog ? ` ${TOOL_LOG_RULE}` : ''}`,
    passCriteria: when ? `Если ${when}: выполнено — ${duty}. Если этого в диалоге не было, ожидание не нарушено.` : `Выполнено: ${duty}.`,
    failCriteria: when ? `${when}, но не выполнено: ${duty}.` : `Не выполнено: ${duty}.` };
}

const DISCLOSURE_WORDS: Record<Fact['disclosure'], string> = { initial: 'сразу', on_request: 'если спросят', unknown: 'не знает' };

/** The brief in one line, for people reading the definition; the controller never reads it. */
function behaviorSummary(card: Card): string {
  const { knows, turn, leaves } = card.client;
  const facts = knows.map(fact => `${statement(fact)} — ${DISCLOSURE_WORDS[fact.disclosure]}`);
  return clip([
    `Знает: ${facts.join('; ') || 'ничего сверх первой реплики'}.`,
    ...(turn ? [`Поворот после «${turn.after}»: «${turn.says}».`] : []),
    `Уходит: ${leaves}.`,
    'На вопрос без ответа в карточке отвечает «Этого я не знаю.»',
  ].join(' '), 2000);
}

export interface CompileContext {
  /** The library's requirements; an expectation cites them by id. */
  requirements: readonly Requirement[];
  /** The agent's environment as its connection declares it; an unmanaged agent judged on its replies by default. */
  environment?: CardExecution['environmentView'];
  /** The run's limit on the customer's messages: a long logged conversation gives the customer no more than fit in it. */
  maxTurns?: number;
  /** The stand's test customer from the connection: what every customer knows about their own account. */
  profile?: CustomerProfile;
}

/**
 * The runnable definition of an accepted card. Only the expectations enter the judgment (no success
 * criteria and no card-wide goal rubric), so one expectation never colours the verdict of another.
 */
export function compileCard(card: Card, context: CompileContext): Scenario {
  const { policy, facts, missing } = compilePolicy(card, context.maxTurns, context.profile);
  const cited = [...new Set(card.agentMust.flatMap(expectation => expectation.requirementIds))];
  const requirements = cited.map(id => context.requirements.find(requirement => requirement.id === id));
  if (requirements.some(requirement => !requirement)) throw new Error(`Ситуация №${card.number}: ожидание ссылается на правило, которого нет в наборе.`);
  const { wants, writes } = card.client;
  const parsed = scenarioSchema.parse({
    id: card.id, familyId: card.id, title: card.title, requirementIds: cited,
    provenance: card.origin.kind === 'dialogue' ? 'production' : card.origin.kind === 'similar' ? 'synthetic' : 'curated',
    tier: 'regression',
    user: { goal: wants, opening: writes, facts: facts.map(fact => fact.statement).join('\n') || 'Исходные факты не заданы.',
      knows: facts.map(fact => fact.statement), cannotKnow: missing, behavior: behaviorSummary(card), maxFollowUps: policy.maxFollowUps },
    initialState: { records: {}, writableFields: [], transientFailures: 0 }, checks: [], goalObservation: 'reply',
    execution: { protocol: USER_CONTROLLER_PROTOCOL, evaluation: EXPECTATIONS_PROTOCOL,
      userView: { goal: wants, opening: writes, facts, policy, missing },
      environmentView: context.environment ?? { mode: 'prompt' },
      evaluatorView: { expectations: card.agentMust, requirements } },
    metrics: card.agentMust.map(expectation => expectationRubric(expectation, expectationLetter(expectation.id), `карточки №${card.number}`,
      { toolLog: expectation.observation === 'tool' })),
    ...(card.references ? { references: card.references } : {}),
  });
  return { ...parsed, split: 'dev' };
}

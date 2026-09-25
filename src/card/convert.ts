import { fingerprint, worldSchema, type Experiment, type Requirement, type Source } from '../contracts.js';
import { isIdentifier } from '../ids.js';
import { CARD_LATER_MESSAGES } from '../limits.js';
import { countText, pluralForm } from '../plural.js';
import type { ImportBatch, LibraryV1, ScenarioVariant } from '../scenario-contracts.js';
import { clip } from '../text.js';
import { contains, importEvidence, loggedMessages, normalizeText, quotable, type LoggedMessage } from './checks.js';
import { orderedVariants } from './legacy-v1.js';
import { addCard, createLibraryV2 } from './library.js';
import { CARD_PROTOCOL, pendingReviewCalls, preparationInputHash } from './prepare.js';
import { cardSchema, type Card, type CardPreparation, type LibraryV2, type PreparationProgress } from './schema.js';

/*
 * «Продолжить в новом формате» (docs/design/card-v2-spec.md §6, choice A): a draft of the first library format goes on as a new draft
 * of cards; the old draft stays as it was. Each variant becomes one card by fixed rules and says nothing the variant
 * did not: the opening is the logged customer message it equals, a fact keeps the message it came from or waits for
 * the owner's word, each duty the judge decided becomes an expectation with its rule and its condition — the way old
 * runs are judged again (projectedExpectations). What a card cannot hold — an exact check of the system's state, a
 * seeded environment, more duties or facts than a card has, an opening that is no logged message, a text longer than
 * its field — leaves the variant out with the reason: nothing is cut or reworded to fit. No receipt crosses over:
 * the reviewer checks the new cards afresh, paid and on the owner's word, and the owner answers anew.
 */

/** A variant the card format cannot hold, and why, in the owner's words. */
export interface LeftOut { variantId: string; title: string; reason: string }

export interface Conversion {
  library: LibraryV2;
  /** The unit each card stands for, as a preparation names it: the logged dialogue, or `rules_N` for a situation with none. */
  units: { unit: string; cardId: string }[];
  left: LeftOut[];
  /** Review calls the new cards need before any of them is ready: the price of the check the owner is asked to agree to. */
  calls: number;
}

const DUTIES: [string, string, string] = ['обязанность', 'обязанности', 'обязанностей'];
const SITUATIONS: [string, string, string] = ['ситуация', 'ситуации', 'ситуаций'];
const CALLS: [string, string, string] = ['вызова', 'вызовов', 'вызовов'];
const MOVED: [string, string, string] = ['перенесена', 'перенесены', 'перенесено'];
const FACTS: [string, string, string] = ['факт', 'факта', 'фактов'];
const UNACCOUNTED = 'Старая подготовка не отнесла эту реплику ни к фактам клиента, ни к повороту.';

type Built = { card: Omit<Card, 'number'>; reading?: { dialogueId: string; batchId: string; sourceIds: string[] } };
type Logged = { batch: ImportBatch; dialogue: ImportBatch['dialogues'][number]; customer: LoggedMessage[]; opening: LoggedMessage };

/** The variant's logged dialogue with the customer message its opening equals; a reason when there is none to stand on. */
function loggedOpening(library: LibraryV1, variant: ScenarioVariant): Logged | string | undefined {
  const source = variant.sourceDialogues[0];
  if (!source) return undefined;
  const batch = library.imports.find(item => item.id === source.batchId);
  const dialogue = batch?.dialogues.find(item => item.id === source.dialogueId);
  if (!batch || !dialogue) return 'её разговора нет в логах этого набора';
  const customer = loggedMessages(dialogue).filter(message => message.role === 'user');
  const opening = customer.find(message => normalizeText(message.content) === normalizeText(variant.userState.opening));
  if (!opening) return 'её первая реплика не совпадает ни с одной репликой клиента в логах, а ситуация нового формата берёт её из лога дословно';
  return { batch, dialogue, customer, opening };
}

/** One variant as a card without its number, or why the card format cannot hold it. */
function convertVariant(library: LibraryV1, variant: ScenarioVariant): Built | string {
  const { userState, behaviorPolicy: policy, evaluationSpec, environmentFixture } = variant;
  // The duties the judge decided the variant by; a diagnostic checkpoint never decided a verdict.
  const duties = evaluationSpec.checkpoints.filter(checkpoint => checkpoint.role === 'required');
  if (duties.some(checkpoint => checkpoint.check !== undefined)) return 'в ней есть точная проверка состояния системы, а в ситуации нового формата её нет';
  if (!duties.length) return 'в ней нет обязательной проверки агента';
  if (duties.length > 3) return `в ней ${countText(duties.length, DUTIES)} агента, а в ситуации нового формата их не больше трёх`;
  if (duties.some(checkpoint => checkpoint.rule.length > 300 || checkpoint.applicability.length > 300)) return 'обязанность агента в ней описана длиннее 300 знаков';
  const world = worldSchema.safeParse(environmentFixture.initialState);
  if (environmentFixture.mode === 'managed' || !world.success || Object.keys(world.data.records).length || world.data.writableFields.length
    || world.data.transientFailures || world.data.external !== undefined) return 'она задаёт состояние системы агента, а ситуация нового формата его не задаёт';
  if (userState.goal.length > 300) return 'цель клиента в ней длиннее 300 знаков';
  const known = userState.facts.filter(fact => fact.availability !== 'learned_in_source');
  if (known.length > 8) return `клиент в ней знает ${countText(known.length, FACTS)}, а в ситуации нового формата их не больше восьми`;
  const terminal = new Set(policy.terminalStates);
  const leaves = [...new Set(policy.transitions.filter(transition => terminal.has(transition.to)).map(transition => transition.when))].join('; ');
  if (!leaves) return 'в ней не сказано, когда клиент уходит';
  if (leaves.length > 300) return 'условие ухода клиента в ней длиннее 300 знаков';
  const moves = policy.actions.filter(action => (action.kind === 'change_intent' || action.kind === 'observe') && action.payload);
  if (moves.length > 1) return 'клиент в ней поворачивает разговор не один раз, а в ситуации нового формата поворот один';
  const logged = loggedOpening(library, variant);
  if (typeof logged === 'string') return logged;
  const agentMust = duties.map((duty, index) => ({ id: `e${index + 1}`, text: duty.rule, requirementIds: [duty.requirementId], appliesWhen: duty.applicability, observation: duty.observation }));
  const common = { id: `card_${fingerprint({ firstFormat: library.id, variant: variant.id, revision: variant.revision })}`, title: clip(variant.title, 160),
    topic: clip(library.businessScenarios.find(group => group.id === variant.businessScenarioId)?.title ?? variant.title, 120), agentMust, revision: 1 };
  if (!logged) {
    // A situation with no logged dialogue behind it: the owner's rules and the words the old preparation wrote.
    if (known.length) return 'клиент в ней знает факты, а ни одна реплика в логах за них не ручается';
    if (moves.length) return 'поворот клиента в ней не опирается на реплику в логах';
    return { card: { ...common, origin: { kind: 'rules', requirementIds: [...new Set(duties.map(duty => duty.requirementId))] },
      client: { wants: userState.goal, writes: userState.opening, writesSource: { kind: 'model' }, knows: [], leaves }, coverage: [] } };
  }
  const { batch, dialogue, customer, opening } = logged;
  if (opening.content.trim().length > 3000) return 'первая реплика клиента длиннее 3000 знаков';
  const event = (eventIndex: number) => ({ batchId: batch.id, dialogueId: dialogue.id, eventIndex });
  const writes = opening.content;
  const knows: Card['client']['knows'] = [];
  for (const [index, fact] of known.entries()) {
    if (fact.statement.length > 120) return 'факт клиента в ней описан длиннее 120 знаков';
    // A value the statement already says is not said twice: the customer says the statement.
    const value = quotable(fact.value) && contains(fact.statement, fact.value) ? undefined : fact.value;
    if (typeof value === 'string' && value.length > 120) return 'значение факта клиента в ней длиннее 120 знаков';
    const first = contains(writes, quotable(fact.value) ? fact.value : fact.statement);
    const cited = fact.origin.kind === 'dialogue' && fact.origin.batchId === batch.id && fact.origin.dialogueId === dialogue.id ? fact.origin.eventIndex : undefined;
    const askedAs = policy.actions.find(action => action.kind === 'answer' && action.factIds.includes(fact.id) && action.ifAsked)?.ifAsked;
    // Said in the opening, the opening vouches for it; otherwise its own message, unless the old preparation doubted it.
    knows.push({ id: `f${index + 1}`, label: fact.statement, ...(value === undefined ? {} : { value }), disclosure: first ? 'initial' : 'on_request',
      ...(askedAs && askedAs.length <= 200 ? { askedAs } : {}),
      source: first ? { kind: 'dialogue', event: event(opening.index) }
        : fact.availability === 'uncertain' || cited === undefined ? { kind: 'unconfirmed' } : { kind: 'dialogue', event: event(cited) } });
  }
  const later = customer.slice(1).filter(message => message.index !== opening.index);
  if (later.length > CARD_LATER_MESSAGES) return `после первой реплики клиент пишет больше ${CARD_LATER_MESSAGES} раз`;
  const accounted = (index: number) => variant.sourceCoverage?.find(entry => entry.batchId === batch.id && entry.dialogueId === dialogue.id && entry.eventIndex === index);
  let turn: Card['client']['turn'];
  const [move] = moves;
  if (move) {
    const said = later.find(message => message.index > opening.index && accounted(message.index)?.actionIds.includes(move.id));
    const after = policy.transitions.find(transition => transition.actionId === move.id)?.when;
    if (!said || !after) return 'поворот клиента в ней не опирается на более позднюю реплику в логах';
    if (after.length > 300 || said.content.trim().length > 1000) return 'поворот клиента в ней описан длиннее, чем держит ситуация нового формата';
    turn = { kind: move.kind === 'change_intent' ? 'change_intent' : 'report', after, says: said.content, source: { kind: 'dialogue', event: event(said.index) } };
  }
  const facts = new Set(knows.flatMap(fact => fact.source.kind === 'dialogue' ? [fact.source.event.eventIndex] : []));
  const coverage = later.map((message): Card['coverage'][number] => {
    if (turn?.source.kind === 'dialogue' && turn.source.event.eventIndex === message.index) return { event: event(message.index), as: 'turn' };
    if (facts.has(message.index)) return { event: event(message.index), as: 'fact' };
    const reason = accounted(message.index)?.reason;
    return { event: event(message.index), as: 'ignored', reason: reason && reason.length <= 300 ? reason : UNACCOUNTED };
  });
  const read = library.readingManifest?.find(row => row.dialogueId === dialogue.id && (row.batchId === undefined || row.batchId === batch.id));
  return {
    card: { ...common, origin: { kind: 'dialogue', batchId: batch.id, dialogueId: dialogue.id },
      client: { wants: userState.goal, writes, writesSource: { kind: 'dialogue', event: event(opening.index) }, knows, leaves, ...(turn ? { turn } : {}) }, coverage },
    ...(read ? { reading: { dialogueId: dialogue.id, batchId: batch.id, sourceIds: read.sourceIds } } : {}),
  };
}

/**
 * The cards of a first-format library, numbered from 1 in the order its variants are listed, over the draft's own
 * materials and rules (the ones an acceptance compares with the record's). A card an expectation cites an unknown
 * rule for is kept: its check says so.
 */
export function convertV1Library(v1: LibraryV1, input: { id: string; createdAt: string; sources: Source[]; requirements: Requirement[] }): Conversion {
  let library = createLibraryV2({ id: input.id, createdAt: input.createdAt, imports: v1.imports.map(({ id, contentHash }) => ({ id, contentHash })),
    sources: input.sources, requirements: input.requirements });
  const units: Conversion['units'] = [], left: LeftOut[] = [];
  let rules = 0;
  for (const variant of orderedVariants(v1)) {
    const built = convertVariant(v1, variant);
    if (typeof built === 'string') { left.push({ variantId: variant.id, title: variant.title, reason: built }); continue; }
    const parsed = cardSchema.safeParse({ ...built.card, number: library.nextNumber });
    if (!parsed.success) { left.push({ variantId: variant.id, title: variant.title, reason: 'она не складывается в ситуацию нового формата' }); continue; }
    library = addCard(library, parsed.data, built.reading);
    const { origin } = parsed.data;
    units.push({ unit: origin.kind === 'dialogue' ? origin.dialogueId : `rules_${++rules}`, cardId: parsed.data.id });
  }
  return { library, units, left, calls: pendingReviewCalls(library, importEvidence(v1.imports)) };
}

/**
 * The finished card preparation of a converted draft: every unit processed, each left-out variant excluded with its
 * reason, and the articles the old preparation chose per dialogue — the judge of a large knowledge base reads by them.
 */
export function convertedPreparation(record: Experiment, conversion: Conversion, previous: PreparationProgress | undefined): CardPreparation {
  const selection = previous?.sourceSelection?.filter(row => isIdentifier(row.dialogueId));
  return { protocol: CARD_PROTOCOL, inputHash: preparationInputHash(record, CARD_PROTOCOL), pending: [], processed: [...new Set(conversion.units.map(item => item.unit))],
    excluded: conversion.left.map(item => ({ dialogueId: item.variantId, reason: `Ситуация «${clip(item.title, 160)}» не перенесена: ${item.reason}.` })),
    ...(selection ? { sourceSelection: selection } : {}),
    cards: conversion.units.map(item => ({ dialogueId: item.unit, cardId: item.cardId })) };
}

/** What the owner reads after a conversion, the same on every surface: what went over, what did not and why, and the check it waits for. */
export function conversionText(conversion: Pick<Conversion, 'library' | 'left' | 'calls'>): { summary: string; left: string[]; check: string } {
  const { left, calls } = conversion, cards = conversion.library.cards.length;
  return {
    summary: `В новый формат ${pluralForm(cards, MOVED)} ${countText(cards, SITUATIONS)}${left.length ? `, не ${pluralForm(left.length, MOVED)} ${left.length}` : ''}. Старый черновик остался как есть.`,
    left: left.map(item => `«${clip(item.title, 80)}» не перенесена: ${item.reason}.`),
    check: `Новые ситуации ещё не проверены: проверка — до ${countText(calls, CALLS)} модели.`,
  };
}

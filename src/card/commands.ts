import { fingerprint } from '../contracts.js';
import { CommandRefused, StaleRevisionError, UnknownReference } from '../errors.js';
import type { ImportBatch } from '../scenario-contracts.js';
import { libraryHash } from '../scenario-library.js';
import { clip } from '../text.js';
import { logVersionCommandSchema, logVersionJournalSchema, type LogVersionCommand, type LogVersionJournal } from './calibration.js';
import { cardMessage, messageAt, normalizeText, problemText, unusableFindings, type CardEvidence, type CheckFinding } from './checks.js';
import { pendingClaims } from './review.js';
import { expectationLine, variationExpectations, variationLine } from './plan.js';
import { bindsBot, KIND_WORDS, rulebookChangeLines, rulebookOf, unboundCitation } from './rulebook.js';
import { cardCommandSchema, cardSchema, libraryV2Schema, type BusinessScenario, type Card, type CardChange, type CardCommand, type EventRef, type LibraryV2, type Rulebook } from './schema.js';
import { cardStatus, plausibleGroup } from './status.js';
import { applyFill } from './unmask.js';
import { briefChanges, cardSituation, changeText, type BriefChange } from './view.js';

/*
 * The owner's commands on a draft of cards (docs/design/card-v2-spec.md §5): one layer for the chat, the board and the CLI. An
 * adapter only gathers the input and shows the result; everything a command means is decided here.
 *
 *   command ──prepare (pure)──► Prepared: the exact next library, «было → стало», the cards it touches,
 *                               the claims to check again, the authority it needs
 *            ──owner decides──► HostGrant (issued by host code only, bound to that preview)
 *            ──apply──────────► the next library, if the draft is still the one previewed (else StaleRevisionError)
 *
 * Every applied command is kept verbatim in an owner receipt. It raises the library revision, drops an
 * acceptance (what was accepted is no longer what the draft says) and keeps the card's account of the later
 * customer messages true: a message whose fact or turn the owner replaced is marked `changed`. A command
 * that would break a deterministic check of the card is refused with the reason, before anything is written.
 */

/**
 * Who must stand behind a command: `owner-confirm` — a decision about what the customer knows or a doubt
 * settled: the owner confirms the exact change natively (a Pi dialog, a board key, `--yes`); `owner-words` —
 * a wording: the text is the owner's own, verbatim from their message or typed in a native input, or the
 * owner confirmed it natively as shown. A model's argument is never an authority.
 */
export type Authority = 'owner-confirm' | 'owner-words';
export type Via = 'pi-confirm' | 'board' | 'cli-yes';

/** The stricter of the authorities a command's parts need: a decision about the customer or the rules outranks a wording. */
const strictest = (authorities: readonly Authority[]): Authority => authorities.includes('owner-confirm') || !authorities.length ? 'owner-confirm' : 'owner-words';

/** The words, rules and ways of a duty an edit names — of one card's duty or of the plan's expectation, the same fields. */
type DutyFields = Pick<Extract<CardCommand, { kind: 'edit_plan_expectation' }>, 'text' | 'requirementIds' | 'strength' | 'acceptable' | 'violation'>;

/** Every field a duty's edit changes counts: new words for a duty never carry a new rule or a dropped condition along with them. */
const dutyAuthority = (fields: DutyFields, appliesWhen?: string | null): Authority => strictest([
  ...(fields.text !== undefined ? ['owner-words' as const] : []),
  ...(typeof appliesWhen === 'string' ? ['owner-words' as const] : appliesWhen === null ? ['owner-confirm' as const] : []),
  ...(fields.requirementIds !== undefined || fields.strength !== undefined ? ['owner-confirm' as const] : []),
  ...[fields.acceptable, fields.violation].flatMap(value => typeof value === 'string' ? ['owner-words' as const] : value === null ? ['owner-confirm' as const] : []),
]);

/** The authority a command needs; the same in every adapter. */
export function requiredAuthority(command: CardCommand | LogVersionCommand): Authority {
  switch (command.kind) {
    // Which agent wrote the logs decides whether agreement with them is a calibration: the owner's decision.
    case 'declare_log_version': return 'owner-confirm';
    // Whether the customer can say what they want is a decision about the customer, whatever words come with it.
    case 'edit_client': return strictest([
      ...(command.wants !== undefined || command.writes !== undefined || command.leaves !== undefined ? ['owner-words' as const] : []),
      ...(command.clarity !== undefined ? ['owner-confirm' as const] : []),
    ]);
    case 'edit_expectation': return dutyAuthority(command, command.appliesWhen);
    // The plan's expectation is every card's duty that is it: the same fields, the same authority.
    case 'edit_plan_expectation': return dutyAuthority(command);
    case 'set_turn': return command.turn && !command.turn.event ? 'owner-words' : 'owner-confirm';
    // A similar card whose customer knows something else is a claim about the customer, whatever its words.
    case 'add_similar': return command.change.kind === 'opening' || command.change.kind === 'turn' && command.change.turn !== null ? 'owner-words' : 'owner-confirm';
    // An answer in the owner's own words is a wording; picking an answer is a decision.
    case 'answer_question': return command.text !== undefined ? 'owner-words' : 'owner-confirm';
    // Which rules bind the bot, and whether customers know a plausible fact, are the owner's decisions about the whole set.
    // A series needs the owner's confirmation when any of its changes does; otherwise it is all wording.
    case 'edit_card': return strictest(command.changes.map(change => requiredAuthority(withCard(change, command.cardId))));
    // Lab's values over the log's masks speak for the customer: the owner confirms them as shown.
    case 'set_fact_disclosure': case 'set_fact': case 'remove_fact': case 'remove_expectation': case 'settle_claim': case 'remove_card':
    // A new kind of customer is a decision about who the agent is checked with, whatever its words.
    case 'decide_plausible': case 'set_rulebook': case 'fill_masked': case 'set_references': case 'remove_plan_expectation': case 'add_variation': return 'owner-confirm';
  }
}

/** A change of a series as the command of one card it stands for. */
const withCard = (change: CardChange, cardId: string): CardCommand => ({ ...change, cardId });

/** The wordings of a command: what `owner-words` asks to be the owner's own text. */
export function wordsOf(command: CardCommand | LogVersionCommand): string[] {
  const texts = (...items: (string | null | undefined)[]) => items.filter((item): item is string => typeof item === 'string');
  switch (command.kind) {
    case 'edit_client': return texts(command.wants, command.writes, command.leaves);
    case 'edit_expectation': return texts(command.text, command.appliesWhen, command.acceptable, command.violation);
    case 'edit_plan_expectation': return texts(command.text, command.acceptable, command.violation);
    case 'add_variation': return [command.title];
    case 'set_turn': return command.turn && !command.turn.event ? texts(command.turn.after, command.turn.says) : [];
    case 'add_similar': return command.change.kind === 'opening' ? [command.change.writes] : command.change.kind === 'turn' ? texts(command.change.turn?.after, command.change.turn?.says)
      : texts(command.change.writes);
    case 'answer_question': return texts(command.text);
    case 'edit_card': return command.changes.flatMap(change => wordsOf(withCard(change, command.cardId)));
    case 'set_fact_disclosure': case 'set_fact': case 'remove_fact': case 'remove_expectation': case 'settle_claim': case 'remove_card': case 'declare_log_version':
    case 'decide_plausible': case 'set_rulebook': case 'fill_masked': case 'set_references': case 'remove_plan_expectation': return [];
  }
}

export interface CommandContext {
  /** The import batches the cards cite: the checks read the messages there. */
  evidence: CardEvidence;
  /** A run's limit on the customer's messages. */
  maxTurns: number;
  /** Where the owner decides; the receipt names it. */
  via: Via;
  /** When the owner saw the preview; the receipt keeps it. */
  at?: string;
  /** The owner's verbatim words behind a wording; the receipt keeps them. */
  ownerWords?: string;
}

export interface Prepared {
  /** The command as it will be applied: an answer to a question is the answer's own command. */
  command: CardCommand;
  /** The draft it was prepared on: applied to any other state it is refused. */
  libraryHash: string;
  /** Binds a grant to exactly what the owner was shown. */
  previewHash: string;
  authority: Authority;
  via: Via;
  /** «Было → стало» per touched card, in the lines of the brief. */
  diff: { cardId: string; number: number; changes: BriefChange[] }[];
  /** The cards the command touches, and the ones it adds. */
  scope: string[];
  /** Claim keys of those cards that no receipt answers after the change: what the reviewer is asked again. */
  recheck: string[];
  /** A change of the rulebook: what bound the bot before and after, and the situations whose expectations it leaves without a binding rule. */
  rulebook?: { before: Rulebook; after: Rulebook; flagged: number[] };
  /**
   * A change of the plan: the scenario's question and, in a line, its expectation or variation before and after (null —
   * none: added, or removed); `diff` holds the situations that change with it.
   */
  plan?: { scenario: string; what: 'expectation' | 'variation'; before: string | null; after: string | null; flip?: true };
  next: LibraryV2;
}

/** A host's word that the owner stands behind a preview: after a native confirmation (`confirmed`) or with their verbatim words (`words`). */
export interface HostGrant { readonly previewHash: string; readonly via: Via; readonly basis: 'confirmed' | 'words' }
const issued = new WeakSet<HostGrant>();

/**
 * Issued by host code only — after the owner's native confirmation of the preview, or when every wording of
 * it is the owner's own. A grant is an object this module made: no parsed argument, flag or copy is one.
 */
export function hostGrant(prepared: Pick<Prepared, 'previewHash' | 'via'>, basis: HostGrant['basis']): HostGrant {
  const grant: HostGrant = Object.freeze({ previewHash: prepared.previewHash, via: prepared.via, basis });
  issued.add(grant);
  return grant;
}

/* ───────────────────────────── references ───────────────────────────── */

function cardOf(library: LibraryV2, cardId: string): Card {
  const card = library.cards.find(item => item.id === cardId);
  if (!card) throw new UnknownReference('card', [...library.cards].sort((a, b) => a.number - b.number).map(item => `№${item.number} ${clip(item.title, 60)}`), 'Такой ситуации в черновике нет.');
  return card;
}
function factOf(card: Card, factId: string): Card['client']['knows'][number] {
  const fact = card.client.knows.find(item => item.id === factId);
  if (!fact) throw new UnknownReference('fact', card.client.knows.map(item => `${item.id} ${clip(item.label, 60)}`), `У ситуации №${card.number} нет такого факта.`);
  return fact;
}
function expectationOf(card: Card, expectationId: string): Card['agentMust'][number] {
  const expectation = card.agentMust.find(item => item.id === expectationId);
  if (!expectation) throw new UnknownReference('expectation', card.agentMust.map(item => `${item.id} ${clip(item.text, 60)}`), `У ситуации №${card.number} нет такого ожидания.`);
  return expectation;
}
function requireRequirements(library: LibraryV2, ids: readonly string[]): void {
  const missing = ids.filter(id => !library.requirements.some(item => item.id === id));
  if (missing.length) throw new UnknownReference('requirement', library.requirements.map(item => `${item.id} «${clip(item.quote, 60)}»`), 'Такого правила в ваших материалах нет.');
}
/** An expectation may rest only on rules the rulebook binds: another kind has to enter the rulebook first. */
function requireBinding(library: LibraryV2, ids: readonly string[]): void {
  const rulebook = rulebookOf(library);
  const outside = library.requirements.find(item => ids.includes(item.id) && !bindsBot(rulebook, item));
  if (outside?.kind) throw new CommandRefused(`«${clip(outside.quote, 80)}» — ${KIND_WORDS[outside.kind].one}, а такие правила не входят в свод правил: сначала включите это правило в свод.`);
}

/**
 * The next fact id of a card: after every id it ever had — its facts before the command and as the command has left
 * them so far, the facts named in its receipts, and the ids the command already gave out — so a removed fact's id is
 * never given to another one, not even later in the same series of changes.
 */
function nextFactId(library: LibraryV2, draft: Card, issued: ReadonlySet<string>): string {
  const named = library.receipts.flatMap(receipt => {
    const { command } = receipt;
    if (command.kind === 'decide_plausible') return command.facts.flatMap(item => item.cardId === draft.id ? [item.factId] : []);
    if (!('cardId' in command) || command.cardId !== draft.id) return [];
    const changes: (CardCommand | CardChange)[] = command.kind === 'edit_card' ? command.changes : [command];
    return changes.flatMap(change => (change.kind === 'set_fact' || change.kind === 'remove_fact' || change.kind === 'set_fact_disclosure') && change.factId ? [change.factId] : []);
  });
  const before = library.cards.find(item => item.id === draft.id)?.client.knows.map(fact => fact.id) ?? [];
  const numbers = [...before, ...draft.client.knows.map(fact => fact.id), ...named, ...issued].map(id => id.startsWith('f') ? Number(id.slice(1)) : 0).filter(Number.isInteger);
  return `f${Math.max(0, ...numbers) + 1}`;
}

/* ───────────────────────────── one card's change ───────────────────────────── */

/** The fields an edit names, applied in place to a card's duty or to the plan's expectation: null removes the words, `must` the mark. */
function applyDutyFields(target: Card['agentMust'][number] | BusinessScenario['expectations'][number], fields: DutyFields): void {
  if (fields.text !== undefined) target.text = fields.text;
  if (fields.requirementIds) target.requirementIds = [...new Set(fields.requirementIds)];
  if (fields.strength === 'must') delete target.strength; else if (fields.strength === 'must_not') target.strength = 'must_not';
  if (fields.acceptable === null) delete target.acceptable; else if (fields.acceptable !== undefined) target.acceptable = fields.acceptable;
  if (fields.violation === null) delete target.violation; else if (fields.violation !== undefined) target.violation = fields.violation;
}
const reworded = (fields: DutyFields): boolean => fields.text !== undefined || fields.requirementIds !== undefined || fields.strength !== undefined
  || fields.acceptable !== undefined || fields.violation !== undefined;

const place = (event: EventRef): string => `${event.batchId}/${event.dialogueId}/${event.eventIndex}`;

/**
 * Keeps the account of the later customer messages true after an edit: a message a fact no longer comes from,
 * or that is no longer the turn, is `changed` with the reason; the message the new turn comes from is the turn.
 */
function accountFor(card: Card, reason: string): Card['coverage'] {
  const facts = new Set(card.client.knows.flatMap(fact => fact.source.kind === 'dialogue' ? [place(fact.source.event)] : []));
  const turn = card.client.turn?.source.kind === 'dialogue' ? place(card.client.turn.source.event) : undefined;
  return card.coverage.map(entry => {
    const at = place(entry.event);
    if (turn === at) return entry.as === 'turn' ? entry : { event: entry.event, as: 'turn' as const };
    if (entry.as === 'fact' && !facts.has(at) || entry.as === 'turn') return { event: entry.event, as: 'changed' as const, reason };
    return entry;
  });
}

/** The card after an owner edit: a new version of it, its account kept true; `edit` changes the draft and says why, for the account. */
function revised(card: Card, edit: (draft: Card) => string): Card {
  const draft = structuredClone(card);
  const reason = edit(draft);
  draft.coverage = accountFor(draft, reason);
  draft.revision = card.revision + 1;
  return cardSchema.parse(draft);
}

/**
 * What fixes a change that would break the card, when the fix is another field: both go together as one series
 * (`edit_card`), checked once as they leave the card, so the owner never has to break the card on the way.
 */
const REMEDY: Partial<Record<CheckFinding['check'], string>> = {
  'initial-in-opening': 'Передайте вместе с первой репликой, где это есть, — одной правкой.',
  'hidden-not-in-opening': 'Передайте вместе с первой репликой без этого — одной правкой.',
  'unknown-never-said': 'Передайте вместе с поворотом и уходом без этого — одной правкой.',
};

/** A change is refused when it gives the card a deterministic problem it did not have; a problem it already had is not the command's. */
function refuseNewFindings(before: Card | undefined, after: Card, library: LibraryV2, context: CommandContext): void {
  const check = (card: Card) => unusableFindings(card, { evidence: context.evidence, maxTurns: context.maxTurns, materials: library });
  const known = new Set((before ? check(before) : []).map(finding => fingerprint(finding)));
  const found = check(after).find(finding => !known.has(fingerprint(finding)));
  if (found) throw new CommandRefused(`Так нельзя: ${problemText(found, after, library.requirements)}${REMEDY[found.check] ? ` ${REMEDY[found.check]}` : ''}`);
}

interface Edited { cards: Card[]; scope: string[]; readingManifest?: LibraryV2['readingManifest']; nextNumber?: number; rulebook?: Rulebook;
  plan?: BusinessScenario[]; planChange?: Prepared['plan'];
  /** A doubt the owner settles: the card stays as it is, and the question it asked is what changes. */
  settled?: { cardId: string; question: string } }
const replace = (library: LibraryV2, card: Card): Edited => ({ cards: library.cards.map(item => item.id === card.id ? card : item), scope: [card.id] });

/** The owner's words for a similar card's title: what differs from its parent. */
function similarTitle(parent: Card, change: Extract<CardCommand, { kind: 'add_similar' }>['change']): string {
  const fact = change.kind === 'disclosure' ? parent.client.knows.find(item => item.id === change.factId) : undefined;
  const what = change.kind === 'opening' ? 'другая первая реплика'
    : change.kind === 'turn' ? change.turn ? 'с поворотом' : 'без поворота'
    : change.disclosure === 'unknown' ? `клиент не знает «${fact?.label ?? ''}»` : change.disclosure === 'on_request' ? `«${fact?.label ?? ''}» только по просьбе` : `«${fact?.label ?? ''}» сразу`;
  return clip(`${parent.title} — ${what}`, 160);
}

function addSimilar(library: LibraryV2, command: Extract<CardCommand, { kind: 'add_similar' }>, receiptId: string, context: CommandContext): Edited {
  const parent = cardOf(library, command.parentId);
  const { change } = command;
  const owner = { kind: 'owner' as const, receiptId };
  const card = structuredClone(parent);
  if (change.kind === 'disclosure') {
    const fact = factOf(card, change.factId);
    if (fact.disclosure === 'initial' && change.disclosure !== 'initial' && change.writes === undefined) {
      throw new CommandRefused(`«${fact.label}» клиент называет в первой реплике: для похожей ситуации нужна первая реплика без этого.`);
    }
    fact.disclosure = change.disclosure; fact.source = owner;
    if (change.writes !== undefined) { card.client.writes = change.writes; card.client.writesSource = owner; }
  } else if (change.kind === 'opening') {
    card.client.writes = change.writes; card.client.writesSource = owner;
  } else if (change.turn) card.client.turn = { ...change.turn, source: owner };
  else if (card.client.turn) delete card.client.turn;
  else throw new CommandRefused(`У ситуации №${parent.number} нет поворота.`);
  const number = library.nextNumber;
  const similar = cardSchema.parse({ ...card, id: `card_${fingerprint({ parentId: parent.id, change, number })}`, number, title: command.title ?? similarTitle(parent, change),
    origin: { kind: 'similar', parentId: parent.id, change }, coverage: accountFor(card, 'Изменено в похожей ситуации.'), revision: 1 });
  refuseNewFindings(parent, similar, library, context);
  // The similar card was read against its parent's articles.
  const readingManifest = library.readingManifest.map(row => row.cardIds.includes(parent.id) ? { ...row, cardIds: [...row.cardIds, similar.id] } : row);
  return { cards: [...library.cards, similar], scope: [similar.id], readingManifest, nextNumber: number + 1 };
}

/**
 * The owner's word on a plausible label, on every card that holds it undecided: kept (named when asked, vouched by
 * this receipt) or removed (the customer then says «не знаю»). The command lists the facts it decides; a draft whose
 * facts under the label are no longer exactly those is refused as stale, so the owner never decides what they did not see.
 */
function decidePlausible(library: LibraryV2, command: Extract<CardCommand, { kind: 'decide_plausible' }>, receiptId: string, context: CommandContext): Edited {
  const group = plausibleGroup(library, command.label);
  const listed = (items: readonly { cardId: string; factId: string }[]) => fingerprint(items.map(item => `${item.cardId}/${item.factId}`).sort());
  const current = group.map(item => ({ cardId: item.card.id, factId: item.fact.id }));
  if (!group.length || listed(current) !== listed(command.facts)) {
    throw new StaleRevisionError(listed(command.facts), listed(current), `Правдоподобные факты «${clip(command.label, 80)}» уже изменились: покажу, что осталось.`);
  }
  const decided = new Set(current.map(item => `${item.cardId}/${item.factId}`));
  const reason = command.known ? `«${clip(command.label, 80)}» клиент знает — решили вы.` : `«${clip(command.label, 80)}» клиент не знает — решили вы.`;
  let cards = library.cards;
  const scope: string[] = [];
  for (const card of new Set(group.map(item => item.card))) {
    const after = revised(card, draft => {
      const mine = (fact: Card['client']['knows'][number]) => decided.has(`${card.id}/${fact.id}`);
      draft.client.knows = command.known ? draft.client.knows.map(fact => mine(fact) ? { ...fact, source: { kind: 'plausible', receiptId } } : fact)
        : draft.client.knows.filter(fact => !mine(fact));
      return reason;
    });
    refuseNewFindings(card, after, library, context);
    cards = cards.map(item => item.id === card.id ? after : item);
    scope.push(card.id);
  }
  return { cards, scope };
}

/**
 * One change of one card, made on the draft of that card: references are read on the draft as the earlier changes of a
 * series left it. `issued`: the fact ids the command gave out so far. Returns why, for the account of the later messages.
 */
function applyChange(draft: Card, change: CardChange, library: LibraryV2, context: CommandContext, owner: { kind: 'owner'; receiptId: string }, issued: Set<string>): string {
  switch (change.kind) {
    case 'set_fact_disclosure': {
      const fact = factOf(draft, change.factId);
      if (fact.disclosure === change.disclosure && fact.source.kind === 'owner') throw new CommandRefused('Так уже записано.');
      fact.disclosure = change.disclosure; fact.source = owner;
      return `Когда клиент называет «${clip(fact.label, 80)}», решили вы.`;
    }
    case 'set_fact': {
      const existing = change.factId === undefined ? undefined : factOf(draft, change.factId);
      if (!existing && draft.client.knows.length >= 8) throw new CommandRefused(`У ситуации №${draft.number} уже 8 фактов: уберите лишний, прежде чем добавлять.`);
      const id = existing?.id ?? nextFactId(library, draft, issued);
      issued.add(id);
      // How the customer recognises the agent's question stays as it was unless the command says it anew.
      const askedAs = change.askedAs ?? existing?.askedAs;
      const fact = { id, label: change.label, ...(change.value !== undefined ? { value: change.value } : {}),
        disclosure: change.disclosure, ...(askedAs !== undefined ? { askedAs } : {}), source: owner };
      draft.client.knows = existing ? draft.client.knows.map(item => item.id === fact.id ? fact : item) : [...draft.client.knows, fact];
      return `Факт «${clip(change.label, 80)}» записали вы.`;
    }
    case 'remove_fact': {
      const fact = factOf(draft, change.factId);
      draft.client.knows = draft.client.knows.filter(item => item.id !== fact.id);
      return `Факт «${clip(fact.label, 80)}» убрали вы.`;
    }
    case 'edit_expectation': {
      const target = expectationOf(draft, change.expectationId);
      if (change.text === undefined && change.requirementIds === undefined && change.appliesWhen === undefined && change.strength === undefined
        && change.acceptable === undefined && change.violation === undefined) throw new CommandRefused('Не сказано, что изменить в ожидании.');
      if (change.requirementIds) { requireRequirements(library, change.requirementIds); requireBinding(library, change.requirementIds); }
      applyDutyFields(target, change);
      if (change.appliesWhen === null) delete target.appliesWhen; else if (change.appliesWhen !== undefined) target.appliesWhen = change.appliesWhen;
      // A duty of the plan the owner rewords on this card alone is the card's own from now on: a later change of the plan
      // leaves it as the owner made it. When it applies is the card's anyway.
      if (reworded(change)) delete target.planExpectationId;
      return 'Ожидание изменили вы.';
    }
    case 'remove_expectation': {
      const expectation = expectationOf(draft, change.expectationId);
      if (draft.agentMust.length < 2) throw new CommandRefused('У ситуации должно остаться хотя бы одно ожидание: без него её нечем измерить.');
      draft.agentMust = draft.agentMust.filter(item => item.id !== expectation.id);
      return 'Ожидание убрали вы.';
    }
    case 'edit_client': {
      const worded = change.wants !== undefined || change.writes !== undefined || change.leaves !== undefined;
      if (!worded && change.clarity === undefined) throw new CommandRefused('Не сказано, что изменить у клиента.');
      if (!worded && change.clarity === (draft.clarity ?? 'clear')) throw new CommandRefused('Так уже записано.');
      if (change.wants !== undefined) draft.client.wants = change.wants;
      if (change.writes !== undefined) { draft.client.writes = change.writes; draft.client.writesSource = owner; }
      if (change.leaves !== undefined) draft.client.leaves = change.leaves;
      // A clear request is the absence of the mark, as on every card before it.
      if (change.clarity === 'vague') draft.clarity = 'vague';
      else if (change.clarity === 'clear') delete draft.clarity;
      return worded ? 'Слова клиента изменили вы.' : 'Понятен ли запрос клиента, решили вы.';
    }
    case 'set_turn': {
      const { turn } = change;
      if (!turn) {
        if (!draft.client.turn) throw new CommandRefused(`У ситуации №${draft.number} нет поворота.`);
        delete draft.client.turn;
        return 'Поворот убрали вы.';
      }
      const { event, ...rest } = turn;
      if (event) {
        if (!draft.coverage.some(entry => place(entry.event) === place(event))) throw new CommandRefused('Поворот берётся из поздней реплики клиента этого разговора.');
        // Word for word: as the log has it, or as the card reads it with Lab's values over its masks.
        const verbatim = [messageAt(context.evidence, event), cardMessage(draft, context.evidence, event)].some(said => said?.trim() === rest.says);
        if (!verbatim) throw new CommandRefused('Поворот — это слова клиента из реплики дословно.');
      }
      draft.client.turn = { ...rest, source: event ? { kind: 'dialogue', event } : owner };
      return 'Поворот изменили вы.';
    }
  }
}

/** The change one command makes to the draft's cards. */
function edit(library: LibraryV2, command: CardCommand, receiptId: string, context: CommandContext): Edited {
  const owner = { kind: 'owner' as const, receiptId };
  const change = (card: Card, apply: (draft: Card) => string): Edited => {
    const after = revised(card, apply);
    // A change that leaves the card as it was would only raise its version: nothing the owner could see.
    if (fingerprint({ ...after, revision: card.revision }) === fingerprint(card)) throw new CommandRefused('Так уже записано.');
    refuseNewFindings(card, after, library, context);
    return replace(library, after);
  };
  switch (command.kind) {
    case 'set_fact_disclosure': case 'set_fact': case 'remove_fact': case 'edit_expectation': case 'remove_expectation': case 'edit_client': case 'set_turn': {
      const { cardId, ...single } = command;
      return change(cardOf(library, cardId), draft => applyChange(draft, single, library, context, owner, new Set()));
    }
    // The whole series on one draft, checked once as it leaves the card: what is valid only together passes together.
    case 'edit_card': return change(cardOf(library, command.cardId), draft => {
      const issued = new Set<string>();
      const reasons = command.changes.map(item => applyChange(draft, item, library, context, owner, issued));
      return reasons.length === 1 ? reasons[0]! : 'Ситуацию изменили вы.';
    });
    case 'set_references': return change(cardOf(library, command.cardId), draft => {
      if (command.references.length) draft.references = command.references; else delete draft.references;
      return command.references.length ? 'Эталон ситуации задали вы.' : 'Эталон ситуации убрали вы.';
    });
    case 'fill_masked': return change(cardOf(library, command.cardId), draft => {
      applyFill(draft, command, context.evidence);
      return 'Вместо обезличенных значений Lab подставил правдоподобные — подтвердили вы.';
    });
    case 'settle_claim': {
      const card = cardOf(library, command.cardId);
      const question = cardStatus(card, { library, evidence: context.evidence, maxTurns: context.maxTurns }).question;
      if (!question?.choices.some(choice => choice.command.kind === 'settle_claim' && choice.command.key === command.key)) {
        throw new StaleRevisionError(command.key, question?.id ?? 'none', `Сомнение по ситуации №${card.number} уже другое или снято: покажу, что осталось.`);
      }
      return { cards: library.cards, scope: [card.id], settled: { cardId: card.id, question: question.text } };
    }
    case 'add_similar': return addSimilar(library, command, receiptId, context);
    case 'decide_plausible': return decidePlausible(library, command, receiptId, context);
    case 'remove_card': {
      const card = cardOf(library, command.cardId);
      return { cards: library.cards.filter(item => item.id !== card.id), scope: [card.id],
        readingManifest: library.readingManifest.map(row => ({ ...row, cardIds: row.cardIds.filter(id => id !== card.id) })) };
    }
    case 'set_rulebook': return rulebookChange(library, command.rulebook);
    case 'edit_plan_expectation': case 'remove_plan_expectation': return planChange(library, command, context);
    case 'add_variation': return variationAdded(library, command);
    case 'answer_question': throw new Error('An answer is resolved to its own command before it is applied.');
  }
}

/**
 * An expectation of the plan changes together with every card's duty that is it: the scenario keeps the owner's words,
 * and each such card becomes a new version of itself, checked as it leaves — a card the change would break is refused
 * with its number. A duty the owner reworded on its card alone is no longer the plan's and stays as it is. A removed
 * expectation leaves the scenario and those duties; it is refused where it is the scenario's or a card's last one.
 */
function planChange(library: LibraryV2, command: Extract<CardCommand, { kind: 'edit_plan_expectation' | 'remove_plan_expectation' }>, context: CommandContext): Edited {
  const plan = library.plan ?? [];
  const scenario = plan.find(item => item.id === command.scenarioId);
  if (!scenario) throw new UnknownReference('scenario', plan.map((item, index) => `${index + 1} «${clip(item.question, 60)}»`), 'Такого сценария в плане нет.');
  const expectation = scenario.expectations.find(item => item.id === command.expectationId);
  if (!expectation) throw new UnknownReference('expectation', scenario.expectations.map(item => `${item.id} ${clip(item.text, 60)}`), `У сценария «${clip(scenario.question, 80)}» нет такого ожидания.`);
  const linked = library.cards.filter(card => card.scenarioRef?.scenarioId === scenario.id && card.agentMust.some(duty => duty.planExpectationId === expectation.id));
  const mine = (duty: Card['agentMust'][number]) => duty.planExpectationId === expectation.id;
  let after: BusinessScenario;
  if (command.kind === 'edit_plan_expectation') {
    if (!reworded(command)) throw new CommandRefused('Не сказано, что изменить в ожидании.');
    if (command.requirementIds) { requireRequirements(library, command.requirementIds); requireBinding(library, command.requirementIds); }
    const edited = structuredClone(expectation);
    applyDutyFields(edited, command);
    if (fingerprint(edited) === fingerprint(expectation)) throw new CommandRefused('Так уже записано.');
    after = { ...scenario, expectations: scenario.expectations.map(item => item.id === expectation.id ? edited : item) };
  } else {
    if (scenario.expectations.length < 2) throw new CommandRefused('У сценария должно остаться хотя бы одно ожидание: без него его нечем проверить. Измените это ожидание или уберите ситуации сценария.');
    const emptied = linked.filter(card => card.agentMust.every(mine));
    if (emptied.length) throw new CommandRefused(`У ${emptied.length === 1 ? 'ситуации' : 'ситуаций'} ${emptied.map(card => `№${card.number}`).join(', ')} это единственное ожидание: без него ${emptied.length === 1 ? 'её' : 'их'} нечем измерить. Сначала уберите ${emptied.length === 1 ? 'её' : 'их'} или дайте другое ожидание.`);
    after = { ...scenario, expectations: scenario.expectations.filter(item => item.id !== expectation.id) };
  }
  const reason = command.kind === 'edit_plan_expectation' ? 'Ожидание сценария изменили вы.' : 'Ожидание сценария убрали вы.';
  // Must ↔ must not: the preview says so before anything else.
  const flip = command.kind === 'edit_plan_expectation' && command.strength !== undefined && (command.strength === 'must_not') !== (expectation.strength === 'must_not');
  let cards = library.cards;
  for (const card of linked) {
    const next = revised(card, draft => {
      if (command.kind === 'edit_plan_expectation') draft.agentMust.filter(mine).forEach(duty => applyDutyFields(duty, command));
      else draft.agentMust = draft.agentMust.filter(duty => !mine(duty));
      return reason;
    });
    refuseNewFindings(card, next, library, context);
    cards = cards.map(item => item.id === card.id ? next : item);
  }
  const kept = after.expectations.find(item => item.id === expectation.id);
  return { cards, scope: linked.map(card => card.id), plan: plan.map(item => item.id === scenario.id ? after : item),
    planChange: { scenario: scenario.question, what: 'expectation', before: expectationLine(scenario, expectation), after: kept ? expectationLine(after, kept) : null,
      ...(flip ? { flip: true as const } : {}) } };
}

/**
 * A kind of customer the owner adds to a scenario: a new variation, never traffic, that the scenario's expectations of
 * every variation apply to, and those of some variations the command names. No card changes: a situation of it is written
 * from the rules when the owner asks (lab/library.ts queueVariations). A variation nothing would check is refused.
 */
function variationAdded(library: LibraryV2, command: Extract<CardCommand, { kind: 'add_variation' }>): Edited {
  const plan = library.plan ?? [];
  const scenario = plan.find(item => item.id === command.scenarioId);
  if (!scenario) throw new UnknownReference('scenario', plan.map((item, index) => `${index + 1} «${clip(item.question, 60)}»`), 'Такого сценария в плане нет.');
  const named = command.expectationIds ?? [];
  const unknown = named.filter(id => !scenario.expectations.some(expectation => expectation.id === id));
  if (unknown.length) throw new UnknownReference('expectation', scenario.expectations.map(item => `${item.id} ${clip(item.text, 60)}`), `У сценария «${clip(scenario.question, 80)}» нет такого ожидания.`);
  if (scenario.variations.some(variation => normalizeText(variation.title) === normalizeText(command.title))) throw new CommandRefused(`Вариант «${clip(command.title, 80)}» в сценарии уже есть.`);
  if (scenario.variations.length >= 8) throw new CommandRefused('В сценарии уже 8 вариантов — больше план не держит.');
  const id = `v${Math.max(0, ...scenario.variations.map(variation => Number(variation.id.slice(1))).filter(Number.isInteger)) + 1}`;
  const after: BusinessScenario = { ...scenario, variations: [...scenario.variations, { id, title: command.title, origin: 'owner', examples: [] }],
    expectations: scenario.expectations.map(expectation => expectation.variationIds && named.includes(expectation.id) ? { ...expectation, variationIds: [...expectation.variationIds, id] } : expectation) };
  if (!variationExpectations(after, id).length) throw new CommandRefused('Для нового варианта нет ни одного ожидания: отметьте, какие ожидания сценария к нему относятся.');
  return { cards: library.cards, scope: [], plan: plan.map(item => item.id === scenario.id ? after : item),
    planChange: { scenario: scenario.question, what: 'variation', before: null, after: variationLine(after, after.variations.at(-1)!) } };
}

/**
 * A new rulebook changes no card: the cards whose expectations it leaves without a binding rule are its scope, and their
 * status sends them back to the owner (status.ts). Only rules the library holds can be named.
 */
function rulebookChange(library: LibraryV2, rulebook: Rulebook): Edited {
  requireRequirements(library, rulebook.included);
  const before = rulebookOf(library);
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(item => b.includes(item));
  if (same(before.kinds, rulebook.kinds) && same(before.included, rulebook.included)) throw new CommandRefused('Так уже записано.');
  const flagged = library.cards.filter(card => unboundCitation(card, { ...library, rulebook })).map(card => card.id);
  return { cards: library.cards, scope: flagged, rulebook };
}

/**
 * The command an answer stands for: the answer's ready-made command, with the owner's text where the answer
 * asks for their words. The question must still be the one the card asks now.
 */
function answered(library: LibraryV2, command: Extract<CardCommand, { kind: 'answer_question' }>, context: CommandContext): { command: CardCommand; basisHash: string; worded: boolean } {
  const card = cardOf(library, command.cardId);
  const question = cardStatus(card, { library, evidence: context.evidence, maxTurns: context.maxTurns }).question;
  if (!question || question.id !== command.questionId) {
    throw new StaleRevisionError(command.questionId, question?.id ?? 'none', `Вопрос по ситуации №${card.number} уже другой или снят: покажу его заново.`);
  }
  const choice = question.choices.find(item => item.id === command.choice);
  if (!choice) throw new UnknownReference('choice', question.choices.map(item => `${item.id} ${item.label}`), 'Такого ответа на этот вопрос нет.');
  if (!choice.needsText) return { command: choice.command, basisHash: question.basisHash, worded: false };
  if (command.text === undefined) throw new CommandRefused('Для этого ответа нужны ваши слова.');
  const inner = choice.command;
  const worded: CardCommand = inner.kind === 'edit_client' ? { ...inner, ...(inner.wants !== undefined ? { wants: command.text } : {}), ...(inner.writes !== undefined ? { writes: command.text } : {}),
    ...(inner.leaves !== undefined ? { leaves: command.text } : {}) }
    : inner.kind === 'edit_expectation' ? { ...inner, text: command.text } : inner;
  return { command: cardCommandSchema.parse(worded), basisHash: question.basisHash, worded: true };
}

/**
 * Prepares a command on a draft: the exact library it would make, what changes in which brief, and what
 * must then be checked again. Pure; nothing is written. A refusal (CommandRefused, UnknownReference,
 * StaleRevisionError) says why in the owner's words.
 */
export function prepareCommand(library: LibraryV2, raw: CardCommand, context: CommandContext): Prepared {
  const asked = cardCommandSchema.parse(raw);
  const before = libraryHash(library);
  const answer = asked.kind === 'answer_question' ? answered(library, asked, context) : undefined;
  const command = answer?.command ?? asked;
  // The receipt keeps the owner's words only where they became the wording: an answer that takes none keeps none.
  const ownerWords = answer ? (answer.worded ? (asked as Extract<CardCommand, { kind: 'answer_question' }>).text : undefined) : context.ownerWords;
  const receiptId = `owner_${fingerprint({ library: before, command }).slice(0, 32)}`;
  const edited = edit(library, command, receiptId, context);
  const receipt = { id: receiptId, at: context.at ?? new Date().toISOString(), via: context.via, command,
    ...(answer ? { basisHash: answer.basisHash } : {}), ...(ownerWords !== undefined ? { ownerWords } : {}) };
  const { acceptance: _accepted, ...draft } = library;
  const next = libraryV2Schema.parse({ ...draft, revision: library.revision + 1, cards: edited.cards, receipts: [...library.receipts, receipt],
    ...(edited.readingManifest ? { readingManifest: edited.readingManifest } : {}), ...(edited.nextNumber ? { nextNumber: edited.nextNumber } : {}),
    ...(edited.rulebook ? { rulebook: edited.rulebook } : {}), ...(edited.plan ? { plan: edited.plan } : {}) });
  const card = (source: LibraryV2, id: string) => source.cards.find(item => item.id === id);
  const diff = edited.scope.map(id => {
    const was = card(library, id), now = card(next, id);
    const settled = edited.settled?.cardId === id ? [{ field: 'Сомнение проверяющего', before: edited.settled.question, after: 'снято вашим решением' }] : [];
    return { cardId: id, number: (now ?? was)!.number, changes: [...settled, ...briefChanges(was && cardSituation(library, was), now && cardSituation(next, now))] };
  });
  const recheck = edited.scope.flatMap(id => {
    const now = card(next, id);
    return now ? pendingClaims(now, { library: next, evidence: context.evidence }).map(claim => claim.key) : [];
  });
  const rulebook = edited.rulebook && { before: rulebookOf(library), after: edited.rulebook,
    flagged: edited.scope.flatMap(id => card(next, id)?.number ?? []).sort((a, b) => a - b) };
  // An answer needs what the answer is and what it does: words for a choice that does not take them never make a decision a wording.
  const authority = answer ? strictest([requiredAuthority(asked), requiredAuthority(command)]) : requiredAuthority(command);
  const prepared: Prepared = { command, libraryHash: before, previewHash: fingerprint({ library: before, command, next: libraryHash(next) }),
    authority, via: context.via, diff, scope: edited.scope, recheck, ...(rulebook ? { rulebook } : {}), ...(edited.planChange ? { plan: edited.planChange } : {}), next };
  // The owner confirms what the preview shows: a change no line of it shows is never written in their name.
  if (!preparedLines(prepared).length) throw new CommandRefused('Это изменение не видно ни в одной строке ситуации, поэтому Lab его не записывает.');
  return prepared;
}

/**
 * What a prepared command changes, in the owner's lines, the same on every surface: «было → стало» of each touched
 * situation — every field that moves, a duty turned into its opposite first of all — and a change of the rulebook; for
 * the plan, its expectation before and after and the numbers of the situations that change with it — one change, not
 * the same line for each of them. Pure: each surface makes them safe.
 */
export function preparedLines(prepared: Pick<Prepared, 'diff' | 'rulebook' | 'plan' | 'next'>): string[] {
  const { plan } = prepared;
  if (plan?.what === 'variation') return [`Сценарий «${plan.scenario}» — новый вариант клиента:`, `  ${plan.after ?? ''}`,
    'Ситуацию этого варианта Lab составит по правилам, когда вы скажете: это расходует вызовы модели.'];
  if (plan) {
    const numbers = prepared.diff.map(item => item.number).sort((a, b) => a - b);
    return [`Сценарий «${plan.scenario}» — общее ожидание`, ...(plan.flip ? ['  Смысл ожидания меняется на противоположный:'] : []),
      `  было: ${plan.before ?? '—'}`, `  стало: ${plan.after ?? 'убрано из плана'}`,
      numbers.length === 1 ? `Вместе с ним ${plan.after ? 'меняется' : 'теряет его'} ситуация ${numbers[0]}.`
        : numbers.length ? `Вместе с ним ${plan.after ? 'меняются' : 'теряют его'} ситуации ${numbers.join(', ')}.` : 'Ситуаций с этим ожиданием сейчас нет.'];
  }
  const lines = (flip: boolean) => prepared.diff.flatMap(item => item.changes.filter(change => !!change.flip === flip).map(change => `${item.number}  ${changeText(change)}`));
  return [...lines(true), ...lines(false),
    ...(prepared.rulebook ? rulebookChangeLines(prepared.rulebook.before, prepared.rulebook.after, prepared.next.requirements, prepared.rulebook.flagged) : [])];
}

/**
 * Applies a prepared command with the owner's grant. The grant must be one a host issued for this very
 * preview, confirmed natively when the command needs a confirmation; the draft must still be the one the
 * preview was made on, or the owner is shown the fresh state instead (StaleRevisionError).
 */
export function applyCommand(library: LibraryV2, prepared: Prepared, grant: HostGrant): LibraryV2 {
  if (!issued.has(grant) || grant.previewHash !== prepared.previewHash || grant.via !== prepared.via
    || fingerprint({ library: prepared.libraryHash, command: prepared.command, next: libraryHash(prepared.next) }) !== prepared.previewHash) {
    throw new CommandRefused('Изменение записывается только после вашего решения в Pi, на доске или с --yes в командной строке.');
  }
  if (prepared.authority === 'owner-confirm' && grant.basis !== 'confirmed') throw new CommandRefused('Это решение о клиенте: его нужно подтвердить.');
  const current = libraryHash(library);
  if (current !== prepared.libraryHash) throw new StaleRevisionError(prepared.libraryHash, current);
  return libraryV2Schema.parse(prepared.next);
}

/* ───────────────────────────── the agent version behind the logs ───────────────────────────── */

export interface PreparedLogVersion {
  command: LogVersionCommand;
  /** The import's journal it was prepared on, null before the first declaration: applied to any other state it is refused. */
  journalHash: string | null;
  /** Binds a grant to exactly what the owner was shown. */
  previewHash: string;
  authority: 'owner-confirm';
  via: Via;
  /** «Было → стало»: the version declared before (undefined — never declared, null — «неизвестно») and the one declared now. */
  change: { before: string | null | undefined; after: string | null };
  next: LogVersionJournal;
}

const PREVIEW_ONLY = 'Изменение записывается только после вашего решения в Pi, на доске или с --yes в командной строке.';
const MOVED = 'Версию логов уже изменили: покажу, что записано сейчас.';
const previewOf = (prepared: Pick<PreparedLogVersion, 'journalHash' | 'command' | 'next'>): string =>
  fingerprint({ journal: prepared.journalHash, command: prepared.command, next: fingerprint(prepared.next) });

/**
 * Prepares the owner's word on which agent version wrote an import's logs (docs/design/card-v2-spec.md §10.2): the next journal of
 * the import with one more declaration. Pure; nothing is written. The declaration lives beside the import and
 * never in a library, so declaring after an acceptance changes no library hash and no acceptance; a run keeps
 * a snapshot of what it used, so its result never moves with a later declaration.
 */
export function prepareLogVersion(journal: LogVersionJournal | undefined, batch: Pick<ImportBatch, 'id' | 'contentHash'>, raw: LogVersionCommand,
  context: { via: Via; at?: string }): PreparedLogVersion {
  const command = logVersionCommandSchema.parse(raw);
  if (command.importId !== batch.id || journal && (journal.importId !== batch.id || journal.contentHash !== batch.contentHash)) {
    throw new CommandRefused('Версия относится к другому импорту логов.');
  }
  const before = journal?.declarations.at(-1)?.command.version;
  if (before === command.version) throw new CommandRefused('Так уже записано.');
  const journalHash = journal ? fingerprint(journal) : null;
  const receipt = { id: `logs_${fingerprint({ journal: journalHash, command }).slice(0, 32)}`, at: context.at ?? new Date().toISOString(), via: context.via, command };
  const next = logVersionJournalSchema.parse({ formatVersion: 1, importId: batch.id, contentHash: batch.contentHash, declarations: [...journal?.declarations ?? [], receipt] });
  return { command, journalHash, previewHash: previewOf({ journalHash, command, next }), authority: 'owner-confirm', via: context.via, change: { before, after: command.version }, next };
}

/**
 * Applies a prepared declaration with the owner's grant: one a host issued for this very preview after a native
 * confirmation. The journal must still be the one the preview was made on, or the owner is shown the fresh state.
 */
export function applyLogVersion(journal: LogVersionJournal | undefined, prepared: PreparedLogVersion, grant: HostGrant): LogVersionJournal {
  if (!issued.has(grant) || grant.previewHash !== prepared.previewHash || grant.via !== prepared.via || previewOf(prepared) !== prepared.previewHash) throw new CommandRefused(PREVIEW_ONLY);
  if (grant.basis !== 'confirmed') throw new CommandRefused('Версию логов нужно подтвердить.');
  const current = journal ? fingerprint(journal) : null;
  if (current !== prepared.journalHash) throw new StaleRevisionError(prepared.journalHash ?? 'none', current ?? 'none', MOVED);
  return logVersionJournalSchema.parse(prepared.next);
}

import { fingerprint } from '../contracts.js';
import { CommandRefused, StaleRevisionError, UnknownReference } from '../errors.js';
import { libraryHash } from '../scenario-library.js';
import { clip } from '../text.js';
import { messageAt, problemText, unusableFindings, type CardEvidence, type CheckFinding } from './checks.js';
import { pendingClaims } from './review.js';
import { cardCommandSchema, cardSchema, libraryV2Schema, type Card, type CardCommand, type EventRef, type LibraryV2 } from './schema.js';
import { cardStatus } from './status.js';
import { briefChanges, cardSituation, type BriefChange } from './view.js';

/*
 * The owner's commands on a draft of cards (card-v2 §5): one layer for the chat, the board and the CLI. An
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

/** The authority a command needs; the same in every adapter. */
export function requiredAuthority(command: CardCommand): Authority {
  switch (command.kind) {
    case 'edit_client': return 'owner-words';
    case 'edit_expectation': return command.text !== undefined || typeof command.appliesWhen === 'string' ? 'owner-words' : 'owner-confirm';
    case 'set_turn': return command.turn && !command.turn.event ? 'owner-words' : 'owner-confirm';
    // A similar card whose customer knows something else is a claim about the customer, whatever its words.
    case 'add_similar': return command.change.kind === 'opening' || command.change.kind === 'turn' && command.change.turn !== null ? 'owner-words' : 'owner-confirm';
    // An answer in the owner's own words is a wording; picking an answer is a decision.
    case 'answer_question': return command.text !== undefined ? 'owner-words' : 'owner-confirm';
    case 'set_fact_disclosure': case 'set_fact': case 'remove_fact': case 'remove_expectation': case 'settle_claim': case 'remove_card': return 'owner-confirm';
  }
}

/** The wordings of a command: what `owner-words` asks to be the owner's own text. */
export function wordsOf(command: CardCommand): string[] {
  const texts = (...items: (string | null | undefined)[]) => items.filter((item): item is string => typeof item === 'string');
  switch (command.kind) {
    case 'edit_client': return texts(command.wants, command.writes, command.leaves);
    case 'edit_expectation': return texts(command.text, command.appliesWhen);
    case 'set_turn': return command.turn && !command.turn.event ? texts(command.turn.after, command.turn.says) : [];
    case 'add_similar': return command.change.kind === 'opening' ? [command.change.writes] : command.change.kind === 'turn' ? texts(command.change.turn?.after, command.change.turn?.says)
      : texts(command.change.writes);
    case 'answer_question': return texts(command.text);
    case 'set_fact_disclosure': case 'set_fact': case 'remove_fact': case 'remove_expectation': case 'settle_claim': case 'remove_card': return [];
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

/**
 * The next fact id of a card: after every id it ever had — its facts and the facts named in its receipts, so a
 * removed fact's id is never given to another one.
 */
function nextFactId(library: LibraryV2, card: Card): string {
  const named = library.receipts.flatMap(receipt => {
    const { command } = receipt;
    return (command.kind === 'set_fact' || command.kind === 'remove_fact' || command.kind === 'set_fact_disclosure') && command.cardId === card.id && command.factId ? [command.factId] : [];
  });
  const numbers = [...card.client.knows.map(fact => fact.id), ...named].map(id => id.startsWith('f') ? Number(id.slice(1)) : 0).filter(Number.isInteger);
  return `f${Math.max(0, ...numbers) + 1}`;
}

/* ───────────────────────────── one card's change ───────────────────────────── */

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

/** The card after an owner edit: a new version of it, its account kept true. */
function revised(card: Card, reason: string, edit: (draft: Card) => void): Card {
  const draft = structuredClone(card);
  edit(draft);
  draft.coverage = accountFor(draft, reason);
  draft.revision = card.revision + 1;
  return cardSchema.parse(draft);
}

/** What the owner is told first when a change would break the card, and what fixes it. */
const REMEDY: Partial<Record<CheckFinding['check'], string>> = {
  'initial-in-opening': 'Сначала измените первую реплику.',
  'hidden-not-in-opening': 'Сначала уберите это из первой реплики.',
  'unknown-never-said': 'Сначала уберите это из слов клиента.',
};

/** A change is refused when it gives the card a deterministic problem it did not have; a problem it already had is not the command's. */
function refuseNewFindings(before: Card | undefined, after: Card, library: LibraryV2, context: CommandContext): void {
  const check = (card: Card) => unusableFindings(card, { evidence: context.evidence, maxTurns: context.maxTurns, materials: library });
  const known = new Set((before ? check(before) : []).map(finding => fingerprint(finding)));
  const found = check(after).find(finding => !known.has(fingerprint(finding)));
  if (found) throw new CommandRefused(`Так нельзя: ${problemText(found, after, library.requirements)}${REMEDY[found.check] ? ` ${REMEDY[found.check]}` : ''}`);
}

interface Edited { cards: Card[]; scope: string[]; readingManifest?: LibraryV2['readingManifest']; nextNumber?: number }
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

/** The change one command makes to the draft's cards. */
function edit(library: LibraryV2, command: CardCommand, receiptId: string, context: CommandContext): Edited {
  const owner = { kind: 'owner' as const, receiptId };
  const change = (card: Card, reason: string, apply: (draft: Card) => void): Edited => {
    const after = revised(card, reason, apply);
    refuseNewFindings(card, after, library, context);
    return replace(library, after);
  };
  switch (command.kind) {
    case 'set_fact_disclosure': {
      const card = cardOf(library, command.cardId);
      const fact = factOf(card, command.factId);
      if (fact.disclosure === command.disclosure && fact.source.kind === 'owner') throw new CommandRefused('Так уже записано.');
      return change(card, `Когда клиент называет «${clip(fact.label, 80)}», решили вы.`, draft => {
        const target = draft.client.knows.find(item => item.id === fact.id)!;
        target.disclosure = command.disclosure; target.source = owner;
      });
    }
    case 'set_fact': {
      const card = cardOf(library, command.cardId);
      const existing = command.factId === undefined ? undefined : factOf(card, command.factId);
      if (!existing && card.client.knows.length >= 8) throw new CommandRefused(`У ситуации №${card.number} уже 8 фактов: уберите лишний, прежде чем добавлять.`);
      const fact = { id: existing?.id ?? nextFactId(library, card), label: command.label, ...(command.value !== undefined ? { value: command.value } : {}),
        disclosure: command.disclosure, ...(command.askedAs !== undefined ? { askedAs: command.askedAs } : {}), source: owner };
      return change(card, `Факт «${clip(command.label, 80)}» записали вы.`, draft => {
        draft.client.knows = existing ? draft.client.knows.map(item => item.id === fact.id ? fact : item) : [...draft.client.knows, fact];
      });
    }
    case 'remove_fact': {
      const card = cardOf(library, command.cardId);
      const fact = factOf(card, command.factId);
      return change(card, `Факт «${clip(fact.label, 80)}» убрали вы.`, draft => { draft.client.knows = draft.client.knows.filter(item => item.id !== fact.id); });
    }
    case 'edit_expectation': {
      const card = cardOf(library, command.cardId);
      const expectation = expectationOf(card, command.expectationId);
      if (command.text === undefined && command.requirementIds === undefined && command.appliesWhen === undefined) throw new CommandRefused('Не сказано, что изменить в ожидании.');
      if (command.requirementIds) requireRequirements(library, command.requirementIds);
      return change(card, 'Ожидание изменили вы.', draft => {
        const target = draft.agentMust.find(item => item.id === expectation.id)!;
        if (command.text !== undefined) target.text = command.text;
        if (command.requirementIds) target.requirementIds = [...new Set(command.requirementIds)];
        if (command.appliesWhen === null) delete target.appliesWhen; else if (command.appliesWhen !== undefined) target.appliesWhen = command.appliesWhen;
      });
    }
    case 'remove_expectation': {
      const card = cardOf(library, command.cardId);
      const expectation = expectationOf(card, command.expectationId);
      if (card.agentMust.length < 2) throw new CommandRefused('У ситуации должно остаться хотя бы одно ожидание: без него её нечем измерить.');
      return change(card, 'Ожидание убрали вы.', draft => { draft.agentMust = draft.agentMust.filter(item => item.id !== expectation.id); });
    }
    case 'edit_client': {
      const card = cardOf(library, command.cardId);
      if (command.wants === undefined && command.writes === undefined && command.leaves === undefined) throw new CommandRefused('Не сказано, что изменить у клиента.');
      return change(card, 'Слова клиента изменили вы.', draft => {
        if (command.wants !== undefined) draft.client.wants = command.wants;
        if (command.writes !== undefined) { draft.client.writes = command.writes; draft.client.writesSource = owner; }
        if (command.leaves !== undefined) draft.client.leaves = command.leaves;
      });
    }
    case 'set_turn': {
      const card = cardOf(library, command.cardId);
      const { turn } = command;
      if (!turn) {
        if (!card.client.turn) throw new CommandRefused(`У ситуации №${card.number} нет поворота.`);
        return change(card, 'Поворот убрали вы.', draft => { delete draft.client.turn; });
      }
      const { event, ...rest } = turn;
      if (event) {
        if (!card.coverage.some(entry => place(entry.event) === place(event))) throw new CommandRefused('Поворот берётся из поздней реплики клиента этого разговора.');
        if (messageAt(context.evidence, event)?.trim() !== rest.says) throw new CommandRefused('Поворот — это слова клиента из реплики дословно.');
      }
      return change(card, 'Поворот изменили вы.', draft => { draft.client.turn = { ...rest, source: event ? { kind: 'dialogue', event } : owner }; });
    }
    case 'settle_claim': {
      const card = cardOf(library, command.cardId);
      const question = cardStatus(card, { library, evidence: context.evidence, maxTurns: context.maxTurns }).question;
      if (!question?.choices.some(choice => choice.command.kind === 'settle_claim' && choice.command.key === command.key)) {
        throw new StaleRevisionError(command.key, question?.id ?? 'none', `Сомнение по ситуации №${card.number} уже другое или снято: покажу, что осталось.`);
      }
      return { cards: library.cards, scope: [card.id] };
    }
    case 'add_similar': return addSimilar(library, command, receiptId, context);
    case 'remove_card': {
      const card = cardOf(library, command.cardId);
      return { cards: library.cards.filter(item => item.id !== card.id), scope: [card.id],
        readingManifest: library.readingManifest.map(row => ({ ...row, cardIds: row.cardIds.filter(id => id !== card.id) })) };
    }
    case 'answer_question': throw new Error('An answer is resolved to its own command before it is applied.');
  }
}

/**
 * The command an answer stands for: the answer's ready-made command, with the owner's text where the answer
 * asks for their words. The question must still be the one the card asks now.
 */
function answered(library: LibraryV2, command: Extract<CardCommand, { kind: 'answer_question' }>, context: CommandContext): { command: CardCommand; basisHash: string } {
  const card = cardOf(library, command.cardId);
  const question = cardStatus(card, { library, evidence: context.evidence, maxTurns: context.maxTurns }).question;
  if (!question || question.id !== command.questionId) {
    throw new StaleRevisionError(command.questionId, question?.id ?? 'none', `Вопрос по ситуации №${card.number} уже другой или снят: покажу его заново.`);
  }
  const choice = question.choices.find(item => item.id === command.choice);
  if (!choice) throw new UnknownReference('choice', question.choices.map(item => `${item.id} ${item.label}`), 'Такого ответа на этот вопрос нет.');
  if (!choice.needsText) return { command: choice.command, basisHash: question.basisHash };
  if (command.text === undefined) throw new CommandRefused('Для этого ответа нужны ваши слова.');
  const inner = choice.command;
  const worded: CardCommand = inner.kind === 'edit_client' ? { ...inner, ...(inner.wants !== undefined ? { wants: command.text } : {}), ...(inner.writes !== undefined ? { writes: command.text } : {}),
    ...(inner.leaves !== undefined ? { leaves: command.text } : {}) }
    : inner.kind === 'edit_expectation' ? { ...inner, text: command.text } : inner;
  return { command: cardCommandSchema.parse(worded), basisHash: question.basisHash };
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
  const ownerWords = asked.kind === 'answer_question' ? asked.text : context.ownerWords;
  const receiptId = `owner_${fingerprint({ library: before, command }).slice(0, 32)}`;
  const edited = edit(library, command, receiptId, context);
  const receipt = { id: receiptId, at: context.at ?? new Date().toISOString(), via: context.via, command,
    ...(answer ? { basisHash: answer.basisHash } : {}), ...(ownerWords !== undefined ? { ownerWords } : {}) };
  const { acceptance: _accepted, ...draft } = library;
  const next = libraryV2Schema.parse({ ...draft, revision: library.revision + 1, cards: edited.cards, receipts: [...library.receipts, receipt],
    ...(edited.readingManifest ? { readingManifest: edited.readingManifest } : {}), ...(edited.nextNumber ? { nextNumber: edited.nextNumber } : {}) });
  const card = (source: LibraryV2, id: string) => source.cards.find(item => item.id === id);
  const diff = edited.scope.map(id => {
    const was = card(library, id), now = card(next, id);
    return { cardId: id, number: (now ?? was)!.number, changes: briefChanges(was && cardSituation(library, was), now && cardSituation(next, now)) };
  });
  const recheck = edited.scope.flatMap(id => {
    const now = card(next, id);
    return now ? pendingClaims(now, { library: next, evidence: context.evidence }).map(claim => claim.key) : [];
  });
  return { command, libraryHash: before, previewHash: fingerprint({ library: before, command, next: libraryHash(next) }),
    authority: answer ? requiredAuthority(asked) : requiredAuthority(command), via: context.via, diff, scope: edited.scope, recheck, next };
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

import { fingerprint } from '../contracts.js';
import { countText } from '../plural.js';
import { clip } from '../text.js';
import { messageAt, normalizeText, problemText, quotable, unusableFindings, type CardEvidence } from './checks.js';
import { planClaims, type Claim, type ClaimKind } from './review.js';
import type { Card, CardCommand, ClaimReceipt, LibraryV2 } from './schema.js';

/*
 * The status of a card and the one question the owner is asked (docs/design/card-v2-spec.md §2.6). Both are derived, never stored:
 * from the card, the reviewer's receipts and the owner's receipts. The question and its answers are harness
 * templates in the owner's words; every answer is a typed command built in advance, so a choice never has to be
 * interpreted. The first open question is the only one shown: after the answer the next one, if any, appears.
 *
 *   deterministic finding ─► unusable      no receipt for a current claim ─► checking
 *   a claim blocked       ─► unusable      an unconfirmed fact, an open doubt, an undecided plausible label,
 *                                          a twin ─► needs_owner (first one)
 *   otherwise             ─► ready
 */

export type CardStatusKind = 'checking' | 'ready' | 'needs_owner' | 'unusable';
export interface QuestionChoice {
  id: 'a' | 'b' | 'c'; label: string;
  command: CardCommand;
  /** The owner's own words complete the command: they replace the text the command carries now. */
  needsText?: true;
}
export interface Question {
  /** digest(kind, subject, basis): an answer goes stale when the basis changes. */
  id: string;
  text: string;
  choices: QuestionChoice[];
  basisHash: string;
}
export interface CardStatus { status: CardStatusKind; question?: Question; problems: string[] }

export interface StatusContext { library: LibraryV2; evidence: CardEvidence; maxTurns: number }

/** What a card's compiled definition depends on besides its name, number and origin: two cards equal here run the same test. */
function definitionIdentity(card: Card): string {
  const { wants, writes, knows, leaves, turn } = card.client;
  return fingerprint({ wants, writes, knows: knows.map(({ source: _source, ...fact }) => fact), leaves,
    turn: turn ? { kind: turn.kind, after: turn.after, says: turn.says } : null, agentMust: card.agentMust });
}

/** A doubt the owner settled in their own name: a `settle_claim` receipt on exactly this key. */
const settled = (library: LibraryV2, key: string): boolean =>
  library.receipts.some(receipt => receipt.command.kind === 'settle_claim' && receipt.command.key === key);

/** Choices in the order given, lettered a, b, c. */
function question(id: string, basisHash: string, text: string, choices: Omit<QuestionChoice, 'id'>[]): Question {
  return { id, basisHash, text, choices: choices.map((choice, index) => ({ ...choice, id: (['a', 'b', 'c'] as const)[index]! })) };
}

type Fact = Card['client']['knows'][number];
const statement = (fact: Fact): string => quotable(fact.value) ? `${fact.label}: ${fact.value}` : fact.label;

/** A fact no message vouches for: only the owner can say whether the customer knows it. */
function unconfirmedQuestion(card: Card, fact: Fact, claim: Claim): Question {
  const id = fingerprint({ kind: 'unconfirmed', subject: fact.id, basisHash: claim.basisHash });
  const disclose = (disclosure: 'on_request' | 'unknown'): CardCommand => ({ kind: 'set_fact_disclosure', cardId: card.id, factId: fact.id, disclosure });
  return question(id, claim.basisHash, `Клиент знает «${clip(statement(fact), 200)}»?`, [
    { label: 'Да, скажет, если спросят', command: disclose('on_request') },
    { label: 'Нет, не знает', command: disclose('unknown') },
    { label: 'Убрать', command: { kind: 'remove_fact', cardId: card.id, factId: fact.id } },
  ]);
}

/** A plausible fact the owner has not decided yet. */
const undecidedPlausible = (fact: Fact): boolean => fact.source.kind === 'plausible' && fact.source.receiptId === undefined;

/**
 * The undecided plausible facts of the whole draft that share a label, the way the owner decides them: one word per
 * label, compared after the one normalisation, so «Тип оборудования» on five cards is one decision.
 */
export function plausibleGroup(library: LibraryV2, label: string): { card: Card; fact: Fact }[] {
  const key = normalizeText(label);
  return [...library.cards].sort((a, b) => a.number - b.number)
    .flatMap(card => card.client.knows.filter(fact => undecidedPlausible(fact) && normalizeText(fact.label) === key).map(fact => ({ card, fact })));
}

/**
 * «Клиенты знают „Тип оборудования“?» — asked once for a label across the draft: every card holding it asks the same
 * question (the same id), and either answer decides the label on all of them in one receipt. The basis is every
 * such fact, so a new card with the label, or an edit of one, asks again.
 */
function plausibleQuestion(library: LibraryV2, fact: Fact): Question {
  const group = plausibleGroup(library, fact.label);
  const basisHash = fingerprint(group.map(item => ({ cardId: item.card.id, fact: { ...item.fact, source: { kind: 'plausible' } } })));
  const id = fingerprint({ kind: 'plausible', subject: normalizeText(fact.label), basisHash });
  const values = [...new Set(group.flatMap(item => item.fact.value === undefined ? [] : [quotable(item.fact.value) ? String(item.fact.value) : item.fact.value ? 'да' : 'нет']))];
  const facts = group.map(item => ({ cardId: item.card.id, factId: item.fact.id }));
  const decide = (known: boolean): CardCommand => ({ kind: 'decide_plausible', label: fact.label, known, facts });
  const shown = values.length ? ` (${clip(values.join(', '), 120)})` : '';
  return question(id, basisHash, `Клиенты знают «${clip(fact.label, 100)}»${shown}, если агент спросит? В логах этого нет — Lab предполагает; ответ относится ко всем ситуациям с этим фактом: ${countText(group.length, ['ситуация', 'ситуации', 'ситуаций'])}.`, [
    { label: 'Да, скажут, если спросят', command: decide(true) },
    { label: 'Нет, не знают', command: decide(false) },
  ]);
}

/** The later message a doubt about the account can mean: the first one left out, else the one the customer stops on. */
function doubtedMessage(card: Card, evidence: CardEvidence) {
  const entry = card.coverage.find(item => item.as === 'ignored') ?? card.coverage.find(item => item.as === 'stop');
  const said = entry && messageAt(evidence, entry.event);
  return entry && said !== undefined ? { event: entry.event, said } : undefined;
}

/** The reviewer doubted a claim the owner can decide: its question, in the reviewer's own reason. */
function doubtQuestion(card: Card, claim: Claim, receipt: ClaimReceipt, evidence: CardEvidence): Question {
  const settle: Omit<QuestionChoice, 'id'> = { label: 'Да', command: { kind: 'settle_claim', cardId: card.id, key: claim.key } };
  const reason = clip(receipt.reason, 150);
  const ask = (text: string, choices: Omit<QuestionChoice, 'id'>[]) => question(claim.key, claim.basisHash, text, choices);
  const removeCard = { label: 'Убрать ситуацию', command: { kind: 'remove_card', cardId: card.id } } as const;
  switch (claim.kind) {
    case 'goal': return ask(`Клиент хочет именно «${clip(card.client.wants, 120)}»? ${reason}`, [settle,
      { label: 'Сказать иначе', command: { kind: 'edit_client', cardId: card.id, wants: card.client.wants }, needsText: true }]);
    case 'expectation': {
      const expectation = card.agentMust.find(item => item.id === claim.subject)!;
      return ask(`Агент должен «${clip(expectation.text, 100)}»? Проверяющий сомневается: ${reason}`, [{ ...settle, label: 'Да, это правило' },
        ...(card.agentMust.length > 1 ? [{ label: 'Убрать', command: { kind: 'remove_expectation', cardId: card.id, expectationId: expectation.id } } as const] : []),
        { label: 'Сказать иначе', command: { kind: 'edit_expectation', cardId: card.id, expectationId: expectation.id, text: expectation.text }, needsText: true }]);
    }
    case 'fact': {
      const fact = card.client.knows.find(item => item.id === claim.subject)!;
      return ask(`Клиент знал «${clip(fact.label, 100)}» до разговора? ${reason}`, [settle,
        ...(fact.disclosure !== 'unknown' ? [{ label: 'Не знал', command: { kind: 'set_fact_disclosure', cardId: card.id, factId: fact.id, disclosure: 'unknown' } } as const] : []),
        { label: 'Убрать', command: { kind: 'remove_fact', cardId: card.id, factId: fact.id } }]);
    }
    case 'coverage': {
      const doubted = doubtedMessage(card, evidence);
      if (!doubted) return ask(`Поздние реплики клиента учтены неверно? ${reason}`, [{ ...settle, label: 'Нет, всё верно' }, removeCard]);
      // One turn per card: a card that has one can only be left out when another late message matters.
      const turn = !card.client.turn && doubted.said.trim().length <= 1000
        ? { label: 'Да, это поворот', command: { kind: 'set_turn', cardId: card.id,
          turn: { kind: 'report', after: 'агент ответил на предыдущую реплику', says: doubted.said.trim(), event: doubted.event } } } as const
        : { ...removeCard, label: 'Да, ситуация не подходит' };
      return ask(`В диалоге клиент ещё писал: «${clip(doubted.said, 150)}». Это важно для проверки?`, [{ ...settle, label: 'Нет' }, turn]);
    }
    case 'leak': return ask(`Слова клиента подсказывают агенту ответ? ${reason}`, [{ ...settle, label: 'Нет' },
      { label: 'Изменить первую реплику', command: { kind: 'edit_client', cardId: card.id, writes: card.client.writes }, needsText: true }]);
  }
}

function duplicateQuestion(card: Card, twin: Card): Question {
  const basisHash = definitionIdentity(card);
  const id = fingerprint({ kind: 'duplicate', subject: twin.id, basisHash });
  return question(id, basisHash, `Совпадает с №${twin.number}. Оставить обе?`, [
    { label: 'Оставить', command: { kind: 'settle_claim', cardId: card.id, key: id } },
    { label: 'Убрать эту', command: { kind: 'remove_card', cardId: card.id } },
  ]);
}

/** The order doubts are asked in: what the customer wants, what the agent must do, what they know, the account, the leak. */
const DOUBT_ORDER: readonly ClaimKind[] = ['goal', 'expectation', 'fact', 'coverage', 'leak'];

function statusOf(card: Card, context: StatusContext, twin: Card | undefined): CardStatus {
  const { library, evidence, maxTurns } = context;
  const findings = unusableFindings(card, { evidence, maxTurns, materials: library });
  if (findings.length) return { status: 'unusable', problems: findings.map(finding => problemText(finding, card, library.requirements)) };
  const claims = planClaims(card, context);
  const receipts = claims.flatMap(claim => {
    const receipt = library.claims.find(item => item.key === claim.key);
    return receipt ? [{ claim, receipt }] : [];
  });
  if (receipts.length < claims.length) return { status: 'checking', problems: [] };
  const blocked = receipts.filter(item => item.receipt.status === 'blocked');
  if (blocked.length) return { status: 'unusable', problems: blocked.map(item => item.receipt.reason) };
  const unconfirmed = card.client.knows.find(fact => fact.source.kind === 'unconfirmed');
  const plausible = card.client.knows.find(undecidedPlausible);
  const doubt = receipts.filter(item => item.receipt.status === 'needs_owner' && !settled(library, item.claim.key))
    .sort((a, b) => DOUBT_ORDER.indexOf(a.claim.kind) - DOUBT_ORDER.indexOf(b.claim.kind))[0];
  const duplicate = twin && duplicateQuestion(card, twin);
  const open = unconfirmed ? unconfirmedQuestion(card, unconfirmed, receipts.find(item => item.claim.kind === 'fact' && item.claim.subject === unconfirmed.id)!.claim)
    : doubt ? doubtQuestion(card, doubt.claim, doubt.receipt, evidence)
    : plausible ? plausibleQuestion(library, plausible)
    : duplicate && !settled(library, duplicate.id) ? duplicate : undefined;
  return open ? { status: 'needs_owner', question: open, problems: [] } : { status: 'ready', problems: [] };
}

/**
 * The status of every card of a library at once. A card whose definition equals an earlier-numbered card's is
 * its twin: the later one asks whether to keep both.
 */
export function cardStatuses(context: StatusContext): Map<string, CardStatus> {
  const first = new Map<string, Card>();
  for (const card of [...context.library.cards].sort((a, b) => a.number - b.number)) {
    const identity = definitionIdentity(card);
    if (!first.has(identity)) first.set(identity, card);
  }
  return new Map(context.library.cards.map(card => {
    const twin = first.get(definitionIdentity(card));
    return [card.id, statusOf(card, context, twin && twin.id !== card.id ? twin : undefined)];
  }));
}

/** The status of one card of the library. */
export function cardStatus(card: Card, context: StatusContext): CardStatus {
  const twin = [...context.library.cards].sort((a, b) => a.number - b.number)
    .find(other => other.number < card.number && definitionIdentity(other) === definitionIdentity(card));
  return statusOf(card, context, twin);
}

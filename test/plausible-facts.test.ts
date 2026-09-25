import test from 'node:test';
import assert from 'node:assert/strict';
import { importEvidence, loggedMessages } from '../src/card/checks.js';
import { cardExclusion } from '../src/card/calibration-scope.js';
import { applyCommand, hostGrant, prepareCommand, type CommandContext } from '../src/card/commands.js';
import { compileCard, compilePolicy } from '../src/card/compile.js';
import { addCard, createLibraryV2 } from '../src/card/library.js';
import { bindProposal, cardProposalProblem, proposalCall, type DialogueProposal } from '../src/card/proposal.js';
import { cardSchema, type Card, type LibraryV2 } from '../src/card/schema.js';
import { cardStatuses } from '../src/card/status.js';
import { briefRows, plainSituationText, situationViews } from '../src/card/view.js';
import { fingerprint, type Trial } from '../src/contracts.js';
import { customerMoves, dunnoThenLeft } from '../src/customer-moves.js';
import { decisions } from '../src/inbox.js';
import { htmlReport } from '../src/report.js';
import { buildResultView } from '../src/result-view.js';
import { DUNNO_MARK, errorListRows, trustParts } from '../src/result-text.js';
import { deriveRun } from '../src/run.js';
import { importBatch } from '../src/scenario-library.js';
import { advanceUser, allowedUserActions, createUserState, USER_CONTROLLER_PROTOCOL } from '../src/user-controller.js';
import { reviewed } from './helpers/card-library.js';
import { dialogues, policy, proposals, refundRule } from './helpers/card-prep.js';
import { briefCard, cardAttempt, cardRun, requirements } from './helpers/cards.js';

/*
 * W2: the customer Lab plays knows what a real one knows. A card may add plausible profile facts that no log states;
 * they are shown as Lab's assumption, decided by the owner once per label for the whole draft, answered when asked
 * once confirmed, and keep the card out of the agreement with production. The conversation may be as long as the
 * logged one, and the result says how often the customer could not answer. Invented refund data; no owner data.
 */

const EQUIPMENT = { label: 'Тип оборудования', value: 'POS-терминал', askedAs: 'какой у клиента терминал' };

/** The two refund cards of card-prep.ts, each also knowing its kind of equipment — the second under a differently spaced label. */
function plausibleDraft() {
  const batch = importBatch(dialogues);
  const evidence = importEvidence([batch]);
  const sources = [{ id: 'source-1', name: 'Правила возвратов', content: policy, hash: fingerprint(policy) }];
  const rules = [{ ...refundRule, sourceId: 'source-1' }];
  let library = createLibraryV2({ id: 'library_plausible', imports: [{ id: batch.id, contentHash: batch.contentHash }], sources, requirements: rules, createdAt: '2026-09-24T10:00:00.000Z' });
  for (const dialogue of batch.dialogues) {
    const key = dialogue.id as 'late' | 'known';
    const call = proposalCall({ source: { kind: 'dialogue', batchId: batch.id, dialogueId: dialogue.id }, messages: loggedMessages(dialogue), sources, maxTurns: 6 });
    const plausibleKnows = [{ ...EQUIPMENT, label: key === 'late' ? EQUIPMENT.label : 'тип  оборудования' }];
    library = addCard(library, bindProposal({ ...proposals[key], plausibleKnows }, call, library.nextNumber), { dialogueId: dialogue.id, batchId: batch.id, sourceIds: ['source-1'] });
  }
  return { library: reviewed(library, evidence), evidence, batch };
}

const context = (evidence: CommandContext['evidence']): CommandContext => ({ evidence, maxTurns: 6, via: 'pi-confirm', at: '2026-09-24T11:00:00.000Z' });
const plausibleOf = (card: Card) => card.client.knows.filter(fact => fact.source.kind === 'plausible');

test('a proposal binds its plausible facts after the logged ones: named on request, vouched by no message; the card\'s id digests the source and the answer', () => {
  const { library } = plausibleDraft();
  const late = library.cards[0]!;
  assert.deepEqual(late.client.knows.map(fact => [fact.id, fact.label, fact.disclosure, fact.source.kind]),
    [['f1', 'Номер терминала', 'on_request', 'dialogue'], ['f2', 'Тип оборудования', 'on_request', 'plausible']]);
  const dialogue = importBatch(dialogues).dialogues[0]!;
  const call = proposalCall({ source: { kind: 'dialogue', batchId: importBatch(dialogues).id, dialogueId: dialogue.id }, messages: loggedMessages(dialogue), sources: [{ id: 'source-1', name: 'Правила возвратов', content: policy }], maxTurns: 6 });
  assert.equal(bindProposal(proposals.late, call, 1).id, `card_${fingerprint({ source: call.source, proposal: proposals.late })}`,
    'the whole answer: a card is bound once and keeps its id, so nothing derives it again and no older answer needs to read the same');
  assert.equal(cardProposalProblem({ ...proposals.late, plausibleKnows: [EQUIPMENT] }, call), undefined, 'a quality from a small closed set binds');
});

test('a plausible fact with a number, a code or a long text is refused with the exact reason, and so is a brief of more than eight facts', () => {
  const dialogue = importBatch(dialogues).dialogues[0]!;
  const call = proposalCall({ source: { kind: 'dialogue', batchId: importBatch(dialogues).id, dialogueId: dialogue.id }, messages: loggedMessages(dialogue), sources: [{ id: 'source-1', name: 'Правила возвратов', content: policy }], maxTurns: 6 });
  const refused = (value: string) => cardProposalProblem({ ...proposals.late, plausibleKnows: [{ label: 'Номер договора', value, askedAs: null }] }, call);
  const reason = 'plausibleKnows[0] "Номер договора": the value "Д-20931" is a number, a code or a long text.';
  assert.ok(refused('Д-20931')?.startsWith(reason), refused('Д-20931'));
  assert.match(refused('１２３')!, /is a number, a code or a long text/, 'a full-width digit is a digit after the one normalisation');
  assert.match(refused('терминал стоит в магазине у кассы слева')!, /is a number, a code or a long text/);
  const many = Array.from({ length: 4 }, (_, index) => ({ label: `Факт ${'абвг'[index]}`, value: true, askedAs: null }));
  const crowded = { ...proposals.late, knows: Array.from({ length: 5 }, () => proposals.late.knows[0]!), plausibleKnows: many } satisfies DialogueProposal;
  assert.match(cardProposalProblem(crowded, call)!, /knows and plausibleKnows hold 9 facts together; at most 8/);
});

test('undecided plausible facts are «? правдоподобно» and ask one question per label across the draft; the inbox holds it once', () => {
  const { library, evidence } = plausibleDraft();
  const statuses = cardStatuses({ library, evidence, maxTurns: 6 });
  const [late, known] = library.cards.map(card => statuses.get(card.id)!);
  assert.equal(late!.status, 'needs_owner');
  assert.equal(known!.status, 'needs_owner');
  assert.equal(late!.question!.id, known!.question!.id, 'one label, one question');
  assert.match(late!.question!.text, /^Клиенты знают «Тип оборудования» \(POS-терминал\), если агент спросит\? В логах этого нет/);
  assert.deepEqual(late!.question!.choices.map(choice => choice.label), ['Да, скажут, если спросят', 'Нет, не знают']);
  const record = cardRun([], [], 1, { librarySnapshot: library, phase: 'review' });
  const views = situationViews(record, { evidence, maxTurns: 6 });
  assert.match(plainSituationText(briefRows(views[0]!), 100), /Тип оборудования: POS-терминал — \? правдоподобно/);
  assert.ok(!plainSituationText(briefRows(views[0]!), 100).includes('POS-терминал — если спросят'), 'never shown as a fact of the log');
  const asked = decisions({ draft: { record, views, pendingCalls: 0 } }).filter(item => item.key.startsWith('question:'));
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.subject, 'Ситуации 1, 2');
});

test('one answer decides the label on every card: one receipt, a new revision, the facts kept and vouched — or removed', () => {
  const { library, evidence } = plausibleDraft();
  const question = cardStatuses({ library, evidence, maxTurns: 6 }).get(library.cards[1]!.id)!.question!;
  const answer = (choice: 'a' | 'b') => {
    const prepared = prepareCommand(library, { kind: 'answer_question', cardId: library.cards[1]!.id, questionId: question.id, choice }, context(evidence));
    return { prepared, next: applyCommand(library, prepared, hostGrant(prepared, 'confirmed')) };
  };
  const kept = answer('a');
  assert.equal(kept.next.revision, library.revision + 1);
  assert.equal(kept.next.receipts.length, library.receipts.length + 1, 'one receipt for the whole label');
  const receipt = kept.next.receipts.at(-1)!;
  assert.equal(receipt.command.kind, 'decide_plausible');
  assert.deepEqual(kept.prepared.scope, library.cards.map(card => card.id));
  assert.deepEqual(kept.next.cards.map(card => plausibleOf(card).map(fact => fact.source)), [[{ kind: 'plausible', receiptId: receipt.id }], [{ kind: 'plausible', receiptId: receipt.id }]]);
  assert.deepEqual(kept.prepared.recheck, [], 'the owner\'s word changes nothing the reviewer checked');
  assert.deepEqual([...cardStatuses({ library: kept.next, evidence, maxTurns: 6 }).values()].map(status => status.status), ['ready', 'ready']);
  const views = situationViews(cardRun([], [], 1, { librarySnapshot: kept.next, phase: 'review' }), { evidence, maxTurns: 6 });
  assert.match(plainSituationText(briefRows(views[0]!), 100), /Тип оборудования: POS-терминал — правдоподобно, если спросят/);

  const removed = answer('b').next;
  assert.deepEqual(removed.cards.map(card => plausibleOf(card).length), [0, 0], 'the customer then says «не знаю»');
  assert.deepEqual(removed.cards.map(card => card.revision), [2, 2]);

  // A decision on facts the draft no longer holds as listed is stale: the owner is shown what is there now.
  const stale = { kind: 'decide_plausible' as const, label: EQUIPMENT.label, known: true, facts: [{ cardId: library.cards[0]!.id, factId: 'f2' }] };
  assert.throws(() => prepareCommand(library, stale, context(evidence)), /уже изменились/);
});

test('a confirmed plausible fact is answered by the controlled customer, not «не знаю»; an undecided one is not known', () => {
  const card = briefCard({ turn: null });
  const plausible = (receiptId?: string): Card => cardSchema.parse({ ...card, client: { ...card.client, knows: [...card.client.knows,
    { id: 'f5', label: 'Тип оборудования', value: 'POS-терминал', disclosure: 'on_request', askedAs: 'какой у клиента терминал', source: { kind: 'plausible', ...(receiptId ? { receiptId } : {}) } }] } });
  assert.ok(!compilePolicy(plausible()).policy.actions.some(action => action.factIds.includes('f5')), 'before the owner decides, the customer does not know it');
  const { policy, facts } = compilePolicy(plausible('owner_equipment'));
  let state = createUserState(policy, facts);
  assert.ok(allowedUserActions(state, 'Какой у вас терминал?').some(action => action.id === 'tell_f5'));
  const moved = advanceUser(state, { actionId: 'tell_f5' });
  assert.equal(moved.message, 'Тип оборудования: POS-терминал');
  state = moved.state;
  assert.equal(advanceUser(state, { actionId: 'leave' }).done, true);
});

test('a card of a long logged conversation lets the customer talk as long, within the run\'s messages; a short one keeps its own need', () => {
  const event = (eventIndex: number) => ({ batchId: 'batch_1', dialogueId: 'late', eventIndex });
  const card = briefCard({ turn: null });
  // Six customer messages: the opening and five later ones, each accounted for.
  const long = cardSchema.parse({ ...card, client: { ...card.client, knows: [card.client.knows[1]!] },
    coverage: [{ event: event(2), as: 'fact' }, ...[4, 6, 8, 10].map(index => ({ event: event(index), as: 'ignored', reason: 'уточнение' }))] });
  assert.equal(compilePolicy(long, 16).policy.maxFollowUps, 7, 'five later messages plus two');
  assert.equal(compilePolicy(long, 6).policy.maxFollowUps, 5, 'bounded by the run\'s messages');
  assert.equal(compileCard(long, { requirements, maxTurns: 16 }).user.maxFollowUps, 7);
  assert.equal(compilePolicy(card, 16).policy.maxFollowUps, 6, 'a short conversation keeps the brief\'s own need: four facts and two to spare');
});

/** A conversation of the compiled brief card whose controlled customer made these moves. */
function movedAttempt(id: string, scenario: ReturnType<typeof compileCard>, moves: string[], results: Record<string, 'pass' | 'fail'>): Trial {
  const attempt = cardAttempt(id, scenario, results);
  const controller = moves.map((actionId, index) => ({ seq: 2 + index, type: 'simulator' as const,
    result: { protocol: USER_CONTROLLER_PROTOCOL, decision: { actionId }, accepted: true, from: 'talk', to: actionId === 'leave' ? 'done' : 'talk' } }));
  return { ...attempt, events: [...attempt.events.slice(0, 2), ...controller] };
}

test('the result says how often the customer could not answer and marks the failed situation «не знаю» may have blocked; older records say nothing', () => {
  const first = compileCard(briefCard({ turn: null }), { requirements });
  const second = { ...first, id: 'card_second', familyId: 'card_second', title: 'Возврат — номер назван' };
  const trials = [
    movedAttempt('t1', first, ['dunno_other', 'leave'], { e1: 'fail', e2: 'pass', e3: 'pass' }),
    movedAttempt('t2', second, ['tell_f2', 'tell_f3', 'dunno_f4', 'leave'], { e1: 'pass', e2: 'pass', e3: 'pass' }),
  ];
  const record = cardRun([first, second], trials);
  const moves = customerMoves(deriveRun(record));
  assert.deepEqual(moves, { answer: 2, missing: 2, turn: 0, finish: 2, other: 0, blocked: [first.id] }, 'a passed situation is never marked');
  assert.equal(dunnoThenLeft(['missing', 'answer', 'finish']), true);
  assert.equal(dunnoThenLeft(['answer', 'finish']), false);
  const view = buildResultView(record);
  assert.ok(trustParts(view).includes('клиент не знал ответа на 50% вопросов агента'), trustParts(view).join(' · '));
  assert.ok(errorListRows(view).some(row => row.text === DUNNO_MARK));
  assert.ok(htmlReport(record).includes('мог помешать'));

  // A run whose conversations recorded no controlled move (an older record) shows neither the share nor the mark.
  const older = cardRun([first], [cardAttempt('t1', first, { e1: 'fail', e2: 'pass', e3: 'pass' })]);
  const plain = buildResultView(older);
  assert.equal(plain.customer, undefined);
  assert.ok(!trustParts(plain).some(part => part.includes('не знал ответа')));
  assert.ok(!errorListRows(plain).some(row => row.text === DUNNO_MARK));
});

test('a card whose customer holds a confirmed plausible fact is no longer the logged customer: the agreement leaves it out as edited', () => {
  const { library, evidence } = plausibleDraft();
  const question = cardStatuses({ library, evidence, maxTurns: 6 }).get(library.cards[0]!.id)!.question!;
  const decide = (choice: 'a' | 'b'): LibraryV2 => {
    const prepared = prepareCommand(library, { kind: 'answer_question', cardId: library.cards[0]!.id, questionId: question.id, choice }, context(evidence));
    return applyCommand(library, prepared, hostGrant(prepared, 'confirmed'));
  };
  assert.deepEqual(decide('a').cards.map(cardExclusion), ['situation_edited', 'situation_edited']);
  assert.deepEqual(decide('b').cards.map(cardExclusion), [undefined, undefined], 'removed, the customer is the logged one again');
});

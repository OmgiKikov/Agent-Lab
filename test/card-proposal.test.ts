import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { cardFindings, contains, loggedMessages, normalizeText, unusableFindings, type CardEvidence } from '../src/card/checks.js';
import { bindProposal, cardProposalProblem, cardProposalSchema, citationId, proposalCall, proposalPayload, proposalRequirements, type DialogueProposal, type ProposalCall } from '../src/card/proposal.js';
import { cardSchema, type Card } from '../src/card/schema.js';
import { importBatch } from '../src/scenario-library.js';
import { strictSchemaProblems } from './helpers/strict-schema.js';
import { dialogues, policy, proposals, refundBasis, refundRule, rulesProposal } from './helpers/card-prep.js';

/*
 * C7: the model proposes a card through a schema built for the one call, the harness binds it — the opening and
 * the turn word for word, ids and sources its own — and deterministic checks without regular expressions hold every
 * reference and value to what it promises.
 */

const batch = importBatch([...dialogues, { id: 'greeting', messages: [
  { role: 'user', content: 'Здравствуйте' },
  { role: 'assistant', content: 'Здравствуйте! Чем помочь?' },
  { role: 'user', content: 'Хочу вернуть оплату, но номер терминала не помню.' },
  { role: 'assistant', content: 'Назовите номер терминала.' },
  { role: 'user', content: 'Не знаю его. А можно просто отменить покупку?' },
] }]);
const rule = { ...refundRule, sourceId: 'source-1' };
const materials = [{ id: 'source-1', name: 'Правила возвратов', content: policy }];
const callFor = (dialogueId: string, maxTurns = 6): ProposalCall => proposalCall({ source: { kind: 'dialogue', batchId: batch.id, dialogueId },
  messages: loggedMessages(batch.dialogues.find(dialogue => dialogue.id === dialogueId)!), sources: materials, maxTurns });
const evidence = (call: ProposalCall): CardEvidence => ({ messages: (batchId, dialogueId) => call.source.kind === 'dialogue' && batchId === call.source.batchId && dialogueId === call.source.dialogueId ? call.messages : undefined });
const late = callFor('late');
const with_ = (change: (proposal: DialogueProposal) => void): DialogueProposal => {
  const proposal = structuredClone(proposals.late);
  change(proposal);
  return proposal;
};

test('the answer\'s schema is built for the call: a message, rule or channel outside it is refused, and the account takes exactly the later messages', () => {
  assert.deepEqual([late.customerEvents, late.laterEvents], [[0, 2, 4], [2, 4]]);
  const schema = cardProposalSchema(late);
  assert.equal(schema.safeParse(proposals.late).success, true);
  const refused = (change: (proposal: DialogueProposal & Record<string, unknown>) => void) => !schema.safeParse(with_(change as (proposal: DialogueProposal) => void)).success;
  assert.ok(refused(proposal => { proposal.writesEvent = 1; }), 'the agent\'s message is not an opening');
  assert.ok(refused(proposal => { proposal.knows[0]!.from = 3; }), 'a fact comes from a customer message');
  assert.ok(refused(proposal => { proposal.knows[0]!.from = 7; }), 'no such message');
  assert.ok(refused(proposal => { proposal.agentMust[0]!.basis = [{ ...refundBasis[0]!, sourceId: 'invented_source' }]; }), 'a source outside the call');
  assert.ok(refused(proposal => { proposal.agentMust[0]!.basis = []; }), 'a duty rests on at least one sentence');
  assert.ok(refused(proposal => { proposal.agentMust[0]!.observation = 'tool' as 'reply'; }), 'a channel the connection did not confirm');
  assert.ok(refused(proposal => { delete proposal.coverage['4']; }), 'a later message left out of the account');
  assert.ok(refused(proposal => { proposal.coverage['0'] = { as: 'ignored', reason: 'приветствие' }; }), 'the first message is not a later one');
  assert.ok(refused(proposal => { proposal.turn = { kind: 'report', after: 'агент ответил', from: 0 }; }), 'a turn comes after the first message');
  assert.ok(refused(proposal => { proposal.id = 'card_1'; }), 'the harness gives the ids');
  assert.deepEqual(strictSchemaProblems(schema), [], 'the schema is ready for a provider\'s strict structured output');
  const json = JSON.stringify(z.toJSONSchema(schema));
  assert.match(json, /"writesEvent":\{"type":"number","enum":\[0,2,4\]\}/);
  assert.match(json, /"sourceId":\{"type":"string","enum":\["source-1"\]\}/);
  assert.match(json, /"coverage":\{"type":"object","properties":\{"2":.*"required":\["2","4"\],"additionalProperties":false/);
  const single = callFor('known');
  assert.deepEqual(z.toJSONSchema(cardProposalSchema(single)).properties?.turn, { type: 'null' }, 'one customer message: no turn to point at');
  const rules = proposalCall({ source: { kind: 'rules', unit: 'rules_1' }, messages: [], sources: materials, maxTurns: 6 });
  const shape = Object.keys((z.toJSONSchema(cardProposalSchema(rules)) as { properties: object }).properties);
  assert.deepEqual(shape, ['title', 'topic', 'wants', 'writes', 'leaves', 'agentMust'], 'from the rules alone: the model writes the opening; no facts, turn or account');
});

test('binding copies the opening and the turn word for word, and gives ids, the number and every source', () => {
  const card = bindProposal(proposals.late, late, 7);
  const event = (eventIndex: number) => ({ batchId: batch.id, dialogueId: 'late', eventIndex });
  assert.equal(card.number, 7);
  assert.match(card.id, /^card_[a-f0-9]{64}$/);
  assert.equal(bindProposal(proposals.late, late, 7).id, card.id, 'the id is the digest of the source and the proposal');
  assert.notEqual(bindProposal(proposals.late, { ...late, source: { ...late.source, dialogueId: 'other' } as ProposalCall['source'] }, 7).id, card.id);
  assert.deepEqual(card.origin, { kind: 'dialogue', batchId: batch.id, dialogueId: 'late' });
  assert.equal(card.client.writes, 'Помогите с возвратом.');
  assert.deepEqual(card.client.writesSource, { kind: 'dialogue', event: event(0) });
  assert.deepEqual(card.client.knows, [{ id: 'f1', label: 'Номер терминала', value: '5678', disclosure: 'on_request', askedAs: 'номер терминала', source: { kind: 'dialogue', event: event(2) } }]);
  assert.deepEqual(card.agentMust.map(item => [item.id, item.appliesWhen]), [['e1', undefined], ['e2', 'клиент назвал номер терминала']], 'null stays out of the card');
  assert.deepEqual(card.coverage, [{ event: event(2), as: 'fact' }, { event: event(4), as: 'stop' }]);
  assert.deepEqual(cardSchema.parse(structuredClone(card)), card, 'a bound card is a stored card as it stands');

  // A bare greeting first: the later message with the request is the opening, and the last question is the turn.
  const greeting = callFor('greeting');
  const proposal: DialogueProposal = { title: 'Возврат без номера — клиент меняет решение', topic: 'Возврат оплаты', wants: 'Вернуть оплату', clarity: 'clear', writesEvent: 2,
    knows: [{ label: 'Номер терминала', value: null, disclosure: 'unknown', from: 4, askedAs: 'номер терминала' }, { label: 'Покупка оплачена картой', value: true, disclosure: 'on_request', from: null, askedAs: null }], plausibleKnows: [],
    leaves: 'получил ответ про отмену покупки', turn: { kind: 'change_intent', after: 'агент попросил номер терминала', from: 4 },
    agentMust: [{ text: 'объяснить, как оформить возврат', basis: refundBasis, appliesWhen: null, observation: 'reply' }],
    coverage: { 2: { as: 'ignored', reason: 'это первая реплика' }, 4: { as: 'turn', reason: null } } };
  assert.equal(cardProposalProblem(proposal, greeting), undefined);
  const turned = bindProposal(proposal, greeting, 1);
  assert.equal(turned.client.writes, 'Хочу вернуть оплату, но номер терминала не помню.');
  assert.deepEqual(turned.client.turn, { kind: 'change_intent', after: 'агент попросил номер терминала', says: 'Не знаю его. А можно просто отменить покупку?',
    source: { kind: 'dialogue', event: { batchId: batch.id, dialogueId: 'greeting', eventIndex: 4 } } });
  assert.deepEqual(turned.client.knows[1]!.source, { kind: 'unconfirmed' }, 'a fact no message states waits for the owner');
  assert.deepEqual(turned.coverage.map(entry => [entry.event.eventIndex, entry.as]), [[4, 'turn']], 'the opening is not accounted for twice');

  const rules = proposalCall({ source: { kind: 'rules', unit: 'rules_1' }, messages: [], sources: materials, maxTurns: 6 });
  const fromRules = bindProposal(rulesProposal(1), rules, 2);
  assert.deepEqual([fromRules.origin, fromRules.client.writesSource, fromRules.client.knows, fromRules.coverage],
    [{ kind: 'rules', requirementIds: [refundRule.id] }, { kind: 'model' }, [], []]);
});

/** A bound card with one change, checked against the dialogue it came from. */
function checked(change: (card: Card) => void, maxTurns = 6) {
  const card = structuredClone(bindProposal(proposals.late, late, 1));
  change(card);
  return cardFindings(card, { evidence: evidence(late), maxTurns, materials: { requirements: [rule], sources: [{ id: 'source-1', content: `${refundRule.quote} Иначе уточните номер.` }] } });
}

test('the deterministic checks, one rule each: a reference or a value that does not hold is found, a clean card has nothing', () => {
  assert.deepEqual(checked(() => {}), []);
  assert.deepEqual(checked(card => { card.client.knows[0]!.value = '5679'; }), [{ check: 'fact-from-event', factId: 'f1' }]);
  assert.deepEqual(checked(card => { card.client.knows[0]!.disclosure = 'initial'; }), [{ check: 'initial-in-opening', factId: 'f1' }]);
  assert.deepEqual(checked(card => { card.client.knows[0]!.source = { kind: 'unconfirmed' }; card.client.knows[0]!.disclosure = 'initial'; }),
    [{ check: 'initial-in-opening', factId: 'f1' }, { check: 'coverage-refs', eventIndex: 2, problem: 'no_fact' }]);
  assert.deepEqual(checked(card => { card.client.writes = 'Помогите с возвратом, терминал 5678.'; }), [{ check: 'hidden-not-in-opening', factId: 'f1' }]);
  assert.deepEqual(checked(card => { card.client.knows[0]!.disclosure = 'unknown'; card.client.leaves = 'ушёл, так и не назвав 5678'; }),
    [{ check: 'unknown-never-said', factId: 'f1', where: 'leaves' }]);
  assert.deepEqual(checked(card => { card.coverage[1]!.as = 'fact'; }), [{ check: 'coverage-refs', eventIndex: 4, problem: 'no_fact' }]);
  assert.deepEqual(checked(card => { card.coverage[1]!.as = 'turn'; }), [{ check: 'coverage-refs', eventIndex: 4, problem: 'no_turn' }]);
  assert.deepEqual(checked(card => { card.coverage[0] = { ...card.coverage[0]!, as: 'ignored', reason: 'повтор' }; }), [{ check: 'coverage-refs', eventIndex: 2, problem: 'ignored_source' }]);
  assert.deepEqual(checked(card => { card.coverage.push({ event: { ...card.coverage[1]!.event, eventIndex: 6 }, as: 'stop' }); }), [{ check: 'coverage-refs', eventIndex: 6, problem: 'second_stop' }]);
  assert.deepEqual(checked(card => { card.client.turn = { kind: 'report', after: 'агент ответил', says: 'Спасибо!', source: { kind: 'dialogue', event: card.coverage[1]!.event } }; }),
    [{ check: 'coverage-refs', eventIndex: 4, problem: 'turn_uncovered' }]);
  assert.deepEqual(checked(card => { card.agentMust[0]!.requirementIds = ['missing_rule']; }), [{ check: 'requirements-grounded', requirementId: 'missing_rule' }]);
  const turn = (card: Card) => { card.client.turn = { kind: 'change_intent', after: 'агент объяснил возврат', says: 'Спасибо!', source: { kind: 'dialogue', event: card.coverage[1]!.event } }; card.coverage[1]!.as = 'turn'; };
  assert.deepEqual(checked(turn, 6), [], 'a change of intent fits a run of six messages');
  assert.deepEqual(checked(turn, 1), [{ check: 'controller-compiles', needed: 2 }], 'the opening and the turn need two messages');
  const card = structuredClone(bindProposal(proposals.late, late, 1));
  card.coverage[1]!.as = 'turn';
  assert.deepEqual(unusableFindings(card, { evidence: evidence(late), maxTurns: 6 }), [], 'a slip in the account is repaired while writing, never an unusable card');
});

test('a proposal that does not bind is answered with every reason, in the words of the proposal', () => {
  assert.equal(cardProposalProblem(proposals.late, late), undefined);
  const problem = cardProposalProblem(with_(proposal => { proposal.knows[0]!.value = '5679'; proposal.coverage['4'] = { as: 'ignored', reason: null }; }), late);
  assert.equal(problem, 'coverage["4"] is "ignored": give a short reason.', 'what the binding itself cannot hold comes first');
  const reasons = cardProposalProblem(with_(proposal => { proposal.knows[0]!.value = '5679'; proposal.coverage['2'] = { as: 'turn', reason: null }; }), late)!;
  assert.match(reasons, /knows\[0\] "Номер терминала": the value "5679" is not in customer message 2\./);
  assert.match(reasons, /coverage\["2"\] is "turn", but "turn\.from" is not 2\./);
  assert.match(cardProposalProblem(with_(proposal => { proposal.knows[0]!.disclosure = 'initial'; }), late)!, /knows\[0\] "Номер терминала" is "initial", so it is said in the opening: its "from" must be writesEvent 0/);
  const long = importBatch([{ id: 'long', messages: [{ role: 'user', content: 'Очень длинно. '.repeat(250) }, { role: 'assistant', content: 'Слушаю.' }] }]);
  const call = proposalCall({ source: { kind: 'dialogue', batchId: long.id, dialogueId: 'long' }, messages: loggedMessages(long.dialogues[0]!), sources: materials, maxTurns: 6 });
  assert.match(cardProposalProblem({ ...proposals.known, knows: [] }, call)!, /longer than 3000 characters and cannot be the opening/);
});

// The agent's prompt and an article of its knowledge base, as a proposal reads them.
const prompt = { id: 'source-1', name: 'reply_prompt', kind: 'prompt' as const, content: 'Ты вежливый ассистент банка.\nНе обещай перезвонить, если можешь ответить сразу.\nОтвечай на «вы».' };
const article = { id: 'source-2', name: 'Возвраты', content: `${policy}\nОператор проверяет платёж в АБС и переводит звонок на отдел возвратов.` };
const cited = (quote: string, sourceId = 'source-1', kind: 'behavior' | 'knowledge' | 'operator_procedure' = 'behavior') => ({ sourceId, quote, rule: 'Правило ответа.', kind });
const citing = (...basis: ReturnType<typeof cited>[]): DialogueProposal => ({ ...structuredClone(proposals.late), agentMust: [{ text: 'ответить сразу, не обещая перезвонить', basis, appliesWhen: null, observation: 'reply' }] });
const direct = (binds?: ProposalCall['binds']) => proposalCall({ source: late.source, messages: late.messages, sources: [prompt, article], maxTurns: 6, ...(binds ? { binds } : {}) });

test('a duty cites the agent\'s prompt and an article directly: each sentence becomes a rule of its own source, verbatim', () => {
  const call = direct();
  const proposal = citing(cited('Не обещай перезвонить, если можешь ответить сразу.'), cited(refundRule.quote, 'source-2', 'knowledge'));
  assert.equal(cardProposalProblem(proposal, call), undefined);
  const payload = proposalPayload({ task: 'Возвраты', call, topics: [], written: [] });
  assert.deepEqual(payload.sources.map(source => source.name), ['reply_prompt (промпт агента)', 'Возвраты'], 'the prompt is named as the agent\'s own');
  assert.deepEqual(payload.rulebook, { binds: ['behavior', 'knowledge'] });
  assert.equal('requirements' in payload, false, 'no rules are written out before the proposal');
  const rules = proposalRequirements(proposal, call);
  assert.deepEqual(rules.map(({ sourceId, quote, kind, observable }) => ({ sourceId, quote, kind, observable })), [
    { sourceId: 'source-1', quote: 'Не обещай перезвонить, если можешь ответить сразу.', kind: 'behavior', observable: true },
    { sourceId: 'source-2', quote: refundRule.quote, kind: 'knowledge', observable: true }]);
  assert.deepEqual(bindProposal(proposal, call, 1).agentMust[0]!.requirementIds, rules.map(item => item.id));
  // A model normalises typography and may name the wrong source: the stored quote is the source's own characters, in the source that holds it.
  const loose = proposalRequirements(citing(cited('Отвечай на "вы".', 'source-2')), call);
  assert.deepEqual(loose.map(({ sourceId, quote }) => [sourceId, quote]), [['source-1', 'Отвечай на «вы».']]);
});

test('two cards citing one sentence share one rule: its id is the digest of the source and the sentence', () => {
  const call = direct();
  const first = proposalRequirements(citing(cited('Отвечай на «вы».')), call);
  const second = proposalRequirements({ ...citing(cited('Отвечай на "вы".')), title: 'Другая ситуация' }, call);
  assert.equal(first[0]!.id, second[0]!.id);
  assert.equal(first[0]!.id, citationId('source-1', 'Отвечай на «вы».'));
  assert.notEqual(citationId('source-2', 'Отвечай на «вы».'), first[0]!.id, 'the same words in another source are another rule');
  const twice = proposalRequirements({ ...citing(cited('Отвечай на «вы».')), agentMust: [...citing(cited('Отвечай на «вы».')).agentMust, ...citing(cited('Отвечай на «вы».')).agentMust] }, call);
  assert.equal(twice.length, 1, 'a card citing the sentence for two duties adds it once');
});

test('a quote that is not in its source is answered with the exact reason, and never binds', () => {
  const call = direct();
  const paraphrase = citing(cited('Не надо обещать перезвон, если ответ известен.'));
  assert.match(cardProposalProblem(paraphrase, call)!, /agentMust\[0\]\.basis\[0\]: the quote is not a verbatim substring of "reply_prompt"\. Copy the exact characters/);
  assert.throws(() => bindProposal(paraphrase, call, 1), /не найдено дословно/);
});

test('a kind of rule outside the owner\'s rulebook cannot back a duty, unless the owner included that very rule', () => {
  const procedure = citing(cited('Оператор проверяет платёж в АБС и переводит звонок на отдел возвратов.', 'source-2', 'operator_procedure'));
  assert.match(cardProposalProblem(procedure, direct())!, /agentMust\[0\]\.basis\[0\] is a rule of kind operator_procedure, and the owner's rulebook binds the agent only by behavior, knowledge: cite a rule of those kinds, or drop this duty\./);
  const included = { kinds: ['behavior', 'knowledge'] as ('behavior' | 'knowledge')[], rules: [{ sourceId: 'source-2', quote: 'Оператор проверяет платёж в АБС и переводит звонок на отдел возвратов.' }] };
  assert.equal(cardProposalProblem(procedure, direct(included)), undefined, 'a rule the owner included binds whatever its kind');
  assert.equal(cardProposalProblem(procedure, direct({ kinds: ['behavior', 'knowledge', 'operator_procedure'], rules: [] })), undefined, 'operator instructions bind when the owner says so');
});

test('text is compared exactly, after NFKC, case and spacing: no tokenizer, no fuzzy match', () => {
  assert.equal(normalizeText('  Номер  терминала:\n5678 '), 'номер терминала: 5678');
  assert.equal(normalizeText('ＡＢＣ ５６７８'), 'abc 5678', 'compatibility characters fold');
  assert.ok(contains('Номер  терминала: 5678.', 5678));
  assert.ok(contains('НОМЕР ТЕРМИНАЛА', 'номер терминала'));
  assert.ok(!contains('Номер 56 78', '5678'), 'digits split by a space are another value');
  assert.ok(!contains('Ёлка', 'елка'), 'no letter is folded into another');
  assert.ok(!contains('Номер терминала', 'Номер терминала: 5678'));
});

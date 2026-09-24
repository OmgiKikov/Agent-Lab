import test from 'node:test';
import assert from 'node:assert/strict';
import { compileCard, compilePolicy } from '../src/card/compile.js';
import { fingerprint, targetSchema } from '../src/contracts.js';
import { advanceUser, allowedUserActions, createUserState } from '../src/user-controller.js';
import { briefCard, requirements } from './helpers/cards.js';

/*
 * The stand's test customer: a bank agent identifies its customer first (terminal, shop, INN). Without a profile the
 * simulated customer can only say «не знаю» and the conversation fails on the stand; with one, every customer names
 * what any real customer knows about their own account, and a card compiled without it stays byte for byte as it was.
 */

const profile = [
  { label: 'Номер терминала', value: '40000001', askedAs: 'номер терминала' },
  { label: 'Торговая точка', value: 'Магазин «Пример», ул. Тестовая' },
  { label: 'ИНН', value: '0000000000' },
];

test('a profile fact is told when the agent asks for it, after the card’s own facts', () => {
  const card = briefCard({ turn: null });
  const withoutTerminal = { ...card, client: { ...card.client, knows: card.client.knows.filter(fact => fact.id !== 'f2') } };
  const { policy, facts } = compilePolicy(withoutTerminal, undefined, profile);
  assert.deepEqual(facts.filter(fact => fact.id.startsWith('p')).map(fact => fact.statement),
    ['Номер терминала: 40000001', 'Торговая точка: Магазин «Пример», ул. Тестовая', 'ИНН: 0000000000']);
  const tell = policy.actions.find(action => action.id === 'tell_p1');
  assert.deepEqual(tell, { id: 'tell_p1', kind: 'answer', factIds: ['p1'], ifAsked: 'номер терминала' });
  const state = createUserState(policy, facts);
  assert.ok(allowedUserActions(state, '').some(action => action.id === 'tell_p1'));
  assert.equal(advanceUser(state, { actionId: 'tell_p1' }).message, 'Номер терминала: 40000001');
});

test('a label the card already holds stays the card’s: the logged value wins over the profile', () => {
  const { facts } = compilePolicy(briefCard({ turn: null }), undefined, profile);
  assert.deepEqual(facts.filter(fact => fact.statement.startsWith('Номер терминала')).map(fact => fact.statement), ['Номер терминала: 5678']);
});

test('with a profile the customer may leave when the agent hands the question to an operator', () => {
  const { policy } = compilePolicy(briefCard({ turn: null }), undefined, profile);
  const leave = policy.transitions.find(transition => transition.actionId === 'leave');
  assert.match(leave!.when, /передаёт вопрос оператору/);
});

test('without a profile a card compiles exactly as before, so sealed definitions keep their hashes', () => {
  const card = briefCard();
  assert.equal(fingerprint(compileCard(card, { requirements })), fingerprint(compileCard(card, { requirements, profile: [] })));
  assert.notEqual(fingerprint(compileCard(card, { requirements })), fingerprint(compileCard(card, { requirements, profile })));
});

test('the connection carries the profile, and an old connection without it still parses', () => {
  const command = { kind: 'command', command: '/usr/bin/python3', args: ['agent.py'] };
  assert.equal(targetSchema.parse(command).kind, 'command');
  const parsed = targetSchema.parse({ ...command, customerProfile: profile });
  assert.equal(parsed.kind === 'command' && parsed.customerProfile?.length, 3);
  assert.throws(() => targetSchema.parse({ ...command, customerProfile: [{ label: 'x' }] }));
});

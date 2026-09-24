import test from 'node:test';
import assert from 'node:assert/strict';
import { customerBrief, customerReplyProblem, deliveredMessage, type CustomerBrief } from '../src/card-customer.js';
import { compileCard } from '../src/card/compile.js';
import { briefCard, requirements } from './helpers/cards.js';

/*
 * The card's customer speaks in their own words; the harness checks every message before the agent sees it:
 * no value the customer does not know, no leaving before a required turn, the turn in the card's words.
 */

const brief = (): CustomerBrief => {
  const scenario = compileCard(briefCard(), { requirements, profile: [{ label: 'ИНН', value: '0000000000' }] });
  return customerBrief(scenario.execution!.userView);
};

test('the brief is the card: goal, opening, known facts with the profile, unknowns, the turn and when to leave', () => {
  const note = brief();
  assert.equal(note.opening, 'Помогите с возвратом, я Анна.');
  assert.ok(note.knows.includes('Номер терминала: 5678'));
  assert.ok(note.knows.includes('ИНН: 0000000000'));
  assert.deepEqual(note.doesNotKnow, ['Дата покупки']);
  assert.deepEqual(note.turn, { when: 'агент объяснил, как оформить возврат', says: 'Тогда лучше отмените покупку.', required: true });
  assert.match(note.leaves, /получил инструкцию/);
  assert.doesNotMatch(JSON.stringify(note), /12\.03\.2026/, 'an unknown value is not in the note');
});

test('a value the customer knows or heard passes; an invented one goes back to the model with the reason', () => {
  const note = brief();
  const said = [{ role: 'assistant' as const, content: 'Назовите номер заявки, например 777-12.' }];
  assert.equal(customerReplyProblem({ move: 'answer', message: 'терминал 5678' }, note, said, false), undefined);
  assert.equal(customerReplyProblem({ move: 'answer', message: 'заявка 777-12, кажется' }, note, said, false), undefined, 'what the agent said may be repeated');
  assert.match(customerReplyProblem({ move: 'answer', message: 'покупка была 12.03.2026' }, note, said, false)!, /"12\.03\.2026"/);
  assert.match(customerReplyProblem({ move: 'clarify', message: 'а если терминал 9999?' }, note, said, false)!, /"9999"/);
  assert.equal(customerReplyProblem({ move: 'clarify', message: 'Это не то, мне нужен возврат' }, note, said, false), undefined);
  assert.match(customerReplyProblem({ move: 'answer', message: '  ' }, note, said, false)!, /empty/);
});

test('a required turn comes before leaving, happens once, and is sent in the card’s words', () => {
  const note = brief();
  assert.match(customerReplyProblem({ move: 'leave', message: '' }, note, [], false)!, /cannot leave yet/);
  assert.equal(customerReplyProblem({ move: 'leave', message: '' }, note, [], true), undefined);
  assert.equal(customerReplyProblem({ move: 'turn', message: 'что угодно' }, note, [], false), undefined);
  assert.match(customerReplyProblem({ move: 'turn', message: '' }, note, [], true)!, /already happened/);
  assert.equal(deliveredMessage({ move: 'turn', message: 'что угодно' }, note), 'Тогда лучше отмените покупку.');
  assert.equal(deliveredMessage({ move: 'leave', message: 'пока' }, note), '');
});

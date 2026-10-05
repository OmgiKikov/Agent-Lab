"""A scenario is a test: the error of the real conversation it reproduces, and its own result in every run of its check
(docs/superpowers/specs/2026-10-03-scenario-cards-design.md)."""

import unittest

import support

from lab import cards, checks, store

FROM_LOG, COVERAGE = 'Ошибка из лога', 'Покрытие темы'
TERM = {'id': 't1r1', 'name': 'Называет срок', 'text': 'Агент называет срок доставки терминала', 'quote': 'Срок'}
HELP = {'id': 't1r2', 'name': '', 'text': 'Агент предлагает помощь в конце ответа', 'quote': 'Помощь'}
CRITERIA = [TERM, HELP]


def scenario(card_id: str, source: str, origin: str = FROM_LOG, **fields) -> dict:
    return {
        'id': card_id,
        'name': card_id,
        'topic': 'Терминалы',
        'topicId': 't1',
        'situation': 'Клиент ждёт терминал и не знает, когда его привезут.',
        'opening': 'Когда привезут терминал?',
        'criteria': CRITERIA,
        'origin': origin,
        'sourceDialogueId': source,
        'world': None,
        **fields,
    }


def row(rule_id: str, status: str, quote: str = '') -> dict:
    return {'ruleId': rule_id, 'rule': rule_id, 'status': status, 'reason': '', 'agentQuote': quote, 'title': ''}


def logged(dialogue_id: str, status: str, rows: list[dict]) -> dict:
    return {'dialogueId': dialogue_id, 'topicId': 't1', 'status': status, 'opening': 'Когда?', 'rules': rows}


def played(card_id: str, persona: str, status: str, failed: tuple[str, ...] = ()) -> dict:
    rows = [row(rule_id, 'FAIL', 'Привезём, жди.') for rule_id in failed] or [row('t1r1', 'PASS', 'Завтра.')]
    return {
        'cardId': card_id,
        'persona': persona,
        'attempt': 1,
        'name': card_id,
        'topic': 'Терминалы',
        'status': status,
        'criteria': CRITERIA,
        'conversation': [],
        'rules': rows if status in ('PASS', 'FAIL') else [],
    }


def run(run_id: str, started: str, items: list[dict], check: str = checks.CODE, label: str = '') -> None:
    record = {'id': run_id, 'label': label, 'startedAt': started, 'status': 'done', 'check': check, 'items': items}
    store.create_run(record)


class ScenariosTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        support.serve(self)

    async def scenarios(self) -> dict:
        response = await self.client.get('/api/scenarios')
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_a_scenario_shows_the_error_it_reproduces_and_its_result_in_each_run_of_its_check(self) -> None:
        store.save(
            checks.result(checks.CODE),
            {
                'results': [
                    logged('d1', 'FAIL', [row('t1r1', 'FAIL', 'Привезём, жди.'), row('t1r2', 'PASS', 'Помочь ещё?')]),
                    logged('d2', 'PASS', [row('t1r1', 'PASS', 'Завтра до 18:00.')]),
                ]
            },
        )
        deck = [scenario('error', 'd1', reproduces=['t1r1']), scenario('control', 'd2', COVERAGE, reproduces=[])]
        store.save(cards.DECK, {'check': checks.CODE, 'createdAt': '2026-10-01T09:00:00+00:00', 'cards': deck})
        older = [
            played('error', 'default', 'FAIL', failed=('t1r1', 't1r2')),
            played('control', 'default', 'UNMEASURED'),
            played('error', 'impatient', 'PASS'),
        ]
        run('older', '2026-10-01T10:00:00+00:00', older, label='До правки промпта')
        # A conversation still playing has no result yet; a run of the other check is counted by other criteria.
        newer = [played('error', 'default', 'PASS'), played('error', 'typos', 'RUNNING')]
        run('newer', '2026-10-02T10:00:00+00:00', newer)
        run('tone', '2026-10-03T10:00:00+00:00', [played('error', 'default', 'FAIL', ('t1r1',))], check=checks.TONE)
        found = await self.scenarios()
        self.assertEqual((found['check'], [card['id'] for card in found['cards']]), ('code', ['error', 'control']))
        error, control = found['cards']
        self.assertEqual(
            error['reproduces'],
            [{'ruleId': 't1r1', 'name': 'Называет срок', 'text': TERM['text'], 'agentQuote': 'Привезём, жди.'}],
        )
        self.assertEqual(
            [(at['run'], at['persona'], at['status'], at['index'], at['failed']) for at in error['history']],
            [
                ('newer', 'default', 'PASS', 0, []),
                (
                    'older',
                    'default',
                    'FAIL',
                    0,
                    # A criterion without a short name is named by what it requires.
                    [{'ruleId': 't1r1', 'name': 'Называет срок'}, {'ruleId': 't1r2', 'name': HELP['text']}],
                ),
                ('older', 'impatient', 'PASS', 2, []),
            ],
        )
        self.assertEqual(
            {key: error['history'][1][key] for key in ('label', 'startedAt', 'attempt')},
            {'label': 'До правки промпта', 'startedAt': '2026-10-01T10:00:00+00:00', 'attempt': 1},
        )
        self.assertEqual(error['sourceStatus'], 'FAIL')
        # A control: its real conversation had no error, so it reproduces none; it still has results of its own.
        self.assertEqual((control['reproduces'], control['sourceStatus']), ([], 'PASS'))
        self.assertEqual([(entry['run'], entry['status']) for entry in control['history']], [('older', 'UNMEASURED')])

    async def test_an_older_deck_reproduces_what_its_source_conversation_failed_in_the_current_result(self) -> None:
        store.save(
            checks.result(checks.TONE),
            {'results': [logged('d1', 'FAIL', [row('t1r1', 'PASS', 'Завтра.'), row('t1r2', 'FAIL', 'Всё.')])]},
        )
        deck = [
            scenario('old', 'd1'),  # built before cards named what they reproduce
            scenario('gone', 'd9'),  # its conversation is not in the current result
            scenario('control', 'd1', COVERAGE),  # a control reproduces no error, whatever its conversation has now
            scenario('kept', 'd1', reproduces=['t1r1']),  # the agent's words come only from a row that has the error
        ]
        store.save(cards.DECK, {'check': checks.TONE, 'cards': deck})
        found = {card['id']: card for card in (await self.scenarios())['cards']}
        self.assertEqual(
            found['old']['reproduces'],
            [{'ruleId': 't1r2', 'name': HELP['text'], 'text': HELP['text'], 'agentQuote': 'Всё.'}],
        )
        self.assertEqual((found['gone']['reproduces'], found['gone']['sourceStatus']), ([], None))
        self.assertEqual(found['control']['reproduces'], [])
        self.assertEqual(
            found['kept']['reproduces'],
            [{'ruleId': 't1r1', 'name': 'Называет срок', 'text': TERM['text'], 'agentQuote': ''}],
        )
        self.assertEqual([card['history'] for card in found.values()], [[]] * len(found))

    async def test_without_scenarios_there_is_nothing_to_show(self) -> None:
        self.assertEqual(await self.scenarios(), {'check': None, 'cards': []})


if __name__ == '__main__':
    unittest.main()

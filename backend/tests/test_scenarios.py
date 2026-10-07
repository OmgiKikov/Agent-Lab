"""A scenario is a test: its own result in every run of its check."""

import unittest

import support

from lab import storage
from lab.domain import checks

REPRESENTATIVE, STRESS = 'Представительный набор', 'Стрессовый набор'
TERM = {'id': 't1r1', 'name': 'Называет срок', 'text': 'Агент называет срок доставки терминала', 'quote': 'Срок'}
HELP = {'id': 't1r2', 'name': '', 'text': 'Агент предлагает помощь в конце ответа', 'quote': 'Помощь'}
CRITERIA = [TERM, HELP]


def scenario(card_id: str, source: str, origin: str = REPRESENTATIVE, **fields) -> dict:
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
    storage.runs.create(record)


class ScenariosTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        support.serve(self)

    async def scenarios(self) -> dict:
        response = await self.client.get('/api/scenarios')
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_a_scenario_shows_its_result_in_each_run_of_its_check(self) -> None:
        deck = [scenario('error', 'd1'), scenario('control', 'd2', STRESS)]
        storage.documents.save(
            checks.DECK, {'check': checks.CODE, 'createdAt': '2026-10-01T09:00:00+00:00', 'cards': deck}
        )
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
        self.assertEqual([(entry['run'], entry['status']) for entry in control['history']], [('older', 'UNMEASURED')])

    async def test_without_scenarios_there_is_nothing_to_show(self) -> None:
        self.assertEqual(await self.scenarios(), {'check': None, 'cards': []})


if __name__ == '__main__':
    unittest.main()

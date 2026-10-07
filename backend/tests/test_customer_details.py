"""What the synthetic customer can say of its organization: the client of the bank the agent sees in that very
conversation (the scenario's world, the stand's fixtures, the organization of an EPK on the IFT stand), as far as the
card says the customer knows it."""

import unittest
from unittest.mock import patch

import support

from lab import agents, storage
from lab.agents.http import HttpAgent, epk_of, prod_request
from lab.domain import world
from lab.flows import connection, simulation

# The stand's fixture answers, as agents.world.templates reads them: the client every test of the stand talks as.
FIXTURES = {
    'organizationInfoByEpkId': {
        'organizations': [
            {
                'inn': '7701234567',
                'contracts': [],
                'terminalList': [
                    {'tid': '12345678', 'stateCode': 'ACTIVE'},
                    {'tid': '87654321', 'stateCode': 'BLOCKED'},
                ],
            }
        ]
    },
    'organizationInfoByMidOrTid': {
        'organization': {'inn': '7701234567', 'kpp': '770101001', 'clientModuleId': '1', 'name': 'ООО «Ромашка»'}
    },
    'getLkkTerminalList': {
        'pagination': {'size': 10, 'page': 0, 'hasNext': False},
        'terminals': [
            {
                'address': 'г. Москва, ул. Тверская, д. 1',
                'nameForClient': f'Касса №{n}',
                'merchantId': '900000001',
                'terminalId': tid,
                'merchantName': 'Ромашка, Тверская',
            }
            for n, tid in ((1, '12345678'), (2, '87654321'))
        ],
    },
}
# The card says: the customer does not know its terminal numbers and would look its INN up.
UNSURE = {'terminal': {'value': 'unknown', 'basis': 'log'}, 'organization': {'value': 'looks_up', 'basis': 'log'}}
KNOWS = {'terminal': {'value': 'knows', 'basis': 'log'}, 'organization': {'value': 'knows', 'basis': 'log'}}
DESCRIBED = {'name': 'ООО «Тест»', 'inn': '7712345678', 'terminals': ['11112222']}


def scenario_world() -> dict:
    return {
        'organization': {'name': 'ООО «Кофе»', 'inn': '5012345678', 'merchantName': 'Кофе', 'address': 'Тула'},
        'terminals': [{'nameForClient': 'Касса', 'terminalId': '55556666', 'stateCode': 'ACTIVE'}],
        'tools': {},
    }


class BankOfTheConversationTests(unittest.TestCase):
    def test_without_a_world_the_customer_knows_the_stands_client_only_as_far_as_the_card_says(self):
        """It used to be told every number of the stand's client, whatever the card said."""
        found = simulation.customer_details(
            {'world': None, 'identifiers': UNSURE}, HttpAgent({'profile': 'local'}), FIXTURES, {}, 'c'
        )
        self.assertEqual((found['from'], found['known']), ('fixtures', True))
        self.assertIn('ООО «Ромашка»', found['text'])
        self.assertIn('наизусть не помнишь; если попросят, посмотришь: 7701234567', found['text'])
        self.assertIn('Касса №1, Касса №2', found['text'])
        self.assertNotIn('12345678', found['text'])

    def test_with_the_scenarios_world_in_the_mocks_the_customer_knows_that_world(self):
        card = {'world': scenario_world(), 'identifiers': KNOWS}
        sent = world.overrides(card['world'], FIXTURES)
        found = simulation.customer_details(card, HttpAgent({'profile': 'local'}), FIXTURES, sent, 'c')
        self.assertEqual(found['from'], 'world')
        self.assertIn('ООО «Кофе», ИНН 5012345678', found['text'])
        self.assertIn('Касса (номер 55556666)', found['text'])
        self.assertNotIn('Ромашка', found['text'])

    def test_a_stand_whose_fixtures_cannot_be_read_gives_the_customer_no_numbers(self):
        found = simulation.customer_details(
            {'world': None, 'identifiers': KNOWS}, HttpAgent({'profile': 'local'}), None, {}, 'c'
        )
        self.assertEqual((found['from'], found['known'], found['text']), ('fixtures', False, world.NO_DETAILS))

    def test_on_the_ift_stand_the_customer_knows_the_described_organization_of_its_epk(self):
        agent = HttpAgent({'profile': 'prod', 'epk': ['111'], 'clients': {'111': DESCRIBED}})
        found = simulation.customer_details({'world': scenario_world(), 'identifiers': KNOWS}, agent, None, {}, 'c')
        self.assertEqual((found['from'], found['epk'], found['known']), ('epk', '111', True))
        self.assertEqual(found['text'], 'Твоя организация: ООО «Тест», ИНН 7712345678. Терминалы: номер 11112222.')

    def test_on_the_ift_stand_an_undescribed_or_unauthorized_customer_has_no_numbers(self):
        card = {'world': scenario_world(), 'identifiers': KNOWS}
        undescribed = simulation.customer_details(card, HttpAgent({'profile': 'prod', 'epk': ['222']}), None, {}, 'c')
        self.assertEqual((undescribed['epk'], undescribed['known']), ('222', False))
        unauthorized = simulation.customer_details(card, HttpAgent({'profile': 'prod'}), None, {}, 'c')
        self.assertEqual((unauthorized['epk'], unauthorized['known']), (None, False))
        self.assertEqual(unauthorized['text'], world.NO_DETAILS)

    def test_a_client_without_names_is_told_without_empty_places(self):
        bare = world.epk_client({'name': '', 'inn': '', 'terminals': ['11112222', '33334444']})
        self.assertEqual(world.customer_profile(bare, UNSURE), 'Терминалов: 2. Номеров терминалов не знаешь.')
        self.assertIsNone(world.fixture_client({}))
        self.assertIsNone(world.epk_client(None))

    def test_the_conversation_talks_as_the_epk_its_customer_is_told_of(self):
        support.lab(self)
        for conversation_id in ('a', 'b', 'c', 'dd'):
            sent = prod_request(conversation_id, 'текст', ['111', '222'])[1]['metadata']['organization']['epk_id']
            self.assertEqual(sent, epk_of(conversation_id, ['111', '222']))
        self.assertEqual(prod_request('a', 'текст', [])[1]['metadata']['organization']['epk_id'], 'org-12345')


class ClientSettingsTests(unittest.TestCase):
    def test_only_the_epk_ids_talked_as_keep_their_organizations(self):
        saved = {
            'epk': ['111'],
            'clients': {'111': {'inn': ' 7712345678 ', 'terminals': '11112222, 33334444'}, '999': DESCRIBED},
        }
        self.assertEqual(
            agents.settings(saved)['clients'],
            {'111': {'name': '', 'inn': '7712345678', 'terminals': ['11112222', '33334444']}},
        )
        self.assertEqual(agents.configs(agents.settings(saved))['prod']['clients'], agents.settings(saved)['clients'])

    def test_a_mistyped_inn_or_terminal_is_refused_in_words(self):
        current = agents.settings({})
        with self.assertRaises(ValueError) as inn:
            agents.changed(current, {'epk': '111', 'clients': {'111': {'inn': '77123'}}})
        self.assertEqual(str(inn.exception), agents.BAD_INN.format(epk='111'))
        with self.assertRaises(ValueError) as terminal:
            agents.changed(current, {'epk': '111', 'clients': {'111': {'terminals': ['T-1']}}})
        self.assertEqual(str(terminal.exception), agents.BAD_TERMINALS.format(epk='111'))
        self.assertEqual(
            agents.changed(current, {'epk': '111', 'clients': {'111': {'name': ' ООО '}}})['clients'],
            {'111': {'name': 'ООО', 'inn': '', 'terminals': []}},
        )


class IftAgent:
    version = 'v1'
    mocked = False

    async def open(self) -> None:
        pass

    async def close(self) -> None:
        pass

    def client(self, conversation_id: str) -> tuple[str | None, dict | None]:
        return '111', DESCRIBED

    async def say(self, conversation_id: str, message: str, world: dict) -> dict:
        return {'text': 'Назовите ИНН', 'status': '200', 'ok': True, 'options': [], 'events': []}


class PlayedConversationTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_customer_is_told_the_organization_of_the_conversations_epk_and_the_run_keeps_it(self):
        support.lab(self)
        card = {
            'id': 'card',
            'name': 'card',
            'topic': 'topic',
            'origin': 'log',
            'situation': 'situation',
            'opening': 'Какой у меня тариф?',
            'criteria': [],
            'world': scenario_world(),
            'identifiers': KNOWS,
        }
        told = []

        async def customer(scenario: dict, conversation: list[dict], details: str = '', persona: str | None = None):
            told.append(details)
            return '7712345678'

        async def evaluate(scenario: dict, item: dict) -> None:
            item.update(status='PASS', rules=[])

        with (
            patch.object(simulation.scenarios, 'deck', return_value=[card]),
            patch.object(simulation.connection, 'ways', return_value={'prod': {'name': 'ИФТ'}}),
            patch.object(simulation.connection, 'connect', return_value=IftAgent()),
            patch.object(simulation, 'customer_says', side_effect=customer),
            patch.object(simulation, 'evaluate', side_effect=evaluate),
        ):
            result = await simulation.run('prod')
        self.assertEqual(set(told), {'Твоя организация: ООО «Тест», ИНН 7712345678. Терминалы: номер 11112222.'})
        details = storage.runs.get(result['id'])['items'][0]['customerDetails']
        self.assertEqual((details['from'], details['epk'], details['known']), ('epk', '111', True))


class ClientSettingsApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        support.serve(self)

    async def test_the_page_saves_the_organizations_and_refuses_a_mistyped_inn_in_words(self) -> None:
        clients = {'111': {'name': 'ООО «Тест»', 'inn': '7712345678', 'terminals': ['11112222']}}
        response = await self.client.post('/api/settings', json={'epk': ['111'], 'clients': clients})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(connection.settings()['clients'], clients)
        self.assertEqual(connection.ways()['prod']['clients'], clients)
        response = await self.client.post('/api/settings', json={'clients': {'111': {'inn': '123'}}})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()['detail'], agents.BAD_INN.format(epk='111'))
        self.assertEqual(connection.settings()['clients'], clients)

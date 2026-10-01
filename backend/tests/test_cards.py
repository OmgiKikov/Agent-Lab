import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from lab import api, cards, llm, store
from lab.jobs import Jobs


def analysis():
    rule = {'id': 'reply', 'text': 'Ответить клиенту', 'quote': 'Подробный ответ клиенту', 'observation': 'reply'}
    tool = {'id': 'tool', 'text': 'Узнать тариф', 'quote': 'getLkkTariff', 'observation': 'tool'}
    return {
        'topics': [{'id': 't', 'title': 'Тариф', 'rules': [rule, tool]}],
        'results': [{'topicId': 't', 'dialogueId': 'd', 'status': 'UNMEASURED'}],
    }


def dialogue():
    return {
        'id': 'd',
        'messages': [
            {'role': 'user', 'content': 'Какой мой тариф?'},
            {'role': 'assistant', 'content': 'Подробный ответ клиенту'},
        ],
    }


class CardsTests(unittest.IsolatedAsyncioTestCase):
    async def test_unmeasured_logs_supply_scenarios_without_becoming_passes(self):
        audit = analysis()
        with patch.object(cards.logs, 'load', return_value=[dialogue()]):
            picks = cards.pick(audit)
        self.assertEqual(len(picks), 1)
        self.assertEqual(picks[0][2], 'Покрытие темы')
        self.assertEqual(audit['results'][0]['status'], 'UNMEASURED')

    async def test_empty_generation_is_an_explicit_error(self):
        with (
            patch.object(cards.store, 'load', return_value={'topics': [], 'results': []}),
            patch.object(cards.logs, 'load', return_value=[]),
            self.assertRaisesRegex(RuntimeError, 'Нет разговоров'),
        ):
            await cards.run()

    async def test_generation_failure_keeps_saved_deck_and_is_visible(self):
        with (
            tempfile.TemporaryDirectory() as folder,
            patch.object(store, 'DB', Path(folder) / 'test.sqlite3'),
            patch.object(api, 'jobs', Jobs()),
            patch.object(cards.logs, 'load', return_value=[dialogue()]),
            patch.object(cards, 'build_card', AsyncMock(side_effect=llm.ModelError('model unavailable'))),
        ):
            previous = {'cards': [{'id': 'previous'}]}
            store.save(cards.DECK, previous)
            store.save('discover.json', analysis())
            await api.start_cards()
            await api.jobs._task
            self.assertEqual(store.load(cards.DECK), previous)
            self.assertIn('model unavailable', api.jobs.state['error'])
            self.assertFalse(api.jobs.state['running'])

    async def test_failure_joins_other_card_calls_before_returning(self):
        cancelled = asyncio.Event()

        async def build(topic, dialogue, origin, general):
            if dialogue['id'] == 'fail':
                await asyncio.sleep(0)
                raise llm.ModelError('model unavailable')
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        with (
            patch.object(cards.store, 'load', return_value={'topics': [], 'results': []}),
            patch.object(
                cards, 'pick', return_value=[({}, {'id': 'fail'}, 'Coverage'), ({}, {'id': 'wait'}, 'Coverage')]
            ),
            patch.object(cards, 'build_card', build),
            self.assertRaises(llm.ModelError),
        ):
            await cards.run()
        self.assertTrue(cancelled.is_set())

    async def test_generated_card_keeps_actual_model_outside_scenario_id(self):
        topic = analysis()['topics'][0]
        with (
            patch.object(
                cards.llm,
                'structured',
                AsyncMock(
                    return_value=llm.Answer({'name': 'Тариф', 'situation': 'Клиент узнаёт тариф'}, 'actual-model')
                ),
            ),
            patch.object(cards.world, 'build', AsyncMock(return_value=None)),
            patch.object(cards.sources, 'load', return_value=[]),
        ):
            result = await cards.build_card(topic, dialogue(), 'Покрытие темы')
        self.assertEqual(result['model'], 'actual-model')
        self.assertEqual(result['sourceDialogueId'], 'd')
        self.assertEqual(result['criteria'][1]['observation'], 'tool')

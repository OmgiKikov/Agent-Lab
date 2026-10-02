import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from lab import api, bench, cards, llm, store
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
    async def test_regression_takes_failures_and_the_representative_sample_ignores_verdicts(self):
        audit = analysis()
        with patch.object(cards.logs, 'load', return_value=[dialogue()]):
            self.assertEqual(cards.pick(audit), [])
        pool = [{'id': f'd{i}', 'messages': []} for i in range(10)]
        sample, manifest = cards.representative(pool, 4)
        self.assertEqual(len(sample), 4)
        self.assertEqual((manifest['population'], manifest['weight']), (10, 2.5))
        self.assertEqual(sample, cards.representative(list(reversed(pool)), 4)[0])
        self.assertEqual(audit['results'][0]['status'], 'UNMEASURED')

    async def test_stress_set_takes_rare_conditions_and_reports_their_share(self):
        long = {'id': 'long', 'messages': [{'role': 'user', 'content': 'x'}] * 4}
        refused = {'id': 'refused', 'messages': [], 'meta': {'acquiringStatuses': ['200', '202_7']}}
        common = {'id': 'common', 'messages': [{'role': 'user', 'content': 'x'}]}
        chosen, manifest = cards.stress([long, refused, common], {'long'})
        self.assertEqual([d['id'] for d in chosen], ['refused'])
        self.assertIsNone(manifest['weight'])
        self.assertEqual(manifest['conditions']['Четыре и больше реплик клиента'], '1 из 3')

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
        audit = analysis()
        audit['results'] = [{'topicId': 't', 'dialogueId': i, 'status': 'FAIL'} for i in ('fail', 'wait')]

        async def build(topic, dialogue, sets, general):
            if dialogue['id'] == 'fail':
                await asyncio.sleep(0)
                raise llm.ModelError('model unavailable')
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        with (
            patch.object(cards.store, 'load', return_value=audit),
            patch.object(
                cards.logs, 'load', return_value=[{'id': 'fail', 'messages': []}, {'id': 'wait', 'messages': []}]
            ),
            patch.object(cards, 'build_card', build),
            self.assertRaises(llm.ModelError),
        ):
            await cards.run()
        self.assertTrue(cancelled.is_set())

    async def test_card_keeps_only_quoted_customer_facts_and_the_actual_model(self):
        chat = {
            'id': 'd',
            'meta': {'agents': ['ACQUIRING_AGENT'], 'channel': 'WEB', 'row': 5},
            'messages': [
                {'role': 'user', 'content': 'Какой тариф у терминала ########?'},
                {'role': 'assistant', 'content': 'Ваш тариф 1,8%. Подробный ответ клиенту'},
                {'role': 'user', 'content': 'Такого раздела нет, зови человека'},
            ],
        }
        reply = {
            'eligible': True,
            'name': 'Тариф терминала',
            'goal': 'Узнать тариф своего терминала',
            'episode': {'start': 1, 'entry': 'first_message'},
            'facts': [
                {'text': 'тариф 1,8%', 'status': 'learned_from_agent', 'n': 2, 'quote': 'Ваш тариф 1,8%'},
                {'text': 'клиент на тарифе 2%', 'status': 'knows', 'n': 1, 'quote': 'тариф 2%'},
            ],
            'reactions': [
                {
                    'trigger': 'inapplicable_instruction',
                    'response': 'говорит, что раздела нет, и зовёт человека',
                    'agentN': 2,
                    'agentQuote': 'Подробный ответ',
                    'n': 3,
                    'quote': 'Такого раздела нет',
                }
            ],
            'observations': [
                {'action': 'спросил в чате', 'result': 'бот ответил про тариф', 'n': 3, 'quote': 'Такого раздела нет'}
            ],
            'identifiers': {'terminal': {'status': 'masked_in_source', 'n': 1, 'quote': 'терминала'}},
            'openingFilled': 'Какой тариф у терминала 48213907?',
        }
        with (
            patch.object(cards.llm, 'structured', AsyncMock(return_value=llm.Answer(reply, 'actual-model'))),
            patch.object(cards.world, 'build', AsyncMock(return_value=None)),
            patch.object(cards.sources, 'load', return_value=[]),
        ):
            card = await cards.build_card(analysis()['topics'][0], chat, ['representative'])
        self.assertEqual(card['model'], 'actual-model')
        self.assertEqual(card['opening'], 'Какой тариф у терминала 48213907?')
        self.assertEqual([f['status'] for f in card['facts']], ['learned_from_agent'])
        self.assertEqual((card['checks']['dropped']['facts'], card['checks']['dropped']['observations']), (1, 1))
        self.assertNotIn('1,8%', card['situation'])
        self.assertIn('раздела нет', card['situation'])
        self.assertEqual(card['identifiers']['terminal'], {'value': 'knows', 'basis': 'log'})
        self.assertEqual(card['identifiers']['organization']['basis'], 'variant')
        self.assertEqual((card['episode']['scope'], card['origin']), ('acquiring_only', 'Представительный набор'))
        self.assertEqual(card['criteria'][1]['observation'], 'tool')

    def test_filled_opening_may_change_only_the_masked_runs(self):
        self.assertEqual(cards._filled('Терминал ####', 'Терминал 1234'), 'Терминал 1234')
        self.assertIsNone(cards._filled('Терминал ####', 'Мой терминал 1234'))
        self.assertIsNone(cards._filled('Терминал ####', 'Терминал ####'))
        self.assertEqual(cards._filled('Без масок', 'что угодно'), 'Без масок')
        self.assertRegex(cards._digits('Терминал #, сумма *', 'd'), r'^Терминал \d{4}, сумма \*$')

    def test_report_reads_the_representative_set_against_sampling_noise(self):
        pool = [
            {'id': f'd{i}', 'messages': [{'role': 'user', 'content': f'Вопрос {i}'}], 'meta': {'channel': 'WEB'}}
            for i in range(30)
        ]
        manner = {'words': 2, 'greeting': False, 'polite': False, 'capital': 1.0, 'endMark': 0.0}
        deck = [
            {
                'id': f'c{i}',
                'sets': ['representative'],
                'sourceDialogueId': f'd{i}',
                'opening': f'Вопрос {i}',
                'situation': f'Твоя задача: вопрос {i}',
                'goal': f'Узнать {i}',
                'style': manner,
                'reactions': [],
                'facts': [],
                'circumstances': [],
                'observations': [],
                'hypotheses': [],
                'notEstablished': [],
                'identifiers': {'terminal': {'value': 'knows', 'basis': 'variant'}},
                'checks': {'dropped': {'facts': 1}, 'openingFilled': True},
            }
            for i in range(5)
        ]
        result = bench.report({'cards': deck, 'sets': {'representative': {'cardIds': ['c0'], 'weight': 6.0}}}, pool)
        self.assertEqual(result['population']['канал']['distance'], 0)
        self.assertEqual(result['grounding']['dropped'], {'facts': 5})
        self.assertEqual(result['grounding']['identifiers'], {'terminal:variant': 5})
        self.assertEqual(result['sets']['representative'], {'weight': 6.0, 'cards': 1})
        self.assertEqual(result['diversity']['signatures'], 1)

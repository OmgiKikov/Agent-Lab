import asyncio
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from lab import api, cards, llm, store
from lab.agents import world
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

    async def test_a_tone_check_gives_a_scenario_per_criterion_the_agent_failed_not_four_at_most(self):
        """Tone of voice has one topic: picking two errors and two controls per topic capped its deck at four. Every
        criterion the agent failed gets its own conversation first (the most frequent first, each conversation once),
        then a control, then the second conversation of every criterion, then the second control."""
        rules = [{'id': f'c{n}', 'text': f'Критерий {n}', 'quote': str(n), 'observation': 'reply'} for n in range(1, 5)]
        failed = {'d1': ['c1', 'c2'], 'd2': ['c1'], 'd3': ['c3'], 'd4': ['c3'], 'd5': ['c4']}

        def result(dialogue_id: str) -> dict:
            errors = failed.get(dialogue_id, [])
            rows = [{'ruleId': rule['id'], 'status': 'FAIL' if rule['id'] in errors else 'PASS'} for rule in rules]
            return {'topicId': 't1', 'dialogueId': dialogue_id, 'status': 'FAIL' if errors else 'PASS', 'rules': rows}

        ids = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8']
        topic = {'id': 't1', 'title': 'Tone of voice', 'rules': rules}
        audit = {'topics': [topic], 'results': [result(d) for d in ids]}
        messages = [{'role': 'user', 'content': 'Вопрос'}, {'role': 'assistant', 'content': 'Ответ'}]
        talks = [{'id': d, 'messages': messages} for d in ids]
        with patch.object(cards.logs, 'load', return_value=talks):
            picks = cards.pick(audit)
        self.assertEqual(
            [(dialogue['id'], origin) for _, dialogue, origin, _ in picks],
            [
                ('d1', cards.FROM_LOG),
                ('d3', cards.FROM_LOG),
                ('d5', cards.FROM_LOG),
                ('d6', cards.COVERAGE),
                ('d2', cards.FROM_LOG),
                ('d4', cards.FROM_LOG),
                ('d7', cards.COVERAGE),
            ],
        )
        self.assertEqual(picks[0][3], ['c1', 'c2'])  # the card still reproduces every criterion failed there

    async def test_empty_generation_is_an_explicit_error(self):
        with (
            patch.object(cards.store, 'load', return_value={'topics': [], 'results': []}),
            patch.object(cards.logs, 'load', return_value=[]),
            self.assertRaisesRegex(RuntimeError, 'Нет разговоров'),
        ):
            await cards.run('code')

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
            await api.start_cards(api.CardsCommand(check='code'))
            await api.jobs._task
            self.assertEqual(store.load(cards.DECK), previous)
            self.assertIn('model unavailable', api.jobs.state['error'])
            self.assertFalse(api.jobs.state['running'])

    async def test_a_failed_card_does_not_cancel_the_others_and_is_reported(self):
        failed, release = asyncio.Event(), asyncio.Event()

        async def build(topic, dialogue, origin, general, reproduces=()):
            if dialogue['id'] == 'fail':
                failed.set()
                raise llm.ModelError('model unavailable')
            await release.wait()  # still being built when the other card fails
            return {'id': dialogue['id']}

        topic = {'title': 'Тариф'}
        picks = [(topic, {'id': 'fail'}, 'Coverage'), (topic, {'id': 'kept'}, 'Coverage')]
        reported = []
        with (
            patch.object(cards.store, 'load', return_value={'topics': [], 'results': []}),
            patch.object(cards, 'pick', return_value=picks),
            patch.object(cards, 'build_card', build),
        ):
            building = asyncio.create_task(cards.run('code', lambda **values: reported.append(values)))
            await failed.wait()
            await asyncio.sleep(0)
            release.set()
            deck = await building
        self.assertEqual(deck, [{'id': 'kept'}])
        self.assertEqual(reported[-1]['done'], 2)
        self.assertEqual(
            reported[-1]['failed'], [{'topic': 'Тариф', 'dialogueId': 'fail', 'error': 'model unavailable'}]
        )

    async def test_a_world_of_the_wrong_shape_is_a_model_error_and_is_asked_again(self):
        shapes = {'getLkkTariff': {'rate': 1.0}}
        bad = {'organization': {'name': 'ООО «Ромашка»'}, 'terminals': [], 'tools': ['getLkkTariff']}
        good = {**bad, 'tools': {'getLkkTariff': {'rate': 2.5}}}
        replies = [llm.Answer(json.dumps(bad), 'actual-model'), llm.Answer(json.dumps(good), 'actual-model')]
        with (
            patch.object(world, 'templates', return_value=shapes),
            patch.object(world.llm, 'chat', AsyncMock(side_effect=replies)) as chat,
        ):
            built = await world.build('Клиент узнаёт тариф', ['Какой мой тариф?'])
        self.assertEqual(chat.await_count, 2)
        self.assertEqual(built['tools'], {'getLkkTariff': {'rate': 2.5}})
        with (
            patch.object(world, 'templates', return_value=shapes),
            patch.object(world.llm, 'chat', AsyncMock(return_value=replies[0])),
            self.assertRaises(llm.ModelError),
        ):
            await world.build('Клиент узнаёт тариф', ['Какой мой тариф?'])

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

    async def test_a_card_from_an_error_names_the_criteria_it_reproduces(self):
        """A scenario is a test of the error it was built from: the criteria the agent failed in the source conversation
        travel with the card, in the order of that conversation's result. One the scenario does not check (the Lab does
        not record state changes) is not reproduced by it; a card from a conversation without an error reproduces none.
        """
        audit = analysis()
        state = {'id': 'state', 'text': 'Сменить статус заявки', 'quote': 'setStatus', 'observation': 'state'}
        audit['topics'][0]['rules'].append(state)
        failed = [
            {'ruleId': 'state', 'status': 'FAIL', 'agentQuote': ''},
            {'ruleId': 'tool', 'status': 'PASS', 'agentQuote': 'getLkkTariff'},
            {'ruleId': 'reply', 'status': 'FAIL', 'agentQuote': 'Подробный ответ клиенту'},
        ]
        audit['results'] = [
            {'topicId': 't', 'dialogueId': 'd', 'status': 'FAIL', 'rules': failed},
            {'topicId': 't', 'dialogueId': 'p', 'status': 'PASS', 'rules': [{'ruleId': 'reply', 'status': 'PASS'}]},
        ]
        named = llm.Answer({'name': 'Тариф', 'situation': 'Клиент узнаёт тариф.'}, 'actual-model')
        with (
            patch.object(cards.store, 'load', return_value=audit),
            patch.object(cards.logs, 'load', return_value=[dialogue(), dict(dialogue(), id='p')]),
            patch.object(cards.llm, 'structured', AsyncMock(return_value=named)),
            patch.object(cards.world, 'build', AsyncMock(return_value=None)),
            patch.object(cards.sources, 'load', return_value=[]),
        ):
            deck = await cards.run('code')
        self.assertEqual(
            [(card['origin'], card['sourceDialogueId'], card['reproduces']) for card in deck],
            [('Ошибка из лога', 'd', ['reply']), ('Покрытие темы', 'p', [])],
        )
        # The id is still the hash of the card's content, what it reproduces included; the model stays outside.
        for card in deck:
            content = {key: value for key, value in card.items() if key not in ('id', 'model')}
            digest = hashlib.sha256(json.dumps(content, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
            self.assertEqual(card['id'], digest[:12])

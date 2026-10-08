import asyncio
import hashlib
import json
import unittest
from unittest.mock import AsyncMock, patch

import support

from lab import api, models, storage
from lab.domain import checks
from lab.flows import datasets, inputs
from lab.flows import scenarios as cards
from lab.flows.simulation import run as cards_run
from lab.jobs import Jobs
from lab.roles import world as world_role


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


def scenario(name: str, goal: str) -> models.Reply:
    """What the model answers as the card role: the customer of the conversation's episode."""
    value = {'eligible': True, 'name': name, 'goal': goal, 'episode': {'start': 1, 'entry': 'first_message'}}
    return models.Reply(json.dumps(value, ensure_ascii=False), 'actual-model')


def catalog_of(*ids: str):
    """The catalog flow answering with one scenario that holds these conversations."""
    return patch.object(cards.catalog, 'build', AsyncMock(return_value=support.catalog_of(list(ids))))


class CardsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        support.lab(self)

    async def test_empty_generation_is_an_explicit_error(self):
        storage.documents.save(checks.result(checks.CODE), {'topics': [], 'results': []})
        with self.assertRaisesRegex(RuntimeError, 'Нет разговоров'):
            await cards.built(checks.CODE)

    async def test_generation_failure_keeps_saved_deck_and_is_visible(self):
        jobs = Jobs()
        storage.dialogues.replace([dialogue()])
        with (
            patch.object(cards, 'build_card', AsyncMock(side_effect=models.ModelError('model unavailable'))),
            catalog_of('d'),
        ):
            previous = {'cards': [{'id': 'previous'}]}
            storage.documents.save(checks.DECK, previous)
            storage.documents.save('discover.json', analysis())
            await api.scenarios.start_cards(jobs, api.scenarios.CardsCommand(check='code'))
            await jobs._task
            self.assertEqual(storage.documents.load(checks.DECK), previous)
            self.assertIn('model unavailable', jobs.state['error'])
            self.assertFalse(jobs.state['running'])

    async def test_a_failed_card_does_not_cancel_the_others_and_is_reported(self):
        failed, release = asyncio.Event(), asyncio.Event()

        async def build(
            topic, dialogue, sets, general=(), scenario=None, start=None, end=None, agent=None, judged=True
        ):
            if dialogue['id'] == 'fail':
                failed.set()
                raise models.ModelError('model unavailable')
            await release.wait()  # still being built when the other card fails
            return {'id': dialogue['id'], 'sets': list(sets), 'sourceDialogueId': dialogue['id']}

        reported = []
        storage.documents.save(checks.result(checks.CODE), analysis())
        storage.dialogues.replace([dict(dialogue(), id='fail'), dict(dialogue(), id='kept')])
        with patch.object(cards, 'build_card', build), catalog_of('fail', 'kept'):
            building = asyncio.create_task(cards.built(checks.CODE, lambda **values: reported.append(values)))
            await failed.wait()
            await asyncio.sleep(0)
            release.set()
            deck = await building
        self.assertEqual([card['id'] for card in deck['cards']], ['kept'])
        self.assertEqual(reported[-1]['done'], 2)
        self.assertEqual(
            reported[-1]['failed'], [{'topic': 'Тариф', 'dialogueId': 'fail', 'error': 'model unavailable'}]
        )

    async def test_a_world_of_the_wrong_shape_is_a_model_error_and_is_asked_again(self):
        shapes = {'getLkkTariff': {'rate': 1.0}}
        bad = {'organization': {'name': 'ООО «Ромашка»'}, 'terminals': [], 'tools': ['getLkkTariff']}
        good = {**bad, 'tools': {'getLkkTariff': {'rate': 2.5}}}
        replies = [models.Reply(json.dumps(bad), 'actual-model'), models.Reply(json.dumps(good), 'actual-model')]
        with patch.object(models, 'chat', AsyncMock(side_effect=replies)) as chat:
            built = await world_role.world('Клиент узнаёт тариф', ['Какой мой тариф?'], shapes)
        self.assertEqual(chat.await_count, 2)
        self.assertEqual(built.value['tools'], {'getLkkTariff': {'rate': 2.5}})
        with (
            patch.object(models, 'chat', AsyncMock(return_value=replies[0])),
            self.assertRaises(models.ModelError),
        ):
            await world_role.world('Клиент узнаёт тариф', ['Какой мой тариф?'], shapes)

    async def test_generated_card_keeps_actual_model_outside_scenario_id(self):
        topic = analysis()['topics'][0]
        named = scenario('Тариф', 'Узнать тариф')
        with (
            patch.object(models, 'chat', AsyncMock(return_value=named)),
            patch.object(cards.world, 'templates', return_value=None),
            patch.object(cards.inputs, 'sources', return_value=[]),
        ):
            result = await cards.build_card(topic, dialogue(), ['representative'])
        self.assertEqual(result['model'], 'actual-model')
        self.assertEqual(result['sourceDialogueId'], 'd')
        self.assertEqual(result['criteria'][1]['observation'], 'tool')

    async def test_without_a_check_a_card_is_the_customer_of_its_business_scenario_without_criteria(self):
        """No check has a result: no conversation is sorted into a check's topics, the card's topic is its scenario of
        the catalog, and it carries no criteria even where the agent's prompts say the rules every scenario has."""
        storage.dialogues.replace([dialogue()])
        chat = AsyncMock(return_value=scenario('Тариф', 'Узнать тариф.'))
        prompts = [{'id': 'p', 'kind': 'prompt', 'content': 'Используй ТОЛЬКО информацию из контекста.'}]
        with (
            catalog_of('d'),
            patch.object(models, 'chat', chat),
            patch.object(cards.world, 'templates', return_value=None),
            patch.object(cards.inputs, 'sources', return_value=prompts),
        ):
            await cards.build(None, lambda **_: None)
        deck = storage.documents.load(checks.DECK)
        self.assertIsNone(deck['check'])
        [card] = deck['cards']
        self.assertEqual(
            (card['eligible'], card['topic'], card['topicId'], card['criteria'], card['scenario']['title']),
            (True, 'Узнать тариф', 'c1s1', [], 'Узнать тариф'),
        )
        self.assertEqual([call.kwargs['call'].role for call in chat.await_args_list], ['card'])

    async def test_a_run_of_scenarios_without_criteria_is_refused_before_the_agent_is_called(self):
        storage.documents.save(checks.DECK, {'check': None, 'cards': [{'id': 'c', 'criteria': []}]})
        with self.assertRaisesRegex(RuntimeError, 'собраны без проверки'):
            await cards_run('nowhere')

    async def test_a_deck_built_without_a_check_stays_when_checks_change_and_goes_with_the_export(self):
        storage.documents.save(checks.DECK, {'check': None, 'cards': [{'id': 'c'}]})
        inputs.drop_deck(list(checks.RESULTS))
        self.assertIsNotNone(storage.documents.load(checks.DECK))
        inputs.replace_export([{'id': 'd2'}])
        self.assertIsNone(storage.documents.load(checks.DECK))

    def test_a_deck_built_without_a_check_comes_back_with_its_dataset(self):
        """A new dataset starts without scenarios; going back to the one they were built from brings them back: with no
        criteria in them, no change of a check can make them stale."""
        talk = {'messages': [{'role': 'user', 'content': 'Какой тариф?'}, {'role': 'assistant', 'content': 'Ответ'}]}
        first = datasets.add([{'id': 'd1', **talk}], 'one.json')
        storage.documents.save(checks.DECK, {'check': None, 'cards': [{'id': 'c'}]})
        datasets.add([{'id': 'd2', **talk}], 'two.json')
        self.assertIsNone(storage.documents.load(checks.DECK))
        datasets.select(first['id'])
        self.assertEqual(storage.documents.load(checks.DECK)['cards'], [{'id': 'c'}])

    def test_only_a_deck_from_before_decks_named_their_check_is_given_one(self):
        self.assertEqual(checks.separated({checks.DECK: {'cards': []}})[checks.DECK]['check'], checks.CODE)
        self.assertEqual(checks.separated({checks.DECK: {'check': None, 'cards': []}}), {})

    async def test_every_sampled_conversation_is_a_representative_card_named_by_the_hash_of_its_content(self):
        """No card comes from the check's errors: a conversation with an error and one without are both sampled
        episodes of the catalog's scenario."""
        audit = analysis()
        audit['results'] = [
            {'topicId': 't', 'dialogueId': 'd', 'status': 'FAIL', 'rules': [{'ruleId': 'reply', 'status': 'FAIL'}]},
            {'topicId': 't', 'dialogueId': 'p', 'status': 'PASS', 'rules': [{'ruleId': 'reply', 'status': 'PASS'}]},
        ]
        named = scenario('Тариф', 'Узнать тариф.')
        storage.documents.save(checks.result(checks.CODE), audit)
        storage.dialogues.replace([dialogue(), dict(dialogue(), id='p')])
        with (
            catalog_of('d', 'p'),
            patch.object(models, 'chat', AsyncMock(return_value=named)),
            patch.object(cards.world, 'templates', return_value=None),
            patch.object(cards.inputs, 'sources', return_value=[]),
        ):
            deck = (await cards.built(checks.CODE))['cards']
        self.assertEqual(
            sorted((card['origin'], card['sourceDialogueId']) for card in deck),
            [('Представительный набор', 'd'), ('Представительный набор', 'p')],
        )
        self.assertTrue(all('reproduces' not in card for card in deck))
        # The id is the hash of the card's content; the model stays outside.
        for card in deck:
            content = {key: value for key, value in card.items() if key not in ('id', 'model')}
            digest = hashlib.sha256(json.dumps(content, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
            self.assertEqual(card['id'], digest[:12])

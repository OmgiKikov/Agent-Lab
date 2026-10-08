import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

import support

from lab import models, storage
from lab.domain import catalog, checks
from lab.flows import catalog as catalog_flow
from lab.flows import scenarios as deck_flow
from lab.roles import Answer
from lab.roles import catalog as catalog_role


def talk(dialogue_id: str, text: str = 'Не работает QR') -> dict:
    return {
        'id': dialogue_id,
        'messages': [{'role': 'user', 'content': text}, {'role': 'assistant', 'content': 'Перезагрузите терминал'}],
    }


PROPOSED = [
    {
        'title': 'QR-оплата',
        'description': 'Оплата по QR-коду',
        'scenarios': [
            {'title': 'Не работает QR', 'description': 'QR не принимает оплату'},
            {'title': 'Подключить QR', 'description': 'Новый QR'},
        ],
    },
    {'title': 'Тарифы', 'description': 'Ставки', 'scenarios': [{'title': 'Узнать ставку', 'description': ''}]},
]


class CatalogTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        support.lab(self)

    def test_proposed_scenarios_get_ids_and_lose_blanks_and_repeats(self):
        found = catalog.taxonomy(
            [
                *PROPOSED,
                {'title': 'Пусто', 'scenarios': [{'title': ' '}]},
                {'title': 'Ещё', 'scenarios': PROPOSED[0]['scenarios']},
            ]
        )
        self.assertEqual([c['id'] for c in found], ['c1', 'c2'])
        self.assertEqual([s['id'] for s in found[0]['scenarios']], ['c1s1', 'c1s2'])
        self.assertEqual(catalog.revision(found), catalog.revision(catalog.taxonomy(PROPOSED)))
        with self.assertRaises(ValueError):
            catalog.taxonomy([{'title': 'Пусто', 'scenarios': []}])

    def test_an_episode_starts_at_a_customer_message_and_names_a_task(self):
        dialogue = talk('d')
        read = {'inDomain': True, 'start': 1, 'end': 2, 'task': 'починить QR.', 'object': 'QR'}
        self.assertEqual(
            catalog.checked_episode(read, dialogue),
            {'inDomain': True, 'start': 1, 'end': 2, 'task': 'починить QR', 'object': 'QR'},
        )
        for wrong in (
            {'inDomain': True, 'start': 2, 'end': 2, 'task': 'x'},
            {'inDomain': True, 'start': 1, 'end': 2, 'task': ' '},
            {'inDomain': True, 'start': 1, 'task': 'x'},  # where the task ends is part of the reading
            {'inDomain': True, 'start': 1, 'end': 3, 'task': 'x'},
        ):
            with self.subTest(wrong=wrong), self.assertRaises(ValueError):
                catalog.checked_episode(wrong, dialogue)
        self.assertEqual(
            catalog.checked_episode({'inDomain': False, 'reason': 'приветствие', 'task': None}, dialogue),
            {'inDomain': False, 'reason': 'приветствие'},
        )
        # A model that leaves acquiring out: an answer with a task is an acquiring episode, one without is asked again.
        read = {'start': 1, 'end': 1, 'task': 'починить QR', 'object': None}
        self.assertTrue(catalog.checked_episode(read, dialogue)['inDomain'])
        with self.assertRaises(ValueError):
            catalog.checked_episode({'start': 1, 'task': None}, dialogue)

    def test_the_catalog_is_proposed_from_a_sample_of_acquiring_episodes_the_same_every_time(self):
        episodes = {f'd{i}': {'inDomain': i % 4 != 0, 'task': f'задача {i}', 'object': 'x'} for i in range(40)}
        chosen = catalog.sample(episodes, 10)
        self.assertEqual(len(chosen), 10)
        self.assertTrue(all(e['inDomain'] for e in chosen.values()))
        self.assertEqual(chosen, catalog.sample(episodes, 10))
        self.assertEqual(len(catalog.sample(episodes, 100)), 30)

    def test_the_catalog_role_reads_each_task_once_with_its_count(self):
        episodes = {
            'a': {'inDomain': True, 'task': 'Починить QR', 'object': 'QR'},
            'b': {'inDomain': True, 'task': 'починить QR', 'object': 'qr'},
            'c': {'inDomain': True, 'task': 'узнать ставку', 'object': 'тариф'},
            'd': {'inDomain': False, 'reason': 'приветствие'},
        }
        self.assertEqual(
            catalog.distinct_tasks(episodes),
            [
                {'task': 'починить qr', 'object': 'qr', 'count': 2},
                {'task': 'узнать ставку', 'object': 'тариф', 'count': 1},
            ],
        )

    def test_the_catalog_counts_its_scenarios_and_shows_real_first_messages(self):
        categories = catalog.taxonomy(PROPOSED)
        dialogues = {i: talk(i, f'Сообщение {i}') for i in ('a', 'b', 'c', 'd', 'e')}
        episodes = {
            'a': {'inDomain': True, 'start': 1, 'task': 'починить QR', 'object': 'QR', 'scenarioId': 'c1s1'},
            'b': {'inDomain': True, 'start': 1, 'task': 'починить QR', 'object': 'QR', 'scenarioId': 'c1s1'},
            'c': {'inDomain': True, 'start': 1, 'task': 'узнать ставку', 'object': 'тариф', 'scenarioId': 'c2s1'},
            'd': {'inDomain': True, 'start': 1, 'task': 'зарплата', 'object': 'проект', 'scenarioId': catalog.NONE},
            'e': {'inDomain': False, 'reason': 'приветствие'},
        }
        found = catalog.counted(categories, episodes, dialogues)
        qr = found['categories'][0]
        self.assertEqual((qr['count'], qr['share']), (2, 0.5))
        self.assertEqual(qr['scenarios'][0]['examples'][0]['opening'][:9], 'Сообщение')
        self.assertTrue(qr['scenarios'][1]['rare'])
        self.assertEqual(
            found['totals'],
            {
                'dialogues': 5,
                'inDomain': 4,
                'outOfDomain': 1,
                'unread': 0,
                'placed': 3,
                'unplaced': 1,
                'notYetPlaced': 0,
            },
        )

    async def test_a_build_reads_each_conversation_once_and_places_new_ones_into_the_frozen_catalog(self):
        storage.dialogues.replace([talk('a'), talk('b', 'Какая ставка?'), talk('g', 'Привет')])
        tasks = {'a': ('починить QR', 'QR'), 'b': ('узнать ставку', 'тариф')}

        async def episode(dialogue, agent):
            if dialogue['id'] in tasks:
                task, thing = tasks[dialogue['id']]
                return Answer({'inDomain': True, 'start': 1, 'task': task, 'object': thing}, 'm')
            return Answer({'inDomain': False, 'reason': 'приветствие'}, 'm')

        async def place(scenarios, items):
            names = {s['title']: s['id'] for s in scenarios}
            return Answer(
                [(i['id'], names['Не работает QR' if 'QR' in i['task'] else 'Узнать ставку']) for i in items], 'm'
            )

        read = AsyncMock(side_effect=episode)
        propose = AsyncMock(return_value=Answer(catalog.taxonomy(PROPOSED), 'm'))
        with (
            patch.object(catalog_role, 'episode', read),
            patch.object(catalog_role, 'propose', propose),
            patch.object(catalog_role, 'place', AsyncMock(side_effect=place)),
        ):
            first = await catalog_flow.build()
            self.assertEqual(read.await_count, 3)
            self.assertEqual(first['episodes']['a']['scenarioId'], 'c1s1')
            self.assertEqual(first['totals']['outOfDomain'], 1)
            storage.dialogues.replace([talk('a'), talk('b', 'Какая ставка?'), talk('n', 'QR не работает')])
            tasks['n'] = ('починить QR', 'QR')
            second = await catalog_flow.build()
        self.assertEqual(read.await_count, 4)  # only the new conversation is read
        self.assertEqual(propose.await_count, 1)  # the catalog stays: the new one is placed into it
        self.assertEqual(second['revision'], first['revision'])
        self.assertEqual(second['episodes']['n']['scenarioId'], 'c1s1')
        self.assertNotIn('g', second['episodes'])
        self.assertEqual(storage.documents.load(checks.CATALOG)['revision'], first['revision'])

    async def test_a_catalog_is_never_proposed_from_part_of_the_export_and_the_next_build_goes_on(self):
        storage.dialogues.replace([talk(f'd{i}') for i in range(20)])
        reading = Answer({'inDomain': True, 'start': 1, 'task': 'починить QR', 'object': 'QR'}, 'm')
        busy = [models.ModelError('Модель ответила ошибкой (HTTP 429).')] * 2
        propose = AsyncMock(return_value=Answer(catalog.taxonomy(PROPOSED), 'm'))

        async def place(scenarios, items):
            return Answer([(i['id'], 'c1s1') for i in items], 'm')

        with (
            patch.object(catalog_role, 'propose', propose),
            patch.object(catalog_role, 'place', AsyncMock(side_effect=place)),
        ):
            with (
                patch.object(catalog_role, 'episode', AsyncMock(side_effect=[*busy, *[reading] * 18])),
                self.assertRaisesRegex(RuntimeError, r'не прочитала 2 из 20 разговоров \(Модель ответила ошибкой'),
            ):
                await catalog_flow.build()
            propose.assert_not_awaited()
            again = AsyncMock(return_value=reading)
            with patch.object(catalog_role, 'episode', again):
                found = await catalog_flow.build()
        self.assertEqual(again.await_count, 2)  # only the two the model did not read
        self.assertEqual((found['totals']['unread'], found['totals']['placed']), (0, 20))

    async def test_a_rebuild_that_places_too_little_leaves_the_catalog_in_use(self):
        storage.dialogues.replace([talk(f'd{i}') for i in range(10)])
        reading = Answer({'inDomain': True, 'start': 1, 'task': 'починить QR', 'object': 'QR'}, 'm')

        async def place(scenarios, items):
            return Answer([(i['id'], 'c1s1') for i in items], 'm')

        with (
            patch.object(catalog_role, 'episode', AsyncMock(return_value=reading)),
            patch.object(catalog_role, 'propose', AsyncMock(return_value=Answer(catalog.taxonomy(PROPOSED), 'm'))),
            patch.object(catalog_role, 'place', AsyncMock(side_effect=place)),
        ):
            used = await catalog_flow.build()
        with (
            patch.object(catalog_role, 'propose', AsyncMock(return_value=Answer(catalog.taxonomy(PROPOSED[:1]), 'm'))),
            patch.object(catalog_role, 'place', AsyncMock(side_effect=models.ModelError('unusable'))),
            self.assertRaisesRegex(RuntimeError, 'не разложила по сценариям'),
        ):
            await catalog_flow.build(rebuild=True)
        saved = catalog_flow.current()
        self.assertEqual((saved['revision'], saved['totals']), (used['revision'], used['totals']))
        self.assertIn('proposed', saved)  # the rebuild's work waits beside the catalog in use

    async def test_one_conversation_the_model_cannot_read_among_many_is_left_out(self):
        storage.dialogues.replace([talk(f'd{i}') for i in range(30)])
        reading = Answer({'inDomain': True, 'start': 1, 'task': 'починить QR', 'object': 'QR'}, 'm')

        async def place(scenarios, items):
            return Answer([(i['id'], 'c1s1') for i in items], 'm')

        with (
            patch.object(
                catalog_role, 'episode', AsyncMock(side_effect=[models.ModelError('unusable'), *[reading] * 29])
            ),
            patch.object(catalog_role, 'propose', AsyncMock(return_value=Answer(catalog.taxonomy(PROPOSED), 'm'))),
            patch.object(catalog_role, 'place', AsyncMock(side_effect=place)),
        ):
            found = await catalog_flow.build()
        self.assertEqual(found['totals']['unread'], 1)

    async def test_the_router_places_episodes_in_batches(self):
        many = [talk(f'd{i}') for i in range(catalog_flow.BATCH + 1)]
        storage.dialogues.replace(many)
        sizes = []

        async def place(scenarios, items):
            sizes.append(len(items))
            return Answer([(i['id'], 'c1s1') for i in items], 'm')

        reading = Answer({'inDomain': True, 'start': 1, 'task': 'починить QR', 'object': 'QR'}, 'm')
        with (
            patch.object(catalog_role, 'episode', AsyncMock(return_value=reading)),
            patch.object(catalog_role, 'propose', AsyncMock(return_value=Answer(catalog.taxonomy(PROPOSED), 'm'))),
            patch.object(catalog_role, 'place', AsyncMock(side_effect=place)),
        ):
            found = await catalog_flow.build()
        self.assertEqual(sorted(sizes), [1, catalog_flow.BATCH])
        self.assertEqual(found['categories'][0]['scenarios'][0]['count'], catalog_flow.BATCH + 1)

    async def test_the_router_answer_must_place_most_episodes(self):
        scenarios = [{'id': 'c1s1', 'category': 'QR', 'title': 'Не работает QR', 'description': ''}]
        items = [{'id': f'e{i}', 'task': 'починить QR', 'object': 'QR', 'opening': 'x'} for i in range(1, 11)]
        half = {'assignments': [{'episodeId': f'e{i}', 'scenarioId': 'c1s1'} for i in range(1, 6)]}
        whole = {'assignments': [{'episodeId': f'e{i}', 'scenarioId': 'none'} for i in range(1, 11)]}
        replies = [models.Reply(json.dumps(half), 'm'), models.Reply(json.dumps(whole), 'm')]
        with patch.object(models, 'chat', AsyncMock(side_effect=replies)) as chat:
            answer = await catalog_role.place(scenarios, items)
        self.assertEqual(chat.await_count, 2)
        self.assertEqual(len(answer.value), 10)

    async def test_the_deck_has_a_card_for_every_conversation_and_names_its_scenario(self):
        topic = {
            'id': 't1',
            'title': 'Tone of voice',
            'rules': [{'id': 't1r1', 'text': 'x', 'quote': 'y', 'observation': 'reply'}],
        }
        storage.documents.save(checks.result(checks.CODE), {'topics': [topic], 'results': []})
        storage.dialogues.replace([talk('a'), talk('b'), talk('c', 'Какая ставка?')])
        categories = catalog.taxonomy(PROPOSED)
        episodes = {
            'a': {'inDomain': True, 'start': 1, 'task': 'починить QR', 'object': 'QR', 'scenarioId': 'c1s1'},
            'b': {'inDomain': True, 'start': 1, 'task': 'починить QR', 'object': 'QR', 'scenarioId': 'c1s1'},
            'c': {'inDomain': True, 'start': 1, 'task': 'узнать ставку', 'object': 'тариф', 'scenarioId': 'c2s1'},
        }
        found = {'revision': 'r1', 'categories': categories, 'episodes': episodes}

        async def build_card(
            topic, dialogue, sets, general=(), scenario=None, start=None, end=None, agent=None, judged=True
        ):
            return {
                'id': dialogue['id'],
                'eligible': True,
                'sets': list(sets),
                'sourceDialogueId': dialogue['id'],
                'scenario': scenario,
            }

        with (
            patch.object(deck_flow.catalog, 'build', AsyncMock(return_value=found)),
            patch.object(deck_flow, 'build_card', build_card),
        ):
            deck = await deck_flow.built(checks.CODE)
        self.assertEqual(deck['catalogRevision'], 'r1')
        scenarios = sorted(card['scenario']['id'] for card in deck['cards'])
        self.assertEqual(scenarios, ['c1s1', 'c1s1', 'c2s1'])
        self.assertTrue(all('representative' in card['sets'] for card in deck['cards']))
        self.assertEqual(deck['sets']['representative']['scenarios'], 2)
        self.assertEqual(catalog.scenarios_of(categories)[catalog.NONE]['title'], 'Не попал в каталог')

    async def test_a_stopped_build_keeps_its_readings_proposal_and_placements_and_the_next_one_goes_on(self):
        storage.dialogues.replace([talk(f'd{i}') for i in range(1, 4)])
        reading = Answer({'inDomain': True, 'start': 1, 'task': 'починить QR', 'object': 'QR'}, 'm')
        stuck = asyncio.Event()

        async def read(dialogue, agent):
            if dialogue['id'] == 'd3':
                stuck.set()
                await asyncio.Event().wait()  # never answers: the build is stopped here
            return reading

        with patch.object(catalog_role, 'episode', read):
            building = asyncio.create_task(catalog_flow.build())
            await stuck.wait()
            await asyncio.sleep(0)
            building.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await building
        self.assertEqual(sorted(catalog_flow.current()['episodes']), ['d1', 'd2'])

        placed = asyncio.Event()

        async def place(scenarios, items):
            if placed.is_set():
                await asyncio.Event().wait()  # the second batch never comes back
            placed.set()
            return Answer([(i['id'], 'c1s1') for i in items], 'm')

        proposed = Answer(catalog.taxonomy(PROPOSED), 'm')
        with (
            patch.object(catalog_role, 'episode', AsyncMock(return_value=reading)) as episode,
            patch.object(catalog_role, 'propose', AsyncMock(return_value=proposed)),
            patch.object(catalog_role, 'place', place),
            patch.object(catalog_flow, 'BATCH', 2),
        ):
            building = asyncio.create_task(catalog_flow.build())
            await placed.wait()
            await asyncio.sleep(0)
            building.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await building
        self.assertEqual(episode.await_count, 1)  # only d3 was left to read
        saved = catalog_flow.current()
        self.assertNotIn('categories', saved)  # no catalog in use yet: the proposal waits beside it
        self.assertEqual(len(saved['proposed']['placements']), 2)

        # One of the placed conversations changed meanwhile: its new reading is placed anew, not by the old placement.
        storage.dialogues.replace([talk('d1', 'Подключить QR'), talk('d2'), talk('d3')])
        with (
            patch.object(catalog_role, 'episode', AsyncMock(return_value=reading)) as episode,
            patch.object(catalog_role, 'propose', AsyncMock(side_effect=AssertionError('proposed again'))),
            patch.object(
                catalog_role, 'place', AsyncMock(return_value=Answer([('e1', 'c1s1'), ('e2', 'c1s1')], 'm'))
            ) as again,
        ):
            found = await catalog_flow.build()
        self.assertEqual((episode.await_count, again.await_count), (1, 1))
        self.assertEqual(len(again.await_args.args[1]), 2)  # d1, read again, and d3, never placed
        self.assertEqual(found['totals']['placed'], 3)
        self.assertNotIn('proposed', found)

    def deck_of(self, *episodes: tuple[str, str]) -> dict:
        """The check, the conversations and the catalog of a deck: (conversation, scenario) pairs."""
        rule = {'id': 'r', 'text': 'x', 'quote': 'y', 'observation': 'reply'}
        topic = {'id': 't1', 'title': 'Тариф', 'rules': [rule]}
        storage.documents.save(checks.result(checks.CODE), {'topics': [topic], 'results': []})
        storage.dialogues.replace([talk(dialogue_id) for dialogue_id, _ in episodes])
        read = {'inDomain': True, 'start': 1, 'task': 'починить QR', 'object': 'QR'}
        found = {i: dict(read, scenarioId=key) for i, key in episodes}
        return {'revision': 'r1', 'categories': catalog.taxonomy(PROPOSED), 'episodes': found}

    def building(self, found: dict, failing: set[str], tries: list[str] | None = None, eligible: bool = True):
        async def build_card(
            topic, dialogue, sets, general=(), scenario=None, start=None, end=None, agent=None, judged=True
        ):
            if tries is not None:
                tries.append(dialogue['id'])
            if dialogue['id'] in failing:
                raise models.ModelError('429')
            card = {'id': dialogue['id'], 'eligible': eligible, 'sets': list(sets), 'sourceDialogueId': dialogue['id']}
            return card if eligible else dict(card, reason='нет задачи')

        patches = (
            patch.object(deck_flow.catalog, 'build', AsyncMock(return_value=found)),
            patch.object(deck_flow, 'build_card', build_card),
        )
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    async def test_every_placed_conversation_gets_its_own_card_and_one_the_model_fails_is_tried_again(self):
        found = self.deck_of(('a', 'c1s1'), ('b', 'c1s1'), ('c', 'c1s1'), ('d', 'c2s1'))
        tries = []
        self.building(found, {'a'}, tries)
        deck = await deck_flow.built(checks.CODE)
        # Every conversation of a scenario is a customer of its own, however many the scenario has.
        self.assertEqual(sorted(card['sourceDialogueId'] for card in deck['cards']), ['b', 'c', 'd'])
        self.assertEqual(tries.count('a'), deck_flow.ROUNDS)
        representative = deck['sets']['representative']
        self.assertEqual(representative['failed'], [{'dialogueId': 'a', 'error': '429'}])
        self.assertEqual((representative['population'], representative['scenarios']), (4, 2))
        self.assertTrue(all('weight' not in card for card in deck['cards']))

    async def test_a_card_the_task_kept_before_a_restart_is_not_built_again(self):
        found = self.deck_of(('a', 'c1s1'), ('b', 'c2s1'))
        kept = {'id': 'a', 'eligible': True, 'sets': ['representative'], 'sourceDialogueId': 'a', 'kept': True}
        tries = []
        self.building(found, set(), tries)
        with patch.object(deck_flow.storage.tasks, 'steps', return_value={'card:a': kept}):
            deck = await deck_flow.built(checks.CODE)
        self.assertEqual(tries, ['b'])
        self.assertIn(kept, deck['cards'])

    async def test_a_deck_with_no_eligible_card_keeps_the_saved_one(self):
        self.building(self.deck_of(('a', 'c1s1'), ('c', 'c2s1')), set(), eligible=False)
        previous = {'cards': [{'id': 'previous'}]}
        storage.documents.save(checks.DECK, previous)
        with self.assertRaisesRegex(models.ModelError, 'нет задачи для сценария'):
            await deck_flow.build(checks.CODE, lambda **_: None)
        self.assertEqual(storage.documents.load(checks.DECK), previous)

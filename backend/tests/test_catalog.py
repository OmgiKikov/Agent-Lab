import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

import support

from lab import models, storage
from lab.domain import catalog, checks, metric
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
        self.assertEqual(
            catalog.checked_episode({'acquiring': True, 'start': 1, 'task': 'починить QR.', 'object': 'QR'}, dialogue),
            {'acquiring': True, 'start': 1, 'task': 'починить QR', 'object': 'QR'},
        )
        for wrong in ({'acquiring': True, 'start': 2, 'task': 'x'}, {'acquiring': True, 'start': 1, 'task': ' '}):
            with self.subTest(wrong=wrong), self.assertRaises(ValueError):
                catalog.checked_episode(wrong, dialogue)
        self.assertEqual(
            catalog.checked_episode({'acquiring': False, 'reason': 'приветствие', 'task': None}, dialogue),
            {'acquiring': False, 'reason': 'приветствие'},
        )
        # A model that leaves acquiring out: an answer with a task is an acquiring episode, one without is asked again.
        self.assertTrue(
            catalog.checked_episode({'start': 1, 'task': 'починить QR', 'object': None}, dialogue)['acquiring']
        )
        with self.assertRaises(ValueError):
            catalog.checked_episode({'start': 1, 'task': None}, dialogue)

    def test_the_catalog_is_proposed_from_a_sample_of_acquiring_episodes_the_same_every_time(self):
        episodes = {f'd{i}': {'acquiring': i % 4 != 0, 'task': f'задача {i}', 'object': 'x'} for i in range(40)}
        chosen = catalog.sample(episodes, 10)
        self.assertEqual(len(chosen), 10)
        self.assertTrue(all(e['acquiring'] for e in chosen.values()))
        self.assertEqual(chosen, catalog.sample(episodes, 10))
        self.assertEqual(len(catalog.sample(episodes, 100)), 30)

    def test_the_catalog_role_reads_each_task_once_with_its_count(self):
        episodes = {
            'a': {'acquiring': True, 'task': 'Починить QR', 'object': 'QR'},
            'b': {'acquiring': True, 'task': 'починить QR', 'object': 'qr'},
            'c': {'acquiring': True, 'task': 'узнать ставку', 'object': 'тариф'},
            'd': {'acquiring': False, 'reason': 'приветствие'},
        }
        self.assertEqual(
            catalog.distinct_tasks(episodes),
            [
                {'task': 'починить qr', 'object': 'qr', 'count': 2},
                {'task': 'узнать ставку', 'object': 'тариф', 'count': 1},
            ],
        )

    def test_every_scenario_gets_a_card_and_each_card_stands_for_its_share(self):
        groups = {'big': [f'b{i}' for i in range(90)], 'small': [f's{i}' for i in range(9)], 'rare': ['r0']}
        chosen, manifest = catalog.allocate(groups, 10)
        by_group = {key: [c for c in chosen if c[1] == key] for key in groups}
        self.assertEqual({key: len(found) for key, found in by_group.items()}, {'big': 9, 'small': 1, 'rare': 1})
        self.assertEqual({c[2] for c in by_group['big']}, {10.0})
        self.assertEqual(by_group['small'][0][2], 9.0)
        self.assertEqual(sum(c[2] for c in chosen), manifest['population'])
        self.assertEqual(chosen, catalog.allocate(groups, 10)[0])

    def test_the_catalog_counts_its_scenarios_and_shows_real_first_messages(self):
        categories = catalog.taxonomy(PROPOSED)
        dialogues = {i: talk(i, f'Сообщение {i}') for i in ('a', 'b', 'c', 'd', 'e')}
        episodes = {
            'a': {'acquiring': True, 'start': 1, 'task': 'починить QR', 'object': 'QR', 'scenarioId': 'c1s1'},
            'b': {'acquiring': True, 'start': 1, 'task': 'починить QR', 'object': 'QR', 'scenarioId': 'c1s1'},
            'c': {'acquiring': True, 'start': 1, 'task': 'узнать ставку', 'object': 'тариф', 'scenarioId': 'c2s1'},
            'd': {'acquiring': True, 'start': 1, 'task': 'зарплата', 'object': 'проект', 'scenarioId': catalog.NONE},
            'e': {'acquiring': False, 'reason': 'приветствие'},
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
                'acquiring': 4,
                'notAcquiring': 1,
                'unread': 0,
                'placed': 3,
                'unplaced': 1,
                'notYetPlaced': 0,
            },
        )

    async def test_a_build_reads_each_conversation_once_and_places_new_ones_into_the_frozen_catalog(self):
        storage.dialogues.replace([talk('a'), talk('b', 'Какая ставка?'), talk('g', 'Привет')])
        tasks = {'a': ('починить QR', 'QR'), 'b': ('узнать ставку', 'тариф')}

        async def episode(dialogue):
            if dialogue['id'] in tasks:
                task, thing = tasks[dialogue['id']]
                return Answer({'acquiring': True, 'start': 1, 'task': task, 'object': thing}, 'm')
            return Answer({'acquiring': False, 'reason': 'приветствие'}, 'm')

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
            self.assertEqual(first['totals']['notAcquiring'], 1)
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
        reading = Answer({'acquiring': True, 'start': 1, 'task': 'починить QR', 'object': 'QR'}, 'm')
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

    async def test_one_conversation_the_model_cannot_read_among_many_is_left_out(self):
        storage.dialogues.replace([talk(f'd{i}') for i in range(30)])
        reading = Answer({'acquiring': True, 'start': 1, 'task': 'починить QR', 'object': 'QR'}, 'm')

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

        reading = Answer({'acquiring': True, 'start': 1, 'task': 'починить QR', 'object': 'QR'}, 'm')
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

    async def test_the_deck_samples_every_scenario_and_names_it_on_its_cards(self):
        topic = {
            'id': 't1',
            'title': 'Tone of voice',
            'rules': [{'id': 't1r1', 'text': 'x', 'quote': 'y', 'observation': 'reply'}],
        }
        storage.documents.save(checks.result(checks.CODE), {'topics': [topic], 'results': []})
        storage.dialogues.replace([talk('a'), talk('b'), talk('c', 'Какая ставка?')])
        categories = catalog.taxonomy(PROPOSED)
        episodes = {
            'a': {'acquiring': True, 'start': 1, 'task': 'починить QR', 'object': 'QR', 'scenarioId': 'c1s1'},
            'b': {'acquiring': True, 'start': 1, 'task': 'починить QR', 'object': 'QR', 'scenarioId': 'c1s1'},
            'c': {'acquiring': True, 'start': 1, 'task': 'узнать ставку', 'object': 'тариф', 'scenarioId': 'c2s1'},
        }
        found = {'revision': 'r1', 'categories': categories, 'episodes': episodes}

        async def build_card(topic, dialogue, sets, general=(), reproduces=(), scenario=None, start=None):
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
        scenarios = {card['scenario']['id'] for card in deck['cards']}
        self.assertEqual(scenarios, {'c1s1', 'c2s1'})
        self.assertTrue(all('representative' in card['sets'] for card in deck['cards']))
        self.assertEqual(sum(card['weight'] for card in deck['cards']), 3)
        self.assertEqual(deck['sets']['representative']['strata'], 2)
        self.assertEqual(catalog.scenarios_of(categories)[catalog.NONE]['title'], 'Не попал в каталог')

    async def test_a_stopped_build_keeps_its_readings_proposal_and_placements_and_the_next_one_goes_on(self):
        storage.dialogues.replace([talk(f'd{i}') for i in range(1, 4)])
        reading = Answer({'acquiring': True, 'start': 1, 'task': 'починить QR', 'object': 'QR'}, 'm')
        stuck = asyncio.Event()

        async def read(dialogue):
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

        with (
            patch.object(catalog_role, 'episode', AsyncMock(return_value=reading)) as episode,
            patch.object(catalog_role, 'propose', AsyncMock(side_effect=AssertionError('proposed again'))),
            patch.object(catalog_role, 'place', AsyncMock(return_value=Answer([('e1', 'c1s1')], 'm'))) as again,
        ):
            found = await catalog_flow.build()
        self.assertEqual((episode.await_count, again.await_count), (0, 1))
        self.assertEqual(found['totals']['placed'], 3)
        self.assertNotIn('proposed', found)

    def test_a_card_stands_for_its_scenario_by_the_cards_it_actually_has(self):
        groups = {'big': [f'b{i}' for i in range(90)], 'small': [f's{i}' for i in range(10)]}
        # 9 + 1 sampled and 8 of the big scenario's cards lost: the one left stands for all 90, not for 10.
        weights, told = catalog.weighted(groups, {'b0': 'big', 's0': 'small'})
        self.assertEqual(weights, {'b0': 90.0, 's0': 10.0})
        self.assertTrue(told['complete'])
        # A scenario without a card: the others would stand for the whole export, so nobody gets a weight.
        weights, told = catalog.weighted(groups, {'b0': 'big'})
        self.assertEqual(weights, {})
        self.assertEqual(
            (told['complete'], told['missing'], told['coverage']),
            (False, [{'scenarioId': 'small', 'population': 10}], 0.9),
        )

    def test_a_lost_sampled_episode_is_replaced_from_its_own_scenario(self):
        groups = {'a': ['a1', 'a2', 'a3'], 'b': ['b1']}
        sampled = {'a1': 'a', 'b1': 'b'}
        found = catalog.replacements(groups, sampled, ['a1', 'b1'], {'a1', 'a2', 'b1'})
        self.assertEqual(found, [('a3', 'a')])  # b has no episode left
        self.assertEqual(found, catalog.replacements(groups, sampled, ['a1', 'b1'], {'a1', 'a2', 'b1'}))

    def deck_of(self, *episodes: tuple[str, str]) -> dict:
        """The check, the conversations and the catalog of a deck: (conversation, scenario) pairs."""
        rule = {'id': 'r', 'text': 'x', 'quote': 'y', 'observation': 'reply'}
        topic = {'id': 't1', 'title': 'Тариф', 'rules': [rule]}
        storage.documents.save(checks.result(checks.CODE), {'topics': [topic], 'results': []})
        storage.dialogues.replace([talk(dialogue_id) for dialogue_id, _ in episodes])
        read = {'acquiring': True, 'start': 1, 'task': 'починить QR', 'object': 'QR'}
        found = {i: dict(read, scenarioId=key) for i, key in episodes}
        return {'revision': 'r1', 'categories': catalog.taxonomy(PROPOSED), 'episodes': found}

    def building(self, found: dict, failing: set[str], tries: list[str] | None = None, eligible: bool = True):
        async def build_card(topic, dialogue, sets, general=(), reproduces=(), scenario=None, start=None):
            if tries is not None:
                tries.append(dialogue['id'])
            if dialogue['id'] in failing:
                raise models.ModelError('429')
            card = {'id': dialogue['id'], 'eligible': eligible, 'sets': list(sets), 'sourceDialogueId': dialogue['id']}
            return card if eligible else dict(card, reason='нет задачи')

        patches = (
            patch.object(deck_flow.catalog, 'build', AsyncMock(return_value=found)),
            patch.object(deck_flow, 'build_card', build_card),
            patch.object(deck_flow.scenarios, 'REPRESENTATIVE', 2),
        )
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    async def test_a_sampled_card_the_model_fails_is_tried_again_then_replaced_and_kept_in_the_manifest(self):
        found = self.deck_of(('a', 'c1s1'), ('b', 'c1s1'), ('c', 'c2s1'))
        lost = next(i for i, key, _ in catalog.allocate(catalog.strata(found['episodes']), 2)[0] if key == 'c1s1')
        other = ({'a', 'b'} - {lost}).pop()
        tries = []
        self.building(found, {lost}, tries)
        deck = await deck_flow.built(checks.CODE)
        self.assertEqual(tries.count(lost), deck_flow.ROUNDS)
        representative = deck['sets']['representative']
        self.assertEqual(representative['failed'], [{'dialogueId': lost, 'error': '429'}])
        self.assertEqual(representative['replacements'], [other])
        self.assertTrue(representative['complete'])
        self.assertEqual({card['sourceDialogueId']: card['weight'] for card in deck['cards']}, {other: 2.0, 'c': 1.0})

    async def test_a_scenario_left_without_a_card_makes_the_sample_incomplete_and_unweighted(self):
        self.building(self.deck_of(('a', 'c1s1'), ('c', 'c2s1')), {'a'})
        deck = await deck_flow.built(checks.CODE)
        representative = deck['sets']['representative']
        self.assertEqual((representative['complete'], representative['coverage']), (False, 0.5))
        self.assertEqual(representative['missing'], [{'scenarioId': 'c1s1', 'population': 1}])
        self.assertEqual([(card['sourceDialogueId'], card['weight']) for card in deck['cards']], [('c', None)])
        items = [{'cardId': 'c', 'status': 'PASS', 'sets': ['representative'], 'weight': None}]
        sets = metric.metric(items)['sets']
        self.assertTrue(sets['representative']['incomplete'])
        self.assertNotIn('weighted', sets['representative'])

    async def test_a_deck_with_no_eligible_card_keeps_the_saved_one(self):
        self.building(self.deck_of(('a', 'c1s1'), ('c', 'c2s1')), set(), eligible=False)
        previous = {'cards': [{'id': 'previous'}]}
        storage.documents.save(checks.DECK, previous)
        with self.assertRaisesRegex(models.ModelError, 'нет задачи для сценария'):
            await deck_flow.build(checks.CODE, lambda **_: None)
        self.assertEqual(storage.documents.load(checks.DECK), previous)

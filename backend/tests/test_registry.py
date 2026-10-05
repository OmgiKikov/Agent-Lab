import asyncio
import io
import json
import os
import sqlite3
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

import support

from lab import config, jobs, migrate, storage
from lab.app import create, lifespan
from lab.flows import connection
from lab.storage import registry


class RegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = support.lab(self)
        self.root = self.settings.data

    def test_the_registry_lives_beside_the_default_database(self) -> None:
        registry.create('Первый', '')
        self.assertTrue((self.root / 'agents.sqlite3').exists())
        self.assertEqual(registry.db_of('pervyy'), self.root / 'agents' / 'pervyy' / 'lab.sqlite3')

    def test_agents_get_readable_unique_ids_in_creation_order(self) -> None:
        first = registry.create('Агент эквайринга', 'СберБизнес · чат поддержки')
        second = registry.create('Агент эквайринга', '')
        self.assertEqual((first['id'], second['id']), ('agent-ekvayringa', 'agent-ekvayringa-2'))
        self.assertEqual(first['name'], 'Агент эквайринга')
        self.assertEqual([a['id'] for a in registry.listed()], ['agent-ekvayringa', 'agent-ekvayringa-2'])
        self.assertEqual(registry.default_id(), 'agent-ekvayringa')
        self.assertEqual(registry.get('agent-ekvayringa-2')['description'], '')
        self.assertIsNone(registry.get('missing'))

    def test_each_agent_reads_and_writes_only_its_own_database(self) -> None:
        first = registry.create('Первый', '')['id']
        second = registry.create('Второй', '')['id']
        with registry.using(first):
            storage.dialogues.replace([{'id': '1'}])
        with registry.using(second):
            self.assertEqual(storage.dialogues.read(), [])
        with registry.using(first):
            self.assertEqual(storage.dialogues.read(), [{'id': '1'}])
        self.assertTrue((self.root / 'agents' / first / 'lab.sqlite3').exists())
        self.assertEqual(storage.dialogues.read(), [])


class AgentRequestTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        support.serve(self, jobs.PerAgent())
        self.first = registry.create('Первый', '')['id']
        self.second = registry.create('Второй', '')['id']

    async def test_a_request_works_inside_the_agent_it_names(self) -> None:
        dialogue = {
            'id': 'd1',
            'messages': [{'role': 'user', 'content': 'Вопрос'}, {'role': 'assistant', 'content': 'Ответ'}],
        }
        response = await self.client.post(
            '/api/logs?name=x.jsonl', content=json.dumps(dialogue), headers={'X-Agent': self.first}
        )
        self.assertEqual(response.status_code, 200)
        first = (await self.client.get('/api/state', headers={'X-Agent': self.first})).json()
        second = (await self.client.get('/api/state', headers={'X-Agent': self.second})).json()
        self.assertEqual((first['logs']['total'], second['logs']['total']), (1, 0))
        self.assertEqual((await self.client.get('/api/state', headers={'X-Agent': 'nobody'})).status_code, 404)

    async def test_each_agent_has_its_own_job(self) -> None:
        release = asyncio.Event()

        async def slow(progress) -> None:
            await release.wait()

        with registry.using(self.first):
            self.jobs.start('discover', slow)
        await asyncio.sleep(0)
        second = (await self.client.get('/api/state', headers={'X-Agent': self.second})).json()
        first = (await self.client.get('/api/state', headers={'X-Agent': self.first})).json()
        self.assertEqual((first['job']['running'], second['job']['running']), (True, False))
        with registry.using(self.second):
            self.assertEqual(self.jobs.start('discover', slow), {'ok': True})
        release.set()

    async def test_a_job_writes_into_the_agent_it_was_started_in(self) -> None:
        release = asyncio.Event()

        async def work(progress) -> None:
            await release.wait()
            storage.documents.save('marker.json', {'agent': 'first'})

        with registry.using(self.first):
            self.jobs.start('discover', work)
        await self.client.get('/api/state', headers={'X-Agent': self.second})
        release.set()
        for _ in range(50):
            await asyncio.sleep(0.01)
            with registry.using(self.first):
                if not self.jobs.state['running']:
                    break
        with registry.using(self.first):
            self.assertEqual(storage.documents.load('marker.json'), {'agent': 'first'})
        with registry.using(self.second):
            self.assertIsNone(storage.documents.load('marker.json'))
        self.assertIsNone(storage.documents.load('marker.json'))

    async def test_a_deleted_agent_leaves_the_list_and_its_data_is_moved_aside(self) -> None:
        with registry.using(self.first):
            storage.dialogues.replace([{'id': '1'}])
        response = await self.client.post('/api/agents/delete', json={'id': self.first})
        self.assertEqual(response.status_code, 200)
        self.assertEqual([a['id'] for a in (await self.client.get('/api/agents')).json()], [self.second])
        self.assertFalse(registry.db_of(self.first).parent.exists())
        (kept,) = (self.settings.data / 'deleted').iterdir()
        self.assertTrue(kept.name.startswith(self.first + '-'))
        self.assertTrue((kept / 'lab.sqlite3').is_file())
        self.assertEqual((await self.client.get('/api/state', headers={'X-Agent': self.first})).status_code, 404)
        # Moved out of data/agents/, the folder is not found again on the next start.
        self.assertEqual(registry.recover_lost(), [])
        self.assertEqual((await self.client.post('/api/agents/delete', json={'id': self.first})).status_code, 404)

    async def test_an_agent_is_not_deleted_while_its_task_runs(self) -> None:
        release = asyncio.Event()

        async def slow(progress) -> None:
            await release.wait()

        with registry.using(self.first):
            self.jobs.start('discover', slow)
        await asyncio.sleep(0)
        response = await self.client.post('/api/agents/delete', json={'id': self.first})
        self.assertEqual(response.status_code, 409)
        self.assertIn('идёт задача', response.json()['detail'])
        self.assertIsNotNone(registry.get(self.first))
        release.set()

    async def test_agents_are_listed_with_the_result_of_each_check_and_created_by_name(self) -> None:
        with registry.using(self.first):
            summary = {'checked': 100, 'measured': 92, 'failed': 78, 'passed': 14, 'unmeasured': 8}
            storage.documents.save(
                'tone-result.json',
                {'purpose': 'tone-of-voice', 'finishedAt': '2026-10-02T20:41:53+00:00', 'summary': summary},
            )
            summary = {'checked': 60, 'measured': 50, 'failed': 5, 'passed': 45, 'unmeasured': 10}
            storage.documents.save('discover.json', {'finishedAt': '2026-10-01T09:00:00+00:00', 'summary': summary})
        response = await self.client.post('/api/agents', json={'name': 'Кредитный агент', 'description': 'Кредиты'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['id'], 'kreditnyy-agent')
        self.assertEqual((await self.client.post('/api/agents', json={'name': ' '})).status_code, 400)
        listed = (await self.client.get('/api/agents')).json()
        self.assertEqual([a['id'] for a in listed], [self.first, self.second, 'kreditnyy-agent'])
        self.assertEqual(
            listed[0]['results'],
            {
                'tone': {'failed': 78, 'measured': 92, 'unmeasured': 8, 'finishedAt': '2026-10-02T20:41:53+00:00'},
                'code': {'failed': 5, 'measured': 50, 'unmeasured': 10, 'finishedAt': '2026-10-01T09:00:00+00:00'},
            },
        )
        self.assertEqual(listed[1]['results'], {'tone': None, 'code': None})
        self.assertNotIn('result', listed[0])

    async def test_the_agent_connection_check_works_inside_the_agent(self) -> None:
        with registry.using(self.first):
            storage.documents.save('settings.json', {'prodUrl': 'http://agent.example/chat'})
        seen = {}
        original = connection.ways

        def ways() -> dict:
            seen['url'] = original()['prod']['url']
            return {}

        with patch.object(connection, 'ways', side_effect=ways):
            await self.client.post('/api/agents/prod/check', headers={'X-Agent': self.first})
        self.assertEqual(seen.get('url'), 'http://agent.example/chat')

    async def test_a_broken_result_of_one_agent_does_not_hide_the_others(self) -> None:
        with registry.using(self.first):
            storage.documents.save(
                'discover.json', {'finishedAt': '2026-10-02T20:41:53+00:00', 'summary': {'checked': 3}}
            )
        response = await self.client.get('/api/agents')
        self.assertEqual(response.status_code, 200)
        self.assertEqual([a['results'] for a in response.json()], [{'tone': None, 'code': None}] * 2)


class AdoptionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = support.lab(self)
        self.root = self.settings.data

    def test_the_existing_database_becomes_the_first_agent_once(self) -> None:
        storage.dialogues.replace([{'id': 'd1'}])
        registry.adopt_legacy()
        self.assertEqual(
            [(a['id'], a['name'], a['description']) for a in registry.listed()],
            [('acquiring', 'Агент эквайринга', 'СберБизнес · чат поддержки')],
        )
        with registry.using('acquiring'):
            self.assertEqual(storage.dialogues.read(), [{'id': 'd1'}])
        self.assertFalse((self.root / 'lab.sqlite3').exists())
        self.assertTrue((self.root / 'lab.sqlite3.before-agents').exists())
        registry.adopt_legacy()
        self.assertEqual(len(registry.listed()), 1)

    def test_starting_after_the_adoption_leaves_no_empty_database_behind(self) -> None:
        storage.dialogues.replace([{'id': 'd1'}])

        async def start() -> None:
            async with lifespan(create(self.settings)):
                pass

        asyncio.run(start())
        self.assertEqual([a['id'] for a in registry.listed()], ['acquiring'])
        self.assertFalse((self.root / 'lab.sqlite3').exists())

    def test_adoption_never_overwrites_an_adopted_database_or_its_backup(self) -> None:
        storage.dialogues.replace([{'id': 'real'}])
        registry.adopt_legacy()
        (self.root / 'agents.sqlite3').unlink()  # the registry lost
        storage.dialogues.replace([{'id': 'stray'}])
        registry.adopt_legacy()
        with registry.using('acquiring'):
            self.assertEqual(storage.dialogues.read(), [{'id': 'real'}])
        with sqlite3.connect(self.root / 'lab.sqlite3.before-agents') as backup:
            rows = backup.execute('SELECT value FROM dialogues').fetchall()
        self.assertEqual([json.loads(value) for (value,) in rows], [{'id': 'real'}])
        self.assertEqual([a['id'] for a in registry.listed()], ['acquiring'])

    def test_an_empty_database_is_not_adopted(self) -> None:
        with sqlite3.connect(self.root / 'lab.sqlite3'):
            pass
        registry.adopt_legacy()
        self.assertEqual(registry.listed(), [])

    def test_a_fresh_start_creates_no_database(self) -> None:
        async def start() -> None:
            async with lifespan(create(self.settings)):
                pass

        asyncio.run(start())
        self.assertFalse((self.root / 'lab.sqlite3').exists())

    def test_a_fresh_install_starts_without_agents(self) -> None:
        registry.adopt_legacy()
        self.assertEqual(registry.listed(), [])

    def test_an_agent_given_by_its_id_is_never_a_second_empty_one(self) -> None:
        registry.create('Агент эквайринга', agent_id='acquiring')
        with self.assertRaises(ValueError):
            registry.create('Агент эквайринга', agent_id='acquiring')
        self.assertEqual([a['id'] for a in registry.listed()], ['acquiring'])
        self.assertEqual(registry.create('Агент эквайринга')['id'], 'agent-ekvayringa')

    def test_agents_whose_registry_is_lost_are_found_on_the_next_start(self) -> None:
        for name, agent_id in (('Агент эквайринга', 'acquiring'), ('Агент кредитов', None), ('Пустой', None)):
            created = registry.create(name, agent_id=agent_id)['id']
            if name != 'Пустой':
                with registry.using(created):
                    storage.dialogues.replace([{'id': 'd1'}])
        (self.root / 'agents.sqlite3').unlink()

        async def start() -> None:
            async with lifespan(create(self.settings)):
                pass

        asyncio.run(start())
        self.assertEqual(
            [(a['id'], a['name']) for a in registry.listed()],
            [('acquiring', 'Агент эквайринга'), ('agent-kreditov', 'agent-kreditov')],
        )
        with registry.using('agent-kreditov'):
            self.assertEqual(storage.dialogues.read(), [{'id': 'd1'}])

    def test_a_second_lab_on_the_same_data_recovers_nothing_and_says_why(self) -> None:
        storage.dialogues.replace([{'id': 'd1'}])

        async def start() -> None:
            async with lifespan(create(self.settings)):
                pass

        with (
            registry.only_process(),
            patch.object(storage.runs, 'recover') as recover,
            self.assertRaises(RuntimeError) as refused,
        ):
            asyncio.run(start())
        self.assertIn('уже работает', str(refused.exception))
        self.assertIn('LAB_DATA', str(refused.exception))
        recover.assert_not_called()
        self.assertEqual(registry.listed(), [])  # the old database is not adopted twice
        asyncio.run(start())  # the first one gone, the lock goes with it
        self.assertEqual([a['id'] for a in registry.listed()], ['acquiring'])

    def test_the_folders_of_the_lab_are_readable_by_its_user_only(self) -> None:
        nested = self.root / 'data' / 'lab.sqlite3'
        with config.using(support.changed(self.settings, data=nested.parent)):
            agent = registry.create('Агент эквайринга')['id']
            for folder in (nested.parent, nested.parent / 'agents', registry.db_of(agent).parent):
                with self.subTest(folder=folder.name):
                    self.assertEqual(folder.stat().st_mode & 0o777, 0o700)


class LegacyImportTests(unittest.TestCase):
    """python -m lab.migrate writes where the app reads: into an agent's database."""

    def setUp(self) -> None:
        self.settings = support.lab(self)
        self.root = self.settings.data
        self.legacy = self.root / 'legacy'
        self.legacy.mkdir()
        dialogue = {'id': 'd1', 'messages': [{'role': 'user', 'content': 'Q'}, {'role': 'assistant', 'content': 'A'}]}
        (self.legacy / 'logs.jsonl').write_text(json.dumps(dialogue) + '\n')

    def run_import(self, *arguments: str) -> dict:
        printed = io.StringIO()
        with (
            patch.object(sys, 'argv', ['migrate', '--source', str(self.legacy), *arguments]),
            patch.dict(os.environ, {'LAB_DATA': str(self.root)}),
            redirect_stdout(printed),
        ):
            migrate.main()
        return json.loads(printed.getvalue())

    def refused(self, *arguments: str) -> str:
        said = io.StringIO()
        with redirect_stderr(said), self.assertRaises(SystemExit):
            self.run_import(*arguments)
        return said.getvalue()

    def logs_of(self, agent_id: str) -> list:
        with registry.using(agent_id):
            return storage.dialogues.read()

    def test_without_agents_the_import_waits_in_the_database_the_next_start_adopts(self) -> None:
        self.assertEqual(self.run_import()['agent'], None)
        self.assertEqual(len(storage.dialogues.read()), 1)
        registry.adopt_legacy()
        self.assertEqual(len(self.logs_of('acquiring')), 1)

    def test_the_only_agent_receives_the_import(self) -> None:
        only = registry.create('Агент эквайринга')['id']
        self.assertEqual(self.run_import()['agent'], only)
        self.assertEqual(len(self.logs_of(only)), 1)
        self.assertFalse(storage.db.default_database().exists())

    def test_with_several_agents_the_import_is_told_which(self) -> None:
        first = registry.create('Первый')['id']
        second = registry.create('Второй')['id']
        for arguments in ((), ('--agent', 'nobody')):
            with self.subTest(arguments=arguments):
                said = self.refused(*arguments)
                self.assertIn(f'{first}, {second}', said)
                self.assertIn('--agent', said)
        self.assertEqual(self.run_import('--agent', second)['agent'], second)
        self.assertEqual((len(self.logs_of(first)), len(self.logs_of(second))), (0, 1))
        self.assertFalse(storage.db.default_database().exists())

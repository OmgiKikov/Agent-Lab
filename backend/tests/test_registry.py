import asyncio
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import httpx

from lab import api, jobs, logs, migrate, registry, store


class RegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        mocked = patch.object(store, 'DB', self.root / 'lab.sqlite3')
        mocked.start()
        self.addCleanup(mocked.stop)

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
            store.save('logs.json', [{'id': '1'}])
        with registry.using(second):
            self.assertIsNone(store.load('logs.json'))
        with registry.using(first):
            self.assertEqual(store.load('logs.json'), [{'id': '1'}])
        self.assertTrue((self.root / 'agents' / first / 'lab.sqlite3').exists())
        self.assertIsNone(store.load('logs.json'))


class AgentRequestTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        for mocked in (patch.object(store, 'DB', root / 'lab.sqlite3'), patch.object(api, 'jobs', jobs.PerAgent())):
            mocked.start()
            self.addCleanup(mocked.stop)
        self.first = registry.create('Первый', '')['id']
        self.second = registry.create('Второй', '')['id']
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url='http://test')

    async def asyncTearDown(self) -> None:
        await api.jobs.close()
        await self.client.aclose()

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
            api.jobs.start('discover', slow)
        await asyncio.sleep(0)
        second = (await self.client.get('/api/state', headers={'X-Agent': self.second})).json()
        first = (await self.client.get('/api/state', headers={'X-Agent': self.first})).json()
        self.assertEqual((first['job']['running'], second['job']['running']), (True, False))
        with registry.using(self.second):
            self.assertEqual(api.jobs.start('discover', slow), {'ok': True})
        release.set()

    async def test_a_job_writes_into_the_agent_it_was_started_in(self) -> None:
        release = asyncio.Event()

        async def work(progress) -> None:
            await release.wait()
            store.save('marker.json', {'agent': 'first'})

        with registry.using(self.first):
            api.jobs.start('discover', work)
        await self.client.get('/api/state', headers={'X-Agent': self.second})
        release.set()
        for _ in range(50):
            await asyncio.sleep(0.01)
            with registry.using(self.first):
                if not api.jobs.state['running']:
                    break
        with registry.using(self.first):
            self.assertEqual(store.load('marker.json'), {'agent': 'first'})
        with registry.using(self.second):
            self.assertIsNone(store.load('marker.json'))
        self.assertIsNone(store.load('marker.json'))

    async def test_agents_are_listed_with_the_result_of_each_check_and_created_by_name(self) -> None:
        with registry.using(self.first):
            summary = {'checked': 100, 'measured': 92, 'failed': 78, 'passed': 14, 'unmeasured': 8}
            store.save(
                'tone-result.json',
                {'purpose': 'tone-of-voice', 'finishedAt': '2026-10-02T20:41:53+00:00', 'summary': summary},
            )
            summary = {'checked': 60, 'measured': 50, 'failed': 5, 'passed': 45, 'unmeasured': 10}
            store.save('discover.json', {'finishedAt': '2026-10-01T09:00:00+00:00', 'summary': summary})
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
            store.save('settings.json', {'prodUrl': 'http://agent.example/chat'})
        seen = {}
        original = api.agents.configs

        def configs() -> dict:
            seen['url'] = original()['prod']['url']
            return {}

        with patch.object(api.agents, 'configs', side_effect=configs):
            await self.client.post('/api/agents/prod/check', headers={'X-Agent': self.first})
        self.assertEqual(seen.get('url'), 'http://agent.example/chat')

    async def test_a_broken_result_of_one_agent_does_not_hide_the_others(self) -> None:
        with registry.using(self.first):
            store.save('discover.json', {'finishedAt': '2026-10-02T20:41:53+00:00', 'summary': {'checked': 3}})
        response = await self.client.get('/api/agents')
        self.assertEqual(response.status_code, 200)
        self.assertEqual([a['results'] for a in response.json()], [{'tone': None, 'code': None}] * 2)


class AdoptionTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        mocked = patch.object(store, 'DB', self.root / 'lab.sqlite3')
        mocked.start()
        self.addCleanup(mocked.stop)

    def test_the_existing_database_becomes_the_first_agent_once(self) -> None:
        store.save('logs.json', [{'id': 'd1'}])
        registry.adopt_legacy()
        self.assertEqual(
            [(a['id'], a['name'], a['description']) for a in registry.listed()],
            [('acquiring', 'Агент эквайринга', 'СберБизнес · чат поддержки')],
        )
        with registry.using('acquiring'):
            self.assertEqual(store.load('logs.json'), [{'id': 'd1'}])
        self.assertFalse((self.root / 'lab.sqlite3').exists())
        self.assertTrue((self.root / 'lab.sqlite3.before-agents').exists())
        registry.adopt_legacy()
        self.assertEqual(len(registry.listed()), 1)

    def test_starting_after_the_adoption_leaves_no_empty_database_behind(self) -> None:
        store.save('logs.json', [{'id': 'd1'}])

        async def start() -> None:
            async with api.lifespan(api.app):
                pass

        with patch.object(api, 'jobs', jobs.PerAgent()):
            asyncio.run(start())
        self.assertEqual([a['id'] for a in registry.listed()], ['acquiring'])
        self.assertFalse((self.root / 'lab.sqlite3').exists())

    def test_adoption_never_overwrites_an_adopted_database_or_its_backup(self) -> None:
        store.save('logs.json', [{'id': 'real'}])
        registry.adopt_legacy()
        (self.root / 'agents.sqlite3').unlink()  # the registry lost
        store.save('logs.json', [{'id': 'stray'}])
        registry.adopt_legacy()
        with registry.using('acquiring'):
            self.assertEqual(store.load('logs.json'), [{'id': 'real'}])
        with sqlite3.connect(self.root / 'lab.sqlite3.before-agents') as backup:
            row = backup.execute("SELECT value FROM documents WHERE name = 'logs.json'").fetchone()
        self.assertEqual(json.loads(row[0]), [{'id': 'real'}])
        self.assertEqual([a['id'] for a in registry.listed()], ['acquiring'])

    def test_an_empty_database_is_not_adopted(self) -> None:
        with sqlite3.connect(self.root / 'lab.sqlite3'):
            pass
        registry.adopt_legacy()
        self.assertEqual(registry.listed(), [])

    def test_a_fresh_start_creates_no_database(self) -> None:
        async def start() -> None:
            async with api.lifespan(api.app):
                pass

        with patch.object(api, 'jobs', jobs.PerAgent()):
            asyncio.run(start())
        self.assertFalse((self.root / 'lab.sqlite3').exists())

    def test_a_fresh_install_starts_without_agents(self) -> None:
        registry.adopt_legacy()
        self.assertEqual(registry.listed(), [])


class LegacyImportTests(unittest.TestCase):
    """python -m lab.migrate writes where the app reads: into an agent's database."""

    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        mocked = patch.object(store, 'DB', self.root / 'lab.sqlite3')
        mocked.start()
        self.addCleanup(mocked.stop)
        self.legacy = self.root / 'legacy'
        self.legacy.mkdir()
        dialogue = {'id': 'd1', 'messages': [{'role': 'user', 'content': 'Q'}, {'role': 'assistant', 'content': 'A'}]}
        (self.legacy / 'logs.jsonl').write_text(json.dumps(dialogue) + '\n')

    def run_import(self, *arguments: str) -> dict:
        printed = io.StringIO()
        with patch.object(sys, 'argv', ['migrate', '--source', str(self.legacy), *arguments]), redirect_stdout(printed):
            migrate.main()
        return json.loads(printed.getvalue())

    def refused(self, *arguments: str) -> str:
        said = io.StringIO()
        with redirect_stderr(said), self.assertRaises(SystemExit):
            self.run_import(*arguments)
        return said.getvalue()

    def logs_of(self, agent_id: str) -> list:
        with registry.using(agent_id):
            return store.load(logs.FILE) or []

    def test_without_agents_the_import_waits_in_the_database_the_next_start_adopts(self) -> None:
        self.assertEqual(self.run_import()['agent'], None)
        self.assertEqual(len(store.load(logs.FILE)), 1)
        registry.adopt_legacy()
        self.assertEqual(len(self.logs_of('acquiring')), 1)

    def test_the_only_agent_receives_the_import(self) -> None:
        only = registry.create('Агент эквайринга')['id']
        self.assertEqual(self.run_import()['agent'], only)
        self.assertEqual(len(self.logs_of(only)), 1)
        self.assertFalse(store.DB.exists())

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
        self.assertFalse(store.DB.exists())

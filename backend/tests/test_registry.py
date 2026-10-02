import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

from lab import api, discover, jobs, registry, store


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

    async def test_agents_are_listed_with_their_last_result_and_created_by_name(self) -> None:
        with registry.using(self.first):
            summary = {'checked': 100, 'measured': 92, 'failed': 78, 'passed': 14, 'unmeasured': 8}
            store.save(
                'discover.json',
                {'purpose': discover.TONE, 'finishedAt': '2026-10-02T20:41:53+00:00', 'summary': summary},
            )
        response = await self.client.post('/api/agents', json={'name': 'Кредитный агент', 'description': 'Кредиты'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['id'], 'kreditnyy-agent')
        self.assertEqual((await self.client.post('/api/agents', json={'name': ' '})).status_code, 400)
        listed = (await self.client.get('/api/agents')).json()
        self.assertEqual([a['id'] for a in listed], [self.first, self.second, 'kreditnyy-agent'])
        self.assertEqual(
            listed[0]['result'],
            {
                'failed': 78,
                'measured': 92,
                'unmeasured': 8,
                'finishedAt': '2026-10-02T20:41:53+00:00',
                'metric': 'Tone of voice',
            },
        )
        self.assertIsNone(listed[1]['result'])


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

    def test_a_fresh_install_starts_without_agents(self) -> None:
        registry.adopt_legacy()
        self.assertEqual(registry.listed(), [])

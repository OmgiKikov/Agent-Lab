import asyncio
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

from lab import api, store
from lab.jobs import Jobs


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for mocked in (
            patch.object(store, 'DB', Path(directory.name) / 'lab.sqlite3'),
            patch.object(api, 'jobs', Jobs()),
        ):
            mocked.start()
            self.addCleanup(mocked.stop)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url='http://test')

    async def asyncTearDown(self) -> None:
        await api.jobs.close()
        await self.client.aclose()

    async def test_uploaded_log_transcript_has_current_evaluation(self) -> None:
        dialogue = {
            'id': 'dialogue-1',
            'messages': [{'role': 'user', 'content': 'question'}, {'role': 'assistant', 'content': 'answer'}],
        }
        response = await self.client.post('/api/logs?name=sample.jsonl', content=json.dumps(dialogue))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'total': 1})
        response = await self.client.get('/api/logs/dialogue-1')
        self.assertEqual(response.json(), {**dialogue, 'evaluation': None})
        evaluation = {'dialogueId': 'dialogue-1', 'status': 'FAIL'}
        store.save(api.discover.RESULT, {'results': [evaluation]})
        response = await self.client.get('/api/logs/dialogue-1')
        self.assertEqual(response.json()['evaluation'], evaluation)
        self.assertEqual((await self.client.get('/api/logs/missing')).status_code, 404)

    async def test_an_article_the_agent_read_comes_from_its_knowledge_base(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            kb = repo / api.knowledge.KB
            kb.parent.mkdir(parents=True)
            article = {'id': 'возвраты', 'title': 'Как оформить возврат', 'passages': ['Откройте раздел.', 'Нажмите.']}
            kb.write_text(json.dumps({'articles': [article]}))
            with patch.object(api.knowledge.agents, 'repo', return_value=repo):
                response = await self.client.get('/api/articles/возвраты')
                self.assertEqual(
                    response.json(),
                    {'article': 'возвраты', 'title': 'Как оформить возврат', 'text': 'Откройте раздел.\nНажмите.'},
                )
                self.assertEqual((await self.client.get('/api/articles/нет-такой')).status_code, 404)

    async def test_failed_upload_keeps_inputs_and_derived_documents(self) -> None:
        store.save(api.logs.FILE, [{'id': 'old'}])
        store.save(api.discover.RESULT, {'results': ['old']})
        store.save(api.cards.DECK, {'cards': ['old']})
        response = await self.client.post('/api/logs?name=broken.xlsx', content=b'not a workbook')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(store.load(api.logs.FILE), [{'id': 'old'}])
        self.assertEqual(store.load(api.discover.RESULT), {'results': ['old']})
        self.assertEqual(store.load(api.cards.DECK), {'cards': ['old']})

    async def test_successful_upload_invalidates_old_audit_and_scenarios(self) -> None:
        store.save(api.discover.RESULT, {'results': ['old']})
        store.save(api.cards.DECK, {'cards': ['old']})
        dialogue = {
            'id': 'new',
            'messages': [{'role': 'user', 'content': 'question'}, {'role': 'assistant', 'content': 'answer'}],
        }
        response = await self.client.post('/api/logs?name=sample.jsonl', content=json.dumps(dialogue))
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(store.load(api.discover.RESULT))
        self.assertIsNone(store.load(api.cards.DECK))

    async def test_criteria_extracted_anew_drop_the_cards_built_from_the_old_ones(self) -> None:
        audit = {'topics': [], 'results': []}
        for replan, kept in ((False, True), (True, False)):
            with self.subTest(replan=replan):
                store.save(api.cards.DECK, {'cards': ['built from the previous criteria']})
                with patch.object(api.discover, 'run', AsyncMock(return_value=audit)):
                    response = await self.client.post('/api/discover', json={'count': 5, 'replan': replan})
                    self.assertEqual(response.status_code, 200, response.text)
                    for _ in range(100):
                        if not api.jobs.state['running']:
                            break
                        await asyncio.sleep(0.002)
                self.assertIsNone(api.jobs.state['error'])
                self.assertEqual(store.load(api.discover.RESULT), audit)
                self.assertEqual(store.load(api.cards.DECK) is not None, kept)

    async def test_stopped_source_worker_cannot_publish_or_invalidate_previous_analysis(self) -> None:
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        store.save(api.sources.FILE, [{'id': 'old'}])
        store.save(api.discover.RESULT, {'results': ['old']})
        store.save(api.cards.DECK, {'cards': ['old']})

        def collect(repo) -> list[dict]:
            entered.set()
            release.wait(timeout=5)
            finished.set()
            return [{'id': 'new'}]

        with patch.object(api.sources, 'collect', side_effect=collect):
            try:
                response = await self.client.post('/api/sources')
                self.assertEqual(response.status_code, 200)
                self.assertTrue(await asyncio.to_thread(entered.wait, 2))
                response = await self.client.post('/api/job/stop')
                self.assertEqual(response.status_code, 200)
                self.assertFalse(api.jobs.state['running'])
            finally:
                release.set()
                await asyncio.to_thread(finished.wait, 2)
                await asyncio.sleep(0)
        self.assertEqual(store.load(api.sources.FILE), [{'id': 'old'}])
        self.assertEqual(store.load(api.discover.RESULT), {'results': ['old']})
        self.assertEqual(store.load(api.cards.DECK), {'cards': ['old']})

    async def test_upload_and_other_commands_share_exclusivity(self) -> None:
        entered, release = asyncio.Event(), asyncio.Event()

        async def work(progress) -> None:
            entered.set()
            await release.wait()

        api.jobs.start('discover', work)
        await entered.wait()
        response = await self.client.post('/api/logs?name=sample.jsonl', content='{}')
        self.assertEqual(response.status_code, 409)
        response = await self.client.post('/api/cards')
        self.assertEqual(response.status_code, 409)
        response = await self.client.post('/api/job/stop')
        self.assertEqual(response.status_code, 200)
        self.assertFalse(api.jobs.state['running'])

    async def test_settings_cannot_change_under_an_active_job(self) -> None:
        store.save(api.agents.SETTINGS, {'repo': '/old/agent'})
        entered = asyncio.Event()

        async def work(progress) -> None:
            entered.set()
            await asyncio.Event().wait()

        api.jobs.start('run', work)
        await entered.wait()
        response = await self.client.post('/api/settings', json={'repo': '/new/agent'})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(api.agents.settings()['repo'], '/old/agent')
        await self.client.post('/api/job/stop')
        response = await self.client.post('/api/settings', json={'repo': '/new/agent'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(api.agents.settings()['repo'], '/new/agent')

    async def test_agent_check_uses_session_and_closes_before_returning(self) -> None:
        agent = api.agents.HttpAgent({'url': 'http://unused.test', 'profile': 'prod'})
        reply = {'text': 'answer', 'status': '200', 'ok': True, 'options': []}
        with (
            patch.object(api.agents, 'create', return_value=agent),
            patch.object(agent, 'open', new=AsyncMock()) as opened,
            patch.object(agent, 'say', new=AsyncMock(return_value=reply)),
            patch.object(agent, 'close', new=AsyncMock()) as closed,
        ):
            response = await self.client.post('/api/agents/prod/check')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['text'], 'answer')
        opened.assert_awaited_once()
        closed.assert_awaited_once()

    async def test_agent_check_open_failure_still_closes(self) -> None:
        agent = api.agents.HttpAgent({'url': 'http://unused.test', 'profile': 'prod'})
        with (
            patch.object(api.agents, 'create', return_value=agent),
            patch.object(agent, 'open', new=AsyncMock(side_effect=api.agents.AgentError('not reachable'))),
            patch.object(agent, 'say', new=AsyncMock()) as said,
            patch.object(agent, 'close', new=AsyncMock()) as closed,
        ):
            response = await self.client.post('/api/agents/prod/check')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'ok': False, 'error': 'not reachable'})
        said.assert_not_awaited()
        closed.assert_awaited_once()

    async def test_malformed_commands_are_validation_errors(self) -> None:
        for route, payload in (
            ('/api/discover', {'count': 'invalid'}),
            ('/api/runs', {'target': 'prod', 'repeats': 0}),
            ('/api/settings', {'epk': {'unexpected': 'shape'}}),
            ('/api/settings', {'repo': []}),
            ('/api/review', {'run': 'run-1', 'index': True, 'decision': 'agree'}),
            ('/api/review', {'run': 'run-1', 'index': 0, 'decision': 'invalid'}),
        ):
            response = await self.client.post(route, json=payload)
            self.assertEqual(response.status_code, 422, (route, response.text))

    async def test_cards_requires_post_and_commits_a_finished_deck(self) -> None:
        done = asyncio.Event()

        async def build(progress) -> list[dict]:
            done.set()
            return [{'id': 'card-1'}]

        with patch.object(api.cards, 'run', side_effect=build):
            self.assertEqual((await self.client.get('/api/cards')).status_code, 405)
            response = await self.client.post('/api/cards')
            self.assertEqual(response.status_code, 200)
            await done.wait()
        self.assertEqual(store.load(api.cards.DECK)['cards'], [{'id': 'card-1'}])

    async def test_review_and_state_expose_current_revision(self) -> None:
        store.create_run({'id': 'run-1', 'items': [{'cardId': 'card-1', 'status': 'PASS'}]})
        response = await self.client.post('/api/review', json={'run': 'run-1', 'index': 0, 'decision': 'disagree'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['metric']['human']['agree'], 0)
        state = (await self.client.get('/api/state')).json()
        self.assertEqual(state['runs'][0]['revision'], 2)
        self.assertTrue(state['runs'][0]['updatedAt'])
        self.assertNotIn('workshop', state)

    async def test_startup_recovers_interrupted_run_and_retains_finished_items_and_reviews(self) -> None:
        store.create_run(
            {
                'id': 'interrupted',
                'status': 'running',
                'items': [
                    {'cardId': 'finished', 'status': 'PASS', 'review': 'disagree'},
                    {'cardId': 'pending', 'status': 'RUNNING', 'stage': 'agent answers'},
                ],
            }
        )
        async with api.app.router.lifespan_context(api.app):
            result = (await self.client.get('/api/runs/interrupted')).json()
            self.assertEqual(result['status'], 'stopped')
            self.assertTrue(result['finishedAt'])
            self.assertEqual(result['items'][0]['status'], 'PASS')
            self.assertEqual(result['items'][0]['review'], 'disagree')
            self.assertEqual(result['items'][1]['status'], 'UNMEASURED')
            self.assertEqual(result['items'][1]['stage'], '')
            self.assertEqual(result['revision'], 2)
        self.assertEqual(store.recover_runs(), 0)


if __name__ == '__main__':
    unittest.main()

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

    async def test_a_broken_export_is_refused_in_words_a_person_can_act_on(self) -> None:
        response = await self.client.post('/api/logs?name=export.jsonl', content='id;client;agent\n1;Здравствуйте')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()['detail'],
            'Не удалось прочитать файл: Строка 1 файла .jsonl не читается как JSON: проверьте, что это выгрузка чата, '
            'по одному разговору в строке.',
        )

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
                store.save(api.cards.DECK, {'check': 'code', 'cards': ['built from the previous criteria']})
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

    async def test_an_audit_the_model_could_not_answer_keeps_the_previous_one_and_its_scenarios(self) -> None:
        dialogue = {
            'id': 'd1',
            'messages': [{'role': 'user', 'content': 'Вопрос'}, {'role': 'assistant', 'content': 'Ответ'}],
        }
        store.save(api.logs.FILE, [dialogue])
        store.save(
            api.sources.FILE, [{'id': 's1', 'kind': 'prompt', 'origin': 'agent.py', 'content': 'Отвечай по делу.'}]
        )
        rule = {'id': 't1r1', 'text': 'Отвечает по делу', 'quote': 'Отвечай по делу', 'sourceId': 's1'}
        previous = {
            'finishedAt': '2026-10-01T10:00:00+00:00',
            'topics': [{'id': 't1', 'title': 'Вопросы', 'dialogueIds': ['d1'], 'rules': [rule]}],
            'results': [{'dialogueId': 'd1', 'topicId': 't1', 'status': 'PASS', 'rules': [], 'opening': 'Вопрос'}],
        }
        store.save(api.discover.RESULT, previous)
        store.save(api.cards.DECK, {'cards': ['built from the previous audit']})
        down = AsyncMock(side_effect=api.llm.ModelError('Модель недоступна: ConnectError'))
        with patch.object(api.discover.judge, 'log_verdict', down):
            response = await self.client.post('/api/discover', json={'count': 5})
            self.assertEqual(response.status_code, 200, response.text)
            for _ in range(100):
                if not api.jobs.state['running']:
                    break
                await asyncio.sleep(0.002)
        down.assert_awaited_once()
        self.assertEqual(
            api.jobs.state['error'], 'Модель проверки не ответила ни по одному разговору. Прежний итог сохранён.'
        )
        self.assertEqual(store.load(api.discover.RESULT), previous)
        self.assertEqual(store.load(api.cards.DECK), {'cards': ['built from the previous audit']})

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

    async def test_a_malformed_agent_address_is_named_by_the_check_and_by_the_run(self) -> None:
        malformed = (
            'https://ift.example.invalid:84 43/api',
            'https://ift.example.invalid:99999/api',
            'https://ift example.invalid/api',
            'ftp://ift.example.invalid/api',
            'ift.example.invalid/api',
        )
        for url in malformed:
            with self.subTest(url=url):
                response = await self.client.post('/api/settings', json={'prodUrl': url})
                self.assertEqual(response.status_code, 400, response.text)
                self.assertIn('адрес агента', response.json()['detail'])
        self.assertEqual(api.agents.settings()['prodUrl'], '')
        for url in ('https://ift.example.invalid:8443/api/v1/ai/agents/agent', ''):
            response = await self.client.post('/api/settings', json={'prodUrl': url})
            self.assertEqual(response.status_code, 200, response.text)
        # Saved before addresses were checked: the agent is unusable, and both the check and a run say why.
        store.save(api.agents.SETTINGS, {'prodUrl': malformed[0]})
        response = await self.client.post('/api/agents/prod/check')
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()['ok'])
        self.assertIn('адрес агента', response.json()['error'])
        card = {
            'id': 'c1',
            'name': 'Возврат',
            'topic': 'Возвраты',
            'origin': 'Покрытие темы',
            'situation': 'Клиент хочет вернуть оборудование',
            'opening': 'Как оформить возврат?',
            'criteria': [{'id': 't1r1', 'text': 'Отвечает на вопрос', 'observation': 'reply', 'quote': 'q'}],
        }
        store.save(api.cards.DECK, {'cards': [card]})
        response = await self.client.post('/api/runs', json={'target': 'prod'})
        self.assertEqual(response.status_code, 200, response.text)
        for _ in range(100):
            if not api.jobs.state['running']:
                break
            await asyncio.sleep(0.002)
        run = store.runs()[0]
        # Never a crash: each conversation names the address, and the run, which the agent answered in none, fails
        # with it (simulate.unanswered).
        self.assertEqual(run['status'], 'failed')
        self.assertTrue(run['error'].startswith('Агент не ответил ни в одном разговоре: '), run['error'])
        self.assertIn('адрес агента', run['error'])
        self.assertEqual([item['status'] for item in run['items']], ['UNMEASURED'])
        self.assertIn('адрес агента', run['items'][0]['error'])

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
        async def build(check, progress) -> list[dict]:
            return [{'id': 'card-1'}]

        with patch.object(api.cards, 'run', side_effect=build):
            self.assertEqual((await self.client.get('/api/cards')).status_code, 405)
            response = await self.client.post('/api/cards', json={'check': 'code'})
            self.assertEqual(response.status_code, 200)
            await api.jobs._task
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

    async def state_parsing(self) -> tuple[dict, list[str]]:
        """/api/state, and every text it parsed as JSON on the way."""
        parsed = []
        loads = json.loads

        def spy(text, *args, **kwargs):
            parsed.append(text if isinstance(text, str) else text.decode())
            return loads(text, *args, **kwargs)

        with patch.object(store.json, 'loads', spy):
            response = await self.client.get('/api/state')
        self.assertEqual(response.status_code, 200)
        return response.json(), parsed

    async def test_state_lists_runs_without_parsing_their_conversations(self) -> None:
        conversation = [{'role': 'agent', 'text': 'conversation-of-the-run'}]
        for number in (1, 2):
            store.create_run(
                {
                    'id': f'run-{number}',
                    'startedAt': f'2026-10-0{number}T10:00:00+00:00',
                    'status': 'done',
                    'items': [{'cardId': 'card-1', 'status': 'PASS', 'conversation': conversation}],
                }
            )
        store.set_review('run-1', 0, 'agree')
        state, parsed = await self.state_parsing()
        self.assertEqual([run['id'] for run in state['runs']], ['run-2', 'run-1'])
        self.assertEqual(state['runs'][1]['revision'], 2)
        self.assertEqual(state['runs'][1]['metric']['human'], {'reviewed': 1, 'agree': 1})
        self.assertNotIn('items', state['runs'][0])
        self.assertFalse([text for text in parsed if 'conversation-of-the-run' in text])

    async def test_a_run_recorded_under_an_older_name_of_its_agent_is_listed_under_the_current_one(self) -> None:
        store.create_run({'id': 'run-1', 'target': 'prod', 'targetName': 'Агент на ИФТ', 'items': []})
        store.create_run({'id': 'run-2', 'target': 'mystery', 'targetName': 'Агент, которого больше нет', 'items': []})
        listed = {run['id']: run['targetName'] for run in (await self.client.get('/api/state')).json()['runs']}
        self.assertEqual(listed, {'run-1': 'Тестовый стенд банка', 'run-2': 'Агент, которого больше нет'})

    async def test_state_counts_the_dialogues_without_parsing_them(self) -> None:
        messages = [{'role': 'user', 'content': 'dialogue-text'}, {'role': 'assistant', 'content': 'answer'}]
        store.replace_inputs('logs.json', [{'id': str(number), 'messages': messages} for number in range(3)])
        state, parsed = await self.state_parsing()
        self.assertEqual(state['logs']['total'], 3)
        self.assertFalse([text for text in parsed if 'dialogue-text' in text])
        response = await self.client.post(
            '/api/logs?name=one.jsonl', content=json.dumps({'id': 'x', 'messages': messages})
        )
        self.assertEqual(response.status_code, 200)
        state, _ = await self.state_parsing()
        self.assertEqual((state['logs']['total'], state['logs']['file']), (1, 'one.jsonl'))

    async def test_state_reads_the_log_assessment_once_and_reuses_its_summary(self) -> None:
        summary = {'checked': 1, 'measured': 1, 'failed': 1, 'passed': 0, 'unmeasured': 0, 'patterns': []}
        assessment = {
            'results': [{'dialogueId': 'd1', 'status': 'FAIL', 'rules': [], 'opening': 'assessment-text'}],
            'topics': [],
            'sources': [{'id': 's1', 'rules': 2}],
            'summary': summary,
        }
        store.save(api.discover.RESULT, assessment)
        store.save('sources.json', [{'id': 's1', 'kind': 'prompt', 'origin': 'agent.py:1', 'content': 'prompt'}])
        with patch.object(api.discover, 'summarize', side_effect=AssertionError('the stored summary is reused')):
            state, parsed = await self.state_parsing()
        self.assertEqual(state['checks']['code']['summary'], summary)
        self.assertEqual(state['sources'][0]['rules'], 2)
        self.assertEqual(len([text for text in parsed if 'assessment-text' in text]), 1)
        # A record from before results carried their summary gets one.
        store.save(api.discover.RESULT, {key: value for key, value in assessment.items() if key != 'summary'})
        state, _ = await self.state_parsing()
        found = state['checks']['code']['summary']
        self.assertEqual((found['failed'], found['measured']), (1, 1))

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

import asyncio
import json
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

import support

from lab import api, store
from lab.domain import comparison
from lab.flows import inputs


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        support.serve(self)

    async def test_uploaded_log_transcript_has_current_evaluation(self) -> None:
        dialogue = {
            'id': 'dialogue-1',
            'messages': [{'role': 'user', 'content': 'question'}, {'role': 'assistant', 'content': 'answer'}],
        }
        response = await self.client.post('/api/logs?name=sample.jsonl', content=json.dumps(dialogue))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'total': 1, 'skipped': 0})
        response = await self.client.get('/api/logs/dialogue-1')
        self.assertEqual(response.json(), {**dialogue, 'evaluation': None})
        evaluation = {'dialogueId': 'dialogue-1', 'status': 'FAIL'}
        store.save(api.accuracy.RESULT, {'results': [evaluation]})
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
            with patch.object(api.connection, 'repo', return_value=repo):
                response = await self.client.get('/api/articles/возвраты')
                self.assertEqual(
                    response.json(),
                    {'article': 'возвраты', 'title': 'Как оформить возврат', 'text': 'Откройте раздел.\nНажмите.'},
                )
                self.assertEqual((await self.client.get('/api/articles/нет-такой')).status_code, 404)

    async def test_failed_upload_keeps_inputs_and_derived_documents(self) -> None:
        store.save(store.EXPORT, [{'id': 'old'}])
        store.save(api.accuracy.RESULT, {'results': ['old']})
        store.save(api.scenarios.DECK, {'cards': ['old']})
        response = await self.client.post('/api/logs?name=broken.xlsx', content=b'not a workbook')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(store.load(store.EXPORT), [{'id': 'old'}])
        self.assertEqual(store.load(api.accuracy.RESULT), {'results': ['old']})
        self.assertEqual(store.load(api.scenarios.DECK), {'cards': ['old']})

    async def test_a_broken_export_is_refused_in_words_a_person_can_act_on(self) -> None:
        response = await self.client.post('/api/logs?name=export.jsonl', content='id;client;agent\n1;Здравствуйте')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()['detail'],
            'Не удалось прочитать файл. Строка 1 не читается как JSON. '
            'Нужна выгрузка чата, по одному разговору в строке.',
        )

    async def test_successful_upload_invalidates_old_audit_and_scenarios(self) -> None:
        store.save(api.accuracy.RESULT, {'results': ['old']})
        store.save(api.scenarios.DECK, {'cards': ['old']})
        dialogue = {
            'id': 'new',
            'messages': [{'role': 'user', 'content': 'question'}, {'role': 'assistant', 'content': 'answer'}],
        }
        response = await self.client.post('/api/logs?name=sample.jsonl', content=json.dumps(dialogue))
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(store.load(api.accuracy.RESULT))
        self.assertIsNone(store.load(api.scenarios.DECK))

    async def test_criteria_extracted_anew_drop_the_cards_built_from_the_old_ones(self) -> None:
        for replan, kept in ((False, True), (True, False)):
            with self.subTest(replan=replan):
                # What a check of no conversation returns (discover.run), with its own id for its saved check.
                audit = {
                    'checkId': uuid.uuid4().hex,
                    'datasetFingerprint': comparison.dataset_fingerprint([]),
                    'finishedAt': store.now(),
                    'model': None,
                    'sampled': 0,
                    'topics': [],
                    'results': [],
                    'summary': api.results.summarize([], []),
                }
                store.save(api.scenarios.DECK, {'check': 'code', 'cards': ['built from the previous criteria']})
                with patch.object(api.accuracy, 'assess', AsyncMock(return_value=audit)):
                    response = await self.client.post('/api/discover', json={'count': 5, 'replan': replan})
                    self.assertEqual(response.status_code, 200, response.text)
                    for _ in range(100):
                        if not self.jobs.state['running']:
                            break
                        await asyncio.sleep(0.002)
                self.assertIsNone(self.jobs.state['error'])
                self.assertEqual(store.load(api.accuracy.RESULT), audit)
                self.assertEqual(store.load(api.scenarios.DECK) is not None, kept)

    async def test_an_audit_the_model_could_not_answer_keeps_the_previous_one_and_its_scenarios(self) -> None:
        dialogue = {
            'id': 'd1',
            'messages': [{'role': 'user', 'content': 'Вопрос'}, {'role': 'assistant', 'content': 'Ответ'}],
        }
        store.save(store.EXPORT, [dialogue])
        store.save(
            api.inputs.SOURCES, [{'id': 's1', 'kind': 'prompt', 'origin': 'agent.py', 'content': 'Отвечай по делу.'}]
        )
        rule = {'id': 't1r1', 'text': 'Отвечает по делу', 'quote': 'Отвечай по делу', 'sourceId': 's1'}
        previous = {
            'finishedAt': '2026-10-01T10:00:00+00:00',
            'topics': [{'id': 't1', 'title': 'Вопросы', 'dialogueIds': ['d1'], 'rules': [rule]}],
            'results': [{'dialogueId': 'd1', 'topicId': 't1', 'status': 'PASS', 'rules': [], 'opening': 'Вопрос'}],
        }
        store.save(api.accuracy.RESULT, previous)
        store.save(api.scenarios.DECK, {'cards': ['built from the previous audit']})
        down = AsyncMock(side_effect=api.models.ModelError('Модель недоступна: ConnectError'))
        with patch.object(api.accuracy.conversations.judge, 'log_verdict', down):
            response = await self.client.post('/api/discover', json={'count': 5})
            self.assertEqual(response.status_code, 200, response.text)
            for _ in range(100):
                if not self.jobs.state['running']:
                    break
                await asyncio.sleep(0.002)
        down.assert_awaited_once()
        self.assertEqual(
            self.jobs.state['error'],
            'Модель проверки не ответила ни по одному разговору. Прежний итог сохранён. '
            'Проверьте модель в разделе «Настройки».',
        )
        self.assertEqual(store.load(api.accuracy.RESULT), previous)
        self.assertEqual(store.load(api.scenarios.DECK), {'cards': ['built from the previous audit']})

    async def test_criteria_extracted_anew_without_one_grounded_keep_the_previous_result(self) -> None:
        """«Извлечь критерии заново» where the model cited words the agent's code does not have: no criterion stands,
        so no conversation can be checked. The check fails, and «0 из 0» never replaces the result, its scenarios and
        the history."""
        dialogue = {
            'id': 'd1',
            'messages': [{'role': 'user', 'content': 'Вопрос'}, {'role': 'assistant', 'content': 'Ответ'}],
        }
        store.save(store.EXPORT, [dialogue])
        store.save(
            api.inputs.SOURCES,
            [{'id': 's1', 'kind': 'prompt', 'origin': 'agent.py', 'content': 'Отвечай клиенту по делу и вежливо.'}],
        )
        previous = {'finishedAt': '2026-10-01T10:00:00+00:00', 'topics': [{'id': 't1', 'rules': []}], 'results': []}
        store.save(api.accuracy.RESULT, previous)
        store.save(api.scenarios.DECK, {'check': 'code', 'cards': ['built from the previous criteria']})
        paraphrased = {
            'id': 't1r1',
            'name': 'По делу',
            'text': 'Отвечает по делу',
            'sourceId': 's1',
            'quote': 'Говори с клиентом только о его вопросе',
            'condition': 'всегда',
            'acceptable': '',
            'observation': 'reply',
        }
        plan = {'topics': [{'id': 't1', 'title': 'Вопросы', 'dialogueIds': ['d1'], 'rules': [paraphrased]}]}

        planned = api.models.Reply(json.dumps(plan, ensure_ascii=False), 'model')
        judge = AsyncMock(side_effect=AssertionError('no conversation is judged without a criterion'))
        with (
            patch.object(api.models, 'chat', AsyncMock(return_value=planned)),
            patch.object(api.accuracy.conversations.judge, 'log_verdict', judge),
        ):
            response = await self.client.post('/api/discover', json={'count': 5, 'replan': True})
            self.assertEqual(response.status_code, 200, response.text)
            for _ in range(100):
                if not self.jobs.state['running']:
                    break
                await asyncio.sleep(0.002)
        self.assertEqual(
            self.jobs.state['error'],
            'Ни один критерий не подтвердился дословной цитатой из кода агента. Прежний итог сохранён. '
            'Извлеките критерии ещё раз.',
        )
        self.assertEqual(store.load(api.accuracy.RESULT), previous)
        self.assertEqual(
            store.load(api.scenarios.DECK), {'check': 'code', 'cards': ['built from the previous criteria']}
        )
        self.assertEqual(store.code_checks(), [])

    async def test_stopped_source_worker_cannot_publish_or_invalidate_previous_analysis(self) -> None:
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        store.save(api.inputs.SOURCES, [{'id': 'old'}])
        store.save(api.accuracy.RESULT, {'results': ['old']})
        store.save(api.scenarios.DECK, {'cards': ['old']})

        def collect(repo) -> tuple[list[dict], list[str]]:
            entered.set()
            release.wait(timeout=5)
            finished.set()
            return [{'id': 'new'}], []

        with patch.object(api.inputs.agent_sources, 'collect', side_effect=collect):
            try:
                response = await self.client.post('/api/sources')
                self.assertEqual(response.status_code, 200)
                self.assertTrue(await asyncio.to_thread(entered.wait, 2))
                response = await self.client.post('/api/job/stop')
                self.assertEqual(response.status_code, 200)
                self.assertFalse(self.jobs.state['running'])
            finally:
                release.set()
                await asyncio.to_thread(finished.wait, 2)
                await asyncio.sleep(0)
        self.assertEqual(store.load(api.inputs.SOURCES), [{'id': 'old'}])
        self.assertEqual(store.load(api.accuracy.RESULT), {'results': ['old']})
        self.assertEqual(store.load(api.scenarios.DECK), {'cards': ['old']})

    async def test_upload_and_other_commands_share_exclusivity(self) -> None:
        entered, release = asyncio.Event(), asyncio.Event()

        async def work(progress) -> None:
            entered.set()
            await release.wait()

        self.jobs.start('discover', work)
        await entered.wait()
        response = await self.client.post('/api/logs?name=sample.jsonl', content='{}')
        self.assertEqual(response.status_code, 409)
        response = await self.client.post('/api/cards')
        self.assertEqual(response.status_code, 409)
        response = await self.client.post('/api/job/stop')
        self.assertEqual(response.status_code, 200)
        self.assertFalse(self.jobs.state['running'])

    async def test_settings_cannot_change_under_an_active_job(self) -> None:
        store.save(api.connection.SETTINGS, {'repo': '/old/agent'})
        entered = asyncio.Event()

        async def work(progress) -> None:
            entered.set()
            await asyncio.Event().wait()

        self.jobs.start('run', work)
        await entered.wait()
        response = await self.client.post('/api/settings', json={'repo': '/new/agent'})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(api.connection.settings()['repo'], '/old/agent')
        await self.client.post('/api/job/stop')
        response = await self.client.post('/api/settings', json={'repo': '/new/agent'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(api.connection.settings()['repo'], '/new/agent')

    async def test_agent_check_uses_session_and_closes_before_returning(self) -> None:
        agent = api.agents.HttpAgent({'url': 'http://unused.test', 'profile': 'prod'})
        reply = {'text': 'answer', 'status': '200', 'ok': True, 'options': []}
        with (
            patch.object(api.connection, 'connect', return_value=agent),
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
            patch.object(api.connection, 'connect', return_value=agent),
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
                self.assertIn('Адрес агента', response.json()['detail'])
        self.assertEqual(api.connection.settings()['prodUrl'], '')
        for url in ('https://ift.example.invalid:8443/api/v1/ai/agents/agent', ''):
            response = await self.client.post('/api/settings', json={'prodUrl': url})
            self.assertEqual(response.status_code, 200, response.text)
        # Saved before addresses were checked: the agent is unusable, and both the check and a run say why.
        store.save(api.connection.SETTINGS, {'prodUrl': malformed[0]})
        response = await self.client.post('/api/agents/prod/check')
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()['ok'])
        self.assertIn('Адрес агента', response.json()['error'])
        card = {
            'id': 'c1',
            'name': 'Возврат',
            'topic': 'Возвраты',
            'origin': 'Покрытие темы',
            'situation': 'Клиент хочет вернуть оборудование',
            'opening': 'Как оформить возврат?',
            'criteria': [{'id': 't1r1', 'text': 'Отвечает на вопрос', 'observation': 'reply', 'quote': 'q'}],
        }
        store.save(api.scenarios.DECK, {'cards': [card]})
        response = await self.client.post('/api/runs', json={'target': 'prod'})
        self.assertEqual(response.status_code, 200, response.text)
        for _ in range(100):
            if not self.jobs.state['running']:
                break
            await asyncio.sleep(0.002)
        run = store.runs()[0]
        # Never a crash: each conversation names the address, and the run, which the agent answered in none, fails
        # with it (simulate.unanswered).
        self.assertEqual(run['status'], 'failed')
        self.assertTrue(run['error'].startswith('Агент не ответил ни в одном разговоре. '), run['error'])
        self.assertIn('Адрес агента', run['error'])
        self.assertEqual([item['status'] for item in run['items']], ['UNMEASURED'])
        self.assertIn('Адрес агента', run['items'][0]['error'])

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

        with patch.object(api.scenarios, 'built', side_effect=build):
            self.assertEqual((await self.client.get('/api/cards')).status_code, 405)
            response = await self.client.post('/api/cards', json={'check': 'code'})
            self.assertEqual(response.status_code, 200)
            await self.jobs._task
        self.assertEqual(store.load(api.scenarios.DECK)['cards'], [{'id': 'card-1'}])

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
        inputs.replace_export([{'id': str(number), 'messages': messages} for number in range(3)])
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
        store.save(api.accuracy.RESULT, assessment)
        store.save('sources.json', [{'id': 's1', 'kind': 'prompt', 'origin': 'agent.py:1', 'content': 'prompt'}])
        with patch.object(api.results, 'summarize', side_effect=AssertionError('the stored summary is reused')):
            state, parsed = await self.state_parsing()
        self.assertEqual(state['checks']['code']['summary'], summary)
        self.assertEqual(state['sources'][0]['rules'], 2)
        self.assertEqual(len([text for text in parsed if 'assessment-text' in text]), 1)
        # A record from before results carried their summary gets one.
        store.save(api.accuracy.RESULT, {key: value for key, value in assessment.items() if key != 'summary'})
        state, _ = await self.state_parsing()
        found = state['checks']['code']['summary']
        self.assertEqual((found['failed'], found['measured']), (1, 1))

    async def test_not_checked_counts_the_whole_sample_on_every_screen(self) -> None:
        """«Не удалось проверить» is the conversations taken without a verdict, those in no topic included: the result's
        screen, the summary for management, the history and the list of agents say the same number."""
        summary = {'checked': 3, 'measured': 2, 'failed': 1, 'passed': 1, 'unmeasured': 1, 'patterns': []}
        store.save(
            api.accuracy.RESULT,
            {'results': [], 'topics': [], 'sampled': 5, 'unassigned': 2, 'summary': summary, 'finishedAt': 'now'},
        )
        state = (await self.client.get('/api/state')).json()
        self.assertEqual(state['checks']['code']['summary']['unmeasured'], 3)
        self.assertEqual(api.results_of.line('code')['unmeasured'], 3)

    async def test_an_answer_given_anywhere_changes_the_stamp_the_screens_refresh_by(self) -> None:
        result = {
            'finishedAt': 'now',
            'topics': [],
            'results': [{'dialogueId': 'd1', 'status': 'FAIL', 'rules': [{'ruleId': 't1r1', 'status': 'FAIL'}]}],
        }
        store.save(api.accuracy.RESULT, result)
        before = (await self.client.get('/api/state')).json()['reviewsStamp']
        store.set_log_review(api.accuracy.RESULT, 'd1', 't1r1', 'agree')
        after = (await self.client.get('/api/state')).json()['reviewsStamp']
        self.assertNotEqual(before, after)
        store.set_log_review(api.accuracy.RESULT, 'd1', 't1r1', None)
        self.assertEqual((await self.client.get('/api/state')).json()['reviewsStamp'], before)

    async def test_the_agent_page_names_the_read_that_succeeded(self) -> None:
        """When the code was read, and from which folder: written with the sources, so a read that failed names
        nothing, and a folder saved later is not said to be the one read."""
        source = {'id': 's1', 'kind': 'prompt', 'name': 'a.py:1', 'origin': 'a.py:1', 'sha256': 'x', 'content': 'p'}
        await self.client.post('/api/settings', json={'repo': '~/agent'})
        with patch.object(api.inputs.agent_sources, 'collect', return_value=([source], ['src/c.py:1'])):
            await self.client.post('/api/sources')
            await self.wait_job()
        read = (await self.client.get('/api/state')).json()['sourcesRead']
        self.assertEqual(read['repo'], '~/agent')
        self.assertEqual(read['overBudget'], ['src/c.py:1'])
        self.assertTrue(read['readAt'])
        await self.client.post('/api/settings', json={'repo': '~/elsewhere'})
        with patch.object(api.inputs.agent_sources, 'collect', side_effect=RuntimeError('В папке нет кода агента.')):
            await self.client.post('/api/sources')
            await self.wait_job()
        self.assertEqual((await self.client.get('/api/state')).json()['sourcesRead'], read)

    async def test_a_task_said_finished_has_its_data_in_the_same_answer(self) -> None:
        """The state is put together in a worker thread while the task runs on: a task that finishes meanwhile is
        still running in this answer, never «done» beside the data it has just replaced."""
        self.jobs.state.update(kind='sources', running=True)
        summary = api.source_summary

        def finishing(analysis):
            listed = summary(analysis)
            self.jobs.state.update(running=False)  # the task commits and finishes after the sources were read
            return listed

        with patch.object(api, 'source_summary', finishing):
            job = (await self.client.get('/api/state')).json()['job']
        self.assertTrue(job['running'])
        self.jobs.state.update(kind=None, running=False)

    async def test_a_task_says_when_it_started(self) -> None:
        async def work(progress) -> None:
            pass

        self.jobs.start('sources', work)
        first = (await self.client.get('/api/state')).json()['job']['startedAt']
        await self.wait_job()
        self.assertTrue(first)

    async def wait_job(self) -> None:
        for _ in range(500):
            if not self.jobs.state['running']:
                return
            await asyncio.sleep(0.002)
        self.fail('background job did not finish')

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
        async with self.app.router.lifespan_context(self.app):
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

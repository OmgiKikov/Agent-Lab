import asyncio
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from test_tone import POLICY

from lab import api, discover, llm, store, tone
from lab.jobs import Jobs


class ToneFollowthroughTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for mocked in (
            patch.object(store, 'DB', Path(directory.name) / 'lab.sqlite3'),
            patch.object(api, 'jobs', Jobs()),
        ):
            mocked.start()
            self.addCleanup(mocked.stop)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url='http://test')
        self.dialogue = {
            'id': 'd1',
            'messages': [
                {'role': 'user', 'content': 'Как принести документы?'},
                {'role': 'assistant', 'content': 'Предоставь документы до 12 октября.'},
            ],
        }
        await self.client.post('/api/logs?name=first.jsonl', content=json.dumps(self.dialogue))
        await self.client.post('/api/tone-of-voice/policy', json={'text': POLICY, 'name': 'ToV.docx'})
        await self.client.post('/api/tone-of-voice/criteria')
        await self.wait_job()

    async def asyncTearDown(self):
        await api.jobs.close()
        await self.client.aclose()

    async def wait_job(self):
        for _ in range(100):
            if not api.jobs.state['running']:
                return
            await asyncio.sleep(0.002)
        self.fail('background job did not finish')

    async def check(self, rule_ids=None, model='model-a'):
        async def judge(dialogue, topic):
            return {
                'dialogueId': dialogue['id'],
                'topicId': topic['id'],
                'status': 'FAIL',
                'rules': [
                    {
                        'ruleId': rule['id'],
                        'rule': rule['text'],
                        'status': 'FAIL',
                        'reason': 'Форма обращения не соответствует критерию.',
                        'agentQuote': dialogue['messages'][1]['content'],
                        'title': 'Форма обращения',
                    }
                    for rule in topic['rules']
                ],
                'opening': dialogue['messages'][0]['content'],
                'model': model,
                'second': None,
            }

        draft = store.load(tone.DRAFT)
        with patch.object(discover, 'judge_dialogue', side_effect=judge):
            response = await self.client.post(
                '/api/tone-of-voice/check',
                json={
                    'ruleIds': rule_ids or ['pronouns', 'simple_language'],
                    'count': 1,
                    'revision': draft['revision'],
                },
            )
            self.assertEqual(response.status_code, 200, response.text)
            await self.wait_job()
        self.assertIsNone(api.jobs.state['error'])
        return store.load(discover.RESULT)

    async def test_snapshots_survive_new_inputs_and_do_not_change_with_live_reviews(self):
        result = await self.check()
        original = store.tone_check(result['checkId'])
        snapshot = (await self.client.get(f'/api/tone-of-voice/history/{result["checkId"]}')).json()
        self.assertEqual(snapshot['dialogues'], [self.dialogue])
        self.assertEqual(snapshot['policy'], {'name': 'ToV.docx', 'content': POLICY.strip()})
        self.assertEqual(snapshot['reviewSemantics'], 'latest-saved')
        response = await self.client.post(
            '/api/review',
            json={
                'source': 'log',
                'dialogueId': 'd1',
                'ruleId': 'pronouns',
                'finishedAt': result['finishedAt'],
                'decision': 'disagree',
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(store.load(discover.RESULT)['results'][0]['rules'][0]['review'], 'disagree')
        await self.client.post('/api/logs?name=second.jsonl', content=json.dumps({**self.dialogue, 'id': 'd2'}))
        await self.client.post('/api/tone-of-voice/policy', json={'text': POLICY + '\nНовая редакция.'})
        self.assertIsNone(store.load(tone.DRAFT))
        archived = (await self.client.get(f'/api/tone-of-voice/history/{result["checkId"]}')).json()
        self.assertEqual(archived['dialogues'], snapshot['dialogues'])
        self.assertEqual(archived['policy'], snapshot['policy'])
        self.assertEqual(archived['check'], snapshot['check'])
        self.assertEqual(archived['result']['results'][0]['rules'][0]['review'], 'disagree')
        self.assertEqual(archived['result']['results'][0]['rules'][0]['status'], 'FAIL')
        self.assertEqual(archived['reviews'][0]['decision'], 'disagree')
        self.assertEqual(store.tone_check(result['checkId']), original)
        self.assertEqual(
            (await self.client.get('/api/tone-of-voice/history')).json()['checks'][0]['file'], 'first.jsonl'
        )

    async def test_cleared_carried_review_stays_cleared_in_archive_and_stale_edits_are_rejected(self):
        first = await self.check()
        review = {'source': 'log', 'dialogueId': 'd1', 'ruleId': 'pronouns', 'decision': 'agree'}
        await self.client.post('/api/review', json={**review, 'finishedAt': first['finishedAt']})
        second = await self.check()
        original = store.tone_check(second['checkId'])
        self.assertEqual(original['result']['results'][0]['rules'][0]['review'], 'agree')
        self.assertEqual(store.tone_reviews(second['checkId'])[0]['decision'], 'agree')
        cleared = {**review, 'finishedAt': second['finishedAt'], 'decision': None}
        response = await self.client.post('/api/review', json=cleared)
        self.assertEqual(response.status_code, 200)
        response = await self.client.post('/api/review', json={**review, 'finishedAt': 'stale'})
        self.assertEqual(response.status_code, 409)
        await self.client.post('/api/logs?name=next.jsonl', content=json.dumps({**self.dialogue, 'id': 'd2'}))
        archived = (await self.client.get(f'/api/tone-of-voice/history/{second["checkId"]}')).json()
        self.assertIsNone(archived['result']['results'][0]['rules'][0]['review'])
        self.assertIsNone(archived['reviews'][0]['decision'])
        self.assertEqual(store.tone_check(second['checkId']), original)
        self.assertEqual(store.tone_reviews(first['checkId'])[0]['decision'], 'agree')

    async def test_annotation_failure_rolls_back_live_review_in_same_transaction(self):
        result = await self.check()
        with (
            patch.object(store, '_save_tone_review', side_effect=sqlite3.OperationalError('write failed')),
            self.assertRaises(sqlite3.OperationalError),
        ):
            store.set_log_review(discover.RESULT, 'd1', 'pronouns', 'agree', result['finishedAt'])
        self.assertEqual(store.load(discover.RESULT), result)
        self.assertEqual(store.tone_reviews(result['checkId']), [])

    async def test_comparison_requires_same_criteria_and_models_and_ignores_selection_order(self):
        first = await self.check()
        second = await self.check(['simple_language', 'pronouns'])
        self.assertEqual(first['criteriaFingerprint'], second['criteriaFingerprint'])
        entry = store.tone_checks()[0]
        self.assertEqual(entry['comparison']['kind'], 'same-data')
        self.assertEqual(entry['comparison']['previousId'], first['checkId'])
        draft = store.load(tone.DRAFT)
        await self.client.post('/api/logs?name=second.jsonl', content=json.dumps({**self.dialogue, 'id': 'd2'}))
        self.assertEqual(store.load(tone.DRAFT), draft)
        await self.check()
        self.assertEqual(store.tone_checks()[0]['comparison']['kind'], 'new-data')
        await self.check(model='model-b')
        self.assertEqual(store.tone_checks()[0]['comparison']['kind'], 'incompatible')
        await self.check(['pronouns'], model='model-b')
        self.assertEqual(store.tone_checks()[0]['comparison']['kind'], 'incompatible')

    async def test_clarification_is_explicit_versioned_and_reaches_the_actual_judge(self):
        previous = await self.check()
        original = store.load(tone.DRAFT)
        note = 'Обращение на ты допустимо только в прямой цитате клиента.'
        response = await self.client.post(
            '/api/tone-of-voice/clarification',
            json={
                'revision': original['revision'],
                'ruleId': 'pronouns',
                'text': note,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        draft = response.json()
        self.assertNotEqual(draft['revision'], original['revision'])
        self.assertEqual(store.load(discover.RESULT), previous)
        self.assertEqual(draft['criteria'][0]['quote'], original['criteria'][0]['quote'])
        self.assertEqual(draft['criteria'][0]['text'], original['criteria'][0]['text'])
        self.assertEqual(tone.current_policy()['content'], POLICY.strip())
        response = await self.client.post(
            '/api/tone-of-voice/clarification',
            json={
                'revision': original['revision'],
                'ruleId': 'pronouns',
                'text': note,
            },
        )
        self.assertEqual(response.status_code, 400)
        seen = []

        async def chat(system, payload, **kwargs):
            data = json.loads(payload)
            seen.append(data)
            return llm.Answer(
                json.dumps(
                    {
                        'rules': [
                            {
                                'ruleId': 'pronouns',
                                'status': 'PASS',
                                'reason': 'Проверено с уточнением',
                                'agentQuote': self.dialogue['messages'][1]['content'],
                            }
                        ]
                    }
                ),
                'model-a',
            )

        with patch.object(llm, 'chat', side_effect=chat):
            await self.client.post(
                '/api/tone-of-voice/check',
                json={
                    'ruleIds': ['pronouns'],
                    'count': 1,
                    'revision': draft['revision'],
                },
            )
            await self.wait_job()
        self.assertIsNone(api.jobs.state['error'])
        self.assertEqual(len(seen), 2)
        self.assertTrue(all(note in data['expectations'][0]['text'] for data in seen))
        self.assertEqual(store.tone_checks()[0]['comparison']['kind'], 'incompatible')

    async def test_advice_is_grounded_optional_and_does_not_apply_changes(self):
        result = await self.check()
        draft = store.load(tone.DRAFT)
        request = {'finishedAt': result['finishedAt'], 'dialogueId': 'd1', 'ruleId': 'pronouns', 'mode': 'clarify'}
        proposal = {
            'text': 'Допускается обращение на ты внутри прямой цитаты клиента.',
            'explanation': 'Уточняет исключение.',
        }
        with patch.object(llm, 'chat', AsyncMock(return_value=llm.Answer(json.dumps(proposal), 'model-a'))) as model:
            response = await self.client.post('/api/tone-of-voice/advice', json={**request, 'note': '  '})
            self.assertEqual(response.status_code, 400)
            model.assert_not_awaited()
            response = await self.client.post(
                '/api/tone-of-voice/advice',
                json={
                    **request,
                    'note': 'Здесь агент цитирует самого клиента.',
                },
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json(), proposal)
            evidence = json.loads(model.call_args.args[1])
            self.assertEqual(evidence['conversation'], self.dialogue['messages'])
            self.assertEqual(evidence['targetExcerpt'], self.dialogue['messages'][1]['content'])
            self.assertEqual(evidence['criterion']['quote'], draft['criteria'][0]['quote'])
        self.assertEqual(store.load(tone.DRAFT), draft)
        self.assertEqual(store.load(discover.RESULT), result)

    async def test_stale_advice_and_review_do_not_touch_new_results(self):
        result = await self.check()
        with patch.object(llm, 'chat', AsyncMock()) as model:
            response = await self.client.post(
                '/api/tone-of-voice/advice',
                json={
                    'finishedAt': 'stale',
                    'dialogueId': 'd1',
                    'ruleId': 'pronouns',
                    'mode': 'rewrite',
                },
            )
            self.assertEqual(response.status_code, 400)
            response = await self.client.post(
                '/api/review',
                json={
                    'source': 'log',
                    'dialogueId': 'd1',
                    'ruleId': 'pronouns',
                    'decision': 'agree',
                    'finishedAt': 'stale',
                },
            )
            self.assertEqual(response.status_code, 409)
            model.assert_not_awaited()
        self.assertEqual(store.load(discover.RESULT), result)

    async def test_rewrite_preserves_numeric_facts_and_remains_only_a_suggestion(self):
        result = await self.check()
        request = {
            'finishedAt': result['finishedAt'],
            'dialogueId': 'd1',
            'ruleId': 'pronouns',
            'mode': 'rewrite',
        }
        for text, status in (
            ('Пришлите, пожалуйста, документы до 15 октября.', 502),
            ('Пришлите, пожалуйста, документы до 12 октября.', 200),
        ):
            answer = llm.Answer(json.dumps({'text': text, 'explanation': 'Вежливая формулировка.'}), 'model-a')
            with patch.object(llm, 'chat', AsyncMock(return_value=answer)):
                response = await self.client.post('/api/tone-of-voice/advice', json=request)
            self.assertEqual(response.status_code, status, response.text)
        self.assertEqual(store.load(api.logs.FILE), [self.dialogue])
        self.assertEqual(store.load(discover.RESULT), result)

    async def test_late_result_cannot_publish_after_a_draft_revision_change(self):
        previous = await self.check()

        async def superseded(*args):
            store.update(tone.DRAFT, lambda draft: draft.update(revision='new-revision'))
            return previous['results']

        with patch.object(tone, '_judge', side_effect=superseded):
            await self.client.post('/api/tone-of-voice/check', json={'ruleIds': ['pronouns'], 'count': 1})
            await self.wait_job()
        self.assertIn('Материалы проверки изменились', api.jobs.state['error'])
        self.assertEqual(store.load(discover.RESULT), previous)
        self.assertEqual(len(store.tone_checks()), 1)

    async def test_cancelled_check_cannot_publish_even_if_dependency_swallows_cancellation(self):
        previous = await self.check()
        entered = asyncio.Event()

        async def swallow_cancel(*args):
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                return previous['results']

        with patch.object(tone, '_judge', side_effect=swallow_cancel):
            await self.client.post('/api/tone-of-voice/check', json={'ruleIds': ['pronouns'], 'count': 1})
            await entered.wait()
            await self.client.post('/api/job/stop')
        self.assertEqual(api.jobs.state['error'], 'Остановлено')
        self.assertEqual(store.load(discover.RESULT), previous)
        self.assertEqual(len(store.tone_checks()), 1)

    async def test_cancelled_advice_releases_owner_without_returning_suggestion(self):
        result = await self.check()
        entered = asyncio.Event()

        async def waiting(*args, **kwargs):
            entered.set()
            await asyncio.Event().wait()

        with patch.object(llm, 'structured', side_effect=waiting):
            request = asyncio.create_task(
                self.client.post(
                    '/api/tone-of-voice/advice',
                    json={
                        'finishedAt': result['finishedAt'],
                        'dialogueId': 'd1',
                        'ruleId': 'pronouns',
                        'mode': 'rewrite',
                    },
                )
            )
            await entered.wait()
            blocked = await self.client.post(
                '/api/tone-of-voice/clarification',
                json={
                    'revision': store.load(tone.DRAFT)['revision'],
                    'ruleId': 'pronouns',
                    'text': 'Пояснение человека',
                },
            )
            self.assertEqual(blocked.status_code, 409)
            await self.client.post('/api/job/stop')
            response = await request
        self.assertEqual(response.status_code, 409)
        self.assertEqual(store.load(discover.RESULT), result)

    async def test_history_reads_are_pure_and_snapshot_duplicate_rolls_back_live_write(self):
        with patch.object(llm, 'chat', AsyncMock()) as model:
            self.assertEqual(
                (await self.client.get('/api/tone-of-voice/history')).json(),
                {
                    'checks': [],
                    'hasLegacyResult': False,
                },
            )
            self.assertEqual((await self.client.get('/api/tone-of-voice/history/missing')).status_code, 404)
            model.assert_not_awaited()
        result = await self.check()
        snapshot = store.tone_check(result['checkId'])
        snapshot['result']['finishedAt'] = 'replacement'
        with self.assertRaises(sqlite3.IntegrityError):
            store.save_tone_check(snapshot)
        self.assertEqual(store.load(discover.RESULT), result)

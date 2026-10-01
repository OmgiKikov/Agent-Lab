import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

from lab import api, discover, problems, store
from lab.jobs import Jobs

SOURCE = {'id': 'src-1', 'kind': 'prompt', 'origin': 'prompts/main.txt', 'content': 'Не отправляй клиента в поддержку.'}
QUOTE = 'Не отправляй клиента в поддержку'
RULE = {'id': 't1r1', 'name': 'Не отсылает в поддержку', 'text': 'Агент не отсылает в поддержку', 'quote': QUOTE}


def audit() -> dict:
    """Two topics restating one rule, three conversations: an error, a pass, one the judge could not decide."""
    return {
        'sampled': 4,
        'finishedAt': '2026-09-28T10:00:00+00:00',
        'topics': [
            {'id': 't1', 'title': 'Терминалы', 'rules': [RULE]},
            {'id': 't2', 'title': 'Возвраты', 'rules': [dict(RULE, id='t2r1')]},
        ],
        'results': [
            {
                'dialogueId': 'd1',
                'status': 'FAIL',
                'opening': 'Терминал не работает',
                'rules': [{'ruleId': 't1r1', 'status': 'FAIL', 'reason': 'Отправил', 'agentQuote': 'звоните'}],
                'second': {'status': 'FAIL', 'rules': [{'ruleId': 't1r1', 'status': 'FAIL'}]},
            },
            {
                'dialogueId': 'd2',
                'status': 'PASS',
                'opening': 'Как вернуть деньги',
                'rules': [{'ruleId': 't2r1', 'status': 'PASS', 'reason': 'Ответил', 'agentQuote': 'откройте'}],
            },
            {
                'dialogueId': 'd3',
                'status': 'UNMEASURED',
                'opening': 'Привет',
                'rules': [{'ruleId': 't1r1', 'status': 'UNKNOWN', 'reason': 'Не ясно', 'agentQuote': ''}],
            },
        ],
    }


def played_run() -> dict:
    """A finished run whose item keeps the criterion frozen when it was played."""
    criterion = {'id': 'c1', 'text': 'Агент не отсылает в поддержку', 'quote': QUOTE}
    return {
        'id': 'run-1',
        'startedAt': '2026-09-30T10:00:00+00:00',
        'finishedAt': '2026-09-30T10:10:00+00:00',
        'status': 'done',
        'items': [
            {
                'cardId': 'gone',
                'status': 'FAIL',
                'topic': 'Терминалы',
                'name': 'Нет связи',
                'criteria': [criterion],
                'conversation': [{'role': 'customer', 'text': 'Не работает'}],
                'rules': [{'ruleId': 'c1', 'status': 'FAIL', 'reason': 'Отправил', 'agentQuote': 'звоните'}],
            }
        ],
    }


class ProblemsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for mocked in (
            patch.object(store, 'DB', Path(directory.name) / 'lab.sqlite3'),
            patch.object(api, 'jobs', Jobs()),
        ):
            mocked.start()
            self.addCleanup(mocked.stop)
        store.save(api.sources.FILE, [SOURCE])
        store.save(discover.RESULT, audit())
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url='http://test')

    async def asyncTearDown(self) -> None:
        await api.jobs.close()
        await self.client.aclose()

    def test_a_rule_restated_in_two_topics_is_one_rule_counted_per_conversation(self) -> None:
        value = problems.build()
        self.assertEqual(len(value['rules']), 1)
        rule = value['rules'][0]
        self.assertEqual(rule['topics'], ['Терминалы', 'Возвраты'])
        self.assertEqual(rule['rule']['name'], 'Не отсылает в поддержку')
        self.assertEqual(rule['rule']['origin'], 'prompts/main.txt')
        self.assertEqual((rule['log']['failed'], rule['log']['passed'], rule['log']['unknown']), (1, 1, 1))
        self.assertEqual(rule['log']['examples'][0]['second'], 'agree')
        self.assertEqual(value['log'], {
            'sampled': 4,
            'assessed': 2,
            'withViolations': 1,
            'unassessed': 2,
            'finishedAt': '2026-09-28T10:00:00+00:00',
            'rulesSince': None,
        })  # fmt: skip
        self.assertEqual(value['problems'], [rule['id']])
        self.assertIsNone(value['sim'])

    def test_run_side_uses_the_criterion_frozen_in_the_item(self) -> None:
        store.create_run(played_run())
        value = problems.build()
        rule = value['rules'][0]
        self.assertEqual(rule['sim']['failed'], 1)
        self.assertEqual(rule['sim']['examples'][0]['opening'], 'Не работает')
        self.assertEqual(value['sim']['runId'], 'run-1')
        self.assertEqual(value['sim']['withViolations'], 1)

    async def test_problems_and_source_routes(self) -> None:
        response = await self.client.get('/api/problems')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()['rules']), 1)
        self.assertEqual((await self.client.get('/api/problems?run=missing')).status_code, 404)
        response = await self.client.get('/api/sources/src-1')
        self.assertEqual(response.json()['content'], SOURCE['content'])
        self.assertEqual((await self.client.get('/api/sources/missing')).status_code, 404)

    async def test_a_person_answers_on_one_criterion_of_a_logged_conversation(self) -> None:
        body = {'source': 'log', 'dialogueId': 'd1', 'ruleId': 't1r1', 'decision': 'disagree'}
        response = await self.client.post('/api/review', json=body)
        self.assertEqual(response.status_code, 200, response.text)
        example = (await self.client.get('/api/problems')).json()['rules'][0]['log']['examples']
        failed = next(e for e in example if e['status'] == 'FAIL')
        self.assertEqual((failed['review'], failed['reviewScope']), ('disagree', 'rule'))
        missing = await self.client.post('/api/review', json=dict(body, ruleId='nope'))
        self.assertEqual(missing.status_code, 404)
        self.assertEqual((await self.client.post('/api/review', json={'source': 'log'})).status_code, 422)

    async def test_log_answers_wait_for_a_running_audit(self) -> None:
        with patch.dict(api.jobs.state, {'running': True, 'kind': 'discover'}):
            body = {'source': 'log', 'dialogueId': 'd1', 'ruleId': 't1r1', 'decision': 'agree'}
            response = await self.client.post('/api/review', json=body)
        self.assertEqual(response.status_code, 409)
        self.assertNotIn('review', store.load(discover.RESULT)['results'][0]['rules'][0])

    async def test_a_person_answers_on_one_criterion_of_a_simulated_conversation(self) -> None:
        store.create_run(played_run())
        body = {'source': 'sim', 'run': 'run-1', 'index': 0, 'ruleId': 'c1', 'decision': 'agree'}
        response = await self.client.post('/api/review', json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['metric']['human'], {'reviewed': 1, 'agree': 1})
        self.assertEqual(store.run('run-1')['items'][0]['rules'][0]['review'], 'agree')
        self.assertEqual((await self.client.post('/api/review', json=dict(body, ruleId='nope'))).status_code, 404)

    async def test_upload_remembers_the_export(self) -> None:
        dialogue = {'id': 'x', 'messages': [{'role': 'user', 'content': 'q'}, {'role': 'assistant', 'content': 'a'}]}
        await self.client.post('/api/logs?name=export.jsonl', content=json.dumps(dialogue))
        logs = (await self.client.get('/api/state')).json()['logs']
        self.assertEqual((logs['total'], logs['file']), (1, 'export.jsonl'))
        self.assertTrue(logs['updatedAt'])


class RuleReviewStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        database = patch.object(store, 'DB', Path(directory.name) / 'lab.sqlite3')
        database.start()
        self.addCleanup(database.stop)

    def test_a_decision_stays_with_an_unchanged_verdict_and_leaves_a_changed_one(self) -> None:
        store.create_run(played_run())
        store.set_review('run-1', 0, 'agree', 'c1')
        same = {'ruleId': 'c1', 'status': 'FAIL', 'reason': 'Снова отправил', 'agentQuote': 'звоните'}
        record = store.update_item('run-1', 0, {'rules': [same]})
        self.assertEqual(record['items'][0]['rules'][0]['review'], 'agree')
        flipped = dict(same, status='PASS')
        record = store.update_item('run-1', 0, {'rules': [flipped], 'status': 'PASS'})
        self.assertNotIn('review', record['items'][0]['rules'][0])

    def test_the_producer_copy_cannot_restore_a_withdrawn_decision(self) -> None:
        store.create_run(played_run())
        stale = dict(played_run()['items'][0]['rules'][0], review='agree')
        record = store.update_item('run-1', 0, {'rules': [stale]})
        self.assertNotIn('review', record['items'][0]['rules'][0])

    def test_a_repeated_audit_with_frozen_rules_keeps_the_answers(self) -> None:
        previous = audit()
        previous['results'][0]['rules'][0]['review'] = 'disagree'
        results = audit()['results']
        discover.carry_reviews(previous, results)
        self.assertEqual(results[0]['rules'][0]['review'], 'disagree')
        changed = audit()['results']
        changed[0]['rules'][0]['status'] = 'PASS'
        discover.carry_reviews(previous, changed)
        self.assertNotIn('review', changed[0]['rules'][0])

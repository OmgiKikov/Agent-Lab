"""«Было → стало»: each check compares itself with its previous saved check, criterion by criterion, and a new export
no longer erases the result of Точность (docs/superpowers/specs/2026-10-04-was-is-design.md)."""

import asyncio
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from test_checks import CODE, CODE_RESULT, CODE_TOPIC
from test_tone import POLICY
from test_tone_followthrough import judged

from lab import api, discover, problems, store, tone
from lab.jobs import Jobs

CRITERIA = 'accuracy-criteria.json'


def talk(dialogue_id: str) -> dict:
    return {
        'id': dialogue_id,
        'messages': [
            {'role': 'user', 'content': f'Когда привезут терминал? ({dialogue_id})'},
            {'role': 'assistant', 'content': 'Привезём, жди.'},
        ],
    }


class WasIsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.db = Path(directory.name) / 'lab.sqlite3'
        for mocked in (patch.object(store, 'DB', self.db), patch.object(api, 'jobs', Jobs())):
            mocked.start()
            self.addCleanup(mocked.stop)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url='http://test')
        await self.upload('d1', name='Сентябрь.jsonl')
        await self.client.post('/api/tone-of-voice/policy', json={'text': POLICY, 'name': 'ToV.docx'})
        await self.client.post('/api/tone-of-voice/criteria')
        await self.wait_job()
        await self.read_code(CODE)

    async def asyncTearDown(self):
        await api.jobs.close()
        await self.client.aclose()

    async def wait_job(self):
        for _ in range(200):
            if not api.jobs.state['running']:
                return
            await asyncio.sleep(0.002)
        self.fail('background job did not finish')

    async def upload(self, *ids, name='export.jsonl'):
        content = '\n'.join(json.dumps(talk(dialogue_id), ensure_ascii=False) for dialogue_id in ids)
        response = await self.client.post(f'/api/logs?name={name}', content=content.encode())
        self.assertEqual(response.status_code, 200, response.text)

    async def read_code(self, source):
        with patch.object(api.sources, 'collect', return_value=[source]):
            await self.client.post('/api/sources')
            await self.wait_job()
        self.assertIsNone(api.jobs.state['error'])

    async def check_tone(self, status='FAIL', count=5):
        draft = store.load(tone.DRAFT)
        request = {'ruleIds': ['pronouns', 'simple_language'], 'count': count, 'revision': draft['revision']}
        with patch.object(discover, 'judge_dialogue', side_effect=judged(status)):
            response = await self.client.post('/api/tone-of-voice/check', json=request)
            self.assertEqual(response.status_code, 200, response.text)
            await self.wait_job()
        self.assertIsNone(api.jobs.state['error'])

    async def assess_code(self, status='FAIL', replan=False, topic=CODE_TOPIC):
        """«Оценить разговоры» in Точность: the planner puts each conversation in the one topic; the check is fake."""

        async def plan(srcs, dialogues):
            return [dict(topic, dialogueIds=[str(d['id']) for d in dialogues])], 0

        async def keep(previous, dialogues):
            return [dict(t, dialogueIds=[str(d['id']) for d in dialogues]) for t in previous['topics']]

        self.plan, self.keep = AsyncMock(side_effect=plan), AsyncMock(side_effect=keep)
        with (
            patch.object(discover, 'plan_topics', self.plan),
            patch.object(discover, 'keep_topics', self.keep),
            patch.object(discover, 'judge_dialogue', side_effect=judged(status)),
        ):
            response = await self.client.post('/api/discover', json={'count': 5, 'replan': replan})
            self.assertEqual(response.status_code, 200, response.text)
            await self.wait_job()
        self.assertIsNone(api.jobs.state['error'])
        return store.load(CODE_RESULT)

    async def get(self, path):
        response = await self.client.get(path)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_a_check_of_accuracy_is_saved_in_its_history_and_a_new_export_no_longer_erases_it(self):
        result = await self.assess_code()
        saved = (await self.get('/api/history/code'))['checks']
        self.assertEqual([check['id'] for check in saved], [result['checkId']])
        self.assertEqual(saved[0]['comparison']['kind'], 'first')
        self.assertEqual(saved[0]['file'], 'Сентябрь.jsonl')
        self.assertEqual(saved[0]['summary'], {'measured': 1, 'passed': 0, 'failed': 1, 'unmeasured': 0})
        await self.upload('d2', 'd3', name='Октябрь.jsonl')
        self.assertIsNone(store.load(CODE_RESULT))
        detail = await self.get(f'/api/history/code/{result["checkId"]}')
        self.assertEqual(detail['result']['checkId'], result['checkId'])
        self.assertEqual([d['id'] for d in detail['dialogues']], ['d1'])
        # Tone of voice's saved checks are listed the same way.
        await self.check_tone()
        self.assertEqual(len((await self.get('/api/history/tone'))['checks']), 1)
        missing = await self.client.get('/api/history/code/nothing')
        self.assertEqual(missing.status_code, 404)

    async def test_criteria_of_accuracy_survive_a_new_export_until_the_code_of_the_agent_changes(self):
        first = await self.assess_code()
        await self.upload('d2', 'd3', name='Октябрь.jsonl')
        kept = store.load(CRITERIA)
        self.assertEqual([t['title'] for t in kept['topics']], ['Терминалы'])
        self.assertEqual(kept['topics'][0]['dialogueIds'], [])
        second = await self.assess_code()
        self.plan.assert_not_awaited()  # the new conversations are sorted into the same topics
        self.assertEqual(second['topics'][0]['rules'], first['topics'][0]['rules'])
        self.assertEqual(store.code_checks()[0]['comparison']['kind'], 'new-data')
        # Changed code: its criteria go with it, and the next check extracts them anew.
        await self.read_code({**CODE, 'content': 'Называй срок доставки терминала и его модель.'})
        self.assertIsNone(store.load(CRITERIA))
        await self.assess_code()
        self.plan.assert_awaited()

    async def test_compare_puts_each_criterion_of_the_previous_check_beside_the_current_one(self):
        nothing = await self.get('/api/compare?check=tone')
        self.assertEqual((nothing['kind'], nothing['current'], nothing['previous']), ('first', None, None))
        await self.check_tone(status='FAIL')
        first = await self.get('/api/compare?check=tone')
        self.assertEqual(first['kind'], 'first')
        self.assertNotIn('criteria', first)
        await self.upload('d2', 'd3', name='Октябрь.jsonl')
        waiting = await self.get('/api/compare?check=tone')
        self.assertEqual((waiting['kind'], waiting['current']), ('none', None))
        self.assertEqual(waiting['previous']['summary']['failed'], 1)
        self.assertEqual(waiting['previous']['file'], 'Сентябрь.jsonl')
        await self.check_tone(status='PASS')
        compared = await self.get('/api/compare?check=tone')
        self.assertEqual(compared['kind'], 'new-data')
        self.assertEqual(compared['current']['file'], 'Октябрь.jsonl')
        self.assertEqual(
            compared['overall'],
            {
                'before': {'failed': 1, 'measured': 1},
                'now': {'failed': 0, 'measured': 2},
                'verdict': 'few',
                'direction': 'fewer',
            },
        )
        criteria = {row['id']: row for row in compared['criteria']}
        rules = {rule['id']: rule for rule in store.load(tone.RESULT)['topics'][0]['rules']}
        pronouns = criteria[problems.rule_key(rules['pronouns']['quote'])]
        self.assertEqual(pronouns['before'], {'failed': 1, 'measured': 1})
        self.assertEqual(pronouns['now'], {'failed': 0, 'measured': 2})
        self.assertEqual((pronouns['verdict'], pronouns['direction']), ('few', 'fewer'))
        self.assertTrue(pronouns['name'])

    async def test_checks_with_other_criteria_are_not_compared(self):
        await self.assess_code()
        other = {**CODE_TOPIC, 'rules': [{**CODE_TOPIC['rules'][0], 'id': 't1r2', 'text': 'Агент называет модель'}]}
        await self.assess_code(replan=True, topic=other)
        compared = await self.get('/api/compare?check=code')
        self.assertEqual(compared['kind'], 'incompatible')
        self.assertNotIn('overall', compared)
        self.assertNotIn('criteria', compared)

    async def test_answers_on_accuracy_given_after_its_check_stay_with_its_saved_check(self):
        """A new export takes the live result of Точность away; a person's answers on it stay with its saved check, as
        tone of voice's do."""
        result = await self.assess_code()
        rule_id = result['results'][0]['rules'][0]['ruleId']
        body = {'source': 'log', 'check': 'code', 'dialogueId': 'd1', 'ruleId': rule_id, 'decision': 'disagree'}
        response = await self.client.post(
            '/api/review', json=body | {'finishedAt': result['finishedAt'], 'status': 'FAIL'}
        )
        self.assertEqual(response.status_code, 200, response.text)
        await self.upload('d2', name='Октябрь.jsonl')
        detail = await self.get(f'/api/history/code/{result["checkId"]}')
        self.assertEqual(detail['result']['results'][0]['rules'][0]['review'], 'disagree')
        self.assertEqual(
            [(r['dialogueId'], r['ruleId'], r['decision']) for r in detail['reviews']], [('d1', rule_id, 'disagree')]
        )

    async def test_an_accuracy_result_from_before_its_history_becomes_its_first_saved_check(self):
        result = await self.assess_code()
        legacy = {key: value for key, value in result.items() if key not in ('checkId', 'datasetFingerprint')}
        with sqlite3.connect(self.db) as connection:
            connection.execute('DELETE FROM code_checks')
            connection.execute('UPDATE documents SET value = ? WHERE name = ?', (json.dumps(legacy), CODE_RESULT))
            connection.execute('PRAGMA user_version = 4')
        saved = store.code_checks()
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0]['comparison']['kind'], 'first')
        self.assertEqual(store.load(CODE_RESULT)['checkId'], saved[0]['id'])
        self.assertEqual([d['id'] for d in store.code_check(saved[0]['id'])['dialogues']], ['d1'])
        # The next export no longer erases it.
        await self.upload('d2', name='Октябрь.jsonl')
        self.assertEqual([c['id'] for c in store.code_checks()], [saved[0]['id']])


class ChanceTests(unittest.TestCase):
    def setUp(self):
        from lab import history  # here, so that each test failed on its own before the module existed

        self.history = history

    def test_fisher_exact_two_sided(self):
        self.assertAlmostEqual(self.history.fisher(3, 1, 1, 3), 0.4857, places=4)  # the lady tasting tea
        self.assertAlmostEqual(self.history.fisher(10, 0, 0, 10), 2 / 184756, places=10)
        self.assertAlmostEqual(self.history.fisher(0, 5, 0, 5), 1.0)

    def test_few_conversations_say_nothing_more(self):
        verdict = self.history.verdict
        self.assertEqual(verdict({'failed': 6, 'measured': 52}, {'failed': 2, 'measured': 12}), ('few', 'more'))
        self.assertEqual(verdict({'failed': 6, 'measured': 29}, {'failed': 2, 'measured': 90}), ('few', 'fewer'))

    def test_a_difference_beyond_chance_or_within_it(self):
        verdict = self.history.verdict
        self.assertEqual(
            verdict({'failed': 30, 'measured': 100}, {'failed': 10, 'measured': 100}), ('beyond-chance', 'fewer')
        )
        self.assertEqual(
            verdict({'failed': 12, 'measured': 100}, {'failed': 9, 'measured': 100}), ('within-chance', 'fewer')
        )
        self.assertEqual(verdict({'failed': 5, 'measured': 50}, {'failed': 10, 'measured': 100}), ('same', 'same'))
        self.assertEqual(verdict(None, {'failed': 1, 'measured': 40}), (None, None))

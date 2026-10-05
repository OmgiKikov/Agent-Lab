"""«Было → стало»: each check compares itself with its previous saved check, criterion by criterion, and a new export
no longer erases the result of Точность (docs/superpowers/specs/2026-10-04-was-is-design.md)."""

import asyncio
import json
import sqlite3
import unittest
from unittest.mock import AsyncMock, patch

import support
from test_checks import CODE, CODE_RESULT, CODE_TOPIC
from test_tone import POLICY
from test_tone_followthrough import judged

from lab import api, storage
from lab.domain import comparison, sampling, statistics
from lab.domain.problems import rule_key
from lab.flows import accuracy, conversations, tone

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
        support.serve(self)
        self.db = storage.db.default_database()
        await self.upload('d1', name='Сентябрь.jsonl')
        await self.client.post('/api/tone-of-voice/policy', json={'text': POLICY, 'name': 'ToV.docx'})
        await self.client.post('/api/tone-of-voice/criteria')
        await self.wait_job()
        await self.read_code(CODE)

    async def wait_job(self):
        for _ in range(200):
            if not self.jobs.state['running']:
                return
            await asyncio.sleep(0.002)
        self.fail('background job did not finish')

    async def upload(self, *ids, name='export.jsonl'):
        content = '\n'.join(json.dumps(talk(dialogue_id), ensure_ascii=False) for dialogue_id in ids)
        response = await self.client.post(f'/api/logs?name={name}', content=content.encode())
        self.assertEqual(response.status_code, 200, response.text)

    async def read_code(self, source):
        with patch.object(api.inputs.agent_sources, 'collect', return_value=([source], [])):
            await self.client.post('/api/sources')
            await self.wait_job()
        self.assertIsNone(self.jobs.state['error'])

    async def check_tone(self, status='FAIL', count=5):
        draft = storage.documents.load(tone.DRAFT)
        request = {'ruleIds': ['pronouns', 'simple_language'], 'count': count, 'revision': draft['revision']}
        with patch.object(conversations, 'judge_dialogue', side_effect=judged(status)):
            response = await self.client.post('/api/tone-of-voice/check', json=request)
            self.assertEqual(response.status_code, 200, response.text)
            await self.wait_job()
        self.assertIsNone(self.jobs.state['error'])

    async def assess_code(self, status='FAIL', replan=False, topic=CODE_TOPIC):
        """«Оценить разговоры» in Точность: the planner puts each conversation in the one topic; the check is fake."""

        async def plan(srcs, dialogues):
            return [dict(topic, dialogueIds=[str(d['id']) for d in dialogues])], 0

        async def keep(previous, dialogues):
            return [dict(t, dialogueIds=[str(d['id']) for d in dialogues]) for t in previous['topics']]

        self.plan, self.keep = AsyncMock(side_effect=plan), AsyncMock(side_effect=keep)
        with (
            patch.object(accuracy, 'plan_topics', self.plan),
            patch.object(accuracy, 'keep_topics', self.keep),
            patch.object(conversations, 'judge_dialogue', side_effect=judged(status)),
        ):
            response = await self.client.post('/api/discover', json={'count': 5, 'replan': replan})
            self.assertEqual(response.status_code, 200, response.text)
            await self.wait_job()
        self.assertIsNone(self.jobs.state['error'])
        return storage.documents.load(CODE_RESULT)

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
        self.assertIsNone(storage.documents.load(CODE_RESULT))
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
        kept = storage.documents.load(CRITERIA)
        self.assertEqual([t['title'] for t in kept['topics']], ['Терминалы'])
        self.assertEqual(kept['topics'][0]['dialogueIds'], [])
        second = await self.assess_code()
        self.plan.assert_not_awaited()  # the new conversations are sorted into the same topics
        self.assertEqual(second['topics'][0]['rules'], first['topics'][0]['rules'])
        self.assertEqual(storage.history.lines('code')[0]['comparison']['kind'], 'new-data')
        # Changed code: its criteria go with it, and the next check extracts them anew.
        await self.read_code({**CODE, 'content': 'Называй срок доставки терминала и его модель.'})
        self.assertIsNone(storage.documents.load(CRITERIA))
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
        rules = {rule['id']: rule for rule in storage.documents.load(tone.RESULT)['topics'][0]['rules']}
        pronouns = criteria[rule_key(rules['pronouns']['quote'])]
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
            connection.execute("DELETE FROM history WHERE kind = 'code'")
            connection.execute('UPDATE documents SET value = ? WHERE name = ?', (json.dumps(legacy), CODE_RESULT))
            connection.execute('PRAGMA user_version = 4')
        saved = storage.history.lines('code')
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0]['comparison']['kind'], 'first')
        self.assertEqual(storage.documents.load(CODE_RESULT)['checkId'], saved[0]['id'])
        self.assertEqual([d['id'] for d in storage.history.get('code', saved[0]['id'])['dialogues']], ['d1'])
        # The next export no longer erases it.
        await self.upload('d2', name='Октябрь.jsonl')
        self.assertEqual([c['id'] for c in storage.history.lines('code')], [saved[0]['id']])

    async def test_the_history_says_what_the_result_says_about_the_difference(self):
        """A line of the history compared with the one before it carries the same verdict as «было → стало» on the
        result: the screen never draws two conclusions from one pair of checks."""
        await self.assess_code('FAIL')
        await self.assess_code('PASS')
        compare = await self.get('/api/compare?check=code')
        lines = (await self.get('/api/history/code'))['checks']
        self.assertEqual(lines[0]['comparison']['kind'], compare['kind'])
        self.assertEqual(lines[0]['comparison']['verdict'], compare['overall']['verdict'])
        self.assertEqual(lines[0]['comparison']['direction'], compare['overall']['direction'])
        self.assertNotIn('verdict', lines[1]['comparison'])


class SampleTests(unittest.TestCase):
    def test_the_same_export_in_another_order_gives_the_same_conversations(self):
        ids = [f'd{number}' for number in range(60)]
        first = sampling.sampled(ids, 20)
        again = sampling.sampled(list(reversed(ids)), 20)
        self.assertEqual(len(first), 20)
        self.assertEqual(first, again)


class ChanceTests(unittest.TestCase):
    def test_a_failed_second_check_is_not_another_model(self):
        """One outage of the second model records its configured name, not the name it answers with: the checks stay
        comparable, as the main count does not depend on the second check."""
        answered = {'model': 'main', 'second': {'model': 'openai/gpt-5-2025-08-07', 'status': 'PASS'}}
        failed = {'model': 'main', 'second': {'model': 'openai/gpt-5', 'status': 'ERROR', 'error': 'нет связи'}}
        one = comparison.evaluation_fingerprint({'model': 'main', 'results': [answered, answered]})
        other = comparison.evaluation_fingerprint({'model': 'main', 'results': [answered, failed]})
        self.assertEqual(one, other)

    def test_other_instructions_of_the_judge_are_another_evaluation(self):
        """The same models judging by another version of the judge's instructions (roles.Role.version) made another
        evaluation; a record from before versions were kept was judged by instructions nobody knows."""
        judged = {
            'model': 'main',
            'judgeVersion': 'a1',
            'second': {'model': 'other', 'status': 'PASS', 'judgeVersion': 'a1'},
        }
        again = comparison.evaluation_fingerprint({'model': 'main', 'results': [judged, judged]})
        self.assertEqual(again, comparison.evaluation_fingerprint({'model': 'main', 'results': [judged]}))
        rewritten = {**judged, 'judgeVersion': 'b2', 'second': {**judged['second'], 'judgeVersion': 'b2'}}
        older = {key: value for key, value in judged.items() if key != 'judgeVersion'} | {'second': None}
        for other in (rewritten, older):
            with self.subTest(other=other):
                self.assertNotEqual(again, comparison.evaluation_fingerprint({'model': 'main', 'results': [other]}))
        before = {'id': 'c1', 'criteriaFingerprint': 'k', 'evaluationFingerprint': 'old', 'datasetFingerprint': 'd'}
        now = dict(before, id='c2', evaluationFingerprint=again)
        self.assertEqual(comparison.comparison(now, before)['reason'], 'Изменились модели или инструкции проверки.')

    def test_fisher_exact_two_sided(self):
        self.assertAlmostEqual(statistics.fisher(3, 1, 1, 3), 0.4857, places=4)  # the lady tasting tea
        self.assertAlmostEqual(statistics.fisher(10, 0, 0, 10), 2 / 184756, places=10)
        self.assertAlmostEqual(statistics.fisher(0, 5, 0, 5), 1.0)

    def test_few_conversations_say_nothing_more(self):
        verdict = statistics.verdict
        self.assertEqual(verdict({'failed': 6, 'measured': 52}, {'failed': 2, 'measured': 12}), ('few', 'more'))
        self.assertEqual(verdict({'failed': 6, 'measured': 29}, {'failed': 2, 'measured': 90}), ('few', 'fewer'))

    def test_a_difference_beyond_chance_or_within_it(self):
        verdict = statistics.verdict
        self.assertEqual(
            verdict({'failed': 30, 'measured': 100}, {'failed': 10, 'measured': 100}), ('beyond-chance', 'fewer')
        )
        self.assertEqual(
            verdict({'failed': 12, 'measured': 100}, {'failed': 9, 'measured': 100}), ('within-chance', 'fewer')
        )
        self.assertEqual(verdict({'failed': 5, 'measured': 50}, {'failed': 10, 'measured': 100}), ('same', 'same'))
        self.assertEqual(verdict(None, {'failed': 1, 'measured': 40}), (None, None))

"""The rules of communication taken from another agent: its policy and its criteria with the clarifications people
confirmed become this agent's own, as a copy (POST /api/tone-of-voice/copy); the list of agents names each agent's
rules (GET /api/agents, `rules`)."""

import asyncio
import json
import unittest
from unittest.mock import patch

import support
from test_tone import POLICY
from test_tone_followthrough import judged

from lab import jobs, storage
from lab.domain import checks
from lab.domain import tone as tone_rules
from lab.flows import accuracy, conversations, inputs, tone
from lab.storage import registry

CODE = {'id': 's1', 'kind': 'prompt', 'origin': 'agent.py:1', 'content': 'Называй срок рассмотрения заявки.'}
CLARIFICATION = '«Вы» с прописной буквы — тоже ошибка.'
OTHER_POLICY = POLICY.replace('Не используйте канцеляризмы.', 'Не используйте канцеляризмы и жаргон.')
COPIED_AT = '2030-01-01T00:00:00.000+00:00'


class ToneCopyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        support.serve(self, jobs.PerAgent())
        self.source = registry.create('Агент эквайринга')['id']
        self.target = registry.create('Агент кредитов')['id']
        await self.upload(self.source)
        await self.prepare(self.source)
        draft = self.draft(self.source)
        response = await self.post(
            self.source,
            '/api/tone-of-voice/clarification',
            {'revision': draft['revision'], 'ruleId': 'pronouns', 'text': CLARIFICATION},
        )
        self.assertEqual(response.status_code, 200, response.text)

    async def post(self, agent, path, body):
        return await self.client.post(path, json=body, headers={'X-Agent': agent})

    async def copy(self, into, source=None):
        return await self.post(into, '/api/tone-of-voice/copy', {'agent': source or self.source})

    async def wait_job(self, agent):
        for _ in range(200):
            with registry.using(agent):
                if not self.jobs.state['running']:
                    return
            await asyncio.sleep(0.002)
        self.fail('background job did not finish')

    async def upload(self, agent):
        dialogue = {
            'id': 'd1',
            'messages': [
                {'role': 'user', 'content': 'Когда одобрят кредит?'},
                {'role': 'assistant', 'content': 'Жди, тебе позвонят.'},
            ],
        }
        response = await self.client.post(
            '/api/logs?name=export.jsonl', content=json.dumps(dialogue), headers={'X-Agent': agent}
        )
        self.assertEqual(response.status_code, 200, response.text)

    async def prepare(self, agent, text=POLICY, name='ToV.docx'):
        """Rules of communication saved and their criteria collected (a coded rubric: no model)."""
        response = await self.post(agent, '/api/tone-of-voice/policy', {'text': text, 'name': name})
        self.assertEqual(response.status_code, 200, response.text)
        response = await self.post(agent, '/api/tone-of-voice/criteria', {})
        self.assertEqual(response.status_code, 200, response.text)
        await self.wait_job(agent)

    async def check(self, agent):
        """A tone-of-voice check with a fake model; the result it published."""
        draft = self.draft(agent)
        with patch.object(conversations, 'judge_dialogue', side_effect=judged('FAIL')):
            response = await self.post(
                agent, '/api/tone-of-voice/check', {'ruleIds': ['pronouns'], 'count': 1, 'revision': draft['revision']}
            )
            self.assertEqual(response.status_code, 200, response.text)
            await self.wait_job(agent)
        with registry.using(agent):
            self.assertIsNone(self.jobs.state['error'])
            return storage.documents.load(tone.RESULT)

    def draft(self, agent):
        with registry.using(agent):
            return storage.documents.load(tone.DRAFT)

    def sources_of(self, agent):
        with registry.using(agent):
            return inputs.sources()

    async def test_a_new_agent_takes_the_rules_and_their_criteria_with_the_clarifications(self):
        with registry.using(self.target):
            storage.documents.save(inputs.SOURCES, [CODE])
        before = self.draft(self.source)
        with patch.object(storage, 'now', return_value=COPIED_AT):
            response = await self.copy(self.target)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {'ok': True, 'unchanged': False})
        policy = next(item for item in self.sources_of(self.source) if item['kind'] == tone_rules.KIND)
        self.assertEqual(self.sources_of(self.target), [CODE, policy])  # its own code stays
        copied = self.draft(self.target)
        self.assertEqual(copied['criteria'], before['criteria'])
        pronouns = next(rule for rule in copied['criteria'] if rule['id'] == 'pronouns')
        self.assertEqual(pronouns['clarifications'], [CLARIFICATION])
        self.assertEqual(copied['sourceSha256'], policy['sha256'])
        # A version of its own: a result of the other agent never matches it.
        self.assertNotEqual(copied['revision'], before['revision'])
        self.assertEqual(copied['createdAt'], COPIED_AT)
        self.assertEqual(self.draft(self.source), before)
        # The copied criteria are ready to check in the agent that took them.
        await self.upload(self.target)
        result = await self.check(self.target)
        self.assertEqual(result['criteriaRevision'], copied['revision'])
        self.assertEqual(result['topics'][0]['rules'][0]['clarifications'], [CLARIFICATION])

    async def test_other_rules_are_replaced_and_their_result_goes_to_the_history(self):
        await self.upload(self.target)
        await self.prepare(self.target, OTHER_POLICY, 'Старые правила.md')
        old = await self.check(self.target)
        with registry.using(self.target):
            storage.documents.save(accuracy.RESULT, {'finishedAt': '2026-10-01T09:00:00+00:00', 'results': []})
            storage.documents.save(checks.DECK, {'check': 'tone', 'cards': ['from the old rules']})
        response = await self.copy(self.target)
        self.assertEqual(response.json(), {'ok': True, 'unchanged': False})
        with registry.using(self.target):
            self.assertIsNone(storage.documents.load(tone.RESULT))
            self.assertIsNone(storage.documents.load(checks.DECK))
            self.assertEqual([check['id'] for check in storage.history.lines('tone')], [old['checkId']])
            self.assertEqual(storage.documents.load(accuracy.RESULT)['finishedAt'], '2026-10-01T09:00:00+00:00')
            self.assertEqual(tone.current_policy()['content'], POLICY.strip())
        self.assertEqual(self.draft(self.target)['criteria'], self.draft(self.source)['criteria'])

    async def test_the_same_rules_keep_their_result_and_take_the_confirmed_clarifications(self):
        await self.upload(self.target)
        await self.prepare(self.target, POLICY, 'Правила общения')
        result = await self.check(self.target)
        response = await self.copy(self.target)
        self.assertEqual(response.json(), {'ok': True, 'unchanged': False})
        copied = self.draft(self.target)
        self.assertEqual(copied['criteria'], self.draft(self.source)['criteria'])
        self.assertNotEqual(copied['revision'], result['criteriaRevision'])
        with registry.using(self.target):
            self.assertEqual(
                storage.documents.load(tone.RESULT), result
            )  # the rules did not change: only their criteria did
            self.assertEqual(tone.current_policy()['name'], 'Правила общения')

    async def test_rules_already_the_same_are_left_as_they_are(self):
        await self.copy(self.target)
        await self.upload(self.target)
        result = await self.check(self.target)
        draft = self.draft(self.target)
        response = await self.copy(self.target)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {'ok': True, 'unchanged': True})
        self.assertEqual(self.draft(self.target), draft)
        with registry.using(self.target):
            self.assertEqual(storage.documents.load(tone.RESULT), result)

    async def test_later_changes_in_either_agent_never_reach_the_other(self):
        await self.copy(self.target)
        await self.upload(self.target)
        source = self.draft(self.source)
        target = self.draft(self.target)
        response = await self.post(
            self.target,
            '/api/tone-of-voice/clarification',
            {'revision': target['revision'], 'ruleId': 'simple_language', 'text': 'Термин «эквайринг» — допустим.'},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.draft(self.source), source)
        await self.prepare(self.source, OTHER_POLICY)
        with registry.using(self.target):
            self.assertEqual(tone.current_policy()['content'], POLICY.strip())
        self.assertEqual(self.draft(self.target)['criteria'][1]['clarifications'], ['Термин «эквайринг» — допустим.'])

    async def test_rules_without_criteria_are_taken_alone(self):
        third = registry.create('Агент вкладов')['id']
        response = await self.post(third, '/api/tone-of-voice/policy', {'text': OTHER_POLICY, 'name': 'Черновик.md'})
        self.assertEqual(response.status_code, 200, response.text)
        await self.copy(self.target)
        response = await self.copy(self.target, third)
        self.assertEqual(response.json(), {'ok': True, 'unchanged': False})
        with registry.using(self.target):
            self.assertEqual(tone.current_policy()['name'], 'Черновик.md')
        self.assertIsNone(self.draft(self.target))  # criteria of the rules it had are not theirs

    async def test_the_rules_are_taken_only_from_another_agent_that_has_them(self):
        empty = registry.create('Агент вкладов')['id']
        cases = (
            (self.source, self.source, 400, 'Правила можно взять только у другого агента.'),
            (self.target, 'nobody', 404, 'Агент не найден'),
            (self.target, empty, 400, 'У агента «Агент вкладов» нет правил общения.'),
        )
        for into, source, status, detail in cases:
            with self.subTest(source=source):
                response = await self.copy(into, source)
                self.assertEqual((response.status_code, response.json()['detail']), (status, detail))
        self.assertEqual(self.sources_of(self.target), [])
        self.assertIsNone(self.draft(self.target))

    async def test_the_rules_are_not_taken_while_the_agent_is_busy(self):
        entered = asyncio.Event()

        async def busy(progress):
            entered.set()
            await asyncio.Event().wait()

        with registry.using(self.target):
            self.jobs.start('run', busy)
        await entered.wait()
        response = await self.copy(self.target)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.sources_of(self.target), [])


class AgentRulesTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        support.serve(self, jobs.PerAgent())

    async def test_each_agent_is_listed_with_its_rules_of_communication(self):
        ruled = registry.create('Агент эквайринга')['id']
        drafted = registry.create('Агент кредитов')['id']
        registry.create('Агент вкладов')
        policy = tone_rules.policy('ToV.docx', POLICY)
        for agent in (ruled, drafted):
            with registry.using(agent):
                storage.documents.save(inputs.SOURCES, [CODE, policy])
        with registry.using(ruled):
            criteria = tone_rules.coded_criteria(policy)
            tone.save_draft(
                {'revision': 'r1', 'createdAt': storage.now(), 'sourceSha256': policy['sha256'], 'criteria': criteria}
            )
        listed = (await self.client.get('/api/agents')).json()
        self.assertEqual(
            [agent['rules'] for agent in listed],
            [
                {'name': 'ToV.docx', 'criteria': 2, 'sha256': policy['sha256']},
                {'name': 'ToV.docx', 'criteria': 0, 'sha256': policy['sha256']},
                None,
            ],
        )

    async def test_broken_rules_of_one_agent_do_not_hide_the_others(self):
        broken = registry.create('Сломанный')['id']
        registry.create('Агент кредитов')
        with registry.using(broken):
            storage.documents.save(inputs.SOURCES, {'not': 'a list'})
        response = await self.client.get('/api/agents')
        self.assertEqual(response.status_code, 200)
        self.assertEqual([agent['rules'] for agent in response.json()], [None, None])


if __name__ == '__main__':
    unittest.main()

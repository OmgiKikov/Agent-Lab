"""Serious and minor errors: after a check the model proposes for each criterion whether its errors are serious, and a
person confirms or changes it; the ones a person marked serious come first, and serious errors are counted apart."""

import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

import support
from test_checks import CODE, CODE_TOPIC
from test_tone import POLICY
from test_tone_followthrough import judged

from lab import models, storage
from lab.domain import checks
from lab.domain.problems import rule_key
from lab.flows import accuracy, conversations, inputs, severity, tone
from lab.jobs import PerAgent
from lab.roles import severity as proposals
from lab.storage import registry


def talk(dialogue_id: str) -> dict:
    return {
        'id': dialogue_id,
        'messages': [
            {'role': 'user', 'content': f'Как поменять тариф? ({dialogue_id})'},
            {'role': 'assistant', 'content': 'Поменяй в приложении, осуществляется в разделе «Тарифы».'},
        ],
    }


def judge_by(failing: dict[str, set[str]], inapplicable: dict[str, set[str]] | None = None):
    """conversations.judge_dialogue with a fake model: a conversation fails exactly the criteria named for it; the
    criteria named in `inapplicable` for it did not apply there (their situation never came up)."""

    async def judge(dialogue, topic):
        fails = failing.get(dialogue['id'], set())
        unchecked = (inapplicable or {}).get(dialogue['id'], set())
        rows = [
            {
                'ruleId': rule['id'],
                'rule': rule['text'],
                'status': 'FAIL' if rule['id'] in fails else 'NOT_APPLICABLE' if rule['id'] in unchecked else 'PASS',
                'reason': 'Ответ не соответствует критерию.' if rule['id'] in fails else '',
                'agentQuote': dialogue['messages'][1]['content'] if rule['id'] in fails else '',
                'title': '',
            }
            for rule in topic['rules']
        ]
        return {
            'dialogueId': dialogue['id'],
            'topicId': topic['id'],
            'status': 'FAIL' if fails else 'PASS',
            'rules': rows,
            'opening': dialogue['messages'][0]['content'],
            'error': None,
            'model': 'model-a',
            'second': None,
        }

    return judge


def proposing(*words: str, model: str = 'model-a', fail: Exception | None = None) -> AsyncMock:
    """models.chat as a model that proposes severity: a criterion whose requirement has one of `words` is serious,
    each with its reason; with `fail` the model does not answer."""

    async def chat(system, messages, **kwargs):
        if fail:
            raise fail
        rows = [
            {
                'id': criterion['id'],
                'serious': any(word in criterion['requirement'] for word in words),
                'reason': f'Пояснение: {criterion["name"]}',
            }
            for criterion in json.loads(messages)['criteria']
        ]
        return models.Reply(json.dumps({'criteria': rows}, ensure_ascii=False), model)

    return AsyncMock(side_effect=chat)


# No model is asked unless the test proposes one.
SILENT = AsyncMock(side_effect=AssertionError('the model was asked to propose severity'))


class SeverityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        support.serve(self)
        await self.prepare()

    async def prepare(self, agent=None):
        await self.upload('d1', 'd2', 'd3', agent=agent)
        await self.post('/api/tone-of-voice/policy', {'text': POLICY, 'name': 'ToV.docx'}, agent)
        await self.post('/api/tone-of-voice/criteria', {}, agent)
        await self.wait_job(agent)

    async def post(self, path, body, agent=None):
        return await self.client.post(path, json=body, headers={'X-Agent': agent} if agent else {})

    async def get(self, path):
        response = await self.client.get(path)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def wait_job(self, agent=None):
        for _ in range(200):
            if agent:
                with registry.using(agent):
                    running = self.jobs.state['running']
            else:
                running = self.jobs.state['running']
            if not running:
                return
            await asyncio.sleep(0.002)
        self.fail('background job did not finish')

    async def upload(self, *ids, agent=None):
        content = '\n'.join(json.dumps(talk(dialogue_id), ensure_ascii=False) for dialogue_id in ids)
        headers = {'X-Agent': agent} if agent else {}
        response = await self.client.post('/api/logs?name=export.jsonl', content=content.encode(), headers=headers)
        self.assertEqual(response.status_code, 200, response.text)

    async def check_tone(self, failing, inapplicable=None, count=5, propose=None):
        """A check of tone of voice; with `propose` (the model's fake) the screens ask it to propose severity after."""
        draft = storage.documents.load(tone.DRAFT)
        request = {'ruleIds': ['pronouns', 'simple_language'], 'count': count, 'revision': draft['revision']}
        if propose:
            request['propose'] = True
        with (
            patch.object(conversations, 'judge_dialogue', side_effect=judge_by(failing, inapplicable)),
            patch.object(severity.models, 'chat', propose or SILENT),
        ):
            response = await self.client.post('/api/tone-of-voice/check', json=request)
            self.assertEqual(response.status_code, 200, response.text)
            await self.wait_job()
        self.assertIsNone(self.jobs.state['error'])

    def key(self, rule_id):
        criterion = next(c for c in storage.documents.load(tone.DRAFT)['criteria'] if c['id'] == rule_id)
        return rule_key(criterion['quote'])

    async def mark(self, rule_id, serious=True, agent=None, check='tone'):
        response = await self.post(
            '/api/severity', {'check': check, 'rule': self.key(rule_id), 'serious': serious}, agent
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['severity']

    async def test_a_person_marks_a_criterion_serious_and_takes_it_back(self):
        pronouns = self.key('pronouns')
        self.assertEqual((await self.get('/api/state'))['severity'], {'tone': [], 'code': []})
        self.assertEqual(await self.mark('pronouns'), {'tone': [pronouns], 'code': []})
        self.assertEqual((await self.get('/api/state'))['severity'], {'tone': [pronouns], 'code': []})
        self.assertEqual(await self.mark('pronouns', serious=False), {'tone': [], 'code': []})
        for body in (
            {'check': 'other', 'rule': pronouns, 'serious': True},
            {'check': 'tone', 'rule': 'not a key', 'serious': True},
        ):
            self.assertEqual((await self.post('/api/severity', body)).status_code, 422)

    async def test_serious_problems_come_first_and_are_counted_by_conversation(self):
        failing = {'d1': {'pronouns'}, 'd2': {'simple_language'}, 'd3': {'simple_language'}}
        await self.check_tone(failing, inapplicable={'d2': {'pronouns'}})
        pronouns, simple = self.key('pronouns'), self.key('simple_language')
        found = await self.get('/api/problems?check=tone')
        self.assertEqual(found['problems'], [simple, pronouns])  # by frequency while nothing is marked
        self.assertFalse(any(rule['serious'] for rule in found['rules']))
        self.assertFalse({'withSerious', 'seriousChecked'} & set(found['log']))
        await self.mark('pronouns')
        found = await self.get('/api/problems?check=tone')
        self.assertEqual(found['problems'], [pronouns, simple])  # the serious one first, though rarer
        self.assertEqual({rule['id']: rule['serious'] for rule in found['rules']}, {pronouns: True, simple: False})
        # One conversation with a serious error, of the two where the serious criterion could be checked.
        self.assertEqual((found['log']['withSerious'], found['log']['seriousChecked']), (1, 2))

    async def test_compare_counts_serious_errors_on_both_sides(self):
        await self.check_tone({'d1': {'pronouns'}, 'd2': {'simple_language'}})
        await self.upload('d4', 'd5')
        await self.check_tone({'d4': {'pronouns', 'simple_language'}})
        compared = await self.get('/api/compare?check=tone')
        self.assertEqual(compared['kind'], 'new-data')
        self.assertNotIn('serious', compared)
        await self.mark('pronouns')
        compared = await self.get('/api/compare?check=tone')
        self.assertEqual(
            compared['serious'],
            {
                'before': {'failed': 1, 'measured': 3},
                'now': {'failed': 1, 'measured': 2},
                'checked': {'before': 3, 'now': 2},
                'verdict': 'few',
                'direction': 'more',
            },
        )

    async def test_few_conversations_where_a_serious_criterion_could_be_checked_say_nothing_more(self):
        before, now = [f'a{i}' for i in range(40)], [f'b{i}' for i in range(40)]
        await self.upload(*before)
        await self.check_tone({dialogue: {'pronouns'} for dialogue in before[:20]}, count=40)
        await self.upload(*now)
        await self.check_tone({}, inapplicable={dialogue: {'pronouns'} for dialogue in now[5:]}, count=40)
        await self.mark('pronouns')
        compared = await self.get('/api/compare?check=tone')
        self.assertEqual(compared['overall']['verdict'], 'beyond-chance')  # 20 of 40 → 0 of 40
        # The same shares, but the serious criterion applied in 5 conversations now: nothing more is said.
        self.assertEqual(
            compared['serious'],
            {
                'before': {'failed': 20, 'measured': 40},
                'now': {'failed': 0, 'measured': 40},
                'checked': {'before': 40, 'now': 5},
                'verdict': 'few',
                'direction': 'fewer',
            },
        )

    async def test_marks_survive_a_new_export_and_a_clarified_criterion(self):
        pronouns = self.key('pronouns')
        await self.mark('pronouns')
        await self.upload('d4')
        self.assertEqual((await self.get('/api/state'))['severity']['tone'], [pronouns])
        draft = storage.documents.load(tone.DRAFT)
        clarified = await self.post(
            '/api/tone-of-voice/clarification',
            {'revision': draft['revision'], 'ruleId': 'pronouns', 'text': 'Обращение «Вы» с прописной — тоже ошибка.'},
        )
        self.assertEqual(clarified.status_code, 200, clarified.text)
        self.assertNotEqual(storage.documents.load(tone.DRAFT)['revision'], draft['revision'])
        await self.check_tone({'d4': {'pronouns'}})
        found = await self.get('/api/problems?check=tone')
        self.assertEqual(found['problems'], [pronouns])
        self.assertTrue(next(rule for rule in found['rules'] if rule['id'] == pronouns)['serious'])

    async def test_rules_taken_from_another_agent_bring_their_marks(self):
        with patch.object(self.app.state, 'jobs', PerAgent()) as jobs, patch.object(self, 'jobs', jobs):
            source = registry.create('Агент эквайринга')['id']
            target = registry.create('Агент кредитов')['id']
            await self.prepare(source)
            with registry.using(source):
                pronouns = self.key('pronouns')
            await self.mark('pronouns', agent=source)
            response = await self.post('/api/tone-of-voice/copy', {'agent': source}, target)
            self.assertEqual(response.status_code, 200, response.text)
            with registry.using(target):
                self.assertEqual(storage.severity.marks()['tone'], {pronouns: True})
            await self.jobs.close()

    async def test_rules_taken_from_another_agent_bring_its_proposals(self):
        with patch.object(self.app.state, 'jobs', PerAgent()) as jobs, patch.object(self, 'jobs', jobs):
            source = registry.create('Агент эквайринга')['id']
            target = registry.create('Агент кредитов')['id']
            await self.prepare(source)
            simple = self.key('simple_language')
            with registry.using(source):
                storage.severity.propose('tone', {simple: {'serious': True, 'reason': 'Мешает понять ответ.'}}, 'm')
            response = await self.post('/api/tone-of-voice/copy', {'agent': source}, target)
            self.assertEqual(response.status_code, 200, response.text)
            with registry.using(target):
                self.assertEqual(storage.severity.serious()['tone'], [simple])
                self.assertEqual(
                    storage.severity.proposed()['tone']['proposals'],
                    {simple: {'serious': True, 'reason': 'Мешает понять ответ.'}},
                )
            await self.jobs.close()

    async def test_rules_taken_without_criteria_leave_the_marks(self):
        with patch.object(self.app.state, 'jobs', PerAgent()) as jobs, patch.object(self, 'jobs', jobs):
            source = registry.create('Агент эквайринга')['id']
            target = registry.create('Агент кредитов')['id']
            await self.upload('d1', agent=source)
            await self.post('/api/tone-of-voice/policy', {'text': POLICY, 'name': 'ToV.docx'}, source)
            await self.prepare(target)
            pronouns = self.key('pronouns')
            await self.mark('pronouns', agent=target)
            response = await self.post('/api/tone-of-voice/copy', {'agent': source}, target)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(response.json()['unchanged'])
            with registry.using(target):
                self.assertEqual(storage.severity.serious()['tone'], [pronouns])  # the marks belong to criteria
            await self.jobs.close()

    async def test_the_same_rules_with_other_marks_are_not_the_same(self):
        with patch.object(self.app.state, 'jobs', PerAgent()) as jobs, patch.object(self, 'jobs', jobs):
            source = registry.create('Агент эквайринга')['id']
            target = registry.create('Агент кредитов')['id']
            await self.prepare(source)
            await self.prepare(target)
            pronouns = self.key('pronouns')
            await self.mark('pronouns', agent=source)
            response = await self.post('/api/tone-of-voice/copy', {'agent': source}, target)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertFalse(response.json()['unchanged'])
            with registry.using(target):
                self.assertEqual(storage.severity.serious()['tone'], [pronouns])
            again = await self.post('/api/tone-of-voice/copy', {'agent': source}, target)
            self.assertTrue(again.json()['unchanged'])
            await self.jobs.close()

    async def test_a_check_proposes_for_each_criterion_whether_its_errors_are_serious(self):
        model = proposing('«вы»')
        await self.check_tone({'d1': {'pronouns'}, 'd2': {'simple_language'}, 'd3': {'simple_language'}}, propose=model)
        model.assert_awaited_once()
        pronouns, simple = self.key('pronouns'), self.key('simple_language')
        found = await self.get('/api/problems?check=tone')
        self.assertEqual(found['problems'], [simple, pronouns])  # a proposal moves nothing: the most frequent first
        rules = {rule['id']: rule for rule in found['rules']}
        self.assertEqual((rules[pronouns]['serious'], rules[simple]['serious']), (True, False))
        self.assertEqual(rules[pronouns]['severity']['by'], 'model')
        self.assertTrue(rules[pronouns]['severity']['proposed']['serious'])
        self.assertTrue(rules[pronouns]['severity']['proposed']['reason'].startswith('Пояснение'))
        self.assertEqual(rules[simple]['severity']['proposed']['serious'], False)
        self.assertEqual(found['severity'], {'criteria': 2, 'proposed': 2, 'decided': 0, 'error': None})
        self.assertEqual(found['log']['withSerious'], 1)
        self.assertEqual((await self.get('/api/state'))['severity'], {'tone': [pronouns], 'code': []})

    async def test_only_a_person_s_decision_puts_a_criterion_first(self):
        """The model's proposal informs, a person's decision orders: a criterion only the model proposed as serious
        stays where the number of its errors puts it, and comes first once a person confirms it, though rarer. Its
        `serious` says it is serious now, whoever decided."""
        failing = {'d1': {'pronouns'}, 'd2': {'simple_language'}, 'd3': {'simple_language'}}
        await self.check_tone(failing, propose=proposing('«вы»'))
        pronouns, simple = self.key('pronouns'), self.key('simple_language')
        found = await self.get('/api/problems?check=tone')
        self.assertEqual(found['problems'], [simple, pronouns])
        self.assertEqual(
            [(rule['serious'], rule['severity']['by']) for rule in found['rules']], [(False, 'model'), (True, 'model')]
        )
        response = await self.post('/api/severity/confirm', {'check': 'tone'})
        self.assertEqual(response.status_code, 200, response.text)
        found = await self.get('/api/problems?check=tone')
        self.assertEqual(found['problems'], [pronouns, simple])
        self.assertEqual(
            [(rule['serious'], rule['severity']['by']) for rule in found['rules']],
            [(True, 'person'), (False, 'person')],
        )

    async def test_a_stop_while_the_model_proposes_ends_the_proposals_not_the_saved_check(self):
        asked = asyncio.Event()

        async def endless(*args, **kwargs):
            asked.set()
            await asyncio.Event().wait()

        draft = storage.documents.load(tone.DRAFT)
        request = {
            'ruleIds': ['pronouns', 'simple_language'],
            'count': 5,
            'revision': draft['revision'],
            'propose': True,
        }
        with (
            patch.object(conversations, 'judge_dialogue', side_effect=judge_by({'d1': {'pronouns'}})),
            patch.object(severity.models, 'chat', endless),
        ):
            response = await self.client.post('/api/tone-of-voice/check', json=request)
            self.assertEqual(response.status_code, 200, response.text)
            await asyncio.wait_for(asked.wait(), 2)
            stopped = await self.client.post('/api/job/stop')
            self.assertEqual(stopped.status_code, 200, stopped.text)
            await self.wait_job()
        self.assertIsNone(self.jobs.state['error'])  # not «Остановлено»: the check stands
        self.assertEqual(storage.documents.load(tone.RESULT)['summary']['failed'], 1)
        self.assertEqual(len(storage.history.lines('tone')), 1)

    async def test_a_check_not_asked_to_propose_asks_no_model(self):
        await self.check_tone({'d1': {'pronouns'}})
        found = await self.get('/api/problems?check=tone')
        self.assertEqual(found['severity'], {'criteria': 2, 'proposed': 0, 'decided': 0, 'error': None})
        self.assertFalse(any(rule['serious'] for rule in found['rules']))
        self.assertTrue(all(rule['severity'] == {'by': None, 'proposed': None} for rule in found['rules']))

    async def test_a_person_s_decision_wins_and_no_proposal_takes_it_back(self):
        await self.check_tone({'d1': {'pronouns'}}, propose=proposing('«вы»'))
        pronouns, simple = self.key('pronouns'), self.key('simple_language')
        await self.mark('pronouns', serious=False)  # the person disagrees: an error of form
        model = proposing('«вы»', 'канцеляризм')
        with patch.object(severity.models, 'chat', model):
            response = await self.post('/api/severity/propose', {'check': 'tone', 'again': True})
            self.assertEqual(response.status_code, 200, response.text)
            await self.wait_job()
        self.assertIsNone(self.jobs.state['error'])
        # The task says which check it proposes for: the screens lead to its criteria.
        self.assertEqual(self.jobs.state['progress'], {'message': 'Отмечаем важные критерии', 'check': 'tone'})
        self.assertEqual(len(json.loads(model.await_args.args[1])['criteria']), 1)  # the decided one is not asked about
        found = await self.get('/api/problems?check=tone')
        rules = {rule['id']: rule for rule in found['rules']}
        self.assertEqual((rules[pronouns]['serious'], rules[pronouns]['severity']['by']), (False, 'person'))
        self.assertEqual((rules[simple]['serious'], rules[simple]['severity']['by']), (True, 'model'))
        self.assertEqual(found['severity'], {'criteria': 2, 'proposed': 1, 'decided': 1, 'error': None})

    async def test_confirming_makes_the_proposals_a_person_s_decisions(self):
        await self.check_tone({'d1': {'pronouns'}}, propose=proposing('«вы»'))
        pronouns, simple = self.key('pronouns'), self.key('simple_language')
        stamp = (await self.get('/api/state'))['severityStamp']
        response = await self.post('/api/severity/confirm', {'check': 'tone'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['severity'], {'tone': [pronouns], 'code': []})
        found = await self.get('/api/problems?check=tone')
        self.assertEqual(
            {rule['id']: (rule['serious'], rule['severity']['by']) for rule in found['rules']},
            {pronouns: (True, 'person'), simple: (False, 'person')},
        )
        self.assertEqual(found['severity'], {'criteria': 2, 'proposed': 0, 'decided': 2, 'error': None})
        # The same criteria are serious, but whose decision it is changed: the screens ask again.
        self.assertNotEqual((await self.get('/api/state'))['severityStamp'], stamp)

    async def test_a_model_that_does_not_answer_leaves_the_check_and_says_why(self):
        down = proposing(fail=models.ModelError('Модель недоступна: ConnectError'))
        await self.check_tone({'d1': {'pronouns'}}, propose=down)  # the check itself stands, without an error
        self.assertIsNotNone(storage.documents.load(checks.result('tone')))
        found = await self.get('/api/problems?check=tone')
        self.assertEqual(
            found['severity'], {'criteria': 2, 'proposed': 0, 'decided': 0, 'error': 'Модель недоступна: ConnectError'}
        )
        # «Предложить» by hand: a failure is the task's error; then the model answers.
        with patch.object(severity.models, 'chat', down):
            await self.post('/api/severity/propose', {'check': 'tone'})
            await self.wait_job()
        self.assertIn('Модель недоступна', self.jobs.state['error'])
        with patch.object(severity.models, 'chat', proposing('«вы»')):
            response = await self.post('/api/severity/propose', {'check': 'tone'})
            self.assertEqual(response.status_code, 200, response.text)
            await self.wait_job()
        self.assertIsNone(self.jobs.state['error'])
        found = await self.get('/api/problems?check=tone')
        self.assertEqual(found['severity'], {'criteria': 2, 'proposed': 2, 'decided': 0, 'error': None})

    async def test_a_reply_answers_for_each_criterion_once(self):
        shown = [proposals.shown({'text': 'Не грубит'}, 'c1'), proposals.shown({'text': 'На вы'}, 'c2')]
        rows = [
            {'id': 'c1', 'serious': True, 'reason': 'Вред клиенту.'},
            {'id': 'c2', 'serious': False, 'reason': 'Форма.'},
        ]

        async def proposed(answer: object) -> dict:
            reply = models.Reply(json.dumps(answer, ensure_ascii=False), 'model-a')
            with patch.object(models, 'chat', AsyncMock(return_value=reply)):
                return (await proposals.propose('tone', shown)).value

        self.assertEqual(
            await proposed({'criteria': rows}),
            {'c1': {'serious': True, 'reason': 'Вред клиенту.'}, 'c2': {'serious': False, 'reason': 'Форма.'}},
        )
        for bad in (
            {'criteria': rows[:1]},
            {'criteria': [*rows, rows[0]]},
            {'criteria': [{**rows[0], 'id': 'c9'}, rows[1]]},
            {'criteria': [{**rows[0], 'serious': 'да'}, rows[1]]},
            {'criteria': [{**rows[0], 'reason': ' '}, rows[1]]},
            {'criteria': 'всё серьёзно'},
        ):
            with self.subTest(bad=bad), self.assertRaises(models.ModelError):
                await proposed(bad)

    async def test_marks_of_an_older_service_are_a_person_s_decisions(self):
        await self.check_tone({'d1': {'pronouns'}})
        pronouns, simple = self.key('pronouns'), self.key('simple_language')
        storage.documents.save('severity.json', {'tone': [pronouns], 'code': []})
        found = await self.get('/api/problems?check=tone')
        rule = next(rule for rule in found['rules'] if rule['id'] == pronouns)
        self.assertEqual((rule['serious'], rule['severity']['by']), (True, 'person'))
        self.assertEqual((await self.get('/api/state'))['severity'], {'tone': [pronouns], 'code': []})
        await self.mark('simple_language', serious=False)
        self.assertEqual(storage.severity.marks()['tone'], {pronouns: True, simple: False})

    async def test_an_accuracy_check_proposes_for_its_criteria_too(self):
        with patch.object(inputs.agent_sources, 'collect', return_value=([CODE], [])):
            await self.client.post('/api/sources')
            await self.wait_job()

        async def plan(srcs, dialogues):
            return [dict(CODE_TOPIC, dialogueIds=[str(d['id']) for d in dialogues])], 0

        model = proposing('срок')
        with (
            patch.object(accuracy, 'plan_topics', AsyncMock(side_effect=plan)),
            patch.object(conversations, 'judge_dialogue', side_effect=judged('FAIL')),
            patch.object(severity.models, 'chat', model),
        ):
            response = await self.client.post('/api/discover', json={'count': 5, 'propose': True})
            self.assertEqual(response.status_code, 200, response.text)
            await self.wait_job()
        self.assertIsNone(self.jobs.state['error'])
        self.assertEqual(
            json.loads(model.await_args.args[1])['criteria'][0]['requirement'], 'Агент называет срок доставки терминала'
        )
        found = await self.get('/api/problems?check=code')
        self.assertEqual([(rule['serious'], rule['severity']['by']) for rule in found['rules']], [(True, 'model')])
        self.assertEqual(found['severity'], {'criteria': 1, 'proposed': 1, 'decided': 0, 'error': None})

    async def test_the_counts_cover_the_criteria_of_the_result_only(self):
        await self.check_tone({'d1': {'pronouns'}}, propose=proposing('«вы»'))
        extra = {'id': 'x1', 'text': 'Агент называет клиента по имени', 'quote': 'Называйте клиента по имени'}
        item = {
            'cardId': 'card',
            'status': 'FAIL',
            'topic': 'Tone of voice',
            'criteria': [extra],
            'conversation': [{'role': 'customer', 'text': 'Привет'}],
            'rules': [{'ruleId': 'x1', 'status': 'FAIL', 'reason': 'Без имени', 'agentQuote': 'Здравствуйте'}],
        }
        storage.runs.create(
            {
                'id': 'run-tone',
                'check': 'tone',
                'startedAt': '2026-10-04T10:00:00+00:00',
                'finishedAt': '2026-10-04T10:10:00+00:00',
                'status': 'done',
                'items': [item],
            }
        )
        storage.severity.failed('tone', 'Модель недоступна: ConnectError')  # a later «Предложить снова» failed
        found = await self.get('/api/problems?check=tone')
        self.assertEqual(len(found['rules']), 3)  # a criterion only the run has is listed, but nobody proposes for it
        self.assertEqual(found['severity'], {'criteria': 2, 'proposed': 2, 'decided': 0, 'error': None})

"""Tone of voice and Точность: two checks of the same conversations, each with its own result, answers and scenarios."""

import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

import support
from test_tone import POLICY
from test_tone_followthrough import judged

from lab import models, storage
from lab.domain import judges as rules
from lab.flows import accuracy, answers, conversations, inputs, tone
from lab.flows import checks as results_of
from lab.flows import scenarios as cards

TONE_RESULT, CODE_RESULT = 'tone-result.json', 'discover.json'
CODE = {'id': 's1', 'kind': 'prompt', 'origin': 'agent.py:1', 'content': 'Называй срок доставки терминала.'}
CODE_TOPIC = {
    'id': 't1',
    'title': 'Терминалы',
    'dialogueIds': ['d1'],
    'rules': [
        {
            'id': 't1r1',
            'name': 'Называет срок',
            'text': 'Агент называет срок доставки терминала',
            'quote': 'Называй срок доставки терминала',
            'sourceId': 's1',
            'observation': 'reply',
            'condition': '',
            'acceptable': '',
        }
    ],
}


class ChecksTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        support.serve(self)
        self.dialogue = {
            'id': 'd1',
            'messages': [
                {'role': 'user', 'content': 'Когда привезут терминал?'},
                {'role': 'assistant', 'content': 'Привезём, жди.'},
            ],
        }
        await self.client.post('/api/logs?name=export.jsonl', content=json.dumps(self.dialogue))
        await self.client.post('/api/tone-of-voice/policy', json={'text': POLICY, 'name': 'ToV.docx'})
        await self.client.post('/api/tone-of-voice/criteria')
        await self.wait_job()
        with patch.object(inputs.agent_sources, 'collect', return_value=([CODE], [])):
            await self.client.post('/api/sources')
            await self.wait_job()
        self.assertIsNone(self.jobs.state['error'])

    async def wait_job(self):
        for _ in range(200):
            if not self.jobs.state['running']:
                return
            await asyncio.sleep(0.002)
        self.fail('background job did not finish')

    async def check_tone(self, status='FAIL', down=()):
        """A tone-of-voice check through its screen, the model replaced by a fake one; its error, if any."""
        draft = storage.documents.load(tone.DRAFT)
        request = {'ruleIds': ['pronouns'], 'count': 1, 'revision': draft['revision']}
        with patch.object(conversations, 'judge_dialogue', side_effect=judged(status, down=down)):
            response = await self.client.post('/api/tone-of-voice/check', json=request)
            self.assertEqual(response.status_code, 200, response.text)
            await self.wait_job()
        return self.jobs.state['error']

    async def assess_code(self, status='FAIL', replan=False):
        """The accuracy assessment («Оценить N разговоров») with its planner and its check replaced; its error."""
        with (
            patch.object(accuracy, 'plan_topics', AsyncMock(return_value=([CODE_TOPIC], 0))),
            patch.object(conversations, 'judge_dialogue', side_effect=judged(status)),
        ):
            response = await self.client.post('/api/discover', json={'count': 5, 'replan': replan})
            self.assertEqual(response.status_code, 200, response.text)
            await self.wait_job()
        return self.jobs.state['error']

    async def test_a_tone_check_and_the_accuracy_assessment_keep_each_others_results(self):
        self.assertIsNone(await self.assess_code())
        code = storage.documents.load(CODE_RESULT)
        self.assertEqual(code['topics'][0]['title'], 'Терминалы')
        self.assertIsNone(await self.check_tone())
        own = storage.documents.load(TONE_RESULT)
        self.assertEqual((own['purpose'], own['topics'][0]['title']), ('tone-of-voice', 'Tone of voice'))
        self.assertEqual(storage.documents.load(CODE_RESULT), code)
        # The accuracy assessment is no longer refused over a tone-of-voice result, and leaves it as it was.
        self.assertIsNone(await self.assess_code(status='PASS'))
        self.assertEqual(storage.documents.load(CODE_RESULT)['summary']['passed'], 1)
        self.assertEqual(storage.documents.load(TONE_RESULT), own)

    async def test_the_state_shows_the_result_of_each_check_with_its_summary(self):
        await self.assess_code()
        state = (await self.client.get('/api/state')).json()
        self.assertIsNone(state['checks']['tone'])
        await self.check_tone(status='PASS')
        state = (await self.client.get('/api/state')).json()
        self.assertNotIn('discover', state)
        # Each result in brief, its rules by set and version; its verdicts come from GET /api/checks/{check}, the kinds
        # of its errors with the problems: the brief says only how many criteria have them.
        for check, name in (('tone', TONE_RESULT), ('code', CODE_RESULT)):
            stored, brief = storage.documents.load(name), state['checks'][check]
            self.assertEqual(
                {k: v for k, v in brief.items() if k not in ('summary', 'conversations', 'answers', 'grouped')},
                {key: value for key, value in stored.items() if key not in ('summary', 'results', 'kinds')}
                | ({'judge': rules.brief(stored['judge'])} if stored.get('judge') else {}),
            )
            self.assertEqual(brief['grouped'], len(stored.get('kinds') or {}))
            if stored.get('judge'):
                self.assertNotIn('policy', brief['judge'])
            self.assertEqual(brief['conversations'], len(stored['results']))
            self.assertEqual(brief['answers']['measured'], stored['summary']['measured'])  # nobody answered yet
            self.assertNotIn('patterns', brief['summary'])
            shown = (await self.client.get(f'/api/checks/{check}')).json()
            self.assertEqual(
                (shown['results'], shown['summary']['patterns']), (stored['results'], stored['summary']['patterns'])
            )
        summaries = {check: state['checks'][check]['summary'] for check in ('tone', 'code')}
        self.assertEqual(
            {check: (s['passed'], s['failed']) for check, s in summaries.items()}, {'tone': (1, 0), 'code': (0, 1)}
        )
        # The agent's sources count the criteria of the accuracy result: the communication rules are tone of voice's.
        self.assertEqual({source['id']: source['rules'] for source in state['sources']}, {'s1': 1, 'tone-of-voice': 0})

    async def test_the_result_itself_comes_with_the_answers_on_its_verdicts(self):
        response = await self.client.get('/api/checks/tone')
        self.assertEqual(
            (response.status_code, response.json()['detail']), (404, 'У проверки «Tone of voice» ещё нет итога.')
        )
        await self.check_tone()
        result = storage.documents.load(TONE_RESULT)
        self.assertEqual((await self.answer(result['finishedAt'], 'pronouns')).status_code, 200)
        shown = (await self.client.get('/api/checks/tone')).json()
        row = next(row for row in shown['results'][0]['rules'] if row['ruleId'] == 'pronouns')
        self.assertEqual(row['review'], 'agree')
        self.assertNotIn('review', storage.documents.load(TONE_RESULT)['results'][0]['rules'][0])

    async def test_the_state_lists_each_run_with_its_check(self):
        item = {'cardId': 'c1', 'status': 'PASS', 'topic': 'Tone of voice', 'criteria': [], 'conversation': []}
        storage.runs.create({'id': 'run-1', 'status': 'done', 'items': [item]})
        state = (await self.client.get('/api/state')).json()
        self.assertEqual(state['runs'][0]['check'], 'tone')

    async def test_a_conversation_shows_its_evaluation_in_the_check_asked_for(self):
        async def criteria(query=''):
            evaluation = (await self.client.get(f'/api/logs/d1{query}')).json()['evaluation']
            return evaluation and [row['ruleId'] for row in evaluation['rules']]

        await self.assess_code()
        self.assertEqual(await criteria(), ['t1r1'])
        self.assertIsNone(await criteria('?check=tone'))
        await self.check_tone()
        self.assertEqual(await criteria(), ['pronouns'])  # without a check: tone of voice's, then Точность's
        self.assertEqual(await criteria('?check=tone'), ['pronouns'])
        self.assertEqual(await criteria('?check=code'), ['t1r1'])
        self.assertEqual((await self.client.get('/api/logs/d1?check=other')).status_code, 422)

    async def test_an_outage_says_the_previous_result_is_kept_only_when_the_check_has_one(self):
        self.assertIsNone(await self.assess_code())
        unanswered, advice = (
            'Модель не ответила ни по одному разговору.',
            ' Проверьте модель в разделе «Настройки».',
        )
        self.assertEqual(await self.check_tone(down={'d1'}), unanswered + advice)
        self.assertIsNone(storage.documents.load(TONE_RESULT))
        self.assertIsNone(await self.check_tone())
        self.assertEqual(await self.check_tone(down={'d1'}), unanswered + ' Прежний итог сохранён.' + advice)

    async def answer(self, finished_at, rule_id, **fields):
        body = {'source': 'log', 'dialogueId': 'd1', 'ruleId': rule_id, 'decision': 'agree', 'finishedAt': finished_at}
        return await self.client.post('/api/review', json=body | fields)

    @staticmethod
    def review(document, rule_id):
        """The answer on a criterion of the first conversation of a check's current result, as the screens see it."""
        check = {TONE_RESULT: 'tone', CODE_RESULT: 'code'}[document]
        rows = results_of.current(check)['results'][0]['rules']
        return next(row for row in rows if row['ruleId'] == rule_id).get('review')

    async def test_an_answer_lands_on_the_result_the_person_saw(self):
        await self.assess_code()
        await self.check_tone()
        tone_result, code_result = storage.documents.load(TONE_RESULT), storage.documents.load(CODE_RESULT)
        self.assertEqual((await self.answer(tone_result['finishedAt'], 'pronouns')).status_code, 200)
        self.assertEqual((await self.answer(code_result['finishedAt'], 't1r1')).status_code, 200)
        self.assertEqual((self.review(TONE_RESULT, 'pronouns'), self.review(CODE_RESULT, 't1r1')), ('agree', 'agree'))
        self.assertEqual(storage.reviews.listed('log', tone_result['checkId'])[0]['decision'], 'agree')
        # Without the result it was given on, the answer goes to the result that has this verdict.
        response = await self.answer(None, 't1r1', decision='disagree')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.review(CODE_RESULT, 't1r1'), 'disagree')
        # A result neither check has now: the person saw another one.
        response = await self.answer('2026-01-01T00:00:00+00:00', 'pronouns')
        self.assertEqual((response.status_code, response.json()['detail']), (409, answers.CHANGED))
        # A criterion no check has checked in this conversation.
        for fields in ({}, {'check': 'code'}):
            response = await self.answer(None, 'nope', **fields)
            self.assertEqual(
                (response.status_code, response.json()['detail']), (404, 'Этот критерий в разговоре не проверялся.')
            )

    async def test_an_answer_goes_to_the_check_it_names_and_waits_only_for_that_check(self):
        await self.assess_code()
        await self.check_tone()
        tone_result, code_result = storage.documents.load(TONE_RESULT), storage.documents.load(CODE_RESULT)
        # The check named is where the answer goes: the result the person saw must be that check's.
        response = await self.answer(code_result['finishedAt'], 'pronouns', check='tone')
        self.assertEqual((response.status_code, response.json()['detail']), (409, answers.CHANGED))
        self.assertEqual((await self.answer(None, 'pronouns', check='tone')).status_code, 200)
        self.assertEqual(self.review(TONE_RESULT, 'pronouns'), 'agree')
        # While a check runs, answers on its own result wait; the other check's result takes them.
        with support.running('discover'):
            code = await self.answer(code_result['finishedAt'], 't1r1', check='code')
            own = await self.answer(tone_result['finishedAt'], 'pronouns', check='tone', decision='disagree')
        self.assertEqual((code.status_code, own.status_code), (409, 200))
        self.assertEqual(
            code.json()['detail'], 'Ответ не сохранится, пока идёт проверка «Точность». Ответьте после неё.'
        )
        with support.running('tone-check'):
            code = await self.answer(code_result['finishedAt'], 't1r1')
            own = await self.answer(tone_result['finishedAt'], 'pronouns')
        self.assertEqual((code.status_code, own.status_code), (200, 409))
        self.assertEqual(
            (self.review(CODE_RESULT, 't1r1'), self.review(TONE_RESULT, 'pronouns')), ('agree', 'disagree')
        )
        self.assertEqual((await self.answer(None, 't1r1', check='accuracy')).status_code, 422)
        # A launch that checks the recorded answers writes its check's result as a check of its own does; one that only
        # asks the agent again writes none.
        with support.running('launch', {'check': 'tone', 'modes': ['dataset', 'questions']}):
            code = await self.answer(code_result['finishedAt'], 't1r1', decision='disagree')
            own = await self.answer(tone_result['finishedAt'], 'pronouns', decision='agree')
        self.assertEqual((code.status_code, own.status_code), (200, 409))
        with support.running('launch', {'check': 'tone', 'modes': ['questions']}):
            own = await self.answer(tone_result['finishedAt'], 'pronouns', decision='agree')
        self.assertEqual(own.status_code, 200)

    async def build_cards(self, body=None):
        async def build(topic, dialogue, origin, general, reproduces=()):
            return {'id': f'{topic["title"]}:{dialogue["id"]}', 'topic': topic['title'], 'criteria': topic['rules']}

        with patch.object(cards, 'build_card', side_effect=build):
            response = await self.client.post('/api/cards', json=body)
            if response.status_code == 200:
                await self.wait_job()
        return response

    async def test_scenarios_are_built_from_the_errors_of_one_check(self):
        self.assertEqual((await self.build_cards()).status_code, 200)
        self.assertEqual(
            self.jobs.state['error'], 'Сценарии собираются из найденных ошибок. Сначала проверьте разговоры.'
        )
        response = await self.build_cards({'check': 'code'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.jobs.state['error'], 'У проверки «Точность» ещё нет итога. Сначала проверьте разговоры.')
        await self.check_tone()
        self.assertEqual((await self.build_cards()).status_code, 200)  # the only check with a result
        self.assertIsNone(self.jobs.state['error'])
        deck = storage.documents.load(cards.DECK)
        self.assertEqual((deck['check'], [card['topic'] for card in deck['cards']]), ('tone', ['Tone of voice']))
        await self.assess_code()
        response = await self.build_cards({})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()['detail'], 'Выберите, из какой проверки собрать сценарии.')
        self.assertEqual(storage.documents.load(cards.DECK), deck)
        self.assertEqual((await self.build_cards({'check': 'code'})).status_code, 200)
        deck = storage.documents.load(cards.DECK)
        self.assertEqual((deck['check'], [card['topic'] for card in deck['cards']]), ('code', ['Терминалы']))
        self.assertEqual(set(deck), {'check', 'createdAt', 'model', 'cards'})
        self.assertEqual((await self.build_cards({'check': 'other'})).status_code, 422)

    async def test_tone_advice_and_history_read_the_tone_result_whatever_the_accuracy_assessment_did(self):
        await self.check_tone()
        own = storage.documents.load(TONE_RESULT)
        self.assertIsNone(await self.assess_code(replan=True))
        history = (await self.client.get('/api/tone-of-voice/history')).json()
        self.assertEqual([entry['id'] for entry in history['checks']], [own['checkId']])
        self.assertFalse(history['hasLegacyResult'])
        proposal = {'text': 'Пожалуйста, ожидайте терминал завтра.', 'explanation': 'Вежливо.'}
        request = {'finishedAt': own['finishedAt'], 'dialogueId': 'd1', 'ruleId': 'pronouns'}
        with patch.object(models, 'chat', AsyncMock(return_value=models.Reply(json.dumps(proposal), 'model-a'))):
            response = await self.client.post('/api/tone-of-voice/advice', json=request)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), proposal)


if __name__ == '__main__':
    unittest.main()

import asyncio
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from test_tone import POLICY

from lab import api, cards, discover, judge, llm, simulate, store, tone
from lab.jobs import Jobs


def judged(status='FAIL', model='model-a', down=()):
    """discover.judge_dialogue with a fake model: every criterion gets this verdict on the agent's reply; a conversation
    in `down` is one the model did not answer, so every criterion of it stays unknown, with the model's error."""

    async def judge(dialogue, topic):
        failed = dialogue['id'] in down
        return {
            'dialogueId': dialogue['id'],
            'topicId': topic['id'],
            'status': 'UNMEASURED' if failed else status,
            'rules': [
                {
                    'ruleId': rule['id'],
                    'rule': rule['text'],
                    'status': 'UNKNOWN' if failed else status,
                    'reason': '' if failed else 'Форма обращения не соответствует критерию.',
                    'agentQuote': '' if failed else dialogue['messages'][1]['content'],
                    'title': '' if failed else 'Форма обращения',
                }
                for rule in topic['rules']
            ],
            'opening': dialogue['messages'][0]['content'],
            'error': 'Модель недоступна: ConnectError' if failed else None,
            'model': None if failed else model,
            'second': None,
        }

    return judge


class ToneFollowthroughTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # The flow is checked with both judges: a second vendor configured.
        second = patch.object(llm, 'SECOND', ('http://second/v1', 'second-judge'))
        second.start()
        self.addCleanup(second.stop)
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
        self.other = {
            'id': 'd2',
            'messages': [
                {'role': 'user', 'content': 'Где мой терминал?'},
                {'role': 'assistant', 'content': 'Терминал привезут завтра, жди звонка.'},
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

    async def start_check(self, judge, rule_ids=None, count=1):
        draft = store.load(tone.DRAFT)
        with patch.object(discover, 'judge_dialogue', side_effect=judge):
            response = await self.client.post(
                '/api/tone-of-voice/check',
                json={
                    'ruleIds': rule_ids or ['pronouns', 'simple_language'],
                    'count': count,
                    'revision': draft['revision'],
                },
            )
            self.assertEqual(response.status_code, 200, response.text)
            await self.wait_job()

    async def check(self, rule_ids=None, model='model-a', count=1, down=(), status='FAIL'):
        await self.start_check(judged(status, model, down), rule_ids, count)
        self.assertIsNone(api.jobs.state['error'])
        return store.load(discover.RESULT)

    async def answer(self, result, rule_id, decision, dialogue_id='d1'):
        response = await self.client.post(
            '/api/review',
            json={
                'source': 'log',
                'dialogueId': dialogue_id,
                'ruleId': rule_id,
                'decision': decision,
                'finishedAt': result['finishedAt'],
            },
        )
        self.assertEqual(response.status_code, 200, response.text)

    @staticmethod
    def answers(result, dialogue_id='d1'):
        item = next(item for item in result['results'] if item['dialogueId'] == dialogue_id)
        return {row['ruleId']: (row['status'], row.get('review')) for row in item['rules']}

    async def upload(self, *dialogues, name='export.jsonl'):
        content = '\n'.join(json.dumps(dialogue, ensure_ascii=False) for dialogue in dialogues)
        response = await self.client.post(f'/api/logs?name={name}', content=content.encode())
        self.assertEqual(response.status_code, 200, response.text)

    async def test_a_check_the_model_could_not_answer_keeps_the_previous_result_scenarios_and_history(self):
        down = AsyncMock(side_effect=llm.ModelError('Модель недоступна: ConnectError'))
        request = {'ruleIds': ['pronouns'], 'count': 1, 'revision': store.load(tone.DRAFT)['revision']}
        with patch.object(llm, 'chat', down):
            await self.client.post('/api/tone-of-voice/check', json=request)
            await self.wait_job()
        self.assertEqual(api.jobs.state['error'], 'Модель проверки не ответила ни по одному разговору.')
        self.assertIsNone(store.load(discover.RESULT))
        previous = await self.check()
        deck = {'cards': [{'id': 'built-from-the-previous-check'}]}
        store.save(cards.DECK, deck)
        with patch.object(llm, 'chat', down):
            await self.client.post('/api/tone-of-voice/check', json=request)
            await self.wait_job()
        self.assertEqual(
            api.jobs.state['error'], 'Модель проверки не ответила ни по одному разговору. Прежний итог сохранён.'
        )
        self.assertEqual(store.load(discover.RESULT), previous)
        self.assertEqual(store.load(cards.DECK), deck)
        self.assertEqual(len(store.tone_checks()), 1)

    async def test_a_check_the_model_answered_in_part_is_published_with_the_rest_not_checked(self):
        await self.upload(self.dialogue, self.other)
        result = await self.check(count=2, down={'d2'})
        self.assertEqual((result['summary']['measured'], result['summary']['unmeasured']), (1, 1))
        self.assertEqual(len(store.tone_checks()), 1)

    async def test_an_answer_survives_a_check_that_could_not_decide_its_conversation(self):
        await self.upload(self.dialogue, self.other)
        first = await self.check(count=2)
        await self.answer(first, 'pronouns', 'agree')
        partial = await self.check(count=2, down={'d1'})
        self.assertEqual(self.answers(partial)['pronouns'], ('UNKNOWN', None))
        again = await self.check(count=2)
        self.assertEqual(self.answers(again), {'pronouns': ('FAIL', 'agree'), 'simple_language': ('FAIL', None)})
        self.assertEqual(store.tone_reviews(again['checkId'])[0]['decision'], 'agree')
        # Another verdict is another question; the same verdict again brings the answer back.
        changed = await self.check(count=2, status='PASS')
        self.assertEqual(self.answers(changed)['pronouns'], ('PASS', None))
        self.assertEqual(self.answers(await self.check(count=2))['pronouns'], ('FAIL', 'agree'))
        # A withdrawn answer is the latest word: an older check does not bring it back.
        latest = store.load(discover.RESULT)
        await self.answer(latest, 'pronouns', None)
        await self.check(count=2, down={'d1'})
        self.assertEqual(self.answers(await self.check(count=2))['pronouns'], ('FAIL', None))

    async def test_clarifying_one_criterion_keeps_the_answers_on_the_others(self):
        first = await self.check()
        await self.answer(first, 'pronouns', 'agree')
        await self.answer(first, 'simple_language', 'disagree')
        response = await self.client.post(
            '/api/tone-of-voice/clarification',
            json={
                'revision': store.load(tone.DRAFT)['revision'],
                'ruleId': 'pronouns',
                'text': 'Обращение на ты допустимо только в прямой цитате клиента.',
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        second = await self.check()
        self.assertEqual(self.answers(second), {'pronouns': ('FAIL', None), 'simple_language': ('FAIL', 'disagree')})

    async def test_an_answer_stays_with_its_conversation_not_with_an_id_a_new_export_reuses(self):
        first = await self.check()
        await self.answer(first, 'pronouns', 'agree')
        another = {**self.dialogue, 'messages': [*self.dialogue['messages'][:1], self.other['messages'][1]]}
        await self.upload(another, name='next.jsonl')
        self.assertEqual(self.answers(await self.check())['pronouns'], ('FAIL', None))
        await self.upload(self.dialogue, name='first-again.jsonl')
        self.assertEqual(self.answers(await self.check())['pronouns'], ('FAIL', 'agree'))

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

    async def test_new_check_invalidates_deck_and_retains_frozen_runs_and_previous_check(self):
        first = await self.check()
        previous = store.tone_check(first['checkId'])
        run = store.create_run({'id': 'played-before', 'status': 'completed', 'items': []})
        store.save(cards.DECK, {'cards': [{'id': 'stale-scenario'}]})
        await self.check()
        self.assertIsNone(store.load(cards.DECK))
        self.assertEqual(store.run(run['id']), run)
        self.assertEqual(store.tone_check(first['checkId']), previous)
        self.assertEqual(len(store.tone_checks()), 2)

    async def test_new_rubric_clears_cards_and_blocks_rebuilding_until_logs_are_rechecked(self):
        checked = await self.check()
        draft = store.load(tone.DRAFT)
        store.save(cards.DECK, {'cards': [{'id': 'stale-scenario'}]})
        response = await self.client.post(
            '/api/tone-of-voice/clarification',
            json={
                'revision': draft['revision'],
                'ruleId': 'pronouns',
                'text': 'Обращение на ты допустимо только в прямой цитате клиента.',
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(store.load(cards.DECK))
        self.assertEqual(store.load(discover.RESULT), checked)
        with patch.object(llm, 'chat', AsyncMock()) as model:
            await self.client.post('/api/cards')
            await self.wait_job()
            model.assert_not_awaited()
        self.assertIn('повторите проверку разговоров', api.jobs.state['error'])
        store.save(cards.DECK, {'cards': [{'id': 'also-stale'}]})
        await self.client.post('/api/tone-of-voice/criteria')
        await self.wait_job()
        self.assertIsNone(store.load(cards.DECK))
        self.assertEqual(store.load(discover.RESULT), checked)

    async def test_clarified_log_criterion_reaches_cards_and_both_simulation_judges(self):
        draft = store.load(tone.DRAFT)
        original_rule = draft['criteria'][0]
        note = 'Обращение на ты допустимо только в прямой цитате клиента.'
        await self.client.post(
            '/api/tone-of-voice/clarification',
            json={
                'revision': draft['revision'],
                'ruleId': 'pronouns',
                'text': note,
            },
        )
        await self.check(['pronouns'])
        with (
            patch.object(
                llm,
                'structured',
                AsyncMock(
                    return_value=llm.Answer(
                        {
                            'name': 'Передача документов',
                            'situation': 'Клиент уточняет, как передать документы.',
                        },
                        'scenario-model',
                    )
                ),
            ),
            patch.object(cards.world, 'build', AsyncMock(return_value=None)),
        ):
            await self.client.post('/api/cards')
            await self.wait_job()
        self.assertIsNone(api.jobs.state['error'])
        card = store.load(cards.DECK)['cards'][0]
        self.assertEqual(card['criteria'][0]['quote'], original_rule['quote'])
        self.assertEqual(card['criteria'][0]['clarifications'], [note])
        self.assertIn(note, card['criteria'][0]['text'])
        item = simulate.new_item(card, 'calm', 0)
        item['conversation'] = [{'role': 'agent', 'text': self.dialogue['messages'][1]['content']}]
        # A later card rebuild must not alter the criteria saved with the played conversation.
        card['criteria'][0]['text'] = 'New card criterion'
        seen = []

        async def chat(system, payload, **kwargs):
            seen.append(json.loads(payload))
            return llm.Answer(
                json.dumps(
                    {
                        'customerGoal': 'Передать документы',
                        'rules': [
                            {
                                'ruleId': 'pronouns',
                                'status': 'PASS',
                                'reason': 'Проверено с уточнением',
                                'agentQuote': self.dialogue['messages'][1]['content'],
                            }
                        ],
                    }
                ),
                'judge-model',
            )

        with patch.object(llm, 'chat', side_effect=chat), patch.object(judge.knowledge, 'retrieved', return_value=[]):
            await judge.evaluate({'criteria': item['criteria']}, item)
        self.assertEqual(len(seen), 2)
        self.assertTrue(all(note in data['expectations'][0]['text'] for data in seen))
        self.assertTrue(all(data['expectations'][0]['quote'] == original_rule['quote'] for data in seen))
        self.assertEqual((item['status'], item['second']['status']), ('PASS', 'PASS'))
        self.assertEqual(store.load(tone.DRAFT)['criteria'][0]['text'], original_rule['text'])

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

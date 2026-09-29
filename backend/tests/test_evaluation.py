import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

from lab import cards, discover, judge, llm, quotes
from lab.metric import metric


def criterion(rule_id='r1', observation='reply'):
    return {'id': rule_id, 'text': 'Помочь клиенту', 'observation': observation}


def verdict(rule_id='r1', status='PASS', quote='Вернуть терминал в банк'):
    return {
        'ruleId': rule_id,
        'status': status,
        'reason': 'Ответ соответствует вопросу.',
        'agentQuote': quote,
        'title': '',
    }


class EvaluationTests(unittest.TestCase):
    def test_pass_requires_every_applicable_criterion(self):
        cases = [
            (['PASS', 'UNKNOWN'], 'UNMEASURED'),
            (['PASS', 'NOT_APPLICABLE'], 'PASS'),
            (['FAIL', 'UNKNOWN'], 'FAIL'),
            (['NOT_APPLICABLE'], 'UNMEASURED'),
            ([], 'UNMEASURED'),
        ]
        for statuses, expected in cases:
            with self.subTest(statuses=statuses):
                self.assertEqual(judge.verdict_of([{'status': status} for status in statuses]), expected)
        value = metric([{'cardId': 'one', 'status': judge.verdict_of([verdict(), verdict('r2', 'UNKNOWN')])}])
        self.assertIsNone(value['accuracy'])
        self.assertEqual(value['unmeasured'], 1)

    def test_observation_needs_its_own_evidence(self):
        for observation in ('tool', 'state', 'knowledge'):
            with self.subTest(observation=observation):
                rows = judge.checked([verdict()], [criterion(observation=observation)], 'Вернуть терминал в банк')
                self.assertEqual(rows[0]['status'], 'UNKNOWN')
                self.assertEqual(rows[0]['agentQuote'], '')
        rows = judge.checked([verdict(status='NOT_APPLICABLE')], [criterion(observation='tool')], '')
        self.assertEqual(rows[0]['status'], 'NOT_APPLICABLE')

    def test_tool_evidence_cannot_ground_a_reply_criterion(self):
        rows = judge.checked(
            [verdict(quote='getLkkTariff')], [criterion()], 'Нужен номер терминала', tools='getLkkTariff'
        )
        self.assertEqual(rows[0]['status'], 'UNKNOWN')

    def test_quotes_preserve_fragment_order_and_cannot_reuse_a_match(self):
        self.assertTrue(quotes.found('Вернуть терминал…в банк', 'Вернуть терминал сегодня в банк'))
        self.assertFalse(quotes.found('в банк…Вернуть терминал', 'Вернуть терминал сегодня в банк'))
        self.assertFalse(quotes.found('Вернуть терминал…Вернуть терминал', 'Вернуть терминал'))
        self.assertFalse(quotes.found('да…да…да…да', 'да'))

    def test_grounding_never_substitutes_an_unrelated_source(self):
        topics = [{'title': 'Возврат', 'rules': [dict(criterion(), sourceId='missing', quote='Вернуть терминал')]}]
        grounded, dropped = discover.ground(topics, [{'id': 's1', 'content': 'Вернуть терминал в банк'}])
        self.assertEqual(dropped, 1)
        self.assertEqual(grounded[0]['rules'], [])
        self.assertEqual(len(topics[0]['rules']), 1)


class ModelAnswerTests(unittest.IsolatedAsyncioTestCase):
    async def test_topic_planning_retries_missing_and_duplicated_assignments(self):
        dialogue = {'id': 'stable', 'messages': [{'role': 'user', 'content': 'Вернуть терминал'}]}
        source = {'id': 's1', 'content': 'Вернуть терминал в банк'}
        rule = dict(criterion(), sourceId='s1', quote=source['content'], condition='', acceptable='')
        topic = {'title': 'Возврат', 'dialogueIds': ['d1'], 'rules': [rule]}
        for assigned in ([], ['d1', 'd1'], ['other']):
            with self.subTest(assigned=assigned):
                bad = {'topics': [dict(topic, dialogueIds=assigned)]}
                good = {'topics': [topic]}
                with patch.object(llm, 'chat', AsyncMock(side_effect=[json.dumps(bad), json.dumps(good)])) as chat:
                    topics, dropped = await discover.plan_topics([source], [dialogue])
                self.assertEqual(chat.await_count, 2)
                self.assertEqual(topics[0]['dialogueIds'], ['stable'])
                self.assertEqual(dropped, 0)

    async def test_frozen_topics_retry_unknown_assignments(self):
        dialogue = {'id': 'stable', 'messages': [{'role': 'user', 'content': 'Вернуть терминал'}]}
        previous = {'topics': [{'id': 't1', 'title': 'Возврат', 'rules': []}], 'results': []}
        bad = {'assignments': [{'dialogueId': 'd1', 'topicId': 'unknown'}]}
        good = {'assignments': [{'dialogueId': 'd1', 'topicId': 't1'}]}
        with patch.object(llm, 'chat', AsyncMock(side_effect=[json.dumps(bad), json.dumps(good)])) as chat:
            topics = await discover.keep_topics(previous, [dialogue])
        self.assertEqual(chat.await_count, 2)
        self.assertEqual(topics[0]['dialogueIds'], ['stable'])

    async def test_full_verdict_validation_retries_malformed_rows(self):
        valid = {'rules': [verdict()]}
        invalid = [
            {'rules': None},
            {'rules': []},
            {'rules': ['PASS']},
            {'rules': [dict(verdict(), ruleId='other')]},
            {'rules': [dict(verdict(), status='MAYBE')]},
            {'rules': [dict(verdict(), reason=1)]},
            {'rules': [dict(verdict(), agentQuote=None)]},
            {'rules': [dict(verdict(), agentQuote='')]},
            {'rules': [dict(verdict(), title=[])]},
        ]
        for answer in invalid:
            with self.subTest(answer=answer):
                chat = AsyncMock(side_effect=[json.dumps(answer), json.dumps(valid)])
                with patch.object(llm, 'chat', chat):
                    rows, status = await judge.log_verdict(
                        [criterion()], [{'role': 'AGENT', 'text': 'Вернуть терминал в банк'}]
                    )
                self.assertEqual(chat.await_count, 2)
                self.assertEqual(status, 'PASS')
                self.assertEqual(rows[0]['ruleId'], 'r1')

    async def test_duplicate_verdict_ids_are_retried(self):
        answer = {'rules': [verdict(), verdict()]}
        valid = {'rules': [verdict(), verdict('r2')]}
        with patch.object(llm, 'chat', AsyncMock(side_effect=[json.dumps(answer), json.dumps(valid)])) as chat:
            rows, status = await judge.log_verdict(
                [criterion(), criterion('r2')], [{'role': 'AGENT', 'text': 'Вернуть терминал в банк'}]
            )
        self.assertEqual(chat.await_count, 2)
        self.assertEqual([row['ruleId'] for row in rows], ['r1', 'r2'])
        self.assertEqual(status, 'PASS')

    async def test_structured_retries_non_object_json(self):
        with patch.object(llm, 'chat', AsyncMock(side_effect=['[]', '{"ready": true}'])) as chat:
            answer = await llm.structured('System', {})
        self.assertEqual(answer, {'ready': True})
        self.assertEqual(chat.await_count, 2)

    async def test_run_rejects_tool_claim_in_answer_and_accepts_recorded_call(self):
        answer = {'customerGoal': 'Узнать тариф', 'rules': [verdict(quote='getLkkTariff')]}
        card = {'criteria': [criterion(observation='tool')]}
        for events, expected in (([], 'UNMEASURED'), ([{'tool': 'Система банка · getLkkTariff'}], 'PASS')):
            with (
                self.subTest(events=events),
                patch.object(llm, 'chat', AsyncMock(return_value=json.dumps(answer))),
                patch.object(judge.knowledge, 'retrieved', return_value=[]),
            ):
                _, status = await judge.run_verdict(card, [{'role': 'agent', 'text': 'getLkkTariff', 'events': events}])
            self.assertEqual(status, expected)

    async def test_generated_handoff_marker_cannot_replace_missing_reply_evidence(self):
        answer = {'customerGoal': 'Вернуть терминал', 'rules': [verdict(quote='разговор передан оператору')]}
        with (
            patch.object(llm, 'chat', AsyncMock(return_value=json.dumps(answer))),
            patch.object(judge.knowledge, 'retrieved', return_value=[]),
        ):
            _, status = await judge.run_verdict(
                {'criteria': [criterion()]}, [{'role': 'agent', 'text': 'Нет ответа', 'ok': False, 'status': 500}]
            )
        self.assertEqual(status, 'UNMEASURED')

    async def test_knowledge_needs_supplied_articles(self):
        answer = {'customerGoal': 'Вернуть терминал', 'rules': [verdict(status='FAIL')]}
        for articles, expected in (([], 'UNMEASURED'), ([{'article': 'a', 'text': 'Вернуть терминал в банк'}], 'FAIL')):
            with (
                self.subTest(articles=articles),
                patch.object(llm, 'chat', AsyncMock(return_value=json.dumps(answer))),
                patch.object(judge.knowledge, 'retrieved', return_value=articles),
            ):
                _, status = await judge.run_verdict(
                    {'criteria': [criterion(observation='knowledge')]},
                    [{'role': 'agent', 'text': 'Вернуть терминал в банк'}],
                )
            self.assertEqual(status, expected)

    async def test_failed_primary_joins_second_judge_and_keeps_model_error_contract(self):
        cancelled = asyncio.Event()

        async def model(card, conversation, endpoint=None):
            if endpoint is None:
                await asyncio.sleep(0)
                raise llm.ModelError('failed')
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        item = {'conversation': []}
        with patch.object(judge, 'run_verdict', model), self.assertRaises(llm.ModelError):
            await judge.evaluate({}, item)
        self.assertTrue(cancelled.is_set())
        self.assertNotIn('status', item)

    async def test_audit_produces_results_without_saving(self):
        dialogue = {
            'id': 'stable',
            'messages': [{'role': 'user', 'content': 'Вопрос'}, {'role': 'assistant', 'content': 'Ответ'}],
        }
        topic = {'id': 't1', 'title': 'Возврат', 'dialogueIds': ['stable'], 'rules': [criterion()]}
        result = {'dialogueId': 'stable', 'topicId': 't1', 'status': 'UNMEASURED', 'rules': [], 'opening': 'Вопрос'}
        with (
            patch.object(discover.sources, 'load', return_value=[{'id': 's1', 'kind': 'prompt', 'content': 'text'}]),
            patch.object(discover, 'sample', return_value=[dialogue]),
            patch.object(discover.store, 'load', return_value={}),
            patch.object(discover, 'plan_topics', AsyncMock(return_value=([topic], 0))),
            patch.object(discover, 'judge_dialogue', AsyncMock(return_value=result)),
            patch.object(discover.store, 'save') as save,
        ):
            analysis = await discover.run()
        self.assertEqual(analysis['results'][0]['dialogueId'], 'stable')
        self.assertNotIn('runId', analysis['results'][0])
        save.assert_not_called()

    async def test_card_generation_does_not_commit(self):
        with (
            patch.object(cards.store, 'load', return_value={'topics': [], 'results': []}),
            patch.object(cards.logs, 'load', return_value=[]),
            patch.object(cards.store, 'save') as save,
        ):
            result = await cards.run()
        self.assertEqual(result, [])
        save.assert_not_called()

import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

import support

from lab import config, models, roles, storage
from lab.domain import export, quotes, verdicts
from lab.domain.accuracy import ground
from lab.domain.metric import metric
from lab.flows import accuracy, conversations, simulation
from lab.flows import scenarios as cards
from lab.roles import judge as roles_judge
from lab.roles.judge import RuleReply


def completion(value):
    return models.Reply(json.dumps(value), 'actual-main')


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
                self.assertEqual(verdicts.verdict_of([{'status': status} for status in statuses]), expected)
        value = metric([{'cardId': 'one', 'status': verdicts.verdict_of([verdict(), verdict('r2', 'UNKNOWN')])}])
        self.assertIsNone(value['accuracy'])
        self.assertEqual(value['unmeasured'], 1)

    def test_observation_needs_its_own_evidence(self):
        for observation in ('tool', 'state', 'knowledge'):
            with self.subTest(observation=observation):
                rows = verdicts.checked(
                    [RuleReply.model_validate(verdict())],
                    [criterion(observation=observation)],
                    'Вернуть терминал в банк',
                )
                self.assertEqual(rows[0]['status'], 'UNKNOWN')
                self.assertEqual(rows[0]['agentQuote'], '')
        rows = verdicts.checked(
            [RuleReply.model_validate(verdict(status='NOT_APPLICABLE'))], [criterion(observation='tool')], ''
        )
        self.assertEqual(rows[0]['status'], 'NOT_APPLICABLE')

    def test_tool_evidence_cannot_ground_a_reply_criterion(self):
        rows = verdicts.checked(
            [RuleReply.model_validate(verdict(quote='getLkkTariff'))],
            [criterion()],
            'Нужен номер терминала',
            tools='getLkkTariff',
        )
        self.assertEqual(rows[0]['status'], 'UNKNOWN')

    def test_quotes_preserve_fragment_order_and_cannot_reuse_a_match(self):
        self.assertTrue(quotes.found('Вернуть терминал…в банк', 'Вернуть терминал сегодня в банк'))
        self.assertFalse(quotes.found('в банк…Вернуть терминал', 'Вернуть терминал сегодня в банк'))
        self.assertFalse(quotes.found('Вернуть терминал…Вернуть терминал', 'Вернуть терминал'))
        self.assertFalse(quotes.found('да…да…да…да', 'да'))

    def test_a_verdict_cannot_stitch_short_parts_into_words_the_agent_never_said(self):
        reply = 'Оформить возврат можно в личном кабинете, но деньги вернуть нельзя после закрытия смены.'
        other = 'Вернуть деньги на карту нельзя. Можно оформить возврат через терминал.'
        for quote, text in (
            ('Оформить возврат можно … деньги вернуть', reply),
            ('Вернуть деньги на карту … можно', other),
        ):
            with self.subTest(quote=quote):
                rows = verdicts.checked([RuleReply.model_validate(verdict(quote=quote))], [criterion()], text)
                self.assertEqual(rows[0]['status'], 'UNKNOWN')
                self.assertFalse(quotes.cited(quote, text))
        # Long parts stand, and so does the agent's own «…» quoted whole.
        quote = 'Оформить возврат можно в личном кабинете … деньги вернуть нельзя после закрытия смены'
        rows = verdicts.checked([RuleReply.model_validate(verdict(quote=quote))], [criterion()], reply)
        self.assertEqual(rows[0]['status'], 'PASS')
        # A long part that starts right after the «нельзя» it leaves out does not.
        self.assertFalse(quotes.cited('Оформить возврат можно в личном кабинете … после закрытия смены', reply))
        self.assertTrue(quotes.cited('Минутку… Проверяю данные', 'Минутку… Проверяю данные по терминалу.'))

    def test_a_quote_that_leaves_out_a_negation_is_not_the_agents_words(self):
        """«можно оплатить картой» is not in «невозможно оплатить картой»: a quote starts where a word starts, and
        never right after a «не» it leaves out. A verdict standing on such a quote counts as not measured."""
        reply = 'К сожалению, это невозможно оплатить картой. Терминал недоступен для возврата. Не обещаем сроки.'
        for quote in ('можно оплатить картой', 'доступен для возврата', 'обещаем сроки', 'ожно оплатить картой'):
            with self.subTest(quote=quote):
                self.assertFalse(quotes.cited(quote, reply))
                rows = verdicts.checked([RuleReply.model_validate(verdict(quote=quote))], [criterion()], reply)
                self.assertEqual(rows[0]['status'], 'UNKNOWN')
        for quote in ('невозможно оплатить картой', 'Не обещаем сроки', 'Терминал недоступен для возврата'):
            with self.subTest(quote=quote):
                self.assertTrue(quotes.cited(quote, reply))
        # The same for a criterion grounded in the agent's code: «обещай сроки» is not what «Не обещай сроки» says.
        self.assertFalse(quotes.found('обещай сроки клиенту', 'Никогда не обещай сроки клиенту.'))
        self.assertTrue(quotes.found('не обещай сроки клиенту', 'Никогда не обещай сроки клиенту.'))

    def test_a_faithful_copy_written_with_other_typography_is_the_same_quote(self):
        reply = 'Поддержка работает с 9:00 до 18:00 — по Москве… Приложение «Бизнес­Онлайн» обновится в пятницу.'
        for quote in (
            'с 9:00 до 18:00 - по Москве',
            'с 9:00 до 18:00 – по Москве',
            'по Москве... Приложение',
            'Приложение «БизнесОнлайн» обновится',
        ):
            with self.subTest(quote=quote):
                self.assertTrue(quotes.cited(quote, reply))
        decomposed = 'Пожалуйста, подойдите к кассе № 2'.replace('й', 'й')
        self.assertTrue(quotes.cited('Пожалуйста, подойдите к кассе', decomposed))
        self.assertTrue(quotes.cited('Клиент’s заказ готов к выдаче', "Клиент's заказ готов к выдаче"))
        # The key decisions are stored by does not change with this.
        self.assertEqual(quotes.normalized('Время — по «Москве»'), 'время — по москве')

    def test_grounding_never_substitutes_an_unrelated_source(self):
        topics = [{'title': 'Возврат', 'rules': [dict(criterion(), sourceId='missing', quote='Вернуть терминал')]}]
        grounded, dropped = ground(topics, [{'id': 's1', 'content': 'Вернуть терминал в банк'}])
        self.assertEqual(dropped, 1)
        self.assertEqual(grounded[0]['rules'], [])
        self.assertEqual(len(topics[0]['rules']), 1)


class ModelAnswerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # These tests exercise the second judge, which runs only with a second vendor configured.
        self.settings = support.lab(self, second_url='http://second/v1', second_model='second-judge')

    async def test_both_judges_share_prepared_evidence_and_next_evaluation_refreshes_it(self):
        payloads = []
        first = [{'article': 'first', 'text': 'Первая версия статьи'}]
        second = [{'article': 'second', 'text': 'Вторая версия статьи'}]

        async def model(system, messages, **kwargs):
            payloads.append(json.loads(messages)['knowledge'])
            return completion({'customerGoal': 'Вернуть терминал', 'rules': [verdict()]})

        with (
            patch.object(simulation.knowledge, 'retrieved', side_effect=[first, second]) as retrieve,
            patch.object(models, 'chat', model),
        ):
            for _ in range(2):
                item = {'conversation': [{'role': 'agent', 'text': 'Вернуть терминал в банк'}]}
                await simulation.evaluate({'criteria': [criterion()]}, item)
                self.assertEqual(item['status'], 'PASS')
            self.assertEqual(retrieve.call_count, 2)
        self.assertEqual(payloads, [first, first, second, second])

    async def test_missing_customer_goal_is_retried_for_run_only(self):
        without_goal = {'rules': [verdict()]}
        with_goal = dict(without_goal, customerGoal='Вернуть терминал')
        with (
            patch.object(
                models, 'chat', AsyncMock(side_effect=[completion(without_goal), completion(with_goal)])
            ) as chat,
            patch.object(simulation.knowledge, 'retrieved', return_value=[]),
        ):
            result = await simulation.run_verdict(
                {'criteria': [criterion()]}, [{'role': 'agent', 'text': 'Вернуть терминал в банк'}]
            )
        self.assertEqual(chat.await_count, 2)
        self.assertEqual(result.status, 'PASS')

    async def test_failed_second_judge_preserves_primary_verdict_and_shared_evidence(self):
        async def model(system, messages, *, endpoint=None, **kwargs):
            if endpoint is not None:
                raise models.ModelError('second judge unavailable')
            return completion({'customerGoal': 'Вернуть терминал', 'rules': [verdict()]})

        with (
            patch.object(models, 'chat', model),
            patch.object(simulation.knowledge, 'retrieved', return_value=[]) as retrieve,
        ):
            item = {'conversation': [{'role': 'agent', 'text': 'Вернуть терминал в банк'}]}
            await simulation.evaluate({'criteria': [criterion()]}, item)
        self.assertEqual(retrieve.call_count, 1)
        self.assertEqual(item['status'], 'PASS')
        self.assertEqual(item['second']['status'], 'ERROR')

    async def test_a_dialogue_the_model_could_not_judge_stays_unmeasured_instead_of_failing_the_check(self):
        dialogue = {
            'id': 'd1',
            'messages': [{'role': 'user', 'content': 'Вопрос'}, {'role': 'assistant', 'content': 'Ответ'}],
        }
        topic = {'id': 't1', 'rules': [criterion('r1'), criterion('r2')]}
        with patch.object(conversations.judge, 'log_verdict', AsyncMock(side_effect=models.ModelError('timeout'))):
            result = await conversations.judge_dialogue(dialogue, topic)
        self.assertEqual(result['status'], 'UNMEASURED')
        self.assertEqual([row['status'] for row in result['rules']], ['UNKNOWN', 'UNKNOWN'])
        self.assertEqual(result['error'], 'timeout')

    async def test_with_one_model_there_is_no_second_check(self):
        calls = []

        async def model(system, messages, *, endpoint=None, **kwargs):
            calls.append(endpoint)
            return completion({'rules': [verdict()]})

        same = ('http://model', 'glm')
        dialogue = {
            'id': 'd1',
            'messages': [
                {'role': 'user', 'content': 'Вопрос'},
                {'role': 'assistant', 'content': 'Вернуть терминал в банк'},
            ],
        }
        one = {'model_url': same[0], 'model': same[1], 'second_url': None, 'second_model': None}
        with config.using(support.changed(self.settings, **one)), patch.object(models, 'chat', model):
            result = await conversations.judge_dialogue(dialogue, {'id': 't1', 'rules': [criterion()]})
        self.assertIsNone(result['second'])
        self.assertEqual(len(calls), 1)

    async def test_topic_planning_retries_an_answer_that_places_too_few_conversations(self):
        dialogue = {'id': 'stable', 'messages': [{'role': 'user', 'content': 'Вернуть терминал'}]}
        source = {'id': 's1', 'content': 'Вернуть терминал в банк'}
        rule = dict(criterion(), sourceId='s1', quote=source['content'], condition='', acceptable='')
        topic = {'title': 'Возврат', 'dialogueIds': ['d1'], 'rules': [rule]}
        for assigned in ([], ['other']):
            with self.subTest(assigned=assigned):
                bad = {'topics': [dict(topic, dialogueIds=assigned)]}
                good = {'topics': [topic]}
                with patch.object(models, 'chat', AsyncMock(side_effect=[completion(bad), completion(good)])) as chat:
                    topics, dropped = await accuracy.plan_topics([source], [dialogue])
                self.assertEqual(chat.await_count, 2)
                self.assertEqual(topics[0]['dialogueIds'], ['stable'])
                self.assertEqual(dropped, 0)

    async def test_a_planner_that_leaves_out_or_repeats_a_few_of_many_conversations_is_not_asked_again(self):
        """One conversation left out of twenty is in no topic (it counts as «не удалось проверить»), one repeated stays
        in its first topic: the whole check is not lost to one slip in an answer about hundreds of conversations."""
        dialogues = [{'id': f'c{n}', 'messages': [{'role': 'user', 'content': 'Вернуть терминал'}]} for n in range(20)]
        source = {'id': 's1', 'content': 'Вернуть терминал в банк'}
        rule = dict(criterion(), sourceId='s1', quote=source['content'], condition='', acceptable='')
        first = {'title': 'Возврат', 'dialogueIds': [f'd{n}' for n in range(1, 20)], 'rules': [rule]}
        second = {'title': 'Тарифы', 'dialogueIds': ['d1', 'd2'], 'rules': [rule]}
        answer = completion({'topics': [first, second]})
        with patch.object(models, 'chat', AsyncMock(return_value=answer)) as chat:
            topics, _ = await accuracy.plan_topics([source], dialogues)
        self.assertEqual(chat.await_count, 1)
        self.assertEqual(topics[0]['dialogueIds'], [f'c{n}' for n in range(19)])
        self.assertEqual(topics[1]['dialogueIds'], [])
        previous = {'topics': [{'id': 't1', 'title': 'Возврат', 'rules': []}], 'results': []}
        assignments = [{'dialogueId': f'd{n}', 'topicId': 't1'} for n in (1, 1, *range(2, 20))]
        with patch.object(models, 'chat', AsyncMock(return_value=completion({'assignments': assignments}))) as chat:
            topics = await accuracy.keep_topics(previous, dialogues)
        self.assertEqual(chat.await_count, 1)
        self.assertEqual(topics[0]['dialogueIds'], [f'c{n}' for n in range(19)])

    async def test_frozen_topics_retry_unknown_assignments(self):
        dialogue = {'id': 'stable', 'messages': [{'role': 'user', 'content': 'Вернуть терминал'}]}
        previous = {'topics': [{'id': 't1', 'title': 'Возврат', 'rules': []}], 'results': []}
        bad = {'assignments': [{'dialogueId': 'd1', 'topicId': 'unknown'}]}
        good = {'assignments': [{'dialogueId': 'd1', 'topicId': 't1'}]}
        with patch.object(models, 'chat', AsyncMock(side_effect=[completion(bad), completion(good)])) as chat:
            topics = await accuracy.keep_topics(previous, [dialogue])
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
            {'rules': [dict(verdict(), reason='  ')]},
            {'rules': [dict(verdict(), agentQuote=None)]},
            {'rules': [dict(verdict(), agentQuote='')]},
            {'rules': [dict(verdict(), agentQuote='  ')]},
            {'rules': [dict(verdict(), title=[])]},
        ]
        for answer in invalid:
            with self.subTest(answer=answer):
                chat = AsyncMock(side_effect=[completion(answer), completion(valid)])
                with patch.object(models, 'chat', chat):
                    result = await roles_judge.log_verdict(
                        [criterion()], [{'role': 'AGENT', 'text': 'Вернуть терминал в банк'}]
                    )
                self.assertEqual(chat.await_count, 2)
                self.assertEqual(result.status, 'PASS')
                self.assertEqual(result.rows[0]['ruleId'], 'r1')

    async def test_a_criterion_that_was_not_measured_needs_no_quote_or_reason(self):
        """A null, missing or empty quote or reason on such a row keeps the rest of the reply; a verdict still needs
        both."""
        unmeasured = (
            {'ruleId': 'r2', 'status': 'NOT_APPLICABLE', 'reason': 'Задержки не было.', 'agentQuote': None},
            {'ruleId': 'r2', 'status': 'NOT_APPLICABLE', 'reason': 'Задержки не было.'},
            {'ruleId': 'r2', 'status': 'UNKNOWN', 'reason': '', 'agentQuote': ''},
            {'ruleId': 'r2', 'status': 'UNKNOWN', 'reason': None},
        )
        for row in unmeasured:
            with self.subTest(row=row):
                chat = AsyncMock(return_value=completion({'rules': [verdict(), row]}))
                with patch.object(models, 'chat', chat):
                    result = await roles_judge.log_verdict(
                        [criterion(), criterion('r2')], [{'role': 'AGENT', 'text': 'Вернуть терминал в банк'}]
                    )
                self.assertEqual(chat.await_count, 1)
                self.assertEqual([r['status'] for r in result.rows], ['PASS', row['status']])
                kept = result.rows[1]
                self.assertEqual((kept['agentQuote'], kept['reason']), ('', row.get('reason') or ''))
        valid = {'rules': [verdict()]}
        without_quote = {key: value for key, value in verdict().items() if key != 'agentQuote'}
        for measured in (without_quote, dict(verdict(), reason=None), dict(verdict(status='FAIL'), agentQuote=None)):
            with self.subTest(measured=measured):
                chat = AsyncMock(side_effect=[completion({'rules': [measured]}), completion(valid)])
                with patch.object(models, 'chat', chat):
                    await roles_judge.log_verdict([criterion()], [{'role': 'AGENT', 'text': 'Вернуть терминал в банк'}])
                self.assertEqual(chat.await_count, 2)

    async def test_the_labs_line_of_buttons_is_never_the_agents_words(self):
        """A logged reply is shown with «[Кнопки: …]» for the export's control code; a FAIL quoting that line, or the
        code in it, has no evidence. In a played conversation a button's label is the agent's own text."""
        reply = 'Нажмите кнопку ниже.\n` ` ` transition-code TRANSFER_INTO_CHAT ` ` `'
        dialogue = {
            'id': 'd1',
            'messages': [{'role': 'user', 'content': 'Как вернуть терминал?'}, {'role': 'assistant', 'content': reply}],
        }
        rules = [criterion('special_characters')]
        for quote, expected in (
            ('[Кнопки: TRANSFER_INTO_CHAT]', 'UNKNOWN'),
            ('Кнопки: TRANSFER_INTO_CHAT', 'UNKNOWN'),
            ('TRANSFER_INTO_CHAT', 'UNKNOWN'),
            ('Нажмите кнопку ниже.', 'FAIL'),
        ):
            answer = {'rules': [verdict('special_characters', 'FAIL', quote)]}
            with self.subTest(quote=quote), patch.object(models, 'chat', AsyncMock(return_value=completion(answer))):
                result = await roles_judge.log_verdict(rules, export.conversation(dialogue))
                self.assertEqual(result.rows[0]['status'], expected)
        played = [{'role': 'agent', 'text': 'Выберите, что сделать дальше.', 'options': ['Позвать оператора']}]
        for quote, expected in (('Позвать оператора', 'PASS'), ('[Кнопки: Позвать оператора]', 'UNMEASURED')):
            answer = {'customerGoal': 'Вернуть терминал', 'rules': [verdict(quote=quote)]}
            with (
                self.subTest(quote=quote),
                patch.object(models, 'chat', AsyncMock(return_value=completion(answer))),
                patch.object(simulation.knowledge, 'retrieved', return_value=[]),
            ):
                result = await simulation.run_verdict({'criteria': [criterion()]}, played)
                self.assertEqual(result.status, expected)

    async def test_duplicate_verdict_ids_are_retried(self):
        answer = {'rules': [verdict(), verdict()]}
        valid = {'rules': [verdict(), verdict('r2')]}
        with patch.object(models, 'chat', AsyncMock(side_effect=[completion(answer), completion(valid)])) as chat:
            result = await roles_judge.log_verdict(
                [criterion(), criterion('r2')], [{'role': 'AGENT', 'text': 'Вернуть терминал в банк'}]
            )
        self.assertEqual(chat.await_count, 2)
        self.assertEqual([row['ruleId'] for row in result.rows], ['r1', 'r2'])
        self.assertEqual(result.status, 'PASS')

    async def test_an_answer_that_is_no_json_object_is_asked_again(self):
        with patch.object(
            models, 'chat', AsyncMock(side_effect=[models.Reply('[]', 'broken'), completion({'ready': True})])
        ) as chat:
            answer = await roles.ask(roles.Role('test', 'System', dict), {})
        self.assertEqual(answer.value, {'ready': True})
        self.assertEqual(answer.model, 'actual-main')
        self.assertEqual(chat.await_count, 2)

    async def test_run_rejects_tool_claim_in_answer_and_accepts_recorded_call(self):
        answer = {'customerGoal': 'Узнать тариф', 'rules': [verdict(quote='getLkkTariff')]}
        card = {'criteria': [criterion(observation='tool')]}
        for events, expected in (([], 'UNMEASURED'), ([{'tool': 'Система банка · getLkkTariff'}], 'PASS')):
            with (
                self.subTest(events=events),
                patch.object(models, 'chat', AsyncMock(return_value=completion(answer))),
                patch.object(simulation.knowledge, 'retrieved', return_value=[]),
            ):
                result = await simulation.run_verdict(
                    card, [{'role': 'agent', 'text': 'getLkkTariff', 'events': events}]
                )
            self.assertEqual(result.status, expected)

    async def test_generated_handoff_marker_cannot_replace_missing_reply_evidence(self):
        answer = {'customerGoal': 'Вернуть терминал', 'rules': [verdict(quote='разговор передан оператору')]}
        with (
            patch.object(models, 'chat', AsyncMock(return_value=completion(answer))),
            patch.object(simulation.knowledge, 'retrieved', return_value=[]),
        ):
            result = await simulation.run_verdict(
                {'criteria': [criterion()]}, [{'role': 'agent', 'text': 'Нет ответа', 'ok': False, 'status': 500}]
            )
        self.assertEqual(result.status, 'UNMEASURED')

    async def test_knowledge_needs_supplied_articles(self):
        answer = {'customerGoal': 'Вернуть терминал', 'rules': [verdict(status='FAIL')]}
        for articles, expected in (([], 'UNMEASURED'), ([{'article': 'a', 'text': 'Вернуть терминал в банк'}], 'FAIL')):
            with (
                self.subTest(articles=articles),
                patch.object(models, 'chat', AsyncMock(return_value=completion(answer))),
                patch.object(simulation.knowledge, 'retrieved', return_value=articles),
            ):
                result = await simulation.run_verdict(
                    {'criteria': [criterion(observation='knowledge')]},
                    [{'role': 'agent', 'text': 'Вернуть терминал в банк'}],
                )
            self.assertEqual(result.status, expected)

    async def test_failed_primary_joins_second_judge_and_keeps_model_error_contract(self):
        cancelled = asyncio.Event()

        async def model(system, messages, *, endpoint=None, **kwargs):
            if endpoint is None:
                await asyncio.sleep(0)
                raise models.ModelError('failed')
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        item = {'conversation': []}
        with (
            patch.object(models, 'chat', model),
            patch.object(simulation.knowledge, 'retrieved', return_value=[]),
            self.assertRaises(models.ModelError),
        ):
            await simulation.evaluate({'criteria': []}, item)
        self.assertTrue(cancelled.is_set())
        self.assertNotIn('status', item)

    async def test_audit_produces_results_without_saving(self):
        dialogue = {
            'id': 'stable',
            'messages': [{'role': 'user', 'content': 'Вопрос'}, {'role': 'assistant', 'content': 'Ответ'}],
        }
        storage.exports.add([dialogue], None)  # the export a check is made of; its sample is the patched one
        topic = {'id': 't1', 'title': 'Возврат', 'dialogueIds': ['stable'], 'rules': [criterion()]}
        result = {'dialogueId': 'stable', 'topicId': 't1', 'status': 'UNMEASURED', 'rules': [], 'opening': 'Вопрос'}
        with (
            patch.object(accuracy.inputs, 'sources', return_value=[{'id': 's1', 'kind': 'prompt', 'content': 'text'}]),
            patch.object(accuracy.conversations, 'sample', return_value=[dialogue]),
            patch.object(storage.documents, 'load', return_value={}),
            patch.object(accuracy, 'plan_topics', AsyncMock(return_value=([topic], 0))),
            patch.object(accuracy.conversations, 'judge_dialogue', AsyncMock(return_value=result)),
            patch.object(storage.documents, 'save') as save,
        ):
            analysis = await accuracy.assess()
        self.assertEqual(analysis['results'][0]['dialogueId'], 'stable')
        self.assertNotIn('runId', analysis['results'][0])
        save.assert_not_called()

    async def test_audit_never_turns_the_tone_policy_into_agent_rules(self):
        dialogue = {
            'id': 'stable',
            'messages': [{'role': 'user', 'content': 'Вопрос'}, {'role': 'assistant', 'content': 'Ответ'}],
        }
        storage.exports.add([dialogue], None)  # the export a check is made of; its sample is the patched one
        code = {'id': 's1', 'kind': 'prompt', 'content': 'text'}
        policy = {'id': 'tone-of-voice', 'kind': 'tone-of-voice', 'content': 'Обращайтесь к клиенту на вы.'}
        topic = {'id': 't1', 'title': 'Возврат', 'dialogueIds': ['stable'], 'rules': [criterion()]}
        result = {'dialogueId': 'stable', 'topicId': 't1', 'status': 'UNMEASURED', 'rules': [], 'opening': 'Вопрос'}
        plan = AsyncMock(return_value=([topic], 0))
        with (
            patch.object(accuracy.inputs, 'sources', return_value=[code, policy]),
            patch.object(accuracy.conversations, 'sample', return_value=[dialogue]),
            patch.object(storage.documents, 'load', return_value=None),
            patch.object(accuracy, 'plan_topics', plan),
            patch.object(accuracy.conversations, 'judge_dialogue', AsyncMock(return_value=result)),
        ):
            analysis = await accuracy.assess()
        plan.assert_awaited_once_with([code], [dialogue])
        self.assertEqual([source['id'] for source in analysis['sources']], ['s1'])
        self.assertNotIn('purpose', analysis)

    async def test_an_assessment_without_the_agents_code_names_where_to_read_it(self):
        policy = {'id': 'tone-of-voice', 'kind': 'tone-of-voice', 'content': 'Обращайтесь к клиенту на вы.'}
        with (
            patch.object(accuracy.inputs, 'sources', return_value=[policy]),
            patch.object(storage.documents, 'load', return_value=None),
            self.assertRaises(RuntimeError) as refused,
        ):
            await accuracy.assess()
        self.assertEqual(str(refused.exception), 'Код агента ещё не прочитан. Прочитайте его в разделе «Агент».')

    async def test_card_generation_does_not_commit(self):
        export = storage.exports.add([{'id': 'd'}], None)
        with (
            patch.object(storage.documents, 'load', return_value={'topics': [], 'results': [], 'export': export}),
            patch.object(cards.scenarios, 'pick', return_value=[({}, 'd', 'Coverage')]),
            patch.object(cards, 'build_card', AsyncMock(return_value={'id': 'card', 'model': 'actual-main'})),
            patch.object(storage.documents, 'save') as save,
        ):
            result = await cards.built('code')
        self.assertEqual(result, [{'id': 'card', 'model': 'actual-main'}])
        save.assert_not_called()

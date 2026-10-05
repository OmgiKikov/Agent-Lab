"""Each role on a fake model: its answer is read into its type and held to its rule, an answer that fails either is
asked again once, and every try goes to the journal with the role, the version of its instructions and what it was
about, never with the conversation."""

import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx
import support

from lab import models, roles, store
from lab.roles import advice, customer, judge, planner, scenario, severity, tone, world

Client = httpx.AsyncClient
POLICY = {'id': 'tone-of-voice', 'content': 'Обращайтесь к клиенту на вы и отвечайте вежливо.'}
SOURCE = {'id': 's1', 'content': 'Вернуть терминал в банк можно в любом отделении.'}
CRITERION = {'id': 'r1', 'text': 'Помочь клиенту', 'observation': 'reply'}
PASSED = {'ruleId': 'r1', 'status': 'PASS', 'reason': 'Ответил по делу.', 'agentQuote': 'Вернуть терминал в банк'}


def answering(*answers: object):
    """A model at an address that answers these in turn (an object as its JSON, words as they are), and the requests
    it got."""
    requests = []

    def handler(request):
        requests.append(json.loads(request.content))
        said = answers[len(requests) - 1]
        content = said if isinstance(said, str) else json.dumps(said, ensure_ascii=False)
        body = {'choices': [{'message': {'content': content}}], 'model': 'actual', 'usage': {'prompt_tokens': 7}}
        return httpx.Response(200, json=body)

    client = patch.object(
        httpx, 'AsyncClient', side_effect=lambda **kwargs: Client(transport=httpx.MockTransport(handler), **kwargs)
    )
    return client, requests


class RoleCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        support.lab(self)

    async def asked(self, role: roles.Role, call, unusable: object, usable: object):
        """The role asked through `call`: the first answer is refused and asked again, the second taken. Its journal:
        two tries of this role and version, about the subject the call was made in."""
        client, requests = answering(unusable, usable)
        with client, models.about('check:test'):
            answer = await call()
        self.assertEqual(len(requests), 2)
        lines = store.calls('check:test')
        self.assertEqual([line['outcome'] for line in lines], ['unusable', 'answered'])
        self.assertEqual({(line['role'], line['version']) for line in lines}, {(role.name, role.version)})
        self.assertEqual(
            (lines[1]['answeredBy'], lines[1]['inputTokens'], lines[1]['via']), ('actual', 7, '127.0.0.1:9')
        )
        self.assertEqual(answer.model, 'actual')
        return answer


class EachRoleTests(RoleCase):
    async def test_the_planner_places_enough_requests(self):
        rule = dict(CRITERION, sourceId='s1', quote=SOURCE['content'], condition='', acceptable='', name='Возврат')
        good = {'topics': [{'id': 't1', 'title': 'Возврат', 'dialogueIds': ['d1'], 'rules': [rule], 'gap': ''}]}
        answer = await self.asked(
            planner.PLANNER,
            lambda: planner.plan('task', [SOURCE], [{'id': 'd1', 'customer': 'Как вернуть терминал?'}]),
            {'topics': [dict(good['topics'][0], dialogueIds=[])]},
            good,
        )
        # What the planner wrote stays as it wrote it, what no field names (name, gap, id) included.
        self.assertEqual(answer.value, good['topics'])

    async def test_the_router_places_new_requests_in_known_topics(self):
        answer = await self.asked(
            planner.ROUTER,
            lambda: planner.place([{'id': 't1', 'title': 'Возврат'}], [{'id': 'd1', 'customer': 'Как вернуть?'}]),
            {'assignments': [{'dialogueId': 'd1', 'topicId': 'unknown'}]},
            {'assignments': ['not an assignment', {'dialogueId': 'd1', 'topicId': 't1'}]},
        )
        self.assertEqual(answer.value, [('d1', 't1')])

    async def test_the_judge_of_a_logged_conversation_gives_one_row_on_each_criterion(self):
        shown = [{'role': 'AGENT', 'text': 'Вернуть терминал в банк'}]
        verdict = await self.asked(
            judge.JUDGE_LOG, lambda: judge.log_verdict([CRITERION], shown), {'rules': []}, {'rules': [PASSED]}
        )
        self.assertEqual((verdict.status, verdict.version), ('PASS', judge.JUDGE_LOG.version))

    async def test_the_judge_of_a_played_conversation_names_the_goal(self):
        evidence = judge.Evidence([CRITERION], {'expectations': [CRITERION]}, 'Вернуть терминал в банк', '', False)
        answer = await self.asked(
            judge.JUDGE_RUN,
            lambda: judge.run_verdict(evidence),
            {'rules': [PASSED]},
            {'rules': [PASSED], 'customerGoal': 'Вернуть терминал'},
        )
        self.assertEqual((answer.status, answer.version), ('PASS', judge.JUDGE_RUN.version))

    async def test_the_criteria_of_tone_quote_the_rules(self):
        row = {'name': 'На вы', 'text': 'Обращаться на вы', 'condition': '', 'acceptable': ''}
        answer = await self.asked(
            tone.CRITERIA,
            lambda: tone.criteria(POLICY),
            {'criteria': [dict(row, quote='Обращайтесь к клиенту на ты')]},
            {'criteria': [dict(row, quote='Обращайтесь к клиенту на вы')]},
        )
        self.assertEqual(
            answer.value,
            [dict(row, quote='Обращайтесь к клиенту на вы', id='t1r1', sourceId='tone-of-voice', observation='reply')],
        )

    async def test_severity_proposes_for_every_criterion_once(self):
        shown = [severity.shown({'text': 'Не грубит'}, 'c1')]
        answer = await self.asked(
            severity.SEVERITY,
            lambda: severity.propose('tone', shown),
            {'criteria': [{'id': 'c1', 'serious': 'yes', 'reason': 'Обидит клиента.'}]},
            {'criteria': [{'id': 'c1', 'serious': True, 'reason': ' Обидит клиента. '}]},
        )
        self.assertEqual(answer.value, {'c1': {'serious': True, 'reason': 'Обидит клиента.'}})

    async def test_a_scenario_has_a_name_and_a_situation(self):
        answer = await self.asked(
            scenario.SCENARIO,
            lambda: scenario.scenario('Тарифы', ['Какой у меня тариф?']),
            {'name': ' ', 'situation': 'Клиент узнаёт тариф'},
            {'name': 'Тариф', 'situation': 'Клиент узнаёт тариф'},
        )
        self.assertEqual((answer.value.name, answer.value.situation), ('Тариф', 'Клиент узнаёт тариф'))

    async def test_a_world_has_the_shapes_of_the_stand(self):
        shapes = {'getLkkTariff': {'rate': 1.0}}
        organization = {'name': 'ООО «Ромашка»', 'inn': '7701234567', 'merchantName': 'Ромашка', 'address': 'Москва'}
        answer = await self.asked(
            world.WORLD,
            lambda: world.world('Клиент узнаёт тариф', ['Какой мой тариф?'], shapes),
            {'organization': organization, 'terminals': {}},
            {'organization': organization, 'terminals': [], 'tools': {'getLkkTariff': {'rate': 2.5}}},
        )
        self.assertEqual(answer.value['tools'], {'getLkkTariff': {'rate': 2.5}})

    async def test_advice_keeps_the_numbers_of_the_agent_s_words(self):
        evidence = {'targetExcerpt': 'Оплатите 100 рублей до 5 октября.'}
        answer = await self.asked(
            advice.ADVICE,
            lambda: advice.suggest(evidence, 'rewrite', ''),
            {'text': 'Пожалуйста, оплатите 200 рублей до 5 октября.', 'explanation': 'Вежливее.'},
            {'text': 'Пожалуйста, оплатите 100 рублей до 5 октября.', 'explanation': 'Вежливее.'},
        )
        self.assertEqual(answer.value['text'], 'Пожалуйста, оплатите 100 рублей до 5 октября.')

    async def test_the_customer_answers_in_words_once(self):
        client, requests = answering(' «Какой у меня тариф?» ', '"Какой тариф?"')
        with client, models.about('run:test'):
            line = await customer.reply('Клиент узнаёт тариф', 'АГЕНТ: Здравствуйте!', 'ИНН 7701234567', 'торопится')
            opening = await customer.opening('Какой тариф?', 'торопится')
        self.assertEqual(line.value, 'Какой у меня тариф?')
        self.assertEqual(opening.value, 'Какой тариф?')
        system = requests[0]['messages'][0]['content']
        self.assertIn('Клиент узнаёт тариф', system)
        self.assertIn(
            'Реквизиты (называй их, если агент спросит номер терминала, организацию или ИНН): ИНН 7701234567', system
        )
        self.assertIn('Твоя манера общения (она важнее правил о длине и стиле ниже): торопится', system)
        self.assertNotIn('response_format', requests[0])
        roles_asked = [(line['role'], line['version']) for line in store.calls('run:test')]
        self.assertEqual(
            roles_asked,
            [(customer.CUSTOMER.name, customer.CUSTOMER.version), (customer.OPENING.name, customer.OPENING.version)],
        )


class AskTests(RoleCase):
    async def test_an_answer_is_read_into_the_type_of_its_role(self):
        value = {'rules': [{'ruleId': 'r', 'status': 'UNKNOWN', 'reason': 'Нет доказательств', 'agentQuote': ''}]}
        with patch.object(models, 'chat', AsyncMock(return_value=models.Reply(json.dumps(value), 'actual-model'))):
            answer = await roles.ask(judge.JUDGE_LOG, {})
        self.assertIsInstance(answer.value, judge.JudgeReply)
        self.assertEqual((answer.value.rules[0].rule_id, answer.value.rules[0].title), ('r', ''))
        self.assertEqual(answer.model, 'actual-model')

    async def test_a_broken_envelope_is_asked_again_and_the_model_that_answered_is_kept(self):
        calls = []

        def handler(request):
            calls.append(request)
            if len(calls) == 1:
                return httpx.Response(200, json={'choices': []})
            body = {'choices': [{'message': {'content': '{"ready":true}'}}], 'model': 'actual-model'}
            return httpx.Response(200, json=body)

        with patch.object(
            httpx, 'AsyncClient', side_effect=lambda **kwargs: Client(transport=httpx.MockTransport(handler), **kwargs)
        ):
            answer = await roles.ask(roles.Role('test', 'system', dict), {}, model=('http://provider/v1', 'alias'))
        self.assertEqual(len(calls), 2)
        self.assertEqual(answer, roles.Answer({'ready': True}, 'actual-model'))
        self.assertEqual([line['outcome'] for line in store.calls()], ['unusable', 'answered'])

    async def test_an_unfinished_code_fence_is_asked_again(self):
        replies = [models.Reply('```json', 'bad'), models.Reply('{"ready":true}', 'good')]
        with patch.object(models, 'chat', AsyncMock(side_effect=replies)) as chat:
            answer = await roles.ask(roles.Role('test', 'system', dict), {})
        self.assertEqual((chat.await_count, answer.model), (2, 'good'))

    async def test_an_answer_that_cannot_be_used_is_told_in_plain_words_and_its_words_never_reach_the_journal(self):
        """The person reads what happened and what to do; whoever looks into it finds the parser's words in the log
        and the journal, never the answer's, which quote the conversation."""
        secret = 'Карта клиента 2200 1234'
        answer = {'rules': [{'ruleId': 'r1', 'status': 'MAYBE', 'reason': secret, 'agentQuote': secret}]}
        client, _ = answering(answer, answer)
        with (
            client,
            self.assertRaises(models.ModelError) as caught,
            self.assertLogs('lab.roles.base', 'WARNING') as logged,
        ):
            await judge.log_verdict([CRITERION], [{'role': 'AGENT', 'text': 'Вернуть терминал'}])
        told = str(caught.exception)
        self.assertEqual(told, roles.base.UNUSABLE)
        self.assertIn('rules.0.status', caught.exception.detail)
        self.assertIn('rules.0.status', '\n'.join(logged.output))
        lines = store.calls()
        self.assertEqual([line['outcome'] for line in lines], ['unusable', 'unusable'])
        self.assertTrue(all(secret not in json.dumps(line, ensure_ascii=False) for line in lines))
        self.assertNotIn(secret, '\n'.join(logged.output))


class VersionTests(unittest.TestCase):
    def test_a_version_changes_with_the_instructions_or_the_shape_of_the_answer_and_only_then(self):
        role = roles.Role('test', 'Answer briefly.', scenario.Scenario)
        self.assertEqual(role.version, roles.Role('other', 'Answer briefly.', scenario.Scenario).version)
        self.assertNotEqual(role.version, roles.Role('test', 'Answer at length.', scenario.Scenario).version)
        self.assertNotEqual(role.version, roles.Role('test', 'Answer briefly.', severity.Proposals).version)
        self.assertNotEqual(role.version, roles.Role('test', 'Answer briefly.', str).version)
        self.assertRegex(role.version, r'^[0-9a-f]{12}$')

    def test_every_role_has_instructions_and_a_name_of_its_own(self):
        every = [
            planner.PLANNER,
            planner.ROUTER,
            judge.JUDGE_LOG,
            judge.JUDGE_RUN,
            tone.CRITERIA,
            severity.SEVERITY,
            scenario.SCENARIO,
            world.WORLD,
            customer.CUSTOMER,
            customer.OPENING,
            advice.ADVICE,
        ]
        self.assertEqual(len({role.name for role in every}), 11)
        self.assertEqual(len({role.version for role in every}), 11)
        self.assertTrue(all(role.instructions.strip() and not role.instructions.endswith('\n') for role in every))


if __name__ == '__main__':
    unittest.main()

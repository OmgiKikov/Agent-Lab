import asyncio
import json
import unittest
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from unittest.mock import AsyncMock, patch

import httpx

from lab import judge, llm
from lab.judge_reply import JudgeReply

Client = httpx.AsyncClient


def client_for(handler):
    return lambda **kwargs: Client(transport=httpx.MockTransport(handler), **kwargs)


def json_response(value):
    return httpx.Response(200, json=value)


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_structured_returns_parsed_reply_without_leaving_an_untyped_dictionary(self):
        value = {'rules': [{'ruleId': 'r', 'status': 'UNKNOWN', 'reason': 'Нет доказательств', 'agentQuote': ''}]}
        with patch.object(llm, 'chat', AsyncMock(return_value=llm.Answer(json.dumps(value), 'actual-model'))):
            answer = await llm.structured('system', {}, parse=JudgeReply.model_validate)
        self.assertIsInstance(answer.value, JudgeReply)
        self.assertEqual(answer.value.rules[0].rule_id, 'r')
        self.assertEqual(answer.value.rules[0].status, 'UNKNOWN')
        self.assertEqual(answer.value.rules[0].title, '')
        self.assertEqual(answer.model, 'actual-model')

    async def test_openai_malformed_envelopes_are_model_errors_for_plain_chat(self):
        invalid = [
            [],
            {},
            {'choices': []},
            {'choices': [None]},
            {'choices': [{'message': None}]},
            {'choices': [{'message': {'content': 42}}]},
            {'choices': [{'message': {'content': None}}]},
            {'choices': [{'message': {'content': ['answer']}}]},
            {'choices': [{'message': {'content': 'answer'}}], 'model': 42},
        ]
        for body in invalid:
            with (
                self.subTest(body=body),
                patch.object(
                    llm.httpx, 'AsyncClient', side_effect=client_for(lambda _, body=body: json_response(body))
                ),
                self.assertRaises(llm.ModelError),
            ):
                await llm.chat('system', 'question', endpoint=('http://provider/v1', 'requested'))

    async def test_non_json_provider_reply_is_model_error_and_check_returns_failure(self):
        with patch.object(
            llm.httpx, 'AsyncClient', side_effect=client_for(lambda _: httpx.Response(200, text='<html>broken</html>'))
        ):
            with self.assertRaises(llm.ModelError):
                await llm.chat('system', 'question', endpoint=('http://provider/v1', 'requested'))
            self.assertFalse((await llm.check(('http://provider/v1', 'requested')))['ok'])

    async def test_a_typo_in_the_model_address_is_a_model_error_and_check_says_so(self):
        endpoint = ('http://127.0.0.1:84 43/v1', 'requested')
        with patch.object(llm.httpx, 'AsyncClient', side_effect=client_for(lambda _: json_response({}))):
            with self.assertRaises(llm.ModelError) as caught:
                await llm.chat('system', 'question', endpoint=endpoint)
            checked = await llm.check(endpoint)
        self.assertIn('LAB_MODEL_URL', str(caught.exception))
        self.assertEqual(checked, {'ok': False, 'error': str(caught.exception)})

    async def test_structured_retries_bad_envelope_and_carries_successful_model(self):
        calls = []

        def handler(request):
            calls.append(request)
            if len(calls) == 1:
                return json_response({'choices': []})
            return json_response({'choices': [{'message': {'content': '{"ready":true}'}}], 'model': 'actual-model'})

        with patch.object(llm.httpx, 'AsyncClient', side_effect=client_for(handler)):
            result = await llm.structured(
                'system', {}, parse=lambda value: value, endpoint=('http://provider/v1', 'requested-alias')
            )
        self.assertEqual(len(calls), 2)
        self.assertEqual(result, llm.Answer({'ready': True}, 'actual-model'))

    async def test_unfinished_code_fence_is_retried(self):
        replies = [llm.Answer('```json', 'bad'), llm.Answer('{"ready":true}', 'good')]
        with patch.object(llm, 'chat', AsyncMock(side_effect=replies)) as chat:
            result = await llm.structured('system', {}, parse=lambda value: value)
        self.assertEqual(chat.await_count, 2)
        self.assertEqual(result.model, 'good')

    async def test_an_answer_that_cannot_be_used_is_told_in_plain_words_and_its_technical_text_goes_to_the_log(self):
        """«Не удалось получить ответ модели: ValueError: expected business topics» showed a Python class and an
        internal message: the person reads what happened and what to do, whoever looks into it finds the text in the
        log."""

        def parse(value: dict) -> dict:
            raise ValueError('expected business topics')

        replies = [llm.Answer('{"topics": []}', 'm'), llm.Answer('{"topics": []}', 'm')]
        # The error passes through the innermost assertLogs: what was logged on the way stays in `logged`.
        with (
            patch.object(llm, 'chat', AsyncMock(side_effect=replies)),
            self.assertRaises(llm.ModelError) as caught,
            self.assertLogs('lab.llm', 'WARNING') as logged,
        ):
            await llm.structured('system', {}, parse=parse)
        told = str(caught.exception)
        self.assertNotIn('ValueError', told)
        self.assertNotIn('expected business topics', told)
        self.assertIn('Попробуйте ещё раз', told)
        self.assertIn('«Настройки»', told)
        self.assertEqual(caught.exception.detail, 'ValueError: expected business topics')
        self.assertIn('ValueError: expected business topics', '\n'.join(logged.output))

    async def test_gateway_malformed_envelopes_are_model_errors(self):
        invalid = [
            [],
            {},
            {'messages': []},
            {'messages': [None]},
            {'messages': [{'role': 'assistant', 'content': 'text'}]},
            {'messages': [{'role': 'assistant', 'content': [None]}]},
            {'messages': [{'role': 'assistant', 'content': [{'text': 42}]}]},
            {'messages': [{'role': 'assistant', 'content': [{'text': 'answer'}]}], 'model': 42},
        ]
        for body in invalid:
            client = Client(transport=httpx.MockTransport(lambda _, body=body: json_response(body)))
            with (
                self.subTest(body=body),
                patch.object(llm.gateway, '_client', return_value=(client, 'http://gateway')),
                self.assertRaises(llm.ModelError),
            ):
                await llm.chat('system', 'question', endpoint=(llm.GATEWAY, 'requested'))

    async def test_gateway_auto_and_returned_model_identity_are_explicit(self):
        body = {'messages': [{'role': 'assistant', 'content': [{'text': 'hello '}, {'text': 'world'}]}]}
        client = Client(transport=httpx.MockTransport(lambda _, body=body: json_response(body)))
        with (
            patch.object(llm.gateway, '_client', return_value=(client, 'http://gateway')),
            patch.object(llm.gateway, 'auto_models', AsyncMock(return_value={'model': 'chosen-main'})),
        ):
            result = await llm.chat('system', 'question', endpoint=(llm.GATEWAY, 'auto'))
        self.assertEqual(result, llm.Answer('hello world', 'chosen-main'))
        body['model'] = 'returned-model'
        client = Client(transport=httpx.MockTransport(lambda _, body=body: json_response(body)))
        with patch.object(llm.gateway, '_client', return_value=(client, 'http://gateway')):
            result = await llm.chat('system', 'question', endpoint=(llm.GATEWAY, 'requested'))
        self.assertEqual(result.model, 'returned-model')

    async def test_gateway_bad_catalog_is_a_model_error(self):
        for body in ([], {}, {'data': [None]}, {'data': [{'id': 42}]}):
            client = Client(transport=httpx.MockTransport(lambda _, body=body: json_response(body)))
            with (
                self.subTest(body=body),
                patch.object(llm.gateway, '_client', return_value=(client, 'http://gateway')),
                self.assertRaises(llm.ModelError),
            ):
                await llm.gateway.catalog()

    async def test_concurrent_judges_keep_actual_model_identity_per_call(self):
        criterion = {'id': 'r', 'text': 'Ответить клиенту', 'observation': 'reply'}
        row = {'ruleId': 'r', 'status': 'PASS', 'reason': 'Ответ получен', 'agentQuote': 'Подробный ответ клиенту'}

        def handler(request):
            requested = json.loads(request.content)['model']
            return json_response(
                {
                    'choices': [
                        {'message': {'content': json.dumps({'customerGoal': 'Получить ответ', 'rules': [row]})}}
                    ],
                    'model': 'actual-' + requested,
                }
            )

        with (
            patch.object(llm, 'MAIN', ('http://provider/v1', 'main-alias')),
            patch.object(llm, 'SECOND', ('http://provider/v1', 'second-alias')),
            patch.object(llm.httpx, 'AsyncClient', side_effect=client_for(handler)),
            patch.object(judge.knowledge, 'retrieved', return_value=[]),
        ):
            items = [{'conversation': [{'role': 'agent', 'text': 'Подробный ответ клиенту'}]} for _ in range(3)]
            await asyncio.gather(*(judge.evaluate({'criteria': [criterion]}, item) for item in items))
        for item in items:
            self.assertEqual(item['model'], 'actual-main-alias')
            self.assertEqual(item['second']['model'], 'actual-second-alias')
            self.assertEqual(item['status'], 'PASS')

    def test_models_used_is_derived_from_results_not_last_process_call(self):
        self.assertEqual(
            llm.models_used([{'model': 'first'}, {'model': 'second'}, {'model': 'first'}]), 'first, second'
        )
        self.assertEqual(llm.models_used([{}]), llm.MODEL)


ANSWER = {'choices': [{'message': {'content': '{"ready": true}'}}], 'model': 'm'}


def answered(body: dict = ANSWER):
    return lambda request: json_response(body)


def status(code: int, **headers: str):
    return lambda request: httpx.Response(code, headers=headers)


def broken(kind: type[httpx.TransportError]):
    def reply(request):
        raise kind('network', request=request)

    return reply


class RetryTests(unittest.IsolatedAsyncioTestCase):
    """What is asked again and after which pause; asyncio.sleep is patched, nothing waits for real."""

    async def ask(self, *replies, structured: bool = False):
        """(answer or ModelError, requests the provider got, pauses taken) for these replies in turn."""
        requests, pauses = [], []

        def handler(request):
            requests.append(request)
            return replies[len(requests) - 1](request)

        async def call():
            if structured:
                return await llm.structured('system', {}, parse=lambda value: value, endpoint=('http://p/v1', 'm'))
            return await llm.chat('system', 'question', endpoint=('http://p/v1', 'm'))

        with (
            patch.object(llm.httpx, 'AsyncClient', side_effect=client_for(handler)),
            patch.object(llm.asyncio, 'sleep', AsyncMock(side_effect=pauses.append)),
        ):
            try:
                result = await call()
            except llm.ModelError as error:
                result = error
        return result, len(requests), pauses

    async def test_a_busy_model_is_asked_again_after_the_pause_it_asked_for(self):
        result, requests, pauses = await self.ask(status(429, **{'Retry-After': '7'}), answered())
        self.assertEqual((result.model, requests, pauses), ('m', 2, [7]))

    async def test_a_long_retry_after_is_cut_and_three_tries_are_the_most(self):
        busy = status(429, **{'Retry-After': '3600'})
        result, requests, pauses = await self.ask(busy, busy, busy)
        self.assertEqual((requests, pauses, result.status), (3, [llm.MAX_PAUSE, llm.MAX_PAUSE], 429))

    async def test_a_retry_after_date_is_read_as_seconds(self):
        when = format_datetime(datetime.now(UTC) + timedelta(seconds=20), usegmt=True)
        _, _, pauses = await self.ask(status(503, **{'Retry-After': when}), answered())
        self.assertTrue(15 < pauses[0] <= 20, pauses)

    async def test_a_failing_model_is_asked_again_after_growing_pauses_with_jitter(self):
        result, requests, pauses = await self.ask(status(503), status(502), status(500))
        self.assertEqual((requests, result.status, str(result)), (3, 500, 'Модель не ответила: HTTP 500'))
        self.assertTrue(llm.PAUSE <= pauses[0] < 2 * llm.PAUSE <= pauses[1] < 3 * llm.PAUSE, pauses)

    async def test_another_4xx_is_never_asked_again_even_by_structured(self):
        result, requests, pauses = await self.ask(status(400), structured=True)
        self.assertEqual((requests, pauses, result.status), (1, [], 400))
        self.assertEqual(str(result), 'Модель не ответила: HTTP 400')

    async def test_a_lost_connection_is_asked_again(self):
        replies = broken(httpx.ConnectError), broken(httpx.RemoteProtocolError), answered()
        result, requests, pauses = await self.ask(*replies)
        self.assertEqual((result.value, requests, len(pauses)), ('{"ready": true}', 3, 2))

    async def test_the_connection_check_answers_after_one_try(self):
        """«Проверить модели» says at once what is wrong: three tries with pauses hold the button half a minute."""
        requests, pauses = [], []

        def handler(request):
            requests.append(request)
            return httpx.Response(503, request=request)

        with (
            patch.object(llm.httpx, 'AsyncClient', side_effect=client_for(handler)),
            patch.object(llm.asyncio, 'sleep', AsyncMock(side_effect=pauses.append)),
        ):
            checked = await llm.check(('http://p/v1', 'm'))
        self.assertEqual(
            (checked, len(requests), pauses), ({'ok': False, 'error': 'Модель не ответила: HTTP 503'}, 1, [])
        )

    async def test_a_read_timeout_is_asked_again_once_only(self):
        result, requests, _ = await self.ask(broken(httpx.ReadTimeout), broken(httpx.ReadTimeout), answered())
        self.assertEqual((requests, str(result)), (2, 'Модель недоступна: ReadTimeout'))

    async def test_structured_does_not_multiply_the_tries_of_chat(self):
        result, requests, _ = await self.ask(status(503), status(503), status(503), structured=True)
        self.assertEqual((requests, str(result)), (3, 'Модель не ответила: HTTP 503'))

    async def test_a_malformed_answer_is_asked_again_once_at_once(self):
        result, requests, pauses = await self.ask(answered({'choices': []}), answered(), structured=True)
        self.assertEqual((result.value, requests, pauses), ({'ready': True}, 2, []))

    async def test_the_connection_has_a_short_timeout_and_the_answer_the_usual_one(self):
        seen = []

        def handler(request):
            seen.append(request.extensions['timeout'])
            return json_response(ANSWER)

        with patch.object(llm.httpx, 'AsyncClient', side_effect=client_for(handler)):
            await llm.chat('system', 'question', endpoint=('http://p/v1', 'm'))
        self.assertEqual((seen[0]['connect'], seen[0]['read']), (llm.CONNECT_TIMEOUT, 240))

    async def test_the_gateway_follows_the_same_policy(self):
        answer = {'messages': [{'role': 'assistant', 'content': [{'text': 'да'}]}]}
        replies = iter([httpx.Response(503), json_response(answer)])
        transport = httpx.MockTransport(lambda _: next(replies))
        with (
            patch.object(
                llm.gateway, '_client', side_effect=lambda *_: (Client(transport=transport), 'http://gateway')
            ),
            patch.object(llm.asyncio, 'sleep', AsyncMock()) as sleep,
        ):
            result = await llm.chat('system', 'question', endpoint=(llm.GATEWAY, 'requested'))
        self.assertEqual((result.value, sleep.await_count), ('да', 1))


class DefaultModelsTests(unittest.TestCase):
    def second(self, value: str = 'llm.second_judge()', **extra: str) -> str:
        """What the value is in a fresh process with only these LAB_*/PI_* settings."""
        import os
        import subprocess
        import sys
        import tempfile

        with tempfile.TemporaryDirectory() as folder:
            env = {k: v for k, v in os.environ.items() if not k.startswith(('LAB_', 'PI_'))}
            env.update(LAB_DATA=folder, LAB_CERTS=folder, AGENT_LAB_GATEWAY_FILE=f'{folder}/none.json', **extra)
            script = f'from lab import llm; print({value})'
            done = subprocess.run([sys.executable, '-c', script], env=env, capture_output=True, text=True, check=True)
            return done.stdout.strip()

    def test_one_model_by_default_and_a_second_vendor_only_when_named(self) -> None:
        self.assertEqual(self.second(), 'None')
        self.assertEqual(
            self.second(LAB_SECOND_MODEL='openai/gpt-5.2'), "('http://127.0.0.1:11437/v1', 'openai/gpt-5.2')"
        )

    def test_the_second_judge_goes_where_the_main_one_goes_unless_named(self) -> None:
        main = {'LAB_MODEL_URL': 'http://models.bank.test/v1', 'LAB_SECOND_MODEL': 'openai/gpt-5.2'}
        self.assertEqual(self.second(**main), "('http://models.bank.test/v1', 'openai/gpt-5.2')")
        self.assertEqual(
            self.second(**main, LAB_SECOND_URL='http://other.test/v1'), "('http://other.test/v1', 'openai/gpt-5.2')"
        )

    def test_the_main_key_goes_to_another_host_never_and_the_second_has_its_own(self) -> None:
        main = {'LAB_MODEL_URL': 'http://a.test/v1', 'LAB_MODEL_KEY': 'sk-main', 'LAB_SECOND_MODEL': 'openai/gpt-5.2'}
        elsewhere = {**main, 'LAB_SECOND_URL': 'http://b.test/v1'}
        self.assertEqual(self.second('llm.SECOND_KEY', **elsewhere), 'None')
        self.assertEqual(self.second('llm.SECOND_KEY', **elsewhere, LAB_SECOND_KEY='sk-second'), 'sk-second')
        self.assertEqual(self.second('llm.SECOND_KEY', **main), 'sk-main')  # the same address
        self.assertEqual(self.second('llm.SECOND_KEY', LAB_SECOND_MODEL='x', PI_PROXY_TOKEN='launch'), 'launch')


class DescribeTests(unittest.TestCase):
    def via(self, main: tuple, second: tuple | None = None) -> tuple:
        with (
            patch.object(llm, 'MAIN', main),
            patch.object(llm, 'SECOND', second or main),
            patch.object(llm.gateway, 'chosen_models', return_value={}),
            patch.object(llm.gateway, 'problem', return_value=None),
        ):
            described = llm.describe()
        return described['via'], described.get('secondVia')

    def test_the_settings_say_where_the_conversations_go(self) -> None:
        self.assertEqual(self.via((llm.GATEWAY, 'glm')), ('шлюз банка', None))
        pi = ('http://127.0.0.1:11436/v1', 'glm'), ('http://127.0.0.1:11437/v1', 'gpt')
        self.assertEqual(self.via(*pi), ('OpenRouter через Pi', None))
        self.assertEqual(self.via(('https://user:secret@llm.bank.test:8443/v1', 'glm')), ('llm.bank.test:8443', None))
        elsewhere = ('https://llm.bank.test/v1', 'glm'), ('https://api.vendor.test/v1', 'gpt')
        self.assertEqual(self.via(*elsewhere), ('llm.bank.test', 'api.vendor.test'))


class KeyTests(unittest.IsolatedAsyncioTestCase):
    async def test_each_endpoint_gets_its_own_key_and_another_host_none(self):
        seen = []

        def handler(request):
            seen.append((request.url.host, request.headers.get('Authorization')))
            return json_response(ANSWER)

        with (
            patch.object(llm, 'MAIN', ('http://a.test/v1', 'main')),
            patch.object(llm, 'SECOND', ('http://b.test/v1', 'second')),
            patch.object(llm, 'API_KEY', 'sk-main'),
            patch.object(llm, 'SECOND_KEY', None, create=True),
            patch.object(llm.httpx, 'AsyncClient', side_effect=client_for(handler)),
        ):
            for endpoint in (llm.MAIN, llm.SECOND, ('http://c.test/v1', 'other')):
                await llm.chat('system', 'question', endpoint=endpoint)
            with patch.object(llm, 'SECOND_KEY', 'sk-second'):
                await llm.chat('system', 'question', endpoint=llm.SECOND)
        self.assertEqual(
            seen, [('a.test', 'Bearer sk-main'), ('b.test', None), ('c.test', None), ('b.test', 'Bearer sk-second')]
        )


class GlmReplyTests(unittest.TestCase):
    def test_text_after_the_json_object_is_ignored(self) -> None:
        reply = '{"rules": [{"ruleId": "r1"}]}\n\nПояснение: правило {pronouns} выполнено.'
        self.assertEqual(llm.parse_json(reply), {'rules': [{'ruleId': 'r1'}]})

    def test_a_null_title_reads_as_no_title(self) -> None:
        from lab.judge_reply import JudgeReply

        row = {'ruleId': 'r1', 'status': 'PASS', 'reason': 'Верно', 'agentQuote': 'Откройте', 'title': None}
        self.assertEqual(JudgeReply.model_validate({'rules': [row]}).rules[0].title, '')

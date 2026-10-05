import asyncio
import json
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from unittest.mock import AsyncMock, patch

import httpx
import support

from lab import config, judge, models, roles, store

Client = httpx.AsyncClient


def client_for(handler):
    return lambda **kwargs: Client(transport=httpx.MockTransport(handler), **kwargs)


def json_response(value):
    return httpx.Response(200, json=value)


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.settings = support.lab(self)

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
                    models.httpx, 'AsyncClient', side_effect=client_for(lambda _, body=body: json_response(body))
                ),
                self.assertRaises(models.ModelError),
            ):
                await models.chat('system', 'question', endpoint=('http://provider/v1', 'requested'))

    async def test_non_json_provider_reply_is_model_error_and_check_returns_failure(self):
        with patch.object(
            models.httpx,
            'AsyncClient',
            side_effect=client_for(lambda _: httpx.Response(200, text='<html>broken</html>')),
        ):
            with self.assertRaises(models.ModelError):
                await models.chat('system', 'question', endpoint=('http://provider/v1', 'requested'))
            self.assertFalse((await models.check(('http://provider/v1', 'requested')))['ok'])

    async def test_a_typo_in_the_model_address_is_a_model_error_and_check_says_so(self):
        endpoint = ('http://127.0.0.1:84 43/v1', 'requested')
        with patch.object(models.httpx, 'AsyncClient', side_effect=client_for(lambda _: json_response({}))):
            with self.assertRaises(models.ModelError) as caught:
                await models.chat('system', 'question', endpoint=endpoint)
            checked = await models.check(endpoint)
        self.assertIn('LAB_MODEL_URL', str(caught.exception))
        self.assertEqual(checked, {'ok': False, 'error': str(caught.exception)})

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
                patch.object(models.gateway, '_client', return_value=(client, 'http://gateway')),
                self.assertRaises(models.ModelError),
            ):
                await models.chat('system', 'question', endpoint=(models.GATEWAY, 'requested'))

    async def test_gateway_auto_and_returned_model_identity_are_explicit(self):
        body = {'messages': [{'role': 'assistant', 'content': [{'text': 'hello '}, {'text': 'world'}]}]}
        client = Client(transport=httpx.MockTransport(lambda _, body=body: json_response(body)))
        with (
            patch.object(models.gateway, '_client', return_value=(client, 'http://gateway')),
            patch.object(models.gateway, 'auto_models', AsyncMock(return_value={'model': 'chosen-main'})),
        ):
            result = await models.chat('system', 'question', endpoint=(models.GATEWAY, 'auto'))
        self.assertEqual((result.text, result.model), ('hello world', 'chosen-main'))
        body['model'] = 'returned-model'
        client = Client(transport=httpx.MockTransport(lambda _, body=body: json_response(body)))
        with patch.object(models.gateway, '_client', return_value=(client, 'http://gateway')):
            result = await models.chat('system', 'question', endpoint=(models.GATEWAY, 'requested'))
        self.assertEqual(result.model, 'returned-model')

    async def test_gateway_bad_catalog_is_a_model_error(self):
        for body in ([], {}, {'data': [None]}, {'data': [{'id': 42}]}):
            client = Client(transport=httpx.MockTransport(lambda _, body=body: json_response(body)))
            with (
                self.subTest(body=body),
                patch.object(models.gateway, '_client', return_value=(client, 'http://gateway')),
                self.assertRaises(models.ModelError),
            ):
                await models.gateway.catalog()

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

        two = {'model_url': 'http://provider/v1', 'model': 'main-alias', 'second_model': 'second-alias'}
        with (
            config.using(support.changed(self.settings, **two)),
            patch.object(models.httpx, 'AsyncClient', side_effect=client_for(handler)),
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
            models.models_used([{'model': 'first'}, {'model': 'second'}, {'model': 'first'}]), 'first, second'
        )
        self.assertEqual(models.models_used([{}]), models.main_model())


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

    def setUp(self):
        support.lab(self)

    async def ask(self, *replies, structured: bool = False):
        """(answer or ModelError, requests the provider got, pauses taken) for these replies in turn."""
        requests, pauses = [], []

        def handler(request):
            requests.append(request)
            return replies[len(requests) - 1](request)

        async def call():
            if structured:
                return await roles.ask(roles.Role('test', 'system', dict), {}, model=('http://p/v1', 'm'))
            return await models.chat('system', 'question', endpoint=('http://p/v1', 'm'))

        with (
            patch.object(models.httpx, 'AsyncClient', side_effect=client_for(handler)),
            patch.object(models.asyncio, 'sleep', AsyncMock(side_effect=pauses.append)),
        ):
            try:
                result = await call()
            except models.ModelError as error:
                result = error
        return result, len(requests), pauses

    async def test_a_busy_model_is_asked_again_after_the_pause_it_asked_for(self):
        result, requests, pauses = await self.ask(status(429, **{'Retry-After': '7'}), answered())
        self.assertEqual((result.model, requests, pauses), ('m', 2, [7]))

    async def test_every_try_goes_to_the_journal_with_how_it_ended(self):
        with models.about('run:r1'):
            await self.ask(status(429, **{'Retry-After': '1'}), answered())
            await self.ask(broken(httpx.ConnectError), status(400))
        lines = store.calls('run:r1')
        self.assertEqual(
            [(line['outcome'], line['status'], line['model'], line['via']) for line in lines],
            [
                ('refused', 429, 'm', 'p'),
                ('answered', None, 'm', 'p'),
                ('failed', None, 'm', 'p'),
                ('refused', 400, 'm', 'p'),
            ],
        )
        self.assertEqual(lines[1]['answeredBy'], 'm')
        self.assertTrue(all(line['ms'] >= 0 and line['at'] for line in lines))
        self.assertEqual(store.calls('elsewhere'), [])

    async def test_a_long_retry_after_is_cut_and_three_tries_are_the_most(self):
        busy = status(429, **{'Retry-After': '3600'})
        result, requests, pauses = await self.ask(busy, busy, busy)
        self.assertEqual((requests, pauses, result.status), (3, [models.MAX_PAUSE, models.MAX_PAUSE], 429))

    async def test_a_retry_after_date_is_read_as_seconds(self):
        when = format_datetime(datetime.now(UTC) + timedelta(seconds=20), usegmt=True)
        _, _, pauses = await self.ask(status(503, **{'Retry-After': when}), answered())
        self.assertTrue(15 < pauses[0] <= 20, pauses)

    async def test_a_failing_model_is_asked_again_after_growing_pauses_with_jitter(self):
        result, requests, pauses = await self.ask(status(503), status(502), status(500))
        self.assertEqual((requests, result.status, str(result)), (3, 500, 'Модель ответила ошибкой (HTTP 500).'))
        self.assertTrue(models.PAUSE <= pauses[0] < 2 * models.PAUSE <= pauses[1] < 3 * models.PAUSE, pauses)

    async def test_another_4xx_is_never_asked_again_even_by_structured(self):
        result, requests, pauses = await self.ask(status(400), structured=True)
        self.assertEqual((requests, pauses, result.status), (1, [], 400))
        self.assertEqual(str(result), 'Модель ответила ошибкой (HTTP 400).')

    async def test_a_lost_connection_is_asked_again(self):
        replies = broken(httpx.ConnectError), broken(httpx.RemoteProtocolError), answered()
        result, requests, pauses = await self.ask(*replies)
        self.assertEqual((result.text, requests, len(pauses)), ('{"ready": true}', 3, 2))

    async def test_the_connection_check_answers_after_one_try(self):
        """«Проверить модели» says at once what is wrong: three tries with pauses hold the button half a minute."""
        requests, pauses = [], []

        def handler(request):
            requests.append(request)
            return httpx.Response(503, request=request)

        with (
            patch.object(models.httpx, 'AsyncClient', side_effect=client_for(handler)),
            patch.object(models.asyncio, 'sleep', AsyncMock(side_effect=pauses.append)),
        ):
            checked = await models.check(('http://p/v1', 'm'))
        self.assertEqual(
            (checked, len(requests), pauses), ({'ok': False, 'error': 'Модель ответила ошибкой (HTTP 503).'}, 1, [])
        )

    async def test_the_connection_check_of_an_unreachable_model_does_not_send_to_settings(self):
        """«Проверить модели» is in «Настройки»: its answer names the failure, not the page the person is on."""

        def handler(request):
            raise httpx.ConnectError('refused', request=request)

        with patch.object(models.httpx, 'AsyncClient', side_effect=client_for(handler)):
            checked = await models.check(('http://p/v1', 'm'))
        self.assertEqual(checked, {'ok': False, 'error': 'Модель недоступна (ConnectError).'})

    async def test_a_read_timeout_is_asked_again_once_only(self):
        result, requests, _ = await self.ask(broken(httpx.ReadTimeout), broken(httpx.ReadTimeout), answered())
        self.assertEqual(
            (requests, str(result)), (2, 'Модель недоступна (ReadTimeout). Проверьте её в разделе «Настройки».')
        )

    async def test_structured_does_not_multiply_the_tries_of_chat(self):
        result, requests, _ = await self.ask(status(503), status(503), status(503), structured=True)
        self.assertEqual((requests, str(result)), (3, 'Модель ответила ошибкой (HTTP 503).'))

    async def test_a_malformed_answer_is_asked_again_once_at_once(self):
        result, requests, pauses = await self.ask(answered({'choices': []}), answered(), structured=True)
        self.assertEqual((result.value, requests, pauses), ({'ready': True}, 2, []))

    async def test_the_connection_has_a_short_timeout_and_the_answer_the_usual_one(self):
        seen = []

        def handler(request):
            seen.append(request.extensions['timeout'])
            return json_response(ANSWER)

        with patch.object(models.httpx, 'AsyncClient', side_effect=client_for(handler)):
            await models.chat('system', 'question', endpoint=('http://p/v1', 'm'))
        self.assertEqual((seen[0]['connect'], seen[0]['read']), (models.CONNECT_TIMEOUT, 240))

    async def test_the_gateway_follows_the_same_policy(self):
        answer = {'messages': [{'role': 'assistant', 'content': [{'text': 'да'}]}]}
        replies = iter([httpx.Response(503), json_response(answer)])
        transport = httpx.MockTransport(lambda _: next(replies))
        with (
            patch.object(
                models.gateway, '_client', side_effect=lambda *_: (Client(transport=transport), 'http://gateway')
            ),
            patch.object(models.asyncio, 'sleep', AsyncMock()) as sleep,
        ):
            result = await models.chat('system', 'question', endpoint=(models.GATEWAY, 'requested'))
        self.assertEqual((result.text, sleep.await_count), ('да', 1))


class DefaultModelsTests(unittest.TestCase):
    def started(self, value=lambda: models.second_judge(), **environment: str):
        """What the value is in a Lab started with only these LAB_* and OpenRouter settings."""
        with tempfile.TemporaryDirectory() as folder:
            places = {'LAB_DATA': folder, 'LAB_CERTS': folder, 'AGENT_LAB_GATEWAY_FILE': f'{folder}/none.json'}
            with config.using(config.Settings.from_environment({**places, **environment})):
                return value()

    def test_one_model_by_default_and_a_second_vendor_only_when_named(self) -> None:
        self.assertIsNone(self.started())
        self.assertEqual(
            self.started(LAB_SECOND_MODEL='openai/gpt-5.2'), ('https://openrouter.ai/api/v1', 'openai/gpt-5.2')
        )

    def test_the_second_judge_goes_where_the_main_one_goes_unless_named(self) -> None:
        main = {'LAB_MODEL_URL': 'http://models.bank.test/v1', 'LAB_SECOND_MODEL': 'openai/gpt-5.2'}
        self.assertEqual(self.started(**main), ('http://models.bank.test/v1', 'openai/gpt-5.2'))
        self.assertEqual(
            self.started(**main, LAB_SECOND_URL='http://other.test/v1'), ('http://other.test/v1', 'openai/gpt-5.2')
        )

    def test_the_main_key_goes_to_another_host_never_and_the_second_has_its_own(self) -> None:
        second_key = lambda: models.endpoints().second_key  # noqa: E731
        main = {'LAB_MODEL_URL': 'http://a.test/v1', 'LAB_MODEL_KEY': 'sk-main', 'LAB_SECOND_MODEL': 'openai/gpt-5.2'}
        elsewhere = {**main, 'LAB_SECOND_URL': 'http://b.test/v1'}
        self.assertIsNone(self.started(second_key, **elsewhere))
        self.assertEqual(self.started(second_key, **elsewhere, LAB_SECOND_KEY='sk-second'), 'sk-second')
        self.assertEqual(self.started(second_key, **main), 'sk-main')  # the same address

    def test_openrouter_is_the_endpoint_without_another_and_its_key_goes_only_there(self) -> None:
        main_key, second_key = lambda: models.endpoints().main_key, lambda: models.endpoints().second_key
        self.assertEqual(self.started(lambda: models.endpoints().main[0]), 'https://openrouter.ai/api/v1')
        self.assertEqual(self.started(main_key, OPENROUTER_API_KEY='sk-or'), 'sk-or')
        self.assertEqual(self.started(second_key, LAB_SECOND_MODEL='x', OPENROUTER_API_KEY='sk-or'), 'sk-or')
        own = {'LAB_MODEL_URL': 'http://models.bank.test/v1', 'OPENROUTER_API_KEY': 'sk-or'}
        self.assertIsNone(self.started(main_key, **own))  # OpenRouter's key never goes to another host
        self.assertEqual(self.started(lambda: models.describe()['problem']), models.NO_KEY)
        self.assertIsNone(self.started(lambda: models.describe()['problem'], OPENROUTER_API_KEY='sk-or'))

    def test_a_variable_set_to_nothing_is_not_set(self) -> None:
        self.assertEqual(
            self.started(lambda: models.endpoints().main, LAB_MODEL_URL='', LAB_MODEL=' '),
            (models.OPENROUTER, models.DEFAULT_MODEL),
        )


class DescribeTests(unittest.TestCase):
    def via(self, main: tuple, second: tuple | None = None) -> tuple:
        with (
            patch.object(models, 'endpoints', return_value=models.Endpoints(main, second or main, None, None)),
            patch.object(models.gateway, 'chosen_models', return_value={}),
            patch.object(models.gateway, 'problem', return_value=None),
        ):
            described = models.describe()
        return described['via'], described.get('secondVia')

    def test_the_settings_say_where_the_conversations_go(self) -> None:
        self.assertEqual(self.via((models.GATEWAY, 'glm')), ('шлюз банка', None))
        openrouter = (models.OPENROUTER, 'z-ai/glm-5.3'), (models.OPENROUTER, 'openai/gpt-5.2')
        self.assertEqual(self.via(*openrouter), ('OpenRouter', None))
        self.assertEqual(
            self.via(('https://user:secret@models.bank.test:8443/v1', 'glm')), ('models.bank.test:8443', None)
        )
        elsewhere = ('https://models.bank.test/v1', 'glm'), ('https://api.vendor.test/v1', 'gpt')
        self.assertEqual(self.via(*elsewhere), ('models.bank.test', 'api.vendor.test'))


class KeyTests(unittest.IsolatedAsyncioTestCase):
    async def test_each_endpoint_gets_its_own_key_and_another_host_none(self):
        seen = []

        def handler(request):
            seen.append((request.url.host, request.headers.get('Authorization')))
            return json_response(ANSWER)

        settings = support.lab(
            self,
            model_url='http://a.test/v1',
            model='main',
            model_key='sk-main',
            second_url='http://b.test/v1',
            second_model='second',
        )
        with patch.object(models.httpx, 'AsyncClient', side_effect=client_for(handler)):
            found = models.endpoints()
            for endpoint in (found.main, found.second, ('http://c.test/v1', 'other')):
                await models.chat('system', 'question', endpoint=endpoint)
            with config.using(support.changed(settings, second_key='sk-second')):
                await models.chat('system', 'question', endpoint=found.second)
        self.assertEqual(
            seen, [('a.test', 'Bearer sk-main'), ('b.test', None), ('c.test', None), ('b.test', 'Bearer sk-second')]
        )


class OpenRouterTests(unittest.IsolatedAsyncioTestCase):
    async def test_openrouter_is_asked_with_its_key_and_a_short_reasoning(self):
        seen = []

        def handler(request):
            seen.append((str(request.url), request.headers.get('Authorization'), json.loads(request.content)))
            return json_response(ANSWER)

        support.lab(self, model_url=None, openrouter_key='sk-or')
        with patch.object(models.httpx, 'AsyncClient', side_effect=client_for(handler)):
            await models.chat('system', 'question')
        url, key, body = seen[0]
        self.assertEqual((url, key), ('https://openrouter.ai/api/v1/chat/completions', 'Bearer sk-or'))
        self.assertEqual((body['model'], body['reasoning']), ('z-ai/glm-5.3', {'effort': 'low'}))

    async def test_without_its_key_no_conversation_is_sent_and_the_check_says_what_to_set(self):
        endpoint = (models.OPENROUTER, 'z-ai/glm-5.3')
        support.lab(self, model_url=None)
        sent = AsyncMock(side_effect=AssertionError('a conversation was sent without a key'))
        with patch.object(models.httpx.AsyncClient, 'post', sent):
            with self.assertRaises(models.ModelError) as refused:
                await models.chat('system', 'question')
            checked = await models.check(endpoint)
        self.assertEqual(str(refused.exception), models.NO_KEY)
        self.assertEqual(checked, {'ok': False, 'error': models.NO_KEY})

    async def test_another_endpoint_gets_no_reasoning_setting_it_may_not_know(self):
        seen = []

        def handler(request):
            seen.append(json.loads(request.content))
            return json_response(ANSWER)

        support.lab(self)
        with patch.object(models.httpx, 'AsyncClient', side_effect=client_for(handler)):
            await models.chat('system', 'question', endpoint=('http://models.bank.test/v1', 'glm'))
        self.assertNotIn('reasoning', seen[0])


class GlmReplyTests(unittest.TestCase):
    def test_text_after_the_json_object_is_ignored(self) -> None:
        reply = '{"rules": [{"ruleId": "r1"}]}\n\nПояснение: правило {pronouns} выполнено.'
        self.assertEqual(roles.base.parse_json(reply), {'rules': [{'ruleId': 'r1'}]})

    def test_a_null_title_reads_as_no_title(self) -> None:
        from lab.roles.judge import JudgeReply

        row = {'ruleId': 'r1', 'status': 'PASS', 'reason': 'Верно', 'agentQuote': 'Откройте', 'title': None}
        self.assertEqual(JudgeReply.model_validate({'rules': [row]}).rules[0].title, '')

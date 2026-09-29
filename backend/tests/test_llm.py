import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from lab import judge, llm

Client = httpx.AsyncClient


def client_for(handler):
    return lambda **kwargs: Client(transport=httpx.MockTransport(handler), **kwargs)


def json_response(value):
    return httpx.Response(200, json=value)


class ProviderTests(unittest.IsolatedAsyncioTestCase):
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

    async def test_structured_retries_bad_envelope_and_carries_successful_model(self):
        calls = []

        def handler(request):
            calls.append(request)
            if len(calls) == 1:
                return json_response({'choices': []})
            return json_response({'choices': [{'message': {'content': '{"ready":true}'}}], 'model': 'actual-model'})

        with patch.object(llm.httpx, 'AsyncClient', side_effect=client_for(handler)):
            result = await llm.structured('system', {}, endpoint=('http://provider/v1', 'requested-alias'))
        self.assertEqual(len(calls), 2)
        self.assertEqual(result, llm.Answer({'ready': True}, 'actual-model'))

    async def test_unfinished_code_fence_is_retried(self):
        replies = [llm.Answer('```json', 'bad'), llm.Answer('{"ready":true}', 'good')]
        with patch.object(llm, 'chat', AsyncMock(side_effect=replies)) as chat:
            result = await llm.structured('system', {})
        self.assertEqual(chat.await_count, 2)
        self.assertEqual(result.model, 'good')

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

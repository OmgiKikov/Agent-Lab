import unittest
from unittest.mock import patch

import httpx

from lab.agents import http


class PhrasesTests(unittest.TestCase):
    def test_history_and_new_message_become_phrases_in_order(self) -> None:
        history = [{'role': 'customer', 'text': 'вернуть платёж'}, {'role': 'agent', 'text': 'Как принимали оплату?'}]
        _, body = http.local_request('c-1', 'через приложение', history)
        content = body['message']['content']
        self.assertEqual(
            [(p['speaker_type'], p['text']) for p in content['phrases']],
            [('CUSTOMER', 'вернуть платёж'), ('ROBOT', 'Как принимали оплату?'), ('CUSTOMER', 'через приложение')],
        )
        self.assertEqual(content['trigger_phrase_id'], content['phrases'][-1]['phrase_id'])
        self.assertEqual(content['user_input'], 'через приложение')

    def test_replay_speaks_as_the_bank_chat(self) -> None:
        _, body = http.local_request('c-1', 'вопрос', [])
        self.assertEqual(body['message']['sender'], http.REPLAY_SENDER)

    def test_phrases_are_one_second_apart(self) -> None:
        _, body = http.local_request('c-1', 'b', [{'role': 'customer', 'text': 'a'}])
        times = [p['time'] for p in body['message']['content']['phrases']]
        self.assertEqual(times, ['2026-01-01T00:00:01+00:00', '2026-01-01T00:00:02+00:00'])

    def test_simulation_request_is_unchanged(self) -> None:
        _, body = http.local_request('c-1', 'вопрос')
        self.assertNotIn('phrases', body['message']['content'])
        self.assertEqual(body['message']['sender'], 'user')


class TraceTests(unittest.IsolatedAsyncioTestCase):
    async def fetch(self, status: int, payload: dict) -> dict | None:
        seen = []

        def answer(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            return httpx.Response(status, json=payload)

        async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as client:
            found = await http.agent_trace(client, 'http://127.0.0.1:8081/api/v1/ai/agents/x', 't-1')
        self.assertEqual(seen, ['http://127.0.0.1:8081/local/agent-lab/trace/t-1'])
        return found

    async def test_reads_the_trace_of_the_turn(self) -> None:
        trace = {'traceId': 't-1', 'chains': [], 'rag': [], 'systems': []}
        self.assertEqual(await self.fetch(200, trace), trace)

    async def test_agent_without_traces_gives_none(self) -> None:
        self.assertIsNone(await self.fetch(404, {'detail': 'Not Found'}))


class SayTraceTests(unittest.IsolatedAsyncioTestCase):
    async def requested(self, history: list[dict] | None) -> list[str]:
        """The paths a local agent's turn reached, the agent and the stand's mocks answering."""
        seen = []
        client = httpx.AsyncClient

        def answer(request: httpx.Request) -> httpx.Response:
            seen.append(request.url.path)
            if request.method == 'POST' and request.url.path == http.AGENT_PATH:
                return httpx.Response(200, json={'message': {'content': {'status_code': '200', 'result': 'Ответ'}}})
            return httpx.Response(200, json={})

        agent = http.HttpAgent({'url': f'http://127.0.0.1:8080{http.AGENT_PATH}', 'profile': 'local'})
        with patch.object(
            http.httpx,
            'AsyncClient',
            side_effect=lambda **kwargs: client(transport=httpx.MockTransport(answer), **kwargs),
        ):
            await agent.say('c-1', 'вопрос', history=history)
        return seen

    async def test_a_simulated_turn_does_not_ask_for_the_trace(self) -> None:
        self.assertFalse([path for path in await self.requested(None) if path.startswith(http.TRACE_PATH)])

    async def test_a_replayed_turn_asks_for_its_trace(self) -> None:
        self.assertTrue([path for path in await self.requested([]) if path.startswith(http.TRACE_PATH)])

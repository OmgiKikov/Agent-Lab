import json
import os
import unittest
from unittest.mock import patch

import httpx

from lab import agents
from lab.agents import AgentError
from lab.agents.http import BAD_ADDRESS
from lab.agents.replay_service import NO_ADDRESS, ReplayServiceAgent

WARMING = 'Кэш базы знаний ещё прогревается.'
NOT_AN_OBJECT = 'Тело запроса не JSON-объект.'
TRACE = {'traceId': 't', 'chains': [], 'rag': [{'source': 'idp', 'query': 'как вернуть терминал'}], 'systems': []}


def agent_reply(status: int = 200, code: str = '200', text: str = 'Верните терминал в отделение.') -> dict:
    return {'status': status, 'body': {'message': {'content': {'status_code': code, 'result': text}}}}


class FakeService:
    """The replay service in memory: ready or warming up, answering every turn with the agent's reply and a trace."""

    def __init__(
        self, ready: bool = True, turn_status: int = 200, reply: dict | None = None, turn_problem: str = WARMING
    ) -> None:
        self.ready, self.turn_status, self.reply, self.turn_problem = (
            ready,
            turn_status,
            reply or agent_reply(),
            turn_problem,
        )
        self.bodies = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == '/health':
            return httpx.Response(
                200 if self.ready else 503,
                json={
                    'ready': self.ready,
                    'problems': [] if self.ready else [WARMING],
                    'prompts': {'version': '0.0.1', 'hashes': {}},
                    'idpCache': {'total': 2, 'warmed': 2, 'failed': []},
                    'isolation': ['sbe:stub'],
                },
            )
        self.bodies.append(json.loads(request.content))
        if self.turn_status != 200:
            return httpx.Response(self.turn_status, json={'problems': [self.turn_problem]})
        return httpx.Response(200, json={'agent': self.reply, 'seconds': 1.5, 'trace': TRACE})


def replay_agent(service: FakeService) -> ReplayServiceAgent:
    return ReplayServiceAgent({'url': 'http://replay.stand:8080'}, transport=httpx.MockTransport(service))


class OpenTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_service_not_ready_names_its_problems(self) -> None:
        with self.assertRaisesRegex(AgentError, 'прогревается'):
            await replay_agent(FakeService(ready=False)).open()

    async def test_without_an_address_the_variable_is_asked_for(self) -> None:
        with self.assertRaises(AgentError) as raised:
            await ReplayServiceAgent({'url': ''}).open()
        self.assertEqual(str(raised.exception), NO_ADDRESS)

    async def test_an_address_written_with_an_error_is_named(self) -> None:
        with self.assertRaises(AgentError) as raised:
            await ReplayServiceAgent({'url': 'http://replay.stand:99999'}).open()
        self.assertEqual(str(raised.exception), BAD_ADDRESS)

    async def test_the_agents_version_is_its_prompts_version(self) -> None:
        agent = replay_agent(FakeService())
        await agent.open()
        self.assertEqual(agent.version, '0.0.1')

    async def test_the_stand_keeps_the_cache_warm_up(self) -> None:
        agent = replay_agent(FakeService())
        await agent.open()
        self.assertEqual(agent.stand['idpCache'], {'total': 2, 'warmed': 2, 'failed': []})


class SayTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_turn_gives_the_reply(self) -> None:
        reply = await replay_agent(FakeService()).say('c-1', 'как вернуть терминал', history=[])
        self.assertEqual((reply['text'], reply['status']), ('Верните терминал в отделение.', '200'))

    async def test_a_turn_gives_its_trace(self) -> None:
        reply = await replay_agent(FakeService()).say('c-1', 'как вернуть терминал', history=[])
        self.assertEqual(reply['trace'], TRACE)

    async def test_history_goes_as_the_bank_chats_phrases(self) -> None:
        service = FakeService()
        history = [{'role': 'customer', 'text': 'Здравствуйте'}, {'role': 'agent', 'text': 'Чем помочь?'}]
        await replay_agent(service).say('c-1', 'как вернуть терминал', history=history)
        message = service.bodies[0]['message']
        self.assertEqual((message['sender'], len(message['content']['phrases'])), ('GIGAASSISTANT', 3))

    async def test_an_agents_failure_is_its_reply_to_judge(self) -> None:
        service = FakeService(reply=agent_reply(500, '500-2', 'Внутренняя ошибка агента'))
        reply = await replay_agent(service).say('c-1', 'как вернуть терминал', history=[])
        self.assertEqual(reply['status'], '500-2')

    async def test_an_unhandled_agent_error_is_named_by_its_http_status(self) -> None:
        service = FakeService(reply={'status': 500, 'body': 'Internal Server Error'})
        with self.assertRaisesRegex(AgentError, r'Агент ответил ошибкой \(HTTP 500\)'):
            await replay_agent(service).say('c-1', 'как вернуть терминал', history=[])

    async def test_an_unreadable_reply_with_status_200_is_an_unknown_format(self) -> None:
        service = FakeService(reply={'status': 200, 'body': 'ok'})
        with self.assertRaisesRegex(AgentError, 'неизвестном формате'):
            await replay_agent(service).say('c-1', 'как вернуть терминал', history=[])

    async def test_a_request_the_service_refused_keeps_its_problems(self) -> None:
        service = FakeService(turn_status=400, turn_problem=NOT_AN_OBJECT)
        with self.assertRaisesRegex(AgentError, NOT_AN_OBJECT):
            await replay_agent(service).say('c-1', 'как вернуть терминал', history=[])

    async def test_a_service_gone_unready_is_an_agent_error(self) -> None:
        with self.assertRaisesRegex(AgentError, 'прогревается'):
            await replay_agent(FakeService(turn_status=503)).say('c-1', 'как вернуть терминал', history=[])

    async def test_a_scenarios_test_data_is_refused(self) -> None:
        with self.assertRaises(AgentError):
            await replay_agent(FakeService()).say('c-1', 'тариф', world={'getLkkTariff': {}}, history=[])


class ReplayTargetsTests(unittest.TestCase):
    def test_the_service_is_offered_for_replays_when_its_address_is_set(self) -> None:
        with patch.dict(os.environ, {'LAB_REPLAY_URL': 'http://replay.stand:8080'}):
            self.assertIn(agents.REPLAY_SERVICE, [t['id'] for t in agents.replay_targets()])

    def test_the_service_is_not_offered_without_an_address(self) -> None:
        with patch.dict(os.environ, {'LAB_REPLAY_URL': ''}):
            self.assertNotIn(agents.REPLAY_SERVICE, [t['id'] for t in agents.replay_targets()])

    def test_the_service_is_not_a_way_to_talk_to_the_agent(self) -> None:
        self.assertNotIn(agents.REPLAY_SERVICE, agents.configs())

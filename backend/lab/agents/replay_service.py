"""The replay service on the stand (aigw-local replay/, spec 2026-10-06-acquiring-replay-service-design.md): the
acquiring agent that writes nothing outside itself, one call per turn answering with the reply and its trace."""

import httpx

from ..settings import AGENT_TIMEOUT
from .http import BAD_ADDRESS, AgentError, address_valid, local_request, read_reply

NO_ADDRESS = 'Не задан адрес сервиса повтора. Укажите его в LAB_REPLAY_URL.'
NOT_READY = 'Сервис повтора не готов. {}'
NOT_ACCEPTED = 'Сервис повтора не принял запрос. {}'
NO_WORLD = 'Сервис повтора не принимает тестовые данные сценария: системы банка в нём отвечают одними данными.'
NOT_JSON = 'Сервис повтора ответил не в JSON.'
UNKNOWN_SHAPE = 'Сервис повтора ответил в неизвестном формате.'
AGENT_FAILED = 'Агент ответил ошибкой (HTTP {}).'


class ReplayServiceAgent:
    """Replays only: a turn comes with its trace (traced), the bank systems behind it are fixed, not a scenario's."""

    traced = True
    mocked = False

    def __init__(self, config: dict, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.url = (config.get('url') or '').rstrip('/')
        self.version = 'не сообщается'
        self.stand: dict | None = None
        self._transport = transport  # a test's service in memory; None — the network

    async def open(self) -> None:
        if not self.url:
            raise AgentError(NO_ADDRESS)
        if not address_valid(self.url):
            raise AgentError(BAD_ADDRESS)
        health = await self._call('GET', '/health', timeout=httpx.Timeout(10))
        if not health.get('ready'):
            raise AgentError(NOT_READY.format(_problems(health)))
        self.version = str((health.get('prompts') or {}).get('version') or self.version)
        self.stand = {key: health.get(key) for key in ('prompts', 'idpCache', 'isolation')}

    async def close(self) -> None:
        pass

    async def say(
        self, conversation_id: str, text: str, world: dict | None = None, history: list[dict] | None = None
    ) -> dict:
        """One turn: the reply as the agent gave it (an error status is its reply too), seconds taken, the trace."""
        if world:
            raise AgentError(NO_WORLD)
        _, body = local_request(conversation_id, text, history)
        answer = await self._call('POST', '/replay/turn', body=body, timeout=httpx.Timeout(AGENT_TIMEOUT, connect=10))
        agent = answer.get('agent') or {}
        status = int(agent.get('status') or 0)
        if status != 200 and not _is_reply(agent.get('body')):
            raise AgentError(AGENT_FAILED.format(status))
        reply = read_reply(agent.get('body'), status)
        return {**reply, 'seconds': answer.get('seconds'), 'events': [], 'trace': answer.get('trace')}

    async def _call(self, method: str, path: str, *, timeout: httpx.Timeout, body: dict | None = None) -> dict:
        try:
            async with httpx.AsyncClient(base_url=self.url, timeout=timeout, transport=self._transport) as client:
                response = await client.request(method, path, json=body)
        except httpx.HTTPError as error:
            raise AgentError(f'Нет связи с сервисом повтора ({type(error).__name__}).') from error
        value = _object(response)
        if response.status_code == 503:
            raise AgentError(NOT_READY.format(_problems(value)))
        if response.status_code == 400:
            raise AgentError(NOT_ACCEPTED.format(_problems(value)))
        if response.status_code != 200:
            raise AgentError(f'Сервис повтора ответил ошибкой (HTTP {response.status_code}).')
        return value


def _is_reply(body: object) -> bool:
    message = body.get('message') if isinstance(body, dict) else None
    return isinstance(message, dict) and isinstance(message.get('content'), dict)


def _problems(value: dict) -> str:
    return ' '.join(value.get('problems') or [])


def _object(response: httpx.Response) -> dict:
    try:
        value = response.json()
    except ValueError as error:
        raise AgentError(NOT_JSON) from error
    if not isinstance(value, dict):
        raise AgentError(UNKNOWN_SHAPE)
    return value

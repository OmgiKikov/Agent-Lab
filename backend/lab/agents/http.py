"""An agent reached over HTTP: the aigw-rest-service contract in its two dialects (the IFT stand and the local one)."""

import os
import re
import time
import uuid
from datetime import UTC, datetime
from urllib.parse import urlsplit

import httpx

from ..settings import AGENT_TIMEOUT, MOCK_URL

AGENT_PATH = '/api/v1/ai/agents/agent-ckr-pa-acquiring'
BAD_ADDRESS = 'Проверьте адрес агента: нужен вид https://хост:порт/путь, без пробелов, с портом от 1 до 65535.'


class AgentError(RuntimeError):
    """The agent is unreachable or its answer cannot be read."""


def address_valid(url: str) -> bool:
    """An address the agent can be reached at: http or https, a host, a port that is a number from 1 to 65535, no
    spaces. httpx refuses some typos (InvalidURL) and takes others («:99999», a space in the host) only to fail while
    connecting, outside its own errors: both are checked here, before a request."""
    try:
        parts = urlsplit(url)
        port = parts.port
        httpx.URL(url)
    except (ValueError, httpx.InvalidURL):
        return False
    return parts.scheme in ('http', 'https') and bool(parts.hostname) and port != 0 and not re.search(r'\s', url)


def prod_request(conversation_id: str, text: str, epk_ids: list[str]) -> tuple[dict, dict]:
    """Headers and body the IFT stand expects. With EPK ids the customer is authorized as one of these
    organizations, the same in every turn of a conversation, so the agent can look up the client's own data."""
    epk = epk_ids[sum(conversation_id.encode()) % len(epk_ids)] if epk_ids else 'org-12345'
    headers = {
        'Content-Type': 'application/json',
        'Request-Id': str(uuid.uuid4()),
        'System-Id': os.environ.get('LAB_PROD_SYSTEM_ID', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
        'Request-Time': datetime.now(UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
    }
    body = {
        'message': {
            'version': '1.0',
            'performative': 'request',
            'sender': 'client',
            'receiver': 'agent',
            'conversation_id': conversation_id,
            'reply_with': 'text',
            'content': {'user_input': text},
        },
        'metadata': {
            'surface_mode': 'NORMAL',
            'communication_channel': 'TEXT',
            'surface': {'code': 'WEB', 'type': 'desktop'},
            'organization': {'epk_id': epk},
            'dialog': {'dialog_id': conversation_id},
            'customer_info': {'authorized': bool(epk_ids), 'device_info': {'browser': 'Chrome/120.0'}},
        },
    }
    return headers, body


def local_request(conversation_id: str, text: str) -> tuple[dict, dict]:
    """Headers and body the local stand expects; x-trace-id keys the scenario's mock data."""
    headers = {
        'Content-Type': 'application/json',
        'x-trace-id': str(uuid.uuid4()),
        'x-client-id': 'CI00163870',
        'x-request-time': datetime.now(UTC).isoformat(timespec='seconds'),
        'x-session-id': str(uuid.uuid4()),
    }
    body = {
        'message': {
            'version': '1.4',
            'performative': 'request',
            'sender': 'user',
            'receiver': 'agent',
            'conversation_id': conversation_id,
            'reply_with': str(uuid.uuid4()),
            'content': {'user_input': text},
        },
        'metadata': {
            'surface_mode': 'CHAT',
            'communication_channel': 'TEXT',
            'organization': {'epk_id': '1000000001'},
            'customer_info': {'authorized': True, 'digital_user_id': conversation_id[:8]},
            'dialog': {'dialog_id': conversation_id},
        },
    }
    return headers, body


def read_reply(data: object, http_status: int) -> dict:
    """What the Lab takes from the agent's answer.
    Status 200 is the agent's own reply; 202-x hands the conversation off to an operator."""
    if not isinstance(data, dict):
        raise AgentError('Ответ агента должен быть JSON-объектом')
    message = data.get('message')
    if not isinstance(message, dict) or not isinstance(message.get('content'), dict):
        raise AgentError('В ответе агента нет объекта message.content')
    content = message['content']
    status = str(content.get('status_code') or http_status)
    text = content.get('result') or content.get('reason') or ''
    if not isinstance(text, str):
        raise AgentError('Текст ответа агента должен быть строкой')
    text = text.strip()
    # Clarifying questions come with buttons; the chat sends the button's text back as the next message.
    suggestions = data.get('suggestions') or []
    if not isinstance(suggestions, list):
        raise AgentError('Подсказки агента должны быть списком')
    options = [o['text'] for o in suggestions if isinstance(o, dict) and isinstance(o.get('text'), str) and o['text']]
    return {'text': text, 'status': status, 'ok': status.startswith('200') and bool(text), 'options': options}


class HttpAgent:
    def __init__(self, config: dict) -> None:
        self.url = config.get('url') or ''
        self.profile = config.get('profile', 'prod')
        self.epk = config.get('epk') or []
        self.version = 'не сообщается'

    @property
    def mocked(self) -> bool:
        """The bank's systems behind this agent are the stand's mocks, so a scenario's test data can be applied."""
        return self.profile == 'local'

    def request(self, conversation_id: str, text: str) -> tuple[dict, dict]:
        if self.profile == 'prod':
            return prod_request(conversation_id, text, self.epk)
        return local_request(conversation_id, text)

    async def open(self) -> None:
        if not self.url:
            raise AgentError('Не задан адрес агента на ИФТ: шаг «агент» → адрес ручки.')
        if self.mocked:
            self.version = await _stand_version(self.url) or self.version

    async def close(self) -> None:
        pass

    async def say(self, conversation_id: str, text: str, world: dict | None = None) -> dict:
        """One turn: the reply, its status and buttons, seconds taken, and the systems it called (local stand)."""
        if not address_valid(self.url):
            raise AgentError(BAD_ADDRESS)  # saved before addresses were checked: the agent cannot be reached
        headers, body = self.request(conversation_id, text)
        # A long answer is normal; an unreachable address should fail fast.
        async with httpx.AsyncClient(timeout=httpx.Timeout(AGENT_TIMEOUT, connect=10)) as client:
            if world and self.mocked:
                await _apply_world(client, headers['x-trace-id'], world)
            cursor = await _mock_cursor(client) if self.mocked else None
            started = time.monotonic()
            try:
                response = await client.post(self.url, json=body, headers=headers)
            except httpx.HTTPError as error:
                raise AgentError(f'Агент недоступен: {type(error).__name__}') from error
            seconds = round(time.monotonic() - started, 2)
            events = await _mock_events(client, cursor, headers.get('x-trace-id'))
        if response.status_code >= 500 or response.status_code in (401, 403, 404):
            raise AgentError(f'Агент ответил HTTP {response.status_code}')
        try:
            data = response.json()
        except ValueError as error:
            raise AgentError('Агент вернул не JSON') from error
        return {**read_reply(data, response.status_code), 'seconds': seconds, 'events': events}


async def _stand_version(url: str) -> str | None:
    if not address_valid(url):
        return None
    origin = '{0.scheme}://{0.netloc}'.format(urlsplit(url))
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            identity = (await client.get(origin + '/local/agent-lab/identity')).json()
    except (httpx.HTTPError, ValueError):
        return None
    if not isinstance(identity, dict):
        return None
    return str(identity.get('version') or '') or None


async def _apply_world(client: httpx.AsyncClient, trace_id: str, world: dict) -> None:
    """The scenario's answers of the bank's systems, for this request only."""
    try:
        response = await client.post(
            f'{MOCK_URL}/mock/overrides', json={'trace_id': trace_id, 'sbe': {'tools': world}}, timeout=5
        )
        response.raise_for_status()
    except (httpx.HTTPError, httpx.InvalidURL) as error:
        raise AgentError(f'Заглушки систем не приняли данные сценария: {type(error).__name__}') from error


async def _mock_cursor(client: httpx.AsyncClient) -> int | None:
    try:
        data = (await client.get(f'{MOCK_URL}/mock/calls', params={'limit': 0}, timeout=3)).json()
        return data.get('cursor') if isinstance(data, dict) else None
    except (httpx.HTTPError, httpx.InvalidURL, ValueError):
        return None


async def _mock_events(client: httpx.AsyncClient, cursor: int | None, trace_id: str | None) -> list[dict]:
    """Knowledge-base and business-system calls the turn made, as the stand's mocks recorded them."""
    if cursor is None:
        return []
    try:
        params = {'after': cursor, 'limit': 500}
        data = (await client.get(f'{MOCK_URL}/mock/calls', params=params, timeout=3)).json()
    except (httpx.HTTPError, httpx.InvalidURL, ValueError):
        return []
    events = []
    for call in data.get('calls') or [] if isinstance(data, dict) else []:
        if not isinstance(call, dict):
            continue
        if call.get('trace_id') != trace_id:
            continue
        if call.get('kind') == 'idp':
            events.append({'tool': 'База знаний', 'query': call.get('query'), 'article': call.get('article')})
        elif call.get('kind') == 'sbe':
            events.append({'tool': f'Система банка · {call.get("tool")}', 'arguments': call.get('arguments')})
    return events

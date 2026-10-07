"""An agent reached over HTTP: the aigw-rest-service contract in its two dialects (the IFT stand and the local one)."""

import re
import time
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

import httpx

from .. import config

AGENT_PATH = '/api/v1/ai/agents/agent-ckr-pa-acquiring'
# Who speaks when a recorded conversation is replayed: the bank chat (Voice360 «agentCode» AGENT_GIGACHAT). With it
# the agent reads every customer phrase and drops its own, as in production
# (aigw-local, form_dialog_parts_from_phrases).
REPLAY_SENDER = 'GIGAASSISTANT'
PHRASES_FROM = datetime(2026, 1, 1, tzinfo=UTC)
TRACE_PATH = '/local/agent-lab/trace/'
BAD_ADDRESS = 'Адрес агента записан с ошибкой. Нужен вид https://хост:порт/путь без пробелов, с портом от 1 до 65535.'


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
        'System-Id': config.current().prod_system_id,
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


def local_request(conversation_id: str, text: str, history: list[dict] | None = None) -> tuple[dict, dict]:
    """Headers and body the local stand expects; x-trace-id keys the scenario's mock data and the turn's trace.
    With history (a replayed conversation) the earlier phrases go along, spoken as the bank chat."""
    headers = {
        'Content-Type': 'application/json',
        'x-trace-id': str(uuid.uuid4()),
        'x-client-id': 'CI00163870',
        'x-request-time': datetime.now(UTC).isoformat(timespec='seconds'),
        'x-session-id': str(uuid.uuid4()),
    }
    content: dict = {'user_input': text}
    if history is not None:
        said = phrases([*history, {'role': 'customer', 'text': text}])
        content.update(phrases=said, trigger_phrase_id=said[-1]['phrase_id'])
    body = {
        'message': {
            'version': '1.4',
            'performative': 'request',
            'sender': 'user' if history is None else REPLAY_SENDER,
            'receiver': 'agent',
            'conversation_id': conversation_id,
            'reply_with': str(uuid.uuid4()),
            'content': content,
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


def phrases(messages: list[dict]) -> list[dict]:
    """The conversation as the agent's phrases, one second apart: it orders them by time."""
    return [
        {
            'phrase_id': str(number),
            'speaker_type': 'CUSTOMER' if message['role'] == 'customer' else 'ROBOT',
            'text': message['text'],
            'time': (PHRASES_FROM + timedelta(seconds=number)).isoformat(timespec='seconds'),
        }
        for number, message in enumerate(messages, 1)
    ]


def read_reply(data: object, http_status: int) -> dict:
    """What the Lab takes from the agent's answer.
    Status 200 is the agent's own reply; 202-x hands the conversation off to an operator."""
    if not isinstance(data, dict):
        raise AgentError('Агент ответил в неизвестном формате (не JSON-объект).')
    message = data.get('message')
    if not isinstance(message, dict) or not isinstance(message.get('content'), dict):
        raise AgentError('Агент ответил в неизвестном формате (нет message.content).')
    content = message['content']
    status = str(content.get('status_code') or http_status)
    text = content.get('result') or content.get('reason') or ''
    if not isinstance(text, str):
        raise AgentError('Агент ответил в неизвестном формате (текст не строка).')
    text = text.strip()
    # Clarifying questions come with buttons; the chat sends the button's text back as the next message.
    suggestions = data.get('suggestions') or []
    if not isinstance(suggestions, list):
        raise AgentError('Агент ответил в неизвестном формате (suggestions не список).')
    options = [o['text'] for o in suggestions if isinstance(o, dict) and isinstance(o.get('text'), str) and o['text']]
    return {'text': text, 'status': status, 'ok': status.startswith('200') and bool(text), 'options': options}


# What a run records as the agent's version when the stand names none.
UNKNOWN_VERSION = 'не сообщается'


class HttpAgent:
    def __init__(self, connection: dict) -> None:
        self.url = connection.get('url') or ''
        self.profile = connection.get('profile', 'prod')
        self.epk = connection.get('epk') or []
        self.version = UNKNOWN_VERSION

    @property
    def mocked(self) -> bool:
        """The bank's systems behind this agent are the stand's mocks, so a scenario's test data can be applied."""
        return self.profile == 'local'

    @property
    def traced(self) -> bool:
        """It gives the trace of a replayed turn: the local agent with its trace harness does."""
        return self.mocked

    def request(self, conversation_id: str, text: str, history: list[dict] | None = None) -> tuple[dict, dict]:
        if self.profile == 'prod':
            return prod_request(conversation_id, text, self.epk)
        return local_request(conversation_id, text, history)

    async def open(self) -> None:
        if not self.url:
            raise AgentError('Не задан адрес агента на тестовом стенде. Укажите его в разделе «Агент».')
        if self.mocked:
            self.version = await _stand_version(self.url) or self.version

    async def close(self) -> None:
        pass

    async def say(
        self, conversation_id: str, text: str, world: dict | None = None, history: list[dict] | None = None
    ) -> dict:
        """One turn: the reply, its status and buttons, seconds taken, the systems it called (local stand) and, from a
        local agent in a replayed conversation (history), what happened inside it (trace; None when the agent does not
        give one or the turn is not replayed)."""
        if not address_valid(self.url):
            raise AgentError(BAD_ADDRESS)  # saved before addresses were checked: the agent cannot be reached
        headers, body = self.request(conversation_id, text, history)
        # A long answer is normal; an unreachable address should fail fast.
        async with httpx.AsyncClient(timeout=httpx.Timeout(config.current().agent_timeout, connect=10)) as client:
            if world and self.mocked:
                await _apply_world(client, headers['x-trace-id'], world)
            cursor = await _mock_cursor(client) if self.mocked else None
            started = time.monotonic()
            try:
                response = await client.post(self.url, json=body, headers=headers)
            except httpx.HTTPError as error:
                raise AgentError(f'Нет связи с агентом ({type(error).__name__}).') from error
            seconds = round(time.monotonic() - started, 2)
            events = await _mock_events(client, cursor, headers.get('x-trace-id'))
            traced = self.mocked and history is not None
            trace = await agent_trace(client, self.url, headers['x-trace-id']) if traced else None
        if response.status_code >= 500 or response.status_code in (401, 403, 404):
            raise AgentError(f'Агент ответил ошибкой (HTTP {response.status_code}).')
        try:
            data = response.json()
        except ValueError as error:
            raise AgentError('Агент ответил не в JSON.') from error
        return {**read_reply(data, response.status_code), 'seconds': seconds, 'events': events, 'trace': trace}


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
            f'{config.current().mock_url}/mock/overrides',
            json={'trace_id': trace_id, 'sbe': {'tools': world}},
            timeout=5,
        )
        response.raise_for_status()
    except (httpx.HTTPError, httpx.InvalidURL) as error:
        raise AgentError(
            f'Заглушки систем банка не приняли тестовые данные сценария ({type(error).__name__}).'
        ) from error


async def _mock_cursor(client: httpx.AsyncClient) -> int | None:
    try:
        data = (await client.get(f'{config.current().mock_url}/mock/calls', params={'limit': 0}, timeout=3)).json()
        return data.get('cursor') if isinstance(data, dict) else None
    except (httpx.HTTPError, httpx.InvalidURL, ValueError):
        return None


async def agent_trace(client: httpx.AsyncClient, agent_url: str, trace_id: str) -> dict | None:
    """What the local agent recorded inside itself for this turn (aigw-local replay/recorder.py)."""
    parts = urlsplit(agent_url)
    try:
        response = await client.get(f'{parts.scheme}://{parts.netloc}{TRACE_PATH}{trace_id}', timeout=5)
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    try:
        value = response.json()
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


async def _mock_events(client: httpx.AsyncClient, cursor: int | None, trace_id: str | None) -> list[dict]:
    """Knowledge-base and business-system calls the turn made, as the stand's mocks recorded them."""
    if cursor is None:
        return []
    try:
        params = {'after': cursor, 'limit': 500}
        data = (await client.get(f'{config.current().mock_url}/mock/calls', params=params, timeout=3)).json()
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

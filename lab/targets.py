"""Agents under test. All speak the aigw-rest-service HTTP contract.

- prod:       the production endpoint (reachable only from the work computer)
- local-http: the acquiring agent already running on this Mac (localhost:8080)
- local-code: the Lab starts the agent from its source code on a free port
"""
import asyncio
import os
import signal
import socket
import ssl
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from . import store

AGENT_PATH = '/api/v1/ai/agents/agent-ckr-pa-acquiring'
DEFAULTS = {
    'prod': {'name': 'Продовый агент', 'kind': 'http', 'profile': 'prod', 'url': os.environ.get('LAB_PROD_URL', ''),
             'note': 'Ручка в контуре банка, доступна с рабочего компьютера.'},
    'local-http': {'name': 'Локальный агент', 'kind': 'http', 'profile': 'local', 'url': 'http://127.0.0.1:8080' + AGENT_PATH,
                   'note': 'Сервис на этом маке, тот же API. GigaChat настоящий, системы банка на заглушках.'},
    'local-code': {'name': 'Агент из исходников', 'kind': 'code', 'profile': 'local',
                   'repo': os.environ.get('AIGW_LOCAL_REPO', str(Path.home() / 'Desktop/aigw-local')), 'port': 8081,
                   'note': 'Запускается из исходников на время прогона, потом останавливается.'},
}
# Test client known to the local stand's business-system fixtures; the synthetic customer uses it for identifiers.
STAND_CUSTOMER = ('Твоя организация: ООО «Ромашка», ИНН 7701234567. Торговая точка «Ромашка, Тверская», '
                  'г. Москва, ул. Тверская, д. 1. Терминалы: Касса №1 (номер 12345678) и Касса №2 (номер 87654321).')
DEFAULTS['local-http']['customer'] = STAND_CUSTOMER
DEFAULTS['local-code']['customer'] = STAND_CUSTOMER
MOCK_URL = os.environ.get('AGENT_LAB_MOCK_URL', 'http://127.0.0.1:8090')
TIMEOUT = float(os.environ.get('LAB_AGENT_TIMEOUT', '180'))


class TargetError(RuntimeError):
    pass


def configs() -> dict:
    """Defaults merged with lab/data/targets.json (kept out of git: internal URLs live there)."""
    merged = {k: dict(v) for k, v in DEFAULTS.items()}
    for key, value in (store.load('targets.json', {}) or {}).items():
        merged.setdefault(key, {}).update(value)
    return merged


def public(key: str, config: dict) -> dict:
    host = urlsplit(config.get('url') or '').hostname or ''
    return {'id': key, 'name': config['name'], 'kind': config['kind'], 'note': config.get('note', ''),
            'where': host if config['kind'] == 'http' else config.get('repo', '').replace(str(Path.home()), '~'),
            'ready': bool(config.get('url')) or config['kind'] == 'code'}


EPK_FILE = Path(__file__).resolve().parent.parent / 'epk.txt'


def prod_clients() -> tuple[list[str], bool]:
    """Organizations (EPK ids) to talk as: epk.txt next to run-prod (one per line) or LAB_PROD_EPK_ID (comma-separated).
    Real ids mean an authorized customer, so the agent can look up the client's own data."""
    ids = [line.strip() for line in EPK_FILE.read_text(encoding='utf-8').splitlines()
           if line.strip() and not line.startswith('#')] if EPK_FILE.exists() else []
    ids = ids or [v.strip() for v in os.environ.get('LAB_PROD_EPK_ID', '').split(',') if v.strip()]
    authorized = os.environ.get('LAB_PROD_AUTHORIZED', '1' if ids else '0') == '1'
    return ids or ['org-12345'], authorized


def _prod_request(conversation_id: str, text: str) -> tuple[dict, dict]:
    ids, authorized = prod_clients()
    epk = ids[sum(conversation_id.encode()) % len(ids)]  # one client per conversation, stable across its turns
    headers = {
        'Content-Type': 'application/json',
        'Request-Id': str(uuid.uuid4()),
        'System-Id': os.environ.get('LAB_PROD_SYSTEM_ID', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
        'Request-Time': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    }
    body = {
        'message': {'version': '1.0', 'performative': 'request', 'sender': 'client', 'receiver': 'agent',
                    'conversation_id': conversation_id, 'reply_with': 'text', 'content': {'user_input': text}},
        'metadata': {'surface_mode': 'NORMAL', 'communication_channel': 'TEXT',
                     'surface': {'code': 'WEB', 'type': 'desktop'},
                     'organization': {'epk_id': epk},
                     'dialog': {'dialog_id': conversation_id},
                     'customer_info': {'authorized': authorized, 'device_info': {'browser': 'Chrome/120.0'}}},
    }
    return headers, body


def _local_request(conversation_id: str, text: str) -> tuple[dict, dict]:
    headers = {
        'Content-Type': 'application/json',
        'x-trace-id': str(uuid.uuid4()),
        'x-client-id': 'CI00163870',
        'x-request-time': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'x-session-id': str(uuid.uuid4()),
    }
    body = {
        'message': {'version': '1.4', 'performative': 'request', 'sender': 'user', 'receiver': 'agent',
                    'conversation_id': conversation_id, 'reply_with': str(uuid.uuid4()),
                    'content': {'user_input': text}},
        'metadata': {'surface_mode': 'CHAT', 'communication_channel': 'TEXT',
                     'organization': {'epk_id': '1000000001'},
                     'customer_info': {'authorized': True, 'digital_user_id': conversation_id[:8]},
                     'dialog': {'dialog_id': conversation_id}},
    }
    return headers, body


class HttpAgent:
    def __init__(self, key: str, config: dict):
        self.key, self.config = key, config
        self.url = config.get('url') or ''
        self.profile = config.get('profile', 'prod')
        self.version = 'не сообщается'
        self.verify = True
        if config.get('cert') and config.get('key'):
            context = ssl.create_default_context(cafile=config.get('ca') or None)
            context.load_cert_chain(os.path.expanduser(config['cert']), os.path.expanduser(config['key']))
            if config.get('insecure'):
                context.check_hostname, context.verify_mode = False, ssl.CERT_NONE
            self.verify = context
        elif config.get('ca'):
            self.verify = ssl.create_default_context(cafile=os.path.expanduser(config['ca']))

    async def open(self) -> None:
        if not self.url:
            raise TargetError('Не задан адрес агента. Для прода: LAB_PROD_URL или lab/data/targets.json.')
        if self.profile == 'local':
            origin = '{0.scheme}://{0.netloc}'.format(urlsplit(self.url))
            try:
                async with httpx.AsyncClient(timeout=5) as client:
                    identity = (await client.get(origin + '/local/agent-lab/identity')).json()
                self.version = str(identity.get('version') or self.version)
            except (httpx.HTTPError, ValueError):
                pass

    async def close(self) -> None:
        pass

    async def _mock_cursor(self, client) -> int | None:
        try:
            data = (await client.get(MOCK_URL + '/mock/calls', params={'limit': 0}, timeout=3)).json()
            return data.get('cursor')
        except (httpx.HTTPError, ValueError):
            return None

    async def _mock_events(self, client, cursor, trace_id) -> list[dict]:
        """Knowledge-base and business-system calls this turn made (local stand only)."""
        if cursor is None:
            return []
        try:
            data = (await client.get(MOCK_URL + '/mock/calls', params={'after': cursor, 'limit': 500}, timeout=3)).json()
        except (httpx.HTTPError, ValueError):
            return []
        events = []
        for call in data.get('calls') or []:
            if call.get('trace_id') != trace_id:
                continue
            if call.get('kind') == 'idp':
                events.append({'tool': 'База знаний', 'query': call.get('query'), 'article': call.get('article')})
            elif call.get('kind') == 'sbe':
                events.append({'tool': 'Система банка · ' + str(call.get('tool')), 'arguments': call.get('arguments')})
        return events

    @property
    def mocked(self) -> bool:
        """Business systems are the stand's mocks, so a scenario world can be applied."""
        return self.profile == 'local'

    async def say(self, conversation_id: str, text: str, world: dict | None = None) -> dict:
        build = _prod_request if self.profile == 'prod' else _local_request
        headers, body = build(conversation_id, text)
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=self.verify) as client:
            if world and self.mocked:
                try:
                    applied = await client.post(MOCK_URL + '/mock/overrides', timeout=5,
                                                json={'trace_id': headers['x-trace-id'], 'sbe': {'tools': world}})
                    applied.raise_for_status()
                except httpx.HTTPError as error:
                    raise TargetError(f'Заглушки систем не приняли данные сценария: {type(error).__name__}') from error
            cursor = await self._mock_cursor(client) if self.profile == 'local' else None
            started = time.monotonic()
            try:
                response = await client.post(self.url, json=body, headers=headers)
            except httpx.HTTPError as error:
                raise TargetError(f'Агент недоступен: {type(error).__name__}') from error
            seconds = round(time.monotonic() - started, 2)
            events = await self._mock_events(client, cursor, headers.get('x-trace-id')) if cursor is not None else []
        if response.status_code >= 500 or response.status_code in (401, 403, 404):
            raise TargetError(f'Агент ответил HTTP {response.status_code}')
        try:
            data = response.json()
        except ValueError as error:
            raise TargetError('Агент вернул не JSON') from error
        content = (data.get('message') or {}).get('content') or {}
        status = str(content.get('status_code') or response.status_code)
        reply = str(content.get('result') or content.get('reason') or '').strip()
        # Clarifying questions come with buttons; the UI sends the button text back as the next message.
        options = [str(o.get('text')) for o in data.get('suggestions') or [] if isinstance(o, dict) and o.get('text')]
        return {'text': reply, 'status': status, 'ok': status.startswith('200') and bool(reply), 'options': options,
                'final': bool((data.get('metadata') or {}).get('final_message')), 'seconds': seconds, 'events': events}


def free_port(preferred: int) -> int:
    """The preferred port if nobody listens on it, otherwise the next free one."""
    for port in range(preferred, preferred + 50):
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1', port)) != 0:
                return port
    raise TargetError('Нет свободного порта для агента из исходников')


class CodeAgent(HttpAgent):
    """Starts the agent from its repository (local/run-app.sh) on its own port."""

    def __init__(self, key: str, config: dict):
        port = free_port(int(config.get('port', 8081)))
        super().__init__(key, {**config, 'url': f'http://127.0.0.1:{port}{AGENT_PATH}', 'profile': 'local'})
        self.repo = Path(os.path.expanduser(config['repo']))
        self.port = port
        self.process = None

    async def open(self) -> None:
        script = self.repo / 'local/run-app.sh'
        if not script.exists():
            raise TargetError(f'Нет исходников агента: {script}')
        log = (store.DATA / 'local-code-agent.log').open('w')
        env = {**os.environ, 'APP_PORT': str(self.port)}
        self.process = subprocess.Popen([str(script)], cwd=self.repo, env=env, stdout=log, stderr=subprocess.STDOUT,
                                        start_new_session=True)
        deadline = time.monotonic() + 180
        async with httpx.AsyncClient(timeout=3) as client:
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise TargetError('Агент из исходников не запустился: см. lab/data/local-code-agent.log')
                try:
                    identity = (await client.get(f'http://127.0.0.1:{self.port}/local/agent-lab/identity')).json()
                    if identity.get('pid') != self.process.pid:
                        raise TargetError(f'На порту {self.port} отвечает чужой процесс агента (pid {identity.get("pid")})')
                    branch = subprocess.run(['git', 'branch', '--show-current'], cwd=self.repo, capture_output=True,
                                            text=True).stdout.strip()
                    self.version = f"{identity.get('version')} · {branch}" if branch else str(identity.get('version'))
                    return
                except (httpx.HTTPError, ValueError):
                    await asyncio.sleep(1)
        raise TargetError('Агент из исходников не ответил за 3 минуты')

    async def close(self) -> None:
        if self.process and self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
                await asyncio.to_thread(self.process.wait, 15)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                os.killpg(self.process.pid, signal.SIGKILL)


def create(key: str):
    config = configs().get(key)
    if not config:
        raise TargetError(f'Неизвестный агент: {key}')
    return (CodeAgent if config['kind'] == 'code' else HttpAgent)(key, config)

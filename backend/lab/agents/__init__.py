"""Agents under test. Each one speaks the aigw-rest-service HTTP contract.

- prod:       the agent on the IFT stand, reachable from the work computer;
- local-http: the acquiring agent already running on this computer (localhost:8080);
- local-code: the Lab starts the agent from its repository for one run.
Their settings are set on the page and kept in data/settings.json.
"""

from pathlib import Path
from urllib.parse import urlsplit

from .. import store
from .http import AGENT_PATH, AgentError, HttpAgent
from .session import session
from .source import CodeAgent

SETTINGS = 'settings.json'
DEFAULT_REPO = '~/Desktop/aigw-local'
# The test client in the local stand's fixtures: the synthetic customer gives these details when asked.
STAND_CUSTOMER = (
    'Твоя организация: ООО «Ромашка», ИНН 7701234567. Торговая точка «Ромашка, Тверская», '
    'г. Москва, ул. Тверская, д. 1. Терминалы: Касса №1 (номер 12345678) и Касса №2 (номер 87654321).'
)


def settings() -> dict:
    """prodUrl: the agent's address on the IFT stand; epk: the customers' EPK ids to talk as (none: an
    unauthorized test customer); repo: the agent's repository with its prompts, tools and knowledge base."""
    saved = store.load(SETTINGS, {}) or {}
    return {
        'prodUrl': str(saved.get('prodUrl') or '').strip(),
        'epk': [str(e).strip() for e in saved.get('epk') or [] if str(e).strip()],
        'repo': str(saved.get('repo') or DEFAULT_REPO).strip(),
    }


def save_settings(values: dict) -> dict:
    current = settings()
    current.update({k: v for k, v in values.items() if k in current})
    if isinstance(current['epk'], str):
        current['epk'] = current['epk'].split()
    store.save(SETTINGS, current)
    return settings()


def repo() -> Path:
    return Path(settings()['repo']).expanduser()


def configs() -> dict[str, dict]:
    current = settings()
    return {
        'prod': {
            'name': 'Агент на ИФТ',
            'kind': 'http',
            'profile': 'prod',
            'url': current['prodUrl'],
            'epk': current['epk'],
            'note': 'Ручка в контуре банка, доступна с рабочего компьютера.',
        },
        'local-http': {
            'name': 'Локальный агент',
            'kind': 'http',
            'profile': 'local',
            'url': f'http://127.0.0.1:8080{AGENT_PATH}',
            'customer': STAND_CUSTOMER,
            'note': 'Сервис на этом компьютере, тот же API. GigaChat настоящий, системы банка на заглушках.',
        },
        'local-code': {
            'name': 'Агент из исходников',
            'kind': 'code',
            'profile': 'local',
            'repo': current['repo'],
            'port': 8081,
            'customer': STAND_CUSTOMER,
            'note': 'Запускается из исходников на время прогона, потом останавливается.',
        },
    }


def public(key: str, config: dict) -> dict:
    """What the page shows about an agent: the host or the repository, never the full internal address."""
    where = urlsplit(config.get('url') or '').hostname or ''
    if config['kind'] == 'code':
        where = config.get('repo', '').replace(str(Path.home()), '~')
    return {
        'id': key,
        'name': config['name'],
        'kind': config['kind'],
        'note': config.get('note', ''),
        'where': where,
        'ready': bool(config.get('url')) or config['kind'] == 'code',
    }


def create(key: str) -> HttpAgent:
    config = configs().get(key)
    if not config:
        raise AgentError(f'Неизвестный агент: {key}')
    return CodeAgent(config) if config['kind'] == 'code' else HttpAgent(config)


__all__ = [
    'STAND_CUSTOMER',
    'AgentError',
    'CodeAgent',
    'HttpAgent',
    'configs',
    'create',
    'public',
    'repo',
    'session',
    'settings',
]

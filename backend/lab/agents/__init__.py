"""Agents under test. Each one speaks the aigw-rest-service HTTP contract.

- prod:       the agent on the IFT stand, reachable from the work computer;
- local-http: the acquiring agent already running on this computer (localhost:8080);
- local-code: the Lab starts the agent from its repository for one run;
- replay-service: the acquiring agent on the stand that only replays recorded conversations, with its trace.
The settings they are reached by are set on the page (flows.connection keeps them); here is how to reach each.
"""

from pathlib import Path
from urllib.parse import urlsplit

from .code import START, CodeAgent
from .http import AGENT_PATH, BAD_ADDRESS, UNKNOWN_VERSION, AgentError, HttpAgent, address_valid
from .replay_service import ReplayServiceAgent
from .session import session

DEFAULT_REPO = '~/Desktop/aigw-local'
REPLAY_SERVICE = 'replay-service'
Agent = HttpAgent | ReplayServiceAgent
# The ways to reach the agent, in words without a developer's slang: the same in «Агент», «Сыграть», the runs and
# the reports. A run keeps the name it was played under (targetName); it is shown under the current one (run_name).
NAMES = {
    'prod': 'Тестовый стенд банка',
    'local-http': 'На этом компьютере',
    'local-code': 'Запуск из кода',
    REPLAY_SERVICE: 'Сервис повтора на стенде',
}
# The test client in the local stand's fixtures: the synthetic customer gives these details when asked.
STAND_CUSTOMER = (
    'Твоя организация: ООО «Ромашка», ИНН 7701234567. Торговая точка «Ромашка, Тверская», '
    'г. Москва, ул. Тверская, д. 1. Терминалы: Касса №1 (номер 12345678) и Касса №2 (номер 87654321).'
)


def settings(saved: dict) -> dict:
    """prodUrl: the agent's address on the IFT stand; epk: the customers' EPK ids to talk as (none: an
    unauthorized test customer); repo: the agent's repository with its prompts, tools and knowledge base. saved: the
    settings as the page last saved them."""
    return {
        'prodUrl': str(saved.get('prodUrl') or '').strip(),
        'epk': [str(e).strip() for e in saved.get('epk') or [] if str(e).strip()],
        'repo': str(saved.get('repo') or DEFAULT_REPO).strip(),
    }


def changed(current: dict, values: dict) -> dict:
    """The settings with a person's changes. A typo in the agent's address is refused here, in words, instead of
    surfacing later inside a check or a run; an empty address clears it."""
    found = current | {key: value for key, value in values.items() if key in current}
    if isinstance(found['epk'], str):
        found['epk'] = found['epk'].split()
    found['prodUrl'] = found['prodUrl'].strip()
    if found['prodUrl'] and not address_valid(found['prodUrl']):
        raise ValueError(BAD_ADDRESS)
    return found


def configs(current: dict) -> dict[str, dict]:
    """How to reach the agent each way, by the settings (settings)."""
    return {
        'prod': {
            'name': NAMES['prod'],
            'kind': 'http',
            'profile': 'prod',
            'url': current['prodUrl'],
            'epk': current['epk'],
            'note': 'Стенд ИФТ в сети банка. Агент доступен с рабочего компьютера.',
        },
        'local-http': {
            'name': NAMES['local-http'],
            'kind': 'http',
            'profile': 'local',
            'url': f'http://127.0.0.1:8080{AGENT_PATH}',
            'customer': STAND_CUSTOMER,
            'note': (
                'Агент с тем же API уже запущен на этом компьютере. GigaChat настоящий, системы банка на заглушках.'
            ),
        },
        'local-code': {
            'name': NAMES['local-code'],
            'kind': 'code',
            'profile': 'local',
            'repo': current['repo'],
            'port': 8081,
            'customer': STAND_CUSTOMER,
            'note': 'Агент запускается из кода только на время прогона.',
        },
    }


def replay_config(url: str) -> dict:
    """How to reach the replay service on the stand (aigw-local replay/) at its origin, http://host:port: it replays
    recorded conversations and does not talk, so it is not among the ways to reach the agent (configs)."""
    return {
        'name': NAMES[REPLAY_SERVICE],
        'kind': 'replay',
        'profile': 'replay',
        'url': url.strip(),
        'note': 'Агент эквайринга на стенде. Во внешние системы не пишет, трейс отдаёт на каждом шаге.',
    }


def replay_targets(ways: dict[str, dict]) -> list[dict]:
    """The ways a replay may reach the agent (ways: the agent's own and the replay service), as the page shows them:
    set up and giving their trace."""
    shown = [public(key, way) for key, way in ways.items()]
    return [target for target in shown if target['ready'] and (target['local'] or target['kind'] == 'replay')]


def public(key: str, config: dict) -> dict:
    """What the page shows about an agent: the host or the repository, never the full internal address.
    Ready: its address is set, or its folder has what starts it from its code (START). Whether it answers is what
    «Проверить связь» tells. Local: it runs on the local stand (HttpAgent.mocked; the code one always does), so it gives
    its trace to a replay; the replay service does too (replay_targets)."""
    where = urlsplit(config.get('url') or '').hostname or ''
    ready = bool(config.get('url'))
    if config['kind'] == 'code':
        where = config.get('repo', '').replace(str(Path.home()), '~')
        ready = bool(config.get('repo')) and (Path(config['repo']).expanduser() / START).is_file()
    return {
        'id': key,
        'name': config['name'],
        'kind': config['kind'],
        'note': config.get('note', ''),
        'where': where,
        'ready': ready,
        'local': config['kind'] == 'code' or config.get('profile') == 'local',
    }


def run_name(run: dict) -> str:
    """The way a run reached its agent, by its current name: a run played before the names changed recorded the older
    one; a way that no longer exists keeps the name it was played under."""
    return NAMES.get(str(run.get('target') or ''), run.get('targetName') or '')


def create(connection: dict) -> Agent:
    """The agent reached this way (configs, replay_config); one started from its code writes its output to
    connection['log']."""
    if connection['kind'] == 'replay':
        return ReplayServiceAgent(connection)
    return CodeAgent(connection) if connection['kind'] == 'code' else HttpAgent(connection)


__all__ = [
    'NAMES',
    'REPLAY_SERVICE',
    'STAND_CUSTOMER',
    'UNKNOWN_VERSION',
    'Agent',
    'AgentError',
    'CodeAgent',
    'HttpAgent',
    'ReplayServiceAgent',
    'changed',
    'configs',
    'create',
    'public',
    'replay_config',
    'replay_targets',
    'run_name',
    'session',
    'settings',
]

"""Agents under test. Each one speaks the aigw-rest-service HTTP contract.

- prod:       the agent on the IFT stand, reachable from the work computer;
- local-http: the acquiring agent already running on this computer (localhost:8080);
- local-code: the Lab starts the agent from its repository for one run.
The settings they are reached by are set on the page (flows.connection keeps them); here is how to reach each.
"""

from pathlib import Path
from urllib.parse import urlsplit

from .code import START, CodeAgent
from .http import AGENT_PATH, BAD_ADDRESS, UNKNOWN_VERSION, AgentError, HttpAgent, address_valid
from .session import session

DEFAULT_REPO = '~/Desktop/aigw-local'
# The three ways to reach the agent, in words without a developer's slang: the same in «Агент», «Сыграть», the runs and
# the reports. A run keeps the name it was played under (targetName); it is shown under the current one (run_name).
NAMES = {'prod': 'Тестовый стенд банка', 'local-http': 'На этом компьютере', 'local-code': 'Запуск из кода'}
BAD_INN = 'ИНН клиента с ЕПК {epk} записан с ошибкой: нужно 10 или 12 цифр.'
BAD_TERMINALS = 'Номера терминалов клиента с ЕПК {epk}: только цифры, через пробел.'


def _clients(saved: object, epk: list[str]) -> dict[str, dict]:
    """The organizations of the EPK ids as the person described them ({epk: {name, inn, terminals}}): what the
    synthetic customer can name on the IFT stand, where the agent sees these organizations' real data. Only the EPK
    ids talked as; one described by nothing is left out."""
    found = {}
    for key, item in saved.items() if isinstance(saved, dict) else ():
        if str(key).strip() not in epk or not isinstance(item, dict):
            continue
        terminals = item.get('terminals') or []
        if isinstance(terminals, str):
            terminals = terminals.replace(',', ' ').split()
        described = {
            'name': str(item.get('name') or '').strip(),
            'inn': str(item.get('inn') or '').strip(),
            'terminals': [str(t).strip() for t in terminals if str(t).strip()],
        }
        if any(described.values()):
            found[str(key).strip()] = described
    return found


def settings(saved: dict) -> dict:
    """prodUrl: the agent's address on the IFT stand; epk: the customers' EPK ids to talk as (none: an
    unauthorized test customer); clients: the organizations of those EPK ids, as far as the person described them;
    repo: the agent's repository with its prompts, tools and knowledge base. saved: the settings as the page last saved
    them."""
    epk = [str(e).strip() for e in saved.get('epk') or [] if str(e).strip()]
    return {
        'prodUrl': str(saved.get('prodUrl') or '').strip(),
        'epk': epk,
        'clients': _clients(saved.get('clients'), epk),
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
    found['clients'] = _clients(found['clients'], [str(e).strip() for e in found['epk'] or []])
    for epk, client in found['clients'].items():
        if client['inn'] and not (client['inn'].isdigit() and len(client['inn']) in (10, 12)):
            raise ValueError(BAD_INN.format(epk=epk))
        if not all(t.isdigit() for t in client['terminals']):
            raise ValueError(BAD_TERMINALS.format(epk=epk))
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
            'clients': current['clients'],
            'note': 'Стенд ИФТ в сети банка. Агент доступен с рабочего компьютера.',
        },
        'local-http': {
            'name': NAMES['local-http'],
            'kind': 'http',
            'profile': 'local',
            'url': f'http://127.0.0.1:8080{AGENT_PATH}',
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
            'note': 'Агент запускается из кода только на время прогона.',
        },
    }


def public(key: str, config: dict) -> dict:
    """What the page shows about an agent: the host or the repository, never the full internal address.
    Ready: its address is set, or its folder has what starts it from its code (START). Whether it answers is what
    «Проверить связь» tells."""
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
    }


def run_name(run: dict) -> str:
    """The way a run reached its agent, by its current name: a run played before the names changed recorded the older
    one; a way that no longer exists keeps the name it was played under."""
    return NAMES.get(str(run.get('target') or ''), run.get('targetName') or '')


def create(connection: dict) -> HttpAgent:
    """The agent reached this way (configs); one started from its code writes its output to connection['log']."""
    return CodeAgent(connection) if connection['kind'] == 'code' else HttpAgent(connection)


__all__ = [
    'NAMES',
    'UNKNOWN_VERSION',
    'AgentError',
    'CodeAgent',
    'HttpAgent',
    'changed',
    'configs',
    'create',
    'public',
    'run_name',
    'session',
    'settings',
]

#!/usr/bin/env python3
"""A report on this computer's setup for replaying Voice360 conversations through the acquiring agent: both
repositories, the agent's .env with secrets masked, certificates, Python, reachability of GigaChat, IDP, SBE and
Postgres, and what is running. Standard library only; nothing is changed.

    python3 bin/replay_env_report.py --agent ../ai-agent-acquiring

The report goes to stdout and to replay-env-report.txt beside this repository. No secret value is printed: a
password, token, login or key is shown only as set or empty."""

import argparse
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

LAB = Path(__file__).resolve().parents[1]
AGENT_BRANCH = 'feat/replay-service'
LAB_BRANCH = 'feat/voice360-replay-on-master'
SECRET = re.compile(r'PASS|SECRET|TOKEN|LOGIN|CREDENTIAL|API_KEY|(?<!_)KEY$|_KEY$')
PATHLIKE = re.compile(r'(FILEPATH|CERT_PATH)$')
ENDPOINTS = (
    ('GigaChat', 'GIGA_CHAT_HOST', 'GIGA_CHAT_PORT'),
    ('IDP', 'IDP_RAG_HOST', 'IDP_RAG_PORT'),
    ('SBE', 'SBE_TOOL_HOST', 'SBE_TOOL_PORT'),
    ('SBE mock', 'SBE_TOOL_HOST_MOCK', 'SBE_TOOL_PORT_MOCK'),
    ('Postgres', 'POSTGRES_HOST', 'POSTGRES_PORT'),
    ('Elastic', 'ELASTIC_HOST', 'ELASTIC_PORT'),
)
RELEVANT = (
    'LOCAL', 'DEBUG', 'APP_PORT', 'GIGA_CHAT_HOST', 'GIGA_CHAT_PORT', 'GIGA_PRO_MODEL', 'GIGA_MAX_MODEL',
    'GIGACHAT_TLS_CERT_FILEPATH', 'GIGACHAT_KEY_FILEPATH', 'GIGACHAT_CA_BUNDLE_FILEPATH', 'IDP_RAG_HOST',
    'IDP_RAG_PORT', 'IDP_ENDPOINT', 'TLS_CERT_FILEPATH', 'KEY_FILEPATH', 'IDP_QA_ENABLED', 'IDP_OWN_GENERATION_ENABLED',
    'IDP_QA_MODEL', 'IDP_BASE_EMBEDDER_MODEL', 'IDP_DATA_SOURCE_INDEX_ID_MAIN', 'IDP_FILTER_VALUE_MAIN',
    'IDP_CACHE_ENABLED', 'IDP_AND_VALIDATOR_UNITE_ENABLED', 'NEGATIVE_FILTER_ENABLED', 'SBE_MOCK_ENABLED',
    'SBE_TOOL_HOST', 'SBE_TOOL_HOST_MOCK', 'POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_SEARCH_PATH', 'POSTGRES_LOGIN',
    'DB_PASS', 'MLS_CLIENT_ENABLED', 'MLS_CLIENT_LOGIN', 'AEF_ENABLED', 'ELASTIC_HOST', 'MOCK_LLM_BASE_URL',
    'MOCK_LLM_MODEL', 'MOCK_LLM_API_KEY',
)
LOCAL_PORTS = {8080: 'агент', 8090: 'заглушки агента', 5899: 'Agent Lab', 55432: 'локальный Postgres'}
AGENT_PACKAGES = ('fastapi', 'langchain_core', 'langchain_gigachat', 'langgraph', 'httpx', 'asyncpg', 'sqlalchemy')
LAB_PACKAGES = ('fastapi', 'httpx', 'openpyxl', 'pydantic')


def main() -> None:
    arguments = parse_arguments()
    agent = Path(arguments.agent).expanduser().resolve()
    lines: list[str] = []
    for title, section in (
        ('Компьютер', lambda: computer()),
        ('Репозиторий агента', lambda: repository(agent, AGENT_BRANCH)),
        ('Репозиторий Lab', lambda: repository(LAB, LAB_BRANCH)),
        ('.env агента', lambda: agent_env(agent)),
        ('Файлы из .env агента', lambda: env_files(agent)),
        ('Python агента', lambda: virtualenv(agent / '.venv', AGENT_PACKAGES)),
        ('Запись трейса в агенте', lambda: trace_harness(agent)),
        ('Сеть: хосты из .env агента', lambda: reachability(agent)),
        ('Что запущено на этом компьютере', lambda: running(arguments.agent_url)),
        ('Lab: модели и данные', lambda: lab_setup()),
        ('Python Lab', lambda: virtualenv(LAB / 'backend' / '.venv', LAB_PACKAGES)),
    ):
        lines += ['', f'## {title}', *safely(section)]
    report = '\n'.join(['# Отчёт о настройке повтора разговоров', *lines]) + '\n'
    print(report)
    target = LAB / 'replay-env-report.txt'
    target.write_text(report, encoding='utf-8')
    print(f'Сохранено в {target}')


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--agent', default=str(LAB.parent / 'aigw-local'), help='папка репозитория агента')
    parser.add_argument('--agent-url', default='http://127.0.0.1:8080', help='адрес запущенного агента')
    return parser.parse_args()


def safely(section) -> list[str]:
    try:
        return section()
    except Exception as error:  # a broken section must not hide the rest of the report
        return [f'не удалось проверить: {type(error).__name__}: {error}']


def computer() -> list[str]:
    tools = ['git', 'uv', 'node', 'npm', 'openssl', 'python3.11', 'python3.12', 'python3.13']
    return [
        f'ОС: {platform.platform()}',
        f'python3 этого скрипта: {sys.version.split()[0]} ({sys.executable})',
        *(f'{tool}: {version_of(tool)}' for tool in tools),
    ]


def version_of(tool: str) -> str:
    if not shutil.which(tool):
        return 'нет'
    flag = '--version'
    result = run([tool, flag])
    return (result.splitlines() or ['?'])[0]


def repository(path: Path, expected: str) -> list[str]:
    if not (path / '.git').exists():
        return [f'{path}: не репозиторий git (укажите путь через --agent)']
    branch = git(path, 'branch', '--show-current')
    run(['git', '-C', str(path), 'fetch', '--quiet'], timeout=20)
    behind_ahead = git(path, 'rev-list', '--left-right', '--count', f'origin/{branch}...HEAD') if branch else ''
    changed = [line for line in run(['git', '-C', str(path), 'status', '--porcelain']).splitlines() if line.strip()]
    return [
        f'путь: {path}',
        f'remote: {mask_url(git(path, "remote", "get-url", "origin"))}',
        f'ветка: {branch or "(detached)"}' + ('' if branch == expected else f'  ← нужна {expected}'),
        f'коммит: {git(path, "log", "-1", "--format=%h %ad %s", "--date=short")}',
        f'отставание/опережение от origin: {behind_ahead or "нет ветки на origin"}',
        f'изменённых файлов в рабочей копии: {len(changed)}',
        *(f'  {line}' for line in changed[:15]),
    ]


def agent_env(agent: Path) -> list[str]:
    env_path = agent / '.env'
    if not env_path.exists():
        return ['.env нет: run-app.sh создаст ссылку на local/env.local (заглушки)']
    lines = [f'.env: {"ссылка на " + os.readlink(env_path) if env_path.is_symlink() else "обычный файл"}']
    values = read_env(env_path)
    template = read_env(agent / 'local_env') if (agent / 'local_env').exists() else {}
    if template:
        missing = sorted(set(template) - set(values))
        extra = sorted(set(values) - set(template))
        lines.append(f'нет по сравнению с local_env: {", ".join(missing) or "—"}')
        lines.append(f'лишние по сравнению с local_env: {", ".join(extra) or "—"}')
        differs = sorted(key for key in set(values) & set(template) - set(RELEVANT) if values[key] != template[key])
        lines.append(f'прочие ключи со значением не как в local_env: {", ".join(differs) or "—"}')
    lines += [f'{key}={shown(key, values[key])}' for key in RELEVANT if key in values]
    return lines


def env_files(agent: Path) -> list[str]:
    values = read_env(agent / '.env') if (agent / '.env').exists() else {}
    lines = []
    for key, value in sorted(values.items()):
        if not PATHLIKE.search(key) or not value:
            continue
        path = Path(value).expanduser()
        path = path if path.is_absolute() else agent / path
        state = 'есть' if path.is_file() else 'папка, нужен файл' if path.is_dir() else 'НЕТ ФАЙЛА'
        lines.append(f'{key}: {state}  ({value})')
    local = values.get('LOCAL', '').lower() == 'true'
    if local and not values.get('GIGACHAT_CA_BUNDLE_FILEPATH'):
        lines.append('GIGACHAT_CA_BUNDLE_FILEPATH не задан: при LOCAL=True агент не стартует (config.py, validate_file_path)')
    if values.get('MLS_CLIENT_ENABLED', '').lower() == 'true':
        cache = agent / 'local' / 'mls_cache'
        lines.append(f'MLS_CLIENT_ENABLED=True, локальный кэш промптов local/mls_cache: {"есть" if cache.exists() else "нет"}')
    return lines or ['путей к файлам в .env нет']


def virtualenv(venv: Path, packages: tuple[str, ...]) -> list[str]:
    python = venv / 'bin' / 'python'
    if not python.exists():
        return [f'{venv}: нет виртуального окружения']
    if not python.resolve().exists():
        return [f'{python} ссылается на {python.resolve()}, которого нет: окружение нужно пересоздать']
    probe = (
        'import importlib.metadata as m, sys\n'
        f'print(sys.version.split()[0])\n'
        f'for name in {list(packages)!r}:\n'
        '    try: print(name, m.version(name.replace("_", "-")))\n'
        '    except m.PackageNotFoundError: print(name, "НЕТ")\n'
    )
    return [f'окружение: {venv}', *run([str(python), '-c', probe]).splitlines()]


def trace_harness(agent: Path) -> list[str]:
    files = [
        'local/run-app.sh',
        'local/agent_lab_app.py',
        'replay/recorder.py',
        'replay/app.py',
        'replay/run.sh',
        'local/stubs/aef_tracing',
    ]
    lines = [f'{name}: {"есть" if (agent / name).exists() else "НЕТ"}' for name in files]
    app = agent / 'local' / 'agent_lab_app.py'
    if app.exists():
        text = app.read_text(encoding='utf-8')
        lines.append(f'agent_lab_app.py отдаёт трейс: {"да" if "/local/agent-lab/trace/" in text else "НЕТ (старая версия)"}')
    return lines


def reachability(agent: Path) -> list[str]:
    values = read_env(agent / '.env') if (agent / '.env').exists() else {}
    lines = []
    for name, host_key, port_key in ENDPOINTS:
        host, port = values.get(host_key), values.get(port_key)
        if not host:
            continue
        lines.append(f'{name} {host}:{port or "?"} — {connect(host, int(port) if port and port.isdigit() else 443)}')
    mls = values.get('MLS_CLIENT_URL')
    if mls:
        parts = urllib.parse.urlsplit(mls if '://' in mls else f'https://{mls}')
        port = parts.port or int(values.get('MLS_CLIENT_PORT') or 443)
        lines.append(f'ML Storage {parts.hostname}:{port} — {connect(parts.hostname or "", port)}')
    return lines or ['хостов в .env нет']


def connect(host: str, port: int) -> str:
    try:
        address = socket.gethostbyname(host)
    except OSError:
        return 'имя не находится (DNS)'
    try:
        with socket.create_connection((address, port), timeout=4):
            return f'порт открыт ({address})'
    except OSError as error:
        return f'не подключиться ({address}): {error.__class__.__name__}'


def running(agent_url: str) -> list[str]:
    lines = []
    for port, name in LOCAL_PORTS.items():
        busy = connect('127.0.0.1', port).startswith('порт открыт')
        lines.append(f':{port} {name}: {"слушает" if busy else "не запущен"}')
    identity = fetch(f'{agent_url}/local/agent-lab/identity')
    lines.append(f'identity агента: {identity}')
    trace = fetch(f'{agent_url}/local/agent-lab/trace/report-probe')
    lines.append(f'адрес трейса (ожидается 404 trace not found): {trace}')
    return lines


def lab_setup() -> list[str]:
    certs = LAB / 'certs'
    lines = [f'certs/: {", ".join(sorted(p.name for p in certs.iterdir())) if certs.exists() else "нет"}']
    url = certs / 'url.txt'
    if url.exists():
        lines.append(f'шлюз моделей: {mask_url(url.read_text(encoding="utf-8").strip())}')
    for key in (
        'LAB_MODEL_URL', 'LAB_MODEL', 'LAB_SECOND_MODEL', 'LAB_SECOND_URL', 'LAB_DATA', 'LAB_PORT', 'LAB_REPLAY_URL',
        'LAB_AGENT_TIMEOUT', 'AGENT_LAB_MOCK_URL',
    ):  # fmt: skip
        if key in os.environ:
            lines.append(f'{key}={shown(key, os.environ[key])}')
    agents = LAB / 'data' / 'agents'
    lines.append(f'агенты в data/: {", ".join(sorted(p.name for p in agents.iterdir())) if agents.exists() else "нет"}')
    lines.append(f'интерфейс собран (frontend/dist): {"да" if (LAB / "frontend" / "dist").exists() else "нет"}')
    return lines


def read_env(path: Path) -> dict[str, str]:
    values = {}
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        match = re.match(r'\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$', line)
        if match:
            values[match.group(1)] = match.group(2).strip().strip('"').strip("'")
    return values


def shown(key: str, value: str) -> str:
    if PATHLIKE.search(key):
        return value
    if SECRET.search(key):
        return '<пусто>' if not value else '<задан>'
    return value


def mask_url(url: str) -> str:
    return re.sub(r'//[^/@]+@', '//***@', url)


def git(path: Path, *arguments: str) -> str:
    return run(['git', '-C', str(path), *arguments]).strip()


def fetch(url: str) -> str:
    try:
        with urllib.request.urlopen(url, timeout=4) as response:
            body = response.read(400).decode('utf-8', 'replace')
            return f'HTTP {response.status} {compact(body)}'
    except urllib.error.HTTPError as error:
        return f'HTTP {error.code} {compact(error.read(200).decode("utf-8", "replace"))}'
    except (urllib.error.URLError, OSError) as error:
        return f'нет ответа ({error.__class__.__name__})'


def compact(body: str) -> str:
    try:
        return json.dumps(json.loads(body), ensure_ascii=False)[:300]
    except ValueError:
        return body.strip()[:200]


def run(command: list[str], timeout: int = 15) -> str:
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        return f'не запустилось: {error.__class__.__name__}'
    return result.stdout or result.stderr


if __name__ == '__main__':
    main()

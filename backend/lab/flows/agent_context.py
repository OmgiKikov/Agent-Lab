"""Optional agent tools, IDP connection and a managed checkout of a repository URL."""

import asyncio
import hashlib
import os
from pathlib import Path
from urllib.parse import urlsplit

from .. import storage
from ..agents import idp

FILE = 'agent-context.json'
DEFAULTS = {'tools': [], 'idpUrl': '', 'idpIndex': '', 'idpEmbedder': '', 'idpFilter': '', 'repositoryUrl': ''}


def current() -> dict:
    return DEFAULTS | (storage.documents.load(FILE) or {})


def save(values: dict) -> dict:
    value = current() | values
    for key in ('idpUrl', 'idpIndex', 'idpEmbedder', 'idpFilter', 'repositoryUrl'):
        value[key] = value[key].strip()
    for key in ('idpUrl', 'repositoryUrl'):
        if value[key]:
            url = urlsplit(value[key])
            allowed = ('https', 'http', 'ssh') if key == 'repositoryUrl' else ('https', 'http')
            if url.scheme not in allowed or not url.hostname or url.password or (url.scheme != 'ssh' and url.username):
                raise ValueError(
                    'Укажите HTTP(S)-адрес без встроенных учётных данных. Для Git также поддерживается ssh://.'
                )
            # The key and the certificate of the knowledge base go with every request to it: never in the clear,
            # but to this computer.
            if key == 'idpUrl' and url.scheme == 'http' and url.hostname not in ('localhost', '127.0.0.1', '::1'):
                raise ValueError('Адрес базы знаний должен начинаться с https://: с запросом к ней уходит ключ.')
    value['tools'] = list(dict.fromkeys(tool.strip() for tool in value['tools'] if tool.strip()))
    storage.documents.save(FILE, value)
    return value


def checkout_path() -> Path | None:
    url = current()['repositoryUrl']
    return (
        storage.db.database().parent / 'repositories' / hashlib.sha256(url.encode()).hexdigest()[:16] if url else None
    )


async def checkout() -> Path | None:
    path = checkout_path()
    if path is None:
        return None
    url = current()['repositoryUrl']
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = (path / '.git').exists()
    args = (
        ['git', '-C', str(path), 'fetch', '--depth=1', 'origin']
        if (path / '.git').exists()
        else [
            'git',
            'clone',
            '--depth',
            '1',
            '--',
            url,
            str(path),
        ]
    )
    await _git(args)
    if existing:
        await _git(['git', '-C', str(path), 'checkout', '--detach', 'FETCH_HEAD'])
    return path


async def _git(args: list[str]) -> None:
    # Never a question in the Lab's terminal: no password or passphrase is asked, an unknown host is refused, and the
    # error says why (ssh in batch mode, unless the person set their own ssh command for git).
    quiet = {'GIT_TERMINAL_PROMPT': '0', 'GIT_SSH_COMMAND': os.environ.get('GIT_SSH_COMMAND', 'ssh -o BatchMode=yes')}
    process = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        env=os.environ | quiet,
    )
    try:
        _, _error = await asyncio.wait_for(process.communicate(), 120)
    except asyncio.CancelledError:
        process.terminate()
        await process.wait()
        raise
    except TimeoutError as error:
        process.kill()
        await process.wait()
        raise ValueError('Репозиторий не ответил за две минуты. Проверьте доступ и повторите.') from error
    if process.returncode:
        raise ValueError('Не удалось прочитать репозиторий. Проверьте URL и доступ Git на этом компьютере.')


async def knowledge(query: str) -> tuple[list[dict], str | None]:
    context = current()
    if not context['idpIndex']:
        return [], None
    if not context['idpUrl'] or not context['idpEmbedder']:
        return [], 'Для IDP укажите адрес и модель эмбеддингов в карточке агента.'
    try:
        found = await idp.retrieve(context, query)
        return found, None if found else 'IDP не вернула источники по этому вопросу.'
    except ValueError as error:
        return [], str(error)

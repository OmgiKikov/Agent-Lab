"""The agents this Lab checks. Each agent has its own database, data/agents/<id>/lab.sqlite3: its dialogues, rules,
results and a person's answers never mix with another agent's. The registry itself is data/agents.sqlite3.

A request works inside one agent (api.py sets it from the X-Agent header); `using` does the same for code outside a
request. Without an agent, store keeps its own default database (tests, the legacy import).
"""

import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from . import store

LATIN = {
    'а': 'a',
    'б': 'b',
    'в': 'v',
    'г': 'g',
    'д': 'd',
    'е': 'e',
    'ё': 'e',
    'ж': 'zh',
    'з': 'z',
    'и': 'i',
    'й': 'y',
    'к': 'k',
    'л': 'l',
    'м': 'm',
    'н': 'n',
    'о': 'o',
    'п': 'p',
    'р': 'r',
    'с': 's',
    'т': 't',
    'у': 'u',
    'ф': 'f',
    'х': 'kh',
    'ц': 'ts',
    'ч': 'ch',
    'ш': 'sh',
    'щ': 'shch',
    'ъ': '',
    'ы': 'y',
    'ь': '',
    'э': 'e',
    'ю': 'yu',
    'я': 'ya',
}


def _root() -> Path:
    """Where agents live: beside the default database, so whatever data directory a process (or a test) uses, its
    agents are there too and never in another one."""
    return store.DB.parent


def _registry() -> Path:
    return _root() / 'agents.sqlite3'


def db_of(agent_id: str) -> Path:
    return _root() / 'agents' / agent_id / 'lab.sqlite3'


@contextmanager
def _connection() -> Iterator[sqlite3.Connection]:
    path = _registry()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10)
    try:
        path.chmod(0o600)
        connection.execute(
            'CREATE TABLE IF NOT EXISTS agents ('
            'id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL)'
        )
        with connection:
            yield connection
    finally:
        connection.close()


def _row(row: tuple) -> dict:
    return {'id': row[0], 'name': row[1], 'description': row[2], 'createdAt': row[3]}


def listed() -> list[dict]:
    with _connection() as connection:
        rows = connection.execute('SELECT id, name, description, created_at FROM agents ORDER BY rowid').fetchall()
    return [_row(row) for row in rows]


def get(agent_id: str) -> dict | None:
    with _connection() as connection:
        row = connection.execute(
            'SELECT id, name, description, created_at FROM agents WHERE id = ?', (agent_id,)
        ).fetchone()
    return _row(row) if row else None


def default_id() -> str | None:
    """The first agent, for a request that names none."""
    agents = listed()
    return agents[0]['id'] if agents else None


def slug(name: str) -> str:
    """«Агент эквайринга» → «agent-ekvayringa»: an address a person can read."""
    latin = ''.join(LATIN.get(ch, ch) for ch in name.lower())
    return re.sub(r'[^a-z0-9]+', '-', latin).strip('-')[:40].strip('-') or 'agent'


def create(name: str, description: str = '', agent_id: str | None = None) -> dict:
    """A new agent with an empty database of its own; a taken id gets a number."""
    name, description = name.strip(), description.strip()
    if not name:
        raise ValueError('Нужно имя агента')
    base = agent_id or slug(name)
    with _connection() as connection:
        connection.execute('BEGIN IMMEDIATE')
        taken = {row[0] for row in connection.execute('SELECT id FROM agents')}
        chosen, number = base, 2
        while chosen in taken:
            chosen, number = f'{base}-{number}', number + 1
        connection.execute(
            'INSERT INTO agents (id, name, description, created_at) VALUES (?, ?, ?, ?)',
            (chosen, name, description, store.now()),
        )
    db_of(chosen).parent.mkdir(parents=True, exist_ok=True)
    return get(chosen) or {}


@contextmanager
def using(agent_id: str) -> Iterator[None]:
    """Run inside one agent: store reads and writes its database."""
    token = store.AGENT.set(db_of(agent_id))
    try:
        yield
    finally:
        store.AGENT.reset(token)


# The agent that lived alone before agents existed.
FIRST = {'id': 'acquiring', 'name': 'Агент эквайринга', 'description': 'СберБизнес · чат поддержки'}


def _has_data(path: Path) -> bool:
    """A database worth adopting: it holds documents or runs, not just empty tables."""
    connection = sqlite3.connect(path)
    try:
        documents = connection.execute('SELECT count(*) FROM documents').fetchone()[0]
        runs = connection.execute('SELECT count(*) FROM runs').fetchone()[0]
    except sqlite3.OperationalError:
        return False
    finally:
        connection.close()
    return documents + runs > 0


def adopt_legacy() -> None:
    """Before agents, everything lived in one database: it becomes the first agent, once. Nothing is ever overwritten:
    an adopted database already on disk stays (the registry was lost: it is registered again), and the old file is
    renamed to lab.sqlite3.before-agents, or to a dated name if that backup exists. An empty database is not adopted.
    A copy finished on disk precedes the registry entry, so an interrupted start simply repeats the adoption."""
    old = store.DB
    if listed() or not old.exists() or not _has_data(old):
        return
    target = db_of(FIRST['id'])
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(target.name + '.partial')
        source, copy = sqlite3.connect(old), sqlite3.connect(partial)
        try:
            source.backup(copy)  # consistent with a write-ahead log, unlike copying the file
        finally:
            copy.close()
            source.close()
        partial.replace(target)
        target.chmod(0o600)
    create(FIRST['name'], FIRST['description'], agent_id=FIRST['id'])
    backup = old.name + '.before-agents'
    if old.with_name(backup).exists():
        backup += '-' + re.sub(r'[^0-9]', '', store.now())[:14]
    for suffix in ('', '-wal', '-shm'):
        path = old.with_name(old.name + suffix)
        if path.exists():
            path.replace(old.with_name(backup + suffix))

"""The agents this Lab checks. Each agent has its own database, data/agents/<id>/lab.sqlite3: its dialogues, rules,
results and a person's answers never mix with another agent's. The registry itself is data/agents.sqlite3.

A request works inside one agent (api.py sets it from the X-Agent header); `using` does the same for code outside a
request. Without an agent, storage keeps its own default database (tests, the legacy import).
"""

import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .. import config
from . import db

try:
    import fcntl
except ImportError:  # no flock where there is no fcntl (Windows): only_process holds nothing there
    fcntl = None

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
    """Where agents live: the data folder of the Lab's settings, beside the default database, so whatever data folder a
    process (or a test) uses, its agents are there too and never in another one."""
    return config.current().data


def _registry() -> Path:
    return _root() / 'agents.sqlite3'


def db_of(agent_id: str) -> Path:
    return _root() / 'agents' / agent_id / 'lab.sqlite3'


@contextmanager
def _connection() -> Iterator[sqlite3.Connection]:
    path = _registry()
    if db.read_only():  # a reader never creates the registry nor its table (db.reading)
        connection = sqlite3.connect(f'{path.as_uri()}?mode=ro', uri=True, timeout=10)
        try:
            yield connection
        finally:
            connection.close()
        return
    db.private_folder(path.parent)
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
    if db.read_only() and not _registry().is_file():
        return []
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
    """A new agent with an empty database of its own; a taken id made from the name gets a number. An id given
    (agent_id: the adopted first agent, an agent found on disk) is that agent's or nobody's: taken, it is refused,
    never renumbered into a second, empty agent of the same name."""
    name, description = name.strip(), description.strip()
    if not name:
        raise ValueError('Введите имя агента.')
    base = agent_id or slug(name)
    with _connection() as connection:
        connection.execute('BEGIN IMMEDIATE')
        taken = {row[0] for row in connection.execute('SELECT id FROM agents')}
        if agent_id and agent_id in taken:
            raise ValueError(f'Агент «{agent_id}» уже есть.')
        chosen, number = base, 2
        while chosen in taken:
            chosen, number = f'{base}-{number}', number + 1
        connection.execute(
            'INSERT INTO agents (id, name, description, created_at) VALUES (?, ?, ?, ?)',
            (chosen, name, description, db.now()),
        )
    db.private_folder(db_of(chosen).parent)
    return get(chosen) or {}


def update(agent_id: str, name: str, description: str) -> dict:
    """Change the displayed identity without moving its database or breaking links."""
    name, description = name.strip(), description.strip()
    if not name or len(name) > 80 or len(description) > 200:
        raise ValueError('Укажите имя до 80 символов и описание до 200 символов.')
    with _connection() as connection:
        changed = connection.execute(
            'UPDATE agents SET name=?, description=? WHERE id=?', (name, description, agent_id)
        )
        if not changed.rowcount:
            raise LookupError('Агент не найден.')
    return get(agent_id)


def remove(agent_id: str) -> Path | None:
    """The agent out of the registry, then its folder moved to data/deleted/<id>-<time>/: never erased, a person can
    bring it back by hand. A start in between finds the folder and registers the agent again (recover_lost), so nothing
    is lost on the way. Where its data went; None when it had none. LookupError for an agent the Lab does not have."""
    with _connection() as connection:
        if not connection.execute('DELETE FROM agents WHERE id = ?', (agent_id,)).rowcount:
            raise LookupError(agent_id)
    folder = db_of(agent_id).parent
    if not folder.exists():
        return None
    target = _root() / 'deleted' / f'{agent_id}-{re.sub(r"[^0-9]", "", db.now())[:14]}'
    db.private_folder(target.parent)
    folder.replace(target)
    return target


@contextmanager
def using(agent_id: str) -> Iterator[None]:
    """Run inside one agent: storage reads and writes its database."""
    token = db.AGENT.set(db_of(agent_id))
    try:
        yield
    finally:
        db.AGENT.reset(token)


# The agent that lived alone before agents existed.
FIRST = {'id': 'acquiring', 'name': 'Агент эквайринга', 'description': 'СберБизнес · чат поддержки'}


# What an agent's database holds besides empty tables; an older database has only some of these tables.
_DATA = ('documents', 'dialogues', 'runs', 'history')


def _has_data(path: Path) -> bool:
    """A database worth adopting: it holds documents, conversations, runs or saved checks, not just empty tables."""
    connection = sqlite3.connect(path)
    try:
        tables = {name for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        return any(
            connection.execute(f'SELECT 1 FROM {table} LIMIT 1').fetchone() for table in _DATA if table in tables
        )
    except sqlite3.DatabaseError:
        return False
    finally:
        connection.close()


def adopt_legacy() -> None:
    """Before agents, everything lived in one database: it becomes the first agent, once. Nothing is ever overwritten:
    an adopted database already on disk stays (the registry was lost: it is registered again), and the old file is
    renamed to lab.sqlite3.before-agents, or to a dated name if that backup exists. An empty database is not adopted.
    A copy finished on disk precedes the registry entry, so an interrupted start simply repeats the adoption."""
    old = db.default_database()
    if listed() or not old.exists() or not _has_data(old):
        return
    target = db_of(FIRST['id'])
    if not target.exists():
        db.private_folder(target.parent)
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
        backup += '-' + re.sub(r'[^0-9]', '', db.now())[:14]
    for suffix in ('', '-wal', '-shm'):
        path = old.with_name(old.name + suffix)
        if path.exists():
            path.replace(old.with_name(backup + suffix))


def recover_lost() -> list[str]:
    """Agents whose databases are on disk but not in the registry (agents.sqlite3 lost or replaced) are registered
    again, under their id: their names went with the registry (the first agent's is known), their data never goes out
    of reach. An empty database has nothing to recover."""
    folder = _root() / 'agents'
    if not folder.is_dir():
        return []
    known = {agent['id'] for agent in listed()}
    found = []
    for path in sorted(folder.iterdir()):
        database = path / 'lab.sqlite3'
        if path.name in known or not re.fullmatch(r'[a-z0-9-]+', path.name) or not database.is_file():
            continue
        if _has_data(database):
            first = path.name == FIRST['id']
            create(FIRST['name'] if first else path.name, FIRST['description'] if first else '', agent_id=path.name)
            found.append(path.name)
    return found


@contextmanager
def only_process() -> Iterator[None]:
    """One Lab process per data folder. Uvicorn starts the application before it takes its port, so a second start
    (bin/start.sh run twice, a development server beside it) would mark the runs the first one is playing as stopped
    (runs.recover) and adopt the old database twice before failing on the port. The lock goes with the process."""
    if fcntl is None:
        yield
        return
    db.private_folder(_root())
    with open(_root() / 'lab.lock', 'a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise RuntimeError(
                f'Agent Lab уже работает с папкой данных {_root()}. Остановите его или задайте другую LAB_DATA.'
            ) from None
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)

"""Where the database of the current agent is, one connection to it, and transactions.

A process (flows/) holds a transaction around the writes one change of the product makes (transaction); every read and
write inside goes through its connection (connect). Outside one, each call opens its own connection and commits it.
"""

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .. import config
from . import schema

# The database of the agent a request works in (registry.using, app.py); without one, default_database().
AGENT: ContextVar[Path | None] = ContextVar('agent_db', default=None)
# The transaction a process holds open (transaction): its database and its connection.
_HELD: ContextVar[tuple[Path, sqlite3.Connection] | None] = ContextVar('transaction', default=None)


def now() -> str:
    return datetime.now(UTC).isoformat(timespec='milliseconds')


def default_database() -> Path:
    """The database of a Lab without agents (tests, the legacy import), in its data folder, beside the agents."""
    return config.current().data / 'lab.sqlite3'


def database() -> Path:
    """The database the current request or job works in; its folder holds the rest of that agent's files."""
    return AGENT.get() or default_database()


def private_folder(folder: Path) -> None:
    """Create the folder, and the missing ones above it, readable by this user only: they hold the bank's
    conversations, also when the Lab is started without bin/start.sh. A folder that exists keeps its mode."""
    if folder.is_dir():
        return
    for missing in reversed([path for path in (folder, *folder.parents) if not path.exists()]):
        missing.mkdir(mode=0o700, exist_ok=True)


@contextmanager
def transaction() -> Iterator[None]:
    """What is written inside is written together, or none of it: one connection to the current database, BEGIN
    IMMEDIATE, the commit at the end. A process holds it around the writes one change of the product makes, and awaits
    nothing inside: another task's writes wait for it, and its connection stays on its thread."""
    path = database()
    held = _HELD.get()
    if held is not None:
        if held[0] != path:
            raise RuntimeError('A transaction is held in another database')
        yield
        return
    with connect() as connection:
        begin(connection)
        token = _HELD.set((path, connection))
        try:
            yield
        finally:
            _HELD.reset(token)


def begin(connection: sqlite3.Connection) -> None:
    """A write that reads first takes the database at once, unless a transaction holds it already."""
    if not connection.in_transaction:
        connection.execute('BEGIN IMMEDIATE')


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """The connection of the transaction held on this database, else a new one, committed when the block ends. A
    database is set up (schema.set_up) when it is new or of another schema."""
    path = database()
    held = _HELD.get()
    if held is not None and held[0] == path:
        yield held[1]  # the transaction commits or rolls back as a whole
        return
    private_folder(path.parent)
    connection = sqlite3.connect(path, timeout=10)
    try:
        if connection.execute('PRAGMA user_version').fetchone()[0] != schema.SCHEMA:
            schema.set_up(connection, path)
        with connection:
            yield connection
    finally:
        connection.close()


def dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))

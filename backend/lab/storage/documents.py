"""The documents of an agent: its inputs (the agent's code read, the rules of communication), drafts, settings, the deck
and the current result of each check, each one JSON value by its name (domain.checks names most of them). A result is
kept as it was made: the answers people give on it are rows of their own (reviews.py)."""

import json
import sqlite3
from typing import Any

from . import db


def load(name: str, default: Any = None) -> Any:
    with db.connect() as connection:
        row = connection.execute('SELECT value FROM documents WHERE name = ?', (name,)).fetchone()
    return json.loads(row[0]) if row else default


def save(name: str, value: Any) -> None:
    """The document under its name; None keeps the name, set to nothing (a cleared result stays cleared)."""
    with db.connect() as connection:
        put(connection, name, value)


def get(connection: sqlite3.Connection, name: str) -> Any:
    """A document read on a connection the caller holds; None when there is none."""
    row = connection.execute('SELECT value FROM documents WHERE name = ?', (name,)).fetchone()
    return json.loads(row[0]) if row else None


def put(connection: sqlite3.Connection, name: str, value: Any) -> None:
    """A document written on a connection the caller holds."""
    connection.execute(
        'INSERT INTO documents (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
        (name, db.dump(value)),
    )


def exists(name: str) -> bool:
    """Whether a document of this name was ever written, also one set to nothing."""
    with db.connect() as connection:
        return connection.execute('SELECT 1 FROM documents WHERE name = ?', (name,)).fetchone() is not None

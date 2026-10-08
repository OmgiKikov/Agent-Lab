"""The export's conversations, one row each in the export's order, by their ids: a conversation, or the sample of a
check, is read without the rest of the export, and their number is counted without reading any of them. Beside them,
the name of the export's file and when it was uploaded (meta)."""

import json
from collections.abc import Collection

from . import db, documents, schema

META = schema.EXPORT_META
# Conversations read by their ids in one query, under SQLite's limit of variables in one statement.
_CHUNK = 500


def replace(dialogues: list[dict], name: str | None = None) -> None:
    """The new export in place of the previous one, with the name of its file and the time: written together, so the
    meta never names the previous file. In the caller's transaction, if it holds one."""
    with db.connect() as connection:
        db.begin(connection)
        connection.execute('DELETE FROM dialogues')
        connection.executemany(
            'INSERT OR REPLACE INTO dialogues (position, id, value) VALUES (?, ?, ?)',
            ((position, str(dialogue['id']), db.dump(dialogue)) for position, dialogue in enumerate(dialogues, 1)),
        )
        documents.put(connection, META, {'file': name, 'updatedAt': db.now()})


def ids() -> list[str]:
    """The ids of the export's conversations, in the export's order."""
    with db.connect() as connection:
        return [dialogue_id for (dialogue_id,) in connection.execute('SELECT id FROM dialogues ORDER BY position')]


def read(named: Collection[str] | None = None) -> list[dict]:
    """The export's conversations, in its order; only the named ones when ids are given, in the order named."""
    with db.connect() as connection:
        if named is None:
            return [
                json.loads(value) for (value,) in connection.execute('SELECT value FROM dialogues ORDER BY position')
            ]
        wanted = [str(dialogue_id) for dialogue_id in named]
        found: dict[str, dict] = {}
        for start in range(0, len(wanted), _CHUNK):
            part = wanted[start : start + _CHUNK]
            marks = ', '.join('?' for _ in part)
            query = f'SELECT id, value FROM dialogues WHERE id IN ({marks})'
            found.update((dialogue_id, json.loads(value)) for dialogue_id, value in connection.execute(query, part))
    return [found[dialogue_id] for dialogue_id in wanted if dialogue_id in found]


def get(dialogue_id: str) -> dict | None:
    """One conversation of the export, by its id."""
    with db.connect() as connection:
        row = connection.execute('SELECT value FROM dialogues WHERE id = ?', (str(dialogue_id),)).fetchone()
    return json.loads(row[0]) if row else None


def count() -> int:
    """How many conversations the export has, without reading them."""
    with db.connect() as connection:
        return connection.execute('SELECT count(*) FROM dialogues').fetchone()[0]


def page(offset: int, limit: int) -> list[dict]:
    """A bounded page in export order; browsing never loads the entire export."""
    with db.connect() as connection:
        rows = connection.execute('SELECT value FROM dialogues ORDER BY position LIMIT ? OFFSET ?', (limit, offset))
        return [json.loads(value) for (value,) in rows]


def meta() -> dict:
    """The export the conversations came from: its file name and when it was uploaded, when that is known."""
    return documents.load(META) or {'file': None, 'updatedAt': None}


def uploaded() -> bool:
    """Whether an export was ever uploaded, also one with no conversation: its meta is written with it."""
    return documents.exists(META)

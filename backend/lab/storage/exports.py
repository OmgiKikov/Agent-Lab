"""The exports of real conversations: every upload is an export of its own, with its name (the file's by default, a
person may change it), the file, when it was uploaded, how many conversations it has and how many of the file's could
not be read (skipped). Its conversations are rows (dialogues), one each by (export, id) in the export's order: the same
conversation may be in two exports. A conversation, or the sample of a check, is read without the rest of its export,
and an export's conversations are counted without reading them. What an export changes is decided in flows/
(inputs.add_export, inputs.remove_export)."""

import json
import uuid
from collections.abc import Collection

from . import db

# Conversations read by their ids in one query, under SQLite's limit of variables in one statement.
_CHUNK = 500
_COLUMNS = 'id, name, file, uploaded_at, total, skipped'


def _line(row: tuple) -> dict:
    export_id, name, file, uploaded_at, total, skipped = row
    return {'id': export_id, 'name': name, 'file': file, 'uploadedAt': uploaded_at, 'total': total, 'skipped': skipped}


def name_of(file: str | None) -> str:
    """The name an export gets unless a person gives one: its file's, without the folders and the extension."""
    stem = (file or '').replace('\\', '/').rsplit('/', 1)[-1]
    stem = stem.rsplit('.', 1)[0] if '.' in stem else stem
    return stem.strip() or 'Выгрузка'


def line(export: dict) -> dict:
    """What a result and a saved check keep of the export they were made of: its name may change and it may go."""
    return {key: export.get(key) for key in ('id', 'name', 'file', 'total')}


def add(dialogues: list[dict], file: str | None, name: str | None = None, skipped: int = 0) -> dict:
    """A new export with its conversations, written together; in the caller's transaction, if it holds one. A
    conversation the file repeats is kept once, at its last place."""
    export_id = uuid.uuid4().hex[:12]
    with db.connect() as connection:
        db.begin(connection)
        connection.executemany(
            'INSERT OR REPLACE INTO dialogues (export, position, id, value) VALUES (?, ?, ?, ?)',
            ((export_id, position, str(d['id']), db.dump(d)) for position, d in enumerate(dialogues, 1)),
        )
        total = connection.execute('SELECT count(*) FROM dialogues WHERE export = ?', (export_id,)).fetchone()[0]
        at = db.now()
        connection.execute(
            f'INSERT INTO exports ({_COLUMNS}, stamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
            (export_id, (name or '').strip() or name_of(file), file, at, total, skipped, at),
        )
        row = connection.execute(f'SELECT {_COLUMNS} FROM exports WHERE id = ?', (export_id,)).fetchone()
    return _line(row)


def listed() -> list[dict]:
    """The exports, the newest first."""
    with db.connect() as connection:
        return [_line(row) for row in connection.execute(f'SELECT {_COLUMNS} FROM exports ORDER BY rowid DESC')]


def get(export_id: str | None) -> dict | None:
    if not export_id:
        return None
    with db.connect() as connection:
        row = connection.execute(f'SELECT {_COLUMNS} FROM exports WHERE id = ?', (export_id,)).fetchone()
    return _line(row) if row else None


def newest() -> dict | None:
    with db.connect() as connection:
        row = connection.execute(f'SELECT {_COLUMNS} FROM exports ORDER BY rowid DESC LIMIT 1').fetchone()
    return _line(row) if row else None


def stamp(export_id: str) -> str | None:
    """When the export came, as the fingerprint of a check of it says it: the time of its upload; for the one export
    of an older database, the time that database kept (None when it kept none), so a check stopped before is the same
    work after."""
    with db.connect() as connection:
        row = connection.execute('SELECT stamp FROM exports WHERE id = ?', (export_id,)).fetchone()
    return row[0] if row else None


def uploaded() -> bool:
    """Whether an export with a conversation to check was uploaded."""
    with db.connect() as connection:
        return connection.execute('SELECT 1 FROM exports WHERE total > 0 LIMIT 1').fetchone() is not None


def rename(export_id: str, name: str) -> dict | None:
    """The export under a new name; None when there is no such export."""
    with db.connect() as connection:
        connection.execute('UPDATE exports SET name = ? WHERE id = ?', (name.strip(), export_id))
    return get(export_id)


def remove(export_id: str) -> dict | None:
    """The export and its conversations, gone together; in the caller's transaction, if it holds one. The export as
    it was, None when there was none."""
    with db.connect() as connection:
        db.begin(connection)
        row = connection.execute(f'SELECT {_COLUMNS} FROM exports WHERE id = ?', (export_id,)).fetchone()
        if row is None:
            return None
        connection.execute('DELETE FROM dialogues WHERE export = ?', (export_id,))
        connection.execute('DELETE FROM exports WHERE id = ?', (export_id,))
    return _line(row)


def ids(export_id: str) -> list[str]:
    """The ids of an export's conversations, in its order."""
    with db.connect() as connection:
        query = 'SELECT id FROM dialogues WHERE export = ? ORDER BY position'
        return [dialogue_id for (dialogue_id,) in connection.execute(query, (export_id,))]


def read(export_id: str, named: Collection[str] | None = None) -> list[dict]:
    """An export's conversations in its order; only the named ones when ids are given, in the order named."""
    with db.connect() as connection:
        if named is None:
            query = 'SELECT value FROM dialogues WHERE export = ? ORDER BY position'
            return [json.loads(value) for (value,) in connection.execute(query, (export_id,))]
        wanted = [str(dialogue_id) for dialogue_id in named]
        found: dict[str, dict] = {}
        for start in range(0, len(wanted), _CHUNK):
            part = wanted[start : start + _CHUNK]
            marks = ', '.join('?' for _ in part)
            query = f'SELECT id, value FROM dialogues WHERE export = ? AND id IN ({marks})'
            found.update(
                (dialogue_id, json.loads(value)) for dialogue_id, value in connection.execute(query, (export_id, *part))
            )
    return [found[dialogue_id] for dialogue_id in wanted if dialogue_id in found]


def conversation(export_id: str | None, dialogue_id: str) -> dict | None:
    """One conversation of an export, by its id; None when the export or the conversation is not there."""
    if not export_id:
        return None
    with db.connect() as connection:
        row = connection.execute(
            'SELECT value FROM dialogues WHERE export = ? AND id = ?', (export_id, str(dialogue_id))
        ).fetchone()
    return json.loads(row[0]) if row else None

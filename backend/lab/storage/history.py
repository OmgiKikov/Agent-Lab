"""The saved checks of both checks of the real conversations, in one table: each finished check's line of the list
(its summary) and its whole record, the evidence behind it, which never changes (domain.accuracy.saved,
domain.tone.snapshot). The answers people give on a saved check are rows of their own (reviews.py)."""

import json

from . import db


def save(kind: str, record: dict) -> None:
    """A finished check of one kind (domain.checks: tone or code) in the history; a check saved already is an
    IntegrityError, never a second line."""
    with db.connect() as connection:
        connection.execute(
            'INSERT INTO history (id, kind, summary, value) VALUES (?, ?, ?, ?)',
            (record['check']['id'], kind, db.dump(record['check']), db.dump(record)),
        )


def lines(kind: str) -> list[dict]:
    """The saved checks of one kind, the newest first: their lines."""
    with db.connect() as connection:
        rows = connection.execute('SELECT summary FROM history WHERE kind = ? ORDER BY rowid DESC', (kind,))
        return [json.loads(summary) for (summary,) in rows]


def latest(kind: str) -> dict | None:
    """The line of the newest saved check of one kind."""
    with db.connect() as connection:
        row = connection.execute(
            'SELECT summary FROM history WHERE kind = ? ORDER BY rowid DESC LIMIT 1', (kind,)
        ).fetchone()
    return json.loads(row[0]) if row else None


def get(kind: str, check_id: str) -> dict | None:
    """The whole record of a saved check of this kind; None for another kind's."""
    with db.connect() as connection:
        row = connection.execute('SELECT value FROM history WHERE id = ? AND kind = ?', (check_id, kind)).fetchone()
    return json.loads(row[0]) if row else None

"""Grouped launches and recorded-question runs, stored apart from legacy synthetic-client runs."""

import json

from . import db


def save(kind: str, record: dict) -> None:
    summary = {key: value for key, value in record.items() if key not in ('items', 'inputs')}
    with db.connect() as connection:
        connection.execute(
            'INSERT INTO launches(id,kind,summary,value) VALUES(?,?,?,?) '
            'ON CONFLICT(id) DO UPDATE SET summary=excluded.summary,value=excluded.value',
            (record['id'], kind, db.dump(summary), db.dump(record)),
        )


def get(kind: str, record_id: str) -> dict | None:
    with db.connect() as connection:
        row = connection.execute('SELECT value FROM launches WHERE kind=? AND id=?', (kind, record_id)).fetchone()
    return json.loads(row[0]) if row else None


def listed(kind: str) -> list[dict]:
    with db.connect() as connection:
        rows = connection.execute('SELECT summary FROM launches WHERE kind=? ORDER BY rowid DESC', (kind,))
        return [json.loads(row[0]) for row in rows]

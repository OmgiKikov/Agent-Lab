"""The checks of the live agent on the same customers (domain.replay): each record with its conversations, the recorded
and the played ones with their verdicts, and beside it its summary without them, for the screens that list them. A
record is created once and patched in one transaction, never replaced; its summary of the pairs is counted again with
every write (domain.replay.summarize)."""

import json
import sqlite3
from typing import Any

from ..domain import replay
from . import db, tasks

# What only this module writes: a caller patches a record's own fields and its conversations, never these.
_OWN = {'id', 'items', 'summary', 'revision', 'updatedAt'}
STOPPED = 'Проверка остановилась вместе с сервисом.'


def create(record: dict) -> dict:
    """Insert a check once; later writes patch it."""
    value = dict(record, revision=1, updatedAt=db.now(), summary=replay.summarize(record))
    with db.transaction(), db.connect() as connection:
        connection.execute(
            'INSERT INTO replays (id, value, summary) VALUES (?, ?, ?)', (value['id'], db.dump(value), _summary(value))
        )
    return value


def get(replay_id: str) -> dict | None:
    with db.connect() as connection:
        return _record(connection, replay_id)


def summaries() -> list[dict]:
    """Every check without its conversations, the newest first: a list never parses a conversation."""
    with db.connect() as connection:
        rows = connection.execute('SELECT summary FROM replays').fetchall()
    found = [json.loads(raw) for (raw,) in rows]
    return sorted(found, key=lambda summary: summary.get('startedAt', ''), reverse=True)


def update(replay_id: str, **fields: Any) -> dict:
    """The check's own fields (the agent's version, its status…), never its conversations."""
    return update_items(replay_id, {}, **fields)


def update_items(replay_id: str, patches: dict[int, dict], **fields: Any) -> dict:
    """Patch several conversations, and the check's own fields, in one transaction. The check as it stands after."""
    if _OWN & fields.keys():
        raise ValueError('Replay items and metadata must be updated through their own operation')
    with db.transaction(), db.connect() as connection:
        record = _record(connection, replay_id)
        if record is None:
            raise KeyError(replay_id)
        for index, patch in patches.items():
            record['items'][index] = record['items'][index] | patch
        record.update(fields)
        _save(connection, record)
    return record


def recover() -> int:
    """On the start of the process, the checks the one before it left running with no task to continue them are
    stopped: their worker is gone. One whose task the process took up again (jobs.recover) goes on."""
    recovered = 0
    continued = {task['id'] for task in tasks.running()}
    with db.transaction(), db.connect() as connection:
        for (raw,) in connection.execute('SELECT value FROM replays').fetchall():
            record = json.loads(raw)
            if record.get('status') != 'running' or record['id'] in continued:
                continue
            record.update(status='stopped', error=STOPPED, finishedAt=db.now())
            for item in record['items']:
                if item.get('status') == 'RUNNING':
                    item.update(status='UNMEASURED', stage='', error=STOPPED)
            _save(connection, record)
            recovered += 1
    return recovered


def _record(connection: sqlite3.Connection, replay_id: str) -> dict | None:
    row = connection.execute('SELECT value FROM replays WHERE id = ?', (replay_id,)).fetchone()
    return json.loads(row[0]) if row else None


def _save(connection: sqlite3.Connection, record: dict) -> None:
    """A changed check, with its summary counted again and its revision one more: the screens fetch it again by
    those."""
    record.update(summary=replay.summarize(record), updatedAt=db.now(), revision=record.get('revision', 0) + 1)
    connection.execute(
        'UPDATE replays SET value = ?, summary = ? WHERE id = ?', (db.dump(record), _summary(record), record['id'])
    )


def _summary(record: dict) -> str:
    """The check without its conversations: how many there are, and how many are done."""
    items = record.get('items') or []
    done = sum(1 for item in items if item.get('status') != 'RUNNING')
    return db.dump({key: value for key, value in record.items() if key != 'items'} | {'size': len(items), 'done': done})

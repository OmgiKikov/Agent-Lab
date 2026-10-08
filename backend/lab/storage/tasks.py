"""The long work of an agent, kept in its database: what was started and with what (input), how far it got (progress),
the parts of it already done (steps) and how it ended. Nothing of a task lives only in memory: a screen reads it here,
and a process that dies leaves its task running for the next one to continue (jobs.recover).

A step is one finished part of the work, kept as soon as it is done: a conversation judged, the topics planned. The
first value kept under a key stays (keep), so a part done twice keeps its first result. A task that ends done needs its
steps no more; a stopped or failed one keeps them, and the same work started again (an equal fingerprint) continues it
instead of paying for them again (begin). Only the latest task of a kind, or of a line of work of the kind (begin),
can be continued: starting other work of the same line lets the steps of the earlier ones go.

The only module that knows the tables of tasks: where long work is kept can change here alone.
"""

import json
import sqlite3
import uuid
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from . import db

RUNNING, DONE, FAILED, STOPPED = 'running', 'done', 'failed', 'stopped'
# Restarts in a row that found no new step before the task is given up (resume): work that kills the process each
# time it runs must not run forever.
STALLED = 3
_FIELDS = (
    'id, kind, status, input, fingerprint, progress, error, created_at, started_at, finished_at, resumed, '
    '(SELECT count(*) FROM steps WHERE task_id = tasks.id)'
)


class Busy(Exception):
    """Another task of the agent is running."""


@dataclass
class Current:
    """The task the code runs in (jobs): its id, and whether the Lab is closing under it, which a stop is not."""

    id: str
    closing: bool = False


CURRENT: ContextVar[Current | None] = ContextVar('task', default=None)


def begin(
    kind: str,
    given: dict,
    fingerprint: str | None = None,
    task_id: str | None = None,
    line: Callable[[dict], object] | None = None,
) -> dict:
    """A task running from now: the latest task of the kind when it stopped or failed doing the same work (an equal
    fingerprint), with the steps it kept (continued), else a new one. Busy while another task runs. line: what parts
    a kind into lines of work that never stand for each other (a launch of tone of voice and one of Точность; one
    that checks the recorded answers and one that only asks the agent): only the latest task of the same line is
    continued, and only its line's earlier steps go."""
    with db.transaction(), db.connect() as connection:
        if connection.execute('SELECT 1 FROM tasks WHERE status = ?', (RUNNING,)).fetchone():
            raise Busy
        at = db.now()
        same = [task for task in _of(connection, kind) if line is None or line(task['input']) == line(given)]
        latest = same[0] if same else None
        if fingerprint and latest and latest['status'] in (STOPPED, FAILED) and latest['fingerprint'] == fingerprint:
            connection.execute(
                'UPDATE tasks SET status = ?, input = ?, progress = ?, error = NULL, started_at = ?, updated_at = ?, '
                'finished_at = NULL, resumed = 0, stalled = 0, steps_at_resume = NULL WHERE id = ?',
                (RUNNING, db.dump(given), '{}', at, at, latest['id']),
            )
            return _get(connection, latest['id']) | {'continued': True}
        connection.executemany(
            'DELETE FROM steps WHERE task_id = ?', [(task['id'],) for task in same if task['status'] != RUNNING]
        )
        new_id = task_id or uuid.uuid4().hex
        connection.execute(
            'INSERT INTO tasks (id, kind, status, input, fingerprint, progress, created_at, started_at, updated_at) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (new_id, kind, RUNNING, db.dump(given), fingerprint, '{}', at, at, at),
        )
        return _get(connection, new_id) | {'continued': False}


def get(task_id: str) -> dict | None:
    with db.connect() as connection:
        return _get(connection, task_id)


def latest(kind: str | None = None) -> dict | None:
    """The task started last, of a kind or of any: what the screens show."""
    with db.connect() as connection:
        return _latest(connection, kind)


def running() -> list[dict]:
    """The tasks left running: one while the Lab works, and at its start those a process before it left."""
    with db.connect() as connection:
        rows = connection.execute(f'SELECT {_FIELDS} FROM tasks WHERE status = ?', (RUNNING,)).fetchall()
    return [_task(row) for row in rows]


def report(task_id: str, progress: dict) -> None:
    """How far a running task got, as its screen shows it."""
    with db.connect() as connection:
        connection.execute(
            'UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ? AND status = ?',
            (db.dump(progress), db.now(), task_id, RUNNING),
        )


def end(task_id: str, status: str, error: str | None = None, progress: dict | None = None) -> None:
    """How a task ended, with its last progress. Done, it needs its steps no more: what they held is in its result."""
    with db.transaction(), db.connect() as connection:
        at = db.now()
        connection.execute(
            'UPDATE tasks SET status = ?, error = ?, progress = coalesce(?, progress), finished_at = ?, updated_at = ? '
            'WHERE id = ?',
            (status, error, None if progress is None else db.dump(progress), at, at, task_id),
        )
        if status == DONE:
            connection.execute('DELETE FROM steps WHERE task_id = ?', (task_id,))


def resume(task_id: str) -> bool:
    """A task a process before this one left running, taken up again: counted, and given up (False) after STALLED
    restarts in a row that found no new step. Every kind that takes long keeps a step for each part it finishes, so a
    task that goes on between restarts is never given up."""
    with db.transaction(), db.connect() as connection:
        steps = connection.execute('SELECT count(*) FROM steps WHERE task_id = ?', (task_id,)).fetchone()[0]
        connection.execute(
            'UPDATE tasks SET resumed = resumed + 1, stalled = CASE WHEN ? = steps_at_resume THEN stalled + 1 ELSE 0 '
            'END, steps_at_resume = ?, updated_at = ? WHERE id = ?',
            (steps, steps, db.now(), task_id),
        )
        stalled = connection.execute('SELECT stalled FROM tasks WHERE id = ?', (task_id,)).fetchone()[0]
    return stalled < STALLED


def steps() -> dict[str, Any]:
    """The steps the current task kept, by key: none outside a task."""
    current = CURRENT.get()
    if current is None:
        return {}
    with db.connect() as connection:
        rows = connection.execute('SELECT key, value FROM steps WHERE task_id = ?', (current.id,)).fetchall()
    return {key: json.loads(value) for key, value in rows}


def keep(key: str, value: Any) -> Any:
    """A finished part of the current task, kept at once; the value kept first under the key stays and is returned.
    Outside a task nothing is kept."""
    current = CURRENT.get()
    if current is None:
        return value
    with db.connect() as connection:
        connection.execute(
            'INSERT OR IGNORE INTO steps (task_id, key, value, at) VALUES (?, ?, ?, ?)',
            (current.id, key, db.dump(value), db.now()),
        )
        row = connection.execute('SELECT value FROM steps WHERE task_id = ? AND key = ?', (current.id, key)).fetchone()
    return json.loads(row[0])


def current_id() -> str | None:
    """The id of the task the code runs in; a check or a run made by a task takes it as its own."""
    current = CURRENT.get()
    return None if current is None else current.id


def closing() -> bool:
    """Whether the Lab is closing under the current task: its work stops, and the task stays running for the next
    process, so nothing may be written as stopped."""
    current = CURRENT.get()
    return current is not None and current.closing


def of_kind(kind: str) -> list[dict]:
    """The tasks of a kind, the latest first."""
    with db.connect() as connection:
        return _of(connection, kind)


def _of(connection: sqlite3.Connection, kind: str) -> list[dict]:
    rows = connection.execute(
        f'SELECT {_FIELDS} FROM tasks WHERE kind = ? ORDER BY started_at DESC, rowid DESC', (kind,)
    ).fetchall()
    return [_task(row) for row in rows]


def _latest(connection: sqlite3.Connection, kind: str | None) -> dict | None:
    where, values = ('WHERE kind = ?', (kind,)) if kind else ('', ())
    row = connection.execute(
        f'SELECT {_FIELDS} FROM tasks {where} ORDER BY started_at DESC, rowid DESC LIMIT 1', values
    ).fetchone()
    return None if row is None else _task(row)


def _get(connection: sqlite3.Connection, task_id: str) -> dict | None:
    row = connection.execute(f'SELECT {_FIELDS} FROM tasks WHERE id = ?', (task_id,)).fetchone()
    return None if row is None else _task(row)


def _task(row: tuple) -> dict:
    keys = (
        'id', 'kind', 'status', 'input', 'fingerprint', 'progress', 'error', 'createdAt', 'startedAt', 'finishedAt',
        'resumed', 'kept',
    )  # fmt: skip
    task = dict(zip(keys, row, strict=True))
    task['input'], task['progress'] = json.loads(task['input']), json.loads(task['progress'])
    return task

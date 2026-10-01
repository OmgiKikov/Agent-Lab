"""Local SQLite persistence. Run mutations read and patch the current record in one transaction."""

import json
import sqlite3
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

from .metric import metric
from .settings import DATA

DB = DATA / 'lab.sqlite3'


def now() -> str:
    return datetime.now(UTC).isoformat(timespec='milliseconds')


@contextmanager
def _connection() -> Iterator[sqlite3.Connection]:
    DB.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB, timeout=10)
    try:
        DB.chmod(0o600)
        connection.execute('CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, value TEXT NOT NULL)')
        connection.execute('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
        with connection:
            yield connection
    finally:
        connection.close()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def load(name: str, default: Any = None) -> Any:
    with _connection() as connection:
        row = connection.execute('SELECT value FROM documents WHERE name = ?', (name,)).fetchone()
    return json.loads(row[0]) if row else default


def save(name: str, value: Any) -> None:
    with _connection() as connection:
        connection.execute(
            'INSERT INTO documents (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
            (name, _json(value)),
        )


def update(name: str, mutate: Callable[[Any], None]) -> Any:
    """Read, change and write one document in a single transaction, so concurrent writers do not lose changes."""
    with _connection() as connection:
        connection.execute('BEGIN IMMEDIATE')
        row = connection.execute('SELECT value FROM documents WHERE name = ?', (name,)).fetchone()
        if row is None:
            raise KeyError(name)
        value = json.loads(row[0])
        mutate(value)
        connection.execute('UPDATE documents SET value = ? WHERE name = ?', (_json(value), name))
    return value


def replace_inputs(name: str, value: Any) -> None:
    """Replace sources or logs together with invalidation of their derived audit and scenarios."""
    if name not in ('sources.json', 'logs.json'):
        raise ValueError('Only source and log documents are inputs')
    with _connection() as connection:
        connection.execute('BEGIN IMMEDIATE')
        connection.execute(
            'INSERT INTO documents (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
            (name, _json(value)),
        )
        # Keep the names: a repeated legacy import must not resurrect intentionally cleared results.
        connection.executemany(
            'INSERT INTO documents (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
            [('discover.json', 'null'), ('cards.json', 'null'), ('tone-of-voice-criteria.json', 'null')],
        )


def runs() -> list[dict]:
    with _connection() as connection:
        records = [json.loads(row[0]) for row in connection.execute('SELECT value FROM runs')]
    return sorted(records, key=lambda record: record.get('startedAt', ''), reverse=True)


def run(run_id: str) -> dict | None:
    with _connection() as connection:
        row = connection.execute('SELECT value FROM runs WHERE id = ?', (run_id,)).fetchone()
    return json.loads(row[0]) if row else None


def create_run(record: dict) -> dict:
    """Insert a run once. Subsequent writes must patch it, never replace a snapshot."""
    value = dict(record, revision=1, updatedAt=now(), metric=metric(record['items']))
    with _connection() as connection:
        connection.execute('INSERT INTO runs (id, value) VALUES (?, ?)', (value['id'], _json(value)))
    return value


def _mutate_run(run_id: str, mutate: Callable[[dict], None]) -> dict:
    with _connection() as connection:
        connection.execute('BEGIN IMMEDIATE')
        row = connection.execute('SELECT value FROM runs WHERE id = ?', (run_id,)).fetchone()
        if row is None:
            raise KeyError(run_id)
        record = json.loads(row[0])
        mutate(record)
        record.update(metric=metric(record['items']), updatedAt=now(), revision=record.get('revision', 0) + 1)
        connection.execute('UPDATE runs SET value = ? WHERE id = ?', (_json(record), run_id))
    return record


def update_run(run_id: str, **fields: Any) -> dict:
    if {'id', 'items', 'metric', 'revision', 'updatedAt'} & fields.keys():
        raise ValueError('Run items and metadata must be updated through their own operation')
    return _mutate_run(run_id, lambda record: record.update(fields))


def _rule_reviews(rows: list[dict] | None) -> dict[str, tuple[str | None, str]]:
    return {
        row['ruleId']: (row.get('status'), row['review'])
        for row in rows or []
        if row.get('ruleId') and row.get('review') in ('agree', 'disagree')
    }


def _without_reviews(rows: list[dict] | None) -> list[dict]:
    return [{key: value for key, value in row.items() if key != 'review'} for row in rows or []]


def update_item(run_id: str, index: int, fields: dict) -> dict:
    """Keep human confirmation through progress, but never attach it to a changed judgment.

    A decision on the whole conversation is dropped when its status or verdicts change. A decision on one criterion
    belongs to the person, not to the producer's copy: it stays with that criterion while its verdict is the same."""
    patch = {key: value for key, value in fields.items() if key != 'review'}

    def mutate(record: dict) -> None:
        item = record['items'][index]
        changed = ('status' in patch and patch['status'] != item.get('status')) or (
            'rules' in patch and _without_reviews(patch['rules']) != _without_reviews(item.get('rules'))
        )
        kept = _rule_reviews(item.get('rules'))
        item.update(patch)
        if 'rules' in patch:
            rows = []
            for row in _without_reviews(patch['rules']):
                status, decision = kept.get(row.get('ruleId'), (None, None))
                if decision and status == row.get('status'):
                    row['review'] = decision
                rows.append(row)
            item['rules'] = rows
        if changed:
            item['review'] = None

    return _mutate_run(run_id, mutate)


def _decision(decision: str | None) -> str | None:
    if decision not in ('agree', 'disagree', None):
        raise ValueError('decision: agree | disagree | null')
    return decision


def set_review(run_id: str, index: int, decision: str | None, rule_id: str | None = None) -> dict:
    """A person's decision on a simulated conversation: on one criterion's verdict, or (older requests) on the whole."""
    _decision(decision)
    if isinstance(index, bool) or not isinstance(index, int) or index < 0:
        raise IndexError(index)

    def mutate(record: dict) -> None:
        item = record['items'][index]
        if not rule_id:
            item['review'] = decision
            return
        row = next((row for row in item.get('rules') or [] if row.get('ruleId') == rule_id), None)
        if row is None:
            raise KeyError(rule_id)
        row['review'] = decision

    return _mutate_run(run_id, mutate)


def set_log_review(analysis: str, dialogue_id: str, rule_id: str, decision: str | None) -> None:
    """A person's decision on one criterion's verdict in a logged conversation, kept in the log assessment."""
    _decision(decision)

    def mutate(value: dict | None) -> None:
        result = next((r for r in (value or {}).get('results') or [] if str(r.get('dialogueId')) == dialogue_id), None)
        row = next((row for row in (result or {}).get('rules') or [] if row.get('ruleId') == rule_id), None)
        if row is None:
            raise KeyError(rule_id)
        row['review'] = decision

    update(analysis, mutate)


def recover_runs() -> int:
    """On process startup, finish interrupted runs whose worker no longer exists."""
    recovered = 0
    with _connection() as connection:
        connection.execute('BEGIN IMMEDIATE')
        for (raw,) in connection.execute('SELECT value FROM runs').fetchall():
            record = json.loads(raw)
            if record.get('status') != 'running':
                continue
            error = 'Прогон прерван при завершении процесса'
            record.update(status='stopped', error=error, finishedAt=now())
            for item in record['items']:
                if item.get('status') == 'RUNNING':
                    item.update(status='UNMEASURED', stage='', error=error)
            record.update(metric=metric(record['items']), updatedAt=now(), revision=record.get('revision', 0) + 1)
            connection.execute('UPDATE runs SET value = ? WHERE id = ?', (_json(record), record['id']))
            recovered += 1
    return recovered


def import_legacy(documents: dict[str, Any], records: list[dict]) -> dict[str, int]:
    """Repeatable migration: existing data wins, including newer human reviews."""
    counts = {'documents': 0, 'runs': 0}
    with _connection() as connection:
        connection.execute('BEGIN IMMEDIATE')
        for name, value in documents.items():
            counts['documents'] += connection.execute(
                'INSERT OR IGNORE INTO documents (name, value) VALUES (?, ?)', (name, _json(value))
            ).rowcount
        for record in records:
            value = dict(record)
            value.setdefault('revision', 1)
            value.setdefault('updatedAt', value.get('finishedAt') or value.get('startedAt') or now())
            counts['runs'] += connection.execute(
                'INSERT OR IGNORE INTO runs (id, value) VALUES (?, ?)', (value['id'], _json(value))
            ).rowcount
    return counts

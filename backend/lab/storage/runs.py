"""The runs of the deck's scenarios: each record with its conversations and verdicts, and beside it its summary without
them, for the list of runs. A record is created once and patched in one transaction, never replaced. The answers people
give on its verdicts are rows of their own (reviews.py), laid on the record when it is read (domain.answers.on_run); a
patch that changes a verdict takes back the answer given on it (domain.answers.withdrawn)."""

import json
import sqlite3
from typing import Any

from ..domain import answers, checks
from ..domain.metric import metric
from . import db, reviews

# What only this module writes: a caller patches a run's own fields and its conversations, never these.
_OWN = {'id', 'items', 'metric', 'revision', 'updatedAt'}


def listed() -> list[dict]:
    """Every run with its conversations and the answers on them, the newest first."""
    with db.connect() as connection:
        records = [json.loads(value) for (value,) in connection.execute('SELECT value FROM runs')]
    given = reviews.by_record(answers.SIM)
    found = [answers.on_run(record, given.get(record['id'], {})) for record in records]
    return sorted(found, key=lambda record: record.get('startedAt', ''), reverse=True)


def summaries() -> list[dict]:
    """Every run without its conversations, the newest first: a list of runs never parses a conversation. Its metric
    counts the answers given on it (human)."""
    with db.connect() as connection:
        # A row an older Lab wrote after the setup has no summary yet: its record stands in.
        rows = connection.execute('SELECT coalesce(summary, value) FROM runs').fetchall()
    given = reviews.by_record(answers.SIM)
    found = []
    for (raw,) in rows:
        summary = _summarized(json.loads(raw))
        found.append(answers.counted(summary, given.get(summary.get('id'), {})))
    return sorted(found, key=lambda summary: summary.get('startedAt', ''), reverse=True)


def get(run_id: str) -> dict | None:
    """One run with its conversations and the answers on them."""
    with db.connect() as connection:
        record = _record(connection, run_id)
    return None if record is None else answers.on_run(record, reviews.visible(answers.SIM, run_id))


def create(record: dict) -> dict:
    """Insert a run once. Later writes patch it, never replace it. Answers it comes with (an older record) are rows of
    their own, as every answer. The run as it stands, with them."""
    kept, taken = answers.taken_from_run(record)
    value = dict(kept, check=checks.of_run(kept), revision=1, updatedAt=db.now(), metric=metric(kept['items']))
    with db.transaction(), db.connect() as connection:
        connection.execute(
            'INSERT INTO runs (id, value, summary) VALUES (?, ?, ?)', (value['id'], db.dump(value), _summary(value))
        )
        reviews.add(connection, answers.SIM, value['id'], taken, reviews.PERSON, None)
    if not taken:
        return value
    return answers.on_run(value, {(answer['conversation'], answer['rule']): answer for answer in taken})


def update(run_id: str, **fields: Any) -> dict:
    """The run's own fields (its version, its status…), never its conversations or what this module keeps."""
    return update_items(run_id, {}, **fields)


def update_item(run_id: str, index: int, fields: dict) -> dict:
    return update_items(run_id, {index: fields})


def update_items(run_id: str, patches: dict[int, dict], **fields: Any) -> dict:
    """Patch several conversations, and the run's own fields, in one transaction: a re-judged run changes at once. A
    patch that changes a verdict takes back the answer given on it, in the same transaction. The run as it stands
    after, with the answers on it."""
    if _OWN & fields.keys():
        raise ValueError('Run items and metadata must be updated through their own operation')
    with db.transaction(), db.connect() as connection:
        record = _record(connection, run_id)
        if record is None:
            raise KeyError(run_id)
        given = reviews.visible(answers.SIM, run_id)
        taken_back = []
        for index, patch in patches.items():
            before = record['items'][index]
            after = before | answers.bare(patch)
            on_it = {rule: answer for (talk, rule), answer in given.items() if talk == str(index)}
            for rule_id in answers.withdrawn(before, after, on_it):
                verdict = next((row for row in after.get('rules') or [] if row.get('ruleId') == rule_id), None)
                answer = answers.found(str(index), rule_id, None, verdict or after, after.get('judgeVersion'))
                taken_back.append(answer)
                given[(str(index), rule_id)] = {**given[(str(index), rule_id)], 'decision': None}
            record['items'][index] = after
        record.update(fields)
        _save(connection, record)
        reviews.add(connection, answers.SIM, run_id, taken_back, reviews.LAB, None)
    return answers.on_run(record, given)


def recover() -> int:
    """On the start of the process, the runs the one before it left running are stopped: their worker is gone."""
    recovered = 0
    error = 'Прогон остановился вместе с сервисом.'
    with db.transaction(), db.connect() as connection:
        for (raw,) in connection.execute('SELECT value FROM runs').fetchall():
            record = json.loads(raw)
            if record.get('status') != 'running':
                continue
            record.update(status='stopped', error=error, finishedAt=db.now())
            for item in record['items']:
                if item.get('status') == 'RUNNING':
                    item.update(status='UNMEASURED', stage='', error=error)
            _save(connection, record)
            recovered += 1
    return recovered


def _record(connection: sqlite3.Connection, run_id: str) -> dict | None:
    row = connection.execute('SELECT value FROM runs WHERE id = ?', (run_id,)).fetchone()
    return json.loads(row[0]) if row else None


def _save(connection: sqlite3.Connection, record: dict) -> None:
    """A changed run, with its metric counted again and its revision one more: the screens fetch it again by those."""
    record.update(metric=metric(record['items']), updatedAt=db.now(), revision=record.get('revision', 0) + 1)
    connection.execute(
        'UPDATE runs SET value = ?, summary = ? WHERE id = ?', (db.dump(record), _summary(record), record['id'])
    )


def _summarized(record: dict) -> dict:
    """The run without its conversations, always with its check (checks.of_run: an older record names none)."""
    return {key: value for key, value in record.items() if key != 'items'} | {'check': checks.of_run(record)}


def _summary(record: dict) -> str:
    return db.dump(_summarized(record))


def insert_if_new(connection: sqlite3.Connection, record: dict) -> int:
    """A run of an older Lab's files (legacy.py), inserted as it is unless the database has it already: 1 when it was
    inserted. Its answers are brought out of it with the rest of the import (schema.upgrade)."""
    value = dict(record)
    value.setdefault('check', checks.of_run(value))
    value.setdefault('revision', 1)
    value.setdefault('updatedAt', value.get('finishedAt') or value.get('startedAt') or db.now())
    return connection.execute(
        'INSERT OR IGNORE INTO runs (id, value, summary) VALUES (?, ?, ?)',
        (value['id'], db.dump(value), _summary(value)),
    ).rowcount

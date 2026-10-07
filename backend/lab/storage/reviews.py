"""The answers people gave on the judge's verdicts, one row each, kept as a journal: the visible answer on a case is
its latest row (domain.answers names the cases). A person's answer (author person) is written as they give it; the Lab
writes one (author lab) when it carries an answer to a new check whose verdict did not change, and takes one back (no
decision) when a run judged again changed the verdict it was given on. Each row keeps that verdict: its status, the
agent's words it quoted and the version of the judge's instructions that gave it."""

import sqlite3
from collections.abc import Iterable

from ..domain.answers import DECISIONS, LOG
from . import db, schema

PERSON, LAB = schema.PERSON, schema.LAB
_FIELDS = 'conversation, rule_id, decision, status, quote, version, author, at'


def give(source: str, record_id: str, answers: Iterable[dict], *, author: str = PERSON, at: str | None = None) -> None:
    """Answers on cases of one record (domain.answers.found), in the order given: agree, disagree, or None for an
    answer taken back. In the caller's transaction, if it holds one."""
    with db.connect() as connection:
        add(connection, source, record_id, answers, author, at)


def add(
    connection: sqlite3.Connection, source: str, record_id: str, answers: Iterable[dict], author: str, at: str | None
) -> None:
    """Answers written on a connection the caller holds (give)."""
    rows = []
    for answer in answers:
        if answer['decision'] not in (*DECISIONS, None):
            raise ValueError('decision: agree | disagree | null')
        rows.append(
            (
                source,
                record_id,
                answer['conversation'],
                answer['rule'],
                answer['decision'],
                answer['status'],
                answer['quote'],
                answer['version'],
                author,
                at or db.now(),
            )
        )
    connection.executemany(
        f'INSERT INTO reviews (source, record_id, {_FIELDS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', rows
    )


def visible(source: str, record_id: str) -> dict[tuple[str, str], dict]:
    """The visible answer on every case of one record that has an answer: its latest row by (conversation, criterion),
    one taken back included (decision None)."""
    with db.connect() as connection:
        rows = connection.execute(
            f'SELECT {_FIELDS} FROM reviews WHERE source = ? AND record_id = ? ORDER BY id', (source, record_id)
        ).fetchall()
    return {(row[0], row[1]): _answer(row) for row in rows}


def listed(source: str, record_id: str) -> list[dict]:
    """The visible answers on one record by conversation and criterion, as the history of checks shows them:
    {dialogueId, ruleId, decision, updatedAt}."""
    found = visible(source, record_id)
    return [
        {'dialogueId': conversation, 'ruleId': rule_id, 'decision': answer['decision'], 'updatedAt': answer['at']}
        for (conversation, rule_id), answer in sorted(found.items())
    ]


def by_record(source: str) -> dict[str, dict[tuple[str, str], dict]]:
    """The visible answers on every record of one source (every run, for the list of runs), by record."""
    with db.connect() as connection:
        rows = connection.execute(f'SELECT record_id, {_FIELDS} FROM reviews WHERE source = ? ORDER BY id', (source,))
        found: dict[str, dict[tuple[str, str], dict]] = {}
        for row in rows:
            found.setdefault(row[0], {})[(row[1], row[2])] = _answer(row[1:])
    return found


def on_saved_checks(kind: str) -> list[tuple[str, str, str, str | None]]:
    """The visible answer on every case of the saved checks of one kind, the newest check first: (check, conversation,
    criterion, decision). A person answers only on the current check, so the first one found for a case is their
    latest word."""
    with db.connect() as connection:
        rows = connection.execute(
            'SELECT history.rowid, reviews.record_id, reviews.conversation, reviews.rule_id, reviews.decision '
            'FROM reviews JOIN history ON history.id = reviews.record_id WHERE reviews.source = ? '
            'AND history.kind = ? ORDER BY reviews.id',
            (LOG, kind),
        ).fetchall()
    latest = {(record, conversation, rule): (order, decision) for order, record, conversation, rule, decision in rows}
    ordered = sorted(latest.items(), key=lambda found: -found[1][0])
    return [(*case, decision) for case, (_, decision) in ordered]


def journal(source: str | None = None) -> list[dict]:
    """Every answer given, carried or taken back, the oldest first; only the ones of one source when it is named."""
    where, values = ('WHERE source = ?', (source,)) if source is not None else ('', ())
    with db.connect() as connection:
        rows = connection.execute(
            f'SELECT source, record_id, {_FIELDS} FROM reviews {where} ORDER BY id', values
        ).fetchall()
    return [
        {'source': row[0], 'recordId': row[1], 'conversation': row[2], 'ruleId': row[3], **_answer(row[2:])}
        for row in rows
    ]


def stamp() -> str:
    """What changes with every answer given, carried or taken back, on any record: the journal's last row."""
    with db.connect() as connection:
        return str(connection.execute('SELECT max(id) FROM reviews').fetchone()[0] or 0)


def _answer(row: tuple) -> dict:
    """An answer by its fields (_FIELDS), without its case."""
    _, _, decision, status, quote, version, author, at = row
    return {'decision': decision, 'status': status, 'quote': quote, 'version': version, 'author': author, 'at': at}

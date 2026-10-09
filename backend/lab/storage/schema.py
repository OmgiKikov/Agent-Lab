"""The tables of an agent's database, and how an older database becomes this one: once per file, when its
user_version is not SCHEMA (db.connect). Every step is SQL over the tables as an older Lab left them and never calls the
modules beside it, whose shape moves on while an older database stays what it was. The legacy import brings what it
inserted to this schema the same way (legacy.py).

Schema 7: the export's conversations are rows (dialogues), the saved checks of both checks one table (history), and
the answers people gave on verdicts rows of their own (reviews): a result, a saved check and a run keep verdicts only.
Schema 8: long work is kept as it goes (tasks, steps), never only in memory.
Schema 9: immutable datasets alongside the selected working export.
Schema 10: grouped launches and recorded-question runs.
Schema 11: a dataset keeps how many conversations its upload left out.
Schema 12: a quoted verdict keeps the customer's words its reply answered.
"""

import json
import sqlite3
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from functools import partial
from pathlib import Path
from typing import Any

from ..domain import accuracy, answers, checks, export, verdicts
from ..domain.comparison import dataset_fingerprint
from ..domain.metric import metric

# The database's user_version once these tables are in place. Raise it with every change here: a database is set up
# again only when its user_version differs.
SCHEMA = 12
EXPORT = 'logs.json'  # where a database before schema 7 kept the export's conversations, as one document
EXPORT_META = 'logs-meta.json'  # the name of the export's file and when it was uploaded
PERSON, LAB = 'person', 'lab'  # who gave an answer: a person on a screen, or the Lab (storage.reviews)

TABLES = (
    'CREATE TABLE IF NOT EXISTS launches (id TEXT PRIMARY KEY, kind TEXT NOT NULL, '
    'summary TEXT NOT NULL, value TEXT NOT NULL)',
    # skipped: the conversations of the upload a check cannot read (the agent wrote first, or never answered), left
    # out; unknown (NULL) for a dataset uploaded before it was kept.
    'CREATE TABLE IF NOT EXISTS datasets (id TEXT PRIMARY KEY, name TEXT NOT NULL, file TEXT, '
    'created_at TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, archived_at TEXT, context TEXT, skipped INTEGER)',
    'CREATE TABLE IF NOT EXISTS dataset_dialogues (dataset_id TEXT NOT NULL, position INTEGER NOT NULL, '
    'id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (dataset_id, position), UNIQUE (dataset_id, id))',
    'CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, value TEXT NOT NULL)',
    # The export's conversations in its order (position), each by its id: one is read without the others.
    'CREATE TABLE IF NOT EXISTS dialogues (position INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, value TEXT NOT NULL)',
    # summary: the run without its conversations, written with it, for the list of runs.
    'CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, value TEXT NOT NULL, summary TEXT)',
    # The saved checks of both checks (kind: tone or code): summary is the line of the list, value the whole record.
    'CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, kind TEXT NOT NULL, summary TEXT NOT NULL, '
    'value TEXT NOT NULL)',
    # The answers on verdicts, a journal: the visible answer on a case is its latest row (storage.reviews).
    'CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY, source TEXT NOT NULL, record_id TEXT NOT NULL, '
    'conversation TEXT NOT NULL, rule_id TEXT NOT NULL, decision TEXT, status TEXT, quote TEXT, version TEXT, '
    'author TEXT NOT NULL, at TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS reviews_by_case ON reviews (source, record_id, conversation, rule_id)',
    # The journal of calls to the models (models.chat): one line per try, never a conversation.
    'CREATE TABLE IF NOT EXISTS calls ('
    'id INTEGER PRIMARY KEY, at TEXT NOT NULL, role TEXT, version TEXT, subject TEXT, model TEXT NOT NULL, '
    'answered_by TEXT, via TEXT NOT NULL, ms INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER, '
    'cost REAL, outcome TEXT NOT NULL, status INTEGER, detail TEXT)',
    'CREATE INDEX IF NOT EXISTS calls_by_subject ON calls (subject)',
    # Long work (storage.tasks): one row per task, also after it ended; at most one running at a time.
    'CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, '
    'input TEXT NOT NULL, fingerprint TEXT, progress TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, '
    'started_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT, resumed INTEGER NOT NULL DEFAULT 0, '
    'stalled INTEGER NOT NULL DEFAULT 0, steps_at_resume INTEGER)',
    "CREATE UNIQUE INDEX IF NOT EXISTS one_running_task ON tasks (status) WHERE status = 'running'",
    'CREATE INDEX IF NOT EXISTS tasks_by_kind ON tasks (kind, started_at)',
    # The finished parts of a task, kept as each is done: a conversation judged, the topics planned.
    'CREATE TABLE IF NOT EXISTS steps (task_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, '
    'at TEXT NOT NULL, PRIMARY KEY (task_id, key))',
)


def set_up(connection: sqlite3.Connection, path: Path) -> None:
    """Once per database file, not on every connection: /api/state alone opens several every 1.5 s during a job. A
    file that is new or replaced (an adopted copy, an older Lab's database) has another user_version."""
    # Write-ahead log: a screen reads while a job writes, instead of waiting for it. The file keeps the mode.
    connection.execute('PRAGMA journal_mode=WAL')
    path.chmod(0o600)
    with connection:
        if not connection.in_transaction:
            connection.execute('BEGIN IMMEDIATE')
        for statement in TABLES:
            connection.execute(statement)
        if 'summary' not in {column[1] for column in connection.execute('PRAGMA table_info(runs)')}:
            connection.execute('ALTER TABLE runs ADD COLUMN summary TEXT')
        if 'skipped' not in {column[1] for column in connection.execute('PRAGMA table_info(datasets)')}:
            connection.execute('ALTER TABLE datasets ADD COLUMN skipped INTEGER')
        upgrade(connection)
        connection.execute(f'PRAGMA user_version = {SCHEMA}')


def upgrade(connection: sqlite3.Connection) -> None:
    """What an older database, or an older Lab's files just imported, keeps in an older shape, in this one. A step does
    nothing to what has this shape already."""
    _separate_checks(connection)
    _export_to_rows(connection)
    _one_history(connection)
    _accuracy_history(connection)
    _answers_to_rows(connection)
    _asked_on_verdicts(connection)
    # The number of uploaded dialogues was kept beside them before they were rows.
    connection.execute('DROP TRIGGER IF EXISTS length_on_insert')
    connection.execute('DROP TRIGGER IF EXISTS length_on_update')
    connection.execute('DROP TABLE IF EXISTS lengths')


def _separate_checks(connection: sqlite3.Connection) -> None:
    """Each check keeps its own result, and a deck and a run name their check (domain.checks). In an older database a
    tone-of-voice result lies in the accuracy's place: it moves to its own and the deck gets its check
    (checks.separated); a run gets the check of its criteria (checks.of_run), in its record and its summary. What is
    separated already stays."""
    names = (*checks.RESULTS.values(), checks.DECK)
    for name, value in checks.separated({name: _document(connection, name) for name in names}).items():
        _put(connection, name, value)
    for run_id, value, summary in connection.execute('SELECT id, value, summary FROM runs').fetchall():
        if summary is None or 'check' not in json.loads(summary):
            played = json.loads(value)
            played['check'] = checks.of_run(played)
            connection.execute(
                'UPDATE runs SET value = ?, summary = ? WHERE id = ?', (_dump(played), _summary(played), run_id)
            )


def _export_to_rows(connection: sqlite3.Connection) -> None:
    """The export's conversations, one document before schema 7, become rows in their order, and the document goes. An
    export uploaded before the name of its file was kept gets a record without the name: the legacy import never takes
    it for no export at all."""
    row = connection.execute('SELECT value FROM documents WHERE name = ?', (EXPORT,)).fetchone()
    if row is None:
        return
    connection.execute('DELETE FROM dialogues')
    connection.executemany(
        'INSERT OR REPLACE INTO dialogues (position, id, value) VALUES (?, ?, ?)',
        (
            (position, str(dialogue['id']), _dump(dialogue))
            for position, dialogue in enumerate(json.loads(row[0]) or [], 1)
        ),
    )
    connection.execute('DELETE FROM documents WHERE name = ?', (EXPORT,))
    if _document(connection, EXPORT_META) is None:
        _put(connection, EXPORT_META, {'file': None, 'updatedAt': None})


def _one_history(connection: sqlite3.Connection) -> None:
    """The saved checks, a table per check before schema 7, go into one in the order they were saved. The answers on
    them become rows: first the ones a record kept in its result, then the ones people gave on it, in the order they
    gave them, each with the verdict it was given on. The old tables go.

    Who gave an answer a record kept: the Lab, which carried it from the check before (author lab), except in the
    first saved check of Точность, which an older Lab made of a result from before the history of checks, with the
    answers people had given on it (no check before it to carry from: author person). A row of the old tables is a
    person's click (author person, also when it repeats the answer shown), except the copies of the carried answers a
    check of tone of voice wrote there when it was saved (at its time, with the answer it kept)."""
    tables = {name for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    verdicts: dict[tuple[str, str, str], tuple[Any, Any, Any]] = {}
    kept: dict[tuple[str, str, str], tuple[str | None, str | None]] = {}  # the record's answer and when it was saved
    for kind, table in ((checks.TONE, 'tone_checks'), (checks.CODE, 'code_checks')):
        if table not in tables:
            continue
        for check_id, summary, value in connection.execute(f'SELECT id, summary, value FROM {table} ORDER BY rowid'):
            record = json.loads(value)
            result, carried = answers.taken_from_result(record.get('result') or {})
            for item in result.get('results') or []:
                for row in item.get('rules') or []:
                    verdicts[(check_id, str(item['dialogueId']), row.get('ruleId'))] = (
                        row.get('status'),
                        row.get('agentQuote'),
                        item.get('judgeVersion'),
                    )
            connection.execute(
                'INSERT OR IGNORE INTO history (id, kind, summary, value) VALUES (?, ?, ?, ?)',
                (check_id, kind, summary, _dump({**record, 'result': result} if 'result' in record else record)),
            )
            saved = record.get('check') or {}
            first = not (saved.get('comparison') or {}).get('previousId')
            for answer in carried:
                kept[(check_id, answer['conversation'], answer['rule'])] = (answer['decision'], saved.get('finishedAt'))
            author = PERSON if kind == checks.CODE and first else LAB
            _answer(connection, answers.LOG, check_id, carried, author, saved.get('finishedAt'))
        connection.execute(f'DROP TABLE {table}')
    for table in ('tone_check_reviews', 'code_check_reviews'):
        if table not in tables:
            continue
        rows = connection.execute(
            f'SELECT check_id, dialogue_id, rule_id, decision, updated_at FROM {table} ORDER BY updated_at, rowid'
        ).fetchall()
        for check_id, dialogue_id, rule_id, decision, at in rows:
            if table == 'tone_check_reviews' and kept.get((check_id, dialogue_id, rule_id)) == (decision, at):
                continue  # the copy of a carried answer, written with the check
            status, quote, version = verdicts.get((check_id, dialogue_id, rule_id), (None, None, None))
            given = {
                'conversation': dialogue_id,
                'rule': rule_id,
                'decision': decision,
                'status': status,
                'quote': quote,
                'version': version,
            }
            _answer(connection, answers.LOG, check_id, [given], PERSON, at, again=True)
        connection.execute(f'DROP TABLE {table}')


# What a result needs to become a saved check (domain.accuracy.saved): a result of an older Lab's files may lack them.
_RECORDED = ('finishedAt', 'sampled', 'model', 'summary', 'topics')


def _accuracy_history(connection: sqlite3.Connection) -> None:
    """A result of Точность from before its history becomes its first saved check, with the conversations of the export
    it was made of (still the current one: a new export clears the result), so that the next export no longer erases
    it. A result already saved stays as it is; one without what a saved check records (an older Lab's file) is never
    saved, and its answers are kept under answers.record_of."""
    result = _document(connection, checks.result(checks.CODE))
    if not result or not result.get('results') or result.get('checkId'):
        return
    if any(result.get(key) is None for key in _RECORDED):
        return
    judged = {str(item['dialogueId']) for item in result['results']}
    uploaded = [json.loads(value) for (value,) in connection.execute('SELECT value FROM dialogues ORDER BY position')]
    dialogues = [dialogue for dialogue in uploaded if str(dialogue['id']) in judged]
    result = {**result, 'checkId': uuid.uuid4().hex, 'datasetFingerprint': dataset_fingerprint(dialogues)}
    meta = _document(connection, EXPORT_META) or {}
    record = accuracy.saved(result, dialogues, meta.get('file'), len(uploaded), None)
    kept, _ = answers.taken_from_result(record['result'])
    connection.execute(
        'INSERT INTO history (id, kind, summary, value) VALUES (?, ?, ?, ?)',
        (record['check']['id'], checks.CODE, _dump(record['check']), _dump({**record, 'result': kept})),
    )
    _put(connection, checks.result(checks.CODE), result)


def _answers_to_rows(connection: sqlite3.Connection) -> None:
    """The answers a result or a run kept in its verdicts before schema 7 become rows, and the result and the run keep
    the verdicts. A result from before the history of checks keeps its answers under answers.record_of. A run's metric
    no longer counts them: they are counted when it is read."""
    for check in checks.RESULTS:
        name = checks.result(check)
        result = _document(connection, name)
        if not isinstance(result, dict) or not result.get('results'):
            continue
        kept, taken = answers.taken_from_result(result)
        if kept != result:
            _answer(connection, answers.LOG, answers.record_of(check, result), taken, PERSON, result.get('finishedAt'))
            _put(connection, name, kept)
    for run_id, value in connection.execute('SELECT id, value FROM runs').fetchall():
        record = json.loads(value)
        kept, taken = answers.taken_from_run(record)
        if kept == record and 'human' not in (record.get('metric') or {}):
            continue
        kept['metric'] = metric(kept.get('items') or [])
        at = record.get('updatedAt') or record.get('finishedAt') or record.get('startedAt')
        _answer(connection, answers.SIM, run_id, taken, PERSON, at)
        connection.execute('UPDATE runs SET value = ?, summary = ? WHERE id = ?', (_dump(kept), _summary(kept), run_id))


def _asked_on_verdicts(connection: sqlite3.Connection) -> None:
    """The quoted verdicts of a result an earlier Lab made get the customer's words their replies answered
    (verdicts.with_asked), from the conversations the result was judged on: a result in force from the export's, one
    kept with a dataset for when it is selected again from that dataset's. A verdict that has them keeps them."""
    in_export = partial(_dialogue, connection, 'SELECT value FROM dialogues WHERE id = ?')
    for name in checks.RESULTS.values():
        result = _document(connection, name)
        asked = _with_asked(result, in_export)
        if asked != result:
            _put(connection, name, asked)
    in_dataset = 'SELECT value FROM dataset_dialogues WHERE dataset_id = ? AND id = ?'
    kept = connection.execute('SELECT id, context FROM datasets WHERE context IS NOT NULL').fetchall()
    for dataset_id, context in kept:
        stashed = json.loads(context)
        read = partial(_dialogue, connection, in_dataset, dataset_id)
        documents = stashed.get('documents') or {}
        asked = {
            name: _with_asked(value, read) if name in checks.RESULTS.values() else value
            for name, value in documents.items()
        }
        if asked != documents:
            connection.execute(
                'UPDATE datasets SET context = ? WHERE id = ?', (_dump(stashed | {'documents': asked}), dataset_id)
            )


def _with_asked(result: Any, read: Callable[[str], dict | None]) -> Any:
    """A result with the customer's words on its quoted verdicts, each conversation read by its id (read): one no
    longer there gives none. No result, or a record of another shape, stays as it is."""
    if not isinstance(result, dict) or not isinstance(result.get('results'), list):
        return result
    judged = []
    for item in result['results']:
        dialogue = read(str(item['dialogueId']))
        shown = export.conversation(dialogue) if dialogue else []
        judged.append(item | {'rules': verdicts.with_asked(item['rules'], shown)} if item.get('rules') else item)
    return result | {'results': judged}


def _dialogue(connection: sqlite3.Connection, query: str, *key: str) -> dict | None:
    row = connection.execute(query, key).fetchone()
    return json.loads(row[0]) if row else None


def _answer(
    connection: sqlite3.Connection,
    source: str,
    record_id: str,
    found: list[dict],
    author: str,
    at: str | None,
    *,
    again: bool = False,
) -> None:
    """Answers into the journal (answers.found), each only when it is not the visible answer on its case already, or
    `again` when it is: a person who gave the answer shown gave it too."""
    visible = {
        (conversation, rule_id): decision
        for conversation, rule_id, decision in connection.execute(
            'SELECT conversation, rule_id, decision FROM reviews WHERE source = ? AND record_id = ? ORDER BY id',
            (source, record_id),
        )
    }
    for answer in found:
        key = (answer['conversation'], answer['rule'])
        if not again and key in visible and visible[key] == answer['decision']:
            continue
        connection.execute(
            'INSERT INTO reviews (source, record_id, conversation, rule_id, decision, status, quote, version, '
            'author, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (
                source,
                record_id,
                *key,
                answer['decision'],
                answer['status'],
                answer['quote'],
                answer['version'],
                author,
                at or datetime.now(UTC).isoformat(timespec='milliseconds'),
            ),
        )
        visible[key] = answer['decision']


def _summary(record: dict) -> str:
    """The run without its conversations, with its check (checks.of_run: an older record names none)."""
    return _dump({key: value for key, value in record.items() if key != 'items'} | {'check': checks.of_run(record)})


def _document(connection: sqlite3.Connection, name: str) -> Any:
    row = connection.execute('SELECT value FROM documents WHERE name = ?', (name,)).fetchone()
    return json.loads(row[0]) if row else None


def _put(connection: sqlite3.Connection, name: str, value: Any) -> None:
    connection.execute(
        'INSERT INTO documents (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
        (name, _dump(value)),
    )


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))

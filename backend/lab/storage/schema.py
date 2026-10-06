"""The tables of an agent's database, and how an older database becomes this one: once per file, when its
user_version is not SCHEMA (db.connect). Every step is SQL over the tables as an older Lab left them and never calls the
modules beside it, whose shape moves on while an older database stays what it was. The legacy import brings what it
inserted to this schema the same way (legacy.py).

Schema 7: the export's conversations are rows (dialogues), the saved checks of both checks one table (history), and
the answers people gave on verdicts rows of their own (reviews): a result, a saved check and a run keep verdicts only.
Schema 8: long work is kept as it goes (tasks, steps), never only in memory.
Schema 9: an agent has exports, each upload one (exports); a conversation is a row by its export and id (dialogues).
"""

import json
import sqlite3
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..domain import accuracy, answers, checks
from ..domain.comparison import dataset_fingerprint
from ..domain.metric import metric

# The database's user_version once these tables are in place. Raise it with every change here: a database is set up
# again only when its user_version differs.
SCHEMA = 9
EXPORT = 'logs.json'  # where a database before schema 7 kept the export's conversations, as one document
EXPORT_META = 'logs-meta.json'  # schema 7–8: the record of the one export, its file and when it was uploaded
PERSON, LAB = 'person', 'lab'  # who gave an answer: a person on a screen, or the Lab (storage.reviews)

# The conversations of every export in its order (position), each by its export and id: one is read without the
# others, and the same conversation may be in two exports. An older database has another dialogues table: it gets this
# one, and its order, in _exports.
DIALOGUES = (
    'CREATE TABLE IF NOT EXISTS dialogues (export TEXT NOT NULL, position INTEGER NOT NULL, id TEXT NOT NULL, '
    'value TEXT NOT NULL, PRIMARY KEY (export, id))'
)
DIALOGUES_ORDER = 'CREATE INDEX IF NOT EXISTS dialogues_in_order ON dialogues (export, position)'

TABLES = (
    'CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, value TEXT NOT NULL)',
    # The exports of conversations, each upload one (storage/exports.py): the list is the newest first (rowid).
    'CREATE TABLE IF NOT EXISTS exports (id TEXT PRIMARY KEY, name TEXT NOT NULL, file TEXT, '
    'uploaded_at TEXT NOT NULL, total INTEGER NOT NULL, skipped INTEGER NOT NULL DEFAULT 0)',
    DIALOGUES,
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
        upgrade(connection)
        connection.execute(f'PRAGMA user_version = {SCHEMA}')


def upgrade(connection: sqlite3.Connection) -> None:
    """What an older database, or an older Lab's files just imported, keeps in an older shape, in this one. A step does
    nothing to what has this shape already."""
    _exports(connection)
    _separate_checks(connection)
    _export_to_rows(connection)
    _one_history(connection)
    _accuracy_history(connection)
    _answers_to_rows(connection)
    # The number of uploaded dialogues was kept beside them before they were rows.
    connection.execute('DROP TRIGGER IF EXISTS length_on_insert')
    connection.execute('DROP TRIGGER IF EXISTS length_on_update')
    connection.execute('DROP TABLE IF EXISTS lengths')


def _exports(connection: sqlite3.Connection) -> None:
    """Schema 9: the one export of an older database becomes the first of its exports, named by its file and uploaded
    when it was. The current results were made of it (a new export cleared them then), and so were their saved checks.
    An export still a document (logs.json, before schema 7) is _export_to_rows's."""
    columns = {column[1] for column in connection.execute('PRAGMA table_info(dialogues)')}
    if 'export' not in columns:
        connection.execute('ALTER TABLE dialogues RENAME TO dialogues_before_exports')
        connection.execute(DIALOGUES)
        rows = connection.execute(
            'SELECT position, id, value FROM dialogues_before_exports ORDER BY position'
        ).fetchall()
        meta = _document(connection, EXPORT_META)
        if rows or (meta is not None and _document(connection, EXPORT) is None):
            _new_export(connection, meta or {}, rows)
        connection.execute('DROP TABLE dialogues_before_exports')
    connection.execute(DIALOGUES_ORDER)


def _new_export(connection: sqlite3.Connection, meta: dict, rows: list[tuple]) -> None:
    """An export of these rows (position, id, value) with the file and the time of the older record of the export
    (meta), which goes; the current results, and the saved checks they are, made of it."""
    export_id = uuid.uuid4().hex[:12]
    connection.executemany(
        'INSERT OR REPLACE INTO dialogues (export, position, id, value) VALUES (?, ?, ?, ?)',
        ((export_id, position, dialogue_id, value) for position, dialogue_id, value in rows),
    )
    total = connection.execute('SELECT count(*) FROM dialogues WHERE export = ?', (export_id,)).fetchone()[0]
    file = meta.get('file')
    name = _name_of(file)
    at = meta.get('updatedAt') or datetime.now(UTC).isoformat(timespec='milliseconds')
    connection.execute(
        'INSERT INTO exports (id, name, file, uploaded_at, total, skipped) VALUES (?, ?, ?, ?, ?, 0)',
        (export_id, name, file, at, total),
    )
    made = {'id': export_id, 'name': name, 'file': file, 'total': total}
    for document in checks.RESULTS.values():
        result = _document(connection, document)
        if isinstance(result, dict) and not result.get('export'):
            _put(connection, document, {**result, 'export': made})
            if result.get('checkId'):
                _mark_saved(connection, result['checkId'], {'id': export_id, 'name': name})
    connection.execute('DELETE FROM documents WHERE name = ?', (EXPORT_META,))


def _mark_saved(connection: sqlite3.Connection, check_id: str, export: dict) -> None:
    """The saved check of a result names the export it was made of, in its line and in its record."""
    row = connection.execute('SELECT summary, value FROM history WHERE id = ?', (check_id,)).fetchone()
    if row is None:
        return
    summary, value = json.loads(row[0]), json.loads(row[1])
    value['check'] = {**(value.get('check') or {}), 'export': export}
    connection.execute(
        'UPDATE history SET summary = ?, value = ? WHERE id = ?',
        (_dump({**summary, 'export': export}), _dump(value), check_id),
    )


def _name_of(file: str | None) -> str:
    """The name of an export by its file, as storage.exports names one (its rules may move on; this step's stay)."""
    stem = (file or '').replace('\\', '/').rsplit('/', 1)[-1]
    stem = stem.rsplit('.', 1)[0] if '.' in stem else stem
    return stem.strip() or 'Выгрузка'


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
    """The export's conversations, one document before schema 7 (or in an older Lab's files just imported), become an
    export of rows in their order, with the record of its file when there is one, and the document goes."""
    row = connection.execute('SELECT value FROM documents WHERE name = ?', (EXPORT,)).fetchone()
    if row is None:
        return
    dialogues = json.loads(row[0]) or []
    rows = [(position, str(dialogue['id']), _dump(dialogue)) for position, dialogue in enumerate(dialogues, 1)]
    _new_export(connection, _document(connection, EXPORT_META) or {}, rows)
    connection.execute('DELETE FROM documents WHERE name = ?', (EXPORT,))


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
    export = result.get('export') or {}
    uploaded = [
        json.loads(value)
        for (value,) in connection.execute(
            'SELECT value FROM dialogues WHERE export = ? ORDER BY position', (export.get('id'),)
        )
    ]
    dialogues = [dialogue for dialogue in uploaded if str(dialogue['id']) in judged]
    result = {**result, 'checkId': uuid.uuid4().hex, 'datasetFingerprint': dataset_fingerprint(dialogues)}
    record = accuracy.saved(result, dialogues, {**export, 'total': len(uploaded)}, None)
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

"""Local SQLite persistence. Run mutations read and patch the current record in one transaction."""

import json
import sqlite3
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .metric import metric
from .settings import DATA

DB = DATA / 'lab.sqlite3'
# The database of the agent a request works in (registry.using, api.py); without one, DB above.
AGENT: ContextVar[Path | None] = ContextVar('agent_db', default=None)
# The database's user_version once its schema below is in place.
SCHEMA = 3
# The uploaded dialogues: every write keeps their number beside them (lengths), so the state polled every 1.5 s
# counts them without reading megabytes of conversations.
COUNTED = 'logs.json'


def now() -> str:
    return datetime.now(UTC).isoformat(timespec='milliseconds')


def database() -> Path:
    """The database the current request or job works in; its folder holds the rest of that agent's files."""
    return AGENT.get() or DB


@contextmanager
def _connection() -> Iterator[sqlite3.Connection]:
    path = database()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10)
    try:
        if connection.execute('PRAGMA user_version').fetchone()[0] != SCHEMA:
            _set_up(connection, path)
        with connection:
            yield connection
    finally:
        connection.close()


def _set_up(connection: sqlite3.Connection, path: Path) -> None:
    """Once per database file, not on every connection: /api/state alone opens several every 1.5 s during a job.
    A file that is new or replaced (an adopted copy, an older Lab's database) has another user_version."""
    # Write-ahead log: a screen reads while a job writes, instead of waiting for it. The file keeps the mode.
    connection.execute('PRAGMA journal_mode=WAL')
    path.chmod(0o600)
    with connection:
        connection.execute('BEGIN IMMEDIATE')
        connection.execute('CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, value TEXT NOT NULL)')
        # summary: the run without its conversations, written with it (_summary), for the list of runs.
        connection.execute('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, value TEXT NOT NULL, summary TEXT)')
        if 'summary' not in {column[1] for column in connection.execute('PRAGMA table_info(runs)')}:
            connection.execute('ALTER TABLE runs ADD COLUMN summary TEXT')
        for run_id, value in connection.execute('SELECT id, value FROM runs WHERE summary IS NULL').fetchall():
            connection.execute('UPDATE runs SET summary = ? WHERE id = ?', (_summary(json.loads(value)), run_id))
        connection.execute(
            'CREATE TABLE IF NOT EXISTS tone_checks (id TEXT PRIMARY KEY, summary TEXT NOT NULL, value TEXT NOT NULL)'
        )
        connection.execute(
            'CREATE TABLE IF NOT EXISTS tone_check_reviews ('
            'check_id TEXT NOT NULL, dialogue_id TEXT NOT NULL, rule_id TEXT NOT NULL, '
            'decision TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (check_id, dialogue_id, rule_id))'
        )
        connection.execute('CREATE TABLE IF NOT EXISTS lengths (name TEXT PRIMARY KEY, length INTEGER NOT NULL)')
        if _json_functions(connection):
            # Not INSERT OR REPLACE: in a trigger, the conflict policy of the write that fired it would apply.
            keep = (
                'DELETE FROM lengths WHERE name = new.name; '
                'INSERT INTO lengths (name, length) VALUES (new.name, json_array_length(new.value));'
            )
            for name, event in (('length_on_insert', 'INSERT'), ('length_on_update', 'UPDATE OF value')):
                connection.execute(
                    f"CREATE TRIGGER IF NOT EXISTS {name} AFTER {event} ON documents WHEN new.name = '{COUNTED}' "
                    f'BEGIN {keep} END'
                )
            connection.execute(
                'INSERT OR REPLACE INTO lengths (name, length) '
                'SELECT name, json_array_length(value) FROM documents WHERE name = ?',
                (COUNTED,),
            )
        connection.execute(f'PRAGMA user_version = {SCHEMA}')


def _json_functions(connection: sqlite3.Connection) -> bool:
    """Built into SQLite since 3.38. Without them a trigger calling one would fail every write of the documents."""
    try:
        connection.execute("SELECT json_array_length('[]')")
    except sqlite3.OperationalError:
        return False
    return True


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def _summary(record: dict) -> str:
    return _json({key: value for key, value in record.items() if key != 'items'})


def load(name: str, default: Any = None) -> Any:
    with _connection() as connection:
        row = connection.execute('SELECT value FROM documents WHERE name = ?', (name,)).fetchone()
    return json.loads(row[0]) if row else default


def length(name: str) -> int:
    """How many dialogues are uploaded, from the number kept beside them: the dialogues themselves are not read."""
    if name != COUNTED:
        raise ValueError('Only the uploaded dialogues are counted')
    with _connection() as connection:
        row = connection.execute('SELECT length FROM lengths WHERE name = ?', (name,)).fetchone()
        if row is None:  # nothing uploaded, or a SQLite without JSON functions keeps no number
            stored = connection.execute('SELECT value FROM documents WHERE name = ?', (name,)).fetchone()
            return len(json.loads(stored[0]) or []) if stored else 0
    return row[0]


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
        value = _update_document(connection, name, mutate)
    return value


def _update_document(connection: sqlite3.Connection, name: str, mutate: Callable[[Any], None]) -> Any:
    row = connection.execute('SELECT value FROM documents WHERE name = ?', (name,)).fetchone()
    if row is None:
        raise KeyError(name)
    value = json.loads(row[0])
    mutate(value)
    connection.execute('UPDATE documents SET value = ? WHERE name = ?', (_json(value), name))
    return value


def replace_inputs(name: str, value: Any) -> None:
    """Replace sources or logs together with invalidation of their derived audit and scenarios.

    The tone-of-voice check derives from its own policy, not from the agent's code: while the policy stays the same,
    its criteria and its result survive re-read code. Scenarios read the code, so they are invalidated either way.
    """
    if name not in ('sources.json', 'logs.json'):
        raise ValueError('Only source and log documents are inputs')
    with _connection() as connection:
        connection.execute('BEGIN IMMEDIATE')
        cleared = ['discover.json', 'cards.json']
        if name == 'sources.json':
            policy = _tone_policy(_document(connection, name))
            if not policy or policy != _tone_policy(value):
                cleared.append('tone-of-voice-criteria.json')
            elif (_document(connection, 'discover.json') or {}).get('purpose') == 'tone-of-voice':
                cleared.remove('discover.json')
        connection.execute(
            'INSERT INTO documents (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
            (name, _json(value)),
        )
        # Keep the names: a repeated legacy import must not resurrect intentionally cleared results.
        connection.executemany(
            'INSERT INTO documents (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
            [(document, 'null') for document in cleared],
        )


def _document(connection: sqlite3.Connection, name: str) -> Any:
    row = connection.execute('SELECT value FROM documents WHERE name = ?', (name,)).fetchone()
    return json.loads(row[0]) if row else None


def _tone_policy(items: list[dict] | None) -> list[dict]:
    """The supplied tone-of-voice policy among the sources (tone.KIND)."""
    return [item for item in items or [] if item.get('kind') == 'tone-of-voice']


def save_audit(value: dict, *, new_criteria: bool) -> None:
    """Publish a log audit; criteria extracted anew no longer match the playable cards, so those go with it."""
    documents = [('discover.json', _json(value))]
    if new_criteria:
        documents.append(('cards.json', 'null'))
    with _connection() as connection:
        connection.execute('BEGIN IMMEDIATE')
        connection.executemany(
            'INSERT INTO documents (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
            documents,
        )


def tone_checks() -> list[dict]:
    with _connection() as connection:
        return [json.loads(row[0]) for row in connection.execute('SELECT summary FROM tone_checks ORDER BY rowid DESC')]


def save_tone_draft(draft: dict) -> None:
    """A new rubric revision invalidates playable cards, while the prior assessment stays reviewable."""
    with _connection() as connection:
        connection.execute('BEGIN IMMEDIATE')
        row = connection.execute(
            'SELECT value FROM documents WHERE name = ?', ('tone-of-voice-criteria.json',)
        ).fetchone()
        previous = (json.loads(row[0]) if row else None) or {}
        connection.execute(
            'INSERT INTO documents (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
            ('tone-of-voice-criteria.json', _json(draft)),
        )
        if previous.get('revision') != draft['revision']:
            connection.execute(
                'INSERT INTO documents (name, value) VALUES (?, ?) '
                'ON CONFLICT(name) DO UPDATE SET value = excluded.value',
                ('cards.json', 'null'),
            )


def tone_check(check_id: str) -> dict | None:
    with _connection() as connection:
        row = connection.execute('SELECT value FROM tone_checks WHERE id = ?', (check_id,)).fetchone()
    return json.loads(row[0]) if row else None


def tone_reviews(check_id: str) -> list[dict]:
    with _connection() as connection:
        rows = connection.execute(
            'SELECT dialogue_id, rule_id, decision, updated_at FROM tone_check_reviews '
            'WHERE check_id = ? ORDER BY dialogue_id, rule_id',
            (check_id,),
        )
        return [
            {'dialogueId': dialogue_id, 'ruleId': rule_id, 'decision': decision, 'updatedAt': updated_at}
            for dialogue_id, rule_id, decision, updated_at in rows
        ]


def _save_tone_review(
    connection: sqlite3.Connection, check_id: str, dialogue_id: str, rule_id: str, decision: str | None, updated_at: str
) -> None:
    connection.execute(
        'INSERT INTO tone_check_reviews (check_id, dialogue_id, rule_id, decision, updated_at) VALUES (?, ?, ?, ?, ?) '
        'ON CONFLICT(check_id, dialogue_id, rule_id) DO UPDATE SET '
        'decision = excluded.decision, updated_at = excluded.updated_at',
        (check_id, dialogue_id, rule_id, decision, updated_at),
    )


def save_tone_check(snapshot: dict) -> None:
    """Publish the live result and its immutable evidence snapshot in one transaction.

    Initial carried reviews seed separate annotations; later reviews never rewrite historical model evidence.
    """
    with _connection() as connection:
        connection.execute('BEGIN IMMEDIATE')
        connection.execute(
            'INSERT INTO tone_checks (id, summary, value) VALUES (?, ?, ?)',
            (snapshot['check']['id'], _json(snapshot['check']), _json(snapshot)),
        )
        connection.execute(
            'INSERT INTO documents (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
            ('discover.json', _json(snapshot['result'])),
        )
        connection.execute(
            'INSERT INTO documents (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
            ('cards.json', 'null'),
        )
        for result in snapshot['result']['results']:
            for row in result.get('rules', []):
                if row.get('review') in ('agree', 'disagree'):
                    _save_tone_review(
                        connection,
                        snapshot['check']['id'],
                        str(result['dialogueId']),
                        row['ruleId'],
                        row['review'],
                        snapshot['check']['finishedAt'],
                    )


def runs() -> list[dict]:
    with _connection() as connection:
        records = [json.loads(row[0]) for row in connection.execute('SELECT value FROM runs')]
    return sorted(records, key=lambda record: record.get('startedAt', ''), reverse=True)


def run_summaries() -> list[dict]:
    """Every run without its conversations, newest first: a list of runs never parses a conversation."""
    with _connection() as connection:
        # A row an older Lab wrote after the setup has no summary yet: its record stands in.
        rows = connection.execute('SELECT coalesce(summary, value) FROM runs').fetchall()
    summaries = [{key: value for key, value in json.loads(raw).items() if key != 'items'} for (raw,) in rows]
    return sorted(summaries, key=lambda summary: summary.get('startedAt', ''), reverse=True)


def run(run_id: str) -> dict | None:
    with _connection() as connection:
        row = connection.execute('SELECT value FROM runs WHERE id = ?', (run_id,)).fetchone()
    return json.loads(row[0]) if row else None


def create_run(record: dict) -> dict:
    """Insert a run once. Subsequent writes must patch it, never replace a snapshot."""
    value = dict(record, revision=1, updatedAt=now(), metric=metric(record['items']))
    with _connection() as connection:
        connection.execute(
            'INSERT INTO runs (id, value, summary) VALUES (?, ?, ?)', (value['id'], _json(value), _summary(value))
        )
    return value


def _save_run(connection: sqlite3.Connection, record: dict) -> None:
    connection.execute(
        'UPDATE runs SET value = ?, summary = ? WHERE id = ?', (_json(record), _summary(record), record['id'])
    )


def _mutate_run(run_id: str, mutate: Callable[[dict], None]) -> dict:
    with _connection() as connection:
        connection.execute('BEGIN IMMEDIATE')
        row = connection.execute('SELECT value FROM runs WHERE id = ?', (run_id,)).fetchone()
        if row is None:
            raise KeyError(run_id)
        record = json.loads(row[0])
        mutate(record)
        record.update(metric=metric(record['items']), updatedAt=now(), revision=record.get('revision', 0) + 1)
        _save_run(connection, record)
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


def _patch_item(item: dict, fields: dict) -> None:
    """Keep human confirmation through progress, but never attach it to a changed judgment.

    A decision on the whole conversation is dropped when its status or verdicts change. A decision on one criterion
    belongs to the person, not to the producer's copy: it stays with that criterion while its verdict is the same."""
    patch = {key: value for key, value in fields.items() if key != 'review'}
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


def update_item(run_id: str, index: int, fields: dict) -> dict:
    return update_items(run_id, {index: fields})


def update_items(run_id: str, patches: dict[int, dict], **fields: Any) -> dict:
    """Patch several conversations, and the run's own fields, in one transaction: a re-judged run changes at once."""
    if {'id', 'items', 'metric', 'revision', 'updatedAt'} & fields.keys():
        raise ValueError('Run items and metadata must be updated through their own operation')

    def mutate(record: dict) -> None:
        for index, patch in patches.items():
            _patch_item(record['items'][index], patch)
        record.update(fields)

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


def set_log_review(
    analysis: str, dialogue_id: str, rule_id: str, decision: str | None, finished_at: str | None = None
) -> None:
    """A person's decision on one criterion's verdict in a logged conversation, kept in the log assessment."""
    _decision(decision)

    def mutate(value: dict | None) -> None:
        if finished_at and (value or {}).get('finishedAt') != finished_at:
            raise ValueError('Результат изменился. Откройте актуальную проверку.')
        result = next((r for r in (value or {}).get('results') or [] if str(r.get('dialogueId')) == dialogue_id), None)
        row = next((row for row in (result or {}).get('rules') or [] if row.get('ruleId') == rule_id), None)
        if row is None:
            raise KeyError(rule_id)
        row['review'] = decision

    with _connection() as connection:
        connection.execute('BEGIN IMMEDIATE')
        value = _update_document(connection, analysis, mutate)
        check_id = value.get('checkId')
        if check_id and connection.execute('SELECT 1 FROM tone_checks WHERE id = ?', (check_id,)).fetchone():
            _save_tone_review(connection, check_id, dialogue_id, rule_id, decision, now())


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
            _save_run(connection, record)
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
                'INSERT OR IGNORE INTO runs (id, value, summary) VALUES (?, ?, ?)',
                (value['id'], _json(value), _summary(value)),
            ).rowcount
    return counts

"""Local SQLite persistence: the documents, the runs, the saved checks and the answers on them, the journal of calls.

Storage knows nothing of the processes: what a new input resets, when a result goes to the history, is decided in
flows/, which opens a transaction (transaction) and writes through these functions inside it. A run's mutations read
and patch the current record in one transaction.
"""

import hashlib
import json
import sqlite3
import uuid
from collections.abc import Callable, Collection, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import config
from .domain import accuracy, checks, quotes
from .domain.comparison import dataset_fingerprint
from .domain.metric import metric

# The database's user_version once its schema (_set_up) is in place. Raise it with every change to _set_up: a database
# is set up again only when its user_version differs.
SCHEMA = 6
# The uploaded dialogues: every write keeps their number beside them (lengths), so the state polled every 1.5 s
# counts them without reading megabytes of conversations.
COUNTED = EXPORT = 'logs.json'
EXPORT_META = 'logs-meta.json'  # the name and time of the last upload
# The database of the agent a request works in (registry.using, app.py); without one, default_database().
AGENT: ContextVar[Path | None] = ContextVar('agent_db', default=None)
# A person's answer on a verdict that is no longer the one they saw.
CHANGED = 'Ответ не сохранён: оценка изменилась. Обновите страницу.'
ANSWERED = 'Ответ не сохранён: на этот случай уже ответили, пока вы смотрели. Проверьте ответ на экране.'
# The answer a person saw on a case, when a request does not name one (an older screen): then it is not compared.
UNSEEN: Any = object()


def now() -> str:
    return datetime.now(UTC).isoformat(timespec='milliseconds')


def default_database() -> Path:
    """The database of a Lab without agents (tests, the legacy import), in its data folder, beside the agents."""
    return config.current().data / 'lab.sqlite3'


def database() -> Path:
    """The database the current request or job works in; its folder holds the rest of that agent's files."""
    return AGENT.get() or default_database()


def private_folder(folder: Path) -> None:
    """Create the folder, and the missing ones above it, readable by this user only: they hold the bank's
    conversations, also when the Lab is started without bin/start.sh. A folder that exists keeps its mode."""
    if folder.is_dir():
        return
    for missing in reversed([path for path in (folder, *folder.parents) if not path.exists()]):
        missing.mkdir(mode=0o700, exist_ok=True)


# The transaction a process holds open (transaction): every read and write inside goes through its connection.
_HELD: ContextVar[tuple[Path, sqlite3.Connection] | None] = ContextVar('transaction', default=None)


@contextmanager
def transaction() -> Iterator[None]:
    """What is written inside is written together, or none of it: one connection to the current database, BEGIN
    IMMEDIATE, the commit at the end. A process (flows/) holds it around the writes one change of the product makes,
    and awaits nothing inside: another task's writes wait for it, and its connection stays on its thread."""
    path = database()
    held = _HELD.get()
    if held is not None:
        if held[0] != path:
            raise RuntimeError('A transaction is held in another database')
        yield
        return
    with _connection() as connection:
        _begin(connection)
        token = _HELD.set((path, connection))
        try:
            yield
        finally:
            _HELD.reset(token)


def _begin(connection: sqlite3.Connection) -> None:
    """A write that reads first takes the database at once, unless a transaction holds it already."""
    if not connection.in_transaction:
        connection.execute('BEGIN IMMEDIATE')


@contextmanager
def _connection() -> Iterator[sqlite3.Connection]:
    path = database()
    held = _HELD.get()
    if held is not None and held[0] == path:
        yield held[1]  # the transaction commits or rolls back as a whole
        return
    private_folder(path.parent)
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
        _begin(connection)
        connection.execute('CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, value TEXT NOT NULL)')
        # summary: the run without its conversations, written with it (_summary), for the list of runs.
        connection.execute('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, value TEXT NOT NULL, summary TEXT)')
        if 'summary' not in {column[1] for column in connection.execute('PRAGMA table_info(runs)')}:
            connection.execute('ALTER TABLE runs ADD COLUMN summary TEXT')
        _separate_checks(connection)
        connection.execute(
            'CREATE TABLE IF NOT EXISTS tone_checks (id TEXT PRIMARY KEY, summary TEXT NOT NULL, value TEXT NOT NULL)'
        )
        connection.execute(
            'CREATE TABLE IF NOT EXISTS tone_check_reviews ('
            'check_id TEXT NOT NULL, dialogue_id TEXT NOT NULL, rule_id TEXT NOT NULL, '
            'decision TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (check_id, dialogue_id, rule_id))'
        )
        # The saved checks of Точность, as tone_checks: summary is the line of the list, value the whole record.
        connection.execute(
            'CREATE TABLE IF NOT EXISTS code_checks (id TEXT PRIMARY KEY, summary TEXT NOT NULL, value TEXT NOT NULL)'
        )
        # A person's answers on a saved check of Точность, kept apart from its record, as tone_check_reviews.
        connection.execute(
            'CREATE TABLE IF NOT EXISTS code_check_reviews ('
            'check_id TEXT NOT NULL, dialogue_id TEXT NOT NULL, rule_id TEXT NOT NULL, '
            'decision TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (check_id, dialogue_id, rule_id))'
        )
        _save_accuracy_history(connection)
        # The journal of calls to the models (models.chat): one line per try, never a conversation.
        connection.execute(
            'CREATE TABLE IF NOT EXISTS calls ('
            'id INTEGER PRIMARY KEY, at TEXT NOT NULL, role TEXT, version TEXT, subject TEXT, model TEXT NOT NULL, '
            'answered_by TEXT, via TEXT NOT NULL, ms INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER, '
            'cost REAL, outcome TEXT NOT NULL, status INTEGER, detail TEXT)'
        )
        connection.execute('CREATE INDEX IF NOT EXISTS calls_by_subject ON calls (subject)')
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


def _separate_checks(connection: sqlite3.Connection) -> None:
    """Each check keeps its own result, and a deck and a run name their check (checks.py). In an older database a
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
                'UPDATE runs SET value = ?, summary = ? WHERE id = ?', (_json(played), _summary(played), run_id)
            )


def _save_accuracy_history(connection: sqlite3.Connection) -> None:
    """A result of Точность from before its history becomes its first saved check, with the conversations of the export
    it was made of (still the current one: a new export clears the result), so that the next export no longer erases
    it. A result already saved stays as it is."""
    result = _document(connection, checks.result(checks.CODE))
    if not result or not result.get('results') or result.get('checkId'):
        return
    judged = {str(item['dialogueId']) for item in result['results']}
    uploaded = _document(connection, COUNTED) or []
    dialogues = [dialogue for dialogue in uploaded if str(dialogue['id']) in judged]
    result = {**result, 'checkId': uuid.uuid4().hex, 'datasetFingerprint': dataset_fingerprint(dialogues)}
    meta = _document(connection, EXPORT_META) or {}
    record = accuracy.saved(result, dialogues, meta.get('file'), len(uploaded), None)
    _insert_check(connection, 'code_checks', record)
    _put(connection, checks.result(checks.CODE), result)


def _json_functions(connection: sqlite3.Connection) -> bool:
    """Built into SQLite since 3.38. Without them a trigger calling one would fail every write of the documents."""
    try:
        connection.execute("SELECT json_array_length('[]')")
    except sqlite3.OperationalError:
        return False
    return True


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def _summarized(record: dict) -> dict:
    """The run without its conversations, always with its check (checks.of_run: an older record names none)."""
    return {key: value for key, value in record.items() if key != 'items'} | {'check': checks.of_run(record)}


def _summary(record: dict) -> str:
    return _json(_summarized(record))


def load(name: str, default: Any = None) -> Any:
    with _connection() as connection:
        row = connection.execute('SELECT value FROM documents WHERE name = ?', (name,)).fetchone()
    return json.loads(row[0]) if row else default


# The journal's columns by the names its lines carry (models._journal).
CALL_COLUMNS = {
    'at': 'at',
    'role': 'role',
    'version': 'version',
    'subject': 'subject',
    'model': 'model',
    'answeredBy': 'answered_by',
    'via': 'via',
    'ms': 'ms',
    'inputTokens': 'input_tokens',
    'outputTokens': 'output_tokens',
    'cost': 'cost',
    'outcome': 'outcome',
    'status': 'status',
    'detail': 'detail',
}


def journal(line: dict) -> int:
    """One call to a model in the journal; its id, for the outcome found later (journal_outcome)."""
    names = ', '.join(CALL_COLUMNS.values())
    marks = ', '.join('?' for _ in CALL_COLUMNS)
    with _connection() as connection:
        cursor = connection.execute(
            f'INSERT INTO calls ({names}) VALUES ({marks})', [line.get(key) for key in CALL_COLUMNS]
        )
        return int(cursor.lastrowid)


def journal_outcome(call_id: int, outcome: str, detail: str) -> None:
    """How a call ended, when it is known only after the answer is read: an answer nobody could use."""
    with _connection() as connection:
        connection.execute('UPDATE calls SET outcome = ?, detail = ? WHERE id = ?', (outcome, detail, call_id))


def calls(subject: str | None = None) -> list[dict]:
    """The journal, the oldest call first; only the calls about one subject when it is named."""
    names = ', '.join(CALL_COLUMNS.values())
    where, values = ('WHERE subject = ?', (subject,)) if subject is not None else ('', ())
    with _connection() as connection:
        rows = connection.execute(f'SELECT id, {names} FROM calls {where} ORDER BY id', values).fetchall()
    return [{'id': row[0], **dict(zip(CALL_COLUMNS, row[1:], strict=True))} for row in rows]


def dialogue_ids() -> list[str]:
    """The ids of the export's conversations, in the export's order."""
    return [str(dialogue['id']) for dialogue in dialogues()]


def dialogues(ids: Collection[str] | None = None) -> list[dict]:
    """The export's conversations, in its order; only these when ids are named, in the order named."""
    found = load(EXPORT, []) or []
    if ids is None:
        return found
    by_id = {str(dialogue['id']): dialogue for dialogue in found}
    return [by_id[dialogue_id] for dialogue_id in ids if dialogue_id in by_id]


def dialogue(dialogue_id: str) -> dict | None:
    """One conversation of the export, by its id."""
    return next(iter(dialogues([dialogue_id])), None)


def dialogue_count() -> int:
    """How many conversations the export has, without reading them."""
    return length(EXPORT)


def export_meta() -> dict:
    """The export the conversations came from: its file name and when it was uploaded, when that is known."""
    return load(EXPORT_META) or {'file': None, 'updatedAt': None}


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
        _begin(connection)
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


def _document(connection: sqlite3.Connection, name: str) -> Any:
    row = connection.execute('SELECT value FROM documents WHERE name = ?', (name,)).fetchone()
    return json.loads(row[0]) if row else None


def _put(connection: sqlite3.Connection, name: str, value: Any) -> None:
    connection.execute(
        'INSERT INTO documents (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
        (name, _json(value)),
    )


def _insert_check(connection: sqlite3.Connection, table: str, record: dict) -> None:
    connection.execute(
        f'INSERT INTO {table} (id, summary, value) VALUES (?, ?, ?)',
        (record['check']['id'], _json(record['check']), _json(record)),
    )


def save_code_check(record: dict) -> None:
    """A finished check of Точность in its history (domain.accuracy.saved): its line and its whole record."""
    with _connection() as connection:
        _insert_check(connection, 'code_checks', record)


def code_checks() -> list[dict]:
    """The saved checks of Точность, the newest first: their lines (domain.accuracy.saved)."""
    with _connection() as connection:
        return [json.loads(row[0]) for row in connection.execute('SELECT summary FROM code_checks ORDER BY rowid DESC')]


def code_check(check_id: str) -> dict | None:
    with _connection() as connection:
        row = connection.execute('SELECT value FROM code_checks WHERE id = ?', (check_id,)).fetchone()
    return json.loads(row[0]) if row else None


def code_reviews(check_id: str) -> list[dict]:
    """A person's answers on a saved check of Точность given after it finished (set_log_review)."""
    return _reviews('code_check_reviews', check_id)


def _marks(value: Any) -> dict[str, bool]:
    """A person's decisions of one check: a criterion's key and whether its errors are serious. An older record listed
    only the keys marked serious."""
    if isinstance(value, list):
        return {key: True for key in value if isinstance(key, str)}
    if isinstance(value, dict):
        return {key: serious for key, serious in value.items() if isinstance(serious, bool)}
    return {}


def _proposed(value: Any) -> dict:
    """The model's proposals of one check: by key {serious, reason}, which model, when, and why the last one failed."""
    value = value if isinstance(value, dict) else {}
    proposals = value.get('proposals') if isinstance(value.get('proposals'), dict) else {}
    return {
        'proposals': {
            key: {'serious': row['serious'], 'reason': row.get('reason') or ''}
            for key, row in proposals.items()
            if isinstance(row, dict) and isinstance(row.get('serious'), bool)
        },
        'model': value.get('model'),
        'at': value.get('at'),
        'error': value.get('error'),
    }


def _severity_of(connection: sqlite3.Connection) -> tuple[dict[str, dict[str, bool]], dict[str, dict]]:
    marks = _document(connection, checks.SEVERITY) or {}
    proposed = _document(connection, checks.SEVERITY_PROPOSED) or {}
    return (
        {check: _marks(marks.get(check)) for check in checks.RESULTS},
        {check: _proposed(proposed.get(check)) for check in checks.RESULTS},
    )


def severity_marks() -> dict[str, dict[str, bool]]:
    """A person's decisions per check (checks.SEVERITY): a criterion's key and whether its errors are serious."""
    with _connection() as connection:
        return _severity_of(connection)[0]


def severity_proposed() -> dict[str, dict]:
    """The model's proposals per check (checks.SEVERITY_PROPOSED)."""
    with _connection() as connection:
        return _severity_of(connection)[1]


def _serious(marks: dict[str, dict[str, bool]], proposed: dict[str, dict]) -> dict[str, list[str]]:
    found = {}
    for check in checks.RESULTS:
        decided = {key: row['serious'] for key, row in proposed[check]['proposals'].items()} | marks[check]
        found[check] = sorted(key for key, serious in decided.items() if serious)
    return found


def severity() -> dict[str, list[str]]:
    """The criteria whose errors are serious, per check: a person's decision, else the model's proposal; without
    either an error is minor."""
    with _connection() as connection:
        return _serious(*_severity_of(connection))


def severity_stamp() -> str:
    """What changes with any decision or proposal, also one that leaves the same criteria serious (a person confirmed a
    proposal): the screens ask for the problems again by it."""
    with _connection() as connection:
        marks, proposed = _severity_of(connection)
    return hashlib.sha1(_json([marks, proposed]).encode()).hexdigest()[:12]


def set_severity(check: str, rule: str, serious: bool) -> dict[str, list[str]]:
    """A person decides whether the errors of one criterion of a check are serious; no proposal ever changes it. The
    serious criteria of every check after it."""
    with _connection() as connection:
        _begin(connection)
        marks, proposed = _severity_of(connection)
        marks[check][rule] = serious
        _put(connection, checks.SEVERITY, marks)
        return _serious(marks, proposed)


def confirm_severity(check: str, keys: list[str]) -> dict[str, list[str]]:
    """A person takes the model's proposals for these criteria as their own decisions; a criterion the person decided
    already or the model has not proposed for stays as it is."""
    with _connection() as connection:
        _begin(connection)
        marks, proposed = _severity_of(connection)
        proposals = proposed[check]['proposals']
        for key in keys:
            if key not in marks[check] and key in proposals:
                marks[check][key] = proposals[key]['serious']
        _put(connection, checks.SEVERITY, marks)
        return _serious(marks, proposed)


def propose_severity(check: str, proposals: dict[str, dict], model: str | None) -> None:
    """The model's proposals for some criteria of a check, beside the ones it made before; the last failure is over."""
    with _connection() as connection:
        _begin(connection)
        proposed = _severity_of(connection)[1]
        proposed[check] = {
            'proposals': proposed[check]['proposals'] | proposals,
            'model': model,
            'at': now(),
            'error': None,
        }
        _put(connection, checks.SEVERITY_PROPOSED, proposed)


def severity_failed(check: str, error: str) -> None:
    """Why the model's last proposal for a check failed; what it proposed before stays."""
    with _connection() as connection:
        _begin(connection)
        proposed = _severity_of(connection)[1]
        proposed[check] = proposed[check] | {'error': error, 'at': now()}
        _put(connection, checks.SEVERITY_PROPOSED, proposed)


def take_severity(check: str, marks: dict[str, bool], proposed: dict) -> None:
    """A check's decisions and proposals as another agent has them (rules of communication taken as a copy,
    api.copy_tone_rules)."""
    with _connection() as connection:
        _begin(connection)
        own_marks, own_proposed = _severity_of(connection)
        _put(connection, checks.SEVERITY, own_marks | {check: dict(marks)})
        _put(connection, checks.SEVERITY_PROPOSED, own_proposed | {check: _proposed(proposed)})


def tone_checks() -> list[dict]:
    with _connection() as connection:
        return [json.loads(row[0]) for row in connection.execute('SELECT summary FROM tone_checks ORDER BY rowid DESC')]


def tone_check(check_id: str) -> dict | None:
    with _connection() as connection:
        row = connection.execute('SELECT value FROM tone_checks WHERE id = ?', (check_id,)).fetchone()
    return json.loads(row[0]) if row else None


def tone_reviews(check_id: str) -> list[dict]:
    return _reviews('tone_check_reviews', check_id)


def _reviews(table: str, check_id: str) -> list[dict]:
    with _connection() as connection:
        rows = connection.execute(
            f'SELECT dialogue_id, rule_id, decision, updated_at FROM {table} '
            'WHERE check_id = ? ORDER BY dialogue_id, rule_id',
            (check_id,),
        )
        return [
            {'dialogueId': dialogue_id, 'ruleId': rule_id, 'decision': decision, 'updatedAt': updated_at}
            for dialogue_id, rule_id, decision, updated_at in rows
        ]


def tone_decisions() -> list[tuple[str, str, str, str | None]]:
    """Every saved decision on the tone checks, the newest check first: (check, conversation, criterion, decision).
    A person answers only on the current check, so the first decision found is their latest word."""
    with _connection() as connection:
        return connection.execute(
            'SELECT reviews.check_id, reviews.dialogue_id, reviews.rule_id, reviews.decision '
            'FROM tone_check_reviews AS reviews JOIN tone_checks AS checks ON checks.id = reviews.check_id '
            'ORDER BY checks.rowid DESC'
        ).fetchall()


def _save_tone_review(
    connection: sqlite3.Connection, check_id: str, dialogue_id: str, rule_id: str, decision: str | None, updated_at: str
) -> None:
    _save_review(connection, 'tone_check_reviews', (check_id, dialogue_id, rule_id, decision, updated_at))


def _save_review(connection: sqlite3.Connection, table: str, review: tuple) -> None:
    """(check, conversation, criterion, decision, when) into a table of answers on saved checks."""
    connection.execute(
        f'INSERT INTO {table} (check_id, dialogue_id, rule_id, decision, updated_at) VALUES (?, ?, ?, ?, ?) '
        'ON CONFLICT(check_id, dialogue_id, rule_id) DO UPDATE SET '
        'decision = excluded.decision, updated_at = excluded.updated_at',
        review,
    )


def save_tone_check(record: dict) -> None:
    """A finished check of tone of voice in its history (domain.tone.snapshot): its line and its immutable evidence."""
    with _connection() as connection:
        _insert_check(connection, 'tone_checks', record)


def save_tone_review(check_id: str, dialogue_id: str, rule_id: str, decision: str | None, at: str) -> None:
    """A person's answer on a saved check of tone of voice, apart from its record, which never changes."""
    with _connection() as connection:
        _save_tone_review(connection, check_id, dialogue_id, rule_id, decision, at)


def runs() -> list[dict]:
    with _connection() as connection:
        records = [json.loads(row[0]) for row in connection.execute('SELECT value FROM runs')]
    return sorted(records, key=lambda record: record.get('startedAt', ''), reverse=True)


def run_summaries() -> list[dict]:
    """Every run without its conversations, newest first: a list of runs never parses a conversation."""
    with _connection() as connection:
        # A row an older Lab wrote after the setup has no summary yet: its record stands in.
        rows = connection.execute('SELECT coalesce(summary, value) FROM runs').fetchall()
    summaries = [_summarized(json.loads(raw)) for (raw,) in rows]
    return sorted(summaries, key=lambda summary: summary.get('startedAt', ''), reverse=True)


def run(run_id: str) -> dict | None:
    with _connection() as connection:
        row = connection.execute('SELECT value FROM runs WHERE id = ?', (run_id,)).fetchone()
    return json.loads(row[0]) if row else None


def create_run(record: dict) -> dict:
    """Insert a run once. Subsequent writes must patch it, never replace a snapshot."""
    value = dict(record, check=checks.of_run(record), revision=1, updatedAt=now(), metric=metric(record['items']))
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
        _begin(connection)
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


def _rule_reviews(rows: list[dict] | None) -> dict[str, tuple[str | None, str, str | None]]:
    return {
        row['ruleId']: (row.get('status'), row['review'], row.get('agentQuote'))
        for row in rows or []
        if row.get('ruleId') and row.get('review') in ('agree', 'disagree')
    }


def _without_reviews(rows: list[dict] | None) -> list[dict]:
    return [{key: value for key, value in row.items() if key != 'review'} for row in rows or []]


def _patch_item(item: dict, fields: dict) -> None:
    """Keep human confirmation through progress, but never attach it to a changed judgment.

    A decision on the whole conversation is dropped when its status or verdicts change. A decision on one criterion
    belongs to the person, not to the producer's copy: it stays with that criterion while its verdict is the same, an
    error with the same words of the agent (quotes.same_finding)."""
    patch = {key: value for key, value in fields.items() if key != 'review'}
    changed = ('status' in patch and patch['status'] != item.get('status')) or (
        'rules' in patch and _without_reviews(patch['rules']) != _without_reviews(item.get('rules'))
    )
    kept = _rule_reviews(item.get('rules'))
    item.update(patch)
    if 'rules' in patch:
        rows = []
        for row in _without_reviews(patch['rules']):
            status, decision, quote = kept.get(row.get('ruleId'), (None, None, None))
            if decision and status == row.get('status') and quotes.same_finding(status, quote, row.get('agentQuote')):
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


def set_review(
    run_id: str,
    index: int,
    decision: str | None,
    rule_id: str | None = None,
    status: str | None = None,
    before: Any = UNSEEN,
) -> dict:
    """A person's decision on a simulated conversation: on one criterion's verdict, or (older requests) on the whole.
    With the verdict the person answered about (status), a changed verdict refuses the decision; with the answer they
    saw on it (before), an answer given meanwhile elsewhere refuses it too, never overwritten unseen."""
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
        if status and row.get('status') != status:
            raise ValueError(CHANGED)
        if before is not UNSEEN and row.get('review') != before:
            raise ValueError(ANSWERED)
        row['review'] = decision

    return _mutate_run(run_id, mutate)


def set_log_review(
    analysis: str,
    dialogue_id: str,
    rule_id: str,
    decision: str | None,
    finished_at: str | None = None,
    status: str | None = None,
    before: Any = UNSEEN,
) -> None:
    """A person's decision on one criterion's verdict in a logged conversation, kept in the log assessment.
    It lands only on the result (finished_at), the verdict (status) and the answer (before) the person saw, when they
    are given: an answer given meanwhile in another tab or browser is never overwritten unseen."""
    _decision(decision)

    def mutate(value: dict | None) -> None:
        if finished_at and (value or {}).get('finishedAt') != finished_at:
            raise ValueError(CHANGED)
        result = next((r for r in (value or {}).get('results') or [] if str(r.get('dialogueId')) == dialogue_id), None)
        row = next((row for row in (result or {}).get('rules') or [] if row.get('ruleId') == rule_id), None)
        if row is None:
            raise KeyError(rule_id)
        if status and row.get('status') != status:
            raise ValueError(CHANGED)
        if before is not UNSEEN and row.get('review') != before:
            raise ValueError(ANSWERED)
        row['review'] = decision

    with _connection() as connection:
        _begin(connection)
        value = _update_document(connection, analysis, mutate)
        # The answer stays with the saved check of this result too, which outlives the result (a new export).
        check_id = value.get('checkId')
        review = (check_id, dialogue_id, rule_id, decision, now())
        if check_id and connection.execute('SELECT 1 FROM tone_checks WHERE id = ?', (check_id,)).fetchone():
            _save_tone_review(connection, *review)
        elif check_id and connection.execute('SELECT 1 FROM code_checks WHERE id = ?', (check_id,)).fetchone():
            _save_review(connection, 'code_check_reviews', review)


def recover_runs() -> int:
    """On process startup, finish interrupted runs whose worker no longer exists."""
    recovered = 0
    with _connection() as connection:
        _begin(connection)
        for (raw,) in connection.execute('SELECT value FROM runs').fetchall():
            record = json.loads(raw)
            if record.get('status') != 'running':
                continue
            error = 'Прогон остановился вместе с сервисом.'
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
        _begin(connection)
        for name, value in documents.items():
            counts['documents'] += connection.execute(
                'INSERT OR IGNORE INTO documents (name, value) VALUES (?, ?)', (name, _json(value))
            ).rowcount
        for record in records:
            value = dict(record)
            value.setdefault('check', checks.of_run(value))
            value.setdefault('revision', 1)
            value.setdefault('updatedAt', value.get('finishedAt') or value.get('startedAt') or now())
            counts['runs'] += connection.execute(
                'INSERT OR IGNORE INTO runs (id, value, summary) VALUES (?, ?, ?)',
                (value['id'], _json(value), _summary(value)),
            ).rowcount
    return counts

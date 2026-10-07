"""Grouped launches and recorded-question runs, stored apart from legacy synthetic-client runs. Each is kept whole (get)
and as its line in a list (listed): what it is and how it stands, never its conversations and inputs, the text of its
rules, the agent's context or what its metrics hold beyond their counts."""

import json

from ..domain import judges
from . import db

# What a line keeps of a record, of each of its modes and of a metric.
LINE = (
    'id', 'check', 'mode', 'target', 'status', 'error', 'startedAt', 'finishedAt', 'agentVersion', 'dataset', 'version',
)  # fmt: skip
OUTCOME = ('status', 'error', 'checkId', 'questionsId', 'runId')
COUNTS = ('failed', 'measured', 'unmeasured', 'passed', 'assessed')


def save(kind: str, record: dict) -> None:
    with db.connect() as connection:
        connection.execute(
            'INSERT INTO launches(id,kind,summary,value) VALUES(?,?,?,?) '
            'ON CONFLICT(id) DO UPDATE SET summary=excluded.summary,value=excluded.value',
            (record['id'], kind, db.dump(_line(record)), db.dump(record)),
        )


def get(kind: str, record_id: str) -> dict | None:
    with db.connect() as connection:
        row = connection.execute('SELECT value FROM launches WHERE kind=? AND id=?', (kind, record_id)).fetchone()
    return json.loads(row[0]) if row else None


def listed(kind: str) -> list[dict]:
    """The lines of one kind, the newest first; a line written whole by an earlier Lab is cut to a line here."""
    with db.connect() as connection:
        rows = connection.execute('SELECT summary FROM launches WHERE kind=? ORDER BY rowid DESC', (kind,))
        return [_line(json.loads(row[0])) for row in rows]


def _line(record: dict) -> dict:
    """A record as its list shows it: its own fields of LINE, the set and version of its rules (judges.brief), and of
    each mode how it stands, its results by id and its counts."""
    line = {key: record[key] for key in LINE if key in record}
    if 'judge' in record:
        line['judge'] = record['judge'] and judges.brief(record['judge'])
    if 'metric' in record:
        line['metric'] = _counts(record['metric'])
    if 'modes' in record:
        line['modes'] = {mode: _outcome(outcome) for mode, outcome in record['modes'].items()}
    return line


def _outcome(outcome: dict) -> dict:
    kept = {key: outcome[key] for key in OUTCOME if key in outcome}
    if 'metric' in outcome:
        kept['metric'] = _counts(outcome['metric'])
    return kept


def _counts(metric: dict | None) -> dict | None:
    return metric and {key: metric[key] for key in COUNTS if key in metric}

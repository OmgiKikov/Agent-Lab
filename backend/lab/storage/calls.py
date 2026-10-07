"""The journal of calls to the models (models.chat): one line per try, with the role and the version of its
instructions, what the call was about, the model, the time, the tokens, the cost when the model named it and how it
ended. Never the words of a conversation."""

from . import db

# The journal's columns by the names its lines carry (models._journal).
COLUMNS = {
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


def add(line: dict) -> int:
    """One call to a model in the journal; its id, for the outcome found later (outcome)."""
    names = ', '.join(COLUMNS.values())
    marks = ', '.join('?' for _ in COLUMNS)
    with db.connect() as connection:
        cursor = connection.execute(f'INSERT INTO calls ({names}) VALUES ({marks})', [line.get(key) for key in COLUMNS])
        return int(cursor.lastrowid)


def outcome(call_id: int, outcome: str, detail: str) -> None:
    """How a call ended, when it is known only after the answer is read: an answer nobody could use."""
    with db.connect() as connection:
        connection.execute('UPDATE calls SET outcome = ?, detail = ? WHERE id = ?', (outcome, detail, call_id))


def listed(subject: str | None = None) -> list[dict]:
    """The journal, the oldest call first; only the calls about one subject when it is named."""
    names = ', '.join(COLUMNS.values())
    where, values = ('WHERE subject = ?', (subject,)) if subject is not None else ('', ())
    with db.connect() as connection:
        rows = connection.execute(f'SELECT id, {names} FROM calls {where} ORDER BY id', values).fetchall()
    return [{'id': row[0], **dict(zip(COLUMNS, row[1:], strict=True))} for row in rows]

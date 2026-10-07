"""Immutable uploaded datasets and the working export selected from them. Archiving never erases evidence."""

import json
import uuid

from . import db, dialogues, documents


def _item(row: tuple) -> dict:
    return dict(zip(('id', 'name', 'file', 'createdAt', 'bytes', 'archivedAt', 'total'), row, strict=True))


SELECT = (
    'SELECT d.id, d.name, d.file, d.created_at, d.bytes, d.archived_at, '
    '(SELECT count(*) FROM dataset_dialogues WHERE dataset_id=d.id) FROM datasets d'
)


def listed(*, archived: bool = False) -> list[dict]:
    with db.connect() as connection:
        clause = '' if archived else ' WHERE d.archived_at IS NULL'
        return [_item(row) for row in connection.execute(SELECT + clause + ' ORDER BY d.created_at DESC, d.rowid DESC')]


def get(dataset_id: str) -> dict | None:
    with db.connect() as connection:
        row = connection.execute(SELECT + ' WHERE d.id=?', (dataset_id,)).fetchone()
        return _item(row) if row else None


def create(items: list[dict], file: str, name: str, size: int = 0) -> dict:
    dataset_id = uuid.uuid4().hex
    with db.connect() as connection:
        db.begin(connection)
        connection.execute(
            'INSERT INTO datasets(id,name,file,created_at,bytes) VALUES(?,?,?,?,?)',
            (dataset_id, name, file, db.now(), size),
        )
        connection.executemany(
            'INSERT INTO dataset_dialogues(dataset_id,position,id,value) VALUES(?,?,?,?)',
            ((dataset_id, i, str(item['id']), db.dump(item)) for i, item in enumerate(items, 1)),
        )
    return get(dataset_id)


def adopt_current() -> str | None:
    """Preserve a pre-library export in place, without decoding all its conversations or changing its stamp."""
    meta = dialogues.meta()
    if meta.get('datasetId'):
        return meta['datasetId']
    if not dialogues.count():
        return None
    dataset_id = uuid.uuid4().hex
    with db.connect() as connection:
        db.begin(connection)
        connection.execute(
            'INSERT INTO datasets(id,name,file,created_at) VALUES(?,?,?,?)',
            (dataset_id, meta.get('file') or 'Первая выгрузка', meta.get('file'), meta.get('updatedAt') or db.now()),
        )
        connection.execute('INSERT INTO dataset_dialogues SELECT ?, position, id, value FROM dialogues', (dataset_id,))
        documents.put(connection, dialogues.META, meta | {'datasetId': dataset_id})
    return dataset_id


def activate(dataset_id: str) -> dict:
    item = get(dataset_id)
    if item is None or item['archivedAt']:
        raise ValueError('Датасет не найден или находится в архиве.')
    with db.connect() as connection:
        db.begin(connection)
        connection.execute('DELETE FROM dialogues')
        connection.execute(
            'INSERT INTO dialogues SELECT position,id,value FROM dataset_dialogues WHERE dataset_id=?', (dataset_id,)
        )
        documents.put(
            connection,
            dialogues.META,
            {
                'file': item['file'],
                'name': item['name'],
                'updatedAt': item['createdAt'],
                'datasetId': dataset_id,
            },
        )
    return item


def save_context(dataset_id: str, context: dict) -> None:
    with db.connect() as connection:
        connection.execute('UPDATE datasets SET context=? WHERE id=?', (db.dump(context), dataset_id))


def context(dataset_id: str) -> dict:
    with db.connect() as connection:
        row = connection.execute('SELECT context FROM datasets WHERE id=?', (dataset_id,)).fetchone()
    return json.loads(row[0]) if row and row[0] else {}


def archive(dataset_id: str, *, undo: bool = False) -> None:
    if get(dataset_id) is None:
        raise ValueError('Датасет не найден.')
    with db.connect() as connection:
        connection.execute('UPDATE datasets SET archived_at=? WHERE id=?', (None if undo else db.now(), dataset_id))


def rename(dataset_id: str, name: str) -> None:
    if get(dataset_id) is None:
        raise ValueError('Датасет не найден.')
    with db.connect() as connection:
        connection.execute('UPDATE datasets SET name=? WHERE id=?', (name, dataset_id))


def page(dataset_id: str, offset: int, limit: int) -> list[dict]:
    with db.connect() as connection:
        rows = connection.execute(
            'SELECT value FROM dataset_dialogues WHERE dataset_id=? ORDER BY position LIMIT ? OFFSET ?',
            (dataset_id, limit, offset),
        )
        return [json.loads(row[0]) for row in rows]

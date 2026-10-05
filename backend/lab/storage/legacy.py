"""The legacy import (python -m lab.migrate): the documents and runs of an older Lab's JSON files, inserted beside what
the database has. What the database has wins, the answers people gave since included: a document or a run it has is
not imported, and the export comes only into a database that never had one. What was inserted is then brought to this
schema as an older database is (schema.upgrade): its export becomes rows, its answers rows of their own."""

from typing import Any

from . import db, dialogues, runs, schema

EXPORT = schema.EXPORT  # the export's conversations among the legacy documents, under the name of its old file


def insert(found: dict[str, Any], records: list[dict]) -> dict[str, int]:
    """The legacy documents (by name) and runs; how many of each were inserted."""
    counts = {'documents': 0, 'runs': 0}
    with db.transaction(), db.connect() as connection:
        for name, value in found.items():
            if name == EXPORT and dialogues.uploaded():
                continue  # an export was uploaded here, possibly one with no conversation: it stays
            counts['documents'] += connection.execute(
                'INSERT OR IGNORE INTO documents (name, value) VALUES (?, ?)', (name, db.dump(value))
            ).rowcount
        for record in records:
            counts['runs'] += runs.insert_if_new(connection, record)
        schema.upgrade(connection)
    return counts

"""The legacy import (python -m lab.migrate): the documents and runs of an older Lab's JSON files, inserted beside what
the database has. What the database has wins, the answers people gave since included: a document or a run it has is
not imported, and the export, with the results made of it, comes only into a database that has none. What was inserted
is then brought to this schema as an older database is (schema.upgrade): its export becomes rows, its answers rows of
their own."""

from typing import Any

from ..domain import checks
from . import db, exports, runs, schema

EXPORT = schema.EXPORT  # the export's conversations among the legacy documents, under the name of its old file
# What comes only with the export of the legacy files: the record of its file, and the results made of it.
WITH_EXPORT = {EXPORT, schema.EXPORT_META, *checks.RESULTS.values()}


def insert(found: dict[str, Any], records: list[dict]) -> dict[str, int]:
    """The legacy documents (by name) and runs; how many of each were inserted."""
    counts = {'documents': 0, 'runs': 0}
    with db.transaction(), db.connect() as connection:
        # Asked before anything is inserted: the legacy files may bring the record of their own export with it.
        uploaded = bool(exports.listed())
        for name, value in found.items():
            if name in WITH_EXPORT and uploaded:
                continue  # exports were uploaded here: they stay, and results of another export would name none
            counts['documents'] += connection.execute(
                'INSERT OR IGNORE INTO documents (name, value) VALUES (?, ?)', (name, db.dump(value))
            ).rowcount
        for record in records:
            counts['runs'] += runs.insert_if_new(connection, record)
        schema.upgrade(connection)
    return counts

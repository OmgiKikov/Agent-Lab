"""The exports as the screens read them: each with the latest saved check of both checks made of it, and its
conversations a page at a time. Reads stored records only: no model is called."""

from .. import storage
from ..domain import checks
from . import inputs
from .checks import current

PAGE = 50  # conversations of an export shown at a time


def listed() -> list[dict]:
    """Every export, the newest first, with the latest saved check of each check made of it: its counts, and whether it
    is the check's current result (`current`)."""
    lines = {check: storage.history.lines(check) for check in checks.RESULTS}
    now = {check: (current(check) or {}).get('checkId') for check in checks.RESULTS}

    def latest(check: str, export_id: str) -> dict | None:
        found = next((line for line in lines[check] if (line.get('export') or {}).get('id') == export_id), None)
        if found is None:
            return None
        return {
            'id': found['id'],
            'finishedAt': found['finishedAt'],
            'summary': found['summary'],
            'current': found['id'] == now[check],
        }

    return [
        export | {'checks': {check: latest(check, export['id']) for check in checks.RESULTS}}
        for export in storage.exports.listed()
    ]


def first_words(dialogue: dict) -> str:
    """What the customer wrote first, on one line: how a conversation is told apart in a list."""
    text = next((m.get('content') for m in dialogue.get('messages') or [] if m.get('role') == 'user'), '')
    return ' '.join(str(text or '').split())[:240]


def page(export_id: str, offset: int, limit: int) -> dict | None:
    """A page of an export's conversations in its order: each one's id, its first words and how many messages it has.
    None when there is no such export."""
    if storage.exports.get(export_id) is None:
        return None
    ids = storage.exports.ids(export_id)
    found = storage.exports.read(export_id, ids[offset : offset + limit])
    items = [{'id': str(d['id']), 'first': first_words(d), 'turns': len(d.get('messages') or [])} for d in found]
    return {'total': len(ids), 'items': items}


def remove(export_id: str) -> dict:
    """An export removed (inputs.remove_export), and which checks' current results went with it, for the screens to
    say so. LookupError when it is gone already."""
    before = {check for check in checks.RESULTS if storage.documents.load(checks.result(check))}
    removed = inputs.remove_export(export_id)
    after = {check for check in checks.RESULTS if storage.documents.load(checks.result(check))}
    return {'removed': removed, 'cleared': [check for check in checks.RESULTS if check in before - after]}

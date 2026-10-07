"""Small immutable rubric versions per agent; selecting or editing never overwrites old evidence."""

import uuid

from ..domain import judges as rules
from . import db, documents

LIBRARY, SELECTED = 'judge-library.json', 'judge-selection.json'


def listed(kind: str) -> list[dict]:
    return [v for v in (documents.load(LIBRARY, []) or []) if v['kind'] == kind]


def get(version_id: str) -> dict | None:
    return next((v for v in (documents.load(LIBRARY, []) or []) if v['id'] == version_id), None)


def active(kind: str) -> dict | None:
    return get((documents.load(SELECTED, {}) or {}).get(kind, ''))


def select(kind: str, version_id: str | None) -> None:
    documents.save(SELECTED, (documents.load(SELECTED, {}) or {}) | {kind: version_id})


def save(
    kind: str,
    name: str,
    policy: str,
    criteria: list[dict],
    *,
    set_id: str | None = None,
    base_id: str | None = None,
    builtin: bool = False,
) -> dict:
    with db.transaction():
        library = documents.load(LIBRARY, []) or []
        own = [v for v in library if v['setId'] == set_id]
        if own and base_id is not None and own[-1]['id'] != base_id:
            raise ValueError('Набор уже изменён. Обновите его перед сохранением новой версии.')
        if any(v['builtin'] for v in own):
            raise ValueError('Встроенный набор нельзя изменить. Сохраните его копию под новым названием.')
        value = {
            'id': uuid.uuid4().hex,
            'setId': set_id or uuid.uuid4().hex,
            'kind': kind,
            'name': name,
            'policy': policy,
            'criteria': criteria,
            'builtin': builtin,
            'version': len(own) + 1,
            'createdAt': db.now(),
        }
        documents.save(LIBRARY, [*library, value])
        return value


def ensure(kind: str) -> None:
    with db.transaction():
        if not any(v['builtin'] for v in listed(kind)):
            save(kind, **rules.builtin(kind), builtin=True)


def capture_tone(draft: dict, policy: dict) -> dict:
    """Generated or clarified criteria also enter the library; the active built-in becomes a user-owned copy."""
    current = active('tone')
    if current and current['criteria'] == draft['criteria'] and current['policy'] == policy['content']:
        return current
    own = current and not current['builtin'] and current['policy'] == policy['content']
    value = save(
        'tone',
        current['name'] if own else policy.get('origin') or 'Правила общения',
        policy['content'],
        draft['criteria'],
        set_id=current['setId'] if own else None,
    )
    select('tone', value['id'])
    return value

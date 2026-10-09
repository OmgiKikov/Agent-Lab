"""Small immutable rubric versions per agent; selecting or editing never overwrites old evidence. Every version is one
people made: a database may still hold the rule sets an earlier Lab wrote itself (builtin), which were never the bank's
rules, and none of them is listed, found or in force."""

import uuid

from . import db, documents

LIBRARY, SELECTED = 'judge-library.json', 'judge-selection.json'


def listed(kind: str) -> list[dict]:
    return [v for v in _made() if v['kind'] == kind]


def get(version_id: str) -> dict | None:
    return next((v for v in _made() if v['id'] == version_id), None)


def selected(kind: str) -> str | None:
    """The id selected for a kind, as it is kept: it may name a set an earlier Lab wrote itself, which is no version."""
    return (documents.load(SELECTED, {}) or {}).get(kind)


def active(kind: str) -> dict | None:
    """The version in force for a kind; none when nothing is selected or the selection names no version (selected)."""
    return get(selected(kind) or '')


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
    at: str | None = None,
) -> dict:
    """A new version of a set (set_id), or the first of a new set; at: when its criteria were made, if not now."""
    with db.transaction():
        own = [v for v in _made() if v['setId'] == set_id]
        if own and base_id is not None and own[-1]['id'] != base_id:
            raise ValueError('Набор уже изменён. Обновите его перед сохранением новой версии.')
        value = {
            'id': uuid.uuid4().hex,
            'setId': set_id or uuid.uuid4().hex,
            'kind': kind,
            'name': name,
            'policy': policy,
            'criteria': criteria,
            'builtin': False,  # never: the screens still read the key
            'version': len(own) + 1,
            'createdAt': at or db.now(),
        }
        documents.save(LIBRARY, [*(documents.load(LIBRARY, []) or []), value])
        return value


def capture_tone(draft: dict, policy: dict, *, adopted: bool = False) -> dict:
    """Generated or clarified criteria also enter the library: as a new version of the set in force when they come from
    its rules or from its document updated under the same name, else as a set of their own. A version is dated when it
    is saved; criteria made before the library and adopted into it (adopted) keep the day they were made."""
    current = active('tone')
    if current and current['criteria'] == draft['criteria'] and current['policy'] == policy['content']:
        return current
    name = policy.get('origin') or 'Правила общения'
    own = current and (current['policy'] == policy['content'] or current['name'] == name)
    if not own:
        # New rules deselect the set in force (flows.inputs.replace_sources): the document updated under the same name
        # is found by its name among the sets people made.
        current = next((v for v in reversed(_made()) if v['kind'] == 'tone' and v['name'] == name), None)
        own = current is not None
    value = save(
        'tone',
        current['name'] if own else name,
        policy['content'],
        draft['criteria'],
        set_id=current['setId'] if own else None,
        at=draft.get('createdAt') if adopted else None,
    )
    select('tone', value['id'])
    return value


def _made() -> list[dict]:
    """The versions people made, the oldest first, without the rule sets an earlier Lab wrote itself."""
    return [v for v in documents.load(LIBRARY, []) or [] if not v.get('builtin')]

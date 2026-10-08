"""Select one immutable dataset as the working export; keep each dataset's compatible results and scenarios, and its
catalog of business scenarios with them."""

from .. import storage
from ..domain import accuracy, catalog, checks, export
from . import agent_context, same_work

CONTEXT = (*checks.RESULTS.values(), checks.DECK, checks.CATALOG)


def _signatures() -> dict[str, str]:
    sources = storage.documents.load('sources.json', []) or []

    def is_tone(source: dict) -> bool:
        return source.get('id') == checks.TONE_OF_VOICE or source.get('kind') == checks.TONE_OF_VOICE

    return {
        checks.TONE: same_work(
            sources=[s for s in sources if is_tone(s)],
            revision=(storage.documents.load('tone-of-voice-criteria.json') or {}).get('revision'),
        ),
        checks.CODE: same_work(
            sources=[s for s in sources if not is_tone(s)],
            judge=(storage.judges.active('code') or {}).get('criteria'),
            context=agent_context.current(),
        ),
    }


def _stash() -> str | None:
    active = storage.datasets.adopt_current()
    if active:
        storage.datasets.save_context(
            active,
            {
                'signatures': _signatures(),
                'documents': {key: storage.documents.load(key) for key in CONTEXT},
            },
        )
    previous = storage.documents.load(checks.RESULTS[checks.CODE])
    if previous and previous.get('topics'):
        storage.documents.save(checks.CODE_CRITERIA, accuracy.criteria_of(previous))
    return active


def listed(*, archived: bool = False) -> dict:
    with storage.transaction():
        active = storage.datasets.adopt_current()
        return {'activeId': active, 'datasets': storage.datasets.listed(archived=archived)}


def dialogues(dataset_id: str, offset: int, limit: int) -> dict | None:
    """A page of one dataset's conversations in the order of its file, archived or not. Reading a dataset never makes
    it the working export: the checks' results stay as they are."""
    item = storage.datasets.get(dataset_id)
    if item is None:
        return None
    page = storage.datasets.page(dataset_id, offset, limit)
    return {'total': item['total'], 'offset': offset, 'items': [export.preview(d) for d in page]}


def dialogue(dataset_id: str, dialogue_id: str) -> dict | None:
    """One conversation of a dataset as its file has it."""
    return storage.datasets.dialogue(dataset_id, dialogue_id)


def _activate(dataset_id: str) -> dict:
    item = storage.datasets.activate(dataset_id)
    context = storage.datasets.context(dataset_id)
    documents = context.get('documents', {})
    signatures = _signatures()
    valid = {kind for kind, signature in signatures.items() if context.get('signatures', {}).get(kind) == signature}
    for kind, name in checks.RESULTS.items():
        storage.documents.save(name, documents.get(name) if kind in valid else None)
    deck = documents.get(checks.DECK)
    # A deck built without a check (None) carries no criteria: nothing in it can go stale, it comes back as it was.
    kept = deck and 'check' in deck and (deck['check'] is None or deck['check'] in valid)
    storage.documents.save(checks.DECK, deck if kept else None)
    # The catalog comes back with its dataset: its readings and counts are of that export. A dataset that never had
    # one keeps the scenarios in use, without another export's readings: its conversations are placed in the same ones.
    if checks.CATALOG in documents:
        storage.documents.save(checks.CATALOG, documents[checks.CATALOG])
    else:
        storage.documents.save(checks.CATALOG, _scenarios_only(storage.documents.load(checks.CATALOG)))
    return item


def _scenarios_only(found: dict | None) -> dict | None:
    """A catalog's scenarios without the readings, counts and examples of the export it was built from."""
    if not found or not found.get('categories'):
        return None
    return {'revision': found['revision'], 'model': found.get('model'), 'categories': catalog.bare(found['categories'])}


def select(dataset_id: str) -> dict:
    with storage.transaction():
        if _stash() == dataset_id:
            return storage.datasets.get(dataset_id)
        return _activate(dataset_id)


def add(items: list[dict], file: str, name: str | None = None, size: int = 0, skipped: int | None = None) -> dict:
    title = (name or '').strip() or file
    if len(title) > 160:
        raise ValueError('Название датасета должно быть не длиннее 160 символов.')
    with storage.transaction():
        _stash()
        item = storage.datasets.create(items, file, title, size, skipped)
        return _activate(item['id'])


def archive(dataset_id: str, *, undo: bool = False) -> dict:
    with storage.transaction():
        current = _stash()
        storage.datasets.archive(dataset_id, undo=undo)
        if undo and current is None:
            _activate(dataset_id)
        if not undo and current == dataset_id:
            remaining = storage.datasets.listed()
            if remaining:
                _activate(remaining[0]['id'])
            else:
                storage.dialogues.replace([])
                for name in CONTEXT:
                    storage.documents.save(name, None)
        return listed()


def rename(dataset_id: str, name: str) -> dict:
    name = name.strip()
    if not name or len(name) > 160:
        raise ValueError('Название должно содержать от 1 до 160 символов.')
    with storage.transaction():
        storage.datasets.rename(dataset_id, name)
        if storage.dialogues.meta().get('datasetId') == dataset_id:
            storage.documents.save(storage.dialogues.META, storage.dialogues.meta() | {'name': name})
        return storage.datasets.get(dataset_id)

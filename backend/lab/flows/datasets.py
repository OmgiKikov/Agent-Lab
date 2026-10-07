"""Select one immutable dataset as the working export; keep each dataset's compatible results and scenarios."""

from .. import storage
from ..domain import accuracy, checks
from . import agent_context, same_work

CONTEXT = (*checks.RESULTS.values(), checks.DECK)


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


def _activate(dataset_id: str) -> dict:
    item = storage.datasets.activate(dataset_id)
    context = storage.datasets.context(dataset_id)
    documents = context.get('documents', {})
    signatures = _signatures()
    valid = {kind for kind, signature in signatures.items() if context.get('signatures', {}).get(kind) == signature}
    for kind, name in checks.RESULTS.items():
        storage.documents.save(name, documents.get(name) if kind in valid else None)
    deck = documents.get(checks.DECK)
    storage.documents.save(checks.DECK, deck if deck and deck.get('check') in valid else None)
    return item


def select(dataset_id: str) -> dict:
    with storage.transaction():
        if _stash() == dataset_id:
            return storage.datasets.get(dataset_id)
        return _activate(dataset_id)


def add(items: list[dict], file: str, name: str | None = None, size: int = 0) -> dict:
    title = (name or '').strip() or file
    if len(title) > 160:
        raise ValueError('Название датасета должно быть не длиннее 160 символов.')
    with storage.transaction():
        _stash()
        item = storage.datasets.create(items, file, title, size)
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

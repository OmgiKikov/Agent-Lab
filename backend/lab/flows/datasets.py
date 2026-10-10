"""Select one immutable dataset as the working export; keep each dataset's compatible results and scenarios."""

from collections.abc import Callable

from .. import storage
from ..domain import accuracy, checks, export
from . import agent_context, same_work, sources_content

CONTEXT = (*checks.RESULTS.values(), checks.DECK)


def _signatures(signed: Callable[[list[dict]], object] = sources_content) -> dict[str, str]:
    """What the results of each check kept with a dataset stand on, so they come back with it only while it stands:
    tone of voice's rules and the revision of their criteria; the agent's code, the rules of Точность in force and the
    agent's context. The sources are told by their content (signed): rules renamed are the same rules. A Lab before
    told them by their whole records (_activate)."""
    sources = storage.documents.load('sources.json', []) or []

    def is_tone(source: dict) -> bool:
        return source.get('id') == checks.TONE_OF_VOICE or source.get('kind') == checks.TONE_OF_VOICE

    return {
        checks.TONE: same_work(
            sources=signed([s for s in sources if is_tone(s)]),
            revision=(storage.documents.load('tone-of-voice-criteria.json') or {}).get('revision'),
        ),
        checks.CODE: same_work(
            sources=signed([s for s in sources if not is_tone(s)]),
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
    # Results kept by a Lab that signed the sources by their whole records stand while those records are the same.
    now, before = _signatures(), _signatures(list)
    kept = context.get('signatures', {})
    valid = {kind for kind in checks.RESULTS if kept.get(kind) in (now[kind], before[kind])}
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


def add(
    items: list[dict],
    file: str,
    name: str | None = None,
    size: int = 0,
    skipped: int | None = None,
    agent_version: str | None = None,
) -> dict:
    title = (name or '').strip() or file
    if len(title) > 160:
        raise ValueError('Название датасета должно быть не длиннее 160 символов.')
    version = _version(agent_version or '')
    with storage.transaction():
        _stash()
        item = storage.datasets.create(items, file, title, size, skipped, version)
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


def set_version(dataset_id: str, agent_version: str | None) -> dict:
    """«Версия агента» of a dataset: the version of the agent whose answers it holds, as a person names it
    (trimmed); '' says it is not known."""
    if agent_version is None:
        raise ValueError('Укажите версию агента.')
    version = _version(agent_version)
    with storage.transaction():
        storage.datasets.set_version(dataset_id, version)
        return storage.datasets.get(dataset_id)


def _version(agent_version: str) -> str:
    version = agent_version.strip()
    if len(version) > 80:
        raise ValueError('Версия агента должна быть не длиннее 80 символов.')
    return version


def rename(dataset_id: str, name: str) -> dict:
    name = name.strip()
    if not name or len(name) > 160:
        raise ValueError('Название должно содержать от 1 до 160 символов.')
    with storage.transaction():
        storage.datasets.rename(dataset_id, name)
        if storage.dialogues.meta().get('datasetId') == dataset_id:
            storage.documents.save(storage.dialogues.META, storage.dialogues.meta() | {'name': name})
        return storage.datasets.get(dataset_id)

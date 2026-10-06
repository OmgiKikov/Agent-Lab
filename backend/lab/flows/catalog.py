"""The catalog of business scenarios (domain/catalog.py): every conversation of the export read into an episode, the
categories and scenarios proposed from all their tasks, and every episode placed in one scenario.

An episode is read once: a conversation already read by the same version of the reader keeps its reading. The catalog is
frozen: a build places the new episodes into the scenarios found before, and a rebuild (rebuild=True) proposes them
again, a new revision, and places every episode anew. An episode the model cannot read is left out with its reason and
never stops the others; when more than MISSED of them are left unread or unplaced (a busy model refuses many in a row),
the build stops instead of counting the catalog on part of the export, and the next one goes on from there.

A build keeps its paid work as it goes: the readings every CHECKPOINT of them, the scenarios as soon as they are
proposed (beside the catalog in use, which stays whole until the new one is placed) and the placements after every
batch, also when the build is stopped. The next build goes on with them instead of asking the model again.
"""

import asyncio
import uuid
from collections import Counter
from collections.abc import Callable

from .. import models, storage
from ..domain import catalog, checks
from ..roles import catalog as catalog_role
from . import Progress

CATALOG = checks.CATALOG
BATCH = 40  # episodes the router places in one answer
# The share of conversations the model may leave unread or unplaced: above it a catalog would miss them, so the build
# stops and says so; what was read and placed is kept, and the next build goes on from there.
MISSED = 0.05
# Acquiring episodes the catalog role reads at most, a random sample of them: the scenarios of a frequent task are found
# in it, a rare task falls to none and its share is told; the router places every episode. One answer about the
# tasks of the whole export took a model over four minutes.
SAMPLE = 300
CHECKPOINT = 20  # readings between two saves of a build in progress: a stopped build loses at most these


def current() -> dict | None:
    return storage.documents.load(CATALOG)


async def build(progress: Progress = lambda **_: None, *, rebuild: bool = False) -> dict:
    """The catalog of the export, saved: the episodes read, the scenarios proposed (once, or again on rebuild) and
    every acquiring episode placed."""
    with models.about(f'catalog:{uuid.uuid4().hex}'):
        return await _build(progress, rebuild)


async def _build(progress: Progress, rebuild: bool) -> dict:
    dialogues = {str(d['id']): d for d in storage.dialogues.read()}
    if not dialogues:
        raise RuntimeError('Нет разговоров: сначала загрузите выгрузку.')
    previous = current() or {}
    episodes = await _episodes(dialogues, previous.get('episodes') or {}, progress, _keep_readings)
    _enough(episodes, 'error', 'не прочитала')
    categories, model = previous.get('categories'), previous.get('model')
    # Scenarios proposed by a build that stopped before placing every episode: they are placed, not proposed again.
    proposal = None if rebuild else previous.get('proposed')
    if proposal:
        categories, model = proposal['categories'], proposal['model']
        placements = proposal.get('placements') or {}
        for dialogue_id, episode in episodes.items():
            episode.pop('scenarioId', None)
            if dialogue_id in placements:
                episode['scenarioId'] = placements[dialogue_id]
    elif rebuild or not categories:
        progress(stage='catalog', done=0, total=1, message='Выделяем бизнес-сценарии')
        tasks = catalog.distinct_tasks(catalog.sample(episodes, SAMPLE))
        if not tasks:
            raise RuntimeError('Ни в одном разговоре нет задачи по эквайрингу.')
        answer = await catalog_role.propose(tasks)
        categories, model = answer.value, answer.model
        for episode in episodes.values():
            episode.pop('scenarioId', None)
        proposal = {'categories': categories, 'model': model}
        storage.documents.save(CATALOG, {**(current() or {}), 'proposed': proposal})
    else:
        categories = catalog.bare(categories)

    def keep_placements() -> None:
        """The placements so far: of the proposed scenarios beside the catalog in use, or of its own in it."""
        saved = current() or {}
        if proposal:
            placed = {i: e['scenarioId'] for i, e in episodes.items() if e.get('scenarioId')}
            saved['proposed'] = {**proposal, 'placements': placed}
        else:
            saved['episodes'] = episodes
        storage.documents.save(CATALOG, saved)

    await _place(categories, episodes, dialogues, progress, keep_placements)
    document = {
        'revision': catalog.revision(categories),
        'builtAt': storage.now(),
        'model': model,
        **catalog.counted(categories, episodes, dialogues),
        'episodes': episodes,
    }
    storage.documents.save(CATALOG, document)
    _enough({i: e for i, e in episodes.items() if e.get('acquiring')}, 'unplaced', 'не разложила по сценариям')
    return document


def _keep_readings(episodes: dict[str, dict]) -> None:
    """The readings so far, in the catalog in use: a reading is the same whatever scenarios it is placed in."""
    storage.documents.save(CATALOG, {**(current() or {}), 'episodes': episodes})


def _enough(episodes: dict[str, dict], key: str, what: str) -> None:
    """A RuntimeError when more than MISSED of the episodes are missed (key: 'error', unread; 'unplaced', placed in no
    scenario of the catalog nor in none), with the model's most frequent reason."""
    missed = [e for e in episodes.values() if (e.get('error') if key == 'error' else not e.get('scenarioId'))]
    if len(missed) > MISSED * len(episodes):
        reason = Counter(e.get('error') or 'ответ без раскладки' for e in missed).most_common(1)[0][0]
        raise RuntimeError(
            f'Модель {what} {len(missed)} из {len(episodes)} разговоров ({reason}). '
            'Сделанное сохранено: запустите сборку ещё раз, она продолжит с этого места.'
        )


async def _episodes(
    dialogues: dict[str, dict], known: dict[str, dict], progress: Progress, keep: Callable[[dict], None]
) -> dict[str, dict]:
    """Every conversation's episode: the known reading when the conversation and the reader's version are the same,
    else read now. Order of the export. keep is given the readings so far every CHECKPOINT readings and when the
    reading ends, stopped or not; a conversation not read yet keeps its known reading there."""
    version = catalog_role.EPISODE.version
    episodes, todo = {}, []
    for dialogue_id, dialogue in dialogues.items():
        found = known.get(dialogue_id) or {}
        same = found.get('fingerprint') == catalog.fingerprint(dialogue) and found.get('version') == version
        if same and not found.get('error'):  # an episode the model could not read is read again
            episodes[dialogue_id] = found
        else:
            todo.append(dialogue_id)
    done = 0

    async def one(dialogue_id: str) -> None:
        nonlocal done
        dialogue = dialogues[dialogue_id]
        stamp = {'fingerprint': catalog.fingerprint(dialogue), 'version': version}
        try:
            answer = await catalog_role.episode(dialogue)
            episodes[dialogue_id] = {**stamp, **answer.value}
        except models.ModelError as error:
            episodes[dialogue_id] = {**stamp, 'acquiring': False, 'error': str(error)}
        done += 1
        if done % CHECKPOINT == 0:
            keep(so_far())
        progress(stage='episodes', done=done, total=len(todo), message=f'Читаем разговоры: {done} из {len(todo)}')

    def so_far() -> dict[str, dict]:
        return {i: episodes.get(i) or known[i] for i in dialogues if i in episodes or i in known}

    if todo:
        progress(stage='episodes', done=0, total=len(todo), message=f'Читаем разговоры: 0 из {len(todo)}')
        try:
            async with asyncio.TaskGroup() as tasks:
                for dialogue_id in todo:
                    tasks.create_task(one(dialogue_id))
        finally:
            keep(so_far())
    return {dialogue_id: episodes[dialogue_id] for dialogue_id in dialogues}


async def _place(
    categories: list[dict],
    episodes: dict[str, dict],
    dialogues: dict[str, dict],
    progress: Progress,
    keep: Callable[[], None],
) -> None:
    """Every acquiring episode not placed yet, placed in batches; one the router fails is left for the next build. keep
    saves the placements after every batch and when the placing ends, stopped or not."""
    scenarios = [
        {'id': s['id'], 'category': c['title'], 'title': s['title'], 'description': s['description']}
        for c in categories
        for s in c['scenarios']
    ]
    known = {s['id'] for s in scenarios} | {catalog.NONE}
    for episode in episodes.values():
        if episode.get('scenarioId') not in known:
            episode.pop('scenarioId', None)
    todo = [i for i, e in episodes.items() if e.get('acquiring') and not e.get('scenarioId')]
    batches = [todo[start : start + BATCH] for start in range(0, len(todo), BATCH)]
    done = 0

    async def one(batch: list[str]) -> None:
        nonlocal done
        short = {f'e{n}': dialogue_id for n, dialogue_id in enumerate(batch, 1)}
        items = [
            {
                'id': key,
                'task': episodes[dialogue_id]['task'],
                'object': episodes[dialogue_id]['object'],
                'opening': catalog.opening(dialogues[dialogue_id], episodes[dialogue_id])[:300],
            }
            for key, dialogue_id in short.items()
        ]
        try:
            answer = await catalog_role.place(scenarios, items)
        except models.ModelError:
            answer = None
        for key, scenario_id in answer.value if answer else []:
            episodes[short[key]].setdefault('scenarioId', scenario_id)
        keep()
        done += len(batch)
        progress(stage='place', done=done, total=len(todo), message=f'Раскладываем по сценариям: {done} из {len(todo)}')

    if batches:
        progress(stage='place', done=0, total=len(todo), message=f'Раскладываем по сценариям: 0 из {len(todo)}')
        try:
            async with asyncio.TaskGroup() as tasks:
                for batch in batches:
                    tasks.create_task(one(batch))
        finally:
            keep()

"""One launch can evaluate a dataset, replay its questions and run simulations; each keeps its own result."""

import asyncio
import uuid
from functools import partial

from .. import storage
from ..domain import checks
from . import (
    Progress,
    accuracy,
    connection,
    conversations,
    datasets,
    error_text,
    judges,
    provenance,
    questions,
    same_work,
    scenarios,
    severity,
    simulation,
    tone,
)

MODES = ('dataset', 'questions', 'simulations')
STOPPED = 'Остановлено пользователем.'


def prepare(given: dict) -> dict:
    dataset = storage.datasets.get(given['datasetId'])
    if dataset is None or dataset['archivedAt']:
        raise ValueError('Выберите существующий датасет.')
    if not given['modes'] or any(mode not in MODES for mode in given['modes']):
        raise ValueError('Выберите хотя бы один режим проверки.')
    selected = storage.judges.get(given['judgeId']) if given.get('judgeId') else None
    if given.get('judgeId') and (selected is None or selected['kind'] != given['check']):
        raise ValueError('Выберите набор правил этой проверки.')
    if any(mode != 'dataset' for mode in given['modes']):
        target = connection.ways().get(given['target'])
        if not target or (not target.get('url') and target['kind'] != 'code'):
            raise ValueError('Настройте подключение к живому агенту.')
    with storage.transaction():
        datasets.select(dataset['id'])
        if given.get('judgeId'):
            judges.activate(given['check'], given['judgeId'])
        elif given['check'] == checks.CODE:
            judges.activate(checks.CODE, None)
        if given['check'] == checks.TONE and not (storage.documents.load(tone.DRAFT) or {}).get('criteria'):
            raise ValueError('Выберите или сформируйте критерии Tone of voice.')
    return given


def fingerprint(given: dict) -> str:
    return same_work(launch=given, **conversations.same_material(given['count']))


async def run(given: dict, progress: Progress) -> dict:
    launch_id = storage.tasks.current_id() or uuid.uuid4().hex
    record = storage.launches.get('launch', launch_id)
    if record is None:
        record = {
            'id': launch_id,
            'check': given['check'],
            'startedAt': storage.now(),
            'status': 'running',
            'agentVersion': given.get('agentVersion', ''),
            'dataset': storage.dialogues.meta(),
            'judge': storage.judges.active(given['check']),
            'inputs': given,
            **provenance.snapshot(given['check']),
            'modes': {mode: {'status': 'pending'} for mode in MODES if mode in given['modes']},
        }
    record['status'] = 'running'
    storage.launches.save('launch', record)
    try:
        for mode, result in record['modes'].items():
            if result['status'] == 'done':
                continue
            result.update(status='running', error=None)
            storage.launches.save('launch', record)

            report = partial(progress, mode=mode, launch=launch_id)

            try:
                result.update(await _mode(mode, given, report, launch_id))
            except Exception as error:
                result.update(status='failed', error=error_text(error))
            storage.launches.save('launch', record)
        record['status'] = 'done' if all(r['status'] == 'done' for r in record['modes'].values()) else 'failed'
    except asyncio.CancelledError:
        if not storage.tasks.closing():
            record['status'] = 'stopped'
            for outcome in record['modes'].values():
                if outcome['status'] == 'running':
                    outcome.update(status='stopped', error=STOPPED)
        raise
    finally:
        if record['status'] != 'running':
            record['finishedAt'] = storage.now()
        storage.launches.save('launch', record)
    if record['status'] == 'failed':
        raise RuntimeError('Часть режимов не завершена. Результаты успешных режимов сохранены в отчёте запуска.')
    return record


def view(record: dict) -> dict:
    """A launch as the screens read it, whole or as its line in the list. One kept running while its task runs no more
    (the Lab closed under it and the next start gave the task up, or the task's end could not be written: jobs) never
    says it runs: it ended as its task did, failed or stopped, with the task's reason, and so did each mode it had not
    finished."""
    if record['status'] != 'running':
        return record
    task = storage.tasks.get(record['id'])
    if task is not None and task['status'] == storage.tasks.RUNNING:
        return record
    stopped = task is not None and task['status'] == storage.tasks.STOPPED
    status, reason = ('stopped', STOPPED) if stopped else ('failed', task and task['error'])
    ended = {'status': status, 'error': reason}
    modes = {
        mode: (outcome | ended) if outcome['status'] in ('running', 'pending') else outcome
        for mode, outcome in record['modes'].items()
    }
    finished = task and task['finishedAt']
    return record | {'status': status, 'error': task and task['error'], 'finishedAt': finished, 'modes': modes}


async def _check(given: dict, progress: Progress) -> dict:
    check = given['check']
    if check == checks.TONE:
        draft = storage.documents.load(tone.DRAFT)
        await tone.check(draft['criteria'], given['count'], progress)
    else:
        await accuracy.check(given['count'], progress)
    result = storage.documents.load(checks.result(check))
    if not result:
        raise ValueError('Проверка не сформировала результат.')
    # Unlike a standalone check, cancellation here must stop the remaining launch modes too.
    await severity.propose(check, progress)
    return result


async def _mode(mode: str, given: dict, progress: Progress, launch_id: str) -> dict:
    if mode == 'dataset':
        result = await _check(given, progress)
        return {'status': 'done', 'checkId': result['checkId'], 'metric': result['summary']}
    if mode == 'questions':
        result = await questions.run(
            given['check'], given['target'], given['count'], progress, f'{launch_id}-questions'
        )
        return {
            'status': result['status'],
            'questionsId': result['id'],
            'metric': result['metric'],
            'error': result.get('error'),
        }
    kept_deck = storage.tasks.steps().get('launch-deck')
    if kept_deck:
        storage.documents.save(checks.DECK, kept_deck)
    deck = storage.documents.load(checks.DECK)
    if not deck or deck.get('check') != given['check']:
        if not storage.documents.load(checks.result(given['check'])):
            await _check(given, progress)
        await scenarios.build(given['check'], progress)
    storage.tasks.keep('launch-deck', storage.documents.load(checks.DECK))
    previous = storage.runs.get(launch_id)
    if previous and previous['status'] in ('failed', 'stopped'):
        storage.runs.update(launch_id, status='running', error=None, finishedAt=None)
    result = await simulation.run(given['target'], None, given.get('agentVersion', ''), progress)
    return {'status': result['status'], 'runId': result['id'], 'metric': result['metric'], 'error': result.get('error')}

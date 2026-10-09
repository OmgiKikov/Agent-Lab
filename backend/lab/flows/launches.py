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
    """A launch's choices, checked (_chosen), and what it is made of put in force: its dataset, the version of the agent
    whose answers the dataset holds when the launch checks them and names one («Версия агента в этом датасете»), its
    rules. A ValueError says what to choose."""
    dataset = _chosen(given)
    with storage.transaction():
        datasets.select(dataset['id'])
        if 'dataset' in given['modes'] and given.get('agentVersion', '').strip():
            datasets.set_version(dataset['id'], given['agentVersion'])
        if given.get('judgeId'):
            judges.activate(given['check'], given['judgeId'])
        elif given['check'] == checks.CODE:
            judges.activate(checks.CODE, None)
        if given['check'] == checks.TONE and not (storage.documents.load(tone.DRAFT) or {}).get('criteria'):
            raise ValueError('Выберите или сформируйте критерии Tone of voice.')
        if given.get('ruleIds'):
            if given['check'] != checks.TONE:
                raise ValueError('Отдельные критерии выбираются только для Tone of voice.')
            tone.selection(given['ruleIds'])  # each of them a criterion of the rules in force
    return given


def _chosen(given: dict) -> dict:
    """The dataset a launch's choices name, once they make a launch: a ValueError says what to choose. Nothing is put in
    force here (prepare)."""
    if (
        'simulations' in given['modes']
        and 'dataset' not in given['modes']
        and (given.get('ruleIds') or given.get('replan'))
    ):
        raise ValueError(
            'Сценарии симуляций собираются из ошибок в записанных ответах. Чтобы сыграть их по выбранным критериям '
            'или по критериям, извлечённым заново, отметьте и «Ответы в датасете».'
        )
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
    return dataset


def fingerprint(given: dict) -> str:
    """The same launch: its choices on the same material by the rules in force. Rules taken or changed since it stopped
    make it other work, so it is not continued by them (api/work.py, continuable)."""
    return same_work(launch=given, rules=in_force(given['check']), **conversations.same_material(given['count']))


def in_force(check: str) -> dict:
    """The rules a check goes by now: the version selected, and for tone of voice the revision of its criteria."""
    selected = storage.judges.active(check)
    draft = (storage.documents.load(tone.DRAFT) or {}) if check == checks.TONE else {}
    return {'judge': selected['id'] if selected else None, 'criteria': draft.get('revision')}


def current(record: dict) -> bool:
    """Whether a launch was made of what is in force now: its dataset is the one the checks go by and its rules are the
    ones selected. Only such a launch is started again or continued: another one would silently put its old rules and
    dataset back in force (prepare)."""
    given = record.get('inputs') or {}
    check = given.get('check') or record.get('check')
    selected = storage.judges.active(check)
    chosen = given.get('judgeId') or None
    # A tone launch that named no rules goes by the ones in force, so starting it again puts nothing back; one of
    # Точность that named none goes by the agent's code and would put away a set in force.
    same_rules = chosen == (selected['id'] if selected else None) or (chosen is None and check == checks.TONE)
    return storage.dialogues.meta().get('datasetId') == given.get('datasetId') and same_rules


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
            # Some of the criteria, when a person chose them; the code's criteria read anew (Точность).
            'ruleIds': given.get('ruleIds') or None,
            'replan': bool(given.get('replan')),
            **provenance.snapshot(given['check']),
            'modes': {mode: {'status': 'pending'} for mode in MODES if mode in given['modes']},
        }
    record['status'] = 'running'
    storage.launches.save('launch', record)
    try:
        for mode, result in record['modes'].items():
            if result['status'] == 'done':
                continue
            waits = _waits_for_answers(mode, given, record)
            if waits:
                result.update(status='failed', error=waits)
                storage.launches.save('launch', record)
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


def _waits_for_answers(mode: str, given: dict, record: dict) -> str | None:
    """Why a mode cannot run while the check of the recorded answers of this launch did not finish, when it takes its
    criteria from that check: the scenarios by chosen criteria are built from its errors, criteria read anew come from
    it. None when the mode can run."""
    answers = record['modes'].get('dataset')
    if mode == 'dataset' or answers is None or answers['status'] == 'done':
        return None
    if mode == 'simulations' and (given.get('ruleIds') or given.get('replan')):
        return 'Проверка «Ответы в датасете» не завершилась, а сценарии по выбранным критериям собираются из её ошибок.'
    if mode == 'questions' and given.get('replan'):
        return 'Проверка «Ответы в датасете» не завершилась, а критерии, извлечённые заново, даёт она.'
    return None


def view(record: dict) -> dict:
    """A launch as the screens read it, whole or as its line in the list. One kept running while its task runs no more
    (the Lab closed under it and the next start gave the task up, or the task's end could not be written: jobs) never
    says it runs: it ended as its task did, failed or stopped, with the task's reason, and so did each mode it had not
    finished."""
    record = storage.launches.light(record)
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
        chosen = tone.selection(given['ruleIds']) if given.get('ruleIds') else draft['criteria']
        await tone.check(chosen, given['count'], progress)
    else:
        await accuracy.check(given['count'], progress, replan=bool(given.get('replan')))
    result = storage.documents.load(checks.result(check))
    made = storage.tasks.current_id()
    if made and (result or {}).get('checkId') != made:
        # Published by this launch before a stop or a restart (conversations.published_once), while the result in
        # force is another one since: the check stands in the history and is not made again.
        saved = storage.history.get(check, made)
        if saved:
            return {'checkId': made, 'summary': saved['check']['summary']}
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
            given['check'],
            given['target'],
            given['count'],
            progress,
            f'{launch_id}-questions',
            rule_ids=given.get('ruleIds'),
            # The criteria are read anew once per launch: by its check of the recorded answers when it has one.
            replan=bool(given.get('replan')) and 'dataset' not in given.get('modes', ()),
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

"""A reviewable configuration starts one durable launch with independently reported modes."""

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import storage
from ..flows import launches
from . import work
from .base import Jobs

router = APIRouter()


class LaunchCommand(BaseModel):
    check: Literal['tone', 'code']
    datasetId: str = Field(min_length=1)
    judgeId: str | None = None
    agentVersion: str = Field(default='', max_length=80)
    count: int = Field(default=100, ge=1, le=300)
    modes: list[Literal['dataset', 'questions', 'simulations']] = Field(min_length=1, max_length=3)
    target: str = 'prod'
    # Tone of voice by some of its criteria (all of them when none are named), as a person chose them.
    ruleIds: list[str] | None = Field(default=None, min_length=1, max_length=100)
    # Точность by the agent's code with its criteria read from the code anew: its instructions or tools changed.
    replan: bool = False


@router.post('/api/launches')
async def launch(jobs: Jobs, payload: LaunchCommand) -> dict:
    if jobs.state['running']:
        raise HTTPException(409, 'Дождитесь текущей задачи или остановите её.')
    try:
        given = launches.prepare(payload.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    result = work.start(jobs, 'launch', given)
    task = storage.tasks.latest('launch')
    return {**result, 'id': task['id']}


@router.get('/api/launches')
def history(check: Literal['tone', 'code'] | None = None) -> dict:
    found = storage.launches.listed('launch')
    return {'launches': [launches.view(r) for r in found if check is None or r['check'] == check]}


def _shown(record: dict) -> dict:
    """A launch as its page reads it, with whether it can be started again as it was (current: made of the dataset
    and the rules in force) and whether that start continues it with what it kept (continuable)."""
    shown = launches.view(record)
    ended = shown['status'] in ('stopped', 'failed')
    return shown | {
        'current': launches.current(record),
        'continuable': ended and work.continuable(storage.tasks.get(record['id'])),
    }


@router.get('/api/launches/{launch_id}')
def result(launch_id: str) -> dict:
    found = storage.launches.get('launch', launch_id)
    if found is None:
        task = _task(launch_id)
        return {
            'id': launch_id,
            'check': task['input']['check'],
            'status': task['status'],
            'modes': {},
            'startedAt': task['startedAt'],
            'error': task['error'],
        }
    return _shown(found)


@router.post('/api/launches/{launch_id}/retry')
async def retry(launch_id: str, jobs: Jobs) -> dict:
    """The same launch started again: from its record, or from its task when it was stopped before its first save.
    Only while its dataset and rules are the ones in force: starting it would put them back in force, unasked."""
    record = storage.launches.get('launch', launch_id)
    given = record['inputs'] if record is not None else _task(launch_id)['input']
    if not launches.current({'inputs': given, 'check': given['check']}):
        raise HTTPException(
            409, 'После этой проверки сменились правила или датасет. Запустите новую проверку, она пойдёт по текущим.'
        )
    return await launch(jobs, LaunchCommand(**given))


def _task(launch_id: str) -> dict:
    """The task of a launch kept with no record of it (stopped before the record's first save), else 404."""
    task = storage.tasks.get(launch_id)
    if task is None or task['kind'] != 'launch':
        raise HTTPException(404, 'Проверка не найдена.')
    return task


@router.get('/api/questions/{run_id}')
def questions_result(run_id: str, brief: bool = False) -> dict:
    """A run of recorded questions asked again. brief: its list as the launch's page shows it while the run goes, asked
    again every 1.5 s, one line a question; a question in full comes by itself (question)."""
    record = _settled(_questions(run_id))
    if not brief:
        return record
    shown = {key: value for key, value in record.items() if key not in ('items', 'topics', 'judge', 'agentContext')}
    return shown | {'items': [_line(item) for item in record['items']]}


@router.get('/api/questions/{run_id}/items/{dialogue_id}')
def question(run_id: str, dialogue_id: str) -> dict:
    """One recorded conversation asked again, in full: both sides and the verdicts on the new answers."""
    found = next((i for i in _questions(run_id)['items'] if str(i['dialogueId']) == dialogue_id), None)
    if found is None:
        raise HTTPException(404, 'Такого разговора в проверке нет.')
    baseline = found.get('baseline')
    return {key: value for key, value in found.items() if key != 'criteria'} | {
        'baseline': baseline and {'status': baseline.get('status')}
    }


def _questions(run_id: str) -> dict:
    record = storage.launches.get('questions', run_id)
    if record is None:
        raise HTTPException(404, 'Ответы агента не найдены.')
    return record


def _settled(record: dict) -> dict:
    """A run kept running while its launch runs no more (the Lab closed under it and the next start gave it up) never
    says it runs: it ended as its launch did."""
    if record['status'] != 'running':
        return record
    task = storage.tasks.get(record['id'].removesuffix('-questions'))
    if task is None or task['status'] == storage.tasks.RUNNING:
        return record
    return record | {'status': 'stopped' if task['status'] == storage.tasks.STOPPED else 'failed'}


def _line(item: dict) -> dict:
    """A question as the list shows it: what it was, how many questions the customer asked, how its new answers stand
    and how they stood in the dataset."""
    baseline = item.get('baseline')
    return {
        'dialogueId': item['dialogueId'],
        'name': item['name'],
        'asked': sum(1 for message in item.get('original') or [] if message.get('role') == 'user'),
        'status': item['status'],
        'comparable': bool(item.get('comparable')),
        'baseline': baseline and {'status': baseline.get('status')},
    }
